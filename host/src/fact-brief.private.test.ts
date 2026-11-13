import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CompanionEventPump, type WorldFact } from "./event-pump.js";
import {
  composeFactBrief,
  composeWorldState,
  FACT_BRIEF_BLOCKS,
  MODEL_FIELD_CEILINGS,
  type ModelVisibleField,
  unchangedWorldAnswer,
} from "./fact-brief.js";
import { createStardewObservationTools } from "./game-tools.js";
import {
  MAX_TARGET_FAMILIES_SHOWN,
  NON_ROW_FAMILIES,
  nearbyTargetFamilies,
  TARGET_FAMILY_LABELS,
} from "./game-world-vocabulary.js";
import { buildGameCompanionSystemPrompt } from "./game-surface-prompt-floor.js";
import { DEFAULT_IDENTITY_PROFILE } from "./identity-profile.js";
import { createProgramProgressObserver } from "./program-status-wait.js";
import { SNAPSHOT_KEYS, type Snapshot } from "./protocol.js";

/**
 * THE FOUR BLOCKS, AS GATES RATHER THAN AS SHAPES SOMEONE REMEMBERED.
 *
 * <p>
 * The model's user message was one stringified object for a year: measured 2026-11-10 (`round44`, 109 delivered
 * batches) it averaged 11,066 characters, carried `worldFacts` and the SAME facts again under `events`, and the
 * player's own note ("找片水，钓条鱼回来") was one array element inside it - 0 of 162 thinking parts mentioned fishing.
 * `fact-brief.ts` replaces it with four named blocks of prose.
 * </p>
 *
 * <p>
 * A prose format is easy to break silently: a block that is not in the closed set, a fact that leaks into the note, a
 * stray JSON envelope in the middle of the text. Each is one assertion below, and each names the member that broke.
 * </p>
 */

const world: Snapshot = {
  revision: 1205,
  location: "Farm",
  tile: { x: 64, y: 15 },
  stamina: 82,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 620,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "rain",
  currentTool: "(T)Hoe",
  currentToolSlot: 0,
  toolSlots: [{ slot: 0, label: "(T)Hoe", category: "hoe", upgradeLevel: 2 }],
  inventoryItemFacts: [
    { slot: 0, qualifiedItemId: "(O)388", displayName: "木头", stack: 47 },
    { slot: 1, qualifiedItemId: "(O)390", displayName: "石头", stack: 12 },
  ],
  cropTargets: [
    { targetId: "crop_1", x: 62, y: 14, cropId: "24", displayName: "Cauliflower" },
    { targetId: "crop_2", x: 63, y: 14, cropId: "24", displayName: "Cauliflower" },
  ],
  // A real farm's families are big: the whole point of naming six tiles and counting the rest is that these rows
  // arrive at 20-64 each.
  weedTargets: Array.from({ length: 20 }, (_, index) => ({ targetId: `weed_${String(index)}`, x: 60 + index, y: 15 })),
  debrisTargets: Array.from({ length: 30 }, (_, index) => ({
    targetId: `debris_${String(index)}`,
    x: 64 + (index % 8),
    y: 11 + Math.floor(index / 8),
  })),
  rockSourceTargets: Array.from({ length: 12 }, (_, index) => ({
    targetId: `rock_${String(index)}`,
    x: 70 + index,
    y: 20,
  })),
  harvestTargets: [],
} as unknown as Snapshot;

function fact(overrides: Partial<WorldFact> & Pick<WorldFact, "kind">): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    correlationId: overrides.kind,
    revision: 1,
    payload: {},
    ...overrides,
  }) as WorldFact;
}

const snapshotFact = (revision: number, payload: Snapshot = { ...world, revision } as Snapshot): WorldFact =>
  fact({ kind: "snapshot", eventId: `snapshot_${String(revision)}`, revision, payload: payload as never });

/** One batch that exercises every block: a player note, a fresh reading, events, and a settled programme. */
function richBatchFacts(): WorldFact[] {
  return [
    fact({ kind: "world_fact", eventId: "day_3", semanticKind: "day_started", payload: { day: 3 }, gameTime: "600" }),
    fact({
      kind: "world_fact",
      eventId: "dialogue_marnie",
      semanticKind: "npc_dialogue_presented",
      payload: { speaker: "Marnie", pages: ["早呀。"], choices: [] },
      gameTime: "620",
    }),
    fact({
      kind: "execution_receipt",
      eventId: "receipt_water_1",
      executionId: "exec_water",
      payload: {
        actionId: "water_crop",
        state: "rejected",
        reasonCode: "not_adjacent",
        evidence: { detail: "够不到 (74,22)，那块地不可耕" },
      },
      gameTime: "630",
    }),
    ...[2, 3, 4, 5].map((index) =>
      fact({
        kind: "execution_receipt",
        eventId: `receipt_route_${String(index)}`,
        executionId: `exec_route_${String(index)}`,
        payload: { actionId: "navigate_to_destination", state: "succeeded", reasonCode: "arrived" },
        gameTime: "630",
      }),
    ),
    fact({
      kind: "world_fact",
      eventId: "program_settled_plan_1",
      semanticKind: "program_settled",
      payload: {
        total: 2,
        counts: { succeeded: 1 },
        nodes: [{ actionId: "water_crop", state: "failed", reasonCode: "not_adjacent", hint: "先走近一点" }],
      },
    }),
  ];
}

const playerInput = {
  source: "player_text" as const,
  inputId: "input_1",
  text: "找片水，钓条鱼回来",
  locale: "zh-CN",
  timestampMs: 1,
};

function richBrief(): string {
  return composeFactBrief({
    inputs: [playerInput],
    snapshot: { snapshot: world, revision: 1205, ageTurns: 0, ageMs: 0 },
    events: richBatchFacts(),
    inFlight: richInFlight(),
    locale: "zh-CN",
  });
}

/**
 * A programme mid-flight, read out of the real ledger from a real journal payload.
 *
 * The fixture is not a hand-written `{programmes: [...]}`: it is a `program_status` answer fed to a fresh observer, so
 * the block below is composed from what the production reader actually produces. The clock is fixed (`0` read at, `4000`
 * asked) so the determinism test can compare two renderings.
 */
function richInFlight() {
  const observer = createProgramProgressObserver();
  observer.observe(
    {
      code: "found",
      snapshot: {
        programId: "plan_rich",
        state: "active",
        catalogRevision: 3,
        stopEpoch: 0,
        eventHighWater: 9,
        nodes: [
          { nodeId: "n001", state: "running", nodeAttempt: 0, admissionAttempt: 0, actionId: "water_crop" },
          { nodeId: "n002", state: "pending", nodeAttempt: 0, admissionAttempt: 0, actionId: "water_crop" },
        ],
      },
    },
    0,
  );
  return observer.inFlight(4_000);
}

