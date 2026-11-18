import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { footprintTiles, TOOL_FOOTPRINT_TILES_BY_CHARGE } from "./body-program-packing.js";
import { type CompiledPlan, compilePlanScript, planActionsFromRegistrations } from "./body-program-script.js";
import type { ActionRegistration, Snapshot } from "./protocol.js";

/**
 * GATE: A BATCH OF INDEPENDENT STEPS IS EMITTED AS A PATH, NOT IN THE ORDER THE SCRIPT WROTE THEM.
 *
 * <p>
 * WHY (measured, `round66`). The compiler emitted one node per builder call, in call order, and the Program's own
 * ordering edge carried that order to the game. Nothing looked at WHERE the steps are, so a script that named three crops
 * in the order it happened to read them walked the field three times: `_multiday_routine-round66-live-runner.log` records
 * 37 positioned events and **647 tiles walked (Manhattan) in 1230 s** - 17 world-changing actions at **38 tiles per
 * action** - and the packing pass's own docblock states the stake: walking is 93.6% of a node's time
 * (`body-program-packing.ts`: 76,473 ms of 81,700 ms over 18 nodes).
 * </p>
 * <p>
 * THE EXACT CASE THIS GATE READS, because it is in the log rather than in a model's opinion. The one submitted program of
 * that run carrying crops is `plan_4_bba49665079fd0dd` (`programSubmissions`, receipt `accepted`): three `harvest_crop`
 * nodes at `(60,10)`, `(58,14)`, `(60,9)`, in that order, compiled against snapshot revision 4 while the body stood at
 * `61,11` (the run's own `tool_approach_completed` receipt for the first of the three: `tile=61,11;arrival=exact`).
 * Measured between the tiles the plan NAMES, that is 6+7 = 13 tiles of walk and 1+7 = 8 at best; measured from the tile
 * she STANDS on, which is where this gate measures from, it is 2+6+7 = 15 and 2+1+7 = 10. The surplus is 5 tiles either
 * way - the two readings differ only in the leg INTO the batch, and that leg is exactly what a nearest-first order also
 * shortens, so including it is the reading that cannot flatter the order. Five tiles of pure zigzag - it walks out to the
 * isolated crop and back past the middle one - on a program whose whole content was three steps.
 * </p>
 * <p>
 * THE UNIT. A batch is a maximal run of CONSECUTIVE steps of ONE action, each naming a DIFFERENT piece of world, with no
 * edge between them (the compiler's own consumer rule: "a step on a DIFFERENT tile consumes nothing of the earlier one",
 * `emitPlanNode`). The compiler emits such a batch in a PATH order - the shortest one it can compute - instead of the
 * order the callbacks arrived in. It is a compile-time optimisation and it is INVISIBLE to the author: the same nodes,
 * the same arguments, the same action ids, only the `orderedAfter` chain and the positions differ, so a `for` loop she
 * writes reads the same and walks less.
 * </p>
 * <p>
 * HER TILE IS KNOWN AT COMPILE TIME, so the path starts where she actually stands. `Snapshot.tile` is a REQUIRED field of
 * the snapshot contract (`protocol.ts`, `tile: Readonly<{ x: number; y: number }>` - not one of the `?` members the Mod
 * may omit), and `compilePlanScript` refuses any snapshot `isUsableSnapshot` rejects. Nothing here has to fall back to
 * "start from the first tile the script named", and the batch is measured from `snapshot.tile` rather than from the first
 * tile in the run.
 * </p>
 * <p>
 * THE METRIC, stated because it is the one place this gate could overclaim. Distances are Manhattan between the TILES A
 * PLAN NAMES. The body does not stand on a crop: the Mod picks the adjacent stand tile per target (`stand_at=61,11` for
 * the crop at `60,10`), so the named-tile length is a proxy for the walk, not the walk itself. It is the right proxy for
 * the decision the compiler makes - the order of the steps - and both sides of every comparison below are measured the
 * same way, so a surplus is a surplus in the order and not in the metric.
 * </p>
 * <p>
 * WHAT IS NOT CHECKED, named rather than implied: batches past {@link ENUMERABLE_BATCH_TILES} steps. The shortest order is
 * a travelling-salesman path, so this gate ENUMERATES every order up to that size and reports the larger batches as
 * `not measured` instead of comparing them against a bound it did not compute. A batch of 64 tilled tiles is ordinary in
 * this product and no gate here claims to have measured its optimum.
 * </p>
 */

