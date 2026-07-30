import assert from "node:assert/strict";
import test from "node:test";

import { attachCompanionExpression, finalAssistantText } from "./agent-expression.js";

test("extracts only completed assistant text, not thinking or tool payloads", () => {
  const text = finalAssistantText([
    { role: "user", content: "hello" },
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: " 我在这里。 " },
        { type: "toolCall", name: "stardew_move_to_tile", arguments: {} },
      ],
    },
  ]);
  assert.equal(text, "我在这里。");
  assert.equal(finalAssistantText([{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "do not show" }] }]), null);
});

test("completed agent expression shows text before enqueuing optional speech", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const timeline: string[] = [];
  const unsubscribe = attachCompanionExpression({
    subscribe(callback: (event: never) => void) { listener = callback as unknown as (event: unknown) => void; return () => { listener = undefined; }; },
  } as never, {
    sessionId: "session_01",
    visible: { async show(value) { timeline.push(`text:${value.text}`); } },
    speech: { async enqueue(value) { timeline.push(`speech:${value.text}`); } },
  });

  listener?.({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "先显示文字" }] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timeline, ["text:先显示文字", "speech:先显示文字"]);
  unsubscribe();
});

test("retrying and empty assistant turns do not create presentation output", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const shown: string[] = [];
  attachCompanionExpression({
    subscribe(callback: (event: never) => void) { listener = callback as unknown as (event: unknown) => void; return () => undefined; },
  } as never, { sessionId: "session_01", visible: { async show(value) { shown.push(value.text); } } });
  listener?.({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "retry" }] }] });
  listener?.({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "x" }] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, []);
});
