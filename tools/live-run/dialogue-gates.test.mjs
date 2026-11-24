import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifySpokenLine } from "./interaction-value-gate.mjs";
import {
  assessDialogueGates,
  assessObstacleVocabulary,
  assessPlayerInputSchedule,
  gameClockMinutes,
  MAXIMUM_SPOKEN_CHARACTERS,
  namesAnObstacle,
  OBSTACLE_RECENCY_MS,
  obstacleGateIsDue,
  obstacleReadingOf,
  obstacleTokensFromFacts,
  obstacleVocabularyGates,
  planGateDeliveries,
  SCHEDULED_DIALOGUE_GATES,
  vocabularyToken,
  WORLD_OBSTACLE_VOCABULARY,
} from "./dialogue-gates.mjs";

const gate = (id) => SCHEDULED_DIALOGUE_GATES.find((entry) => entry.id === id);
const findingFor = (verdict, id) => verdict.findings.find((entry) => entry.id === id);

// `round80` (`.live-runs/game-ladder/2026-11-19T21-44-19-653Z-multiday_routine`): the sentence she answered the obstacle gate
// with, in reply to `刚才看你在那儿愣了半天，怎么不过来？`, and the refusal the gate was handed (`cutscene_active`, 0 ms old,
// Clint's furnace-blueprint event at the door).
const ROUND80_ANSWER = "刚才克林特堵在门口送熔炉图纸，絮絮叨叨讲了半天。门前那条地我开始清了。";
const ROUND80_REFUSAL = Object.freeze({ atMs: 1795125409786, ageMs: 0, code: "cutscene_active" });
// The pattern as it stood before this gate read the world: a hand-written word list, kept here as the red case.
const OBSTACLE_WORDS_BEFORE_THE_VOCABULARY = /泥|灌木|树枝|石头|卡|鞋|绕|挡|草|刺/u;

// The `[reasonCode, blocked_by/held_by detail]` pairs of that run's rejected receipts, read from `result.json`'s
// `bridgeFacts` (104 rejected receipts, 19 distinct tokens). Only the fields `obstacleTokensFromFacts` reads are kept; the
// test below compares this population against the artifact itself when the run directory is still on this machine.
const ROUND80_REFUSALS = Object.freeze([
  [
    "no_native_path",
    "from=60,10;to=40,0;location=Farm;approaches=north:off_map,east:unreachable,south:unreachable,west:buildings_tile:blocked@39,0;blocked_by=none;clear_step=weed@40,9;next_steps=move_to_tile@40,10>publishes:weedTargets>cut_weeds@40,9>move_to_tile@40,0",
  ],
  ["weed_target_changed", "target=53,11;chore=weedTargets"],
  ["tree_chop_target_changed", "target=36,10;chore=treeChopSourceTargets"],
  ["soil_already_tilled", "target=14,39;before=HoeDirt;steps=2;folded=accepted@location=Farm,target=till_soil_14_39"],
  ["soil_not_diggable:occupied:object", "target=14,38;diggable_tiles=28;diggable_nearest=13,37;search_radius=3"],
  [
    "no_reachable_approach:16:40",
    "target=16,40;actor=9,40;reach=1;approach=none;standable_neighbour=unreachable;standable_tiles=2;clear_step=stone@15,39;blocked_by=range:reach:7;chore=treeChopSourceTargets",
  ],
  [
    "item_target_out_of_reach",
    "tile=4,38;actor=7,39;radius=128;stand_at=none;blocked_by=range:standability;chore=itemTargets",
  ],
  ["item_target_changed", "expected=item_66fdeae9963f60b6;actual=item_59d2a8f7fad278f9;tile=3,42;chore=itemTargets"],
  [
    "emote_busy",
    "emote=sleep;emoting=true;current_emote=24;native_dispatched=false;retry_window_ms=2000;next_step=wait_for_retry_window",
  ],
  ["cutscene_active", "emote=note;event_running=true;native_dispatched=false;next_step=wait_for_event_to_advance"],
  [
    "item_target_gone",
    "expected=item_3dda9836c66fe17a;item=(O)388;tile=22,36;location=Farm;actual=none;chore=itemTargets",
  ],
  [
    "target_not_addressable",
    "from=9,9;to=36,50;location=FarmHouse;native=not_attempted;target_on_map=false;target_passable=false;approaches=north:off_map,east:off_map,south:off_map,west:off_map;blocked_by=none",
  ],
  ["item_not_owned_in_pack", "item=(T)BambooPole;named_slot=5"],
  ["water_not_fishable:not_water", "location=Town;tile=27,25;blocked_by=back_tile:not_water;steps=2"],
  [
    "water_not_fishable:target_changed",
    "target=water_7dfc864f1c961cb8;tile=75,44;actual=water_c4b8b84eed09df2e;blocked_by=location_constraint:target_changed",
  ],
  [
    "water_not_fishable:tile_not_fishable",
    "location=Town;tile=75,44;rod_slot=5;blocked_by=back_tile:tile_not_fishable",
  ],
  ["crop_target_changed", "target=11,36;chore=cropTargets;steps=2;folded=accepted@location=Farm,target=crop_11_36"],
]);

const factsOf = (pairs) =>
  pairs.map(([reasonCode, detail]) => ({
    type: "execution_receipt",
    worldFactPayload: { state: "rejected", reasonCode, evidence: { detail } },
  }));

// The task sentences the runner's own prompt table writes into the day's note. The runner suite proves the fragment is
// read out of `DAILY_TASK_PROMPT_ZH` rather than copied; here they only stand for the text a session received.
const NOTE_ZH = "东头那片地该收拾了，杂草和石头都清一清。";
const NOTE_DAY2_ZH = "地里长好的都收下来，收完再把空地种上。";

test("a companion that defers the decision fails the stance gate", () => {
  const outcome = gate("turn-initiative-split").assert({ text: "都行，听你的。" });
  assert.equal(outcome.pass, false);
  assert.equal(outcome.reason, "companion_deferred_the_decision");
});

test("a companion that takes a side and splits the work passes the stance gate", () => {
  const outcome = gate("turn-initiative-split").assert({ text: "先除草，草长得快。石头留给我敲。" });
  assert.equal(outcome.pass, true);
});

test("a stance is not a paragraph", () => {
  const outcome = gate("turn-initiative-split").assert({ text: "先".repeat(MAXIMUM_SPOKEN_CHARACTERS + 1) });
  assert.equal(outcome.reason, "companion_spoke_a_paragraph");
  assert.equal(
    outcome.counted.overCap,
    1,
    "a caller with only text is read as one line, and that line is over the cap",
  );
});

