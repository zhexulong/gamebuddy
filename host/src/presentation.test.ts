import assert from "node:assert/strict";
import test from "node:test";

import { createCompanionPresentationTools, type CompanionTextExpression, type PresentationProfile } from "./presentation.js";
import { type VoiceExpression } from "./voice.js";

function profile(speech: PresentationProfile["speech"], text = false): PresentationProfile {
  return { locale: "zh-CN", text, speech };
}

test("presentation tools are materialized only for configured and mounted surfaces", () => {
  const text: CompanionTextExpression[] = [];
  const speech: VoiceExpression[] = [];
  const tools = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "companion.default" }, true), sessionId: "session_01",
    textPort: { present(expression) { text.push(expression); } }, speechPort: { enqueue(expression) { speech.push(expression); } },
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["companion_speak", "companion_text"]);

  const noSurface = createCompanionPresentationTools({ profile: profile({ voiceProfile: "companion.default" }, true), sessionId: "session_02" });
  assert.deepEqual(noSurface, []);
});

test("text and speech stay independent and reject mechanism language", async () => {
  const text: CompanionTextExpression[] = [];
  const speech: VoiceExpression[] = [];
  const tools = createCompanionPresentationTools({
    profile: profile({ voiceProfile: "companion.default" }, true), sessionId: "session_01",
    textPort: { present(expression) { text.push(expression); } }, speechPort: { enqueue(expression) { speech.push(expression); } },
  });
  const textTool = tools.find((tool) => tool.name === "companion_text")!;
  const speechTool = tools.find((tool) => tool.name === "companion_speak")!;
  await textTool.execute("tool_call_text_01", { text: "我在这边等你。" }, new AbortController().signal, () => {}, {} as never);
  await speechTool.execute("tool_call_speech_01", { line: "我们先看看门口。" }, new AbortController().signal, () => {}, {} as never);
  assert.deepEqual(text.map((item) => item.text), ["我在这边等你。"]);
  assert.deepEqual(speech.map((item) => ({ text: item.text, sourceEventId: item.sourceEventId })), [{ text: "我们先看看门口。", sourceEventId: "tool_call_speech_01" }]);
  await assert.rejects(() => textTool.execute("bad", { text: "receipt succeeded; tool result" }, new AbortController().signal, () => {}, {} as never), /invalid_player_expression/);
  await assert.rejects(() => speechTool.execute("bad", { line: "我会调用 subagent" }, new AbortController().signal, () => {}, {} as never), /invalid_player_expression/);
});

test("speech tool exposes only provider-neutral player text", async () => {
  const speech: VoiceExpression[] = [];
  const tools = createCompanionPresentationTools({ profile: profile({ voiceProfile: "plain" }), sessionId: "session_01", speechPort: { enqueue(expression) { speech.push(expression); } } });
  const tool = tools[0]!;
  await tool.execute("speech", { line: "只说这句话。" }, new AbortController().signal, () => {}, {} as never);
  assert.equal(speech[0]?.text, "只说这句话。");
});
