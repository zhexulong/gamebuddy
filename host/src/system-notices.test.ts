import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProviderFailureSystemNotice,
  resolveProviderWaitSystemNotice,
  resolveStopSystemNotice,
} from "./system-notices.js";

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

/**
 * The provider lane: one line that dates the wait, and the provider's own words when it refuses.
 *
 * Both are STATUS, not speech: the key says so on the wire (`system.provider.*`, never a
 * `companion_text` piece), and the game thread checks the copy under each key before drawing it.
 */
test("the provider-wait line is registered copy in the player's own language", () => {
  assert.deepEqual(resolveProviderWaitSystemNotice("zh-CN"), {
    key: "system.provider.waiting",
    locale: "zh-CN",
    text: "已连上游戏，正在等待模型服务…",
  });
  assert.deepEqual(resolveProviderWaitSystemNotice("en-US"), {
    key: "system.provider.waiting",
    locale: "en-US",
    text: "Connected. Waiting for the provider…",
  });
  // A valid tag this build has no copy for falls back to English rather than mixing scripts.
  assert.equal(resolveProviderWaitSystemNotice("ja-JP").text, "Connected. Waiting for the provider…");
});

test("a provider refusal keeps its own words, behind a registered sentence in the player's language", () => {
  const line = '429: {"message":"the cell is at capacity; retry shortly (after 30 s)"}';
  assert.deepEqual(resolveProviderFailureSystemNotice("zh-CN", line), {
    key: "system.provider.unavailable",
    locale: "zh-CN",
    text: `模型服务暂时用不了：${line}`,
  });
  assert.equal(
    resolveProviderFailureSystemNotice("en-US", line).text,
    `The provider can't answer: ${line}`,
    "the provider's words are never translated, so only the sentence around them is",
  );
  // The wire admits 256 characters (`protocol/bridge-v1.schema.json`); a bounded provider line plus the registered
  // sentence has to stay inside it in both languages, or the game thread would refuse the very line that explains a stall.
  for (const locale of ["zh-CN", "en-US"])
    assert.ok(
      resolveProviderFailureSystemNotice(locale, "x".repeat(180)).text.length <= 256,
      `${locale} copy must fit the wire bound`,
    );
});

test("the provider notices reject malformed locales like every other registered line", () => {
  assert.throws(() => resolveProviderWaitSystemNotice("zh_CN"), /invalid_system_notice_locale/);
  assert.throws(() => resolveProviderFailureSystemNotice("", "429: slow down"), /invalid_system_notice_locale/);
});