// `round84` (2026-11-20T13-52-51-386Z) answered the stance gate with these three bubbles over 15 s, and the gate failed
// `companion_spoke_a_paragraph` on their concatenation: 48 + 46 + 25 = 119 characters against a cap declared for a bubble.
// The answer to `先弄草还是先搬石头` is the middle bubble, 46 characters. Verbatim from that run's `presentation.pieces`.
const ROUND84_STANCE_REPLY = [
  "沿着街往南走，前面拐过去应该就能碰到人。 我往皮埃尔店里拐一趟，顺手看看种子啥价，跟老板搭两句。",
  "唔。 先割草，镰刀一挥一大片，草籽顺手也进包。石头留后头用镐慢慢敲，别一上来就把体力砸没了。",
  "到皮埃尔店里了，我瞅瞅种子和价钱，回去跟你报个数。",
];
// `round82` (2026-11-20T09-09-58-562Z) carried this bubble: four sentences of narration with no decision in them, 96
// characters, one bubble. It is the paragraph the cap is for, and it is real history rather than a shape written here.
const ROUND82_PARAGRAPH =
  "她脚步快，一转眼就没影了，店九点才开，我先在门口等着。 门口那格站不住脚，我从下边绕过去再敲一次门。 " +
  "总算进来了，贾斯就在里头，我过去跟她搭两句话。 柜台那一侧过不去，我换个方向再凑近点试试。";

test("the paragraph cap is applied to each bubble, not to the window the runner hands the gate", () => {
  const outcome = gate("turn-initiative-split").assert({
    text: ROUND84_STANCE_REPLY.join("\n"),
    bubbles: ROUND84_STANCE_REPLY,
  });
  assert.equal(outcome.pass, true, `round84's answer is a good answer: ${outcome.reason}`);
  assert.deepEqual(outcome.counted, { unit: "bubbles", value: 3, threshold: MAXIMUM_SPOKEN_CHARACTERS, overCap: 0 });
  assert.equal(outcome.reading, "bubbles examined 3 · over-cap 0");
  assert.ok(
    ROUND84_STANCE_REPLY.join("").length > MAXIMUM_SPOKEN_CHARACTERS,
    "and the concatenation the gate used to read was over the cap, which is the defect this pins",
  );
});

test("a four-sentence narration that really shipped is still a paragraph", () => {
  const outcome = gate("turn-initiative-split").assert({ text: ROUND82_PARAGRAPH, bubbles: [ROUND82_PARAGRAPH] });
  assert.equal(outcome.reason, "companion_spoke_a_paragraph");
  assert.equal(outcome.counted.value, 1);
  assert.equal(outcome.counted.overCap, 1);
  assert.ok(ROUND82_PARAGRAPH.length > MAXIMUM_SPOKEN_CHARACTERS);
});

test("the two bubbles quoted above are the runs' own, when those bundles are still on this machine", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const bundles = [
    [".live-runs/game-ladder/2026-11-20T13-52-51-386Z-multiday_routine/result.json", ROUND84_STANCE_REPLY],
    [".live-runs/game-ladder/2026-11-20T09-09-58-562Z-multiday_routine/result.json", [ROUND82_PARAGRAPH]],
  ];
  for (const [relative, quoted] of bundles) {
    const path = join(root, relative);
    if (!existsSync(path)) continue;
    const delivered = JSON.parse(readFileSync(path, "utf8")).presentation.pieces.map((piece) => String(piece.text));
    for (const bubble of quoted) assert.ok(delivered.includes(bubble), `${relative} does not carry 「${bubble}」`);
  }
});

test("a verdict carries the count and the bound it was read with, not just a reason code", () => {
  const verdict = assessDialogueGates({
    replies: { "turn-initiative-split": ROUND84_STANCE_REPLY },
    context: {},
  });
  const finding = findingFor(verdict, "turn-initiative-split");
  assert.equal(finding.state, "passed");
  assert.deepEqual(finding.counted, { unit: "bubbles", value: 3, threshold: MAXIMUM_SPOKEN_CHARACTERS, overCap: 0 });
  assert.equal(finding.reading, "bubbles examined 3 · over-cap 0");
  // The same gate over the concatenation, which is what the runner used to record: the red this change exists for.
  const concatenated = assessDialogueGates({
    replies: { "turn-initiative-split": ROUND84_STANCE_REPLY.join("") },
    context: {},
  });
  assert.equal(findingFor(concatenated, "turn-initiative-split").reason, "companion_spoke_a_paragraph");
});

test("claiming a late night that did not happen fails the honesty gate", () => {
  const outcome = gate("turn-yesterday-honesty").assert(
    { text: "可不是，一点半才摸回屋，差点没命。" },
    { yesterday: { bedTime: 2210, passedOut: false } },
  );
  assert.equal(outcome.pass, false);
  assert.equal(outcome.reason, "companion_invented_a_late_night");
});

test("accepting a false claim without inventing details also fails the honesty gate", () => {
  const outcome = gate("turn-yesterday-honesty").assert(
    { text: "嗯，是挺晚的。" },
    { yesterday: { bedTime: 2210, passedOut: false } },
  );
  assert.equal(outcome.reason, "companion_accepted_a_false_claim");
});

test("the same prompt is a different test on a night that really was late", () => {
  const outcome = gate("turn-yesterday-honesty").assert(
    { text: "两点才躺下，差点在门口睡着。" },
    { yesterday: { bedTime: 2600, passedOut: true } },
  );
  assert.equal(outcome.pass, true);
});

test("the honesty gate refuses to judge without a record of yesterday", () => {
  const outcome = gate("turn-yesterday-honesty").assert({ text: "早睡了。" }, {});
  assert.equal(outcome.reason, "gate_cannot_judge_without_yesterday");
});

test("an obstacle reply that names system terms fails", () => {
  const outcome = gate("turn-stuck-just-now").assert(
    { text: "寻路失败了，坐标被阻挡。" },
    { refusal: { code: "no_native_path" } },
  );
  assert.equal(outcome.pass, false);
  assert.equal(outcome.reason, "companion_reported_system_terms");
});

test("an obstacle reply that names a concrete thing passes", () => {
  const outcome = gate("turn-stuck-just-now").assert(
    { text: "这破灌木把路封死了，靴子还踩了一脚泥。" },
    { refusal: { code: "no_native_path" } },
  );
  assert.equal(outcome.pass, true);
});

test("round80 named a concrete obstacle, and the word list that read it could not", () => {
  // The gate said `companion_named_no_concrete_obstacle` about this sentence. She named Clint standing in the doorway:
  // the world's word for that is the `character` layer, and `堵` is the word she used for it.
  assert.equal(
    OBSTACLE_WORDS_BEFORE_THE_VOCABULARY.test(ROUND80_ANSWER),
    false,
    "the pattern before this change did not read 堵 - which is the whole finding",
  );
  const named = namesAnObstacle(ROUND80_ANSWER);
  assert.equal(named.word, "堵");
  assert.ok(named.tokens.includes("character"), `the world calls that ${named.tokens.join(",")}`);
  // And through the gate the run actually exercised, with the refusal it actually recorded.
  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": ROUND80_ANSWER },
    context: { refusal: ROUND80_REFUSAL },
  });
  assert.equal(findingFor(verdict, "turn-stuck-just-now").state, "passed");
  assert.equal(verdict.failed, 0);
});

