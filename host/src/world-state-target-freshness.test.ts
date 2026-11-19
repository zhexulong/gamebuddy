/**
 * THE GATE FOR "A STATE LINE THAT GOES STALE WITHOUT SAYING SO", on the target rows.
 *
 * <p>
 * MEASURED `round78` (2026-11-19, her own session). Four `break_rock` steps of `plan_108` broke six stones at revisions
 * 112-123, and the delivery that arrived after them - the turn that opened `plan_124` - printed:
 * </p>
 * <pre>
 *   石头 (6,5) (5,5) (5,6) (11,7) (11,8) (4,9) 其余 2 格未列出
 * </pre>
 * <p>
 * directly under its own `<world-facts>` and `<execution-result>` naming the stones at those very tiles as
 * `rock_source_broken`. The reading was `revision 108`; the world was at 123, and the line printed no age and no proof -
 * the block's header even said `刚刚更新`. Her next plan wrote `snapshot.rockSourceTargets.slice(0, 4)` - the first four
 * rows of that same stale array - and the Mod answered `rock_source_gone` four times: four empty nodes and a wasted
 * round. The count beside it in the same block already carried the fix (`30 份 石头（刚做完那一步之后数的）`).
 * </p>
 *
 * <p>
 * THE PROPERTY. Every line that prints target rows is one of:
 *   - RE-DERIVED from this delivery's own proof - the rows a receipt took out of the world are not printed, and the line
 *     names the action and how many it removed; or
 *   - AGE-STAMPED, so the rows and how old they are cannot be read apart.
 * A row line in neither state is the defect this file exists for.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { WorldFact } from "./event-pump.js";
import { composeFactBrief, composeWorldState, provedGoneTargets, type WorldStateReading } from "./fact-brief.js";
import type { Snapshot } from "./protocol.js";

/** One row of `round78`'s revision-108 mine: the tile and the opaque id the plan copies as `expectedTargetId`. */
type RockRow = Readonly<{ x: number; y: number; targetId: string }>;

/**
 * The eight stones the Mod published at `revision 108`, in the wire order it published them.
 *
 * THE ORDER IS THE EVIDENCE, not decoration: `plan_108` took `slice(0, 6)` and `plan_124` took `slice(0, 4)` of this very
 * array, and the four ids `plan_124` resubmitted are exactly rows 0-3 here - so the second plan did not remember anything,
 * it re-read the same stale list.
 */
const ROCKS_108: readonly RockRow[] = Object.freeze([
  { x: 6, y: 5, targetId: "rock_source_d94198ebf7480082" },
  { x: 5, y: 5, targetId: "rock_source_1a02bc31c1bdac55" },
  { x: 5, y: 6, targetId: "rock_source_146074670f2225fa" },
  { x: 11, y: 7, targetId: "rock_source_237f1a667e9906c8" },
  { x: 11, y: 8, targetId: "rock_source_d505cb811851c86d" },
  { x: 4, y: 9, targetId: "rock_source_93ebe0381c4b3733" },
  { x: 12, y: 9, targetId: "rock_source_b46a7d90cad2f074" },
  { x: 3, y: 6, targetId: "rock_source_9221edced263b784" },
]);

/** The six `plan_108` broke, in the order it broke them: `slice(0, 6)` of the array above, re-ordered by path order. */
const BROKEN_BY_PLAN_108: readonly RockRow[] = Object.freeze([
  ROCKS_108[0]!,
  ROCKS_108[1]!,
  ROCKS_108[2]!,
  ROCKS_108[5]!,
  ROCKS_108[4]!,
  ROCKS_108[3]!,
]);

/** The mine at revision 108, standing at (8,5) - the observation the whole window was planned from. */
const MINE_108: Snapshot = {
  revision: 108,
  location: "UndergroundMine1",
  tile: { x: 8, y: 5 },
  stamina: 254,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 1840,
  dayOfMonth: 5,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  currentTool: "(T)Pickaxe",
  currentToolSlot: 3,
  toolSlots: [{ slot: 3, label: "(T)Pickaxe", category: "pickaxe", upgradeLevel: 0 }],
  inventoryItemFacts: [],
  rockSourceTargets: ROCKS_108.map((row) => ({ ...row, health: 1 })),
} as unknown as Snapshot;

/**
 * The Mod's own `break_rock` detail (`farmhandexecutioncontroller.resourcetoolactions.cs:305-314`), copied from the
 * round78 delivery with the pairs this line reads.
 */
const rockBroken = (row: RockRow, qualifiedItemId: string): string =>
  `target=${row.targetId};tool=pickaxe;tool_selected=pickaxe;slot=3;tool_before=pickaxe;slot_before=3;` +
  `qualified_item_id=${qualifiedItemId};durability_before=1;durability_after=removed;removed=true;` +
  `stamina_before=254;stamina_after=252;stamina_delta=-2;expected_stamina_cost=2;tool_restored=pickaxe;` +
  "chore=rockSourceTargets";