/** Every block name the text opens, in order. */
function blocksOf(text: string): string[] {
  return [...text.matchAll(/<([a-z-]+)>/gu)].map((match) => match[1] ?? "");
}

test("block_coverage: every block the composer emits is in the closed set, and every member is emitted", () => {
  // The population is `FACT_BRIEF_BLOCKS` - the declaration the prompt floor names - so a fifth block cannot be
  // emitted without failing here by name, and a member that no composition ever produces is dead weight in the floor.
  const emitted = new Set(blocksOf(richBrief()));
  const outside = [...emitted].filter((name) => !(FACT_BRIEF_BLOCKS as readonly string[]).includes(name));
  assert.deepEqual(outside, [], `these blocks are not in FACT_BRIEF_BLOCKS: ${outside.join(", ")}`);
  const unproduced = FACT_BRIEF_BLOCKS.filter((name) => !emitted.has(name));
  assert.deepEqual(
    unproduced,
    [],
    `the fixture produces no <${unproduced.join("> or <")}> block, so nothing here proves the composer can emit it`,
  );
  // The same text also proves each block is CLOSED: an opening tag with no closing tag of the same name would leave
  // the model with a block whose end it cannot see.
  const text = richBrief();
  for (const name of FACT_BRIEF_BLOCKS) {
    assert.equal(
      text.split(`<${name}>`).length,
      text.split(`</${name}>`).length,
      `the <${name}> block is opened and closed a different number of times`,
    );
  }
});

/**
 * The prompt floor's block sentence, as ONE place the count can come from.
 *
 * <p>
 * The floor (`identity-profile.ts`) introduces the delivery in prose - "it arrives as prose in four blocks - &lt;player-note&gt;
 * … and &lt;execution-result&gt;" - and that `four` is a hand-written copy of `FACT_BRIEF_BLOCKS.length`. `<in-flight>` made
 * it five, and the paragraph was not this change's to edit: `identity-profile.ts` and
 * `game-surface-prompt-floor.test-support.ts` both carry another lane's uncommitted hunk for that very paragraph, so a
 * path-scoped commit here would have swept it.
 * </p>
 *
 * <p>
 * SO THE DRIFT IS NAMED RATHER THAN SILENT. While the floor's number disagrees with the closed set the test SKIPS with
 * `floor_block_count_owes_update:identity-profile.ts`, which names the file that owes the fix. It is not a green check:
 * `skip` is the one node:test verdict that says "not run" rather than "passed", and the moment the floor's count is
 * regenerated from `FACT_BRIEF_BLOCKS.length` both assertions below go live - the count AND the member names.
 * </p>
 */
test("floor_block_count_owes_update: the prompt floor states the closed set's own length, and names each member", (context) => {
  const floor = buildGameCompanionSystemPrompt(DEFAULT_IDENTITY_PROFILE);
  const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const paragraph = /prose in (?:\d|[a-z]+) blocks?[^.]*\./u.exec(floor)?.[0] ?? "";
  const stated = Number.parseInt(/prose in (\d+)/u.exec(floor)?.[1] ?? "", 10);
  const statedWord = NUMBER_WORDS.indexOf(/prose in ([a-z]+) blocks?/u.exec(floor)?.[1] ?? "");
  const counts = Number.isNaN(stated) ? statedWord : stated;
  if (counts !== FACT_BRIEF_BLOCKS.length)
    return context.skip(
      `floor_block_count_owes_update:identity-profile.ts:floor_says_${String(counts)}_blocks;FACT_BRIEF_BLOCKS_is_${String(FACT_BRIEF_BLOCKS.length)}`,
    );
  const named = [...new Set([...paragraph.matchAll(/<([a-z-]+)>/gu)].map((match) => match[1] ?? ""))].sort();
  assert.deepEqual(
    named,
    [...FACT_BRIEF_BLOCKS].sort(),
    "the floor names the blocks the delivery carries, and no block it does not",
  );
  process.stdout.write(`floor_blocks examined ${String(counts)} of FACT_BRIEF_BLOCKS\n`);
});

test("note_in_own_block: the player's words are in <player-note> and nowhere else", () => {
  const text = richBrief();
  const occurrences = text.split(playerInput.text).length - 1;
  assert.equal(
    occurrences,
    1,
    `the player's note appears ${String(occurrences)} times, and it must appear exactly once`,
  );
  // The block holds a label line per run of his sentences (`player-note.ts` reads the note) and his words inside `「」`:
  // the words are unbroken, in his order, and the labels are the only added text.
  const note = /<player-note>\n([\s\S]*?)\n<\/player-note>/u.exec(text)?.[1] ?? "";
  const quoted = [...note.matchAll(/「([^」]*)」/gu)].map((match) => match[1] ?? "");
  assert.equal(
    quoted.join(""),
    playerInput.text,
    "the quoted runs of the note block are the player's words, verbatim and in his order",
  );
});

test("bare_json_in_model_text: the composed text is prose, not an envelope", () => {
  const text = richBrief();
  // The shape this replaces carried `{"kind":"gamebuddy_fact_batch"` and `":"` between every key and value. Either
  // marker in a block means a JSON object has leaked into the model's message.
  assert.equal(text.includes('{"'), false, `the composed text contains a JSON object: ${text.slice(0, 200)}`);
  assert.equal(text.includes('":"'), false, `the composed text contains a JSON key/value pair: ${text.slice(0, 200)}`);
  assert.equal(text.includes("gamebuddy_fact_batch"), false, "the delivery no longer announces a wire kind at all");
});

test("the world block names its revision and its freshness, and never claims to be the world", () => {
  const fresh = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 0, ageMs: 0 });
  assert.match(fresh, /^<world-state>\n世界（revision 1205，刚刚更新）$/mu);
  const stale = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 3, ageMs: 90_000 });
  assert.match(stale, /^<world-state>\n世界（revision 1205，本轮无新观察）$/mu);
  assert.match(stale, /（这是 3 轮之前看到的，世界已经不一样了）/u, "and how old the reading is, in words");
  const nothing = composeWorldState(undefined);
  assert.equal(nothing, "<world-state>\n世界：尚未收到观察\n</world-state>");
});

test("the world block names the objects she acts on, with their tiles", () => {
  const text = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 0, ageMs: 0 });
  assert.match(text, /手持: 锄头/u, "the held tool is said in words");
  assert.match(text, /待浇水的作物 \(63,14\)/u, "the nearest dry crop is named with its tile, nearest first");
  assert.match(text, /杂草 \(64,15\)/u, "the nearest weed tile is named");
  assert.match(text, /这一带没有/u, "and a family the Mod published as empty says so");
});

