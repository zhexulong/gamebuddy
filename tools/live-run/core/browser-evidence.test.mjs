import assert from "node:assert/strict";
import { test } from "node:test";

import { assertRenderedTranscript, findBrowserExecutable } from "./browser-evidence.mjs";

const transcript = Object.freeze([
  Object.freeze({ handle: "msg_1", role: "player", text: "你好" }),
  Object.freeze({ handle: "msg_2", role: "companion", text: "嘿，你来了。" }),
]);

const goodDom = Object.freeze({
  shellPresent: true,
  handles: ["msg_1", "msg_2"],
  bubbleTexts: ["你好", "嘿，你来了。"],
  bodyText: "聊天 你好 嘿，你来了。",
});

test("rendered transcript assertions pass when the DOM matches the durable state", () => {
  const verdict = assertRenderedTranscript(goodDom, transcript, { expectedPlayerTexts: ["你好"] });
  assert.equal(verdict.passed, true, JSON.stringify(verdict.results));
  assert.deepEqual(
    verdict.results.map((result) => result.assertion),
    [
      "chat_surface_mounted",
      "rendered_message_count_matches_state",
      "rendered_handle_order_matches_state",
      "no_empty_bubble",
      "no_preview_bubble_after_terminal",
      "rendered_text_matches_state_text",
      "no_macro_residue_in_dom",
      "no_reasoning_leak_in_dom",
      "no_transport_marker_in_dom",
      "no_debug_marker_in_dom",
      "player_messages_rendered",
    ],
  );
});

test("rendered transcript assertions name each rendering defect", () => {
  const cases = [
    [{ ...goodDom, handles: ["msg_1", "msg_2"], bodyText: "{{user}} 你好" }, "no_macro_residue_in_dom"],
    [{ ...goodDom, handles: ["msg_1", "turn_9_preview"] }, "no_preview_bubble_after_terminal"],
    [{ ...goodDom, handles: ["msg_2", "msg_1"] }, "rendered_handle_order_matches_state"],
    [{ ...goodDom, handles: ["msg_1"] }, "rendered_message_count_matches_state"],
    [{ ...goodDom, bubbleTexts: ["你好", "嘿，你来了"] }, "rendered_text_matches_state_text"],
    [{ ...goodDom, shellPresent: false }, "chat_surface_mounted"],
    [{ ...goodDom, bubbleTexts: ["你好", "   "] }, "no_empty_bubble"],
    [{ ...goodDom, bodyText: "聊天" }, "player_messages_rendered"],
    [{ ...goodDom, bodyText: "[DEBUG-chat-live-p4c] admission_ok" }, "no_debug_marker_in_dom"],
  ];
  for (const [dom, expectedAssertion] of cases) {
    const verdict = assertRenderedTranscript(dom, transcript, { expectedPlayerTexts: ["你好"] });
    assert.equal(verdict.passed, false, `expected a failure for ${expectedAssertion}`);
    assert.equal(
      verdict.results.find((result) => result.assertion === expectedAssertion)?.ok,
      false,
      `expected ${expectedAssertion} to fail`,
    );
  }
});

test("a machine without a browser reports it by name instead of pretending", async () => {
  assert.equal(await findBrowserExecutable({ executable: undefined, env: {}, exists: () => false }), undefined);
  assert.equal(
    await findBrowserExecutable({ executable: "C:/browser.exe", env: {}, exists: (path) => path === "C:/browser.exe" }),
    "C:/browser.exe",
  );
});
