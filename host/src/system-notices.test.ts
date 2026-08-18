import assert from "node:assert/strict";
import test from "node:test";

import { resolveStopSystemNotice } from "./system-notices.js";

test("STOP system notices use the released Simplified Chinese copy while retaining the exact locale", () => {
  assert.deepEqual(resolveStopSystemNotice("active_turn_cancelled", "zh-CN"), {
    key: "system.stop.active_turn_cancelled",
    locale: "zh-CN",
    text: "已停止生成。",
  });
});

test("queued STOP confirms cancellation without claiming Pi already started", () => {
  assert.deepEqual(resolveStopSystemNotice("queued_turn_cancelled", "zh-CN"), {
    key: "system.stop.queued_turn_cancelled",
    locale: "zh-CN",
    text: "已停止生成。",
  });
});

test("STOP system notices use English fallback without rewriting the game locale", () => {
  assert.deepEqual(resolveStopSystemNotice("active_turn_cancelled", "en-US"), {
    key: "system.stop.active_turn_cancelled",
    locale: "en-US",
    text: "Generation stopped.",
  });
  assert.deepEqual(resolveStopSystemNotice("no_active_turn", "zh-TW"), {
    key: "system.stop.no_active_turn",
    locale: "zh-TW",
    text: "No reply is currently being generated.",
  });
});

test("STOP system notices reject malformed locales", () => {
  assert.throws(() => resolveStopSystemNotice("active_turn_cancelled", "zh_CN"), /invalid_system_notice_locale/);
});
