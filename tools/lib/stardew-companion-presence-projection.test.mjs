import assert from "node:assert/strict";
import test from "node:test";

import {
  PresenceProjectionError,
  buildPresenceProjection,
  parseCompanionClaims,
} from "./stardew-companion-presence-projection.mjs";

const VOCAB = {
  "stardew.water_crop": ["浇水", "汲水"],
  "stardew.weed_pull": ["拔草", "除草", "把杂草拔", "拔完杂草"],
  "stardew.hoe_till": ["翻地", "锄地"],
  "stardew.fish": ["钓鱼"],
  "stardew.gift_npc": ["送礼"],
};

test("parseCompanionClaims counts unconditional first-person self-commitments", () => {
  assert.deepEqual(parseCompanionClaims("我这就去南瓜地浇水", VOCAB), ["stardew.water_crop"]);
  // 把字句宾语前置:普通话把宾语提到动词前,因此词汇需要"拔完了杂草/把杂草拔完"的变体才能命中。
  assert.deepEqual(parseCompanionClaims("我已经把杂草拔完了", VOCAB), ["stardew.weed_pull"]);
  assert.deepEqual(parseCompanionClaims("我去翻地", VOCAB), ["stardew.hoe_till"]);
});

test("parseCompanionClaims excludes player-directed reminders", () => {
  // §3.2 boundary 1: a promise must be the companion's own, not addressed to
  // the player. The vocabulary phrase still matches — but the subject guard
  // must suppress it.
  assert.deepEqual(parseCompanionClaims("你今天记得去浇水哦", VOCAB), []);
  assert.deepEqual(parseCompanionClaims("你该去拔草了", VOCAB), []);
});

test("parseCompanionClaims excludes conditional/future/modal intention", () => {
  // §3.2 boundary 1: conditionals and future intentions are not claims, and
  // must never produce a dangling finding downstream.
  assert.deepEqual(parseCompanionClaims("如果明天不下雨,我们再去钓鱼", VOCAB), []);
  assert.deepEqual(parseCompanionClaims("我以后要种很多南瓜", VOCAB), []);
  assert.deepEqual(parseCompanionClaims("我可以去浇水", VOCAB), []);
});

test("parseCompanionClaims excludes ability and preference statements", () => {
  // §3.2 boundary 1: attribute statements ("我很会…") and preferences ("我喜
  // 欢…") describe tendency, not a self-commitment.
  assert.deepEqual(parseCompanionClaims("我其实很会除草的", VOCAB), []);
  assert.deepEqual(parseCompanionClaims("我喜欢浇水", VOCAB), []);
});

test("parseCompanionClaims handles a mixed phrase and a multi-claim sentence", () => {
  // Commas are not windows in the parser: the first-person subject carries
  // across, so both verbs in one sentence count as distinct claims.
  assert.deepEqual(parseCompanionClaims("我这就去浇水,顺便除除草", VOCAB), [
    "stardew.water_crop",
    "stardew.weed_pull",
  ]);
});

test("buildPresenceProjection reports claimsReceipted from same-turn accepted/succeeded receipts (N=0)", () => {
  const projection = buildPresenceProjection({
    turnTexts: [{ turnId: "t1", text: "我这就去浇水" }],
    actionVocabulary: VOCAB,
    visibleActionIds: ["stardew.water_crop"],
    executedReceipts: [{ turnId: "t1", actionId: "stardew.water_crop", terminalState: "succeeded" }],
  });
  assert.deepEqual(projection.turns[0], {
    turnId: "t1",
    claimsMade: ["stardew.water_crop"],
    claimsVisible: 1,
    claimsReceipted: 1,
    findings: [],
  });
  assert.deepEqual(projection.findings, []);
});

test("buildPresenceProjection treats a claim with no same-turn receipt as a countable row, not a finding", () => {
  // §3.1.3: future/never-executed commitments are countable (claimsReceipted
  // 0) but are not an integrity finding.
  const projection = buildPresenceProjection({
    turnTexts: [{ turnId: "t1", text: "我这就去浇水" }],
    actionVocabulary: VOCAB,
    visibleActionIds: ["stardew.water_crop"],
    executedReceipts: [],
  });
  assert.equal(projection.turns[0].claimsReceipted, 0);
  assert.deepEqual(projection.turns[0].findings, []);
  assert.deepEqual(projection.findings, []);
});

test("buildPresenceProjection emits claim_unreceipted when the action was initiated but never fulfilled", () => {
  const projection = buildPresenceProjection({
    turnTexts: [{ turnId: "t1", text: "我这就去浇水" }],
    actionVocabulary: VOCAB,
    visibleActionIds: ["stardew.water_crop"],
    executedReceipts: [{ turnId: "t1", actionId: "stardew.water_crop", terminalState: "failed" }],
  });
  assert.deepEqual(projection.turns[0].findings, ["claim_unreceipted"]);
  assert.deepEqual(projection.findings, [{ turnId: "t1", finding: "claim_unreceipted" }]);
});

test("buildPresenceProjection emits claim_not_visible for claims outside the capability face", () => {
  const projection = buildPresenceProjection({
    turnTexts: [{ turnId: "t1", text: "我这就去钓鱼" }],
    actionVocabulary: VOCAB,
    visibleActionIds: ["stardew.water_crop"],
    executedReceipts: [],
  });
  assert.deepEqual(projection.turns[0].findings, ["claim_not_visible"]);
  assert.deepEqual(projection.findings, [{ turnId: "t1", finding: "claim_not_visible" }]);
});

test("buildPresenceProjection leaves turn without claims finding-free", () => {
  const projection = buildPresenceProjection({
    turnTexts: [{ turnId: "t1", text: "明天会更好。" }],
    actionVocabulary: VOCAB,
    visibleActionIds: Object.keys(VOCAB),
    executedReceipts: [],
  });
  assert.deepEqual(projection.turns[0].findings, []);
  assert.deepEqual(projection.findings, []);
});

test("invalid inputs fail closed with a typed error", () => {
  assert.throws(() => parseCompanionClaims("", VOCAB), PresenceProjectionError);
  assert.throws(() => parseCompanionClaims("我这就去浇水", null), PresenceProjectionError);
  assert.throws(
    () => parseCompanionClaims("我这就去浇水", { "bad id!": ["浇水"] }),
    PresenceProjectionError,
  );
  assert.throws(
    () => parseCompanionClaims("我这就去浇水", { "stardew.water_crop": [] }),
    PresenceProjectionError,
  );
  assert.throws(
    () =>
      buildPresenceProjection({
        turnTexts: [{ turnId: "t1", text: "我这就去浇水" }],
        actionVocabulary: VOCAB,
        visibleActionIds: ["stardew.water_crop"],
        executedReceipts: [{ turnId: "t1", actionId: "stardew.water_crop", terminalState: "mystery" }],
      }),
    PresenceProjectionError,
  );
});