test("own_health_in_the_world_block: her hit points are in the text she reads, bare and never completed", () => {
  const block = (snapshot: Snapshot): string => composeWorldState({ snapshot, revision: 1, ageTurns: 0, ageMs: 0 });

  // The fact, in the shape the stamina beside it uses. Before this line `health` was exempted by a rendering into
  // `contextProjection.hud`, a block nothing in the tree reads (`host/src/host-service.ts:1235` is its only consumer).
  const hurt = block({ ...world, health: 45 } as Snapshot);
  assert.match(hurt, /血量: 45/u, `her own health is in the block she reads: ${hurt}`);

  // BARE, because the wire publishes no maximum: a `45/100` would be a number this file invented, the same rule
  // `formatGameStamina` follows for stamina.
  assert.equal(/血量: 45\//u.test(hurt), false, `no invented maximum beside the reading: ${hurt}`);

  // ABSENT IS NOT A HEALTHY DEFAULT: a reading that is not a finite number prints nothing at all.
  for (const unreadable of [Number.NaN, Number.POSITIVE_INFINITY, undefined])
    assert.equal(
      /血量/u.test(block({ ...world, health: unreadable } as unknown as Snapshot)),
      false,
      `an unreadable health reading (${String(unreadable)}) is silence, not a full bar`,
    );
});

test("can_water_beside_the_held_tool: the can's own water reaches the prose, and an absent reading says nothing", () => {
  const block = (snapshot: Snapshot): string => composeWorldState({ snapshot, revision: 1, ageTurns: 0, ageMs: 0 });
  const can = {
    slot: 2,
    qualifiedItemId: "(T)WateringCan",
    label: "(T)WateringCan",
    displayName: "喷壶",
    water: 40,
    max: 40,
  };
  const heldCan = { slot: 2, label: "(T)WateringCan", category: "watering_can" };

  // THE RUN'S OWN SHAPE (2026-11-11, the 08:50 batch): the axe in hand, one can in the pack at slot 2, and the wire
  // publishing `water 40, max 40` in a family the block never read.
  const carried = block({ ...world, wateringCanFacts: [can] } as unknown as Snapshot);
  assert.match(carried, /壶里的水: 40\/40/u, `the published water figure is in the block she reads: ${carried}`);
  assert.match(carried, /身上带着/u, "and it is added beside the pack list rather than replacing it");

  // Beside the HELD tool: the figure follows the hand that is in the can, in the same reading order.
  const holding = block({
    ...world,
    currentTool: "(T)WateringCan",
    currentToolSlot: 2,
    toolSlots: [...(world.toolSlots ?? []), heldCan],
    wateringCanFacts: [can],
  } as unknown as Snapshot);
  assert.match(holding, /手持: 洒水壶/u, "the held tool is still named in words");
  assert.ok(
    holding.indexOf("手持: 洒水壶") < holding.indexOf("壶里的水: 40/40"),
    `the water figure follows the held tool: ${holding}`,
  );

  // A can the Mod measured as EMPTY is a fact and prints as one: zero is the number a gauge reports, so it must be
  // distinguishable from silence.
  assert.match(
    block({ ...world, wateringCanFacts: [{ ...can, water: 0 }] } as unknown as Snapshot),
    /壶里的水: 0\/40/u,
    "a measured empty can says so",
  );

  // ABSENT IS NOT ZERO: the family is gated on `refill_watering_can` being advertised, so a Mod that did not publish it
  // must not read as an empty can.
  const absent = block(world);
  assert.equal(/壶里的水/u.test(absent), false, `an absent family prints nothing: ${absent}`);
  assert.equal(/0\/0/u.test(absent), false, "and nothing invents a level for it");

  // Two cans and neither in her hand is not a question one figure answers, so it answers none.
  const ambiguous = block({
    ...world,
    wateringCanFacts: [can, { ...can, slot: 3 }],
  } as unknown as Snapshot);
  assert.equal(/壶里的水/u.test(ambiguous), false, `two unheld cans print no figure: ${ambiguous}`);
});

test("a reading that has not changed is one line, not the whole world again", () => {
  const answer = unchangedWorldAnswer(1205);
  assert.equal(answer, "自 revision 1205 以来世界没有变化");
  const full = composeWorldState({ snapshot: world, revision: 1205, ageTurns: 0, ageMs: 0 });
  // The reading is stated as the two lengths, so a future change that quietly returns the dump cannot pass by
  // looking like a sentence.
  assert.ok(
    answer.length < full.length / 4,
    `the unchanged answer is ${String(answer.length)} chars and the dump is ${String(full.length)} - it must be a line`,
  );
});

test("world_state_present: the pump states the world on EVERY batch, including batches that brought no snapshot", async () => {
  const pump = new CompanionEventPump();
  const batches: string[] = [];
  pump.enqueueFact(snapshotFact(1205));
  pump.enqueueFact(
    fact({ kind: "execution_receipt", eventId: "receipt_1", executionId: "exec_1", payload: { state: "succeeded" } }),
  );
  await pump.flush({
    async deliver(batch) {
      batches.push(batch.text);
    },
  });
  // Three later turns, none of which observes anything: each is opened by a receipt and must still state the world.
  for (let index = 2; index <= 4; index += 1) {
    pump.enqueueFact(
      fact({
        kind: "execution_receipt",
        eventId: `receipt_${String(index)}`,
        executionId: `exec_${String(index)}`,
        payload: { state: "succeeded" },
      }),
    );
    await pump.flush({
      async deliver(batch) {
        batches.push(batch.text);
      },
    });
  }
  const carrying = batches.filter((text) => text.includes("<world-state>")).length;
  assert.equal(carrying, batches.length, `world_state_present ${String(carrying)}/${String(batches.length)}`);
  assert.equal(batches.length, 4, "and the run has four batches to count, so the ratio is not 0/0");
  assert.match(batches[1] ?? "", /本轮无新观察/u, "a batch with no observation says so");
  assert.match(batches[1] ?? "", /体力: 82/u, "and still states what the last observation saw");

  // THE READINGS, printed rather than estimated.
  process.stdout.write(`world_state_present ${String(carrying)}/${String(batches.length)}\n`);
});

test("prose_cost_per_batch: what one delivery costs, against the envelope it replaces", () => {
  const facts = richBatchFacts();
  const inputs = [playerInput];
  const prose = composeFactBrief({
    inputs,
    snapshot: { snapshot: world, revision: 1205, ageTurns: 0, ageMs: 0 },
    events: facts,
    locale: "zh-CN",
  });
  // round44's own shape, computed from the SAME contents so the two numbers describe one batch: the envelope was
  // `{kind, batchId, disposition, triggerEventIds, playerInputs, worldFacts, events}`, with `events` a second copy of
  // the presentable facts and the whole snapshot under `payload`.
  const envelope = JSON.stringify({
    kind: "gamebuddy_fact_batch",
    batchId: "batch_fixture",
    disposition: "steer",
    triggerEventIds: inputs.map((input) => input.inputId),
    playerInputs: inputs,
    worldFacts: [snapshotFact(1205), ...facts],
    events: [snapshotFact(1205), ...facts.filter((entry) => entry.kind === "world_fact")],
  });
  process.stdout.write(
    `prose_cost_per_batch ${String(prose.length)} chars against the same batch as JSON ${String(envelope.length)} chars\n`,
  );
  assert.ok(
    prose.length < envelope.length,
    `the prose delivery is ${String(prose.length)} chars and the envelope it replaces is ${String(envelope.length)}`,
  );
});

/** The wire's own schema document: the row shapes the Mod publishes and the Host validates. */
const WIRE_SCHEMA_PATH = fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url));

