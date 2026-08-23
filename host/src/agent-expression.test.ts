import assert from "node:assert/strict";
import test from "node:test";

import { finalAssistantText } from "./agent-expression.js";

test("extracts only completed assistant text for a private task summary", () => {
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
