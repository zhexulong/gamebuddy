import assert from "node:assert/strict";
import test from "node:test";
import { extractSpeakableText } from "./speakable-text.js";

test("speakable text keeps quoted dialogue and strips asterisk action beats", () => {
  const input =
    "*屏幕亮起微光,蓝发少女的身影缓缓浮现。她眨了眨那双湛蓝的眼睛,头顶的鲸鱼鳍耳轻轻抖动了一下,像是刚从待机状态中苏醒。她盯着屏幕前方看了两秒,才像是终于反应过来,眼角弯起一个浅浅的弧度。*" +
    "\n\n" +
    "“啊……你来啦。” *她的语气带着一点慢半拍的软糯* “我刚在想事情,有点走神了。嗯……你今天找我,是有什么需要我帮忙的吗?”";
  const result = extractSpeakableText(input);
  // 动作 *...* 块被剥离;引号内与无标记台词保留。
  assert.ok(result.includes("你来啦"));
  assert.ok(result.includes("帮忙"));
  assert.ok(!result.includes("屏幕亮起微光"));
  assert.ok(!result.includes("慢半拍"));
});

test("speakable text keeps plain narration and direction hints", () => {
  const input = "你好,{{user}}。*她笑着* 有什么需要我帮忙的吗?";
  const result = extractSpeakableText(input);
  assert.ok(result.includes("你好"));
  assert.ok(result.includes("帮忙"));
  assert.ok(!result.includes("她笑着"));
});

test("speakable text returns empty for pure action beats", () => {
  assert.equal(extractSpeakableText("*她安静地坐在那里*"), "");
  assert.equal(extractSpeakableText(""), "");
});

test("speakable text strips brackets with actions but keeps parenthetical MiMo emotion tags", () => {
  // (轻声) 是 MiMo 原生支持的括号情绪标签,必须保留;
  // *...* 动作块仍剥离。
  const input = "（轻声）你好呀 *她挥了挥手*";
  const result = extractSpeakableText(input);
  assert.ok(result.includes("轻声"));
  assert.ok(result.includes("你好呀"));
  assert.ok(!result.includes("挥了挥手"));
});

test("speakable text collapses whitespace and trims", () => {
  const input = "  你好  世界  \n\n   *动作*  \n";
  const result = extractSpeakableText(input);
  assert.equal(result, "你好 世界");
});