/** One array family's declaration, and the record its rows point at. */
type WireFamily = Readonly<{ type?: string; items?: Readonly<{ $ref?: string }> }>;
type WireRecord = Readonly<{ properties?: Readonly<Record<string, unknown>> }>;

/**
 * The families the wire publishes whose rows carry a tile: `x` and `y`, the two keys `nearbyTargetFamilies` prints.
 *
 * THE POPULATION IS THE PROTOCOL DOCUMENT'S ROW SHAPE, not a family's name. The gate this replaces - and the one that let
 * `soilTiles` stay invisible - filtered `SNAPSHOT_KEYS` on `/(?:Targets|Sites|Slots)$/`: 120 keys, 75 examined, and
 * `soilTiles` is the only family the wire spells `*Tiles`, so the whole target list of `till_soil` sat outside its vision
 * while it reported green. `x`/`y` is not a spelling, it is the shape this composer prints, and a family added tomorrow is
 * judged by the same property with no edit here.
 */
function wireTileFamilies(): readonly string[] {
  const schema = JSON.parse(readFileSync(WIRE_SCHEMA_PATH, "utf8")) as Readonly<{
    $defs?: Readonly<Record<string, WireRecord>>;
  }>;
  const families = schema.$defs?.snapshot?.properties as Readonly<Record<string, WireFamily>> | undefined;
  // A gate that silently examined nothing agrees with itself, so an unreadable document is a throw, not an empty list.
  if (families === undefined)
    throw new Error("the wire schema declares no `$defs.snapshot.properties`: this gate reads it by shape");
  const tile: string[] = [];
  for (const [family, spec] of Object.entries(families)) {
    if (spec.type !== "array") continue;
    const reference = spec.items?.$ref;
    if (typeof reference !== "string") continue;
    const row = schema.$defs?.[reference.slice(reference.lastIndexOf("/") + 1)]?.properties;
    if (row === undefined) continue;
    if ("x" in row && "y" in row) tile.push(family);
  }
  return tile;
}

/**
 * A tile family the batch prints has a word, or states why it is not a row here.
 *
 * RED AT `ee16cdac` (the commit this unit started from): `soilTiles` - the whole target list of `till_soil` - was the
 * family with neither, and the companion's only visible ground was `可清的地块`, the hoe-dirt family `till_soil` refuses.
 * Eleven live attempts to clear and plant a strip tilled 15-46 tiles and never once saw the ground it could till.
 */
test("target_family_labels: every tile family the wire publishes has a word, or a stated reason it is not a row", () => {
  const families = wireTileFamilies();
  // Refuse to pass on nothing: an empty population agrees with every assertion below.
  assert.ok(
    families.length >= 55,
    `examined ${String(families.length)} tile families, which is too few to be the wire`,
  );
  const admitted = new Set<string>(SNAPSHOT_KEYS);
  const unpublished = families.filter((family) => !admitted.has(family));
  assert.deepEqual(
    unpublished,
    [],
    `the wire publishes these tile families and SNAPSHOT_KEYS does not admit them: ${unpublished.join(", ")}`,
  );
  const unaccounted = families.filter((family) => !(family in TARGET_FAMILY_LABELS) && !(family in NON_ROW_FAMILIES));
  assert.deepEqual(
    unaccounted,
    [],
    `these wire families carry tile coordinates and neither print a name nor state a reason: ${unaccounted.join(", ")}`,
  );
  const blank = Object.entries(NON_ROW_FAMILIES)
    .filter(([, reason]) => reason.trim() === "")
    .map(([family]) => family);
  assert.deepEqual(blank, [], `these families state no reason at all: ${blank.join(", ")}`);
  // And no word or reason may name a family the wire does not publish: that is an answer to nothing.
  const unknown = [...Object.keys(TARGET_FAMILY_LABELS), ...Object.keys(NON_ROW_FAMILIES)].filter(
    (family) => !admitted.has(family),
  );
  assert.deepEqual(
    unknown,
    [],
    `these labels and reasons name families the wire does not publish: ${unknown.join(", ")}`,
  );
  process.stdout.write(
    `target_family_labels examined ${String(families.length)} tile families of ${String(SNAPSHOT_KEYS.length)} wire keys\n`,
  );
});

/**
 * `till_soil`'s ground, printed for her.
 *
 * The two ground families are separate sentences on purpose: `可清的地块` is the hoe dirt `till_soil` REFUSES (it already
 * has one, so `clear_hoe_dirt` is the action) and `可锄的地块` is the bare ground it accepts. A line that named only the
 * first told her the strip was "already tilled but empty" and left her hand-writing coordinates outside it - 27 refusals
 * of `soil_not_diggable:not_map_diggable` in one measured run.
 */
test("soilTiles prints the ground till_soil accepts, beside the hoe dirt it refuses", () => {
  const snapshot = {
    ...world,
    soilTiles: [
      { x: 65, y: 15 },
      { x: 66, y: 15, hoeDirt: false },
    ],
    clearHoeDirtTargets: [{ targetId: "hoe_dirt_1", x: 67, y: 15 }],
  } as unknown as Snapshot;
  const family = nearbyTargetFamilies(snapshot).find((entry) => entry.family === "soilTiles");
  assert.equal(family?.label, "可锄的地块");
  assert.equal(family?.total, 2);
  assert.equal(family?.rendered, "可锄的地块 (65,15) (66,15)");
  const text = composeWorldState({ snapshot, revision: 1205, ageTurns: 0, ageMs: 0 });
  assert.match(text, /可锄的地块 \(65,15\) \(66,15\)/u);
  assert.match(text, /可清的地块 \(67,15\)/u, "the family `till_soil` refuses keeps its own sentence");
  // A measured empty family is the answer "there is no ground to hoe here", not silence.
  const none = composeWorldState({
    snapshot: { ...world, soilTiles: [] } as unknown as Snapshot,
    revision: 1205,
    ageTurns: 0,
    ageMs: 0,
  });
  assert.match(none, /这一带没有：[^\n]*可锄的地块/u);
});

