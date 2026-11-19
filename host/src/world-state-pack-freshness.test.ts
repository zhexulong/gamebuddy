/**
 * THE GATE FOR "A STATE LINE THAT GOES STALE WITHOUT SAYING SO", on the pack.
 *
 * <p>
 * MEASURED (round75, 208 record session). `<world-state>` printed `种子: 2 花椰菜种子` on every one of fourteen refusal
 * turns while both seeds had already been planted - her own words said `两粒籽都落土了`, and the receipts in the same
 * deliveries said `inventory_after=1` and then `inventory_after=0`. `种子: 0` first appears a hundred turns later, after
 * she called `stardew_observe`. So fifty-plus turns were planned on a count the delivery itself had already corrected.
 * </p>
 *
 * <p>
 * TWO LIES, and they are different. The first is the CONTRADICTION: one message carried the Mod's own post-action count
 * (`item=(O)472;…;inventory_after=0`, summed over the pack exactly as `heldCount` is) beside a state line that said two.
 * The second is the SILENCE: when no receipt corrects it, the count had no age on it, while the block's age sat three
 * clauses away in a parenthetical about "the world".
 * </p>
 *
 * <p>
 * THE PROPERTY. Every pack line is one of:
 *   - RE-EMITTED from the delivery's own proof - the Mod's `item=` + `inventory_after=` from a receipt or a settled
 *     node - and named as such, so the number she plans against is the newest one anybody has; or
 *   - AGE-STAMPED, so the number and how old it is cannot be read apart.
 * A pack line in neither state is the defect this file exists for.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { composeFactBrief, composeWorldState, provedPackCounts, type WorldStateReading } from "./fact-brief.js";
import type { WorldFact } from "./event-pump.js";
import type { Snapshot } from "./protocol.js";

/** The seed she planted twice in round75's run: a cauliflower seed, qualified. */
const CAULIFLOWER_SEED = "(O)472";

const world: Snapshot = {
  revision: 14,
  location: "Farm",
  tile: { x: 62, y: 15 },
  stamina: 82,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 700,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "sun",
  currentTool: "(T)Hoe",
  currentToolSlot: 0,
  toolSlots: [{ slot: 0, label: "(T)Hoe", category: "hoe", upgradeLevel: 2 }],
  inventoryItemFacts: [
    { slot: 3, qualifiedItemId: "(O)388", displayName: "木头", stack: 47 },
    { slot: 4, qualifiedItemId: CAULIFLOWER_SEED, displayName: "花椰菜种子", stack: 2 },
  ],
  seedSupplyTargets: [
    {
      qualifiedItemId: CAULIFLOWER_SEED,
      displayName: "花椰菜种子",
      heldCount: 2,
      shopId: "SeedShop",
      shopDisplayName: "皮埃尔的杂货店",
      ownerName: "Pierre",
      price: 80,
      currency: 0,
      hoursCondition: "900 1800",
      openNow: true,
    },
  ],
} as unknown as Snapshot;

/** The reading as she held it: three delivered turns after it was taken. */
const agedReading = (ageTurns: number): WorldStateReading => ({
  snapshot: world,
  revision: 14,
  ageTurns,
  ageMs: 900_000,
  contentAgeMs: 900_000,
});

function receiptFact(detail: string, state = "succeeded", actionId = "plant_seed"): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `receipt_${detail}`,
    correlationId: `receipt_${detail}`,
    executionId: `exec_${detail}`,
    revision: 15,
    payload: { actionId, state, reasonCode: "planted", evidence: { detail } },
    gameTime: "700",
  }) as unknown as WorldFact;
}

/** The Mod's own `plant_seed` receipt (`farmhandexecutioncontroller.farmingconstructionactions.cs:393`). */
const plantedOne = (before: number, after: number): string =>
  `location=Farm;target=seed_target_1;tile=62,14;item=${CAULIFLOWER_SEED};crop=472;inventory_before=${String(before)};inventory_after=${String(after)}`;

const briefWith = (events: readonly WorldFact[], ageTurns = 3): string =>
  composeFactBrief({ inputs: [], snapshot: agedReading(ageTurns), events, locale: "zh-CN" });