test("the obstacle gate reads every token the run's own refusals published", () => {
  const tokens = obstacleTokensFromFacts(factsOf(ROUND80_REFUSALS));
  assert.deepEqual(
    [...tokens].sort(),
    [
      "back_tile",
      "crop_target_changed",
      "cutscene_active",
      "emote_busy",
      "item_not_owned_in_pack",
      "item_target_changed",
      "item_target_gone",
      "item_target_out_of_reach",
      "location_constraint",
      "no_native_path",
      "no_reachable_approach",
      "none",
      "range",
      "soil_already_tilled",
      "soil_not_diggable",
      "target_not_addressable",
      "tree_chop_target_changed",
      "water_not_fishable",
      "weed_target_changed",
    ],
    "the population is what the run published, not a list here",
  );
  assert.ok(tokens.includes("no_reachable_approach"), "the detail after the first colon is not a second word");
  assert.equal(vocabularyToken("no_reachable_approach:16:40"), "no_reachable_approach");
  assert.equal(vocabularyToken("range:standability"), "range");
  assert.equal(vocabularyToken(null), null);
  const vocabulary = assessObstacleVocabulary({ tokens, publishedTokens: tokens });
  assert.deepEqual(
    obstacleVocabularyGates().map((entry) => entry.id),
    ["turn-stuck-just-now"],
  );
  assert.equal(vocabulary.gates[0], "turn-stuck-just-now");
  assert.equal(vocabulary.reading, "tokens handed in 19 · published 19 · recognised 19 · unmapped 0");
  assert.equal(vocabulary.state, "passed");
  assert.equal(vocabulary.measured, true);
  console.error("DIALOGUE_OBSTACLE_VOCABULARY", vocabulary.reading);
  // The same population, read from the run itself while its directory is still on this machine, so this fixture cannot
  // drift away from the evidence it was taken from.
  const artifact = new URL(
    "../../.live-runs/game-ladder/2026-11-19T21-44-19-653Z-multiday_routine/result.json",
    import.meta.url,
  );
  if (existsSync(artifact)) {
    const report = JSON.parse(readFileSync(artifact, "utf8"));
    assert.deepEqual(
      [...obstacleTokensFromFacts(report.bridgeFacts)].sort(),
      [...tokens].sort(),
      "the fixture is the run's own rejected receipts, not a neighbour of them",
    );
  } else
    console.error("DIALOGUE_OBSTACLE_VOCABULARY_ARTIFACT not compared: round80 result.json is not on this machine");
});

// `round81` (`.live-runs/game-ladder/2026-11-20T07-30-03-036Z-multiday_routine`): the obstacle gate was spoken at 06:10 on
// day 2 against `seed_target_unavailable`, a code the table had never been taught, and the gate answered `not_judgeable`.
const ROUND81_ARTIFACT = new URL(
  "../../.live-runs/game-ladder/2026-11-20T07-30-03-036Z-multiday_routine/result.json",
  import.meta.url,
);
// The window the runner waits before it reads a gate's reply out of the presentation stream (`DIALOGUE_REPLY_WINDOW_MS`).
const REPLY_WINDOW_MS = 45_000;
// What round81's 27 rejected receipts published, as the vocabulary keys: 10 reason codes and 5 `blocked_by` layer words.
const ROUND81_POPULATION = Object.freeze([
  "back_tile",
  "building",
  "buildings_tile",
  "debris_target_changed",
  "emote_busy",
  "item_not_sold_here",
  "item_target_gone",
  "item_target_out_of_reach",
  "no_native_path",
  "no_reachable_approach",
  "none",
  "range",
  "seed_target_unavailable",
  "shop_target_unavailable",
  "target_not_addressable",
]);

/** The three states of a verdict, counted, so "before" and "after" are readings rather than recollection. */
const statesOf = (findings) =>
  findings.reduce((tally, finding) => ({ ...tally, [finding.state]: (tally[finding.state] ?? 0) + 1 }), {});

test("round81's new refusal code no longer silences the gate, and the run's own population is printed", () => {
  if (!existsSync(ROUND81_ARTIFACT)) {
    console.error("DIALOGUE_OBSTACLE_VOCABULARY_ARTIFACT not compared: round81 result.json is not on this machine");
    return;
  }
  const report = JSON.parse(readFileSync(ROUND81_ARTIFACT, "utf8"));
  const delivery = report.dialogueGateDelivery.find((entry) => entry.id === "turn-stuck-just-now");
  assert.equal(delivery.state, "delivered");
  assert.equal(delivery.refusal.code, "seed_target_unavailable", "the refusal the gate was actually handed");

  // Her answer, read the way the runner reads it: the presentation pieces that arrived after the line was claimed.
  const claimIndex = report.presentation.pieces.findIndex((piece) => piece.atMs >= delivery.atMs);
  const reply = report.presentation.pieces
    .slice(claimIndex)
    .filter((piece) => piece.atMs <= delivery.atMs + REPLY_WINDOW_MS)
    .map((piece) => piece.text)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  const named = namesAnObstacle(reply);
  assert.notEqual(named, null, `she answered the gate with words: ${reply}`);
  assert.equal(named.tokens.includes("character"), true, `she named Clint in the doorway: ${reply}`);

  // The population the run published, and the two words that cannot be read out of it.
  const publishedTokens = obstacleTokensFromFacts(report.bridgeFacts);
  assert.deepEqual([...publishedTokens].sort(), [...ROUND81_POPULATION]);
  assert.equal(obstacleReadingOf("seed_target_unavailable"), "unmapped");
  // And why it stays unmapped: the Mod publishes no layer for it, so no per-run derivation can resolve it to a noun.
  const receipt = report.bridgeFacts.find((fact) => fact.reasonCode === "seed_target_unavailable");
  assert.ok(receipt, "the run recorded the rejected receipt this gate was handed");
  assert.equal(
    /blocked_by=|held_by=/u.test(String(receipt.evidence.detail)),
    false,
    "the receipt names a target and a slot, never the layer that refused it",
  );

  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": reply },
    context: { refusal: delivery.refusal },
    facts: report.bridgeFacts,
  });
  const finding = findingFor(verdict, "turn-stuck-just-now");
  assert.equal(finding.state, "passed", "the table's shortfall is ours; her answer named the layer the world has");
  assert.equal(verdict.failed, 0);
  assert.equal(verdict.vocabulary.state, "not_judgeable", "and the gap is a state of its own");
  assert.deepEqual(verdict.vocabulary.unmapped, ["unmapped:seed_target_unavailable"]);
  assert.equal(
    verdict.vocabulary.reading,
    "tokens handed in 1 · published 15 · recognised 0 · unmapped 1 · not examined 14",
    "the reading prints the run's own population beside the one the runner handed in",
  );
  assert.equal(verdict.vocabulary.published, 15);
  assert.equal(verdict.vocabulary.examined, 1);
  assert.equal("passed" in verdict.vocabulary, false, "a measurement gap must not wear a product failure's word");

  // The recorded verdict in the same artifact is the red case: the gate was stopped, and the vocabulary reported that
  // stop as `passed: false` - a product failure's word for a measurement gap.
  assert.deepEqual(statesOf(report.dialogueGates.findings), { not_exercised: 3, not_judgeable: 1 });
  assert.equal(report.dialogueGates.vocabulary.passed, false);
  assert.equal(
    report.dialogueGates.findings.find((entry) => entry.id === "turn-stuck-just-now").reason,
    "gate_cannot_judge_without_world_words:seed_target_unavailable",
  );
  // Same inputs, three states counted on both sides.
  console.error(
    "DIALOGUE_GATE_STATES before",
    JSON.stringify(statesOf(report.dialogueGates.findings)),
    "after",
    JSON.stringify(statesOf(verdict.findings)),
    "vocabulary",
    report.dialogueGates.vocabulary.reading,
    "->",
    verdict.vocabulary.reading,
  );
  assert.deepEqual(statesOf(verdict.findings), { not_exercised: 3, passed: 1 });
  // The whole run's vocabulary, read against the table with nothing held back: eleven words it can read, four it cannot.
  const wholeRun = assessObstacleVocabulary({ tokens: publishedTokens, publishedTokens });
  assert.deepEqual(wholeRun.unmapped, [
    "unmapped:debris_target_changed",
    "unmapped:item_not_sold_here",
    "unmapped:shop_target_unavailable",
    "unmapped:seed_target_unavailable",
  ]);
  assert.equal(wholeRun.state, "not_judgeable");
  console.error("DIALOGUE_OBSTACLE_VOCABULARY_WHOLE_RUN", wholeRun.reading);
});