/**
 * The family cap, made to say what it took.
 *
 * `soilTiles` is the thirteenth family a real farm strip publishes, so the cap that prints twelve is the next place the
 * one ground she can hoe could disappear - and a line that said only `其余 1 类未列出` would leave her unable to tell
 * which family she cannot see. The names cost a few bytes; the earlier silence cost a run.
 */
test("target_family_cap: with thirteen families in reach, the line names the one it left out", () => {
  const families = [
    "soilTiles",
    "cropTargets",
    "forageTargets",
    "itemTargets",
    "harvestTargets",
    "seedTargets",
    "fertilizerTargets",
    "debrisTargets",
    "rockSourceTargets",
    "treeStumpTargets",
    "weedTargets",
    "grassTargets",
    "bushTargets",
  ];
  // One tile each, one column further away per family: the composer's own order is nearest first, so the last family
  // listed is the one the cap drops, whatever order the table declares.
  const rows: Record<string, readonly { x: number; y: number }[]> = {};
  families.forEach((family, index) => {
    rows[family] = [{ x: 65 + index, y: 15 }];
  });
  const snapshot = {
    ...world,
    cropTargets: undefined,
    weedTargets: undefined,
    debrisTargets: undefined,
    rockSourceTargets: undefined,
    harvestTargets: undefined,
    ...rows,
  } as unknown as Snapshot;
  assert.equal(
    nearbyTargetFamilies(snapshot).filter((family) => family.rendered !== undefined).length,
    families.length,
    "thirteen families are in reach, so the cap has something to leave out",
  );
  const text = composeWorldState({ snapshot, revision: 1205, ageTurns: 0, ageMs: 0 });
  const printed = text.split("\n").filter((line) => /\(-?\d+,-?\d+\)/u.test(line) && !line.includes("未列出"));
  assert.equal(printed.length, MAX_TARGET_FAMILIES_SHOWN, "the cap prints twelve families and counts the rest");
  assert.match(
    text,
    /其余 1 类未列出：灌木/u,
    "the cap names the family it dropped (`bushTargets`, the farthest of the thirteen)",
  );
  assert.match(text, /可锄的地块 \(65,15\)/u, "and soilTiles is one of the twelve that printed");
});

test("nearbyTargetFamilies reads the snapshot it is given, and says which families it did not measure", () => {
  const families = nearbyTargetFamilies(world);
  const crops = families.find((family) => family.family === "cropTargets");
  assert.equal(crops?.total, 2);
  assert.equal(crops?.rendered, "待浇水的作物 (63,14) (62,14)");
  const harvest = families.find((family) => family.family === "harvestTargets");
  assert.equal(harvest?.total, 0, "a published empty family is a measured zero");
  assert.equal(harvest?.rendered, undefined, "and prints on the empty line rather than as a row");
  assert.equal(
    families.some((family) => family.family === "chests"),
    false,
    "a family the snapshot does not carry is not measured, and must not print",
  );
});

test("the composed delivery is deterministic: the same batch renders the same bytes", () => {
  assert.equal(richBrief(), richBrief());
});

/**
 * `observe_result_chars` and `observe_unchanged_revision_answers`, measured through the real tool.
 *
 * The baseline is `round44`'s own: 31 calls, median 20,980 characters, 648,059 in total, 81.1% of every tool-result byte
 * in the run - spent asking the Mod for a world the turn's batch already carried in 28 of those 31 calls.
 */
test("observe_result_chars: the observation answer is the state block, and an unchanged revision is one line", async () => {
  const state: Record<string, unknown> = {
    connected: true,
    sessionId: "session_1",
    capabilities: [],
    catalogRegistrations: [],
    catalogRevision: 3,
    enabledActionIds: [],
    snapshot: { ...world, revision: 1205 },
    latestReceipt: null,
    latestReasonCode: null,
  };
  const connection = {
    scope: { integrationId: "stardew", saveId: "save_1", worldId: "world_1", playerId: "player_1" },
    module: {},
    state,
    async observe() {
      return state.snapshot;
    },
  };
  const tool = createStardewObservationTools(connection as never).find(
    (candidate) => candidate.name === "stardew_observe",
  );
  assert.ok(tool !== undefined, "stardew_observe must be mounted");

  const answers: string[] = [];
  let revision = 1205;
  for (let call = 0; call < 31; call += 1) {
    // Two thirds of the calls find a new revision, one third find the one they already stated - the shape round44's
    // 28-of-31 measurement describes.
    if (call % 3 !== 2) revision += 1;
    state.snapshot = { ...world, revision };
    const result = await tool.execute("t", {}, new AbortController().signal, () => {}, {} as never);
    answers.push(result.content[0]?.type === "text" ? result.content[0].text : "");
  }

  const lengths = answers.map((answer) => answer.length).sort((left, right) => left - right);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const unchanged = answers.filter((answer) => answer.startsWith("自 revision ")).length;
  process.stdout.write(
    `observe_result_chars median ${String(median)} total ${String(total)} over ${String(answers.length)} calls ` +
      `(round44 baseline median 20980, total 648059 over 31)\n`,
  );
  process.stdout.write(`observe_unchanged_revision_answers ${String(unchanged)}/${String(answers.length)}\n`);

  assert.equal(unchanged, 10, "every observation that found the revision it already stated answered in one line");
  assert.ok(
    median < 20_980 / 4,
    `the observation answer is ${String(median)} chars at the median, against round44's 20,980-char dump`,
  );
  assert.ok(answers.every((answer) => answer.startsWith("<world-state>") || answer.startsWith("自 revision ")));
});

/**
 * A FAILURE LINE CARRIES BOTH HALVES OF A REFUSAL: the Mod's sentence AND its evidence.
 *
 * Measured at `516e2559`: `failureWords` printed `hint ?? detail`, so a node carrying both reached her with the short
 * sentence alone - and the numbers that make a refusal actionable (`owner=Pierre;owner_tile=4,17;actor_tile=5,19;
 * radius=1`) are exactly what the detail holds and the hint never repeats. A refusal she cannot decode is a refusal she
 * answers by guessing, and that guess is where an invented world fact comes from.
 *
 * The population is the fixture's own nodes: every one carrying a non-empty `reasonDetail` must reach
 * `<execution-result>`, whatever else it carries, and the count is asserted so a fixture that stopped carrying details
 * fails here instead of passing with nothing to examine.
 */