/**
 * The published surface is the authority for the builder's vocabulary and for what a step ADDRESSES, so the suites feed
 * the generator from the Mod-owned artifact instead of hand-writing the actions they expect.
 */
const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);

type SurfaceAction = Readonly<{
  actionId: string;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
  targetFamily?: string;
}>;

const SURFACE = (JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { actions: readonly SurfaceAction[] }).actions;

const REGISTRATIONS: readonly ActionRegistration[] = SURFACE.map((action) =>
  Object.freeze({
    actionId: action.actionId,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    ...(action.argumentSchema === undefined
      ? {}
      : {
          descriptor: {
            argumentSchema: action.argumentSchema,
            outputFacts: action.outputFacts ?? {},
            ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
            ...(action.targetFamily === undefined ? {} : { targetFamily: action.targetFamily }),
          },
        }),
  }),
);

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

/**
 * The actions whose coordinates name a PIECE OF WORLD rather than a place to stand, read from the surface's own
 * `targetFamily`. A batch may only be reordered among members of this set: two `move_to_tile` steps are not interchangeable
 * (the last one decides where she ends up), and the surface says which is which.
 */
const TILE_ADDRESSED: ReadonlySet<string> = new Set(
  SURFACE.filter((action) => action.targetFamily !== undefined).map((action) => action.actionId),
);

type Tile = Readonly<{ x: number; y: number }>;
type PlanNode = Extract<CompiledPlan, { status: "compiled" }>["program"]["nodes"][number];

const BASE_SNAPSHOT: Snapshot = {
  revision: 4,
  location: "Farm",
  tile: { x: 61, y: 11 },
  stamina: 100,
  health: 100,
  actionable: true,
  exhausted: false,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
};

function compile(script: string, overrides: Partial<Snapshot> = {}): CompiledPlan {
  return compilePlanScript({ script }, { snapshot: { ...BASE_SNAPSHOT, ...overrides } as Snapshot, actions: ACTIONS });
}

function nodesOf(result: CompiledPlan): readonly PlanNode[] {
  if (result.status === "refused") throw new Error(`expected a plan, received ${result.reasonCode}`);
  return result.program.nodes;
}

/** The nodes the compiler wrote into the program, and their population, read through the plan they stand beside. */
function insertionsOf(plan: CompiledPlan): Readonly<{ inserted: readonly string[]; count: number }> {
  if (plan.status === "refused") throw new Error(`expected a plan beside the insertions, received ${plan.reasonCode}`);
  return { inserted: plan.inserted, count: plan.insertedCount };
}

/** The ids of the nodes the compiler minted, in program order: the population an insertion reading joins on. */
function insertedNodeIdsOf(plan: CompiledPlan): readonly string[] {
  if (plan.status === "refused")
    throw new Error(`expected a plan beside its inserted node ids, received ${plan.reasonCode}`);
  return plan.insertedNodeIds;
}