/** The clauses of `<world-state>` itself, so an assertion about one line cannot be satisfied by the receipt beside it. */
function worldStateClauses(text: string): readonly string[] {
  const open = text.indexOf("<world-state>");
  const close = text.indexOf("</world-state>");
  if (open < 0 || close < 0) return [];
  return text
    .slice(open, close)
    .split(/[；\n]/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
}

/** The seed sentence's own clause, isolated. */
function seedLine(text: string): string {
  return worldStateClauses(text).find((clause) => clause.includes("种子:")) ?? "";
}

/** The pack sentence's own clause, isolated. */
function packLine(text: string): string {
  return worldStateClauses(text).find((clause) => clause.includes("身上带着")) ?? "";
}

test("pack_contradiction: a delivery that proves the seed count changed does not also print the old count as current", () => {
  // THE FALSIFIER. Plant twice: the readings still say two, and the two receipts in this one delivery say one and then
  // zero. Before the fix the state line keeps saying two, so this is the round75 shape reproduced without a live run.
  const afterFirstPlant = briefWith([receiptFact(plantedOne(2, 1))]);
  const afterSecondPlant = briefWith([receiptFact(plantedOne(2, 1)), receiptFact(plantedOne(1, 0))]);
  const line = seedLine(afterSecondPlant);
  assert.notEqual(line, "", "the seed line is composed at all");
  assert.doesNotMatch(
    afterFirstPlant,
    /种子: 2\b/u,
    "the reading says 2 and the receipt says 1: the state line must not contradict the delivery it arrives in",
  );
  assert.doesNotMatch(
    afterSecondPlant,
    /种子: 2\b/u,
    "two receipts, one delivery, and the seed line must end at the count the Mod last counted",
  );
  assert.match(line, /0/u, `the seed line states the proof's own count: ${line}`);
});

test("pack_proof_is_named: the re-emitted count says a step counted it, so it is not a second silent reading", () => {
  const line = seedLine(briefWith([receiptFact(plantedOne(2, 0))]));
  assert.match(line, /0 花椰菜种子/u, `the seed line states the proof's own count: ${line}`);
  // THE CLAIM, NOT THE ACTION ID. `（plant_seed 之后数的）` put a handle in the middle of a sentence, and a run taught by
  // that line answers with action ids instead of work. The claim is what makes the number a statement about a MOMENT;
  // which action took the count is the receipt's own statement, printed beside it by `receiptLine`.
  assert.match(line, /（刚做完那一步之后数的）/u, `a count that replaced the reading says it was re-counted: ${line}`);
  assert.doesNotMatch(line, /plant_seed|_seed/u, `and it names no action id: ${line}`);
});

test("pack_age_is_stated: a pack count with no proof carries the age of the reading it came from", () => {
  // THE OTHER HORN. Nothing corrected this count, so the number must not be able to be read as the present tense: the
  // block's own parenthetical sits three clauses away and mentions "the world", not this number.
  const line = seedLine(briefWith([], 12));
  assert.match(line, /12/u, `a twelve-turn-old count states its age on its own line: ${line}`);
});

test("pack_fresh_reading_is_not_stamped: a count read this turn says nothing extra", () => {
  const line = seedLine(briefWith([], 0));
  assert.match(line, /2/u);
  assert.doesNotMatch(line, /轮前|之后数的/u, `a count read this turn needs no qualifier: ${line}`);
});

test("pack_proof_of_another_item_does_not_touch_this_line", () => {
  // Boundary: the proof names one item. A receipt about stone must not re-date the seeds.
  const stone = `location=Farm;target=rock_1;tile=70,20;item=(O)390;inventory_before=12;inventory_after=11`;
  const line = seedLine(briefWith([receiptFact(stone)], 4));
  assert.match(line, /2/u, `the seed row is untouched by a receipt about another item: ${line}`);
  assert.match(line, /4/u, `and it is still an aged count, so it says so: ${line}`);
});

test("pack_refusal_carries_no_count_and_supersedes_nothing", () => {
  // Boundary: a rejected plant changed no stack. Its evidence names no `inventory_after`, so it is not a proof.
  const refusal = receiptFact(
    `location=Farm;target=seed_target_1;tile=62,14;item=${CAULIFLOWER_SEED};reason=slot_empty`,
    "rejected",
  );
  const proved = provedPackCounts([refusal]);
  assert.equal(proved.size, 0, "a refusal states no count, so it proves nothing about the pack");
});

test("pack_proof_reaches_the_model_through_a_settled_program_node", () => {
  // She dispatches through body programs, so the count usually arrives folded into a settlement's node evidence rather
  // than on a bare receipt. Both shapes are the Mod's own detail string and both must count.
  const settlement: WorldFact = {
    source: "host_local_transport",
    kind: "world_fact",
    eventId: "program_settled_1",
    correlationId: "program_settled_1",
    revision: 15,
    semanticKind: "program_settled",
    payload: {
      total: 1,
      counts: { succeeded: 1 },
      nodes: [{ nodeId: "n01", actionId: "plant_seed", state: "succeeded", evidence: plantedOne(2, 0) }],
    },
  } as unknown as WorldFact;
  assert.doesNotMatch(briefWith([settlement]), /种子: 2\b/u, "a settlement's node evidence is a proof too");
});

test("pack_line_population: every pack-count line the block emits obeys the property", () => {
  // The block composes several lines; two of them print pack counts (`种子:` and `身上带着`). Both must obey, because
  // leaving one of two adjacent lines stale is the same defect one clause to the right.
  const picked = `location=Farm;target=debris_1;tile=64,11;item=(O)388;stack=1;inventory_before=47;inventory_after=48`;
  const text = briefWith([receiptFact(picked, "succeeded", "pickup_item")]);
  const pack = packLine(text);
  assert.notEqual(pack, "", "the pack line is composed at all");
  assert.doesNotMatch(pack, /47 份/u, `the pack line states the proof's own count: ${pack}`);
  assert.match(pack, /48 份/u, `and it is the proven count, in the pack line's own words: ${pack}`);
  assert.match(pack, /（刚做完那一步之后数的）/u, `said to be a receipt's count, not a second silent reading: ${pack}`);
  assert.doesNotMatch(pack, /pickup_item/u, `and with no action id in the sentence: ${pack}`);
});

test("pack_composition_without_a_delivery_is_unchanged", () => {
  // The direct `composeWorldState` caller (the block on its own) has no delivery to trust and must keep working.
  const text = composeWorldState(agedReading(0));
  assert.match(seedLine(text), /种子: 2 花椰菜种子/u);
});