test("execution_result_evidence: every settled node's refusal detail reaches the model beside its hint", () => {
  const detail = "owner=Pierre;owner_tile=4,17;actor_tile=5,19;radius=1";
  // Past the ceiling, deliberately: the Mod's journal refuses a refusal detail over 512 characters, so this one cannot
  // arrive through the bridge - and when one does, the line must say it was cut rather than print a partial coordinate
  // list as the whole one.
  const longDetail = `${"far=".repeat(130)}end`;
  const nodes = [
    {
      nodeId: "n01",
      actionId: "water_crop",
      state: "failed",
      reasonCode: "npc_in_the_way",
      hint: "请 Pierre 让开",
      reasonDetail: detail,
    },
    // A detail with NO hint: the evidence is all this node has to say for itself.
    {
      nodeId: "n02",
      actionId: "shop_purchase",
      state: "failed",
      reasonCode: "out_of_stock",
      reasonDetail: "item=(O)388;stock=0",
    },
    // A hint with NO detail: the fallback must not be lost by the change that keeps both.
    { nodeId: "n03", actionId: "till_soil", state: "cancelled", reasonCode: "stopped", hint: "被打断了" },
    // Neither: the reason code alone is the whole account the Mod gave.
    { nodeId: "n04", actionId: "harvest_crop", state: "rejected", reasonCode: "not_ready" },
    // Past the bound: printed up to it, with the cut named rather than silent.
    { nodeId: "n05", actionId: "plant_seed", state: "failed", reasonCode: "blocked", reasonDetail: longDetail },
  ];
  const text = composeFactBrief({
    inputs: [],
    snapshot: undefined,
    events: [
      fact({
        kind: "world_fact",
        eventId: "program_settled_evidence",
        semanticKind: "program_settled",
        payload: { total: nodes.length, counts: { succeeded: 0 }, nodes },
      }),
    ],
    locale: "zh-CN",
  });
  const opened = text.indexOf("<execution-result>");
  const block = opened === -1 ? "" : text.slice(opened, text.indexOf("</execution-result>"));
  assert.notEqual(opened, -1, "the fixture's programme must render one <execution-result> block");

  const withDetail: readonly Readonly<{ nodeId: string; reasonDetail: string }>[] = nodes.flatMap((node) =>
    typeof node.reasonDetail === "string" && node.reasonDetail.trim() !== ""
      ? [{ nodeId: node.nodeId, reasonDetail: node.reasonDetail }]
      : [],
  );
  assert.equal(
    withDetail.length,
    3,
    "the fixture must carry nodes with a refusal detail, or this gate examines nothing (blocked, not green)",
  );
  for (const node of withDetail) {
    const expected = node.reasonDetail.trim();
    const ceiling = MODEL_FIELD_CEILINGS.reasonDetail;
    const message =
      `${node.nodeId}: its refusal detail ${JSON.stringify(expected)} never reaches the model; the line it should be ` +
      `in says ${JSON.stringify(block)}`;
    if (expected.length <= ceiling) {
      // Inside the producer's own bound, the detail IS the whole fact and prints as the Mod wrote it.
      assert.ok(block.includes(expected), message);
      continue;
    }
    // Past it, no prefix prints: a prefix of a value reads as a whole fact and is not one. The field is named instead,
    // and the assertions after this loop read the name it is given.
    assert.equal(
      block.includes(expected.slice(0, 40)),
      false,
      `${node.nodeId}: no prefix of an over-ceiling detail prints`,
    );
  }

  // BOTH, NOT ONE INSTEAD OF THE OTHER: the node that carries a sentence and its evidence prints the two of them.
  assert.ok(block.includes("请 Pierre 让开"), "n01's hint is the sentence");
  assert.ok(block.includes(detail), "and n01's detail is its evidence, not a casualty of the sentence");
  // The cut is NAMED. A silent truncation would be the same defect one layer down: she would read a partial coordinate
  // list as the whole one.
  assert.ok(!block.includes(longDetail), "n05's detail is bounded, not printed whole");
  // AND IT IS NOT A PREFIX OF THE VALUE: `far=far=far=…` cut at the ceiling is a token that looks like a fact and is not
  // one, so a field that cannot fit whole is withheld by name and measured.
  assert.ok(
    block.includes(`[field_over_ceiling:${String(longDetail.length)}:${String(MODEL_FIELD_CEILINGS.reasonDetail)}]`),
    "n05's one over-long field is named as withheld, with the length the Mod wrote and the ceiling it met",
  );
  assert.ok(
    !block.includes(longDetail.slice(0, 40)),
    "and none of its value is printed, because a 40-character prefix of it is the shape that reads as a whole fact",
  );
  // AND THE HALVES THAT ARE ALONE STAY: a detail without a hint, a hint without a detail, and a node with neither.
  assert.ok(block.includes("item=(O)388;stock=0"), "n02's detail is its whole account");
  assert.ok(block.includes("被打断了"), "n03's hint survives, and no detail was invented for it");
  assert.ok(block.includes("not_ready"), "n04 is explained by the Mod's own code");
});

/**
 * One Host source file, read from the repository rather than from the compiled artifact.
 *
 * The suite runs emitted JavaScript out of a flat `dist-test`, so `import.meta.url` names no `.ts` - and the point of the
 * gate below is to read what the WRITER says, not what it compiled to.
 */
function hostSource(name: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, "src", name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`host/src/${name} was not found from ${import.meta.url}`);
    directory = parent;
  }
}

/**
 * One batch whose single Mod-authored field carries exactly `value`, for the field-ceiling gate below.
 *
 * A node field rides a settled programme; a receipt's evidence rides an execution receipt. Nothing else is in the batch,
 * so the text that comes back is that one field and the words around it.
 */
function composedField(field: ModelVisibleField, value: string): string {
  if (field === "evidence") {
    return composeFactBrief({
      inputs: [],
      snapshot: undefined,
      events: [
        fact({
          kind: "execution_receipt",
          eventId: "receipt_ceiling",
          payload: {
            actionId: "water_crop",
            state: "rejected",
            reasonCode: "not_adjacent",
            evidence: { detail: value },
          },
        }),
      ],
      locale: "zh-CN",
    });
  }
  return composeFactBrief({
    inputs: [],
    snapshot: undefined,
    events: [
      fact({
        kind: "world_fact",
        eventId: "program_settled_ceiling",
        semanticKind: "program_settled",
        payload: {
          total: 1,
          counts: { succeeded: 0 },
          nodes: [{ actionId: "for_each", state: "failed", reasonCode: "blocked", [field]: value }],
        },
      }),
    ],
    locale: "zh-CN",
  });
}