/** One node's tile: the integer `x`/`y` every positioned action declares, or undefined for a step that names none. */
function tileOf(node: PlanNode): Tile | undefined {
  const coordinate = (name: string): number | undefined => {
    const declared = (node.arguments as Readonly<Record<string, { canonicalValue?: unknown }>>)[name];
    if (declared === undefined || typeof declared.canonicalValue !== "string") return undefined;
    const value = Number.parseInt(declared.canonicalValue, 10);
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const x = coordinate("x");
  const y = coordinate("y");
  return x === undefined || y === undefined ? undefined : { x, y };
}

const walk = (from: Tile, to: Tile): number => Math.abs(from.x - to.x) + Math.abs(from.y - to.y);

/** The Manhattan length of walking the given tiles in the given order, starting where the body stands. */
function walkLength(tiles: readonly Tile[], start: Tile): number {
  let length = 0;
  let from = start;
  for (const tile of tiles) {
    length += walk(from, tile);
    from = tile;
  }
  return length;
}

/** How many steps of one action this gate enumerates the orders of; past it a batch is reported, never passed. */
const ENUMERABLE_BATCH_TILES = 8;

/**
 * The shortest visiting order's length, BY ENUMERATING EVERY ORDER - a second method, not a second copy of the compiler's
 * one. `undefined` past {@link ENUMERABLE_BATCH_TILES}, which the caller must report as not measured.
 */
function shortestWalk(tiles: readonly Tile[], start: Tile): number | undefined {
  if (tiles.length > ENUMERABLE_BATCH_TILES) return undefined;
  let best = Number.POSITIVE_INFINITY;
  const visit = (remaining: readonly Tile[], from: Tile, length: number): void => {
    if (length >= best) return;
    if (remaining.length === 0) {
      best = length;
      return;
    }
    remaining.forEach((tile, index) => {
      const next = remaining.filter((_, other) => other !== index);
      visit(next, tile, length + walk(from, tile));
    });
  };
  visit(tiles, start, 0);
  return best;
}

/**
 * The batches a PROGRAM contains: maximal runs of consecutive steps of one action on different pieces of world, with no
 * edge among them. Read from the program itself, so the reading is of what the Mod would receive rather than of what the
 * compiler meant.
 */
function batchRuns(nodes: readonly PlanNode[]): readonly Readonly<{ from: number; to: number }>[] {
  const runs: Readonly<{ from: number; to: number }>[] = [];
  let open = -1;
  const close = (end: number): void => {
    if (open >= 0 && end - open > 1) runs.push({ from: open, to: end });
    open = -1;
  };
  nodes.forEach((node, index) => {
    const tile = TILE_ADDRESSED.has(node.actionId) ? tileOf(node) : undefined;
    if (tile === undefined) {
      close(index);
      return;
    }
    if (open >= 0) {
      const members = nodes.slice(open, index);
      const continues =
        members[0]!.actionId === node.actionId &&
        members.every((member) => {
          const memberTile = tileOf(member)!;
          return memberTile.x !== tile.x || memberTile.y !== tile.y;
        }) &&
        !members.some((member) => node.dependsOn.includes(member.nodeId));
      if (!continues) close(index);
    }
    if (open < 0) open = index;
  });
  close(nodes.length);
  return runs;
}

/**
 * One batch as the program emitted it, against the shortest order the same tiles allow.
 *
 * `start` is where the walk to the batch's first tile begins: the last positioned step before the batch, else the tile the
 * body stood on when the plan was compiled. Both numbers include the leg INTO the batch, so an order that is longer is
 * longer by its own choice and not by where it began.
 */
type BatchReading = Readonly<{
  actionId: string;
  nodeIds: readonly string[];
  emitted: number;
  shortest: number | undefined;
  start: Tile;
}>;

function batchReadings(nodes: readonly PlanNode[], actor: Tile): readonly BatchReading[] {
  return batchRuns(nodes).map((run) => {
    const members = nodes.slice(run.from, run.to);
    const tiles = members.map((member) => tileOf(member)!);
    let start = actor;
    for (let index = run.from - 1; index >= 0; index -= 1) {
      const standing = tileOf(nodes[index]!);
      if (standing !== undefined) {
        start = standing;
        break;
      }
    }
    return {
      actionId: members[0]!.actionId,
      nodeIds: members.map((member) => member.nodeId),
      emitted: walkLength(tiles, start),
      shortest: shortestWalk(tiles, start),
      start,
    };
  });
}

/**
 * The finding a batch is answered with when the program walked further than the shortest order allows, or `null` when the
 * order IS the shortest one. One sentence, naming the batch, both lengths and the start it was measured from: a gate that
 * says "expected 9, got 13" without the batch would send the next reader to the wrong program.
 */
function surplusFinding(reading: BatchReading): string | null {
  if (reading.shortest === undefined)
    return `not_measured:${reading.actionId}:${reading.nodeIds.length}_tiles:path=${reading.emitted}`;
  if (reading.emitted <= reading.shortest) return null;
  return [
    `a_batch_is_emitted_in_script_order:${reading.actionId}`,
    `batch=[${reading.nodeIds.join(",")}]`,
    `from=${reading.start.x},${reading.start.y}`,
    `path=${reading.shortest}`,
    `emitted=${reading.emitted}`,
    `surplus=${reading.emitted - reading.shortest}`,
  ].join(":");
}

/**
 * One script, the tile the body stood on, and the steps it wrote in the order it wrote them.
 *
 * `wrote` is the fixture's own statement of the script's content and is cross-checked against the program (`a_path_order_
 * changes_no_step`), so a fixture that drifts from the script it quotes fails by name rather than quietly measuring
 * something else.
 */
type PathFixture = Readonly<{
  name: string;
  actor: Tile;
  script: string;
  enabled: readonly string[];
  /** `actionId@x,y` for every step the script wrote, in the order it wrote them. */
  wrote: readonly string[];
  /** `actionId@x,y` for every node the compiler writes itself into this program, if any. */
  inserted?: readonly string[];
}>;

/**
 * The real crop batch of `round66`, verbatim: `plan_4_bba49665079fd0dd`'s three `harvest_crop` nodes, in the order the plan
 * carried them, with the arguments and target ids the run's own submission shows.
 */
const ROUND66_CROPS = [
  { tile: { x: 60, y: 10 }, item: "(O)190", target: "crop_72f6ce55311cf7c3" },
  { tile: { x: 58, y: 14 }, item: "(O)190", target: "crop_5481d34df6f60c18" },
  { tile: { x: 60, y: 9 }, item: "(O)190", target: "crop_2a7e1fd59d0206a0" },
] as const;

const harvestCall = (crop: Readonly<{ tile: Tile; item: string; target: string }>): string =>
  `builder.harvest_crop({ x: ${crop.tile.x}, y: ${crop.tile.y}, expectedQualifiedItemId: "${crop.item}", expectedTargetId: "${crop.target}" });`;

/** The brief's own cluster: `x 53-63, y 30-35`, seven pickups, written as the zigzag it was. */
const CLUSTER_PICKUPS = [
  { tile: { x: 53, y: 30 }, target: "forage_53_30" },
  { tile: { x: 63, y: 30 }, target: "forage_63_30" },
  { tile: { x: 54, y: 35 }, target: "forage_54_35" },
  { tile: { x: 62, y: 34 }, target: "forage_62_34" },
  { tile: { x: 56, y: 31 }, target: "forage_56_31" },
  { tile: { x: 60, y: 35 }, target: "forage_60_35" },
  { tile: { x: 58, y: 32 }, target: "forage_58_32" },
] as const;

const pickupCall = (pickup: Readonly<{ tile: Tile; target: string }>): string =>
  `builder.pickup_forage({ x: ${pickup.tile.x}, y: ${pickup.tile.y}, expectedQualifiedItemId: "(O)18", expectedTargetId: "${pickup.target}" });`;

const tillCall = (tile: Tile): string => `builder.till_soil({ x: ${tile.x}, y: ${tile.y}, charge: 0 });`;

const key = (actionId: string, tile: Tile): string => `${actionId}@${tile.x},${tile.y}`;

const scriptOf = (calls: readonly string[]): string => calls.join("\n");

const FIXTURES: readonly PathFixture[] = [
  {
    name: "round66-crops",
    actor: { x: 61, y: 11 },
    script: scriptOf(ROUND66_CROPS.map(harvestCall)),
    enabled: ["harvest_crop"],
    wrote: ROUND66_CROPS.map((crop) => key("harvest_crop", crop.tile)),
  },
  {
    name: "cluster-pickups",
    actor: { x: 58, y: 33 },
    script: scriptOf(CLUSTER_PICKUPS.map(pickupCall)),
    enabled: ["pickup_forage"],
    wrote: CLUSTER_PICKUPS.map((pickup) => key("pickup_forage", pickup.tile)),
  },
  {
    // A row walked from her own end outward: already a path, and the case that says the compiler may leave a batch alone.
    name: "strip-ascending",
    actor: { x: 10, y: 18 },
    script: scriptOf([60, 61, 62, 63].map((x) => tillCall({ x, y: 18 }))),
    enabled: ["till_soil"],
    wrote: [60, 61, 62, 63].map((x) => key("till_soil", { x, y: 18 })),
  },
  {
    // The same three tiles written far-to-near: the script's order is 58 tiles, the shortest is 53.
    name: "corridor-reversed",
    actor: { x: 10, y: 18 },
    script: scriptOf([63, 60, 62].map((x) => tillCall({ x, y: 18 }))),
    enabled: ["till_soil"],
    wrote: [63, 60, 62].map((x) => key("till_soil", { x, y: 18 })),
  },
  {
    // The compiler writes a dismissal before the first crop (the talk left the body held); the batch is still a batch.
    name: "dismissal-then-crops",
    actor: { x: 58, y: 12 },
    script: `builder.talk_to_npc({ x: 58, y: 11, expectedTargetId: "npc_1" });\n${scriptOf(ROUND66_CROPS.map(harvestCall))}`,
    enabled: ["talk_to_npc", "harvest_crop"],
    wrote: [key("talk_to_npc", { x: 58, y: 11 }), ...ROUND66_CROPS.map((crop) => key("harvest_crop", crop.tile))],
    inserted: ["dismiss_modal@none"],
  },
];

/** Every program node as `actionId@x,y`, so a step that was lost, gained or moved is named rather than counted. */
const stepKeys = (nodes: readonly PlanNode[]): readonly string[] =>
  nodes.map((node) => {
    const tile = tileOf(node);
    return tile === undefined ? `${node.actionId}@none` : key(node.actionId, tile);
  });

const sorted = (entries: readonly string[]): readonly string[] => [...entries].sort();

/**
 * `a_batch_is_emitted_in_script_order:<action>` - the batch walked no further than the shortest order from her own tile.
 *
 * One assertion per batch, the population printed, and a batch too large to enumerate answered `not_measured` rather than
 * passed: `"0 violations"` without `"examined N"` is a gate agreeing with itself.
 */
test("a_batch_is_emitted_in_script_order:harvest_crop - every batch is emitted as a path, not in script order", () => {
  const readings: BatchReading[] = [];
  const findings: string[] = [];
  for (const fixture of FIXTURES) {
    const nodes = nodesOf(compile(fixture.script, { tile: fixture.actor, enabledActionIds: fixture.enabled }));
    const batches = batchReadings(nodes, fixture.actor);
    assert.ok(batches.length > 0, `${fixture.name}: the fixture carries a batch this gate can read`);
    for (const reading of batches) {
      readings.push(reading);
      const finding = surplusFinding(reading);
      if (finding !== null) findings.push(`${fixture.name}:${finding}`);
      console.log(
        [
          `a_batch_is_emitted_in_script_order:${reading.actionId}`,
          `${fixture.name}`,
          `batch=[${reading.nodeIds.join(",")}]`,
          `from=${reading.start.x},${reading.start.y}`,
          `path=${String(reading.shortest)}`,
          `emitted=${reading.emitted}`,
          `surplus=${reading.shortest === undefined ? "?" : reading.emitted - reading.shortest}`,
        ].join(" "),
      );
    }
  }
  const measured = readings.filter((reading) => reading.shortest !== undefined).length;
  console.log(
    `batches examined ${readings.length} (measured ${measured}, not_measured ${readings.length - measured}) over ${FIXTURES.length} scripts`,
  );
  assert.ok(readings.length > 0, "the population is empty: this gate examined nothing");
  assert.ok(measured > 0, "no batch was small enough to enumerate: the gate measured nothing");
  assert.deepEqual(findings, [], `batches emitted longer than the shortest order:\n${findings.join("\n")}`);
});

/**
 * `a_path_order_changes_no_step:<action>` - the reverse half, and the one that makes the first half safe to have.
 *
 * A reorder that drops a step, duplicates one, merges two or rewrites an argument is refused BY NAME here: the multiset of
 * `(actionId, tile)` a program carries must equal the multiset the script wrote plus exactly the nodes the compiler says it
 * inserted. `harvest_crop`'s arguments themselves are checked against the run's own submitted program, so "the same
 * arguments" is a fact about `round66` rather than a promise.
 */
test("a_path_order_changes_no_step:harvest_crop - a reorder keeps every step, its arguments and its count", () => {
  const findings: string[] = [];
  for (const fixture of FIXTURES) {
    const plan = compile(fixture.script, { tile: fixture.actor, enabledActionIds: fixture.enabled });
    const nodes = nodesOf(plan);
    const carried = sorted(stepKeys(nodes));
    const wrote = sorted([...fixture.wrote, ...(fixture.inserted ?? [])]);
    if (JSON.stringify(carried) !== JSON.stringify(wrote))
      findings.push(`${fixture.name}: carried=[${carried.join(",")}] wrote=[${wrote.join(",")}]`);
    // A batch's own members stay distinct nodes: a merge or a drop shows up as a shorter multiset above, a duplicate as a
    // repeated key, so the count is asserted from the fixture's own cards rather than from the compiler's account.
    // THE INSERTION ACCOUNT IS READ AGAINST THE PROGRAM IT IS BESIDE: `inserted=<action>;before=<id>` must name the node that
    // immediately follows the inserted one. A reorder renumbers the program and may move the step an insertion was written
    // before, so an answer that carried the id it captured at emission time names a node somewhere else entirely.
    assert.equal(
      fixture.inserted === undefined ? 0 : fixture.inserted.length,
      insertedNodeIdsOf(plan).length,
      `${fixture.name}: one stated insertion per node the compiler wrote`,
    );
    insertedNodeIdsOf(plan).forEach((nodeId, index) => {
      const position = nodes.findIndex((node) => node.nodeId === nodeId);
      assert.ok(position >= 0, `${fixture.name}: the inserted node ${nodeId} is in the program`);
      const following = nodes[position + 1];
      assert.ok(following, `${fixture.name}: ${nodeId} is written before a step of hers`);
      assert.match(
        insertionsOf(plan).inserted[index]!,
        new RegExp(`;before=${following.nodeId}$`, "u"),
        `${fixture.name}: the insertion account names ${following.nodeId} as the step it precedes`,
      );
    });
    const crops = nodes.filter((node) => node.actionId === "harvest_crop");
    if (fixture.name.startsWith("round66") || fixture.name === "dismissal-then-crops") {
      assert.equal(crops.length, ROUND66_CROPS.length, `${fixture.name}: three crop steps in, three crop nodes out`);
      for (const crop of ROUND66_CROPS) {
        const node = crops.find((candidate) => {
          const tile = tileOf(candidate)!;
          return tile.x === crop.tile.x && tile.y === crop.tile.y;
        });
        assert.ok(node, `${fixture.name}: the crop at ${crop.tile.x},${crop.tile.y} is in the program`);
        assert.deepEqual(
          node.arguments,
          {
            x: { type: "integer", canonicalValue: String(crop.tile.x) },
            y: { type: "integer", canonicalValue: String(crop.tile.y) },
            expectedQualifiedItemId: { type: "string", canonicalValue: crop.item },
            expectedTargetId: { type: "string", canonicalValue: crop.target },
          },
          `${fixture.name}: the arguments of the step at ${crop.tile.x},${crop.tile.y} are the ones the run submitted`,
        );
      }
    }
  }
  console.log(
    `steps examined ${FIXTURES.reduce((total, fixture) => total + fixture.wrote.length, 0)} over ${FIXTURES.length} scripts`,
  );
  assert.deepEqual(findings, [], `a reorder changed the program's steps:\n${findings.join("\n")}`);
});

/**
 * THE FALSIFIER, ON REAL HISTORY: the program `round66` actually submitted is fed to the same reading, and it must be red.
 *
 * <p>
 * Not a synthetic defect - the three `harvest_crop` nodes of `plan_4_bba49665079fd0dd` at `(60,10)`, `(58,14)`, `(60,9)`,
 * in the order the run carried them, with the arguments and target ids its submission shows. These are the nodes the
 * compiler emitted, so the gate reads them the same way it reads a compiled fixture: 13 tiles emitted, 9 shortest, surplus
 * 4. If this test ever passes, the gate has stopped being able to see the defect it was written for.
 * </p>
 */
test("a_batch_is_emitted_in_script_order is red on the program round66 submitted", () => {
  const submitted: readonly PlanNode[] = ROUND66_CROPS.map((crop, index) =>
    Object.freeze({
      nodeId: `n0${index + 1}`,
      actionId: "harvest_crop",
      arguments: Object.freeze({
        x: Object.freeze({ type: "integer" as const, canonicalValue: String(crop.tile.x) }),
        y: Object.freeze({ type: "integer" as const, canonicalValue: String(crop.tile.y) }),
        expectedQualifiedItemId: Object.freeze({ type: "string" as const, canonicalValue: crop.item }),
        expectedTargetId: Object.freeze({ type: "string" as const, canonicalValue: crop.target }),
      }),
      dependsOn: Object.freeze([]),
      orderedAfter: Object.freeze([`n0${index}`]),
      bindings: Object.freeze({}),
    } satisfies PlanNode),
  );
  const readings = batchReadings(submitted, { x: 61, y: 11 });
  assert.equal(readings.length, 1, "the submitted program is one batch of three crops");
  const finding = surplusFinding(readings[0]!);
  assert.equal(readings[0]!.emitted, 15, "the order round66 submitted is 2+6+7 = 15 tiles of walk from her tile");
  assert.equal(readings[0]!.shortest, 10, "the shortest order over the same three tiles is 2+1+7 = 10");
  assert.ok(finding !== null, "the gate must be red on the order round66 emitted");
  assert.match(finding, /surplus=5/, finding);
});

/**
 * The second falsifier, and the shorter one: take a program the compiler DID order as a path and put its batch back into
 * script order. Same nodes, same arguments, same ids - only the sequence differs, so this isolates the ORDER as the thing
 * the gate reads rather than the program's content.
 */
test("the same reading is red when a correct program's batch is put back into script order", () => {
  const fixture = FIXTURES[0]!;
  const nodes = nodesOf(compile(fixture.script, { tile: fixture.actor, enabledActionIds: fixture.enabled }));
  assert.deepEqual(
    batchReadings(nodes, fixture.actor).map((reading) => surplusFinding(reading)),
    [null],
  );
  const run = batchRuns(nodes)[0]!;
  const scriptOrder = [...nodes];
  const members = nodes.slice(run.from, run.to);
  const byScript = ROUND66_CROPS.map(
    (crop) =>
      members.find((member) => {
        const tile = tileOf(member)!;
        return tile.x === crop.tile.x && tile.y === crop.tile.y;
      })!,
  );
  scriptOrder.splice(run.from, members.length, ...byScript);
  const finding = surplusFinding(batchReadings(scriptOrder, fixture.actor)[0]!);
  assert.ok(finding !== null, "putting the batch back into script order makes the reading red");
  assert.match(finding, /surplus=5/, finding);
});
/**
 * THE TWO PASSES COMPOSE: packing decides WHICH nodes a patch becomes, the path order decides which is walked to first.
 *
 * <p>
 * This is the reading the rebase onto the authored-run packing pass needs, because the two passes run back to back and
 * each one could quietly undo the other. Packing replaces a run of authored tiles with the native uses that cover it, and
 * the planting written on one of those tiles must consume THE USE THAT COVERS ITS TILE - not merely the node before it,
 * and not nothing. That second failure is the one a re-derivation by tile would produce: a packed use names its ANCHOR
 * tile, so looking for a node at the planting position finds none and the edge disappears while every test that counts
 * nodes stays green.
 * </p>
 * <p>
 * The reorder is forced rather than hoped for: the body stands at `61,17`, so the packing pass's own column order walks to
 * `60,18` first (2 tiles) where `61,18` is adjacent (1 tile). After the reorder the planting edge must still name the use
 * whose footprint covers `60,19`, and that use is now the SECOND node in the program.
 * </p>
 */
test("a packed run is ordered by the same pass, and the planting edge still names the use that tills its tile", () => {
  const patch = { x: 60, y: 18, w: 2, h: 3 };
  const tiles = Array.from({ length: patch.w * patch.h }, (_, index) => ({
    x: patch.x + (index % patch.w),
    y: patch.y + Math.floor(index / patch.w),
  }));
  const script =
    `for (const tile of ${JSON.stringify(tiles)}) builder.till_soil({ x: tile.x, y: tile.y, charge: 0 });\n` +
    'builder.plant_seed({ x: 60, y: 19, slot: 0, expectedQualifiedItemId: "(O)472", expectedTargetId: "target:60,19" });';
  const plan = compilePlanScript(
    { script },
    {
      snapshot: {
        ...BASE_SNAPSHOT,
        tile: { x: 61, y: 17 },
        enabledActionIds: ["till_soil", "plant_seed"],
        currentToolSlot: 0,
        toolSlots: [{ slot: 0, label: "Hoe", upgradeLevel: 3 }],
      } as Snapshot,
      actions: ACTIONS,
    },
  );
  const nodes = nodesOf(plan);
  const tilled = nodes.filter((node) => node.actionId === "till_soil");
  assert.ok(
    tilled.length < tiles.length,
    `the patch must be PACKED for this reading to mean anything: ${String(tilled.length)} of ${String(tiles.length)} steps`,
  );
  // ONE ACTION AT ONE CHARGE WHOSE TILES FILL A RECTANGLE: the packing pass's own run predicate, read back as the batch.
  const uses = tilled.map((node) => tileOf(node)!);
  const fromHerTile = { x: 61, y: 17 };
  const emitted = walkLength(uses, fromHerTile);
  assert.equal(
    emitted,
    shortestWalk(uses, fromHerTile),
    "the packed uses are emitted at the shortest length from her tile, not in the packing pass's column order",
  );
  // THE EDGE THAT CAN VANISH SILENTLY: the planting written on a packed tile consumes the use that covers it.
  const planting = nodes.find((node) => node.actionId === "plant_seed");
  assert.ok(planting, "the planting is in the program");
  assert.equal(planting.dependsOn.length, 1, "the planting consumes exactly one node: the use that tills its tile");
  const producer = nodes.find((node) => node.nodeId === planting.dependsOn[0]);
  assert.ok(producer, "the edge names a node that is in the program");
  assert.equal(producer.actionId, "till_soil", "and that node is the tilling");
  const charge = Number((producer.arguments.charge as { canonicalValue: string }).canonicalValue);
  const covered = footprintTiles(tileOf(producer)!, TOOL_FOOTPRINT_TILES_BY_CHARGE[charge]!, "y");
  assert.ok(
    covered.some((tile) => tile.x === 60 && tile.y === 19),
    `the producer covers the planted tile: ${JSON.stringify(covered)}`,
  );
  console.log(
    `packed run: ${String(tiles.length)} authored steps -> ${String(uses.length)} uses, walk ${String(emitted)} as emitted, planting consumes ${producer.nodeId} covering ${String(covered.length)} tiles`,
  );
});
