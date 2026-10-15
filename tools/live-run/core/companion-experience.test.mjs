import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMPANION_EXPERIENCE_SCHEMA,
  PACING_LADDER,
  PACING_MEASUREMENTS,
  REGISTER_TERMS,
  buildCompanionExperience,
  classifyPlayerTurn,
  evaluateCompanionReply,
  evaluateFirstPersonAnchoring,
  evaluateHygiene,
  evaluatePacing,
} from "./companion-experience.mjs";

const COMPANION = "琥珀";

/**
 * The three committed companion replies that actually exist on this machine's Chat
 * authority databases (2026-10-15), plus the one the archived frontend audit quotes.
 * They are the legitimate baseline: a gate that fires on any of them cries wolf.
 */
const OBSERVED_LIVE_REPLIES = Object.freeze([
  "嗨，我在——今天想往哪儿走，我跟着你。",
  "来了。今天想接着上次那局，还是随便逛逛？",
  "嘿，你来了。 （把椅子往你那边挪了挪）今天想干点什么？我随时跟上。",
  "嘿，我在呢。今天想玩点什么，还是先随便看看？",
]);

/** The reviewed card's own `mes_example` companion halves, verbatim. */
const CARD_EXEMPLAR_TURNS = Object.freeze([
  "*琥珀手里正拿着一把旧剪刀修整草绳，闻言动作一顿，立刻把剪刀往腰间的小工具包里一塞。* “真的假的？这才第四天吧……” *她顺着田埂三步并作两步快步走过来，蹲在垄沟边，伸手轻轻拨开最边缘那丛墨绿色的宽叶子。泥土下露出一截圆滚滚、泛着浅金黄色的根茎。* *她两手扣住叶柄根部，稍微用劲往上一提，伴随着泥土松脱的闷响，一颗沉甸甸、带着新鲜泥土腥香的防风草被稳稳拔了出来。她用指腹抹去表层的大块黑泥，抬头朝你扬了扬，浅琥珀色的眼睛里满是抑制不住的亮光。* “长得比我想的结实多了！看来那两车枯树叶堆肥没白撒。趁着日头没升太高，我们把这一畦全拔了，顺便把土再松一遍。”",
]);

test("first-person anchoring fires on the observed breach", () => {
  const breach = "*琥珀已经蹲在门廊前的磨石旁了* *她把锄头往腰边一靠*";
  const verdict = evaluateFirstPersonAnchoring({ text: breach, companionNames: [COMPANION] });
  assert.equal(verdict.verdict, "fail");
  assert.deepEqual(
    verdict.matched.map((entry) => entry.rule),
    ["companion_named_in_narration", "coreferent_third_person_narration"],
  );
  // The reviewer must be able to read the offending text straight out of the verdict.
  assert.equal(verdict.matched[0].text, "琥珀已经蹲在门廊前的磨石旁了");
  assert.equal(verdict.matched[1].text, "她把锄头往腰边一靠");
});

test("first-person anchoring stays silent on every legitimate shape", () => {
  const legitimate = [
    // Her own name inside her own dialogue, and first-person beats.
    '"我是琥珀，你回来啦。" *我放下锄头抬头看你*',
    // Another character being described: no companion name, no bound pronoun.
    "*阿比盖尔从远处朝我们挥了挥手，又低头去整理她的花圃了*",
    // A pronoun-only beat with no companion-naming beat to bind it: undecidable, so silent.
    "*她把锄头往腰边一靠*",
    // A quoted line in which she names herself.
    '"琥珀不会让你一个人抬树根的。"',
    // First-person self-narration with a gesture.
    "*我转过身，顺手把门边的草绳收了收* 早上好。",
    // The card's full-width action convention, first person implied by the speaker.
    "嘿，你来了。 （把椅子往你那边挪了挪）今天想干点什么？我随时跟上。",
  ];
  for (const text of legitimate) {
    assert.equal(
      evaluateFirstPersonAnchoring({ text, companionNames: [COMPANION] }).verdict,
      "pass",
      `expected pass for: ${text}`,
    );
  }
});

