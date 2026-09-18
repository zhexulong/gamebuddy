import assert from "node:assert/strict";
import test from "node:test";
import { GroqWhisperAsrProvider, GROQ_WHISPER_DEFAULT_MODEL, GROQ_WHISPER_ENDPOINT } from "./groq.js";

const VALID_KEY = "gsk_test_123456789012345678901234567890";
const DUMMY_PCM16 = new Uint8Array([0, 0, 100, 0, 200, 0, 50, 0]); // 4 samples, 8 bytes

test("GroqWhisperAsrProvider validates options and keys", () => {
  assert.throws(
    () => new GroqWhisperAsrProvider({ apiKey: "" }),
    /groq_api_key_not_configured/,
  );
  assert.throws(
    () => new GroqWhisperAsrProvider({ apiKey: "short" }),
    /groq_api_key_not_configured/,
  );
  assert.throws(
    () => GroqWhisperAsrProvider.forTest({ apiKey: VALID_KEY }, "https://malicious.com/api"),
    /groq_test_endpoint_not_allowed/,
  );

  const provider = new GroqWhisperAsrProvider({ apiKey: VALID_KEY });
  assert.equal(provider.providerId, "groq-whisper");
  assert.equal(provider.modelRevision, GROQ_WHISPER_DEFAULT_MODEL);
});

test("GroqWhisperAsrProvider rejects invalid PCM audio", async () => {
  const provider = new GroqWhisperAsrProvider({ apiKey: VALID_KEY });
  const signal = new AbortController().signal;

  await assert.rejects(
    () => provider.transcribe(new Uint8Array(0), "zh-CN", signal),
    /invalid_pcm16_audio/,
  );
  await assert.rejects(
    () => provider.transcribe(new Uint8Array([1, 2, 3]), "zh-CN", signal),
    /invalid_pcm16_audio/,
  );
});

test("GroqWhisperAsrProvider respects AbortSignal cancellation", async () => {
  const provider = new GroqWhisperAsrProvider({ apiKey: VALID_KEY });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => provider.transcribe(DUMMY_PCM16, "en-US", controller.signal),
    /asr_cancelled/,
  );
});

test("GroqWhisperAsrProvider transcribes audio with correct request format", async () => {
  const originalFetch = globalThis.fetch;
  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input, init) => {
    capturedRequest = new Request(input, init);
    return new Response(JSON.stringify({ text: "  Hello from Groq Whisper!  " }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const provider = new GroqWhisperAsrProvider({ apiKey: VALID_KEY });
    const result = await provider.transcribe(DUMMY_PCM16, "zh-CN", new AbortController().signal);

    assert.equal(result, "Hello from Groq Whisper!");
    assert.equal(capturedRequest?.url, GROQ_WHISPER_ENDPOINT);
    assert.equal(capturedRequest?.headers.get("authorization"), `Bearer ${VALID_KEY}`);

    const formData = await capturedRequest?.formData();
    assert.equal(formData?.get("model"), GROQ_WHISPER_DEFAULT_MODEL);
    assert.equal(formData?.get("response_format"), "json");
    assert.equal(formData?.get("temperature"), "0");
    assert.equal(formData?.get("language"), "zh");

    const file = formData?.get("file");
    assert.ok(file instanceof Blob);
    assert.equal((file as Blob).type, "audio/wav");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GroqWhisperAsrProvider sanitizes error and hides secrets on failure", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: { message: "Invalid key gsk_test_123456789012345678901234567890" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const provider = new GroqWhisperAsrProvider({ apiKey: VALID_KEY });
    await assert.rejects(
      () => provider.transcribe(DUMMY_PCM16, "en", new AbortController().signal),
      (err: Error) => {
        assert.ok(!err.message.includes(VALID_KEY));
        assert.match(err.message, /groq_transcription_failed:http_401/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