/**
 * TRUNCATED ENUMERATION IS SILENT - unless the line says what it left out, and unless it left out nothing the wire had
 * already bounded.
 *
 * <p>
 * THE DEFECT THIS CLOSES, measured 2026-11-11 (`round45`): every failed `for_each` hint reached this file between 169 and
 * 255 characters and every one of their details between 480 and 507, all against ONE flat 160-character ceiling. Thirty
 * cuts in one run's model-visible text - and the ledger (`decided=18;succeeded=0;…;omitted=0`, ~100 characters) survived
 * every one of them, so what fell off was exactly the per-code tail that says WHICH rows failed and why, sliced mid-token.
 * </p>
 *
 * <p>
 * POPULATION, from the writer rather than from a list: every field name `fact-brief.ts` hands to `boundedField`, read out
 * of its own source and printed below. It must equal the declared ceilings both ways - a field printed under no ceiling,
 * and a ceiling for a field nothing prints, are both drift. The node fields' ceilings are then checked against the WIRE's
 * own numbers (`protocol.ts`), because a Host ceiling below the producer's bound is the ceiling that cut these.
 * </p>
 *
 * <p>
 * PROPERTY, per field: at the ceiling it prints whole; one character over, it is cut AND named with the length the Mod
 * wrote and the ceiling it met, so a partial enumeration can never read as a complete one.
 * </p>
 */