/** The Mod's own answer for a stone the world no longer holds (`RockSourceAlreadySettled`, the same file). */
const rockGone = (row: RockRow): string =>
  `target=${row.targetId};named_tile=${String(row.x)},${String(row.y)};tile=none;chore=rockSourceTargets`;

/** One bare `execution_receipt`, the shape `receiptLine` prints and `provedGoneTargets` reads. */
function receiptFact(detail: string, reasonCode: string, actionId = "break_rock"): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `receipt_${detail}`,
    correlationId: `receipt_${detail}`,
    executionId: `exec_${detail}`,
    revision: 123,
    payload: { actionId, state: "succeeded", reasonCode, evidence: { detail } },
    gameTime: "1840",
  }) as unknown as WorldFact;
}

/** The six receipts the round78 window delivered together, in the Mod's own order. */
const PLAN_108_RECEIPTS: readonly WorldFact[] = Object.freeze(
  BROKEN_BY_PLAN_108.map((row) => receiptFact(rockBroken(row, "(O)32"), "rock_source_broken")),
);

const readingOf = (ageTurns = 0): WorldStateReading => ({
  snapshot: MINE_108,
  revision: 108,
  ageTurns,
  ageMs: 0,
  contentAgeMs: 0,
});

const briefWith = (events: readonly WorldFact[], ageTurns = 0): string =>
  composeFactBrief({ inputs: [], snapshot: readingOf(ageTurns), events, locale: "zh-CN" });

