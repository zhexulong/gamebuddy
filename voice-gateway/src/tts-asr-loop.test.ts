import assert from "node:assert/strict";
import test from "node:test";

import { type AsrProvider, type SpeechJob, type TtsProvider } from "./gateway.js";
import { runTtsAsrLoop } from "./tts-asr-loop.js";

const job: SpeechJob = {
  jobId: "job_loop_01",
  sessionId: "session_loop_01",
  epoch: 0,
  sourceEventId: "event_loop_01",
  text: "测试语音闭环",
  locale: "zh-CN",
  voiceProfile: "companion.default",
  expiresAtMs: Date.now() + 5_000,
  interruptible: true,
};

const tts: TtsProvider = {
  providerId: "test-tts",
  modelRevision: "test-tts-v1",
  async *synthesize() {
    yield new Uint8Array([0, 1]);
    yield new Uint8Array([2, 3]);
  },
};

test("TTS-to-ASR diagnostic loop preserves PCM16 chunk order and provider revisions", async () => {
  let received: Uint8Array | undefined;
  const asr: AsrProvider = {
    providerId: "test-asr",
    modelRevision: "test-asr-v1",
    async transcribe(pcm16) { received = pcm16; return "测试转写"; },
  };

  const result = await runTtsAsrLoop(tts, asr, job, new AbortController().signal);
  assert.deepEqual(received, new Uint8Array([0, 1, 2, 3]));
  assert.deepEqual(result, {
    pcm16Bytes: 4,
    transcript: "测试转写",
    ttsProviderId: "test-tts",
    ttsModelRevision: "test-tts-v1",
    asrProviderId: "test-asr",
    asrModelRevision: "test-asr-v1",
  });
});

test("TTS-to-ASR diagnostic loop propagates cancellation and rejects malformed audio", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const asr: AsrProvider = { providerId: "test-asr", modelRevision: "test-asr-v1", async transcribe() { return "unexpected"; } };
  await assert.rejects(() => runTtsAsrLoop(tts, asr, job, cancelled.signal), /tts_asr_loop_cancelled/);

  const malformedTts: TtsProvider = { providerId: "malformed", modelRevision: "v1", async *synthesize() { yield new Uint8Array([1]); } };
  await assert.rejects(() => runTtsAsrLoop(malformedTts, asr, job, new AbortController().signal), /tts_asr_invalid_pcm16/);
});
