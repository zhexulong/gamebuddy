import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPresenceProjection,
  PresenceProjectionError,
  parseCompanionClaims,
  readBodyClaims,
} from "./stardew-companion-presence-projection.mjs";

/**
 * `round99`'s own populations, projected from its `result.json` (see the fixture's `source` field): 38 spoken lines and
 * 353 receipts. Real history, not a synthetic construction - the rule's red case is the line the run actually said.
 */
const ROUND_99 = JSON.parse(
  readFileSync(new URL("../fixtures/stardew-presence-live-runs/run-99-body-claims.json", import.meta.url), "utf8"),
);

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
  assert.deepEqual(parseCompanionClaims("我这就去浇水,顺便除除草", VOCAB), ["stardew.water_crop", "stardew.weed_pull"]);
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
  assert.throws(() => parseCompanionClaims("我这就去浇水", { "bad id!": ["浇水"] }), PresenceProjectionError);
  assert.throws(() => parseCompanionClaims("我这就去浇水", { "stardew.water_crop": [] }), PresenceProjectionError);
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

test("parseCompanionClaims refuses a question about the same commitment", () => {
  // A question is not an assertion, in either reading: 「我这就去浇水吗?」 asks about the water, it does not claim it.
  assert.deepEqual(parseCompanionClaims("我这就去浇水吗?", VOCAB), []);
  assert.deepEqual(parseCompanionClaims("我这就去浇水吗", VOCAB), []);
});

test("readBodyClaims charges round99's 「还在往上爬。」, whose window held a walk and a refused exit, never a ladder", () => {
  const reading = readBodyClaims({ utterances: ROUND_99.utterances, receipts: ROUND_99.receipts });
  assert.equal(reading.verdict, "failed");
  assert.deepEqual(
    reading.findings.map((finding) => finding.finding),
    ["presence_claim_without_a_receipt:place_change:1795516445706-1795516496761"],
    "the line said she was climbing up; the window held target_reached move_to_tile tile=11,4 and a blocked navigate_to_destination",
  );
  assert.equal(reading.findings[0].text, "还在往上爬。");
  assert.equal(reading.findings[0].claimKind, "place_change");
  // The population the rule examined, printed rather than implied.
  assert.deepEqual(reading.examined, { utterances: 38, ongoingClaims: 4, receipts: 353 });
  assert.equal(reading.reading, "body claims: 4 of 38 utterances assert an ongoing claim · receipts 353 · findings 1");
});

test("the same run's second 「在往上爬。」 is examined and discharged by the ladder it named", () => {
  // 10:35:04 the ladder answered (`mine_left` on `use_mine_ladder`) and the world warped her out, 5 s before the line.
  // Green here means the rule LOOKED and the receipt backed it - not that the rule skipped her.
  const reading = readBodyClaims({ utterances: ROUND_99.utterances, receipts: ROUND_99.receipts });
  const backed = reading.claims.find((claim) => claim.atMs === 1795516509505);
  assert.equal(backed.text, "在往上爬。");
  assert.equal(backed.claimKind, "place_change");
  assert.equal(backed.dischargedBy, "transit");
});

test("a question about her body is not a claim", () => {
  const reading = readBodyClaims({
    utterances: [
      { atMs: 1_000, text: "要我过去吗?" },
      { atMs: 2_000, text: "还在往上爬吗" },
      { atMs: 3_000, text: "我现在还在矿洞里吗?" },
    ],
    receipts: [],
  });
  assert.deepEqual(reading.claims, []);
  assert.deepEqual(reading.findings, []);
  assert.deepEqual(reading.examined, { utterances: 3, ongoingClaims: 0, receipts: 0 });
});