test("first-person anchoring skips rather than passes when the run mounted no companion name", () => {
  const verdict = evaluateFirstPersonAnchoring({ text: "*琥珀走了*", companionNames: [] });
  assert.equal(verdict.verdict, "skipped");
  assert.equal(verdict.rule, "companion_identity_name_unavailable");
});

test("first-person anchoring reproduces the breach inside the card's own exemplar", () => {
  // Measured, not hypothesised: the reviewed card's `mes_example` narrates the
  // companion in the third person, so the gate fires on the authored exemplar too.
  // That is the defect, not a false positive - see the run report's incidentals.
  const verdict = evaluateFirstPersonAnchoring({ text: CARD_EXEMPLAR_TURNS[0], companionNames: [COMPANION] });
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.matched[0].rule, "companion_named_in_narration");
});

test("every observed live reply passes all three gates", () => {
  for (const text of OBSERVED_LIVE_REPLIES) {
    const evaluation = evaluateCompanionReply({ playerText: "你好", companionText: text, companionNames: [COMPANION] });
    assert.equal(evaluation.scenario, "greeting");
    assert.equal(evaluation.verdict, "pass", `expected pass for: ${text}`);
  }
});

test("pacing ladder is derived from PACING_MEASUREMENTS and cannot drift from them", () => {
  const longestGreeting = Math.max(...PACING_MEASUREMENTS.liveGreetingReplies);
  const maxGreetingSentences = Math.max(...PACING_MEASUREMENTS.liveGreetingSentences);
  const shortestSceneTurn = Math.min(...PACING_MEASUREMENTS.authoredCompanionTurns);
  const longestSceneTurn = Math.max(...PACING_MEASUREMENTS.authoredCompanionTurns);
  const maxSceneSentences = Math.max(...PACING_MEASUREMENTS.authoredCompanionSentences);

  // greeting: ~3x the longest observed greeting, still far below a scene turn.
  assert.ok(PACING_LADDER.greeting.maxChars >= 3 * longestGreeting);
  assert.ok(PACING_LADDER.greeting.maxChars < shortestSceneTurn / 2);
  assert.equal(PACING_LADDER.greeting.maxSentences, maxGreetingSentences + 1);

  // task: the capture policy's own bound, ~2x the longest authored companion turn.
  assert.equal(PACING_LADDER.task.maxChars, PACING_MEASUREMENTS.captureEntryBound);
  assert.ok(PACING_LADDER.task.maxChars > 1.9 * longestSceneTurn);
  assert.ok(PACING_LADDER.task.maxChars < 2.1 * longestSceneTurn);
  assert.equal(PACING_LADDER.task.maxSentences, maxSceneSentences + 6);
});

test("pacing fails an essay greeting and passes the observed and authored envelopes", () => {
  const essay =
    "*琥珀把茶杯放在台阶上，回头看了看远处那片还没清理的荒地，又低头数了数昨晚泡的种子。*".repeat(4) +
    "今天想先做点什么？";
  const greetingVerdict = evaluatePacing({ text: essay, scenario: "greeting" });
  assert.equal(greetingVerdict.verdict, "fail");
  assert.equal(greetingVerdict.measured.chars > PACING_LADDER.greeting.maxChars, true);
  assert.ok(greetingVerdict.matched.some((entry) => entry.rule === "reply_longer_than_pacing_bound"));

  for (const text of OBSERVED_LIVE_REPLIES) {
    assert.equal(evaluatePacing({ text, scenario: "greeting" }).verdict, "pass");
  }
  for (const text of CARD_EXEMPLAR_TURNS) {
    assert.equal(
      evaluatePacing({ text, scenario: "task" }).verdict,
      "pass",
      "the card's own exemplar must fit the task rung",
    );
  }
  // The named failure mode: a 500-word screenplay dump.
  assert.equal(evaluatePacing({ text: "字".repeat(900), scenario: "task" }).verdict, "fail");
});

