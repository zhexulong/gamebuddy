import assert from "node:assert/strict";
import test from "node:test";

import {
  dehydrateCompanionSpeech,
  isEmptyAfterDehydration,
} from "./companion-speech-dehydration.js";

test("strips asterisk action beats and keeps dialogue", () => {
  assert.equal(
    dehydrateCompanionSpeech("*转过身微笑* 早安!今天天气真好。"),
    "早安!今天天气真好。",
  );
  assert.equal(
    dehydrateCompanionSpeech('*她的语气慢半拍* "需要帮忙吗?"'),
    '"需要帮忙吗?"',
  );
});

test("strips <thinking>/<thought> blocks, possibly multi-line", () => {
  assert.equal(
    dehydrateCompanionSpeech("<thinking>玩家在农场西侧</thinking>我去看看吧。"),
    "我去看看吧。",
  );
  assert.equal(
    dehydrateCompanionSpeech("<thought>多行\n推理</thought>好的!"),
    "好的!",
  );
});

test("strips parenthesised asides used in character replies", () => {
  assert.equal(
    dehydrateCompanionSpeech("种子帮你种好了,(轻声)记得浇水哦。"),
    "种子帮你种好了, 记得浇水哦。",
  );
  assert.equal(
    dehydrateCompanionSpeech("花椰菜种好啦（浇水壶从40降到38）等你来验收。"),
    "花椰菜种好啦 等你来验收。",
  );
});

test("strips markdown horizontal-rule separators", () => {
  assert.equal(
    dehydrateCompanionSpeech("搞定！\n\n---\n**一句话总结：** 种好浇透了。"),
    "搞定！ 一句话总结： 种好浇透了。",
  );
});

test("collapses whitespace and normalizes NFC, trims surrounding beats", () => {
  assert.equal(dehydrateCompanionSpeech("  *笑*  你好 , **粗体强调** 世界。 "), "你好 , 世界。");
  assert.equal(dehydrateCompanionSpeech("Cafe\u0301"), "Café");
});

test("detects pure stage direction as empty after dehydration", () => {
  assert.equal(isEmptyAfterDehydration("*转过身微笑*"), true);
  assert.equal(isEmptyAfterDehydration("<thinking>思考</thinking>"), true);
  assert.equal(isEmptyAfterDehydration("(轻声)"), true);
  assert.equal(isEmptyAfterDehydration("（轻声）"), true);
  assert.equal(isEmptyAfterDehydration(""), true);
  assert.equal(isEmptyAfterDehydration("早安!"), false);
});

test("handles mixed beats and keeps remaining speakable dialogue", () => {
  assert.equal(
    dehydrateCompanionSpeech(
      '<thinking>他想要种子</thinking>*微笑走近* "给你种子," (轻声) "记得浇水哦。"',
    ),
    '"给你种子," "记得浇水哦。"',
  );
});