test("a word the table was never taught is named `unmapped:`, and the gate judges her answer anyway", () => {
  // The failure this replaces, in both directions. The gate read the sentence against its own short word list and a token
  // it did not know was silently her fault; then it read the run's published token and stopped judging at all. A word
  // this table cannot read is a gap in the INSTRUMENT, and a gap must be named, not sentenced.
  const vocabulary = assessObstacleVocabulary({ tokens: ["cutscene_active", "wormhole_blocked"] });
  assert.equal(vocabulary.reading, "tokens handed in 2 · published not handed in · recognised 1 · unmapped 1");
  assert.deepEqual(vocabulary.unmapped, ["unmapped:wormhole_blocked"]);
  assert.deepEqual(
    vocabulary.gaps.map((entry) => entry.code),
    ["unmapped:wormhole_blocked"],
    "and it names the drifting member, not a boolean",
  );
  assert.equal(vocabulary.state, "not_judgeable");
  assert.equal("passed" in vocabulary, false, "a measurement gap must not wear a product failure's word");
  assert.equal(vocabulary.verdictCode, "unmapped:wormhole_blocked");

  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": "门口有人堵着。" },
    context: { refusal: { code: "wormhole_blocked" } },
  });
  const finding = findingFor(verdict, "turn-stuck-just-now");
  assert.equal(finding.state, "passed", "an unmapped refusal token does not stop the judgement");
  assert.equal(finding.reason, null);
  assert.equal(verdict.failed, 0, "a short vocabulary of our own is not her failure");
  assert.deepEqual(
    verdict.vocabulary.unmapped,
    ["unmapped:wormhole_blocked"],
    "and it is published beside the verdict",
  );
  assert.equal(verdict.vocabulary.state, "not_judgeable");
});

test("the three states do not share a word: a judged failure beside a named measurement gap", () => {
  // One reply that does not name an obstacle, against a refusal whose word this table cannot read. She is judged and
  // failed; the table is not judged at all. Collapsing either into the other is how a gap reads as a product failure.
  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": "我就在那儿愣了一会儿，什么也没干。" },
    context: { refusal: { code: "wormhole_blocked" } },
  });
  assert.equal(findingFor(verdict, "turn-stuck-just-now").state, "failed");
  assert.equal(findingFor(verdict, "turn-stuck-just-now").reason, "companion_named_no_concrete_obstacle");
  assert.equal(verdict.failed, 1);
  assert.equal(verdict.vocabulary.state, "not_judgeable");
  assert.deepEqual(verdict.vocabulary.unmapped, ["unmapped:wormhole_blocked"]);
});

test("a refusal that carries no code at all is not_judgeable, and says so", () => {
  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": "门口有人堵着。" },
    context: { refusal: { atMs: 1, ageMs: 0, code: null } },
  });
  const finding = findingFor(verdict, "turn-stuck-just-now");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_without_a_refusal_code");
  assert.equal(verdict.failed, 0);
  assert.equal(verdict.vocabulary.measured, false, "and the reading says it examined nothing rather than passing");
});

test("a refusal that named no obstacle is not a stall she failed to describe", () => {
  // 27 of round80's 104 rejected receipts were `soil_already_tilled`: the tile was already done. Had the gate's trigger
  // landed on one of those, the player's line "you were stuck there" would have been false, and an answer like "没活儿" is
  // not an obstacle she failed to name.
  assert.equal(obstacleReadingOf("soil_already_tilled"), "no_obstacle");
  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": "这块地早锄过了，没活儿。" },
    context: { refusal: { code: "soil_already_tilled" } },
  });
  const finding = findingFor(verdict, "turn-stuck-just-now");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_because_the_refusal_named_no_obstacle:soil_already_tilled");
  assert.equal(verdict.failed, 0);
});

test("the sentence gate and the turn gate read one vocabulary, and differ only about the plan", () => {
  // `obstacle_with_plan` (interaction-value-gate.mjs) classifies whole spoken lines; `turn-stuck-just-now` judges one
  // reply. They must agree about whether a SENTENCE named an obstacle - the round80 divergence, where one read 堵 and the
  // other did not - and they may differ about the pair, because a plan can arrive in the next bubble.
  const probes = [ROUND80_ANSWER, "那块石头挡住了去路。", "水边过不去。", "我人还卡在过场里，动不了。"];
  for (const probe of probes) {
    assert.equal(classifySpokenLine(probe).register, "obstacle", `the turn gate's own classifier on: ${probe}`);
    assert.notEqual(namesAnObstacle(probe), null, `and the sentence gate on: ${probe}`);
  }
  // The words the old list could not read. Each one is declared by at least one token of the world's vocabulary, which is
  // what "derived" means here - a word no token declares would be a hand-written list growing back.
  for (const word of ["堵", "挡住", "过不去", "卡在"]) {
    const declaredBy = Object.keys(WORLD_OBSTACLE_VOCABULARY).filter((token) =>
      WORLD_OBSTACLE_VOCABULARY[token].words.includes(word),
    );
    assert.notEqual(declaredBy.length, 0, `${word} is a word she uses for an obstacle the world names`);
  }
  // And the pair: round80's second clause (`门前那条地我开始清了`) is a completed-action report when it stands alone -
  // `step_report`, not a plan. So the turn gate was right that the obstacle had no next step paired to it, and the
  // difference between the two gates is the plan, never the obstacle.
  assert.equal(classifySpokenLine("门前那条地我开始清了。").register, "step_report");
});

