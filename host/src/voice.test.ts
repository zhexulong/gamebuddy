import assert from "node:assert/strict";
import test from "node:test";

import { deliverFinalVoiceInput, expressTextFirst, type FinalVoiceInput, type VoiceExpression } from "./voice.js";

const final: FinalVoiceInput = { sessionId: "session_01", inputId: "input_01", text: "去农场看看", locale: "zh-CN", providerId: "fake-asr", modelRevision: "v1", timestampMs: 1, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } };

test("Host accepts only a final voice event through the ordinary player-input boundary", async () => {
  const received: FinalVoiceInput[] = [];
  await deliverFinalVoiceInput({ receive(input) { received.push(input); } }, final);
  assert.deepEqual(received, [final]);
  assert.equal(JSON.stringify(received).includes("pcm"), true);
  assert.equal(JSON.stringify(received).includes("Uint8Array"), false);
});

test("Host presents text before optional speech and keeps it on speech failure", async () => {
  const timeline: string[] = []; let visible: VoiceExpression | undefined;
  const expression = await expressTextFirst({ show(value) { timeline.push("text"); visible = value; } }, { enqueue() { timeline.push("speech"); throw new Error("tts_unavailable"); } }, { sessionId: "session_01", sourceEventId: "event_01", text: "我在这里。", locale: "zh-CN", voiceProfile: "companion.default", epoch: 1, expiresAtMs: Date.now() + 1_000 });
  assert.deepEqual(timeline, ["text", "speech"]); assert.equal(visible?.expressionId, expression.expressionId); assert.equal(expression.text, "我在这里。");
});