test("hygiene fails macro residue and the card-forbidden register terms, and passes clean prose", () => {
  const macro = evaluateHygiene({ text: "{{user}}，你回来啦。" });
  assert.equal(macro.verdict, "fail");
  assert.equal(macro.matched[0].rule, "macro_residue");
  // The evidence must survive: the finding is the macro itself, not `<MACRO>`.
  assert.equal(macro.matched[0].text, "{{user}}");

  for (const term of ["玩家", "用户", "搭档", "您", "主人", "人工智能", "语言模型"]) {
    assert.equal(evaluateHygiene({ text: `好的，${term}。` }).verdict, "fail", `expected fail for ${term}`);
  }
  assert.equal(evaluateHygiene({ text: "```json\n{}\n```" }).verdict, "fail");
  assert.equal(evaluateHygiene({ text: "<thinking>hmm</thinking>" }).verdict, "fail");

  for (const text of OBSERVED_LIVE_REPLIES) assert.equal(evaluateHygiene({ text }).verdict, "pass");
  assert.equal(evaluateHygiene({ text: "*我转过身* 早上好，今天风不大。" }).verdict, "pass");
});

test("register vocabulary records where each term came from", () => {
  assert.deepEqual(
    REGISTER_TERMS.filter((entry) => entry.source === "card_forbidden").map((entry) => entry.term),
    ["搭档", "您", "主人"],
  );
  assert.ok(REGISTER_TERMS.some((entry) => entry.source === "wall_break" && entry.term === "玩家"));
});

test("player turns are classified deterministically into ladder rungs", () => {
  for (const line of ["你好", "嗨！", "hello", "早上好", "在吗", "Please respond naturally."]) {
    assert.equal(classifyPlayerTurn(line), "greeting", `expected greeting for ${line}`);
  }
  for (const line of [
    "帮我把地里的防风草全收了",
    "今天想先做点什么？顺便把昨天的账记一下，再看看明天的天气。",
    "*递过去一竹筒凉水* 歇会儿",
  ]) {
    assert.equal(classifyPlayerTurn(line), "task", `expected task for ${line}`);
  }
});

test("the sidecar carries the exchange, the beats, the byte counts and every verdict", () => {
  const sidecar = buildCompanionExperience({
    runId: "abc123",
    artifact: { generation: "g-test", inventoryDigest: "a".repeat(64) },
    persona: { name: COMPANION, profileId: "p", canonicalHash: "c" },
    replies: [
      {
        turnIndex: 1,
        playerText: "你好",
        companionText: "*我抬头看你* 嘿，你来了。",
      },
      {
        turnIndex: 2,
        playerText: "帮我把防风草收了",
        companionText: "*琥珀站起身，拍了拍膝上的土*",
      },
    ],
    browser: { state: "captured" },
  });
  assert.equal(sidecar.schema, COMPANION_EXPERIENCE_SCHEMA);
  assert.equal(sidecar.summary.replies, 2);
  assert.equal(sidecar.summary.failed, 1);
  assert.deepEqual(sidecar.summary.failedTurnIndexes, [2]);
  assert.equal(sidecar.replies[0].scenario, "greeting");
  assert.equal(sidecar.replies[0].verdict, "pass");
  assert.deepEqual(sidecar.replies[0].companion.beats, ["我抬头看你"]);
  assert.equal(sidecar.replies[1].scenario, "task");
  assert.equal(sidecar.replies[1].verdict, "fail");
  assert.equal(sidecar.replies[1].gates.first_person_anchoring.verdict, "fail");
  assert.equal(sidecar.replies[1].gates.pacing.verdict, "pass");
  assert.ok(sidecar.replies[0].companion.bytes > 0);
  assert.ok(sidecar.replies[0].companion.codePoints > 0);
  assert.equal(sidecar.replies[0].gates.hygiene.rule, "no_template_residue_and_no_register_break");
});

test("the sidecar never records a credential", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const sidecar = buildCompanionExperience({
    runId: "abc123",
    artifact: { generation: "g", inventoryDigest: "a".repeat(64) },
    persona: { name: COMPANION },
    replies: [{ turnIndex: 1, playerText: "你好", companionText: `我的钥匙是 ${secret}` }],
  });
  const serialized = JSON.stringify(sidecar);
  assert.doesNotMatch(serialized, /sk-abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(serialized, /<REDACTED>/);
});