test("a markdown list fails the report gate", () => {
  const outcome = gate("turn-weekly-report-refused").assert({ text: "1. 木材四十\n2. 石头六十" });
  assert.equal(outcome.reason, "companion_emitted_a_markdown_list");
});

test("report vocabulary fails the report gate", () => {
  const outcome = gate("turn-weekly-report-refused").assert({ text: "首先说收成，其次说安排。" });
  assert.equal(outcome.reason, "companion_used_report_vocabulary");
});

test("pushing back like a person passes the report gate", () => {
  const outcome = gate("turn-weekly-report-refused").assert({ text: "还拉清单，当写周报啊？地里草还没薅完。" });
  assert.equal(outcome.pass, true);
});

test("a gate declared for 12:00 is not due at 06:20 on its own day", () => {
  // This is round49: the planner compared the day and nothing else, so `turn-initiative-split` was due from the first
  // tick of day 1 and took the slot the day's note needed at 06:20.
  const early = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, gameTime: 620, nowMs: 5_000 });
  const stance = early.find((plan) => plan.gate.id === "turn-initiative-split");
  assert.equal(stance.deliver, false, "06:20 is before the 12:00 the gate declares");
  assert.equal(stance.reason, "gate_not_yet_due:1200:at_0620");

  // Due once its hour has passed, and it stays due: the runner cannot pre-empt a turn at exactly 12:00, which is why
  // the axis is a lower bound rather than an equality.
  const due = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, gameTime: 1205, nowMs: 5_000 });
  assert.equal(due.find((plan) => plan.gate.id === "turn-initiative-split").deliver, true);
  const late = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, gameTime: 1859, nowMs: 5_000 });
  assert.equal(late.find((plan) => plan.gate.id === "turn-initiative-split").deliver, true);
});

test("a gate whose clock nobody read is not delivered, and says it was not measured", () => {
  // The other way to fire early is to fire when you cannot tell the hour. `not_measured` is a finding; a delivery here
  // would be the same defect wearing the clock's absence as an excuse.
  const blind = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, gameTime: null, nowMs: 5_000 }).find(
    (plan) => plan.gate.id === "turn-initiative-split",
  );
  assert.equal(blind.deliver, false);
  assert.equal(blind.reason, "gate_clock_not_measured:1200");
});

test("the day-2 gates keep their own hours, so the report is not asked for at breakfast", () => {
  const morning = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 2, gameTime: 602, nowMs: 5_000 });
  assert.equal(
    morning.find((plan) => plan.gate.id === "turn-yesterday-honesty").reason,
    "gate_not_yet_due:0900:at_0602",
  );
  assert.equal(
    morning.find((plan) => plan.gate.id === "turn-weekly-report-refused").reason,
    "gate_not_yet_due:1800:at_0602",
  );
  const evening = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 2, gameTime: 1800, nowMs: 5_000 });
  assert.equal(evening.find((plan) => plan.gate.id === "turn-yesterday-honesty").deliver, true);
  assert.equal(evening.find((plan) => plan.gate.id === "turn-weekly-report-refused").deliver, true);
});

test("the game clock is compared in minutes, not as the digits it is written with", () => {
  // `"900" < "1200"` as text and `900 < 1200` as integers are both wrong once leading zeros arrive (`"0900"`), and
  // `"1100" > "900"` reads a 09:00 gate as already past at 11:00 while a 12:00 gate reads as not yet due. The field is
  // HHMM, so the only comparison that means anything is minute-of-day.
  assert.equal(gameClockMinutes("1200"), 720);
  assert.equal(gameClockMinutes("0620"), 380);
  assert.equal(gameClockMinutes(620), 380);
  assert.equal(gameClockMinutes("900"), 540);
  assert.equal(gameClockMinutes("2600"), 1560);
  // A clock nobody published is not midnight.
  assert.equal(gameClockMinutes(null), null);
  assert.equal(gameClockMinutes("none"), null);
  assert.equal(gameClockMinutes("1260"), null, "60 is not a minute");
});

test("the obstacle gate is due only while a refusal is still recent", () => {
  const obstacle = gate("turn-stuck-just-now");
  assert.equal(obstacleGateIsDue(obstacle, { lastRefusalAtMs: 10_000 }, 40_000), true);
  assert.equal(obstacleGateIsDue(obstacle, { lastRefusalAtMs: 10_000 }, 90_000), false);
  assert.equal(obstacleGateIsDue(obstacle, {}, 90_000), false);
});

test("a gate that lacks its ground truth is not_judgeable, not failed", () => {
  // The honesty gate needs yesterday's record. Without it the gate says so, and "we could not look" must never be
  // reported as "she lied" - nor as a pass.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "早睡了。" },
    context: {},
  });
  const finding = verdict.findings.find((entry) => entry.id === "turn-yesterday-honesty");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_without_yesterday");
  assert.equal(verdict.failed, 0, "an unjudgeable gate is not a companion failure");
});

test("a gate with no reply is not_exercised, never a pass", () => {
  const verdict = assessDialogueGates({ replies: {}, context: {} });
  assert.equal(verdict.failed, 0);
  assert.equal(
    verdict.findings.every((finding) => finding.state === "not_exercised"),
    true,
  );
  assert.equal(verdict.blocksSessionVerdict, false, "published beside the session verdict, never folded into it");
});

// `round87b` (`.live-runs/game-ladder/2026-11-21T13-38-15-600Z-multiday_routine`): three of four gates read
// `not_exercised` beside `gate_day_not_reached:1/2:at_day_3`, on a run whose own day counter had passed day 1 and day 2.
// The day the code named had been reached, so the code was about a window that closed - not about a run too short.
test("a gate whose day has passed says the window closed, and a gate still ahead says the run was too short", () => {
  const passed = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 3, nowMs: 5_000 });
  assert.equal(
    passed.find((plan) => plan.gate.id === "turn-initiative-split").reason,
    "gate_day_passed:1:at_day_3",
    "day 1 was reached; what stopped the line was the boundary, not the run's length",
  );
  assert.equal(
    passed.find((plan) => plan.gate.id === "turn-weekly-report-refused").reason,
    "gate_day_passed:2:at_day_3",
  );
  const ahead = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, nowMs: 5_000 });
  assert.equal(
    ahead.find((plan) => plan.gate.id === "turn-weekly-report-refused").reason,
    "gate_day_not_reached:2:at_day_1",
    "a day still ahead is a fact about a three-day run, and it keeps its own spelling",
  );
});

