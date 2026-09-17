import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SpeechJob } from "./gateway.js";
import {
  MIMO_TTS_ENDPOINT,
  MIMO_TTS_MODEL,
  MimoTtsProvider,
  type MimoTtsAdmission,
  type MimoTtsOptions,
} from "./mimo.js";

const job: SpeechJob = {
  jobId: "job_01",
  sessionId: "session_01",
  epoch: 0,
  sourceEventId: "event_01",
  text: "fixture text",
  locale: "zh-CN",
  voiceProfile: "companion.default",
  expiresAtMs: Date.now() + 1_000,
  interruptible: true,
};

function response(sse: string, contentType = "text/event-stream"): Response {
  return new Response(sse, { status: 200, headers: { "content-type": contentType } });
}

const admission: MimoTtsAdmission = Object.freeze({ assertCurrent() {} });
function options(overrides: Partial<MimoTtsOptions> = {}): MimoTtsOptions {
  return {
    apiKey: "mimo_key_1234567890",
    voiceByProfile: { "companion.default": "Chloe" },
    admission,
    ...overrides,
  };
}
function testProvider(overrides: Partial<MimoTtsOptions> = {}): MimoTtsProvider {
  return MimoTtsProvider.forTest(options(overrides), "http://127.0.0.1:43123/v1/chat/completions");
}

test("MiMo adapter sends v2.5 pcm16 streaming request and consumes only SSE audio chunks", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return response('data: {"choices":[{"delta":{"audio":{"data":"AQIDBA=="}},"finish_reason":null}]}\n\ndata: [DONE]\n');
  };
  try {
    const provider = new MimoTtsProvider(options({ styleByProfile: { "companion.default": "short warm reply" } }));
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesize(job, new AbortController().signal)) chunks.push(chunk);
    // The wire is frozen at 16 kHz: the provider's native 24 kHz chunk
    // (4 bytes = 2 samples here) is resampled to 16 kHz (2 bytes = 1 sample).
    assert.deepEqual([...chunks[0]!], [1, 2]);
    assert.equal(provider.modelRevision, MIMO_TTS_MODEL);
    assert.equal(request?.url, MIMO_TTS_ENDPOINT);
    assert.equal(request?.headers.get("api-key"), "mimo_key_1234567890");
    const body = (await request?.json()) as {
      model: string;
      audio: { format: string; voice: string };
      stream: boolean;
      messages: Array<{ role: string }>;
    };
    assert.equal(body.model, MIMO_TTS_MODEL);
    assert.deepEqual(body.audio, { format: "pcm16", voice: "Chloe" });
    assert.equal(body.stream, true);
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ["user", "assistant"],
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("MiMo adapter fails closed when the logical voice is not configured", async () => {
  const provider = testProvider({ voiceByProfile: {} });
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize(job, new AbortController().signal)) {
      /* no op */
    }
  }, /mimo_voice_profile_not_configured/);
});

test("MiMo adapter requires an explicit admission and keeps provider configuration unavailable without it", () => {
  assert.throws(
    () => new MimoTtsProvider({ apiKey: "mimo_key_1234567890", voiceByProfile: { "companion.default": "Chloe" } }),
    /mimo_admission_required/,
  );
  assert.throws(
    () => MimoTtsProvider.forTest(options(), "https://example.test/v1/chat/completions"),
    /mimo_test_endpoint_not_allowed/,
  );
});

test("MiMo adapter revalidates opaque admission immediately before provider access", async () => {
  const original = globalThis.fetch;
  let checks = 0;
  let fetches = 0;
  const currentAdmission: MimoTtsAdmission = { assertCurrent: () => void checks++ };
  globalThis.fetch = async () => {
    fetches += 1;
    return response('data: {"choices":[{"delta":{"audio":{"data":"AQIDBA=="}}}]}\ndata: [DONE]\n');
  };
  try {
    const provider = testProvider({ admission: currentAdmission });
    for await (const _ of provider.synthesize(job, new AbortController().signal)) {
      /* no op */
    }
    assert.equal(checks, 1);
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("MiMo adapter replays the checked-in redacted live contract shape without secrets or audio", async () => {
  const fixtureUrl = new URL("../../fixtures/voice/mimo-v2.5-tts-sse-redacted.json", import.meta.url);
  const fixture = JSON.parse(await readFile(fileURLToPath(fixtureUrl), "utf8")) as {
    provider: string;
    endpoint: string;
    request: { method: string; model: string; stream: boolean; audioFormat: string; authentication: string };
    response: {
      httpStatus: number;
      contentType: string;
      terminal: string;
      chunksWithAudio: number;
      eventFields: string[];
    };
  };
  assert.equal(fixture.provider, "xiaomi-mimo");
  assert.equal(fixture.endpoint, MIMO_TTS_ENDPOINT);
  assert.deepEqual(fixture.request, {
    method: "POST",
    model: MIMO_TTS_MODEL,
    stream: true,
    audioFormat: "pcm16",
    messageRoles: ["assistant"],
    authentication: "api-key: <redacted>",
  });
  assert.equal(fixture.response.httpStatus, 200);
  assert.equal(fixture.response.contentType, "text/event-stream");
  assert.equal(fixture.response.terminal, "done");
  assert.ok(fixture.response.chunksWithAudio > 0);
  assert.ok(fixture.response.eventFields.includes("choices[].delta.audio"));
  assert.equal(JSON.stringify(fixture).includes("fixture text"), false);
  assert.equal(JSON.stringify(fixture).includes("AQID"), false);
  assert.match(MIMO_TTS_ENDPOINT, /^https:\/\/api\.xiaomimimo\.com\/v1\/chat\/completions$/);
});

test("MiMo adapter rejects a non-SSE provider response", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => response("provider payload", "application/json");
    const provider = testProvider();
    await assert.rejects(async () => {
      for await (const _ of provider.synthesize(job, new AbortController().signal)) {
        /* no op */
      }
    }, /mimo_content_type_invalid/);
  } finally {
    globalThis.fetch = original;
  }
});

test("MiMo adapter rejects an oversized SSE line without exposing provider data", async () => {
  const original = globalThis.fetch;
  const secretPayload = "provider-secret-payload-should-never-be-logged";
  try {
    globalThis.fetch = async () => response(`data: ${JSON.stringify({ error: secretPayload, padding: "x".repeat(300_000) })}\n`);
    const provider = testProvider();
    let failure: unknown;
    try {
      for await (const _ of provider.synthesize(job, new AbortController().signal)) {
        /* no op */
      }
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    if (!(failure instanceof Error)) throw new Error("test_failure_not_error");
    assert.equal(failure.message, "mimo_sse_data_too_large");
    assert.doesNotMatch(failure.message, new RegExp(secretPayload));
  } finally {
    globalThis.fetch = original;
  }
});

test("MiMo adapter rejects truncated and zero-audio SSE streams", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => response('data: {"choices":[{"delta":{"content":"ignored"}}]}\n');
    const provider = testProvider();
    await assert.rejects(async () => {
      for await (const _ of provider.synthesize(job, new AbortController().signal)) {
        /* no op */
      }
    }, /mimo_truncated_stream/);
    globalThis.fetch = async () => response("data: [DONE]\n");
    await assert.rejects(async () => {
      for await (const _ of provider.synthesize(job, new AbortController().signal)) {
        /* no op */
      }
    }, /mimo_no_audio/);
  } finally {
    globalThis.fetch = original;
  }
});
