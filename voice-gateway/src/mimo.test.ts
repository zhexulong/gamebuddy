import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SpeechJob } from "./gateway.js";
import { MIMO_TTS_MODEL, MimoTtsProvider } from "./mimo.js";

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

function response(sse: string): Response {
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("MiMo adapter sends v2.5 pcm16 streaming request and consumes only SSE audio chunks", async () => {
  const original = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init);
    return response('data: {"choices":[{"delta":{"audio":{"data":"AQID"}},"finish_reason":null}]}\n\ndata: [DONE]\n');
  };
  try {
    const provider = new MimoTtsProvider({
      apiKey: "mimo_key_1234567890",
      voiceByProfile: { "companion.default": "Chloe" },
      styleByProfile: { "companion.default": "short warm reply" },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesize(job, new AbortController().signal)) chunks.push(chunk);
    assert.deepEqual([...chunks[0]!], [1, 2, 3]);
    assert.equal(provider.modelRevision, MIMO_TTS_MODEL);
    assert.equal(request?.url, "https://api.xiaomimimo.com/v1/chat/completions");
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
  const provider = new MimoTtsProvider({ apiKey: "mimo_key_1234567890", voiceByProfile: {} });
  await assert.rejects(async () => {
    for await (const _ of provider.synthesize(job, new AbortController().signal)) {
      /* no op */
    }
  }, /mimo_voice_profile_not_configured/);
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
  assert.equal(fixture.endpoint, "https://api.xiaomimimo.com/v1/chat/completions");
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
});

test("MiMo adapter rejects truncated and zero-audio SSE streams", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => response('data: {"choices":[{"delta":{"content":"ignored"}}]}\n');
    const provider = new MimoTtsProvider({
      apiKey: "mimo_key_1234567890",
      voiceByProfile: { "companion.default": "Chloe" },
    });
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