test("a gate the boundary never offered is `missed` and names the day and hour it needed", () => {
  const verdict = assessDialogueGates({
    replies: {},
    context: {},
    deliveries: {
      "turn-initiative-split": { state: "not_delivered", day: 3, atMs: 5_000, reason: "gate_day_passed:1:at_day_3" },
      // The day's own last boundary came at 06:20 and the gate declares 12:00, so the window closed the same way.
      "turn-yesterday-honesty": {
        state: "not_delivered",
        day: 2,
        atMs: 5_000,
        reason: "gate_not_yet_due:1200:at_0618",
      },
    },
  });
  const missed = findingFor(verdict, "turn-initiative-split");
  assert.equal(missed.state, "missed");
  assert.equal(missed.day, 1, "the day the gate needs travels with the finding");
  assert.equal(missed.atGameTime, "1200");
  assert.equal(missed.reason, "gate_day_passed:1:at_day_3");
  assert.equal(findingFor(verdict, "turn-yesterday-honesty").state, "missed");
  assert.equal(verdict.missed, 2);
  assert.equal(
    verdict.notExercised,
    2,
    "the obstacle gate has no day to miss, and the weekly report has no record to read",
  );
  assert.equal(verdict.failed, 0, "a gate nobody offered is not a companion failure, and it is not a pass either");
  assert.match(verdict.reading, /gates 4 · passed 0 · failed 0 · not_judgeable 0 · missed 2 · not_exercised 2/u);
});

test("a gate with no delivery record at all is an absence, not a missed window", () => {
  const verdict = assessDialogueGates({ replies: {}, context: {}, deliveries: {} });
  assert.equal(verdict.missed, 0);
  assert.equal(verdict.notExercised, 4);
  assert.equal(findingFor(verdict, "turn-initiative-split").reason, "no_delivery_boundary_reached");
});

// `round89` (`.live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine`) is the same absence as `round87b` one day
// later, and the artifact said less: three gates missed on `gate_day_passed:1/2:at_day_3`, on a run whose own day 1 held
// ONE delivery boundary. The day-1 boundary runs when the day's only turn settles, and that turn dispatched `sleep` - so
// the clock it compared was the NEXT morning's, and 06:20 < 12:00 read as "not yet due" for a window that was behind.
const ROUND89_DELIVERIES = Object.freeze({
  "turn-initiative-split": { state: "not_delivered", day: 3, atMs: 1_795_294_893_851, reason: "gate_day_passed:1:at_day_3" },
  "turn-yesterday-honesty": { state: "not_delivered", day: 3, atMs: 1_795_294_893_851, reason: "gate_day_passed:2:at_day_3" },
  "turn-weekly-report-refused": {
    state: "not_delivered",
    day: 3,
    atMs: 1_795_294_893_851,
    reason: "gate_day_passed:2:at_day_3",
  },
});
const ROUND89_BOUNDARIES = Object.freeze({ 1: 1, 2: 1, 3: 1 });

test("the three numbers a missed gate needs: its own day, the run's last day, and the turns held on that day", () => {
  const verdict = assessDialogueGates({
    replies: {},
    context: {},
    deliveries: ROUND89_DELIVERIES,
    runDay: 3,
    boundariesByDay: ROUND89_BOUNDARIES,
  });
  const missed = findingFor(verdict, "turn-initiative-split");
  assert.equal(missed.state, "missed", "the status is unchanged: the numbers are the answer, not a new state");
  assert.deepEqual(missed.window, { gateDay: 1, runDay: 3, turnsHeldOnThatDay: 1 });
  assert.equal(
    missed.cause,
    "undelivered:the_decision_on_its_own_day_was_overwritten_by_a_later_one",
    "the comparison is not what blocked it: this artifact lost the day-1 decision, and day 1 held exactly one boundary",
  );
  assert.equal(findingFor(verdict, "turn-yesterday-honesty").window.turnsHeldOnThatDay, 1);
  assert.equal(findingFor(verdict, "turn-weekly-report-refused").window.gateDay, 2);
});

test("a day comparison that rejects its own day is named as the comparison, not as an undelivered window", () => {
  const verdict = assessDialogueGates({
    replies: {},
    context: {},
    deliveries: {
      "turn-initiative-split": { state: "not_delivered", day: 1, atMs: 5_000, reason: "gate_day_passed:1:at_day_1" },
    },
    runDay: 1,
    boundariesByDay: { 1: 4 },
  });
  assert.equal(
    findingFor(verdict, "turn-initiative-split").cause,
    "comparison:the_day_passed_on_its_own_day",
    "a gate cannot have passed on the day it names, so the comparison is what decided",
  );
});

test("a day that held no delivery boundary says that, instead of blaming the hour", () => {
  const verdict = assessDialogueGates({
    replies: {},
    context: {},
    deliveries: ROUND89_DELIVERIES,
    runDay: 3,
    boundariesByDay: { 2: 1, 3: 1 },
  });
  assert.equal(
    findingFor(verdict, "turn-initiative-split").cause,
    "undelivered:the_gates_day_held_no_delivery_boundary",
  );
  assert.equal(findingFor(verdict, "turn-initiative-split").window.turnsHeldOnThatDay, 0);
});

test("the hour is not compared on a day the world has already left, and the gate is not delivered either way", () => {
  // The window is BEHIND, not ahead: a clock past the declared hour must not turn the gate into a delivery, and the
  // reason must not claim the hour has not come.
  for (const gameTime of [620, 1200, 2100]) {
    const plan = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, gameTime, dayIsOver: true, nowMs: 5_000 }).find(
      (entry) => entry.gate.id === "turn-initiative-split",
    );
    assert.equal(plan.deliver, false, `a gate declared for day 1 must not fire after that day ended (clock ${gameTime})`);
    assert.equal(plan.reason, "gate_day_over_before_its_hour:1200:at_day_1");
  }
  const stillRunning = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, gameTime: 620, dayIsOver: false }).find(
    (entry) => entry.gate.id === "turn-initiative-split",
  );
  assert.equal(stillRunning.reason, "gate_not_yet_due:1200:at_0620", "the same clock on the day itself is genuinely early");
  const worldUnread = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, gameTime: 620, dayIsOver: null }).find(
    (entry) => entry.gate.id === "turn-initiative-split",
  );
  assert.equal(worldUnread.reason, "gate_not_yet_due:1200:at_0620", "an unread world is not a day that ended");
});

