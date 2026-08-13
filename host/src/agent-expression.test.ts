import assert from "node:assert/strict";
import test from "node:test";

import { attachCompanionExpression, finalAssistantText } from "./agent-expression.js";

test("extracts only completed assistant text for private trace", () => {
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
  assert.equal(
    finalAssistantText([{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "do not show" }] }]),
    null,
  );
});

test("ordinary agent_end output never becomes player-facing presentation", () => {
  let listener: ((event: unknown) => void) | undefined;
  const timeline: string[] = [];
  const unsubscribe = attachCompanionExpression(
    {
      subscribe(callback: (event: never) => void) {
        listener = callback as unknown as (event: unknown) => void;
        return () => {
          listener = undefined;
        };
      },
    } as never,
    {
      visible: {
        show() {
          timeline.push("text");
        },
      },
      speech: {
        enqueue() {
          timeline.push("speech");
        },
      },
    },
  );

  listener?.({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "普通输出" }] }],
  });
  assert.deepEqual(timeline, []);
  unsubscribe();
});

test("retrying and empty assistant turns do not create presentation output", () => {
  let listener: ((event: unknown) => void) | undefined;
  const shown: string[] = [];
  attachCompanionExpression(
    {
      subscribe(callback: (event: never) => void) {
        listener = callback as unknown as (event: unknown) => void;
        return () => undefined;
      },
    } as never,
    {
      visible: {
        show() {
          shown.push("shown");
        },
      },
    },
  );
  listener?.({
    type: "agent_end",
    willRetry: true,
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "retry" }] }],
  });
  listener?.({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "x" }] }],
  });
  assert.deepEqual(shown, []);
});