/** The `<world-state>` lines as the block emits them, so an assertion about one line cannot be satisfied by a receipt. */
function worldStateLines(text: string): readonly string[] {
  const open = text.indexOf("<world-state>");
  const close = text.indexOf("</world-state>");
  if (open < 0 || close < 0) return [];
  return text
    .slice(open, close)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The rock family's own line - `石头 (…` or `石头 全部 …`, never the pack's `30 份 石头 (O)390`. */
function rockLine(text: string): string {
  return worldStateLines(text).find((line) => /^石头/u.test(line)) ?? "";
}

test("target_contradiction: a delivery that proves six stones gone does not also print them", () => {
  // THE FALSIFIER, and it is round78's own delivery: the reading still lists eight stones and the receipts took six out.
  const line = rockLine(briefWith(PLAN_108_RECEIPTS));
  assert.notEqual(line, "", "the rock line is composed at all");
  for (const row of BROKEN_BY_PLAN_108)
    assert.doesNotMatch(
      line,
      new RegExp(`\\(${String(row.x)},${String(row.y)}\\)`, "u"),
      `the receipt broke the stone at (${String(row.x)},${String(row.y)}) and the line still points at it: ${line}`,
    );
});

test("target_the_four_plan_124_resubmitted_are_the_four_the_line_no_longer_offers", () => {
  // The four ids the next plan submitted again, by the tiles they stood on. This is the wasted round, exactly.
  const line = rockLine(briefWith(PLAN_108_RECEIPTS));
  for (const tile of ["(6,5)", "(5,5)", "(5,6)", "(11,7)"])
    assert.equal(line.includes(tile), false, `plan_124 resubmitted ${tile}; the line must not offer it: ${line}`);
  assert.match(line, /\(12,9\)/u, `the stone still standing is named: ${line}`);
  assert.match(line, /\(3,6\)/u, `and so is the other one: ${line}`);
});

test("target_proof_is_named: the line says a step took the rows out, and how many", () => {
  const line = rockLine(briefWith(PLAN_108_RECEIPTS));
  // THE CLAIM IS A SENTENCE, AND THE ACTION ID IS NOT IN IT. `（break_rock 之后数的，少了 6 格）` put a handle inside a
  // Chinese sentence and a run answered with handles; the receipt that broke the six stones is printed in the same
  // delivery by `receiptLine`, with its own action id, so nothing is lost by not saying it twice.
  assert.match(line, /（刚做完那一步之后数的/u, `a row list that replaced the reading's own says it was re-counted: ${line}`);
  assert.doesNotMatch(line, /break_rock/u, `and names no action id: ${line}`);
  assert.match(line, /少了 6 格/u, `and how many rows left, so the subtraction is a fact: ${line}`);
  assert.doesNotMatch(line, /其余/u, `the six are not counted as the cap's omission: ${line}`);
});

test("target_age_is_stated: rows with no proof carry the age of the reading they came from", () => {
  // THE OTHER HORN. Nothing corrected this list, so the rows must not be readable as the present tense.
  const line = rockLine(briefWith([], 3));
  assert.match(line, /3 轮前数的/u, `a three-turn-old row list states its age on its own line: ${line}`);
});

test("target_fresh_reading_is_not_stamped: rows read this turn say nothing extra", () => {
  const line = rockLine(briefWith([], 0));
  assert.match(line, /\(6,5\)/u);
  assert.doesNotMatch(line, /轮前|之后数的/u, `a row list read this turn needs no qualifier: ${line}`);
});

test("target_proof_of_another_row_does_not_touch_this_line", () => {
  // Boundary: a stone that was only DAMAGED is still standing. `removed=false` is not a proof of removal, and the row
  // must stay on the line.
  const damaged = receiptFact(
    rockBroken(ROCKS_108[0]!, "(O)32").replace("removed=true", "removed=false"),
    "rock_source_damaged",
  );
  const line = rockLine(briefWith([damaged]));
  assert.match(line, /\(6,5\)/u, `a damaged stone is still there, so it is still named: ${line}`);
  assert.doesNotMatch(line, /之后数的/u, `and nothing was subtracted: ${line}`);
});

test("target_gone_is_the_other_spelling: the Mod's `_gone` answer proves the row out of the world", () => {
  // `rock_source_gone` settles with `tile=none` and no `removed` pair at all - the code's own word is the proof.
  const gone = receiptFact(rockGone(ROCKS_108[6]!), "rock_source_gone");
  const proved = provedGoneTargets([gone]);
  assert.equal(proved.size, 1, "a `_gone` receipt proves the row it named");
  const line = rockLine(briefWith([gone]));
  assert.doesNotMatch(line, /\(12,9\)/u, `the stone the Mod answered _gone for is not offered: ${line}`);
});

test("target_family_table_is_not_needed: any family's row is proved by its own id", () => {
  // The mechanism is keyed on the row's id, never on a family name: `item_target_gone` names its row `expected=` and the
  // pack-action row leaves the `itemTargets` line by the same rule a stone leaves the rock line.
  const item = receiptFact(
    "expected=item_89728b64892dedcb;item=(O)390;tile=6,5;location=UndergroundMine1;actual=none",
    "item_target_gone",
    "pickup_item",
  );
  const world = {
    ...MINE_108,
    itemTargets: [{ x: 6, y: 5, targetId: "item_89728b64892dedcb" }],
  } as unknown as Snapshot;
  const text = composeFactBrief({
    inputs: [],
    snapshot: { ...readingOf(0), snapshot: world },
    events: [item],
    locale: "zh-CN",
  });
  const line = worldStateLines(text).find((each) => /^地上的物品/u.test(each)) ?? "";
  assert.notEqual(line, "", "the item family is printed");
  assert.doesNotMatch(line, /\(6,5\)/u, `the row the Mod answered item_target_gone for is not offered: ${line}`);
});

test("target_all_gone: a family every receipt emptied says so instead of reading as a row it could not place", () => {
  // The shape that would otherwise lie: `石头 其余 8 格未列出（这些行没有坐标）` - the rows have coordinates, they are gone.
  const every = ROCKS_108.map((row) => receiptFact(rockBroken(row, "(O)32"), "rock_source_broken"));
  const line = rockLine(briefWith(every));
  assert.equal(line.includes("没有坐标"), false, `the rows have coordinates and left the world: ${line}`);
  assert.match(line, /全部 8 格已不在/u, `the emptied family says what emptied it: ${line}`);
});

test("target_proof_reaches_the_model_through_a_settled_program_node", () => {
  // She dispatches through body programmes, so the removal usually arrives folded into a settlement's node evidence.
  const settlement: WorldFact = {
    source: "host_local_transport",
    kind: "world_fact",
    eventId: "program_settled_1",
    correlationId: "program_settled_1",
    revision: 123,
    semanticKind: "program_settled",
    payload: {
      total: 1,
      counts: { succeeded: 1 },
      nodes: [
        {
          nodeId: "n02",
          actionId: "break_rock",
          state: "succeeded",
          reasonCode: "rock_source_broken",
          evidence: rockBroken(ROCKS_108[0]!, "(O)32"),
        },
      ],
    },
  } as unknown as WorldFact;
  assert.doesNotMatch(rockLine(briefWith([settlement])), /\(6,5\)/u, "a settlement's node evidence is a proof too");
});

test("target_composition_without_a_delivery_is_unchanged", () => {
  // The direct `composeWorldState` caller (the block on its own) has no delivery to trust and must keep working.
  const text = composeWorldState(readingOf(0));
  assert.match(rockLine(text), /^石头 \(6,5\) \(5,5\) \(5,6\) \(11,7\) \(11,8\) \(4,9\) 其余 2 格未列出$/u);
});