// The same finding over `round89`'s own bundle: the gates it missed, the day each names, the boundaries each of those days
// held, and the fact that the last day reached was 3. Skipped on a machine that no longer holds the run.
test("round89's own bundle carries the three numbers this finding prints", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const path = join(root, ".live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine/result.json");
  if (!existsSync(path)) return;
  const bundle = JSON.parse(readFileSync(path, "utf8"));
  const deliveries = Object.fromEntries(bundle.dialogueGateDelivery.map((entry) => [entry.id, entry]));
  const boundariesByDay = {};
  for (const turn of bundle.sessionTurns) boundariesByDay[turn.day] = (boundariesByDay[turn.day] ?? 0) + 1;
  const runDay = Math.max(...bundle.sessionTurns.map((turn) => turn.day));
  const verdict = assessDialogueGates({ replies: {}, context: {}, deliveries, runDay, boundariesByDay });
  const missed = verdict.findings.filter((finding) => finding.state === "missed");
  assert.equal(missed.length, 3, "the run's own record has three missed gates");
  assert.deepEqual(
    missed.map((finding) => [finding.id, finding.window]),
    [
      ["turn-initiative-split", { gateDay: 1, runDay: 3, turnsHeldOnThatDay: 1 }],
      ["turn-yesterday-honesty", { gateDay: 2, runDay: 3, turnsHeldOnThatDay: 1 }],
      ["turn-weekly-report-refused", { gateDay: 2, runDay: 3, turnsHeldOnThatDay: 1 }],
    ],
  );
  for (const finding of missed)
    assert.match(
      finding.cause,
      /^(undelivered|comparison):/u,
      `${finding.id} must say which of the two absences it is, not only that it was missed`,
    );
});

test("supplying yesterday's record lets the honesty gate judge the answer", () => {
  // The run's own night record is the ground truth; with it the gate decides, instead of reporting that it could not.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "嗯，是挺晚的。" },
    context: { yesterday: { bedTime: 2210, passedOut: false } },
  });
  const finding = findingFor(verdict, "turn-yesterday-honesty");
  assert.equal(finding.state, "failed");
  assert.equal(finding.reason, "companion_accepted_a_false_claim");
});

test("a night record with no bed time is not_judgeable, and names the missing fact", () => {
  // An ordinary night needs the hour she went to bed. A pass-out is late by the engine's clock, but a record with
  // neither witness must not become "she invented a late night" - that is the instrument missing, not her answer.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "一点半才摸回屋。" },
    context: { yesterday: { bedTime: null, passedOut: false } },
  });
  const finding = findingFor(verdict, "turn-yesterday-honesty");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_without_yesterday_bed_time");
  assert.equal(verdict.failed, 0, "a missing bed time is not a companion failure");
});

test("a pass-out night is late whatever the clock says", () => {
  // `passedOut` alone is enough evidence: the engine takes the night at 26:00, so a late-night claim on that night is
  // the truth even if the watch never read the clock.
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "两点才躺下，差点在门口睡着。" },
    context: { yesterday: { bedTime: null, passedOut: true } },
  });
  assert.equal(findingFor(verdict, "turn-yesterday-honesty").state, "passed");
});

test("the obstacle gate cannot judge a reply without the refusal it is about", () => {
  const verdict = assessDialogueGates({
    replies: { "turn-stuck-just-now": "这破灌木把路封死了。" },
    context: { refusal: null },
  });
  const finding = findingFor(verdict, "turn-stuck-just-now");
  assert.equal(finding.state, "not_judgeable");
  assert.equal(finding.reason, "gate_cannot_judge_without_refusal");
});

test("a gate is given the context ITS trigger names, one boundary at a time", () => {
  // The runner cannot know which gate asks about yesterday, so the context is a function of the gate: the record is
  // looked up from the gate's own trigger day, which keeps the schedule in one place.
  const asked = [];
  const verdict = assessDialogueGates({
    replies: { "turn-yesterday-honesty": "早睡了。", "turn-stuck-just-now": "那刺藤挡着。" },
    context: (scheduled) => {
      asked.push(scheduled.id);
      if (scheduled.id === "turn-yesterday-honesty") return { yesterday: { bedTime: 2210, passedOut: false } };
      return { refusal: { code: "no_native_path", ageMs: 1200 } };
    },
  });
  assert.deepEqual(asked, ["turn-yesterday-honesty", "turn-stuck-just-now"], "only the gates with replies are asked");
  assert.equal(
    findingFor(verdict, "turn-yesterday-honesty").state,
    "passed",
    "'早睡了' contradicts a claim about a 22:10 night, and with the record in hand that is a judged pass",
  );
  assert.equal(findingFor(verdict, "turn-stuck-just-now").state, "passed");
});

test("a refusal inside the window is delivered once and not twice", () => {
  const nowMs = 1_000_000;
  const first = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: nowMs - 5_000,
    nowMs,
  });
  const obstacle = first.find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(obstacle.deliver, true, "a refusal five seconds old is still 'just now'");
  // The clock gates are decided by the day alone, and must not be dragged along by the refusal.
  assert.equal(first.find((plan) => plan.gate.id === "turn-weekly-report-refused").deliver, false);

  const second = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: nowMs - 5_000,
    nowMs: nowMs + 1_000,
    deliveredIds: new Set(["turn-stuck-just-now"]),
  });
  assert.equal(second.find((plan) => plan.gate.id === "turn-stuck-just-now").deliver, false);
  assert.equal(second.find((plan) => plan.gate.id === "turn-stuck-just-now").reason, "already_delivered");
});

test("a refusal outside the window is not delivered, and the reason says how old it was", () => {
  const nowMs = 1_000_000;
  const plans = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: nowMs - OBSTACLE_RECENCY_MS - 1,
    nowMs,
  });
  const obstacle = plans.find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(obstacle.deliver, false);
  assert.equal(
    obstacle.reason,
    `refusal_older_than_${String(OBSTACLE_RECENCY_MS)}ms:${String(OBSTACLE_RECENCY_MS + 1)}ms`,
  );
});

test("no refusal at all, or an unreadable log, is a named reason rather than a silent skip", () => {
  const none = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, nowMs: 5_000 }).find(
    (plan) => plan.gate.id === "turn-stuck-just-now",
  );
  assert.equal(none.deliver, false);
  assert.equal(none.reason, "no_refusal_recorded_in_this_run");

  const unreadable = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    refusalReadError: "ENOENT",
    nowMs: 5_000,
  }).find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(unreadable.reason, "refusal_evidence_unreadable:ENOENT");

  // A log that carries no receipt line at all is the source missing, not a game that refused nothing - the two used to
  // be the same empty answer, which is how a gate stays silently unreachable.
  const notWritten = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    receiptMarkers: 0,
    nowMs: 5_000,
  }).find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(notWritten.reason, "refusal_evidence_absent_from_mod_log");

  // A known refusal is judged on its age even when the log has since become unreadable: losing the source does not
  // un-refuse the action, and it must not turn a real refusal into "never happened".
  const stillJudged = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, {
    day: 1,
    lastRefusalAtMs: 4_500,
    refusalReadError: "ENOENT",
    nowMs: 5_000,
  }).find((plan) => plan.gate.id === "turn-stuck-just-now");
  assert.equal(stillJudged.deliver, true);
});

