import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SpeechJob } from "./gateway.js";
import {
  MIMO_TTS_ENDPOINT,
  MIMO_TTS_MODEL,
  MIMO_TTS_PERSONAS,
  MIMO_TTS_VOICES,
  MIMO_TTS_VOICE_METADATA,
  MimoTtsProvider,
  resolveMimoTtsPersona,
  type MimoTtsAdmission,
  type MimoTtsOptions,
  type MimoTtsPersonaId,
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

test("MiMo adapter fails closed when no voice or persona is configured", () => {
  // Empty voice/persona configuration is a construction-time configuration
  // error: an unconfigured provider can never speak, so it never publishes.
  assert.throws(
    () => testProvider({ voiceByProfile: {} }),
    /mimo_voices_not_configured/,
  );
  assert.throws(
    () => testProvider({ voiceByProfile: undefined }),
    /mimo_voices_not_configured/,
  );
});

test("MiMo adapter fails closed when the job's voice profile is not configured", async () => {
  // The profile exists for another voice but not for the job's profile.
  const provider = testProvider({ voiceByProfile: { "companion.default": "Chloe" } });
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize({ ...job, voiceProfile: "unconfigured.profile" }, new AbortController().signal)) {
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

test("MiMo exposes the official preset voice allowlist and per-voice advisory metadata", () => {
  // The allowlist reflects the provider's official audio.voice table. It is
  // the voice-layer contract: an id outside it fails fast at construction.
  assert.deepEqual(
    [...MIMO_TTS_VOICES],
    ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"],
  );
  assert.equal(MIMO_TTS_VOICE_METADATA["冰糖"]?.gender, "女性");
  assert.equal(MIMO_TTS_VOICE_METADATA["冰糖"]?.language, "中文");
  assert.equal(MIMO_TTS_VOICE_METADATA["白桦"]?.gender, "男性");
  assert.equal(MIMO_TTS_VOICE_METADATA["Chloe"]?.language, "英文");
  assert.equal(MIMO_TTS_VOICE_METADATA["mimo_default"]?.persona?.includes("冰糖"), true);
});

test("MiMo rejects an unknown voice string at construction with a distinct fail code", () => {
  // A typo like moji -> 茉莉, or an arbitrary id, must never reach the provider.
  assert.throws(
    () => testProvider({ voiceByProfile: { "companion.default": "moli" } }),
    /mimo_voice_unknown/,
  );
  assert.throws(
    () => testProvider({ voiceByProfile: { "companion.default": "DeepSeek" } }),
    /mimo_voice_unknown/,
  );
});

test("MiMo persona preset resolves to the official voice and style hint at synthesis", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return response('data: {"choices":[{"delta":{"audio":{"data":"AQIDBA=="}}}]}\ndata: [DONE]\n');
  };
  try {
    const provider = testProvider({
      // persona supplies the voice: no explicit voiceByProfile override.
      voiceByProfile: undefined,
      personaByProfile: { "companion.default": "soft_maid" },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesize(job, new AbortController().signal)) chunks.push(chunk);
    assert.ok(chunks.length > 0);
    const body = (await request?.json()) as {
      audio: { format: string; voice: string };
      messages: Array<{ role: string; content?: string }>;
    };
    // The persona's official voice (冰糖) is resolved, and its style hint
    // becomes the user-role direction the provider expects.
    assert.deepEqual(body.audio, { format: "pcm16", voice: "冰糖" });
    assert.equal(body.messages[0]?.role, "user");
    assert.ok((body.messages[0]?.content ?? "").includes("软糯"));
  } finally {
    globalThis.fetch = original;
  }
});

test("MiMo persona preset is overridden by an explicit per-profile voice and style", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return response('data: {"choices":[{"delta":{"audio":{"data":"AQIDBA=="}}}]}\ndata: [DONE]\n');
  };
  try {
    const provider = testProvider({
      personaByProfile: { "companion.default": "gentle_maid" },
      voiceByProfile: { "companion.default": "Mia" },
      styleByProfile: { "companion.default": "speak plainly" },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesize(job, new AbortController().signal)) chunks.push(chunk);
    assert.ok(chunks.length > 0);
    const body = (await request?.json()) as {
      audio: { format: string; voice: string };
      messages: Array<{ role: string; content?: string }>;
    };
    assert.deepEqual(body.audio, { format: "pcm16", voice: "Mia" });
    assert.equal(body.messages[0]?.content, "speak plainly");
  } finally {
    globalThis.fetch = original;
  }
});

test("MiMo rejects an unknown persona id at construction with a distinct fail code", () => {
  // The persona reference comes from operator config as a raw string (e.g. an
  // env value); the cast models that runtime boundary — construction still
  // validates the value against the catalog.
  assert.throws(
    () => testProvider({ personaByProfile: { "companion.default": "not_a_persona" as MimoTtsPersonaId } }),
    /mimo_persona_unknown/,
  );
});

test("MiMo voice persona metadata exposes only supported preset ids", () => {
  for (const personaId of Object.keys(MIMO_TTS_PERSONAS) as Array<keyof typeof MIMO_TTS_PERSONAS>) {
    const resolved = resolveMimoTtsPersona(personaId);
    assert.ok((MIMO_TTS_VOICES as readonly string[]).includes(resolved.voice), `${personaId} resolves to an official voice`);
    assert.ok(resolved.style.length > 0, `${personaId} carries a style hint`);
  }
});