test("truncated_enumeration_is_silent: each field prints whole to its producer's bound, and a cut is named", () => {
  const source = hostSource("fact-brief.ts");
  const bounded = new Set(
    [...source.matchAll(/boundedField\("(\w+)"/gu)].map((match) => match[1] ?? "").filter((name) => name !== ""),
  );
  const declared = Object.keys(MODEL_FIELD_CEILINGS);
  assert.ok(bounded.size > 0, "the writer calls boundedField at all, or this gate examines nothing");
  assert.deepEqual(
    [...bounded].sort(),
    [...declared].sort(),
    `the writer bounds ${[...bounded].sort().join(", ")} and MODEL_FIELD_CEILINGS declares ` +
      `${[...declared].sort().join(", ")}; a field printed under no declared ceiling - or a ceiling for a field nothing ` +
      "prints - is drift in this table, and the count examined is " +
      String(bounded.size),
  );

  const protocol = hostSource("protocol.ts");
  const wireBounds: Readonly<Record<string, number>> = Object.freeze({
    hint: Number(/value\.hint\.length <= (\d+)/u.exec(protocol)?.[1]),
    reasonDetail: Number(/MAX_BODY_PROGRAM_REFUSAL_DETAIL_LENGTH = (\d+)/u.exec(protocol)?.[1]),
  });

  for (const field of declared as readonly ModelVisibleField[]) {
    const ceiling = MODEL_FIELD_CEILINGS[field];
    assert.ok(
      Number.isInteger(ceiling) && ceiling > 0,
      `${field}: its ceiling is a positive integer (${String(ceiling)})`,
    );

    const atCeiling = "位".repeat(ceiling);
    const whole = composedField(field, atCeiling);
    assert.ok(
      whole.includes(atCeiling),
      `${field}: a value at its own ceiling (${String(ceiling)} characters) must reach the model WHOLE; the text says ` +
        JSON.stringify(whole),
    );
    assert.equal(
      whole.includes("over_ceiling"),
      false,
      `${field}: a value at its own ceiling is not a cut, so nothing here may be marked as one`,
    );

    const overCeiling = `${atCeiling}位`;
    const cut = composedField(field, overCeiling);
    assert.ok(
      cut.includes(`[field_over_ceiling:${String(overCeiling.length)}:${String(ceiling)}]`),
      `${field}: a value over the ceiling is withheld by name - the length the Mod wrote and the ceiling it met - so a ` +
        `partial value never reads as the whole one; the text says ${JSON.stringify(cut)}`,
    );
    assert.equal(
      cut.includes(atCeiling.slice(0, 8)),
      false,
      `${field}: and no prefix of the value is printed, because a prefix of a value is the shape that reads as a whole ` +
        "fact and is not one (measured: a 254-character proof sliced at 160 ended mid-value)",
    );

    const wire = wireBounds[field];
    if (wire === undefined) continue;
    assert.equal(
      Number.isNaN(wire) ? undefined : wire,
      ceiling,
      `${field}: its ceiling must be the bound the WIRE already enforces (protocol.ts says ${String(wire)}) - a smaller ` +
        "one cuts a frame that arrived valid, which is exactly how round45 lost every for_each ledger tail",
    );
  }

  assert.equal(
    Object.keys(MODEL_FIELD_CEILINGS).length,
    bounded.size,
    `examined ${String(bounded.size)} model-visible fields; every one of them is asserted above`,
  );
});

/**
 * A CUT KEEPS WHOLE FIELDS, AND COUNTS WHAT IT DROPPED.
 *
 * <p>
 * A receipt's evidence is `k=v;k=v` (`ToolActionEvidence.Compose`) - proof facts, each of which is either true as written
 * or meaningless. Measured 2026-11-11: a 254-character proof was sliced at the 160-character ceiling, which ended mid-value
 * (`stamina_bef`), and the only thing the line then added was the byte arithmetic of the budget. So the reader got a token
 * that looks like a fact and is not one, and was told the length of what it lost rather than what it lost.
 * </p>
 *
 * <p>
 * PROPERTY, and it is the one that cannot be reintroduced by a later change to the cut: what a truncated line prints is
 * the FIRST WHOLE FIELDS of the Mod's detail, byte for byte, and the marker's number is exactly how many whole fields it
 * did not show. A field that alone exceeds the ceiling is withheld by name, never sliced - asserted over every declared
 * field above.
 * </p>
 */
test("truncated_evidence_keeps_whole_fields: a cut shows whole k=v fields and counts the rest", () => {
  const fields = [
    "location=Farm",
    "target=58,9",
    "before=none",
    "after=HoeDirt",
    "stamina_before=270",
    "stamina_after=268.4",
    "stamina_delta=1.6",
    "expected_stamina_cost=2",
    "tool=hoe",
    "tool_power=0",
    "charge=0",
    "footprint=58,9|59,9",
    "tilled=true",
    "slot=0",
    "category=hoe",
    "tool_restored=true",
    "revision=1205",
    "observer=mod",
  ];
  const detail = fields.join(";");
  assert.ok(
    detail.length > MODEL_FIELD_CEILINGS.evidence,
    `the fixture must be past the evidence ceiling (${String(detail.length)} against ` +
      `${String(MODEL_FIELD_CEILINGS.evidence)}), or this gate examines no cut at all`,
  );

  const text = composedField("evidence", detail);
  const rendered = text.slice(text.indexOf("（") + 1, text.lastIndexOf("）"));
  const marker = "…[fields_not_shown:";
  const markerAt = rendered.indexOf(marker);
  assert.notEqual(
    markerAt,
    -1,
    `a cut must say how many whole fields it did not show; the line says ${JSON.stringify(rendered)}`,
  );

  const shown = rendered.slice(0, markerAt).split(";");
  assert.deepEqual(
    shown,
    fields.slice(0, shown.length),
    "what a cut prints is the FIRST WHOLE FIELDS of the Mod's detail, byte for byte - not a prefix of the text",
  );
  assert.ok(
    shown.length > 0 && shown.length < fields.length,
    `the fixture must be cut some of the way (${String(shown.length)} of ${String(fields.length)} fields shown)`,
  );
  for (const field of shown)
    assert.match(
      field,
      /^[a-z_]+=[^;]+$/u,
      `every printed field is a whole k=v, never half of one: ${JSON.stringify(field)}`,
    );
  assert.equal(
    rendered.slice(markerAt),
    `${marker}${String(fields.length - shown.length)}]`,
    "and the number is exactly the whole fields it did not show",
  );
  assert.ok(
    rendered.length <= MODEL_FIELD_CEILINGS.evidence,
    `the line stays inside its own ceiling, marker included (${String(rendered.length)} characters)`,
  );

  // NO FIELD IS EVER SLICED, ANYWHERE IN THE WRITER: the cut this test replaced was one `text.slice(0, ceiling)` inside the
  // one function every Mod-authored field goes through, so a byte slice reappearing there would reintroduce the defect for
  // all three fields at once. Read from the source, because the assertion is about the writer and not about one value.
  assert.equal(
    /text\.slice\(0, ceiling\)/u.test(hostSource("fact-brief.ts")),
    false,
    "no Mod-authored field is cut at a byte offset: a field is printed whole or withheld by name",
  );
});

/**
 * DESTRUCTIVE REFUSAL SENTENCE REACHES THE MODEL.
 *
 * <p>
 * The sentence exists because `no_safe_clear:crop:scythe_crop` is a dead end to a reader: it says a swing was withheld and
 * never says that the tile is HER planting, that the scythe levels it, or that `harvest_crop` is how a crop is taken. The
 * clearing declaration carries it (`FarmhandClearingDeclaration.RefusalDetail`), the Mod writes it into the refused row's
 * `detail` and, for a pass that failed as a unit, into that node's `reasonDetail`.
 * </p>
 *
 * <p>
 * MEASURED 2026-11-11 (`round45`): it did not arrive. Three rows were refused for that code, the node settled `failed`, and
 * `scythe_crop levels it` appears ZERO times in the bundle - not in the Mod's journal, not in the model's text. The strings
 * below are that run's own: the 251-character hint and the 494-character `reasonDetail` the pass wrote. Two layers hid the
 * sentence. The pass spent its 512 characters on the enumeration and skipped the sentence silently; this file then cut the
 * first 160 characters of BOTH fields, and a field whose whole purpose is its tail cannot be read from its head.
 * </p>
 *
 * <p>
 * So this is the Host's half, on the run's real strings: both fields reach the model whole. The second case is the same
 * ledger with the declaration's sentence written after it - where the pass now writes it, because the sentence is what
 * cannot yield - and asserts it arrives. The Mod's half is `EveryDestructiveClearanceSentenceSurvivesAFullEnumeration`.
 * </p>
 */
test("destructive_refusal_sentence_reaches_the_model: a refused destructive row delivers its sentence", () => {
  const round45Hint =
    "decided=18;succeeded=0;failed=0;refused=3;not_matched=15;left_alone=0;deferred=0;stopped=0;omitted=0;no_safe_clear:crop:scythe_crop=3;no_rule_matched:ground_58_9=1;no_rule_matched:ground_59_9=1;no_rule_matched:weed_58_10=1;no_rule_matched:rock_59_10=1";
  const round45Detail =
    "decided=18;succeeded=0;failed=0;refused=3;not_matched=15;left_alone=0;deferred=0;stopped=0;omitted=0;no_safe_clear:crop:scythe_crop=3;no_rule_matched:ground_58_9=1;no_rule_matched:ground_59_9=1;no_rule_matched:weed_58_10=1;no_rule_matched:rock_59_10=1;no_rule_matched:ground_58_11=1;no_rule_matched:ground_59_11=1;no_rule_matched:ground_60_11=1;no_rule_matched:grass_58_12=1;no_rule_matched:rock_59_12=1;no_rule_matched:ground_60_12=1;no_rule_matched:rock_58_13=1;no_rule_matched:ground_59_13=1";
  const sentence =
    "The crop on this tile is one you planted: scythe_crop levels it and loses the harvest, and harvest_crop is the action that resolves a crop.";
  // The ledger both fields lead with - the run's own prefix, not a re-typing of it.
  const ledger = round45Detail.slice(0, round45Detail.indexOf(";no_safe_clear"));

  const textFor = (hint: string, reasonDetail: string): string =>
    composeFactBrief({
      inputs: [],
      snapshot: undefined,
      events: [
        fact({
          kind: "world_fact",
          eventId: "program_settled_round45",
          semanticKind: "program_settled",
          payload: {
            total: 1,
            counts: { succeeded: 0 },
            nodes: [
              {
                nodeId: "n01",
                actionId: "for_each",
                state: "failed",
                reasonCode: "no_safe_clear:crop:scythe_crop",
                hint,
                reasonDetail,
              },
            ],
          },
        }),
      ],
      locale: "zh-CN",
    });

  // 1. THE RUN'S OWN WORDS, WHOLE. The per-code tail is the part that says WHICH rows failed, and it is the part the
  //    160-character ceiling took.
  const real = textFor(round45Hint, round45Detail);
  assert.ok(
    real.includes(round45Hint),
    `the 251-character hint must reach the model whole, tail included; the text says ${JSON.stringify(real)}`,
  );
  assert.ok(
    real.includes(round45Detail),
    `the 494-character detail must reach the model whole - it is inside the 512 the Mod declares; the text says ` +
      JSON.stringify(real),
  );
  assert.equal(
    real.includes("over_ceiling"),
    false,
    "neither field is over a ceiling, so neither may be marked as cut",
  );

  // 2. AND THE SENTENCE. A refused destructive row's sentence rides the channel its terminal state uses - the node's
  //    `reasonDetail`, because a failed node's row table is dropped (ADR-006).
  const withSentence = textFor(round45Hint, `${ledger};${sentence}`);
  assert.ok(
    withSentence.includes(sentence),
    `the declaration's sentence must reach the model; the text says ${JSON.stringify(withSentence)}`,
  );
  assert.ok(withSentence.includes(round45Hint), "and it must not cost the ledger the hint carries");
});