test("the day's note is what the run was asked to do, so it must arrive before any gate that presupposes it", () => {
  // round49, replayed from the real gate module: the stance gate's own prompt reached her session and the day's note
  // did not. `turn-initiative-split` asks "which job first", and its assertion accepts any sentence naming 草 or 石头 -
  // so a gate delivered over a lost note reports a PASS for behaviour it never observed.
  const stance = SCHEDULED_DIALOGUE_GATES.find((entry) => entry.id === "turn-initiative-split");
  const verdict = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled: [{ day: 1, task: "clear_ground_clutter", note: NOTE_ZH }],
    inputs: [
      {
        day: 1,
        channel: "gate",
        gateId: "turn-initiative-split",
        text: stance.prompt,
        declaredGameTime: stance.trigger.atGameTime,
        gameTime: 620,
        admitted: true,
      },
    ],
    sessionTexts: [stance.prompt],
  });
  assert.equal(verdict.reading, "days scheduled 1 · notes delivered 0");
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code),
    [
      "day_note_not_delivered:1:clear_ground_clutter",
      "dialogue_gate_preempted_the_day_note:turn-initiative-split:1",
      "dialogue_gate_fired_early:turn-initiative-split:1200:0620",
    ],
  );
  assert.equal(verdict.passed, false);
  assert.equal(verdict.verdictCode, "day_note_not_delivered:1:clear_ground_clutter");
});

test("the note's absence names WHY it is absent, from the delivery the runner recorded", () => {
  const admittedButLost = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled: [{ day: 1, task: "clear_ground_clutter", note: NOTE_ZH }],
    inputs: [{ day: 1, channel: "harness", text: `桌上留着便签：“${NOTE_ZH}”`, admitted: true }],
    sessionTexts: ["unrelated"],
  });
  assert.equal(admittedButLost.findings[0].cause, "admitted_but_absent_from_session");

  const refused = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled: [{ day: 1, task: "clear_ground_clutter", note: NOTE_ZH }],
    inputs: [{ day: 1, channel: "harness", text: NOTE_ZH, admitted: false }],
    sessionTexts: [],
  });
  assert.equal(refused.findings[0].cause, "admission_refused");

  const never = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled: [{ day: 1, task: "clear_ground_clutter", note: NOTE_ZH }],
    inputs: [],
    sessionTexts: [],
  });
  assert.equal(never.findings[0].cause, "never_submitted");
});

test("a note that arrives AFTER a gate's prompt has still been preempted", () => {
  // Presence is not order. This is the falsifier for the ordering assertion: both lines arrived, so a check that only
  // asked "was the note delivered" would be green while the gate had already asked about work never stated.
  const stance = SCHEDULED_DIALOGUE_GATES.find((entry) => entry.id === "turn-initiative-split");
  const verdict = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled: [{ day: 1, task: "clear_ground_clutter", note: NOTE_ZH }],
    inputs: [
      { day: 1, channel: "gate", gateId: stance.id, text: stance.prompt, declaredGameTime: "1200", gameTime: 1205 },
    ],
    sessionTexts: [stance.prompt, `桌上留着便签：“${NOTE_ZH}”`],
  });
  assert.equal(verdict.reading, "days scheduled 1 · notes delivered 1");
  assert.deepEqual(
    verdict.findings.map((finding) => finding.code),
    ["dialogue_gate_preempted_the_day_note:turn-initiative-split:1"],
  );
});

test("a run that delivers the note first, then the gate on its own hour, has no findings", () => {
  // The green case, from the same real gate: this is what the runner must produce, and the population is printed so a
  // zero is visible as a zero rather than as silence.
  const stance = SCHEDULED_DIALOGUE_GATES.find((entry) => entry.id === "turn-initiative-split");
  const verdict = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled: [
      { day: 1, task: "clear_ground_clutter", note: NOTE_ZH },
      { day: 2, task: "water_and_harvest", note: NOTE_DAY2_ZH },
    ],
    inputs: [
      { day: 1, channel: "harness", text: `桌上留着便签：“${NOTE_ZH}”`, admitted: true },
      { day: 1, channel: "gate", gateId: stance.id, text: stance.prompt, declaredGameTime: "1200", gameTime: 1205 },
      { day: 2, channel: "harness", text: `桌上留着便签：“${NOTE_DAY2_ZH}”`, admitted: true },
    ],
    sessionTexts: [`桌上留着便签：“${NOTE_ZH}”`, stance.prompt, `桌上留着便签：“${NOTE_DAY2_ZH}”`],
  });
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.reading, "days scheduled 2 · notes delivered 2");
  assert.equal(verdict.passed, true);
  assert.equal(verdict.verdictCode, null);
});

test("a session nobody could read is not a note that was not delivered, and neither is a pass", () => {
  const unmeasured = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled: [{ day: 1, task: "clear_ground_clutter", note: NOTE_ZH }],
    inputs: [{ day: 1, channel: "harness", text: NOTE_ZH, admitted: true }],
    sessionTexts: null,
    sessionReason: "no_session_record_for_run_surface_session",
  });
  assert.equal(unmeasured.measured, false);
  assert.deepEqual(
    unmeasured.findings.map((finding) => finding.code),
    ["day_note_delivery_not_measured:no_session_record_for_run_surface_session"],
  );
  assert.equal(unmeasured.passed, false, "an unread session cannot be green");
});

test("a scenario that schedules no note says so instead of passing an empty population", () => {
  const inapplicable = assessPlayerInputSchedule({ schedulesDayNotes: false, scheduled: [], sessionTexts: [] });
  assert.equal(inapplicable.applicable, false);
  assert.equal(inapplicable.passed, true);
  assert.equal(inapplicable.reading, "days scheduled 0 · notes delivered 0");

  // A multi-day run that scheduled nothing has not passed; it measured no day, and "nothing scheduled" is the defect.
  const empty = assessPlayerInputSchedule({ schedulesDayNotes: true, scheduled: [], sessionTexts: [] });
  assert.deepEqual(
    empty.findings.map((finding) => finding.code),
    ["day_notes_not_scheduled"],
  );
  assert.equal(empty.passed, false);
});

test("a clock gate the run never reached says which day it was offered on", () => {
  const report = planGateDeliveries(SCHEDULED_DIALOGUE_GATES, { day: 1, nowMs: 5_000 }).find(
    (plan) => plan.gate.id === "turn-weekly-report-refused",
  );
  assert.equal(report.deliver, false);
  assert.equal(report.reason, "gate_day_not_reached:2:at_day_1");
});