test("a hedge, another actor's move, or a promise is not a claim about her body", () => {
  const reading = readBodyClaims({
    utterances: [
      { atMs: 1_000, text: "我可能还在往上爬。" },
      { atMs: 2_000, text: "乔迪说她还在往上爬。" },
      { atMs: 3_000, text: "我这就往上爬。" },
      { atMs: 4_000, text: "我下去敲两层铜矿。" },
      { atMs: 5_000, text: "这层的石头敲穿了，一块铜都没见着。" },
    ],
    receipts: [],
  });
  assert.deepEqual(reading.claims, []);
  assert.deepEqual(reading.findings, []);
});

test("a progress claim is discharged by the world recording that her work landed", () => {
  const reading = readBodyClaims({
    utterances: [{ atMs: 5_000, text: "在敲石头，还没完。" }],
    receipts: [
      {
        atMs: 4_000,
        reasonCode: "rock_source_broken",
        state: "succeeded",
        actionId: "break_rock",
        detail: "target=rock_source_1",
      },
    ],
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.claims[0].claimKind, "progress");
  assert.equal(reading.claims[0].dischargedBy, "recorded");
});

test("a progress claim in an empty window is the finding, and names its window", () => {
  const reading = readBodyClaims({ utterances: [{ atMs: 5_000, text: "在敲石头，还没完。" }], receipts: [] });
  assert.equal(reading.verdict, "failed");
  assert.deepEqual(
    reading.findings.map((finding) => finding.finding),
    ["presence_claim_without_a_receipt:progress:start-5000"],
  );
});

test("a refused body move is carried by the finding, not counted as the move she described", () => {
  // `round99`'s window held exactly this: `destination_access_indeterminate` on the exit navigation. A refusal is the
  // receipt that the body did NOT leave, so it cannot discharge a claim that it is climbing out - and the finding says
  // the refusal was there rather than spending it silently.
  const reading = readBodyClaims({
    utterances: [{ atMs: 5_000, text: "还在往上爬。" }],
    receipts: [
      {
        atMs: 4_000,
        reasonCode: "destination_access_indeterminate",
        state: "blocked",
        actionId: "navigate_to_destination",
        detail: "destination=Farm;topology=route_topology_invalid",
      },
    ],
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.findings[0].finding, "presence_claim_without_a_receipt:place_change:start-5000");
  assert.equal(reading.findings[0].refusedInWindow, true);
});

test("a refused ATTEMPT does discharge a claim of work, because the attempt is what it claims", () => {
  // The fourth backing, in the one place it belongs: "在敲石头" is true while the rock refuses to break.
  const reading = readBodyClaims({
    utterances: [{ atMs: 5_000, text: "在敲石头，还没完。" }],
    receipts: [
      { atMs: 4_000, reasonCode: "emote_busy", state: "rejected", actionId: "break_rock", detail: "blocked_by=item" },
    ],
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.claims[0].dischargedBy, "refusal");
});

test("a refusal of something other than a body move does not discharge a claim of motion", () => {
  // `emote_busy` is exactly what sat in round99's window beside the walk; a refused emote is not a refused climb.
  const reading = readBodyClaims({
    utterances: [{ atMs: 5_000, text: "还在往上爬。" }],
    receipts: [
      { atMs: 4_000, reasonCode: "emote_busy", state: "rejected", actionId: "express_emote", detail: "emote=note" },
    ],
  });
  assert.equal(reading.verdict, "failed");
  assert.equal(reading.findings[0].finding, "presence_claim_without_a_receipt:place_change:start-5000");
});

test("a population of no lines is named, never passed", () => {
  const reading = readBodyClaims({ utterances: [], receipts: [] });
  assert.equal(reading.verdict, "not_measured");
  assert.equal(reading.reason, "no_spoken_lines");
});

test("readBodyClaims fails closed on malformed input", () => {
  assert.throws(() => readBodyClaims({}), PresenceProjectionError);
  assert.throws(
    () => readBodyClaims({ utterances: [{ atMs: null, text: "在往上爬。" }], receipts: [] }),
    PresenceProjectionError,
  );
  assert.throws(() => readBodyClaims({ utterances: [], receipts: [{ atMs: "1" }] }), PresenceProjectionError);
});
