import assert from "node:assert/strict";
import test from "node:test";

import { deliverFinalVoiceInput, type FinalVoiceInput } from "./voice.js";

const final: FinalVoiceInput = {
  sessionId: "session_01",
  inputId: "input_01",
  text: "去农场看看",
  locale: "zh-CN",
  providerId: "fake-asr",
  modelRevision: "v1",
  timestampMs: 1,
  actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
};

test("Host accepts only a final voice event through the ordinary player-input boundary", async () => {
  const received: FinalVoiceInput[] = [];
  await deliverFinalVoiceInput({ receive(input) { received.push(input); } }, final);
  assert.deepEqual(received, [final]);
  assert.equal(JSON.stringify(received).includes("pcm"), true);
  assert.equal(JSON.stringify(received).includes("Uint8Array"), false);
});
