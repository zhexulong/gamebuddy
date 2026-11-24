import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXPRESSION_ONLY_ACTION_IDS } from "./action-registry.js";
import {
  BODY_YIELDING_PLAN_ACTION_IDS,
  type CompiledPlan,
  compilePlanScript,
  GAME_PROSE_PAIR_BUDGET_CHARS,
  MAX_PLAN_NODES,
  MAX_PLAN_SELF_WAIT_NODES,
  MAX_REPORTED_PLAN_READINGS,
  MODAL_CLEARING_PLAN_ACTION_IDS,
  PLAN_FORM_ACTION_IDS,
  PLAN_ITERATION_CONDITIONS,
  PLAN_PLACE_READINGS,
  PLAN_SCRIPT_BUDGET_MS,
  PLAN_SNAPSHOT_DISCOVERY_RADIUS,
  PLAN_SNAPSHOT_READINGS,
  type PlanIterationCondition,
  type PublishedPlanAction,
  planActionsFromRegistrations,
  planProgramId,
  planResourceConflictCodes,
  planSettlementNote,
  planShape,
  planWorkDescription,
  TRANSITION_SOURCE_PLAN_ACTION_IDS,
} from "./body-program-script.js";
import type { StardewTileRead } from "./game-connection.js";
import { GAME_SURFACE_INPUT_HEADER } from "./game-surface-prompt-floor.js";
import { GAME_SURFACE_PROMPT_FLOOR as READING } from "./game-surface-prompt-floor.test-support.js";
import { ROW_STATE_FIELDS } from "./game-world-vocabulary.js";
import { type ActionRegistration, type Snapshot, validateBodyProgramCandidateRequest } from "./protocol.js";
import { SLEEP_DAY_END_TEXT } from "./snapshot-projection.js";

/**
 * The published surface is the authority for the builder's vocabulary, so this suite feeds the generator from
 * the Mod-owned artifact instead of hand-writing the actions it expects.
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
  argumentSchema?: Readonly<
    Record<string, { type: string; enum?: readonly string[]; description?: string; resolvedAtExecution?: boolean }>
  >;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
  /** The snapshot family the action's targets come from, or the surface's silence - the plan compiler reads it too. */
  targetFamily?: string;
  postcondition?: Readonly<{ name?: string }>;
  /**
   * Where the actor must stand before this action can happen, as the surface declares it.
   *
   * Carried because the compiler reads it: how close the previous step already is to a transition's source decides
   * whether a walk is needed at all (`enter_exit` declares `adjacent` one tile; `travel` declares nothing, so it walks
   * itself). A fixture that drops it would publish `approach_requirement_undeclared` for an action the Mod declares.
   */
  approach?: Readonly<{ relation: string; withinTiles?: number }>;
  /**
   * What the action requires of the world and what it changes, as the surface declares it.
   *
   * Carried because the compiler reads it: `requires_place` is what a step written after a move is waiting for, and
   * `moves_actor` is the step it waits on. A fixture that dropped it would make the whole rule below unreachable.
   */
  effects?: Readonly<{
    declared: readonly Readonly<{
      class: "moves_actor" | "requires_place" | "produces" | "consumes";
      subject: string;
      observedBy: string;
    }>[];
    none?: string;
  }>;
}>;

const SURFACE = (
  JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { schema: unknown; actions: readonly SurfaceAction[] }
).actions;

/** The same registrations the Mod publishes on hello_ack, rebuilt from the surface artifact. */
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
            // Carried because it is a declaration the compiler reads, not project decoration: which family a step's
            // targets come from is what tells a piece of world (`soilTiles`, `machineTargets`) from a place to stand
            // (`move_to_tile` declares none), and the consumer rule in `body-program-script.ts` is built on it.
            ...(action.targetFamily === undefined ? {} : { targetFamily: action.targetFamily }),
            ...(action.approach === undefined ? {} : { approach: action.approach }),
            ...(action.effects === undefined ? {} : { effects: action.effects }),
          },
        }),
  }),
);

/**
 * The surface's own declaration of one action's arguments, in the order the artifact lists them.
 *
 * `required` is the MOD's declaration, published as `resolvedAtExecution`: an argument the body answers for at execution
 * is not the caller's to supply, and every other argument must be present or the call is refused. That is the compiler's
 * rule, and the gate at "every declared argument, omitted, is refused" is what keeps these lines honest: it compiles an
 * omission of every argument of every action.
 */
function surfaceArguments(actionId: string): readonly Readonly<{
  name: string;
  type: string;
  required: boolean;
  enum?: readonly string[];
  description?: string;
}>[] {
  const action = SURFACE.find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} is on the published surface`);
  return Object.entries(action.argumentSchema ?? {}).map(([name, declared]) => ({
    name,
    type: declared.type,
    required: declared.resolvedAtExecution !== true,
    ...(declared.enum === undefined ? {} : { enum: declared.enum }),
    ...(declared.description === undefined ? {} : { description: declared.description }),
  }));
}

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

const BASE_SNAPSHOT: Snapshot = {
  revision: 11,
  location: "Farm",
  tile: { x: 10, y: 10 },
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

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...BASE_SNAPSHOT, ...overrides } as Snapshot;
}

const crop = (targetId: string, x: number, y: number) => ({
  targetId,
  x,
  y,
  cropId: "spring_onion",
  displayName: "Parsnip",
});

/**
 * One row of an EXIT table - `warps` or `doorTargets` - as the Mod publishes it: the SOURCE tile on the map the actor
 * stands on, and where the transition leads. Both families accept this shape (`isWarp` in `protocol.ts`).
 */
const exitRow = (sourceX: number, sourceY: number, targetLocation: string) => ({
  sourceX,
  sourceY,
  targetLocation,
  targetX: 40,
  targetY: 12,
});

function compile(script: string, overrides: Partial<Snapshot> = {}, tileRead?: StardewTileRead | null): CompiledPlan {
  return compilePlanScript(
    { script },
    {
      snapshot: snapshot(overrides),
      actions: ACTIONS,
      ...(tileRead === undefined ? {} : { tileRead }),
    },
  );
}

/**
 * The compile windows the compiler declares, read from it rather than restated, and the code that names them.
 *
 * A refusal that outlives a window has to say WHICH measurement it is: the total wall clock it spent and how many
 * windows made it up. Both halves are derived from `PLAN_SCRIPT_BUDGET_MS`, so a change there cannot leave this suite
 * asserting yesterday's arithmetic.
 */
const BUDGET_TOTAL_MS = PLAN_SCRIPT_BUDGET_MS.reduce((total, windowMs) => total + windowMs, 0);
const TIMEOUT_CODE = `plan_script_timeout:${BUDGET_TOTAL_MS}ms:attempts=${PLAN_SCRIPT_BUDGET_MS.length}`;

function refusalOf(result: CompiledPlan): string {
  if (result.status !== "refused") assert.fail(`expected a refusal, received ${result.status}`);
  return result.reasonCode;
}

/**
 * The compiler's own code for the FIRST refused call, in the two states that can carry one.
 *
 * A plan whose every call was refused is `refused` and a plan with some refused is `partial`; both state the same code at
 * the same position, and what differs between them is whether anything RUNS - which is `status`, not the code. So a test
 * about the REFUSAL reads it here, and a test about whether the plan ran reads `status`. Asking `refusalOf` for a plan
 * with one bad call and five good ones would demand the whole-batch void this contract no longer has.
 */
function firstRefusalOf(result: CompiledPlan): string {
  if (result.status === "compiled") assert.fail("expected a refused call, received a plan that compiled every call");
  return result.reasonCode;
}

/**
 * The calls a compile refused, read from the answer that carries them.
 *
 * A plan with ANY refused call is `partial` or `refused` - never `compiled` - so there is nothing to read from a
 * `compiled` answer: that state means every step the author wrote is in the program.
 */
function rejectionsOf(result: CompiledPlan): readonly Readonly<{
  call: number;
  actionId: string | null;
  reasonCode: string;
  missingArguments?: readonly string[];
}>[] {
  if (result.status === "compiled")
    assert.fail("expected refused calls: a plan that compiled every call has no refusals to read");
  return result.rejected;
}

/**
 * What became of every call the script wrote, on either answer.
 *
 * The three lists partition the author's calls - each one lands in exactly one - so their counts sum to the number of
 * builder calls the script made. That is the invariant `tools/check-plan-legal-fixpoint.mjs` asserts over the published
 * vocabulary, and the reason an `ok` answer can no longer hide a step that was thrown away.
 */
function accountOf(result: CompiledPlan) {
  return {
    acceptedSteps: result.acceptedSteps,
    noStepNeeded: result.noStepNeeded,
    dropped: result.dropped,
  };
}

/** The action shape a refused builder call answered with, read from the result the materializer publishes. */
function requirementOf(result: CompiledPlan) {
  if (result.status === "compiled") assert.fail("expected refused calls, received a plan that compiled every call");
  return result.requirement;
}

/** The resource claims the surface publishes for one action: the other half of a refusal's teaching payload. */
function surfaceClaims(actionId: string): readonly Readonly<{ key: string; value: string }>[] {
  const action = SURFACE.find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} is on the published surface`);
  return (action.resourceTemplate?.claims ?? []).map((claim) => ({ key: claim.key, value: claim.value }));
}

type PlanNode = Extract<CompiledPlan, { status: "compiled" }>["program"]["nodes"][number];

/** The program a plan that RUNS carries. `refused` is the one state with nothing to run, so it is the one state this
 *  helper fails on - a `partial` answer has a real program and a real program id. */
function programOf(result: CompiledPlan) {
  if (result.status === "refused") assert.fail(`expected a plan, received ${result.reasonCode}`);
  return result.program;
}

function nodesOf(result: CompiledPlan): readonly PlanNode[] {
  return programOf(result).nodes;
}

/**
 * The nodes the compiler wrote into the program, and their population.
 *
 * Read through the plan they stand beside, so a test cannot assert an insertion on a compile that produced no program:
 * without a plan nothing runs and no insertion means anything.
 */
function insertionsOf(result: CompiledPlan): Readonly<{ inserted: readonly string[]; count: number }> {
  if (result.status === "refused") assert.fail(`expected a plan beside the insertions, received ${result.reasonCode}`);
  return { inserted: result.inserted, count: result.insertedCount };
}

/**
 * The walks this compiler could NOT write, one per transition, spelled `auto_walk_refused:<code>:<x>:<y>`.
 *
 * Read beside the program for the same reason `inserted` is: the program that runs is not the plan the author wrote, and
 * a transition whose walk is missing has to say so rather than leave her reading a node list that disagrees with her
 * script for no stated reason.
 */
function walkRefusalsOf(result: CompiledPlan): readonly string[] {
  if (result.status === "refused")
    assert.fail(`expected a plan beside its walk refusals, received ${result.reasonCode}`);
  return result.autoWalkRefused;
}

/** The node ids the compiler MINTED, which is the population a run's inserted-node reading joins on. */
function insertedNodeIdsOf(result: CompiledPlan): readonly string[] {
  if (result.status === "refused")
    assert.fail(`expected a plan beside its inserted node ids, received ${result.reasonCode}`);
  return result.insertedNodeIds;
}

/**
 * One builder call for an action, carrying exactly the arguments the surface declares.
 *
 * The VALUES are deliberately plain: the tests that use this are about the SHAPE of the program (which nodes exist, in
 * what order), never about a target, and every argument's kind is the surface's own declaration - so a filler of the
 * right kind keeps this helper from becoming a table of actions, which is the thing a gate must not be.
 */
function builderCall(actionId: string): string {
  const supplied = surfaceArguments(actionId).map((argument) => `${argument.name}: ${probeValue(argument)}`);
  return supplied.length === 0 ? `builder.${actionId}();` : `builder.${actionId}({ ${supplied.join(", ")} });`;
}

function probeValue(argument: Readonly<{ type: string; enum?: readonly string[] }>): string {
  switch (argument.type) {
    case "integer":
      return "12";
    case "boolean":
      return "true";
    case "destination_selector":
      return '{ kind: "label", label: "probe" }';
    default:
      return JSON.stringify(argument.enum?.[0] ?? "probe");
  }
}

const WATER_BY_DOOR = `
for (const crop of snapshot.cropTargets ?? []) {
  if (builder.isFull()) break;
  builder.move_to_tile({ x: crop.x, y: crop.y });
  builder.water_crop({ x: crop.x, y: crop.y, expectedTargetId: crop.targetId, charge: 0 });
}
`;

test("a script's calls become one ordered program, ordered in the order it wrote them", () => {
  const nodes = nodesOf(
    compile(WATER_BY_DOOR, {
      enabledActionIds: ["move_to_tile", "water_crop"],
      cropTargets: [crop("crop_01", 11, 10), crop("crop_02", 12, 11)],
    }),
  );
  // Nothing here consumes anything: a walk is a position (`move_to_tile` declares no target family) and each watering
  // is aimed at a different row, so the plan is four steps of one body in the order the script wrote them.
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [
      ["n01", "move_to_tile", []],
      ["n02", "water_crop", []],
      ["n03", "move_to_tile", []],
      ["n04", "water_crop", []],
    ],
  );
  assert.deepEqual(
    nodes.map((node) => node.orderedAfter ?? []),
    [[], ["n01"], ["n02"], ["n03"]],
    "one at a time, in the order the script wrote them",
  );
  assert.deepEqual(nodes[1]!.arguments, {
    x: { type: "integer", canonicalValue: "11" },
    y: { type: "integer", canonicalValue: "10" },
    expectedTargetId: { type: "string", canonicalValue: "crop_01" },
    // The water can's charge, which the surface declares and the compiler carries: charge 0 is the one-tile tap, and a
    // plan that omitted it would be a watering the Mod has to guess the power of.
    charge: { type: "integer", canonicalValue: "0" },
  });
  assert.equal(nodes[1]!.bindings !== undefined && Object.keys(nodes[1]!.bindings).length, 0);
});

/**
 * The nodes the Mod's failure closure would skip when `failedNodeId` fails, read off the edge it reads.
 *
 * `FailedDependents.Compute` (`OpenBodyProgramJournalAuthority.cs`) walks `dependsOn` and nothing else, so this is that
 * closure over the graph the compiler emitted - the same graph `BodyProgramOrderedAfterTests.A3` drives through the real
 * authority, where a failed `till_soil` skips its consuming neighbour and its ordering-only successor still runs. It is
 * here because the Host's half of that fact is the EDGE: a skip count this file cannot produce is a count it must not
 * claim, and the edges are what it does produce.
 */
function skipsOf(nodes: readonly PlanNode[], failedNodeId: string): readonly string[] {
  const skipped = new Set<string>();
  let added = true;
  while (added) {
    added = false;
    for (const node of nodes)
      if (!skipped.has(node.nodeId) && node.dependsOn.some((edge) => edge === failedNodeId || skipped.has(edge))) {
        skipped.add(node.nodeId);
        added = true;
      }
  }
  return [...skipped];
}

/**
 * C3: A BATCH OF INDEPENDENT STEPS IS ORDERED, NOT CHAINED.
 *
 * <p>
 * Measured on the finished 293-node run: `succeeded 197, failed 26, skipped_dependency 58`, and `till_soil` alone was 64
 * nodes - 30 succeeded, 5 failed, **29 skipped**. The tiles of a strip are independent, so one tile that failed has
 * nothing to say about the next, and a fifth of that work died for the shape of the graph rather than for the world.
 * </p>
 * <p>
 * The two edges and what each says (`BodyProgramOrderedAfterTests` A2/A3, written against the wire): `orderedAfter` -
 * "it must be terminal first", the successor is never skipped; `dependsOn` - "I consume its fact", so its failure skips
 * me and names it. This compiler spent `dependsOn` on ordering because it was the only relation there was.
 * </p>
 */
test("a strip of independent steps is ordered, not chained, so one failed tile skips no other tile", () => {
  const nodes = nodesOf(
    compile(
      "for (const tile of snapshot.soilTiles ?? []) { builder.till_soil({ x: tile.x, y: tile.y, charge: 0 }); }",
      {
        enabledActionIds: ["till_soil"],
        soilTiles: [
          { x: 60, y: 18, blockX: 60, blockY: 18, blockW: 4, blockH: 1 },
          { x: 61, y: 18, blockX: 60, blockY: 18, blockW: 4, blockH: 1 },
          { x: 62, y: 18, blockX: 60, blockY: 18, blockW: 4, blockH: 1 },
          { x: 63, y: 18, blockX: 60, blockY: 18, blockW: 4, blockH: 1 },
        ],
      },
    ),
  );
  assert.deepEqual(
    nodes.map((node) => node.actionId),
    ["till_soil", "till_soil", "till_soil", "till_soil"],
  );
  // Four tiles, four holes: no step reads a fact another one produces, so nothing is a consumer.
  assert.deepEqual(
    nodes.map((node) => node.dependsOn),
    [[], [], [], []],
  );
  // One at a time, in the order the script wrote them - every published action claims `embodied_actor`, and one body
  // performs one native mutation at a time.
  assert.deepEqual(
    nodes.map((node) => node.orderedAfter ?? []),
    [[], ["n01"], ["n02"], ["n03"]],
  );
  assert.deepEqual(skipsOf(nodes, "n01"), [], "a tile that failed skips no other tile");
  assert.deepEqual(skipsOf(nodes, "n03"), [], "and neither does one in the middle of the strip");
});

/**
 * C3, in the shape that made the measurement: each tile of a strip is tilled and then planted, interleaved.
 *
 * The planting of a tile CONSUMES the tilling of that tile - there is no soil for a seed where tilling failed - while the
 * next tile's tilling consumes nothing. One failure then costs exactly its own tile's second step.
 */
test("each tile's planting consumes that tile's tilling, and only that tile's", () => {
  const nodes = nodesOf(
    compile(
      "for (const tile of snapshot.soilTiles ?? []) {\n" +
        "  builder.till_soil({ x: tile.x, y: tile.y, charge: 0 });\n" +
        '  builder.plant_seed({ x: tile.x, y: tile.y, slot: 4, expectedQualifiedItemId: "472", expectedTargetId: `seed_${tile.x}` });\n' +
        "}",
      {
        enabledActionIds: ["till_soil", "plant_seed"],
        soilTiles: [
          { x: 60, y: 18, blockX: 60, blockY: 18, blockW: 3, blockH: 1 },
          { x: 61, y: 18, blockX: 60, blockY: 18, blockW: 3, blockH: 1 },
          { x: 62, y: 18, blockX: 60, blockY: 18, blockW: 3, blockH: 1 },
        ],
      },
    ),
  );
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [
      ["n01", "till_soil", []],
      ["n02", "plant_seed", ["n01"]],
      ["n03", "till_soil", []],
      ["n04", "plant_seed", ["n03"]],
      ["n05", "till_soil", []],
      ["n06", "plant_seed", ["n05"]],
    ],
  );
  // The tiles are separated by an ordering edge and by nothing else, so the chain of consumption is broken between them.
  assert.deepEqual(
    nodes.map((node) => node.orderedAfter ?? []),
    [[], [], ["n02"], [], ["n04"], []],
  );
  assert.deepEqual(
    skipsOf(nodes, "n01"),
    ["n02"],
    "the seed had no soil to go in; the other tiles are not its business",
  );
  assert.deepEqual(skipsOf(nodes, "n05"), ["n06"], "the last tile's failure costs the last tile's planting");
});

/**
 * ROUND89, `plan_96`: fifteen seeds in the pack and SEVENTEEN planting nodes.
 *
 * <p>
 * `inventory_after` went 15 -> 0, the plan carried seventeen `plant_seed` nodes, and `n16` and `n17` answered
 * `seed_not_owned_in_pack` - two dispatches bought from a count the plan could read for free. The count and the program
 * are one reading (`inventoryItemFacts`, summed over the slots that hold the seed, which is the pack the Mod re-resolves
 * `slot` from at execution), so a plan that asks for more is a fact about the PLAN - and the compiler is where it is
 * answered, before a node is written.
 * </p>
 */
test("a plan that plants more seed than the pack holds is refused, naming what it plans and what it holds", () => {
  const pack = [{ slot: 11, qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", stack: 15 }];
  const over = compile(plantingSteps(17), { enabledActionIds: ["plant_seed"], inventoryItemFacts: pack });
  assert.equal(over.status, "refused", "seventeen plantings against fifteen seeds is not a program");
  assert.equal(refusalOf(over), "plan_script_exceeds_the_seeds_held:(O)472:planned=17:held=15");
  // AND NOTHING WAS WRITTEN: the program that would have carried the two surplus steps does not exist, which is the
  // difference between this refusal and two nodes the world has to answer `seed_not_owned_in_pack` one at a time.
  assert.equal(
    over.status === "refused" ? over.acceptedStepsCount : -1,
    17,
    "every call is still accounted for, by the position she wrote it",
  );
  // The same pack and a plan that fits it compiles clean - the bound is the count, not a margin under it.
  const fits = compile(plantingSteps(15), { enabledActionIds: ["plant_seed"], inventoryItemFacts: pack });
  assert.equal(fits.status, "compiled");
  assert.equal(nodesOf(fits).length, 15);
});

/**
 * THE OTHER TWO ANSWERS, because "the pack was not published" and "the pack holds none of this seed" are different
 * facts and only one of them may bound a plan.
 */
test("an unpublished pack bounds nothing and is named, and a measured empty one is a real zero", () => {
  const absent = compile(plantingSteps(17), { enabledActionIds: ["plant_seed"] });
  assert.equal(absent.status, "compiled", "no count was published, so no count is invented");
  assert.equal(nodesOf(absent).length, 17);
  assert.deepEqual(
    absent.heldSeedsUnmeasured,
    ["unmeasured=plant_seed.(O)472;family_not_published=inventoryItemFacts"],
    "the plan says which count it could not read instead of guessing one",
  );
  // MEASURED, AND HOLDING NONE: the snapshot says she holds no such seed, so one planting is already one too many.
  const empty = compile('builder.plant_seed({ x: 60, y: 18, expectedQualifiedItemId: "(O)472" });', {
    enabledActionIds: ["plant_seed"],
    inventoryItemFacts: [],
  });
  assert.equal(refusalOf(empty), "plan_script_exceeds_the_seeds_held:(O)472:planned=1:held=0");
});

/**
 * THE PLAN ANSWERS FOR WHAT IT BUYS ITSELF: buying fifteen seeds and planting fifteen is executable with nothing in the
 * pack, and it is the shape `seedSupplyTargets` exists to teach.
 */
test("a plan that buys its own seed is bounded by what it will hold, not by what the pack shows", () => {
  const buyFifteen =
    'builder.shop_purchase({ expectedTargetId: "shop_pierre", expectedQualifiedItemId: "(O)472", quantity: 15 });\n';
  const buys = compile(buyFifteen + plantingSteps(15), {
    enabledActionIds: ["plant_seed", "shop_purchase"],
    inventoryItemFacts: [],
  });
  assert.equal(buys.status, "compiled");
  assert.equal(nodesOf(buys).length, 16, "the purchase and the fifteen plantings are all in the program");
  // One planting past what it buys is still refused, and `held` is what the plan will have rather than `0`.
  const short = compile(buyFifteen + plantingSteps(16), {
    enabledActionIds: ["plant_seed", "shop_purchase"],
    inventoryItemFacts: [],
  });
  assert.equal(refusalOf(short), "plan_script_exceeds_the_seeds_held:(O)472:planned=16:held=15");
});

/** `tiles` planting steps, at consecutive columns of one row: round89's plan in the shape the compiler reads. */
function plantingSteps(tiles: number): string {
  return `for (let x = 60; x < ${String(60 + tiles)}; x += 1) builder.plant_seed({ x, y: 18, expectedQualifiedItemId: "(O)472" });`;
}

/**
 * The can one plan's water belongs to, and the pack row that says the Mod would swing it.
 *
 * TWO FAMILIES, TWO FACTS: `toolSlots` is the pack's own list, which is where a slot is resolved (the compiler ranks it
 * exactly as the Mod's selection does), and `wateringCanFacts` is that can's `water`/`max` - the same reading the Mod's
 * `watering_can_empty` guard compares against zero.
 */
const WATERING_CAN = Object.freeze({
  slot: 4,
  qualifiedItemId: "(T)WateringCan",
  displayName: "Watering Can",
  label: "Watering Can",
  water: 20,
  max: 40,
});
const WATERING_CAN_PACK = [{ slot: 4, label: "Watering Can", category: "watering_can", upgradeLevel: 0 }];

/** `tiles` unwatered crops in one row of the farm: the family a watering plan iterates. */
function cropRows(tiles: number): readonly ReturnType<typeof crop>[] {
  return Array.from({ length: tiles }, (_, index) => crop(`crop_${String(60 + index)}`, 60 + index, 18));
}

/** One `water_crop` call per published crop, charging 0: the loop round92 wrote, whose every node spends one unit. */
const WATERING_STEPS =
  "for (const tile of snapshot.cropTargets ?? []) builder.water_crop({ x: tile.x, y: tile.y, expectedTargetId: tile.targetId, charge: 0 });";

/**
 * ROUND92, `plan_534`: a can holding TWENTY water and a plan carrying THIRTY `water_crop` nodes.
 *
 * <p>
 * The can ran dry at `n21`, and `n22`..`n30` each WALKED to their tile and were then refused `watering_can_empty` - nine
 * walks bought to learn one fact the plan held in its own hand. A can's water is spent by the node that swings it
 * (`WateringCan.cs:189-191`, one unit per charge level the request itself names) and `wateringCanFacts` publishes what the
 * can holds, so the two are one reading taken at submit: a plan that asks for more is a fact about the PLAN.
 * </p>
 */
test("a plan that waters more than its can holds is refused, naming what it plans and what it holds", () => {
  const can = { toolSlots: WATERING_CAN_PACK, wateringCanFacts: [WATERING_CAN], cropTargets: cropRows(30) };
  const over = compile(WATERING_STEPS, can);
  assert.equal(over.status, "refused", "thirty waterings against a can of twenty is not a program");
  assert.equal(refusalOf(over), "plan_script_not_enough_water:planned=30:held=20");
  // AND NOTHING WAS WRITTEN: the nine nodes that could only have been refused are not dispatched, which is the whole
  // difference between this refusal and nine walks to nine tiles.
  assert.equal(
    over.status === "refused" ? over.acceptedStepsCount : -1,
    30,
    "every call is still accounted for, by the position she wrote it",
  );
  // The same can and a plan that fits it compiles clean - the bound is the water held, not a margin under it.
  const fits = compile(WATERING_STEPS, { ...can, cropTargets: cropRows(20) });
  assert.equal(fits.status, "compiled");
  assert.equal(nodesOf(fits).length, 20);
});

/**
 * THE PLAN ANSWERS FOR WHAT IT REFILLS ITSELF, the same way it answers for the seed it buys.
 *
 * A `refill_watering_can` node sets the can back to its maximum, so the count runs in PROGRAM ORDER: with the refill FIRST
 * a plan of forty waterings against a can of twenty is executable, and with the refill written after the dry point it is
 * refused at the same node it would have died at - and `held` says twenty, which is the water that ran out.
 */
test("a refill in the plan tops the can up, and one written after the dry point does not", () => {
  const rows = cropRows(40);
  const refill = 'builder.refill_watering_can({ x: 60, y: 20, slot: 4, expectedTargetId: "refill_1" });\n';
  const can = {
    toolSlots: WATERING_CAN_PACK,
    wateringCanFacts: [WATERING_CAN],
    cropTargets: rows,
    refillWateringCanTargets: [{ targetId: "refill_1", x: 60, y: 20 }],
  };
  const refillsFirst = compile(refill + WATERING_STEPS, can);
  assert.equal(refillsFirst.status, "compiled", "a refill before the work is a plan of forty waterings");
  assert.equal(nodesOf(refillsFirst).length, 41, "the refill and the forty waterings are all in the program");
  const refillsLate = compile(
    "for (const tile of (snapshot.cropTargets ?? []).slice(0, 21)) builder.water_crop({ x: tile.x, y: tile.y, expectedTargetId: tile.targetId, charge: 0 });\n" +
      refill +
      "for (const tile of (snapshot.cropTargets ?? []).slice(21)) builder.water_crop({ x: tile.x, y: tile.y, expectedTargetId: tile.targetId, charge: 0 });",
    can,
  );
  assert.equal(
    refusalOf(refillsLate),
    "plan_script_not_enough_water:planned=40:held=20",
    "the twenty-first watering is already past a can that is only refilled afterwards",
  );
});

/**
 * THE OTHER ANSWERS, because "the can's water was not published", "the snapshot holds no row for the can" and "no slot
 * carries a can" are three different facts and none of them may bound a plan.
 */
test("an unpublished can bounds nothing and is named, and so is a can with no row and a pack with no can slot", () => {
  const absent = compile(WATERING_STEPS, { toolSlots: WATERING_CAN_PACK, cropTargets: cropRows(30) });
  assert.equal(absent.status, "compiled", "no can was published, so no count is invented");
  assert.equal(nodesOf(absent).length, 30);
  assert.deepEqual(
    absent.heldWaterUnmeasured,
    ["unmeasured=water_crop.watering_can;family_not_published=wateringCanFacts"],
    "the plan says which reading it could not make instead of guessing one",
  );
  // MEASURED, AND HOLDING NO ROW FOR THE SLOT the Mod would swing: the can this plan is about is not on the wire.
  const noRow = compile(WATERING_STEPS, {
    toolSlots: WATERING_CAN_PACK,
    wateringCanFacts: [],
    cropTargets: cropRows(30),
  });
  assert.equal(noRow.status, "compiled");
  assert.deepEqual(noRow.heldWaterUnmeasured, ["unmeasured=water_crop.watering_can;slot_not_published=4"]);
  // A PACK THAT NAMES NO CAN AT ALL (an older Mod, whose slots carry no category) resolves no slot, so there is no can to
  // look up - and the plan is not refused for a reading nobody took.
  const noPack = compile(WATERING_STEPS, { cropTargets: cropRows(30) });
  assert.equal(noPack.status, "compiled");
  assert.deepEqual(noPack.heldWaterUnmeasured, ["unmeasured=water_crop.watering_can;slot_unresolved=watering_can"]);
});

/**
 * A door is entered from BESIDE it: the Mod refuses a transition whose source tile is more than one tile from the actor
 * (`door_out_of_range` / `warp_out_of_range`, `farmhandexecutioncontroller.movementactions.cs:478`). A plan that names
 * only the door is therefore refused one submit later, so the compiler writes the walk itself - with the door's own
 * coordinates, which `move_to_tile` accepts as an adjacency target instead of a tile to stand on.
 */
test("a transition gets a walk to its own tile prepended, and its own node is otherwise unchanged", () => {
  const result = compile("builder.enter_exit({ x: 3, y: 12 });", { warps: [exitRow(3, 12, "Town")] });
  const nodes = nodesOf(result);
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [
      ["auto_walk_01", "move_to_tile", []],
      ["n02", "enter_exit", []],
    ],
  );
  // The walk is what makes the door reachable, and it is still only an ORDER: where the body stands is not a fact the
  // door consumes (`move_to_tile` declares no target family), so a walk that failed lets the door run and be refused by
  // name - `door_out_of_range` names what is wrong, where a skip names nothing.
  assert.deepEqual(
    nodes.map((node) => node.orderedAfter ?? []),
    [[], ["auto_walk_01"]],
  );
  assert.deepEqual(nodes[0]!.arguments, {
    x: { type: "integer", canonicalValue: "3" },
    y: { type: "integer", canonicalValue: "12" },
  });
  assert.deepEqual(nodes[1]!.arguments, {
    x: { type: "integer", canonicalValue: "3" },
    y: { type: "integer", canonicalValue: "12" },
  });
  // The prepended step is the compiler's, not the author's: the id says which one it is, and the program it produced is
  // still one the Mod's own request validator accepts.
  assert.equal(nodes[0]!.nodeId.startsWith("auto_walk_"), true);
  assert.equal(validateBodyProgramCandidateRequest({ programId: planProgramId("session_a", 11, nodes), nodes }), null);
});

test("a transition the script already walked to gets no second walk", () => {
  const nodes = nodesOf(
    compile("builder.move_to_tile({ x: 3, y: 12 });\nbuilder.enter_exit({ x: 3, y: 12 });", {
      warps: [exitRow(3, 12, "Town")],
    }),
  );
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [
      ["n01", "move_to_tile", []],
      ["n02", "enter_exit", []],
    ],
  );
  assert.deepEqual(
    nodes.map((node) => node.orderedAfter ?? []),
    [[], ["n01"]],
  );
});

test("a walk to another tile does not stand in for the transition's own tile", () => {
  const nodes = nodesOf(compile("builder.move_to_tile({ x: 4, y: 12 });\nbuilder.travel({ x: 3, y: 12 });"));
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId]),
    [
      ["n01", "move_to_tile"],
      ["auto_walk_02", "move_to_tile"],
      ["n03", "travel"],
    ],
  );
});

/**
 * THE WALK WRITTEN BEFORE A DOOR IS NEITHER INVENTED NOR WRITTEN TWICE, AND BOTH FAULTS WERE MEASURED.
 *
 * <p>
 * `round89` (`.live-runs/game-ladder/2026-11-21T20-38-52-354Z-multiday_routine`) failed the one node whose whole purpose
 * is to hand the body back, twice, for two different reasons - and both were the compiler's:
 * </p>
 * <ul>
 * <li>`plan_12`: `enter_exit(40,-1)` on the Farm, an edge exit one tile OUTSIDE the grid (`snapshot.warps[]` publishes
 * that source, so the coordinate was the author's copy of a real row). The walk was written to `(40,0)` - the off-map
 * axis clamped to the map's first index - and the map answered
 * `target_not_addressable;target_on_map=true;approaches=north:off_map,east:buildings_tile:blocked@41,0,south:buildings_tile:blocked@40,1,west:buildings_tile:blocked@39,0`.
 * A clamped INDEX is not a cell a body can stand on, and this compiler holds no map geometry to ask which cell is.</li>
 * <li>`plan_75`: `move_to_tile(3,11)` then `enter_exit(3,12)`. The author's own walk already stood beside the door -
 * `enter_exit` declares `adjacent`, one tile - and the compiler wrote a SECOND walk, to the door's own tile, which was
 * dispatched, never settled, and abandoned twelve minutes later by the journal heal (`journal_open_stale_dispatch`).</li>
 * </ul>
 * <p>
 * So the two rules these cases pin: a source outside the grid gets NO walk and a named refusal beside the program
 * (`auto_walk_refused:<code>:<x>:<y>`), and a step that already satisfies the transition's DECLARED approach distance
 * gets no walk at all.
 * </p>
 */
test("round89 plan_12: an edge exit's source is outside the grid, so no walk is invented and the refusal is named", () => {
  const edgeWarps = [
    { sourceX: 40, sourceY: -1, targetLocation: "Backwoods", targetX: 40, targetY: 64, accessible: true },
  ];
  for (const actionId of ["enter_exit", "travel"] as const) {
    const result = compile(`builder.${actionId}({ x: 40, y: -1 });`, { warps: edgeWarps } as Partial<Snapshot>);
    const nodes = nodesOf(result);
    // Her transition, alone: the ring of wall the clamp used to send the body to was not a step anybody wrote.
    assert.deepEqual(
      nodes.map((node) => [node.nodeId, node.actionId]),
      [["n01", actionId]],
    );
    assert.deepEqual(walkRefusalsOf(result), ["auto_walk_refused:target_off_map:40:-1"]);
    assert.deepEqual(insertedNodeIdsOf(result), [], "nothing was inserted, so nothing can be refused in the program");
    // The transition's own coordinate is the warp's real source, so the program is still one the Mod's validator accepts.
    assert.equal(
      validateBodyProgramCandidateRequest({ programId: planProgramId("session_a", 11, nodes), nodes }),
      null,
    );
  }
});

test("round89 plan_75: the step before the door already stands beside it, so no second walk is written", () => {
  const result = compile("builder.move_to_tile({ x: 3, y: 11 });\nbuilder.enter_exit({ x: 3, y: 12 });", {
    warps: [exitRow(3, 12, "Town")],
  });
  const nodes = nodesOf(result);
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId]),
    [
      ["n01", "move_to_tile"],
      ["n02", "enter_exit"],
    ],
  );
  assert.deepEqual(walkRefusalsOf(result), [], "the walk was not refused - it was not needed");
  assert.deepEqual(insertedNodeIdsOf(result), []);
});

/**
 * The other side of the same rule, because "no walk" must be the DECLARED distance and not "any earlier walk will do".
 *
 * `enter_exit` declares `adjacent` - one tile - so a step two tiles from the door leaves the door's own `door_out_of_range`
 * to say what is wrong, exactly as before.
 */
test("a step two tiles from the door is not beside it, and the walk is still written", () => {
  const result = compile("builder.move_to_tile({ x: 3, y: 10 });\nbuilder.enter_exit({ x: 3, y: 12 });", {
    warps: [exitRow(3, 12, "Town")],
  });
  assert.deepEqual(
    nodesOf(result).map((node) => [node.nodeId, node.actionId]),
    [
      ["n01", "move_to_tile"],
      ["auto_walk_02", "move_to_tile"],
      ["n03", "enter_exit"],
    ],
  );
  assert.deepEqual(nodesOf(result)[1]!.arguments, {
    x: { type: "integer", canonicalValue: "3" },
    y: { type: "integer", canonicalValue: "12" },
  });
});

/**
 * A DOOR TILE IS A COORDINATE THAT MUST BELONG TO THE MAP SHE IS ON, and `round91` paid twenty seconds to learn it.
 *
 * <p>
 * Measured 2026-11-21 (`round91`, day 7, `plan_481`): she stood on `Farm 64,15`, the snapshot published `location:
 * "Farm"` with the farm's own exits and nothing at `3,12`, and the plan walked via `(42,16)` and `(15,10)` to `(7,18)`
 * before `n02 enter_exit(3,12)` answered `door_not_available`. `3,12` is the FarmHouse's own exit tile - the door of
 * ANOTHER map - and every layer had accepted it: `enter_exit` names no reading, so `a5f5355b`'s family check (which
 * guards arguments the surface marks as readings) never looked at the coordinate, and `protocol.ts` validates a door
 * tile only as `x >= -1 && y >= -1`.
 * </p>
 *
 * <p>
 * The two readings are the same fact from both sides. A tile the snapshot does not publish as a way out of this map is
 * refused BY NAME at compile with zero nodes dispatched - and the script above is the case that matters, because the
 * walk to that tile was a legal node: answering it `partial` would have dispatched exactly the twenty-second approach
 * the refusal exists to save. A tile the map DOES publish compiles untouched (the next case).
 * </p>
 */
test("round91 plan_481: a door tile of another map is refused at compile, naming the map and what it published", () => {
  const result = compile("builder.move_to_tile({ x: 3, y: 12 });\nbuilder.enter_exit({ x: 3, y: 12 });", {
    location: "Farm",
    warps: [exitRow(64, 15, "FarmHouse")],
    doorTargets: [exitRow(64, 14, "FarmHouse")],
  });

  assert.equal(
    refusalOf(result),
    "plan_script_door_not_on_this_map:3:12:map=Farm:warps=1:doors=1",
    "the line names the tile she wrote, the map it was measured against, and what each exit table published",
  );
  assert.equal("program" in result, false, "nothing is dispatched - neither the walk nor the door");
  assert.deepEqual(
    rejectionsOf(result).map((call) => [call.call, call.actionId]),
    [[2, "enter_exit"]],
    "the transition is the refused call, by the position she wrote it",
  );
});

/**
 * The green reading, from BOTH tables: `warps` is the map's own `Warp` property and `doorTargets` is where a building's
 * human door appears, so a check against either table alone would refuse a door the Mod enters.
 */
test("a door this map publishes compiles, whichever table holds it", () => {
  for (const exits of [
    { warps: [exitRow(3, 12, "Town")], doorTargets: [] },
    { warps: [exitRow(64, 15, "FarmHouse")], doorTargets: [exitRow(3, 12, "Farm")] },
  ]) {
    const result = compile("builder.enter_exit({ x: 3, y: 12 });", { location: "Farm", ...exits });
    assert.deepEqual(
      nodesOf(result).map((node) => [node.nodeId, node.actionId]),
      [
        ["auto_walk_01", "move_to_tile"],
        ["n02", "enter_exit"],
      ],
      `exits published as ${JSON.stringify(exits)}`,
    );
  }
});

/**
 * A walk to a tile NO call leaves through is still a walk: the pairing rule refuses the mistake, not the coordinate.
 * This is the boundary the case above must not swallow, and it is why the walk cannot be refused where it is written.
 */
test("a walk to a tile nothing tries to leave through still compiles", () => {
  const nodes = nodesOf(
    compile("builder.move_to_tile({ x: 3, y: 12 });", {
      location: "Farm",
      warps: [exitRow(64, 15, "FarmHouse")],
      doorTargets: [],
    }),
  );
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId]),
    [["n01", "move_to_tile"]],
  );
});

/**
 * A snapshot that publishes no exit table cannot answer, and the three zeroes are told apart: an ABSENT table is
 * `unmeasured`, a published empty one is a count, and neither is accepted - a tile nothing measured is not a door this
 * compiler may send her to.
 */
test("a snapshot with no exit table says unmeasured, and a published empty one says zero", () => {
  assert.equal(
    refusalOf(compile("builder.enter_exit({ x: 3, y: 12 });", { location: "Farm" })),
    "plan_script_door_not_on_this_map:3:12:map=Farm:warps=unmeasured:doors=unmeasured",
  );
  assert.equal(
    refusalOf(compile("builder.enter_exit({ x: 3, y: 12 });", { location: "Farm", warps: [], doorTargets: [] })),
    "plan_script_door_not_on_this_map:3:12:map=Farm:warps=0:doors=0",
  );
});

/**
 * A REFUSED TRANSITION DOES NOT LEAVE THE REST OF HER SCRIPT STANDING, and `round93` paid a night to learn it.
 *
 * <p>
 * Measured 2026-11-22 (`round93`, `plan_463`): she stood in Town and wrote `enter_exit({x:64,y:14}); sleep();`. The
 * transition was refused by name - `(64,14)` is the FARMHOUSE's human door, spelled in the town's frame - and the `sleep`
 * was KEPT, because one refused call stops only itself. The plan that ran was `sleep()` ALONE, from Town: the night
 * answered `not_home` for 308 s and the engine's 2:00 AM pass-out ended the run. The compiler had submitted a plan nobody
 * wrote - hers had the walk home in it - which is the shape this rule exists to make impossible: a plan that loses its
 * precondition must not become a SMALLER plan.
 * </p>
 *
 * <p>
 * The premise is the MAP: `enter_exit` and `travel` move the actor to another one (`TRANSITION_SOURCE_PLAN_ACTION_IDS`),
 * so every call written after a refused one was written for a world this compile never read. The orphan is refused BY
 * NAME, in the same answer, with the call that orphaned it - and the calls written BEFORE the transition still run, which
 * is the falsifier beside this case.
 * </p>
 */
test("round93 plan_463: the sleep written after a refused enter_exit is refused with it, never kept alone", () => {
  const result = compile("builder.enter_exit({ x: 64, y: 14 });\nbuilder.sleep();", {
    location: "Town",
    warps: [],
    doorTargets: [],
  });

  assert.equal(
    refusalOf(result),
    "plan_script_door_not_on_this_map:64:14:map=Town:warps=0:doors=0",
    "the transition's own refusal is the first one, and it is what has to be corrected",
  );
  assert.equal(
    "program" in result,
    false,
    "nothing is dispatched: `sleep()` from Town is the step the refusal exists to stop, and it is not hers to run",
  );
  assert.deepEqual(
    rejectionsOf(result).map((call) => [call.call, call.actionId, call.reasonCode]),
    [
      [1, "enter_exit", "plan_script_door_not_on_this_map:64:14:map=Town:warps=0:doors=0"],
      [2, "sleep", "plan_script_orphaned_by_a_refused_predecessor:n02:sleep:n01:enter_exit"],
    ],
    "the orphan is refused with its predecessor by name and position, so the answer says which of her calls went",
  );
});

/**
 * THE OTHER READING: the orphan rule costs the orphan and no more, so a batch with good work in front of a bad transition
 * still runs that work. Without this, "refuse every later call" would be indistinguishable from "void the batch", and the
 * partial doctrine would have been traded away for the fix rather than kept beside it.
 */
test("the steps written BEFORE a refused transition still run, and only the orphan is dropped", () => {
  const result = compile(
    "builder.move_to_tile({ x: 3, y: 11 });\nbuilder.enter_exit({ x: 64, y: 14 });\nbuilder.sleep();",
    { location: "Town", warps: [], doorTargets: [] },
  );

  assert.equal(result.status, "partial", "the walk was her own step on this map and it compiled");
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["move_to_tile"],
    "the walk runs; the transition and the sleep after it do not",
  );
  assert.deepEqual(accountOf(result).acceptedSteps, ["n01"]);
  assert.deepEqual(accountOf(result).dropped, [
    "n02:plan_script_door_not_on_this_map:64:14:map=Town:warps=0:doors=0",
    "n03:plan_script_orphaned_by_a_refused_predecessor:n03:sleep:n02:enter_exit",
  ]);
});

/**
 * ROUND93'S SUBMITTED PROGRAMME, which is the one that ran: `sleep()` ALONE, from Town.
 *
 * <p>
 * The orphan rule above answers her SCRIPT - a call written after a refused transition went with it - and it cannot answer
 * this one at all, because there is nothing before the `sleep` to have been refused: her plan, as submitted, was one step
 * that the world had already said no to. Measured 2026-11-22 (`round93`, `plan_463`): that plan dispatched, the night
 * answered `not_home` for 308 s, and the engine's 2:00 AM pass-out ended the run.
 * </p>
 * <p>
 * The place is not this file's opinion: `sleep` declares `requires_place: home_indoors`, the predicate that decides it is
 * `SleepAndAdvanceDayLifecycle.HomeOf`, and the Mod publishes its verdict on the snapshot (`sleepAdmitsHere`). A plan that
 * never moves the body home is therefore refused before dispatch, and the refusal names the place and the predicate so the
 * correction is "write the walk home", not "try again".
 * </p>
 */
test("a bare `sleep()` from Town is refused, naming the place the plan never reaches", () => {
  const away = { location: "Town", sleepAdmitsHere: false };
  const result = compile("builder.sleep();", away);

  assert.equal(
    refusalOf(result),
    "plan_script_requires_a_place_the_plan_never_reaches:n01:home_indoors:expected_by=SleepAndAdvanceDayLifecycle.HomeOf",
    "the place and the predicate that would have answered for it, in the Mod's own words",
  );
  assert.equal(accountOf(result).dropped.length, 1, "her one call is dropped, not the plan silently kept");
  // THE OTHER SIDE OF THE SAME READING, which is what keeps this from being "refuse sleep": at home the call compiles
  // with no edge at all, because the place already holds and no step has to reach it.
  const home = compile("builder.sleep();", { location: "FarmHouse", sleepAdmitsHere: true });
  assert.equal(home.status, "compiled", "a place that already holds needs no step in the plan");
  assert.deepEqual(
    nodesOf(home).map((node) => node.dependsOn),
    [[]],
    "and nothing is consumed to reach it",
  );
  // AND THE THIRD ANSWER: no verdict published is the world NOT HAVING SPOKEN. Older Mod snapshots omit the field, and an
  // unread place must not become a refusal - the difference between "nobody said" and "the world said no".
  const unmeasured = compile("builder.sleep();", { location: "Town" });
  assert.equal(unmeasured.status, "compiled", "an unread place is silence, which is never a refusal");
});

/**
 * ROUND93'S OWN TWO CALLS, with the world's verdict published: either the door step is kept, or the `sleep` is refused
 * for the place it never reaches - and here the door is not on this map, so the refusal is the place.
 *
 * <p>
 * WHY THE PLACE ANSWERS BEFORE THE ORPHAN RULE. The orphan code names the predecessor, which here would send her to the
 * transition she already knows is wrong; what she has to fix is that nothing in her plan walks her home. The orphan rule
 * still answers every step whose dependency is the MAP the refused transition led to (see the tests above), and the pair of
 * this test with that one is the difference between a predecessor and a place: without a published verdict the same script
 * answers `plan_script_orphaned_by_a_refused_predecessor`, because silence is not a "no".
 * </p>
 */
test("round93 plan_463: with the place read as unmet, the sleep is refused for home_indoors, not for its predecessor", () => {
  const result = compile("builder.enter_exit({ x: 64, y: 14 });\nbuilder.sleep();", {
    location: "Town",
    warps: [],
    doorTargets: [],
    sleepAdmitsHere: false,
  });

  assert.deepEqual(
    rejectionsOf(result).map((call) => [call.call, call.actionId, call.reasonCode]),
    [
      [1, "enter_exit", "plan_script_door_not_on_this_map:64:14:map=Town:warps=0:doors=0"],
      [
        2,
        "sleep",
        "plan_script_requires_a_place_the_plan_never_reaches:n02:home_indoors:expected_by=SleepAndAdvanceDayLifecycle.HomeOf",
      ],
    ],
    "the door is refused for the tile it named and the sleep for the place her plan never reached",
  );
  assert.equal("program" in result, false, "nothing dispatches: the plan that ran at round93 was this one step");
});

/**
 * THE SUCCESS SIDE OF THE SAME EDGE: a door this map publishes compiles, and the `sleep` after it CONSUMES the door step
 * rather than merely following it.
 *
 * <p>
 * `dependsOn` is the difference between "wait for it" and "I cannot happen without it": a transition that fails at
 * runtime leaves the body on the map it started on, so the step written home-of-that-transition must be SKIPPED, not run
 * from where it is. `orderedAfter` would wait for the failure and run anyway - the 308 s again, in about two seconds.
 * </p>
 */
test("a sleep written after a transition that compiled depends on the transition's success", () => {
  const result = compile("builder.enter_exit({ x: 3, y: 12 });\nbuilder.sleep();", {
    location: "Farm",
    warps: [exitRow(3, 12, "FarmHouse")],
    sleepAdmitsHere: false,
  });

  assert.equal(result.status, "compiled", "the door is on this map, so nothing is refused");
  assert.deepEqual(
    nodesOf(result).map((node) => [node.actionId, node.dependsOn, node.orderedAfter ?? []]),
    [
      ["move_to_tile", [], []],
      ["enter_exit", [], ["auto_walk_01"]],
      ["sleep", ["n02"], []],
    ],
    "the walk, the door she wrote, and a sleep that cannot run if the door did not",
  );
});

/**
 * THE BOUNDARY, WHICH IS THE HALF THAT KEEPS THIS FROM BEING A CHAIN OF EVERYTHING: an action that does not consume the
 * moved actor stays independent and still runs.
 *
 * <p>
 * `chest_store` declares one `consumes` effect (the pack item it moves) and nothing about the body's place, so a plan that
 * walks home, stores something and sleeps is three sentences and the middle one owes nothing to the walk. The classes come
 * from the surface (`PublishedPlanAction.effects`), never from a list of ids here, so the next published action that
 * declares no `requires_place` is outside this rule without an edit - and `express_emote`, whose effect is
 * `actor_body_only`, is not a plan step at all (`EXPRESSION_ONLY_ACTION_IDS`).
 * </p>
 */
test("an action that consumes no moved actor keeps its independence beside the sleep that does", () => {
  const result = compile(
    "builder.enter_exit({ x: 3, y: 12 });\nbuilder.chest_store({ chestId: 'chest_01', expectedQualifiedItemId: '(O)24' });\nbuilder.sleep();",
    { location: "Farm", warps: [exitRow(3, 12, "FarmHouse")], sleepAdmitsHere: false },
  );

  assert.equal(result.status, "compiled");
  assert.deepEqual(
    nodesOf(result).map((node) => [node.actionId, node.dependsOn]),
    [
      ["move_to_tile", []],
      ["enter_exit", []],
      ["chest_store", []],
      ["sleep", ["n02"]],
    ],
    "the store owes nothing to the walk and is written with no edge; the sleep owes the door its success",
  );
  assert.deepEqual(
    accountOf(result).acceptedSteps,
    ["n01", "n02", "n03"],
    "all three of her calls are steps of the plan, so nothing was dropped to keep the sleep honest",
  );
});

/**
 * THE COST OF THE RULE BEING DECLARATION-SHAPED RATHER THAN PRECISE: one dispatch, not a night.
 *
 * <p>
 * `moves_actor` says the body is put somewhere and never says where, so a walk WITHIN the map she stands on is a provider
 * like any other. Written in Town, `move_to_tile(5,5); sleep()` compiles with `sleep` depending on the walk, and when the
 * walk succeeds she is still in Town: the night answers `not_home` **in about two seconds** (that refusal was measured at
 * 308 s before the Mod began releasing it, which is the difference this test is named for). The alternative - deciding
 * which moves can reach which places - would be a second spelling of `HomeOf` in this file, and that predicate is the
 * Mod's.
 * </p>
 */
test("a walk within the map is a provider too, so the cost is one dispatch and an answer, not 308 s", () => {
  const result = compile("builder.move_to_tile({ x: 5, y: 5 });\nbuilder.sleep();", {
    location: "Town",
    sleepAdmitsHere: false,
  });

  assert.equal(
    result.status,
    "compiled",
    "a step that moves the body exists, so the place rule has a provider to name",
  );
  assert.deepEqual(
    nodesOf(result).map((node) => [node.actionId, node.dependsOn]),
    [
      ["move_to_tile", []],
      ["sleep", ["n01"]],
    ],
    "the sleep is written on the walk's success: if the walk failed it is skipped rather than run from Town",
  );
});

/**
 * The same rule over every published action, with its population DERIVED FROM THE SURFACE rather than written here.
 *
 * <p>
 * Two halves, from one reading of `action-surface.v1.json`: an action that declares a place THIS COMPILER CAN READ is
 * refused by that place's name when it is written alone in a world where the place does not hold, and an action that
 * declares none - or a place whose verdict nobody publishes - is never refused for a place at all. A hand-written list of
 * "the place actions" would agree with the artifact today and stop being true in the change that publishes the next one;
 * the print line says how many actions each half examined, and zero blocks.
 * </p>
 */
test("every step that declares a place this compiler can read is answered by that reading, and no other step is", () => {
  const planning = ACTIONS.filter((action) => !PLAN_FORM_ACTION_IDS.includes(action.actionId));
  // One reading of the compiler's own table rather than a second list of "the place actions" here: the population is
  // "declares `requires_place` AND the place has a published verdict", both read from declarations.
  const refusalOfAlone = (actionId: string): string | null => {
    const result = compile(builderCall(actionId), { location: "Town", sleepAdmitsHere: false });
    if (result.status === "compiled") return null;
    const placeRefusal = result.rejected.find((call) => call.reasonCode.startsWith("plan_script_requires_a_place_"));
    return placeRefusal === undefined ? null : placeRefusal.reasonCode;
  };
  const placeActions = planning.filter((action) =>
    action.effects.some((effect) => effect.class === "requires_place" && PLAN_PLACE_READINGS.has(effect.subject)),
  );
  const otherActions = planning.filter((action) => !placeActions.includes(action));
  const namedRefusal = (action: PublishedPlanAction): Readonly<{ place: string; expectedBy: string }> => {
    const declared = action.effects.find(
      (effect) => effect.class === "requires_place" && PLAN_PLACE_READINGS.has(effect.subject),
    );
    return Object.freeze({ place: declared!.subject, expectedBy: declared!.observedBy });
  };
  const unanswered = placeActions
    .map((action) => {
      const expected = namedRefusal(action);
      const reasonCode = refusalOfAlone(action.actionId);
      const code = `plan_script_requires_a_place_the_plan_never_reaches:n01:${expected.place}:expected_by=${expected.expectedBy}`;
      return reasonCode === code ? null : `${action.actionId}: ${String(reasonCode)} (expected ${code})`;
    })
    .filter((finding): finding is string => finding !== null);
  const refusedWithoutAPlace = otherActions
    .map((action) => [action.actionId, refusalOfAlone(action.actionId)] as const)
    .filter(([, reasonCode]) => reasonCode !== null)
    .map(([actionId, reasonCode]) => `${actionId}: ${String(reasonCode)}`);

  console.log(
    `place_rule: actions examined ${String(planning.length)} · declaring a readable place ${String(placeActions.length)} ` +
      `(${placeActions.map((action) => action.actionId).join(",")}) · declaring none ${String(otherActions.length)} · ` +
      `unanswered ${String(unanswered.length)} · refused without a place ${String(refusedWithoutAPlace.length)}`,
  );
  assert.ok(placeActions.length > 0, "blocked: no published action declares a place this compiler can read");
  assert.deepEqual(
    unanswered,
    [],
    "an action whose place is unmet and whose plan cannot reach it must be refused, by name",
  );
  assert.deepEqual(
    refusedWithoutAPlace,
    [],
    "a step that declares no readable place must stay independent: the rule is about the place, not about the plan",
  );
});

/**
 * The same rule from the success side, which is what keeps it about the REFUSAL and not about transitions in general: a
 * door this map publishes compiles, and the step after it is the step she wrote.
 */
test("a step written after a transition that COMPILED is untouched", () => {
  const result = compile("builder.enter_exit({ x: 3, y: 12 });\nbuilder.sleep();", {
    location: "Farm",
    warps: [exitRow(3, 12, "FarmHouse")],
  });

  assert.equal(result.status, "compiled", "nothing was refused, so nothing is orphaned");
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["move_to_tile", "enter_exit", "sleep"],
    "the door she published, the walk the compiler wrote, and her own step after it",
  );
});

/**
 * THE PROPERTY `plan_463` IS ONE INSTANCE OF, MEASURED OVER A GENERATED POPULATION.
 *
 * <p>
 * A HAND-WRITTEN CASE FOR `[enter_exit, sleep]` MISSES THE ELEVENTH COMBINATION. The compiler's whole job is composition,
 * so what is asserted here is the rule and not three examples of it: for every prerequisite this compiler recognises, made
 * refused by every poison this gate can write, with EVERY published action written on either side of it, no step that was
 * written to need what the refused prerequisite would have produced may be SUBMITTED - it is refused with its
 * predecessor and named (`plan_script_orphaned_by_a_refused_predecessor:`), or the whole script is refused and nothing
 * dispatches. Never a smaller plan.
 * </p>
 *
 * <p>
 * TWO DEPENDENCIES, BOTH DERIVED FROM THE COMPILER'S OWN DECLARATIONS rather than from a table of action pairs here:
 * the MAP (`TRANSITION_SOURCE_PLAN_ACTION_IDS` - a step written after a transition was written for the map it leads to)
 * and the TILE (the `planWorldTileOf` consumer relation `dependsOn` is built from - a step on the tile a refused step was
 * to prepare). The map half is enumerated over the whole vocabulary; the tie half is enumerated over the families this
 * suite can publish a row for, and the population line says how many that was.
 * </p>
 *
 * <p>
 * WHAT A PAIRING HAS TO SURVIVE TO BE MEASURED, printed rather than assumed: the dependant must compile ALONE in the same
 * world, or the pairing cannot tell "refused because it was orphaned" from "refused anyway"; and each poison must really
 * refuse its prerequisite on this tree. Both exclusions are counted in the line, so a shrinking population is visible
 * instead of reading as a green run.
 * </p>
 */
test("a refused prerequisite never leaves its dependants in the plan: every generated pairing", () => {
  type Pairing = Readonly<{
    label: string;
    script: string;
    snapshot?: Partial<Snapshot>;
    /** The call written as the prerequisite. */
    pivotCall: number;
    /** The calls written to need what that prerequisite would have produced: none of them may be submitted. */
    dependantCalls: readonly number[];
    /** The calls written BEFORE the prerequisite, which must still run: the rule does not reach backwards. */
    mustRunCalls: readonly number[];
  }>;
  /** The walk every script opens with: a legal step on this map, at a tile no poison below names. */
  const earlier = "builder.move_to_tile({ x: 5, y: 5 });";
  const pairings: Pairing[] = [];
  const poisons: string[] = [];
  const unmeasured = new Set<string>();

  // THE MAP. Every transition the compiler declares, refused by every poison, against every published action.
  for (const pivotActionId of TRANSITION_SOURCE_PLAN_ACTION_IDS) {
    for (const poison of REFUSAL_POISONS) {
      const pivotCall = poison.call(pivotActionId);
      if (compile(pivotCall).status === "compiled") {
        unmeasured.add(`poison_does_not_refuse:${poison.name}:${pivotActionId}`);
        continue;
      }
      poisons.push(`${pivotActionId}.${poison.name}`);
      for (const dependant of ACTIONS) {
        const dependantCall = builderCall(dependant.actionId);
        if (compile(dependantCall).status !== "compiled") {
          unmeasured.add(`dependant_not_writable_alone:${dependant.actionId}`);
          continue;
        }
        for (const pivotPosition of ["first", "last"] as const)
          pairings.push({
            label: `map:${pivotActionId}:${poison.name}:${dependant.actionId}:pivot_${pivotPosition}`,
            script:
              pivotPosition === "first"
                ? [earlier, pivotCall, dependantCall].join("\n")
                : [earlier, dependantCall, pivotCall].join("\n"),
            pivotCall: pivotPosition === "first" ? 2 : 3,
            // WRITTEN AFTER THE PREREQUISITE MEANS IT NEEDS IT; WRITTEN BEFORE MEANS IT DOES NOT. The second ordering is
            // the falsifier that keeps the rule from reaching backwards, so its step must still run.
            dependantCalls: pivotPosition === "first" ? [3] : [],
            mustRunCalls: pivotPosition === "first" ? [1] : [1, 2],
          });
      }
    }
  }

  // THE TILE, over the families whose rows this suite can publish: `cropTargets` and `harvestTargets`, one row each on ONE
  // tile, so a step on that tile is writable alone and the refused step is the same address. Families whose rows this
  // file cannot describe are the population's own hole, printed below.
  const TILE = Object.freeze({ x: 12, y: 12 });
  const tileWorld: Partial<Snapshot> = {
    cropTargets: [crop("crop_01", TILE.x, TILE.y)],
    harvestTargets: [
      {
        targetId: "harvest_01",
        x: TILE.x,
        y: TILE.y,
        cropId: "spring_onion",
        qualifiedHarvestItemId: "(O)24",
        displayName: "Parsnip",
        regrowsAfterHarvest: false,
      },
    ],
  };
  // THE PREREQUISITE IS REFUSED BY A NON-READING ARGUMENT on the SAME tile: `charge` is hers, not the snapshot's, so the
  // refusal happens with `x`/`y` already canonical - which is what makes the tile readable and the dependency real. (An
  // `expectedTargetId` could not do it: it is a READING, so a wrong one is replaced by the row's own before any check,
  // which is how the first version of this half measured nothing and printed `pairing_compiled`.)
  const tillHere = `builder.till_soil({ x: ${TILE.x}, y: ${TILE.y}, charge: "not_an_integer" });`;
  const waterHere = `builder.water_crop({ x: ${TILE.x}, y: ${TILE.y}, expectedTargetId: "crop_01", charge: 0 });`;
  pairings.push(
    {
      label: "tile:pivot_first",
      script: [earlier, tillHere, waterHere].join("\n"),
      snapshot: tileWorld,
      pivotCall: 2,
      dependantCalls: [3],
      mustRunCalls: [1],
    },
    {
      label: "tile:pivot_last",
      script: [earlier, waterHere, tillHere].join("\n"),
      snapshot: tileWorld,
      pivotCall: 3,
      dependantCalls: [],
      mustRunCalls: [1, 2],
    },
  );

  // ONE ASSERTION FOR ALL OF THEM.
  const submittedAnyway: string[] = [];
  let pivotsRefused = 0;
  for (const pairing of pairings) {
    const result = compile(pairing.script, pairing.snapshot);
    if (result.status === "compiled") {
      unmeasured.add(`pairing_compiled:${pairing.label}`);
      continue;
    }
    const dropped = new Set(result.dropped.map(accountPosition));
    // THIS PAIRING IS ONLY ABOUT A REFUSED PREREQUISITE. A script whose pivot COMPILED is a hole in the population - the
    // poison did not survive the rest of the script - so it is named rather than silently skipped.
    if (!dropped.has(pairing.pivotCall)) {
      unmeasured.add(`prerequisite_not_refused:${pairing.label}`);
      continue;
    }
    pivotsRefused += 1;
    const accepted = new Set(result.acceptedSteps.map(accountPosition));
    for (const call of pairing.dependantCalls)
      if (accepted.has(call))
        submittedAnyway.push(
          `${pairing.label}: n0${call} WAS SUBMITTED while its prerequisite n0${pairing.pivotCall} was refused - script ${JSON.stringify(pairing.script)}`,
        );
      else if (!dropped.has(call))
        submittedAnyway.push(
          `${pairing.label}: n0${call} depends on n0${pairing.pivotCall} and is neither run nor named: ${JSON.stringify(result.status === "refused" ? result.dropped : result.dropped)}`,
        );
    for (const call of pairing.mustRunCalls)
      if (!accepted.has(call))
        submittedAnyway.push(`${pairing.label}: n0${call} was written BEFORE the refused step and must still run`);
  }

  // THE POPULATION, PRINTED AND REFUSED AT ZERO: a property test that cannot say how many cases it examined is a test.
  console.log(
    `a_refused_prerequisite_takes_its_dependants: scripts generated ${String(pairings.length)} · ` +
      `prerequisites refused ${String(pivotsRefused)} · poisons ${poisons.join(",")} · ` +
      `unmeasured pairings ${String(unmeasured.size)}` +
      `${unmeasured.size === 0 ? "" : ` (${[...unmeasured].slice(0, 6).join(" | ")}${unmeasured.size > 6 ? " | ..." : ""})`} · ` +
      `orphans that would have been submitted ${String(submittedAnyway.length)}`,
  );
  assert.ok(pairings.length > 0, "blocked: this gate generated no script, so it agrees with itself");
  assert.ok(
    pivotsRefused > 0,
    "blocked: not one generated script refused its prerequisite, so the rule was never measured",
  );
  assert.ok(
    poisons.length >= TRANSITION_SOURCE_PLAN_ACTION_IDS.length,
    `blocked: every declared transition must be refused at least once, and poisons=${String(poisons.length)}`,
  );
  assert.deepEqual(submittedAnyway, [], "a plan that loses its precondition must not become a smaller plan");
});

/**
 * The ways this gate can make a call refused, each derived from the surface's OWN declaration of the arguments: a call
 * missing every argument it declares, and one whose first non-string argument carries a value its type refuses. A
 * transition is the pivot here, so a third poison is the ordinary call on a map that publishes no door - which the door
 * rule refuses without this gate writing it.
 */
const REFUSAL_POISONS: readonly Readonly<{ name: string; call: (actionId: string) => string }>[] = Object.freeze([
  Object.freeze({ name: "missing_every_argument", call: (actionId: string) => `builder.${actionId}({});` }),
  Object.freeze({
    name: "wrong_typed_argument",
    call: (actionId: string) => {
      const declared = surfaceArguments(actionId);
      const target = declared.find((argument) => argument.type !== "string") ?? declared[0];
      if (target === undefined) return `builder.${actionId}({});`;
      const supplied = declared.map(
        (argument) =>
          `${argument.name}: ${argument.name === target.name ? (argument.type === "integer" ? '"not_an_integer"' : "true") : probeValue(argument)}`,
      );
      return `builder.${actionId}({ ${supplied.join(", ")} });`;
    },
  }),
  Object.freeze({ name: "door_not_on_this_map", call: (actionId: string) => `builder.${actionId}({ x: 12, y: 12 });` }),
]);

/** The call position an account entry names: `n03` or `n03:<reasonCode>`. */
function accountPosition(entry: string): number {
  return Number(entry.slice(1, 3));
}

test("a plan with no transition is exactly the plan the script wrote", () => {
  const nodes = nodesOf(
    compile(WATER_BY_DOOR, {
      enabledActionIds: ["move_to_tile", "water_crop"],
      cropTargets: [crop("crop_01", 11, 10)],
    }),
  );
  assert.deepEqual(nodes, [
    {
      nodeId: "n01",
      actionId: "move_to_tile",
      arguments: { x: { type: "integer", canonicalValue: "11" }, y: { type: "integer", canonicalValue: "10" } },
      dependsOn: [],
      bindings: {},
    },
    {
      nodeId: "n02",
      actionId: "water_crop",
      arguments: {
        x: { type: "integer", canonicalValue: "11" },
        y: { type: "integer", canonicalValue: "10" },
        expectedTargetId: { type: "string", canonicalValue: "crop_01" },
        // The can's charge, declared by the surface: 0 is the one-tile tap.
        charge: { type: "integer", canonicalValue: "0" },
      },
      dependsOn: [],
      // The walk is not a producer: the watering waits for the body to be there, and a walk that failed is answered by
      // the watering's own refusal rather than by a skip.
      orderedAfter: ["n01"],
      bindings: {},
    },
  ]);
});

/**
 * ONE RULE, TWO READERS: the ordering requirement the Mod enforces, read on the Host side.
 *
 * `BodyProgramGraphRules.UnorderedClaimPairs` (`OpenBodyProgramJournalAuthority.cs` refuses a candidate that cannot be
 * ordered) refuses any candidate holding two nodes whose actions share a resource-claim key and which are not
 * transitively ordered by EITHER relation. The claims below are the Mod's own, read out of the published surface
 * artifact rather than written here, and the code asserted is the one the Mod's diagnostic carries:
 * `GameBuddy.Stardew.Core.Tests.BodyProgramControllerPumpTests.
 * AStepThatSharesTheActorWithANeighbourItDoesNotDependOnIsRefusedByTheModelItself` drives the real verifier with the
 * same three-step candidate and reads two `resource_conflict:` codes off it.
 */
test("the Host reads the ordering conflict the Mod refuses, in the Mod's own code", () => {
  const claimed = (actionId: string) => {
    const action = ACTIONS.find((candidate) => candidate.actionId === actionId);
    assert.ok(action, `${actionId} is on the published surface`);
    return action;
  };
  const walk = claimed("move_to_tile");
  const harvest = claimed("harvest_crop");
  // The claim that makes two steps of one actor an ordering question at all, taken from the surface and not assumed.
  assert.deepEqual(
    walk.resourceClaims
      .map((claim) => claim.key)
      .filter((key) => harvest.resourceClaims.some((other) => other.key === key)),
    ["embodied_actor"],
    "two steps share the actor claim, so the Mod requires one of them to be ordered against the other",
  );
  const step = (
    nodeId: string,
    actionId: string,
    dependsOn: readonly string[] = [],
    orderedAfter: readonly string[] = [],
  ) => ({ nodeId, actionId, dependsOn, orderedAfter });

  assert.deepEqual(
    planResourceConflictCodes([step("n001", walk.actionId), step("n002", harvest.actionId)], ACTIONS),
    [`resource_conflict:${harvest.actionId}`],
    "unordered, it is the code the Mod would answer",
  );
  // The inverse, in both directions: ONE edge is all the Mod asks for, whichever relation carries it.
  assert.deepEqual(
    planResourceConflictCodes([step("n001", walk.actionId), step("n002", harvest.actionId, ["n001"])], ACTIONS),
    [],
  );
  assert.deepEqual(
    planResourceConflictCodes([step("n001", walk.actionId, ["n002"]), step("n002", harvest.actionId)], ACTIONS),
    [],
  );
  // The ordering edge orders a pair exactly as the consumption edge does - which is what makes it legal to emit for two
  // steps that do not consume each other. Without it in this reader, every plan of a strip would be refused by the
  // compiler itself (`plan_resource_conflict:`) for the shape that stops the strip dying together.
  assert.deepEqual(
    planResourceConflictCodes([step("n001", walk.actionId), step("n002", harvest.actionId, [], ["n001"])], ACTIONS),
    [],
  );
  assert.deepEqual(
    planResourceConflictCodes([step("n001", walk.actionId, [], ["n002"]), step("n002", harvest.actionId)], ACTIONS),
    [],
  );
  // TRANSITIVE, not direct, and through BOTH relations: the Mod walks the edge closure, so a third step that reaches the
  // first through a consumption edge and an ordering edge is ordered without naming it.
  assert.deepEqual(
    planResourceConflictCodes(
      [
        step("n001", walk.actionId),
        step("n002", harvest.actionId, ["n001"]),
        step("n003", walk.actionId, [], ["n002"]),
      ],
      ACTIONS,
    ),
    [],
  );
  // And the shape the Mod was driven with, node for node: one step that consumes another, and a THIRD step that is
  // independent of both. The ordered pair is accepted and the two pairs the third one cannot be placed against are
  // refused - two codes, both naming that third step, which is what the real verifier answered.
  assert.deepEqual(
    planResourceConflictCodes(
      [step("n001", walk.actionId), step("n002", harvest.actionId, ["n001"]), step("n003", harvest.actionId)],
      ACTIONS,
    ),
    [`resource_conflict:${harvest.actionId}`, `resource_conflict:${harvest.actionId}`],
  );
});

test("the program a script produced passes the real Body Program validator", () => {
  const result = compile(WATER_BY_DOOR, {
    enabledActionIds: ["move_to_tile", "water_crop"],
    cropTargets: [crop("crop_01", 11, 10)],
  });
  const nodes = nodesOf(result);
  assert.equal(
    validateBodyProgramCandidateRequest({ programId: planProgramId("session_a", 11, nodes), nodes }),
    null,
    "the compiled program must be one the Mod accepts",
  );
});

test("the same script and snapshot compile to a byte-identical program and program id", () => {
  const overrides = { enabledActionIds: ["move_to_tile", "water_crop"], cropTargets: [crop("crop_01", 11, 10)] };
  const first = compile(WATER_BY_DOOR, overrides);
  const second = compile(WATER_BY_DOOR, overrides);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  if (first.status !== "compiled" || second.status !== "compiled") assert.fail("both compiles must produce a plan");
  assert.equal(
    planProgramId("session_a", 11, first.program.nodes),
    planProgramId("session_a", 11, second.program.nodes),
  );
  // A different plan over the same world is a DIFFERENT program: the id is content-addressed, so the second
  // plan cannot be answered as the first one's duplicate.
  assert.notEqual(
    planProgramId("session_a", 11, first.program.nodes),
    planProgramId(
      "session_a",
      11,
      nodesOf(compile(WATER_BY_DOOR, { ...overrides, cropTargets: [crop("crop_02", 13, 10)] })),
    ),
  );
});

test("a script that reaches outside its sandbox is refused by name, and nothing is compiled", () => {
  for (const [script, name] of [
    ["await builder.move_to_tile({ x: 1, y: 1 });", "await"],
    ['const fs = require("node:fs");', "require"],
    ["const now = Date.now();", "Date"],
    ["const pick = Math.random();", "Math.random"],
    ["setTimeout(() => {}, 10);", "setTimeout"],
    ['return fetch("http://127.0.0.1");', "fetch"],
    ["return process.env;", "process"],
  ] as const)
    assert.equal(refusalOf(compile(script)), `plan_script_uses_forbidden:${name}`);
});

test("a plan is refused by name past the corruption bound, never truncated", () => {
  // The bound is 256, not 16. It is the READ-BACK corruption bound on a journal this product could have written, and it
  // was 16 - which is not a corruption bound at all: a 16-node plan is ordinary, so the writer's policy was being enforced
  // by the reader. A plan past this bound is refused by name rather than silently truncated, because a truncated plan would
  // be a companion that believes it did everything it wrote.
  const result = compile(
    `
for (let index = 0; index < ${MAX_PLAN_NODES + 1}; index++) builder.move_to_tile({ x: 10 + (index % 50), y: 10 });
`,
  );
  assert.equal(refusalOf(result), `plan_cap_exceeded:${MAX_PLAN_NODES + 1}`);
});

test("isFull() stops the script at the bound instead of being refused", () => {
  // `isFull` still exists - a script may legitimately want to stop - but it now answers a bound no ordinary plan reaches,
  // and the tool description no longer shows it, so a model writing a batch does not learn to police itself. Measured
  // 2026-10-31: 31 of 117 historical `plan_work` calls used it, because the only worked example in the description did.
  const nodes = nodesOf(
    compile(
      `
for (let index = 0; index < ${MAX_PLAN_NODES + 40}; index++) {
  if (builder.isFull()) break;
  builder.move_to_tile({ x: 10 + (index % 50), y: 10 });
}
`,
    ),
  );
  assert.equal(nodes.length, MAX_PLAN_NODES);
});

/**
 * `sleep` rebuilds the world, so it is the LAST node a plan can carry.
 *
 * It walks the actor to its own bed and then runs the save/warp/day-start lifecycle, which discards the world every
 * later node was compiled against. A node written after it is a step aimed at a snapshot that no longer describes the
 * farm, so the Mod could only refuse it at runtime - the builder refuses it at the call that wrote it instead, and
 * names both actions so the author sees which line was wrong.
 */
test("a node compiled after sleep is refused by name, at the call that wrote it", () => {
  const result = compile(`
builder.move_to_tile({ x: 12, y: 8 });
builder.sleep();
builder.cut_weeds({ x: 12, y: 8, slot: 0, expectedTargetId: "debris_01" });
`);
  // The refused step cannot exist in the plan - a node after `sleep` aims at a world that is gone - so it is the one
  // call that does not become a node, and the answer names it beside the two that compiled.
  assert.equal(result.status, "partial", "the walk and the sleep ran; the step after the reset could not");
  assert.equal(firstRefusalOf(result), "plan_script_action_after_world_reset:cut_weeds:sleep");
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["move_to_tile", "sleep"],
    "the step written after the world reset is the one absent, and it is the last one she wrote",
  );
  assert.deepEqual(rejectionsOf(result), [
    { call: 3, actionId: "cut_weeds", reasonCode: "plan_script_action_after_world_reset:cut_weeds:sleep" },
  ]);
  assert.deepEqual(accountOf(result).dropped, ["n03:plan_script_action_after_world_reset:cut_weeds:sleep"]);
  assert.deepEqual(
    accountOf(result).acceptedSteps,
    ["n01", "n02"],
    "the walk and the sleep are steps of hers that compiled",
  );
});

/**
 * ROUND42, the shape that cost the day: the rule is real, and the remedy is mechanical, so the compiler writes it.
 *
 * Measured live on day 6: four separate programs were refused
 * `plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal` - one per attempt at "talk
 * to the shopkeeper, then buy seeds" - and not one of them reached the purchase, so no seed was bought in any of those
 * turns. One published node, in one position nothing else competes for, is not a judgement call the author should have to
 * remember: it is a step of the program, and this compiler writes the program.
 */
test("a step after talk_to_npc gets the dismissal inserted, and the answer says where", () => {
  const result = compile(`
  builder.move_to_tile({ x: 12, y: 8 });
  builder.talk_to_npc({ x: 13, y: 8, expectedTargetId: "npc_pierre" });
  builder.shop_purchase({ expectedTargetId: "shop_pierre", expectedQualifiedItemId: "(O)472", quantity: 1 });
  `);
  const nodes = nodesOf(result);
  // Her steps, in her order, with nothing moved: the dismissal goes immediately after the dialogue that held the body and
  // immediately before the step that needs it.
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId]),
    [
      ["n01", "move_to_tile"],
      ["n02", "talk_to_npc"],
      ["auto_dismiss_03", "dismiss_modal"],
      ["n04", "shop_purchase"],
    ],
  );
  // The body was held, nothing was consumed: the dismissal waits for the dialogue and the purchase waits for the
  // dismissal - which is also what makes the pair legal for the Mod's ordering rule (every action claims `embodied_actor`).
  assert.deepEqual(
    nodes.map((node) => node.dependsOn),
    [[], [], [], []],
  );
  assert.deepEqual(
    nodes.map((node) => node.orderedAfter ?? []),
    [[], ["n01"], ["n02"], ["auto_dismiss_03"]],
  );
  assert.deepEqual(nodes[2]!.arguments, {}, "the compiler invents no argument the author did not choose");
  // The answer states that the program is not exactly the script, and where.
  assert.deepEqual(insertionsOf(result).inserted, ["inserted=dismiss_modal;before=n04"]);
  assert.equal(insertionsOf(result).count, 1);
  assert.deepEqual(
    insertedNodeIdsOf(result),
    ["auto_dismiss_03"],
    "the node id the compiler minted is published in full: a run's inserted-node reading joins node outcomes on it",
  );
  assert.deepEqual(accountOf(result).dropped, [], "nothing of hers was thrown away");
  assert.deepEqual(
    accountOf(result).acceptedSteps,
    ["n01", "n02", "n03"],
    "both of her steps are in the program - the third node is the purchase she wrote at call 3",
  );
  // And what the Mod receives is a request its own validator accepts.
  assert.equal(validateBodyProgramCandidateRequest({ programId: planProgramId("session_a", 11, nodes), nodes }), null);
});

test("a plan whose steps never hold the body gets no dismissal inserted", () => {
  const result = compile(`
  builder.move_to_tile({ x: 12, y: 8 });
  builder.water_crop({ x: 12, y: 8, expectedTargetId: "crop_01", charge: 0 });
  `);
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["move_to_tile", "water_crop"],
  );
  assert.deepEqual(insertionsOf(result).inserted, []);
  assert.equal(insertionsOf(result).count, 0);
  assert.deepEqual(
    insertedNodeIdsOf(result),
    [],
    "an empty population is stated, not left to be inferred from an absent field",
  );
});

/**
 * THE PLAN `round44`'S SHAPE COMPILES TO, and the node id it carries.
 *
 * The live measurement this unit answers was `talk_to_npc` then a body action - the plan the compiler now repairs - and the
 * repair is a `dismiss_modal` node whose world may already have closed the box. The Host half of that fix is that the plan
 * compiles and that the inserted node is named exactly (see `round-verdict.mjs` `measureInsertedNodes`, which prices it,
 * and `ModalDismissActionTests.EveryModalFamilyMember_WithoutItsPrecondition_IsANoOpOrANamedRefusal_NeverAFailure`, which
 * requires the absent-modal world to resolve as the no-op).
 */
test("the talk-then-chop plan carries the compiler's dismissal, named by the node id a run can price", () => {
  const result = compile(`
  builder.talk_to_npc({ x: 13, y: 8, expectedTargetId: "npc_pierre" });
  builder.chop_tree({ x: 13, y: 8, slot: 0, expectedTargetId: "tree_01" });
  `);
  assert.deepEqual(
    nodesOf(result).map((node) => [node.nodeId, node.actionId]),
    [
      ["n01", "talk_to_npc"],
      ["auto_dismiss_02", "dismiss_modal"],
      ["n03", "chop_tree"],
    ],
    "her two steps, with the dismissal between them and nothing else moved",
  );
  assert.deepEqual(insertedNodeIdsOf(result), ["auto_dismiss_02"]);
  assert.deepEqual(insertionsOf(result).inserted, ["inserted=dismiss_modal;before=n03"]);
  assert.equal(
    validateBodyProgramCandidateRequest({
      programId: planProgramId("session_a", 11, nodesOf(result)),
      nodes: nodesOf(result),
    }),
    null,
    "the repaired program is still one the Mod's own validator accepts",
  );
});

/**
 * The author who already wrote the step keeps HER program: an insertion is a repair, never a policy.
 *
 * Both body-clearing actions, read from the declaration instead of re-listed here: whichever one she wrote, the compiler
 * must see that the body is already free and leave the node list alone.
 */
test("a body-clearing step the author wrote herself is not inserted twice", () => {
  assert.ok(MODAL_CLEARING_PLAN_ACTION_IDS.length > 0, "the clearing declaration names at least one action");
  for (const clearingActionId of MODAL_CLEARING_PLAN_ACTION_IDS) {
    const result = compile(`
    builder.talk_to_npc({ x: 13, y: 8, expectedTargetId: "npc_pierre" });
    ${builderCall(clearingActionId)}
    builder.move_to_tile({ x: 12, y: 8 });
    `);
    assert.deepEqual(
      nodesOf(result).map((node) => node.actionId),
      ["talk_to_npc", clearingActionId, "move_to_tile"],
      `${clearingActionId} already gives the body back, so no second dismissal is written after it`,
    );
    assert.deepEqual(insertionsOf(result).inserted, [], `${clearingActionId}: nothing was inserted`);
  }
});

/**
 * THE INSERTION IS A PROPERTY OF THE DECLARATION, NOT OF TWO ACTION IDS.
 *
 * Both halves read the product's own declarations and neither re-lists them: the yielding set is the exported declaration
 * `emitPlanNode` itself checks, and the population is every action the builder generates. The property is the pair rule -
 * a dismissal appears if and only if the step before it is in the yielding set - so an action that starts holding the body,
 * or stops, moves this gate instead of escaping it.
 *
 * The population is printed in every failure message and a zero population FAILS, because a check that examines nothing
 * agrees with itself.
 */
test("the dismissal is inserted for exactly the actions the declaration calls body-yielding", () => {
  assert.ok(BODY_YIELDING_PLAN_ACTION_IDS.length > 0, "the yielding declaration names at least one action");
  assert.ok(ACTIONS.length > 20, `the vocabulary is a real population, not ${ACTIONS.length} actions`);
  // The pair is written for every action, so the population stays whole. An action that rebuilds the world cannot be
  // followed by ANY step - that is the other rule, and it is measured as its own named refusal rather than skipped here,
  // because a skipped member would be a hole exactly where the two rules meet.
  const worldResetting = SURFACE.filter((action) => action.postcondition?.name === "day_advanced").map(
    (action) => action.actionId,
  );
  assert.ok(
    worldResetting.length > 0,
    "the surface still declares the day_advanced postcondition, so the pair has a hole to name",
  );
  const insertedFor: string[] = [];
  let refusedAsWorldReset = 0;
  for (const action of ACTIONS) {
    // THE MAP PUBLISHES THE DOOR A TRANSITION NAMES, because each action's own step has to COMPILE for this pair to be
    // about the dismissal at all. `enter_exit`/`travel` name (12,12), and a snapshot carrying no exit table refuses it by
    // name (`plan_script_door_not_on_this_map`) - after which the step after it is an orphan and the compile has no
    // program. Before this fixture published one, those two members were silently READ AS THEIR `move_to_tile`: the
    // answer was `partial` and its insertions were empty, so the gate agreed with itself about the two actions it never
    // measured.
    const result = compile(`${builderCall(action.actionId)}\nbuilder.move_to_tile({ x: 11, y: 10 });`, {
      warps: [exitRow(12, 12, "Town")],
    });
    if (worldResetting.includes(action.actionId)) {
      assert.equal(
        firstRefusalOf(result),
        `plan_script_action_after_world_reset:move_to_tile:${action.actionId}`,
        `${action.actionId} rebuilds the world, so no step may follow it - named here rather than dropped from the population`,
      );
      refusedAsWorldReset += 1;
      continue;
    }
    const insertions = insertionsOf(result).inserted;
    const dismissals = insertions.filter((entry) => entry.includes(`=${MODAL_CLEARING_PLAN_ACTION_IDS[0]};`));
    const yielding = BODY_YIELDING_PLAN_ACTION_IDS.includes(action.actionId);
    assert.equal(
      dismissals.length,
      yielding ? 1 : 0,
      `${action.actionId}: yielding=${yielding}, insertions=${JSON.stringify(insertions)} ` +
        `(examined ${insertedFor.length + 1} of ${ACTIONS.length} actions; ${insertedFor.length} of the ones before it inserted)`,
    );
    // THE POPULATION A RUN'S READING JOINS ON: exactly the nodes the compiler wrote, and only those - read from the
    // program the answer published, not from a list of insertion kinds. An author's node carries its own 1-based
    // position as its id (`planNodeId`), so any other id belongs to a node the compiler wrote: `talk_to_npc` writes a
    // dismissal and `travel` writes a walk. A transition yields no body and still has a node written for it, so "nothing
    // was inserted" is NOT what a non-yielding action means, and asserting it would have made the walk an author's node.
    const program = nodesOf(result);
    const claimed = insertedNodeIdsOf(result);
    assert.deepEqual(
      claimed,
      program.map((node) => node.nodeId).filter((nodeId, index) => nodeId !== `n${String(index + 1).padStart(2, "0")}`),
      `${action.actionId}: the ids the compiler claims are exactly the nodes it wrote`,
    );
    assert.equal(
      claimed.length,
      insertionsOf(result).count,
      `${action.actionId}: every insertion the answer states is one node id it names`,
    );
    if (!yielding) continue;
    insertedFor.push(action.actionId);
    assert.deepEqual(
      program.map((node) => node.actionId).slice(0, 2),
      [action.actionId, MODAL_CLEARING_PLAN_ACTION_IDS[0]],
      `${action.actionId} holds the body, so the dismissal stands between it and the next step`,
    );
    assert.equal(claimed.length, 1, `${action.actionId}: one dismissal, one inserted node id`);
    assert.equal(
      program.find((node) => node.nodeId === claimed[0])?.actionId,
      MODAL_CLEARING_PLAN_ACTION_IDS[0],
      `${action.actionId}: the id the compiler claims is the node the compiler wrote`,
    );
  }
  assert.ok(insertedFor.length > 0, "the population of insertions was not empty");
  assert.equal(
    refusedAsWorldReset,
    worldResetting.length,
    `every world-resetting action was measured by its own refusal (${refusedAsWorldReset} of ${worldResetting.length})`,
  );
});

/**
 * THE REFUSAL SURVIVES FOR THE ONE THING THIS COMPILER CANNOT FIX, and keeps its name.
 *
 * When the vocabulary it was handed publishes no body-clearing action, there is nothing to insert: a node naming an id the
 * attached Mod does not advertise would be refused by the wire with a code that names nothing the author can add. Then she
 * is told exactly what she was told before.
 */
test("with no published dismissal to write, the refusal keeps its name", () => {
  const withoutDismissal = ACTIONS.filter((action) => action.actionId !== MODAL_CLEARING_PLAN_ACTION_IDS[0]);
  const result = compilePlanScript(
    {
      script:
        'builder.talk_to_npc({ x: 13, y: 8, expectedTargetId: "npc_pierre" });\n' +
        "builder.move_to_tile({ x: 12, y: 8 });",
    },
    { snapshot: snapshot(), actions: withoutDismissal },
  );
  assert.deepEqual(rejectionsOf(result), [
    {
      call: 2,
      actionId: "move_to_tile",
      reasonCode: `plan_script_action_after_body_yield:move_to_tile:talk_to_npc:dismiss_first=${MODAL_CLEARING_PLAN_ACTION_IDS[0]}`,
    },
  ]);
  assert.equal(
    firstRefusalOf(result),
    `plan_script_action_after_body_yield:move_to_tile:talk_to_npc:dismiss_first=${MODAL_CLEARING_PLAN_ACTION_IDS[0]}`,
    "the code is the refusal's own, unchanged: the compiler cannot write a dismissal the surface does not publish",
  );
  assert.deepEqual(
    accountOf(result).acceptedSteps,
    ["n01"],
    "the dialogue she wrote compiled; the step after it broke",
  );
});

/**
 * NO PAIR IS A DEAD END: every body-yielding action followed by every other action either compiles, or is refused with a
 * remedy that this same compiler accepts when the remedy is applied mechanically.
 *
 * <p>
 * This is the assertion the round42 run paid for. A refusal is a PROMISE - "write this step and the program runs" - and a
 * promise the compiler does not honour costs a turn in which nothing happens, which is how four programs died on
 * `talk_to_npc` + `shop_purchase` without buying a seed. The remedy is applied the only mechanical way it can be: the
 * action id the refusal names, inserted between the two steps. A pair whose remedy does not compile is a dead end and is
 * listed by name.
 * </p>
 * <p>
 * A PAIR THE COMPILER COULD NOT MEASURE FAILS HERE, BY NAME. This gate used to retry a `plan_script_timeout` itself and
 * file the pair as "not measured", which is how a 50 ms wall-clock window turned machine load into a green gate with a
 * quiet bucket beside it. The re-measurement belongs to the compiler now (`PLAN_SCRIPT_BUDGET_MS`: a measurement window
 * and a larger re-measurement), so an expiry that survives it is a finding about the compiler rather than about the box
 * this ran on - and it is reported as the pairs it stopped, not as a count nobody reads.
 * </p>
 */
test("every body-yielding pair either compiles or names a remedy that fixes it", () => {
  assert.ok(BODY_YIELDING_PLAN_ACTION_IDS.length > 0, "the yielding declaration names at least one action");
  const pairs = BODY_YIELDING_PLAN_ACTION_IDS.flatMap((yieldingId) =>
    ACTIONS.filter((action) => action.actionId !== yieldingId).map((action) => [yieldingId, action.actionId] as const),
  );
  assert.ok(pairs.length > 20, `the pair population is a real population, not ${pairs.length} pairs`);
  const expiredCode = (result: CompiledPlan): string | null =>
    result.status === "refused" && result.reasonCode.startsWith("plan_script_timeout") ? result.reasonCode : null;
  // THE WORLD THESE PLAIN VALUES NEED. `probeValue` writes `12` for every integer argument, so a pair that names a door
  // names `(12,12)`; a snapshot that publishes no exit there would make every `*->enter_exit` pair a dead end for a
  // reason that is about this fixture rather than about the pair. One published exit, and nothing else.
  const pairWorld = { warps: [exitRow(12, 12, "Town")], doorTargets: [] };
  const deadEnds: string[] = [];
  const notMeasured: string[] = [];
  let asWritten = 0;
  let repaired = 0;
  for (const [yieldingId, dependentId] of pairs) {
    const pair = compile(`${builderCall(yieldingId)}\n${builderCall(dependentId)}`, pairWorld);
    const pairExpired = expiredCode(pair);
    if (pairExpired !== null) {
      notMeasured.push(`${yieldingId}->${dependentId}: ${pairExpired}`);
      continue;
    }
    if (pair.status === "compiled") {
      asWritten += 1;
      continue;
    }
    const named = /dismiss_first=([a-z0-9_]+)/u.exec(pair.reasonCode)?.[1];
    if (named === undefined) {
      deadEnds.push(`${yieldingId}->${dependentId}: refused with no remedy (${pair.reasonCode})`);
      continue;
    }
    const remedy = compile(`${builderCall(yieldingId)}\n${builderCall(named)}\n${builderCall(dependentId)}`, pairWorld);
    const remedyExpired = expiredCode(remedy);
    if (remedyExpired !== null) {
      notMeasured.push(`${yieldingId}->${dependentId}:${named}: ${remedyExpired}`);
      continue;
    }
    if (remedy.status !== "compiled") {
      deadEnds.push(`${yieldingId}->${dependentId}: remedy ${named} does not compile (${remedy.reasonCode})`);
      continue;
    }
    repaired += 1;
  }
  const population = `${pairs.length} pairs (${asWritten} compiled as written, ${repaired} only after the named remedy)`;
  assert.deepEqual(
    notMeasured,
    [],
    `${notMeasured.length} pairs outlived every compile window of ${population}:\n${notMeasured.join("\n")}`,
  );
  assert.deepEqual(deadEnds, [], `${deadEnds.length} dead ends of ${population}:\n${deadEnds.join("\n")}`);
});

/**
 * THE HOST'S MODAL SET IS A PROJECTION OF A MOD DECLARATION THAT IS NOT ON THE WIRE, so the two are compared here.
 *
 * A projection narrower than its authority is a plan that needs the missing member and is refused with no legal remedy; a
 * projection wider is a plan that skips a dismissal the body needed. Neither is visible from inside the Host, and the wire
 * carries no handler group (`ActionRegistrationDescriptor`), so the Mod's side is read from its own source:
 * `FarmhandActionCatalog.ModalResolvingActionIds` is `Registrations.Where(r => r.HandlerGroup ==
 * FarmhandActionHandlerGroup.Modal)` (`FarmhandActionDefinitions.cs:746-762`), and a member is one `E(<id>, <family>,
 * FarmhandActionHandlerGroup.Modal, ...)` registration. A member present on one side only is drift, named with the side it
 * is on. The regex spells its quotation marks as `\x22` so this block needs no escaping of its own.
 *
 * Both populations are asserted non-empty BEFORE the comparison: two empty sets agree with themselves. The first member is
 * also asserted to declare no argument, because that member is the one the compiler WRITES on the author's behalf.
 */
test(`the host's modal-clearing projection does not drift from the Mod's declaration`, () => {
  const modMembers = [
    ...MOD_LIFECYCLE_WIRE.matchAll(
      /\bE\(\s*\x22([a-z][a-z0-9_]+)\x22\s*,\s*\x22[a-z][a-z0-9_]+\x22\s*,\s*FarmhandActionHandlerGroup\.Modal\s*,/gu,
    ),
  ].map((match) => match[1]!);
  assert.ok(modMembers.length > 0, `the Mod's Modal handler group names at least one registration`);
  const hostMembers = [...MODAL_CLEARING_PLAN_ACTION_IDS];
  assert.ok(hostMembers.length > 0, `the Host projection names at least one action`);
  const drift: string[] = [];
  for (const actionId of modMembers)
    if (!hostMembers.includes(actionId)) drift.push(`modal_clearing_set_drift:${actionId}:mod`);
  for (const actionId of hostMembers)
    if (!modMembers.includes(actionId)) drift.push(`modal_clearing_set_drift:${actionId}:host`);
  assert.deepEqual(
    drift,
    [],
    `${drift.length} drifting member(s) between the Mod's declaration (${modMembers.join(`,`)}) and the Host projection ` +
      `(${hostMembers.join(`, `)}):\n${drift.join(`\n`)}`,
  );
  // The member the compiler writes is the FIRST one, so its declaration must be one the compiler can write: no argument.
  assert.deepEqual(
    surfaceArguments(MODAL_CLEARING_PLAN_ACTION_IDS[0]!),
    [],
    `${MODAL_CLEARING_PLAN_ACTION_IDS[0]} is the member the compiler writes, so it must declare no argument`,
  );
});

test("a modal-clearing step is what makes a continuation legal after talk_to_npc", () => {
  // The primitive was never missing: `dismiss_modal` closes an informational DialogueBox
  // (`farmhandexecutioncontroller.modalactions.cs:129-131`). So "talk, then carry on" has a correct shape, and the plan rule
  // must admit it while still refusing a plan that would silently fail.
  const ending = nodesOf(
    compile(`
  builder.move_to_tile({ x: 12, y: 8 });
  builder.talk_to_npc({ x: 13, y: 8, expectedTargetId: "npc_abigail" });
  builder.dismiss_modal();
  builder.move_to_tile({ x: 14, y: 8 });
  `),
  );
  assert.deepEqual(
    ending.map((node) => node.actionId),
    ["move_to_tile", "talk_to_npc", "dismiss_modal", "move_to_tile"],
  );
});

test("talk_to_npc as the last node still compiles", () => {
  const ending = nodesOf(
    compile(`
  builder.move_to_tile({ x: 12, y: 8 });
  builder.talk_to_npc({ x: 13, y: 8, expectedTargetId: "npc_abigail" });
  `),
  );
  assert.deepEqual(
    ending.map((node) => node.actionId),
    ["move_to_tile", "talk_to_npc"],
  );
});

test("sleep as the last node still compiles, and a menu-closing step is not terminal", () => {
  const ending = nodesOf(
    compile(`
builder.move_to_tile({ x: 12, y: 8 });
builder.sleep();
`),
  );
  assert.deepEqual(
    ending.map((node) => node.actionId),
    ["move_to_tile", "sleep"],
  );
  // Closing a menu changes nothing about the world, so watering a crop afterwards is a legal sequence and stays one.
  const afterMenu = nodesOf(
    compile(`
builder.dismiss_modal();
builder.water_crop({ x: 12, y: 8, expectedTargetId: "crop_01", charge: 0 });
`),
  );
  assert.deepEqual(
    afterMenu.map((node) => node.actionId),
    ["dismiss_modal", "water_crop"],
  );
});

/**
 * The terminal set is hand-declared because the surface publishes no "this rebuilds the world" property, so this test
 * keeps the rule honest against the one catalog fact that does exist: the `day_advanced` postcondition.
 *
 * It asks the compiler, not the list, so the assertion survives the set becoming derived: every surface action
 * declaring `day_advanced` must be refused as the step before another one, by the same named code. A second such
 * action fails HERE by name instead of silently escaping the rule.
 */
test("every action the surface declares day_advanced refuses a step written after it", () => {
  const dayAdvanced = SURFACE.filter((action) => action.postcondition?.name === "day_advanced").map(
    (action) => action.actionId,
  );
  assert.ok(dayAdvanced.length > 0, "the surface still declares the day_advanced postcondition");
  for (const actionId of dayAdvanced) {
    const result = compile(`builder.${actionId}();\nbuilder.move_to_tile({ x: 11, y: 10 });`);
    assert.equal(
      firstRefusalOf(result),
      `plan_script_action_after_world_reset:move_to_tile:${actionId}`,
      `${actionId} declares day_advanced, so a plan may not write a node after it`,
    );
    assert.deepEqual(
      accountOf(result).acceptedSteps,
      ["n01"],
      `${actionId} is the step that compiled, and the walk after it is the one that did not`,
    );
  }
});

test("a builder method generated from the published surface rejects a wrong, missing or non-canonical argument", () => {
  // `move_to_tile` declares exactly x and y. Every one of these is the mistake a script actually makes, and every
  // answer names the argument, what it must be and where the value is published - see the argument-surface gates below.
  assert.equal(
    refusalOf(compile("builder.move_to_tile({ x: 10, y: 10, expectedTargetId: 'nope' });")),
    "plan_script_unknown_argument:move_to_tile.expectedTargetId:allowed:x,y:declared_by:ride_minecart,select_mine_elevator_floor,mount_transport",
  );
  assert.equal(
    refusalOf(compile("builder.move_to_tile({ x: 10 });")),
    "plan_script_missing_argument:move_to_tile.y:integer[whole]:snapshot.tile.y",
  );
  assert.equal(
    refusalOf(compile("builder.move_to_tile({ x: '10', y: 10 });")),
    "plan_script_argument_not_canonical:move_to_tile.x:integer[whole]:snapshot.tile.x:got:string(10)",
  );
  // A real action that the Mod declares read-only has no method at all, and the refusal names it: a plan is made of
  // executions, and an observation is not a step the Mod can run.
  assert.equal(refusalOf(compile("builder.observe_scene({});")), "plan_script_unknown_action:observe_scene");
});

/**
 * THE REFUSAL IS THE ONLY PLACE THIS SHAPE IS TAUGHT, SO EVERY ARGUMENT REFUSAL ANSWERS THREE THINGS.
 *
 * Measured 2026-10-31 (`round18`): 9 of 66 plans were refused for reasons the model could not have known, and the five
 * worst were `pickup_forage` calls whose `{ observationId, ref }` the model had written BY HAND - because the refusal
 * named the field and nothing else, so guessing was the only way to comply. Every answer below is therefore
 * `<code>:<actionId>.<argument>:<what it must be>:<where the value is published>`, and these gates read the catalog's
 * own argument list rather than a hand-written one: every plannable action, every declared argument, and the source an
 * answer names has to RESOLVE in the snapshot the script was handed.
 */

/** One declared argument, as the surface publishes it. */
type DeclaredArgument = Readonly<{ name: string; type: string; enum?: readonly string[] }>;

/**
 * The snapshot the argument-surface gates hand the compiler: one live row per family, carrying the field names each
 * family really publishes (`harvestTargets` carries `qualifiedHarvestItemId`, not `qualifiedItemId`).
 */
const SOURCE_SNAPSHOT: Partial<Snapshot> = {
  currentTool: "(T)WateringCan",
  currentToolSlot: 0,
  currentToolSlotItem: "(T)WateringCan",
  toolSlots: [{ slot: 0, label: "(T)WateringCan", upgradeLevel: 0, category: "watering_can" }],
  cropTargets: [{ targetId: "crop_01", x: 11, y: 10, cropId: "spring_onion", displayName: "Parsnip" }],
  forageTargets: [{ targetId: "forage_01", x: 12, y: 10, qualifiedItemId: "(O)22", displayName: "Daffodil", stack: 1 }],
  itemTargets: [{ targetId: "item_01", x: 13, y: 10, qualifiedItemId: "(O)390", displayName: "Stone", stack: 1 }],
  harvestTargets: [
    {
      targetId: "harvest_01",
      x: 14,
      y: 10,
      cropId: "spring_onion",
      qualifiedHarvestItemId: "(O)24",
      displayName: "Parsnip",
      regrowsAfterHarvest: false,
    },
  ],
  seedTargets: [
    { targetId: "seed_01", slot: 2, x: 15, y: 10, qualifiedItemId: "(O)472", displayName: "Parsnip Seeds" },
  ],
  debrisTargets: [debris("debris_01", 3, "pickaxe")],
  chests: [
    {
      chestId: "chest_0123456789abcdef",
      x: 9,
      y: 10,
      displayName: "Chest",
      isFridge: false,
      items: [{ slot: 0, qualifiedItemId: "(O)388", displayName: "Wood", stack: 40 }],
    },
  ],
  pendingLevelUpChoices: [
    {
      skill: 0,
      level: 5,
      leftId: 20,
      leftTitle: "Rancher",
      leftDescription: "ranch",
      rightId: 21,
      rightTitle: "Tiller",
      rightDescription: "crops",
    },
  ],
  warps: [{ sourceX: 3, sourceY: 12, targetLocation: "Town", targetX: 40, targetY: 12, accessible: true }],
};

/** A literal of the declared KIND, so a call reaches the check under test instead of failing earlier. */
function sampleLiteral(declaration: DeclaredArgument): string {
  if (declaration.type === "integer") return "1";
  if (declaration.type === "boolean") return "true";
  if (declaration.type === "destination_selector") return "{ kind: 'label', label: 'Mine' }";
  return `'${declaration.enum?.[0] ?? "sample_text"}'`;
}

/** A value of a DIFFERENT kind than the declaration asks for: what a wrong-typed script passes, and what the answer says. */
function wrongKindLiteral(declaration: DeclaredArgument): Readonly<{ literal: string; received: string }> {
  if (declaration.type === "integer") return { literal: "'not_a_number'", received: "string(not_a_number)" };
  if (declaration.type === "boolean") return { literal: "'yes'", received: "string(yes)" };
  if (declaration.type === "destination_selector") return { literal: "'Bus Stop'", received: "string(Bus Stop)" };
  return { literal: "42", received: "number(42)" };
}

/**
 * `builder.<actionId>({ ... })` for one published action, with what this test chooses to omit, override or add - and the
 * binding the surface demands, with one sampled value per property it lists.
 */
function callScript(
  action: PublishedPlanAction,
  options: Readonly<{
    omit?: readonly string[];
    values?: Readonly<Record<string, string>>;
    add?: Readonly<Record<string, string>>;
  }> = {},
): string {
  const omit = options.omit ?? [];
  const parts: string[] = [];
  for (const argument of action.arguments)
    if (!omit.includes(argument.name))
      parts.push(`${argument.name}: ${options.values?.[argument.name] ?? sampleLiteral(argument)}`);
  for (const [name, literal] of Object.entries(options.add ?? {})) parts.push(`${name}: ${literal}`);
  return `builder.${action.actionId}({ ${parts.join(", ")} });`;
}

/** Whether a `snapshot.<family>[].<field>` path an answer names really resolves in the snapshot the script was handed. */
function snapshotPublishes(source: unknown, path: string): boolean {
  const segments = path.split(".");
  if (segments[0] !== "snapshot") return false;
  let current: unknown = source;
  for (const segment of segments.slice(1)) {
    const rows = segment.endsWith("[]");
    const key = rows ? segment.slice(0, -2) : segment;
    if (typeof current !== "object" || current === null) return false;
    const holder = current as Record<string, unknown>;
    if (!Object.hasOwn(holder, key)) return false;
    current = holder[key];
    if (!rows) continue;
    if (!Array.isArray(current)) return false;
    const first = current.find((entry) => typeof entry === "object" && entry !== null);
    if (first === undefined) return false;
    current = first;
  }
  return true;
}

/** The two halves of an answer that are not the reason code's family or its argument: what, and where from. */
function answerOf(code: string, prefix: string): Readonly<{ expects: string; from: string }> {
  if (!code.startsWith(prefix)) throw new Error(`expected ${prefix}..., received ${code}`);
  const rest = code.slice(prefix.length);
  const at = rest.lastIndexOf(":");
  if (at <= 0) throw new Error(`${code} carries no "what it must be" and "where from" pair`);
  return { expects: rest.slice(0, at), from: rest.slice(at + 1) };
}

/** The three source kinds an answer may name when the value is not a path into the snapshot. */
const NAMED_SOURCES = Object.freeze(["observe_scene", "find_destination", "not_in_snapshot"]);

/**
 * THE TILE CLAIMS A READING'S OMISSION MAY BE ANSWERED WITH, one name per claim, because they are different facts:
 *
 *   `..._target_not_in_the_submitted_snapshot` - INSIDE the window, the family measured her tile and lists nothing;
 *   `..._target_outside_the_read` - OUTSIDE it, and nothing this session read names the tile;
 *   `..._reading_outside_the_submitted_snapshot` - the read names the tile, but this action's value has to be copied
 *     out of a snapshot that does not reach it and the Mod does not mint it at execution.
 *
 * A call naming a tile the snapshot cannot speak about is answered about the TILE rather than about the argument she
 * omitted - the order the snapshot claim has always had here - so every gate below that asks "what did her omission
 * earn" has to recognise all three, and none of them may be folded into another.
 */
const TARGET_TILE_CLAIM =
  /^plan_script_(?:target_not_in_the_submitted_snapshot|target_outside_the_read|reading_outside_the_submitted_snapshot):[A-Za-z._]+:[^:]+/u;

/**
 * The gate the measured refusals asked for: for EVERY action whose surface declares an argument, omitting that argument
 * must answer with the argument, what it must be, and where the value is published - and that source must be a path the
 * snapshot really resolves, or one of the two read-only answers / the explicit "the snapshot does not carry it".
 */
test("every declared argument, omitted, is refused with what it must be and where the value is published", () => {
  const withArguments = ACTIONS.filter((action) => action.arguments.length > 0);
  assert.ok(withArguments.length > 50, "the surface declares arguments on most of its actions");
  const faults: string[] = [];
  for (const action of withArguments)
    for (const argument of action.arguments) {
      const subject = `${action.actionId}.${argument.name}`;
      const result = compile(callScript(action, { omit: [argument.name] }), { ...SOURCE_SNAPSHOT });
      const code = result.status === "compiled" ? "accepted" : result.reasonCode;
      const prefix = `plan_script_missing_argument:${subject}:`;
      // A READING IS NOT HERS TO WRITE, so an omission of one has three legal answers and the first is the best: the row
      // answered it (`accepted`), the family is published and holds no such row (the refusal that names both), or the
      // family is not published at all and the snapshot cannot answer - which is the missing-argument answer below.
      if (!code.startsWith(prefix)) {
        if (PLAN_SNAPSHOT_READINGS.has(argument.name) && (code === "accepted" || TARGET_TILE_CLAIM.test(code)))
          continue;
        faults.push(`${subject}: expected ${prefix}..., received ${code}`);
        continue;
      }
      const answer = answerOf(code, prefix);
      // (b) what was expected: the declared type, and every value of a declared closed set.
      if (!answer.expects.includes(argument.type) && argument.type !== "destination_selector")
        faults.push(`${subject}: ${answer.expects} does not name the declared type ${argument.type}`);
      if (argument.type === "destination_selector" && !answer.expects.includes("destination_selector"))
        faults.push(`${subject}: ${answer.expects} does not name the destination selector`);
      for (const value of argument.enum ?? [])
        if (!answer.expects.includes(value))
          faults.push(`${subject}: ${answer.expects} does not name the declared value ${value}`);
      // (c) where the value comes from: a path the snapshot resolves, or the explicit non-snapshot answer.
      if (!(NAMED_SOURCES.includes(answer.from) || snapshotPublishes(snapshot(SOURCE_SNAPSHOT), answer.from)))
        faults.push(`${subject}: ${answer.from} is neither a resolvable snapshot path nor a named source`);
    }
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * The same population against a snapshot that publishes almost nothing: the answer must still say where the value is,
 * and a path it names must still resolve. A refusal that invents `snapshot.something` on a sparse world would be worse
 * than one that says nothing, because it is the answer a model acts on.
 */
test("a sparse snapshot changes the source, never the shape of the answer", () => {
  const sparse = snapshot();
  const faults: string[] = [];
  for (const action of ACTIONS.filter((candidate) => candidate.arguments.length > 0))
    for (const argument of action.arguments) {
      const result = compilePlanScript(
        { script: callScript(action, { omit: [argument.name] }) },
        { snapshot: sparse, actions: ACTIONS },
      );
      const code = result.status === "compiled" ? "accepted" : result.reasonCode;
      const prefix = `plan_script_missing_argument:${action.actionId}.${argument.name}:`;
      if (!code.startsWith(prefix)) {
        if (PLAN_SNAPSHOT_READINGS.has(argument.name) && (code === "accepted" || TARGET_TILE_CLAIM.test(code)))
          continue;
        faults.push(`${action.actionId}.${argument.name}: ${code}`);
        continue;
      }
      const { from } = answerOf(code, prefix);
      if (!(NAMED_SOURCES.includes(from) || snapshotPublishes(sparse, from)))
        faults.push(`${action.actionId}.${argument.name}: ${from} does not resolve on a sparse snapshot`);
    }
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * The two measured item-id refusals, asserted exactly: `pickup_item`'s row publishes `qualifiedItemId`, and
 * `harvest_crop`'s publishes `qualifiedHarvestItemId`. The second is why the field is DERIVED rather than looked up by
 * name - a refusal that could only repeat the argument would leave the model to guess a name it cannot see.
 */
test("the measured item-id refusals point at the row field that actually carries the value", () => {
  assert.equal(
    refusalOf(compile("builder.pickup_item({ x: 13, y: 10, expectedTargetId: 'item_01' });", { ...SOURCE_SNAPSHOT })),
    "plan_script_missing_argument:pickup_item.expectedQualifiedItemId:string:snapshot.itemTargets[].qualifiedItemId",
  );
  assert.equal(
    refusalOf(
      compile("builder.harvest_crop({ x: 14, y: 10, expectedTargetId: 'harvest_01' });", { ...SOURCE_SNAPSHOT }),
    ),
    "plan_script_missing_argument:harvest_crop.expectedQualifiedItemId:string:snapshot.harvestTargets[].qualifiedHarvestItemId",
  );
});

/**
 * The `water_crop` + `slot` refusal, which is CORRECT and used to be unhelpful: an argument this action does not take must
 * answer with the set it does take, and - because an invented argument is nearly always a name carried over from another
 * action - with the actions that really declare it.
 */
test("an unknown argument names the allowed set and the actions that do declare it", () => {
  const faults: string[] = [];
  for (const action of ACTIONS) {
    const allowed = action.arguments.length === 0 ? "none" : action.arguments.map((entry) => entry.name).join(",");
    const code = refusalOf(compile(callScript(action, { add: { notAnArgument: "1" } })));
    const expected = `plan_script_unknown_argument:${action.actionId}.notAnArgument:allowed:${allowed}:declared_by:none`;
    if (code !== expected) faults.push(`${action.actionId}: expected ${expected}, received ${code}`);
  }
  assert.deepEqual(faults, [], faults.join("\n"));

  const waterCrop = ACTIONS.find((action) => action.actionId === "water_crop");
  assert.ok(waterCrop, "water_crop is plannable");
  const slot = refusalOf(compile(callScript(waterCrop, { add: { slot: "0" } })));
  assert.equal(
    slot,
    "plan_script_unknown_argument:water_crop.slot:allowed:x,y,expectedTargetId,charge:declared_by:use_raft,plant_seed,fertilize_tile",
  );
  // Every action the answer names really declares a `slot`, so the correction is a fact the caller can check.
  for (const owner of slot.split(":declared_by:")[1]!.split(","))
    assert.ok(
      ACTIONS.find((action) => action.actionId === owner)?.arguments.some((argument) => argument.name === "slot"),
      `${owner} declares a slot`,
    );
});

/**
 * A wrong KIND is refused with the four facts a guess needs: which argument, what it must be, where the right value is,
 * and what the script actually passed. `travel({ x: 12.5 })` was refused `argument_not_canonical:travel.x` and the model
 * could not tell a rounding slip from the wrong field from the wrong action.
 */
test("a value of the wrong kind names the argument, its expectation, its source and what was passed", () => {
  const faults: string[] = [];
  for (const action of ACTIONS.filter((candidate) => candidate.arguments.length > 0))
    for (const argument of action.arguments) {
      const subject = `${action.actionId}.${argument.name}`;
      const wrong = wrongKindLiteral(argument);
      const result = compile(callScript(action, { values: { [argument.name]: wrong.literal } }), {
        ...SOURCE_SNAPSHOT,
      });
      const code = result.status === "compiled" ? "accepted" : result.reasonCode;
      const prefix = `plan_script_argument_not_canonical:${subject}:`;
      if (!code.startsWith(prefix)) {
        faults.push(`${subject}: expected ${prefix}..., received ${code}`);
        continue;
      }
      const { expects, from } = answerOf(code.slice(0, code.lastIndexOf(":got:")), prefix);
      if (!expects.includes(argument.type) && argument.type !== "destination_selector")
        faults.push(`${subject}: ${expects} does not name the declared type ${argument.type}`);
      if (!(NAMED_SOURCES.includes(from) || snapshotPublishes(snapshot(SOURCE_SNAPSHOT), from)))
        faults.push(`${subject}: ${from} is neither a resolvable snapshot path nor a named source`);
      const got = code.slice(code.lastIndexOf(":got:") + ":got:".length);
      if (got !== wrong.received) faults.push(`${subject}: expected got:${wrong.received}, received got:${got}`);
    }
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * The read-only name a refusal sends the caller to must be a name the surface publishes.
 *
 * `find_destination` is not a plan step - it is read-only, so the builder generates no method for it - which is why the
 * refusal has to spell it. Read from the artifact, so a rename fails here instead of in a refusal that points at
 * nothing.
 */
test("the refusal's named source is a published read-only action", () => {
  assert.equal(
    SURFACE.find((action) => action.actionId === "find_destination")?.kind,
    "read_only",
    "find_destination is a published read-only action, so a refusal may name it",
  );
});

test("a builder method is generated for exactly the lifecycles the Mod's Body Program catalog admits", () => {
  const generated = ACTIONS.map((action) => action.actionId);
  for (const actionId of ["move_to_tile", "water_crop", "harvest_crop", "pickup_forage"])
    assert.ok(generated.includes(actionId), `${actionId} must be callable from a plan`);
  // `live_verified` is an admission, not a draft: the action really ran on the target game version and produced a
  // native receipt, so the Mod accepts it as a node. A Host gate that dropped it refused plans the Mod accepts, and
  // the companion then had no way to name those actions except one flat tool call per step.
  for (const actionId of ["clear_debris", "cut_weeds", "talk_to_npc"])
    assert.ok(generated.includes(actionId), `${actionId} is live-verified and must be callable from a plan`);
  // The one lifecycle-admitted action that is NOT here, and the reason is its kind rather than its rung: the registry
  // declares `express_emote` (and `face_direction`) expression-only, so a gesture reaches the actor through its own
  // mounted tool and this vocabulary excludes it - one route per action, never two (`action-route-gate.test.ts`).
  for (const actionId of EXPRESSION_ONLY_ACTION_IDS) {
    assert.ok(
      !generated.includes(actionId),
      `${actionId} is declared expression-only, so it must not also be a plan step the model can write`,
    );
    assert.ok(
      SURFACE.some((action) => action.actionId === actionId),
      `${actionId} is declared expression-only but the Mod publishes no such action, so the exception exempts nothing`,
    );
  }
  // Every generated method's argument list is the surface's own declaration, name for name.
  const declared = new Map(
    SURFACE.map((action) => [action.actionId, Object.keys(action.argumentSchema ?? {})] as const),
  );
  for (const action of ACTIONS)
    assert.deepEqual(
      action.arguments.map((argument) => argument.name),
      declared.get(action.actionId),
    );
});

/**
 * The Mod's own Body Program catalog is the authority for what a node may name, so this test reads it rather than
 * restating it: whatever lifecycles the C# projection admits, the builder must generate, and whatever it refuses,
 * the builder must refuse. A future divergence between the two fails here instead of in a live run.
 */
const MOD_PROJECTION = readFileSync(
  resolve(hostRoot, "../integrations/stardew/src/Core/BodyPrograms/FarmhandBodyProgramCatalogProjection.cs"),
  "utf8",
);
const MOD_LIFECYCLE_WIRE = readFileSync(
  resolve(hostRoot, "../integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
  "utf8",
);

/** The enum-to-wire map the Mod publishes with, straight from its own source. */
const MOD_LIFECYCLE_VALUES: readonly string[] = [
  ...MOD_LIFECYCLE_WIRE.matchAll(/FarmhandActionLifecycle\.([A-Za-z]+) => "([a-z_]+)"/gu),
].map((match) => match[2] as string);

/** The lifecycles `FarmhandBodyProgramCatalogProjection.TryProject` admits, read from its own condition. */
function modAdmittedLifecycles(): readonly string[] {
  const at = MOD_PROJECTION.indexOf("if (source.Lifecycle != ");
  assert.notEqual(at, -1, "the Mod's lifecycle admission condition is in the source");
  const condition = MOD_PROJECTION.slice(at, MOD_PROJECTION.indexOf("{", at));
  const wire = new Map(
    [...MOD_LIFECYCLE_WIRE.matchAll(/FarmhandActionLifecycle\.([A-Za-z]+) => "([a-z_]+)"/gu)].map(
      (match) => [match[1], match[2]] as const,
    ),
  );
  return [...condition.matchAll(/FarmhandActionLifecycle\.([A-Za-z]+)\.ToWireValue\(\)/gu)].map((match) => {
    const lifecycle = wire.get(match[1] as string);
    assert.ok(lifecycle !== undefined, `${match[1]} has a wire value in the Mod's own map`);
    return lifecycle;
  });
}

const registrationWith = (lifecycle: string, actionId = "move_to_tile"): ActionRegistration => ({
  actionId,
  familyId: "movement_navigation",
  identityVersion: 1,
  lifecycle: lifecycle as ActionRegistration["lifecycle"],
  kind: "execution",
  descriptor: { argumentSchema: { x: { type: "integer" }, y: { type: "integer" } } },
});

test("the builder admits and refuses exactly the lifecycles the Mod's catalog does", () => {
  const admitted = modAdmittedLifecycles();
  assert.ok(admitted.length > 0, "the Mod's admission condition was read, not assumed");
  for (const lifecycle of admitted)
    assert.deepEqual(
      planActionsFromRegistrations([registrationWith(lifecycle)]).map((action) => action.actionId),
      ["move_to_tile"],
      `${lifecycle} is admitted by the Mod's Body Program catalog, so the builder must generate it`,
    );
  const refused = MOD_LIFECYCLE_VALUES.filter((lifecycle) => !admitted.includes(lifecycle));
  assert.ok(refused.length > 0, "the Mod refuses at least one lifecycle, so the refusal side is exercised");
  for (const lifecycle of refused)
    assert.deepEqual(
      planActionsFromRegistrations([registrationWith(lifecycle)]),
      [],
      `${lifecycle} is not a Body Program node the Mod accepts, so the builder must not generate it`,
    );
});

test("a refused call is reported instead of swallowed, and a clock or a throw is named", () => {
  // A try/catch around the builder cannot turn a refused step into a silently shorter plan: the refusal is answered at
  // the call boundary and never thrown into the script, so the script's own catch sees nothing - and when the script is
  // done the plan is refused, with the call named and the walk beside it accounted for as one that compiled. Silently
  // shorter was the danger; named and refused is the point.
  const swallowed = compile(`
try { builder.move_to_tile({ x: 10, y: 10, unexpected: 1 }); } catch (error) {}
builder.move_to_tile({ x: 11, y: 10 });
`);
  assert.deepEqual(rejectionsOf(swallowed), [
    {
      call: 1,
      actionId: "move_to_tile",
      reasonCode: "plan_script_unknown_argument:move_to_tile.unexpected:allowed:x,y:declared_by:none",
    },
  ]);
  assert.deepEqual(accountOf(swallowed).dropped, [
    "n01:plan_script_unknown_argument:move_to_tile.unexpected:allowed:x,y:declared_by:none",
  ]);
  assert.deepEqual(accountOf(swallowed).acceptedSteps, ["n02"], "the walk she wrote second did compile");
  assert.equal(refusalOf(compile("throw new TypeError('nope');")), "plan_script_threw:TypeError");
  // A script that never returns is still stopped by the bound - the bound was never the thing to remove - and the answer
  // names the whole measurement instead of one window of it. The elapsed reading is the point: two windows were spent,
  // which is the fact that separates "this script did not return" from "one window was taken from it".
  const runawayStartedAt = performance.now();
  assert.equal(refusalOf(compile("while (true) {}")), TIMEOUT_CODE);
  const runawayMs = performance.now() - runawayStartedAt;
  assert.ok(
    runawayMs >= BUDGET_TOTAL_MS - 10,
    `the runaway was stopped after ${runawayMs.toFixed(0)} ms, short of the ${BUDGET_TOTAL_MS} ms both windows must spend`,
  );
  assert.equal(refusalOf(compile("   ")), "plan_script_invalid");
  assert.equal(refusalOf(compile("const nothing = 1;")), "plan_script_empty_no_builder_call");
});

/**
 * WALL CLOCK MEASURES THE MACHINE, SO A COMPILE THAT OUTLIVES A WINDOW IS RE-MEASURED, NOT ACCUSED.
 *
 * <p>
 * The 50 ms window this replaces answered `plan_script_timeout:50` for a script that does 56 ms of arithmetic and then
 * returns a plan: no loop that cannot terminate, nothing to fix, and a refusal that told the companion her plan was
 * slow. That exact shape is the first half of this test, and it must come back with the plan.
 * </p>
 * <p>
 * The second half reaches the same condition with work whose size depends on the machine: the burn is grown HERE, by
 * 1.5x steps, until one compile really outlives the first window - so this test does not pin an iteration count that is
 * a pause on one box and a program on another. Whichever count outlives it must come back with a PLAN from the second
 * window, and never with `plan_script_timeout`: that code is reserved for a script that outlived every window, which is
 * the only reading wall clock can support.
 * </p>
 */
test("a compile slowed past a window is re-measured rather than refused as a plan defect", () => {
  const burn = (iterations: number) =>
    `let carried = 0;\n` +
    `for (let index = 0; index < ${iterations}; index += 1) carried = (carried + index) % 997;\n` +
    `builder.move_to_tile({ x: 12, y: 8 });\n`;

  // 20M iterations of that loop measured ~56 ms on the machine this was written on: the burn the old window refused.
  const slowedStartedAt = performance.now();
  const slowed = compile(burn(20_000_000));
  const slowedMs = performance.now() - slowedStartedAt;
  assert.ok(
    slowed.status === "compiled",
    `a ${slowedMs.toFixed(0)} ms compile of a finite script answered ${slowed.status === "compiled" ? "" : slowed.reasonCode}`,
  );
  assert.equal(slowed.program.nodes.length, 1, "the step written after the burn is the program that compiled");

  const firstWindowMs = PLAN_SCRIPT_BUDGET_MS[0]!;
  // The target is 1.5x the first window rather than the window itself: a compile that expired reads as `window + work`,
  // so reaching this reading is what proves the first window really went, not a work time that happened to fit.
  const outlivesMs = Math.ceil(firstWindowMs * 1.5);
  let iterations = 500_000;
  let elapsedMs = 0;
  do {
    const startedAt = performance.now();
    const measured = compile(burn(iterations));
    elapsedMs = performance.now() - startedAt;
    if (measured.status !== "compiled")
      assert.fail(`${iterations} iterations in ${elapsedMs.toFixed(0)} ms answered ${measured.reasonCode}`);
    assert.equal(measured.program.nodes.length, 1, `the step after a ${iterations}-iteration burn is the program`);
    iterations = Math.ceil(iterations * 1.5);
  } while (elapsedMs < outlivesMs);
  assert.ok(
    elapsedMs >= outlivesMs,
    `no compile outlived the ${firstWindowMs} ms first window, so the re-measurement was never exercised`,
  );
  assert.ok(
    elapsedMs < BUDGET_TOTAL_MS,
    `the burn reached ${elapsedMs.toFixed(0)} ms, past both windows (${BUDGET_TOTAL_MS} ms), so it was not a fit test`,
  );
});

/**
 * A script that does not compile is the one refusal no builder call can explain: `plan_script_threw:SyntaxError`
 * alone says something is wrong somewhere in eight kilobytes of script, which is the state a weak model cannot leave
 * in one turn. So the answer carries the engine's own words and the line they point at, in the script's own numbering.
 */
test("a script that throws answers with the engine's own message and the line it named", () => {
  const threwOf = (result: CompiledPlan) => {
    if (result.status !== "refused") assert.fail(`expected a refusal, received ${result.status}`);
    return result.threw;
  };
  const unparsed = compile("const steps = 2;\nbuilder.move_to_tile({ x: 10, y: 10 );");
  assert.equal(refusalOf(unparsed), "plan_script_threw:SyntaxError");
  assert.equal(threwOf(unparsed)?.line, 2, "the line is the script's own, not the wrapper's");
  assert.ok((threwOf(unparsed)?.message.length ?? 0) > 0, "the parser's own message reaches the caller");
  assert.notEqual(threwOf(unparsed)?.message, "SyntaxError", "the error's name is not an account of it");

  // A runtime throw is the same seam, and its message is the script's own text.
  const raised = compile("const steps = 2;\nthrow new TypeError('bad loop');");
  assert.equal(refusalOf(raised), "plan_script_threw:TypeError");
  assert.deepEqual(threwOf(raised), { message: "bad loop", line: 2 });

  // An unclosed group is reported at the wrapper's closing line, which is not a line of the script: the answer
  // says it has no line instead of naming one the companion would search for and not find.
  assert.equal(threwOf(compile("const steps = 2;\n}"))?.line, null);
  // A script that never ran has no account to give.
  assert.equal(threwOf(compile("   ")), undefined);
});

test("an empty plan says whether the script never asked for a step or asked and added none", () => {
  // A filter that matched nothing is the measured case: six plans in one run answered `plan_script_empty`, which
  // told the companion neither that its loop body never ran nor that its calls were refused. Zero builder calls is
  // the first of those, said by name.
  assert.equal(
    refusalOf(compile("const rows = snapshot.cropTargets ?? [];\nconst count = rows.length;")),
    "plan_script_empty_no_builder_call",
  );
  // The other shape: the builder WAS called and added no node (`equipFor` answered a slot). The
  // count is the point - `no_builder_call` and `no_node_added:1` are different mistakes with different repairs.
  assert.equal(
    refusalOf(
      compile("builder.equipFor('cut_weeds');", {
        currentToolSlot: 3,
        toolSlots: [{ slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" }],
      }),
    ),
    "plan_script_empty_no_node_added:1",
  );
  // A swallowed refusal is still the refusal, and it names more than the count would: the call, the argument and
  // where a legal value comes from. The split must not hide it behind `no_node_added`. The argument is
  // `remove_placed_item`'s and not one the Mod mints at execution: a reading the MOD answers for
  // (`ResolvedAtExecution`) is no longer a refusal at all, and pinning this rule on one would pin the product's
  // declaration instead of the compiler's.
  assert.match(
    refusalOf(
      compile(
        "try { builder.remove_placed_item({ x: 5, y: 6 }); } catch (error) {}\nbuilder.equipFor('cut_weeds');",
        {
          currentToolSlot: 3,
          toolSlots: [{ slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" }],
        },
      ),
    ),
    /^plan_script_missing_argument:remove_placed_item\.expectedTargetId:/u,
  );
  // And the split does not touch the happy path: one added node is a plan.
  assert.equal(nodesOf(compile("builder.move_to_tile({ x: 4, y: 9 });")).length, 1);
});

test("a plan with no snapshot refuses rather than compiling from nothing", () => {
  const result = compilePlanScript(
    { script: "builder.move_to_tile({ x: 1, y: 1 });" },
    { snapshot: null, actions: ACTIONS },
  );
  assert.equal(refusalOf(result), "plan_snapshot_unavailable");
});

test("the script cannot mutate the snapshot the Host handed it", () => {
  assert.equal(
    refusalOf(
      compile(
        `
snapshot.revision = 999;
builder.move_to_tile({ x: 10, y: 10 });
`,
      ),
    ),
    "plan_script_threw:TypeError",
  );
  assert.equal(snapshot().revision, 11, "the live snapshot object is untouched");
});

test("a destination selector argument is compiled in the typed shape the wire declares", () => {
  const nodes = nodesOf(compile("builder.navigate_to_destination({ destination: { kind: 'label', label: 'Mine' } });"));
  assert.deepEqual(nodes[0]!.arguments.destination, {
    type: "destination_selector",
    destination: { kind: "label", label: "Mine" },
  });
});

/**
 * The refusal is the teaching surface now that no per-action tool carries a schema: a builder call that names the wrong
 * argument, drops one, or supplies the wrong kind must answer with the action's OWN declared arguments - read back here
 * from the artifact, so a hand-written list cannot drift from what the Mod enforces.
 */
test("a refused builder call answers with the action id, its required argument names and their kinds", () => {
  const required = surfaceArguments("cut_weeds");
  assert.ok(required.length >= 2, "cut_weeds declares more than one argument");
  for (const script of [
    // A GENUINELY REQUIRED ARGUMENT, because the two the tile could answer are not required any more: `cut_weeds`
    // declares both `slot` and `expectedTargetId` resolved at execution, so omitting either is the plan doing what the
    // Mod's own row allows (`body-program-script.test.ts`, "the same strip of clear nodes compiles"). The tile itself is
    // what a swing cannot be written without, and this is the refusal that still has to carry the whole shape.
    "builder.cut_weeds({ y: 10 });",
    "builder.cut_weeds({ x: 10, y: 10, slot: 3, expectedTargetId: 'weed_01', targetId: 'weed_01' });",
    "builder.cut_weeds({ x: 10, y: 10, slot: 'first', expectedTargetId: 'weed_01' });",
  ])
    assert.deepEqual(requirementOf(compile(script)), {
      actionId: "cut_weeds",
      requiredArguments: required,
      resourceClaims: surfaceClaims("cut_weeds"),
      // Which family its targets come from travels with the refusal, because the plan compiler reads it: it is the
      // surface's statement that this step addresses a piece of world at its tile (`targetFamily` -> `weedTargets`).
      targetFamily: "weedTargets",
    });

  // A closed set travels with the argument that declares it, so the refusal can name the values a guess must be one of.
  const choice = requirementOf(compile("builder.respond_level_up({ choice: 'left' });"));
  assert.deepEqual(choice, {
    actionId: "respond_level_up",
    requiredArguments: surfaceArguments("respond_level_up"),
    resourceClaims: surfaceClaims("respond_level_up"),
    targetFamily: "pendingLevelUpChoices",
  });
  assert.deepEqual(choice?.requiredArguments.find((argument) => argument.name === "choice")?.enum, [
    "confirm",
    "branch_a",
    "branch_b",
  ]);
});

/** `stardew_plan_shape` answers from this function, so its answer is the surface's own vocabulary, not a second copy. */
test("plan_shape names the surface's own arguments, output facts and resource claims for one action", () => {
  const cutWeeds = planShape(ACTIONS, { actionIds: ["cut_weeds"] });
  assert.ok(cutWeeds.ok, "cut_weeds is a plannable action");
  assert.deepEqual(
    cutWeeds.actions.map((action) => action.actionId),
    ["cut_weeds"],
  );
  assert.deepEqual(
    cutWeeds.actions[0]!.arguments.map((argument) => argument.name),
    Object.keys(SURFACE.find((action) => action.actionId === "cut_weeds")!.argumentSchema ?? {}),
  );
  assert.deepEqual(cutWeeds.actions[0]!.arguments, surfaceArguments("cut_weeds"));

  const inspect = planShape(ACTIONS, { actionIds: ["machine_inspect"] });
  assert.ok(inspect.ok);
  assert.deepEqual(inspect.actions[0]!.outputFacts, [{ name: "machine_target_id", type: "string" }]);
  assert.deepEqual(
    inspect.actions[0]!.resourceClaims,
    SURFACE.find((action) => action.actionId === "machine_inspect")!.resourceTemplate!.claims.map((claim) => ({
      key: claim.key,
      value: claim.value,
    })),
  );
});

test("plan_shape answers a whole family, and a selector that names nothing with what does exist", () => {
  const family = planShape(ACTIONS, { family: "fixture_family" });
  assert.ok(family.ok);
  assert.deepEqual(
    family.actions.map((action) => action.actionId),
    ACTIONS.map((action) => action.actionId),
  );

  assert.deepEqual(planShape(ACTIONS, {}), { ok: false, reasonCode: "plan_shape_selector_invalid" });
  assert.deepEqual(planShape(ACTIONS, { actionIds: ["cut_weeds"], family: "fixture_family" }), {
    ok: false,
    reasonCode: "plan_shape_selector_invalid",
  });
  const unknown = planShape(ACTIONS, { actionIds: ["brew_potion"] });
  assert.ok(!unknown.ok);
  assert.equal(unknown.reasonCode, "plan_shape_unknown_action:brew_potion");
  // The ids it offers are the vocabulary's own head, bounded: a wrong name teaches without spending the turn on all of it.
  assert.deepEqual(
    unknown.legalActionIds,
    ACTIONS.slice(0, 20).map((action) => action.actionId),
  );
  const unknownFamily = planShape(ACTIONS, { family: "brewing" });
  assert.ok(!unknownFamily.ok);
  assert.equal(unknownFamily.reasonCode, "plan_shape_unknown_family:brewing");
  assert.deepEqual(unknownFamily.legalFamilies, ["fixture_family"]);
});

/**
 * The companion used to guess the tool (`scythe` for weeds, `pickaxe` for rocks) and the slot from tool order, and got
 * ``cut_weeds`` right by luck and ``break_rock_source`` wrong. So the shape answer carries the tool the surface itself
 * declares - for every action, never omitted - and never invents one for an action whose surface is silent.
 */
test("plan_shape reports the tool the surface declares, and tool_requirement_undeclared when it declares none", () => {
  const withClaims = (actionId: string, claims: readonly Readonly<{ key: string; value: string }>[]) =>
    Object.freeze({
      actionId,
      familyId: "resource_gathering",
      identityVersion: 1,
      lifecycle: "live_verified" as const,
      kind: "execution" as const,
      descriptor: Object.freeze({
        argumentSchema: {
          x: { type: "integer" },
          y: { type: "integer" },
          slot: { type: "integer" },
          expectedTargetId: { type: "string" },
        },
        resourceTemplate: Object.freeze({ claims: Object.freeze(claims.map((claim) => Object.freeze(claim))) }),
      }),
    });
  const actions = planActionsFromRegistrations([
    // The Mod's own two words for the level half of a `tool:<category>` claim, verbatim from its claim value.
    withClaims("cut_weeds", [
      { key: "embodied_actor", value: "ScopePlayer" },
      { key: "tool:scythe", value: "AnyUpgrade" },
    ]),
    withClaims("break_rock", [
      { key: "embodied_actor", value: "ScopePlayer" },
      { key: "tool:pickaxe", value: "BasicOnly" },
    ]),
    // Declares its embodied actor and nothing about a tool: the surface is silent, and the answer says so by name.
    withClaims("chop_tree", [{ key: "embodied_actor", value: "ScopePlayer" }]),
    // A word the Host cannot translate is passed through as declared rather than dropped or guessed at.
    withClaims("dig_artifact_spot", [{ key: "tool:hoe", value: "SomeFutureWord" }]),
  ]);

  const shapeOf = (actionId: string) => {
    const shape = planShape(actions, { actionIds: [actionId] });
    assert.ok(shape.ok, `${actionId} is plannable`);
    return shape.actions[0]!.toolRequirement;
  };
  assert.deepEqual(shapeOf("cut_weeds"), {
    declared: true,
    category: "scythe",
    upgradeRequirement: "AnyUpgrade",
    minimumUpgradeLevel: 0,
    maximumUpgradeLevel: null,
  });
  // "the basic one": the Mod refuses an upgraded pickaxe by name, so a bare `minimumUpgradeLevel` would be a lie.
  assert.deepEqual(shapeOf("break_rock"), {
    declared: true,
    category: "pickaxe",
    upgradeRequirement: "BasicOnly",
    minimumUpgradeLevel: 0,
    maximumUpgradeLevel: 0,
  });
  assert.deepEqual(shapeOf("chop_tree"), { declared: false, reasonCode: "tool_requirement_undeclared" });
  assert.deepEqual(shapeOf("dig_artifact_spot"), {
    declared: true,
    category: "hoe",
    upgradeRequirement: "SomeFutureWord",
    minimumUpgradeLevel: null,
    maximumUpgradeLevel: null,
  });

  // The tool is read off claims only: no category is ever fabricated from an action id. On the artifact's own
  // vocabulary each action answers with the `tool:<category>` claim it publishes, and the one that publishes none
  // answers `tool_requirement_undeclared` - the requirement is read from the surface, never invented from an action id.
  assert.ok(
    ACTIONS.some((action) => action.toolRequirement.declared),
    "the surface declares a tool on some action",
  );
  assert.ok(
    ACTIONS.some((action) => !action.toolRequirement.declared),
    "the surface is silent about a tool on some action",
  );
  for (const action of ACTIONS) {
    assert.ok("toolRequirement" in action, `${action.actionId} carries the field rather than omitting it`);
    const claim = surfaceClaims(action.actionId).find((candidate) => candidate.key.startsWith("tool:"));
    if (claim === undefined) {
      assert.deepEqual(
        action.toolRequirement,
        { declared: false, reasonCode: "tool_requirement_undeclared" },
        `${action.actionId} publishes no tool claim, so the answer is the surface's silence`,
      );
      continue;
    }
    const requirement = action.toolRequirement;
    assert.ok(requirement.declared, `${action.actionId} publishes ${claim.key}`);
    assert.equal(requirement.category, claim.key.slice("tool:".length));
    assert.equal(requirement.upgradeRequirement, claim.value);
  }
});

/**
 * "Is the scythe equipped" cannot be judged statically and the slot index cannot be guessed: the Mod publishes the held
 * tool and the pack's tool slots, so a script reads both from the snapshot it was handed instead of inventing a slot.
 */
test("a script reads the held tool and its slot from the snapshot instead of guessing a slot index", () => {
  // The surface's claim says WHICH tool (`tool:scythe`); the slot stays the actor's own state, read here from the
  // snapshot. Nothing is emitted on the plan for the requirement: the builder writes the call the script wrote.
  const nodes = nodesOf(
    compile(
      `
const held = snapshot.currentTool;
const slot = (snapshot.toolSlots ?? []).find((entry) => entry.label === held);
if (slot === undefined) throw new Error("held_tool_has_no_slot");
builder.cut_weeds({ x: snapshot.tile.x, y: snapshot.tile.y, slot: slot.slot, expectedTargetId: "weed_01" });
`,
      { currentTool: "(T)Scythe", toolSlots: [{ slot: 3, label: "(T)Scythe" }] },
    ),
  );
  assert.deepEqual(nodes[0]!.arguments.slot, { type: "integer", canonicalValue: "3" });
  // One node for one call: declaring the tool is what the surface does, and it is not a step of its own.
  assert.deepEqual(
    nodes.map((node) => node.actionId),
    ["cut_weeds"],
  );
});

/** A live ResourceClump target: where the surface lets the TARGET itself name the tool a hit needs. */
function debris(targetId: string, slot: number, toolKind: string) {
  return { targetId, slot, toolKind, requiredUpgradeLevel: 0, x: 11, y: 12, parentSheetIndex: 600, health: 2 };
}

const TOOL_PACK = [
  { slot: 0, label: "(T)Axe", upgradeLevel: 0 },
  { slot: 3, label: "(T)Pickaxe", upgradeLevel: 0 },
] as const;

test("a plan names a chest and one of the items inside it, out of the container's own state", () => {
  // The round trip the ruling is about: `chests` is entity state, and the two actions take their own safe slice out
  // of it - the container's published id and the item id. Nothing here flattens: the plan reads the container, then
  // decides.
  //
  // These arguments were `slot`, `x`, `y` and `expectedTargetId` until the container became an entity. The compiler
  // refused the old shape with `plan_script_unknown_argument:chest_retrieve.slot`, which is the correct answer and the
  // reason this assertion is worth keeping: it reads the catalog instead of restating a shape by hand.
  const nodes = nodesOf(
    compile(
      `
for (const chest of snapshot.chests ?? []) {
  if (builder.isFull()) break;
  for (const item of chest.items) {
    if (item.qualifiedItemId !== "(O)388") continue;
    builder.chest_retrieve({ chestId: chest.chestId, expectedQualifiedItemId: item.qualifiedItemId });
  }
}
`,
      {
        enabledActionIds: ["chest_retrieve"],
        chests: [
          {
            chestId: "chest_0123456789abcdef",
            x: 9,
            y: 10,
            displayName: "Chest",
            isFridge: false,
            items: [
              { slot: 0, qualifiedItemId: "(O)388", displayName: "Wood", stack: 40 },
              { slot: 1, qualifiedItemId: "(O)390", displayName: "Stone", stack: 7 },
            ],
          },
        ],
      },
    ),
  );
  assert.deepEqual(
    nodes.map((node) => node.actionId),
    ["chest_retrieve"],
  );
  // The node carries the container id and the item id, and nothing else: a tile and a pack slot were the flattened
  // shape's arguments, and the container is now the entity those two facts belong to.
  assert.deepEqual(nodes[0]!.arguments, {
    chestId: { type: "string", canonicalValue: "chest_0123456789abcdef" },
    expectedQualifiedItemId: { type: "string", canonicalValue: "(O)388" },
  });
  // The plan is one the Mod accepts, so the chest’s own id is a legal target id and not a shape only this compiler
  // would produce.
  assert.equal(
    validateBodyProgramCandidateRequest({ programId: planProgramId("session_a", 11, nodes), nodes }),
    null,
    "the compiled plan must be one the Mod accepts",
  );
  // A script may see EVERY item a container holds: the mirror is not shortened on the way in, so a loop over
  // `chest.items` reaches the last one exactly as the Mod published it.
  const everyItem = nodesOf(
    compile(
      `
for (const chest of snapshot.chests ?? []) {
  for (const item of chest.items) {
    builder.move_to_tile({ x: chest.x + item.slot, y: chest.y });
  }
}
`,
      {
        enabledActionIds: ["move_to_tile"],
        chests: [
          {
            chestId: "chest_0123456789abcdef",
            x: 9,
            y: 10,
            displayName: "Chest",
            isFridge: false,
            items: Array.from({ length: MAX_PLAN_NODES }, (_, slot) => ({
              slot,
              qualifiedItemId: `(O)${100 + slot}`,
              displayName: `Item ${slot}`,
              stack: 1,
            })),
          },
        ],
      },
    ),
  );
  assert.equal(everyItem.length, MAX_PLAN_NODES, "every item of a container is visible to the script");
  assert.equal(
    JSON.stringify(everyItem[MAX_PLAN_NODES - 1]!.arguments.x),
    JSON.stringify({ type: "integer", canonicalValue: String(9 + MAX_PLAN_NODES - 1) }),
    "the last item of the container is reachable, so the mirror was not shortened",
  );
});

test("equipFor answers the slot the target declares and writes no step before the action", () => {
  const result = compile(
    `
for (const clump of snapshot.debrisTargets ?? []) {
  const slot = builder.equipFor('clear_debris', clump);
  builder.clear_debris({ slot, x: clump.x, y: clump.y, expectedTargetId: clump.targetId });
}
`,
    {
      currentTool: "(T)Axe",
      currentToolSlot: 0,
      toolSlots: TOOL_PACK,
      debrisTargets: [debris("debris_01", 3, "pickaxe")],
    },
  );
  // NO PRELUDE: the action takes the pickaxe its own claim declares when it runs and puts the axe back afterwards, so a
  // step written before it would be undone by it. The plan is the action alone.
  assert.deepEqual(
    nodesOf(result).map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [["n01", "clear_debris", []]],
  );
  // The action names the target's OWN slot, which is the value equipFor answered.
  assert.deepEqual(nodesOf(result)[0]!.arguments.slot, { type: "integer", canonicalValue: "3" });
  assert.deepEqual(
    accountOf(result).noStepNeeded,
    ["n01:equip_for:answered_the_slot"],
    "the call is named as one that answered a slot rather than dropped",
  );
  assert.equal(
    validateBodyProgramCandidateRequest({
      programId: planProgramId("session_a", 11, nodesOf(result)),
      nodes: nodesOf(result),
    }),
    null,
    "the compiled plan must be one the Mod accepts",
  );
});

test("equipFor answers a slot a surface claim cannot resolve, and still writes no step", () => {
  const result = compile(
    `
for (const animal of snapshot.animalProductTargets ?? []) {
  const slot = builder.equipFor('collect_animal_product', animal);
  builder.collect_animal_product({ slot, x: animal.x, y: animal.y, expectedTargetId: animal.targetId });
}
`,
    {
      currentTool: "(T)MilkPail",
      currentToolSlot: 3,
      toolSlots: TOOL_PACK,
      animalProductTargets: [
        {
          targetId: "animal_product_01",
          slot: 3,
          x: 12,
          y: 9,
          animalType: "White Cow",
          qualifiedProduceItemId: "(O)184",
          displayName: "Cow Milk",
          toolKind: "milk_pail",
          produceStack: 1,
        },
      ],
    },
  );
  // The family that publishes its tool on the TARGET rather than in a claim answers through the target's own slot, and
  // the action is still the only node.
  assert.deepEqual(
    nodesOf(result).map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [["n01", "collect_animal_product", []]],
  );
  assert.deepEqual(nodesOf(result)[0]!.arguments.slot, { type: "integer", canonicalValue: "3" });
  assert.deepEqual(accountOf(result).noStepNeeded, ["n01:equip_for:answered_the_slot"]);
});

/**
 * A CALL THAT ANSWERED A SLOT IS NAMED, NOT COUNTED AS A STEP.
 *
 * `equipFor` answers the slot the action must name and writes nothing, because the action equips its own declared tool
 * when it runs. That is the compiler thinking about her call - which is a different fact from "the compiler ignored my
 * step", and the only way she can tell them apart is being told which one happened.
 */
test("a call that answered a slot is named as such, and the step beside it is not", () => {
  const result = compile(
    "const slot = builder.equipFor('cut_weeds');\nbuilder.cut_weeds({ x: 5, y: 6, slot, expectedTargetId: 'weed_01' });",
    { currentToolSlot: 3, toolSlots: [{ slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" }] },
  );
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["cut_weeds"],
    "the plan is the cut alone: an equip step written before it would be undone by it",
  );
  assert.deepEqual(accountOf(result).noStepNeeded, ["n01:equip_for:answered_the_slot"]);
  assert.deepEqual(accountOf(result).acceptedSteps, ["n02"], "the cut itself is the step that compiled");
  assert.deepEqual(accountOf(result).dropped, []);
});

/**
 * NO EQUIP STEP, HOWEVER MANY TIMES THE PROGRAMME ASKS.
 *
 * Measured 2026-11-20 (`round83`): a 32-node weed programme carried 12 `equip_tool` nodes and every one of them answered
 * `already_equipped` - the scythe went into the hand at the programme's first equip and stayed there, because each work
 * node restores the selection it found. `round99` spent sixteen of them in one plan, each a dispatched turn the world
 * advanced through, and not one of them changed which tool any following step used.
 *
 * The count is the property: N calls for one tool, ZERO steps and N named slot answers.
 */
test("no equip step per programme: asking for the same tool at every work node writes no equip step at all", () => {
  const result = compile(
    `
for (const weed of snapshot.weedTargets ?? []) {
  const slot = builder.equipFor('cut_weeds');
  builder.cut_weeds({ x: weed.x, y: weed.y, slot, expectedTargetId: weed.targetId });
}
`,
    {
      currentToolSlot: 0,
      toolSlots: [
        { slot: 0, label: "(T)Axe", upgradeLevel: 0, category: "axe" },
        { slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" },
      ],
      weedTargets: [
        { targetId: "weed_01", location: "Farm", x: 5, y: 6, health: 1 },
        { targetId: "weed_02", location: "Farm", x: 6, y: 6, health: 1 },
        { targetId: "weed_03", location: "Farm", x: 7, y: 6, health: 1 },
        { targetId: "weed_04", location: "Farm", x: 8, y: 6, health: 1 },
      ],
    },
  );
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["cut_weeds", "cut_weeds", "cut_weeds", "cut_weeds"],
    "four cuts and not one equip step, even though the axe was in hand when the plan was written",
  );
  assert.deepEqual(accountOf(result).noStepNeeded, [
    "n01:equip_for:answered_the_slot",
    "n03:equip_for:answered_the_slot",
    "n05:equip_for:answered_the_slot",
    "n07:equip_for:answered_the_slot",
  ]);
  // Every cut still names the slot its own call answered: writing no step must not lose the half the plan uses.
  for (const node of nodesOf(result)) assert.deepEqual(node.arguments.slot, { type: "integer", canonicalValue: "3" });
});

/**
 * Two tools in one programme are still two slot answers and no steps.
 *
 * The half that USED to matter - a second tool owed a second equip - is gone with the step itself: each action takes its
 * own declared tool at execution, so the programme never has to move her hand at all.
 */
test("two tools in one programme are two slot answers, and neither writes a step", () => {
  const result = compile(
    `const scythe = builder.equipFor('cut_weeds');
builder.cut_weeds({ x: 5, y: 6, slot: scythe, expectedTargetId: 'weed_01' });
const hoe = builder.equipFor('dig_artifact_spot');
builder.dig_artifact_spot({ x: 7, y: 6, slot: hoe, expectedTargetId: 'artifact_spot_01' });`,
    {
      currentToolSlot: 0,
      toolSlots: [
        { slot: 0, label: "(T)Axe", upgradeLevel: 0, category: "axe" },
        { slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" },
        { slot: 5, label: "(T)Hoe", upgradeLevel: 0, category: "hoe" },
      ],
    },
  );
  assert.deepEqual(
    nodesOf(result).map((node) => [node.actionId, (node.arguments.slot as unknown as { canonicalValue?: string } | undefined)?.canonicalValue ?? null]),
    [
      ["cut_weeds", "3"],
      ["dig_artifact_spot", "5"],
    ],
    "each action names the slot its own tool sits in, and no step precedes either",
  );
  assert.deepEqual(accountOf(result).noStepNeeded, [
    "n01:equip_for:answered_the_slot",
    "n03:equip_for:answered_the_slot",
  ]);
});

/**
 * `cut_weeds` declares `tool:scythe` on the surface, so the helper must honour that claim: the slot it answers is the
 * scythe's, and when the pack publishes no categories the refusal names the CATEGORY it could not resolve - never
 * "requirement undeclared", which would be a false statement about a claim the surface makes.
 */
test("equipFor resolves the declared category from the pack, and names the category when no slot publishes it", () => {
  // The scythe is in slot 3 whichever tool is in her hand, and the plan is the action alone either way.
  const declared = compile(
    "const slot = builder.equipFor('cut_weeds'); builder.cut_weeds({ x: 5, y: 6, slot, expectedTargetId: 'weed_01' });",
    {
      currentToolSlot: 3,
      toolSlots: [
        { slot: 0, label: "(T)Axe", upgradeLevel: 0, category: "axe" },
        { slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" },
      ],
    },
  );
  assert.deepEqual(
    nodesOf(declared).map((node) => node.actionId),
    ["cut_weeds"],
  );

  // The axe is held instead: the answer is the scythe's slot, and still no step is written before the cut.
  const notHeld = compile(
    "const slot = builder.equipFor('cut_weeds'); builder.cut_weeds({ x: 5, y: 6, slot, expectedTargetId: 'weed_01' });",
    {
      currentToolSlot: 0,
      toolSlots: [
        { slot: 0, label: "(T)Axe", upgradeLevel: 0, category: "axe" },
        { slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" },
      ],
    },
  );
  assert.deepEqual(
    nodesOf(notHeld).map((node) => node.actionId),
    ["cut_weeds"],
  );
  assert.deepEqual(nodesOf(notHeld)[0]!.arguments.slot, { type: "integer", canonicalValue: "3" });

  // The pack is older than the claim: no slot says `scythe`, so the refusal names that, not the requirement.
  const packWithoutCategories = compile("builder.equipFor('cut_weeds');", {
    currentToolSlot: 0,
    toolSlots: TOOL_PACK,
  });
  assert.equal(refusalOf(packWithoutCategories), "plan_script_tool_slot_unresolved:cut_weeds:scythe");

  // A weed target declares no tool, so passing one cannot stand in for the claim either.
  assert.equal(
    refusalOf(
      compile("builder.equipFor('cut_weeds', snapshot.weedTargets[0]);", {
        weedTargets: [{ targetId: "weed_01", location: "Farm", x: 5, y: 6, health: 1 }],
      }),
    ),
    "plan_script_tool_slot_unresolved:cut_weeds:scythe",
  );
  // An id the vocabulary does not have answers with that name, and the host adds the ids it DOES have.
  assert.equal(refusalOf(compile("builder.equipFor('brew_potion');")), "plan_script_unknown_action:brew_potion");
});

/**
 * THE VOCABULARY HAS NO `equip_tool` STEP, AND REFUSES IT BY NAME.
 *
 * A step that equips is undone by the step it precedes: every tool handler selects the tool its own `tool:<category>`
 * claim declares when it runs and puts the previous hand back in its `finally`, so an equip node written before
 * `cut_weeds`, `break_rock`, `chop_tree`, `till_soil` or `water_crop` changes nothing about it while spending a dispatched
 * turn (`round99`: sixteen of them in one plan). The action is still mounted - the surface below still publishes it, a
 * gesture the player can ask for on its own - and what is gone is only the step.
 */
test("a plan cannot write an equip_tool step, and the refusal names the reason", () => {
  assert.equal(
    refusalOf(compile("builder.equip_tool({ tool: 'scythe' });")),
    "plan_script_equip_undone_by_the_step_it_precedes:equip_tool",
  );
  // Refused as ONE CALL, not as the whole script: the steps beside it are still enumerated, so the correction is one
  // deletion and one resubmission rather than a plan she has to rewrite blind.
  const besideIt = compile(
    "builder.equip_tool({ tool: 'scythe' });\nbuilder.cut_weeds({ x: 5, y: 6, expectedTargetId: 'weed_01' });",
    { toolSlots: [{ slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" }] },
  );
  assert.equal(besideIt.status, "partial");
  assert.deepEqual(nodesOf(besideIt).map((node) => node.actionId), ["cut_weeds"]);
  assert.deepEqual(accountOf(besideIt).dropped, ["n01:plan_script_equip_undone_by_the_step_it_precedes:equip_tool"]);
  // The action itself is not withdrawn: it is still a published action of the Mod, reachable outside a plan.
  assert.ok(
    SURFACE.some((action) => action.actionId === "equip_tool"),
    "equip_tool stays a mounted gesture: the plan vocabulary is what refuses it, not the surface",
  );
});

test("a published argument description reaches the plan shape, because the Mod owns the meaning", () => {
  // Measured 2026-10-29: `PLAN_TOOL_SLOT_MEANING` said a `slot` is "never a backpack index". All thirteen actions that
  // take a `slot` read `Game1.player.Items[slot]` - it IS a backpack index - and three of them additionally require it
  // to equal `Farmer.CurrentToolIndex`. One Host-side sentence could not be true for both families, so the meaning now
  // travels per argument, from the handler that enforces it.
  const withDescription: readonly ActionRegistration[] = [
    Object.freeze({
      actionId: "cut_weeds",
      familyId: "resource_gathering",
      identityVersion: 1,
      lifecycle: "live_verified" as ActionRegistration["lifecycle"],
      kind: "execution" as ActionRegistration["kind"],
      descriptor: {
        arguments: [
          { name: "x", type: "integer" },
          { name: "y", type: "integer" },
          { name: "slot", type: "integer", description: "The TOOL's backpack slot, which must also be the held one." },
        ],
      },
    }),
  ];
  const [action] = planActionsFromRegistrations(withDescription);
  assert.ok(action, "the action is plannable");
  assert.deepEqual(
    action.arguments.map((argument) => argument.name),
    ["x", "y", "slot"],
  );
  assert.equal(
    action.arguments[2]?.description,
    "The TOOL's backpack slot, which must also be the held one.",
    "the Mod's own words for the argument survive into what a plan shape answers",
  );
  // An argument the surface does not describe stays UNDESCRIBED rather than becoming an empty string: absent is how a
  // surface says "the name is the whole story", and an empty description would be a label that says nothing.
  assert.equal(action.arguments[0]?.description, undefined);
  assert.equal("description" in (action.arguments[0] ?? {}), false);
});

test("the surface artifact carries a slot description for every action whose slot has a rule", () => {
  // The artifact is what the Mod publishes and the Host reads, so this is the one place the two sides are compared.
  // It fails by NAME when a `slot` argument loses its description, which is the drift the previous design could not
  // detect: a Host paragraph is not compared against anything.
  const slotActions = SURFACE.filter((action) => action.argumentSchema?.slot !== undefined);
  assert.ok(slotActions.length > 0, "the surface declares actions with a slot argument");
  const described = slotActions.filter((action) => (action.argumentSchema?.slot?.description ?? "").length > 0);
  assert.deepEqual(
    slotActions
      .filter((action) => (action.argumentSchema?.slot?.description ?? "").length === 0)
      .map((action) => action.actionId),
    [],
    "every action whose `slot` has a rule states that rule in its own words; an undescribed one is a guess the model makes",
  );
  assert.ok(described.length === slotActions.length);
});

/**
 * The plan tool's description must name exactly the actions this session publishes - and both directions of that
 * comparison are DERIVED, never hand-maintained.
 *
 * The defect the gate exists for is a description that says "every action you can take is a builder method" and names
 * none. Measured 2026-10-28 (`round6`): the companion reached 22:00 without dispatching `advance_day`, wrote goodnight
 * dialogue instead, and its own thinking recorded that it did not know the action was called and would not guess; the
 * engine passed it out at 02:00 onto a standing ShippingMenu. A name it can read costs nothing; a name one tool call
 * away is a round-trip it may decline to pay, and declining it degenerates to single steps or to dialogue.
 *
 * The published side is the Mod catalog: the surface artifact for ids, lifecycles, kinds and arguments, and the Mod's
 * own registration list for the family each action belongs to. The described side is read back out of the description
 * string production hands the model. A published action the description omits, a described id the catalog does not
 * publish, and an action listed under the wrong family each fail here, by name.
 */
const MOD_REGISTRATIONS = readFileSync(
  resolve(hostRoot, "../integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
  "utf8",
);

/** actionId -> familyId exactly as the Mod declares them, from its one registration list. */
function modFamiliesOfActions(): ReadonlyMap<string, string> {
  const body = MOD_REGISTRATIONS.match(/\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/u)?.[1];
  assert.ok(body !== undefined, "the Mod's registration list must be readable from its own source");
  const families = new Map<string, string>();
  for (const entry of body.split(/(?=\b(?:E|R|Registration)\()/u)) {
    const match = entry.match(/\b(?:E|R|Registration)\(\s*"([a-z][a-z0-9_]{1,127})",\s*"([a-z][a-z0-9_]{1,127})"/u);
    if (match?.[1] !== undefined && match[2] !== undefined) families.set(match[1], match[2]);
  }
  return families;
}

const MOD_FAMILY_OF_ACTION = modFamiliesOfActions();

/** The surface artifact's registrations, each carrying the family the Mod really declares for it. */
const CATALOG_REGISTRATIONS: readonly ActionRegistration[] = SURFACE.map((action) => {
  const familyId = MOD_FAMILY_OF_ACTION.get(action.actionId);
  assert.ok(
    familyId !== undefined,
    `${action.actionId} is on the published surface but the Mod's registration list declares no family for it`,
  );
  return Object.freeze({
    actionId: action.actionId,
    familyId,
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
          },
        }),
  });
});

const CATALOG_ACTIONS = planActionsFromRegistrations(CATALOG_REGISTRATIONS);

/**
 * One row of the vocabulary block: the action id and the argument names printed beside it, or `undefined` when the row
 * carries no argument list at all.
 */
type DescribedRow = Readonly<{ actionId: string; arguments: readonly string[] | undefined }>;

/**
 * The vocabulary block read back out of the description: `family: id(args), id(args)` per line, in the order it prints.
 *
 * Only a line that starts with one family id and a colon is a vocabulary line, so neither the prose nor the script
 * example - both of which end a sentence and then a colon - can be mistaken for one. A row WITHOUT parentheses is parsed
 * rather than skipped: that shape is the defect the argument gate is written for, and a parser that demanded parentheses
 * would report it as a missing action instead of a row that says nothing about what it takes.
 */
function describedVocabulary(description: string): ReadonlyMap<string, readonly DescribedRow[]> {
  const vocabulary = new Map<string, readonly DescribedRow[]>();
  for (const line of description.split("\n")) {
    const match = /^([a-z][a-z0-9_]*): (.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    assert.equal(vocabulary.has(match[1]), false, `the description lists the family ${match[1]} twice`);
    const rows: DescribedRow[] = [];
    for (const row of match[2].matchAll(/([a-z][a-z0-9_]*)(?:\(([^)]*)\))?/gu))
      rows.push(
        Object.freeze({
          actionId: row[1]!,
          arguments: row[2] === undefined ? undefined : Object.freeze(row[2] === "" ? [] : row[2].split(",")),
        }),
      );
    // A row this reader cannot put back together is a row it would silently stop covering, so the whole line must be the
    // list of calls it was read as - the same `id(a,b), id2()` the renderer prints.
    assert.equal(
      rows
        .map((row) => (row.arguments === undefined ? row.actionId : `${row.actionId}(${row.arguments.join(",")})`))
        .join(", "),
      match[2],
      `${match[1]}'s vocabulary line is not the list of builder calls this gate reads`,
    );
    vocabulary.set(match[1], Object.freeze(rows));
  }
  return vocabulary;
}

test("the plan description names every action this session publishes, under the family the Mod declares, and no other", () => {
  assert.ok(CATALOG_ACTIONS.length > 0, "the catalog publishes plannable actions");
  const described = describedVocabulary(planWorkDescription(CATALOG_ACTIONS));
  assert.ok(described.size > 0, "the description carries the action vocabulary at all");

  const published = new Set(CATALOG_ACTIONS.map((action) => action.actionId));
  const describedIds = new Set([...described.values()].flat().map((row) => row.actionId));

  // Direction 1: a published action the description never names. This is the `advance_day` defect - the companion held
  // a description that claimed the whole surface and could not read a single name out of it.
  assert.deepEqual(
    [...published].filter((actionId) => !describedIds.has(actionId)).sort(),
    [],
    "every action the session publishes is named in the plan tool's description",
  );
  // Direction 2: a name in the description that this session does not publish. A stale id is worse than a missing one:
  // the companion writes `builder.<thatName>` and is only refused after paying for the call.
  assert.deepEqual(
    [...describedIds].filter((actionId) => !published.has(actionId)).sort(),
    [],
    "the plan tool's description names no action this session does not publish",
  );
  // The grouping is the Mod's own, not a Host invention: each family lists exactly the actions declared in it, so an
  // action filed under the wrong family fails by name instead of merely appearing somewhere.
  assert.deepEqual(
    [...described.keys()].sort(),
    [...new Set(CATALOG_ACTIONS.map((action) => action.familyId))].sort(),
    "the description's families are exactly the families the Mod declares for its plannable actions",
  );
  for (const [familyId, members] of described)
    assert.deepEqual(
      members.map((row) => row.actionId).sort(),
      CATALOG_ACTIONS.filter((action) => action.familyId === familyId)
        .map((action) => action.actionId)
        .sort(),
      `${familyId} lists exactly its own actions`,
    );
});

/**
 * Why one vocabulary row does not say what its action takes: `[]` when it does.
 *
 * THE POPULATION IS THE DECLARATION and the reading is the RENDERED TEXT, which is what makes this a gate rather than a
 * registration step: `planActionVocabularyText` and `stardew_plan_shape` answer from the same `PublishedPlanAction`, so a
 * row that prints fewer arguments than its action declares means the two routes to one fact have drifted apart - and the
 * companion spends a turn on `plan_shape` to find out what the row did not say.
 *
 * Measured `round54`: her own thinking held "Sleep action is world_lifecycle builder.sleep - args? Probably x,y? ... that
 * costs a turn ... Simpler: speak", and twelve turns of speech plus a 02:00 pass-out followed. Earlier rounds did sleep
 * when they asked (`round41` executed `sleep` 43 times, `pass_out 0`), so the fact was in the declaration all along and
 * only the turn was missing.
 */
function vocabularyRowsMissingArguments(
  rendered: readonly PublishedPlanAction[],
  declaration: readonly PublishedPlanAction[],
): readonly string[] {
  const described = describedVocabulary(planWorkDescription(rendered));
  const rows = new Map([...described.values()].flat().map((row) => [row.actionId, row] as const));
  const findings: string[] = [];
  for (const action of declaration) {
    const row = rows.get(action.actionId);
    const declared = action.arguments.map((argument) => argument.name);
    if (row === undefined) {
      findings.push(`action_row_missing:${action.actionId}`);
      continue;
    }
    // An action that takes nothing still prints empty parentheses, so a bare id is a row that never said so.
    if (row.arguments === undefined) {
      findings.push(`action_row_omits_argument_list:${action.actionId}`);
      continue;
    }
    for (const argument of declared)
      if (!row.arguments.includes(argument))
        findings.push(`action_row_omits_declared_arguments:${action.actionId}:${argument}`);
    for (const argument of row.arguments)
      if (!declared.includes(argument))
        findings.push(`action_row_names_undeclared_argument:${action.actionId}:${argument}`);
    if (
      row.arguments.some((argument, index) => argument !== declared[index]) &&
      row.arguments.length === declared.length
    )
      findings.push(
        `action_row_reorders_declared_arguments:${action.actionId}:declared=[${declared.join(",")}]:row=[${row.arguments.join(",")}]`,
      );
  }
  return findings;
}

test("every vocabulary row carries the arguments its own declaration gives it", () => {
  const described = describedVocabulary(planWorkDescription(CATALOG_ACTIONS));
  const rows = [...described.values()].flat();
  const withArguments = CATALOG_ACTIONS.filter((action) => action.arguments.length > 0);
  const withoutArguments = CATALOG_ACTIONS.filter((action) => action.arguments.length === 0);
  // Zero population is BLOCKED rather than green: both shapes have to be in the population, or a renderer that printed
  // `()` for everything would pass this gate by agreeing with an empty set.
  assert.ok(rows.length > 0, "blocked: the description carries no vocabulary row, so this gate examined nothing");
  assert.ok(
    withArguments.length > 0,
    "blocked: no plannable action declares an argument, so a row that omits one could not be named here",
  );
  assert.ok(
    withoutArguments.length > 0,
    "blocked: no plannable action takes nothing, so the empty-parentheses case is not in this population",
  );
  assert.deepEqual(
    vocabularyRowsMissingArguments(CATALOG_ACTIONS, CATALOG_ACTIONS),
    [],
    `these rows do not print the arguments their declaration carries (${String(rows.length)} rows examined, ` +
      `${String(withArguments.length)} actions with arguments, ${String(withoutArguments.length)} with none)`,
  );
});

/**
 * A DECLARATION THAT DECLARES AN ARGUMENT THE ROW DOES NOT PRINT is what this gate exists to name - so the falsifier feeds
 * it one: a synthetic action is added to the declaration carrying an argument, and its row is rendered from a vocabulary
 * whose copy of that action lost the argument. The gate must name that action and that argument, and nothing else.
 */
test("the argument-row gate names a declaration whose row drops the argument it declares", () => {
  const patched: PublishedPlanAction = Object.freeze({
    ...CATALOG_ACTIONS[0]!,
    actionId: "patch_soil",
    arguments: Object.freeze([{ name: "patchWidth", type: "integer", required: true as const }]),
  });
  const declared = Object.freeze([...CATALOG_ACTIONS, patched]);
  const lossy = declared.map((action) =>
    action.actionId === "patch_soil" ? Object.freeze({ ...action, arguments: Object.freeze([]) }) : action,
  );
  const findings = vocabularyRowsMissingArguments(lossy, declared);
  assert.deepEqual(
    findings,
    ["action_row_omits_declared_arguments:patch_soil:patchWidth"],
    "the gate reads the DECLARATION's arguments against the RENDERED row, so an argument only the declaration carries is named",
  );
});

/**
 * The fields `stardew_plan_shape`'s answer carries, and what a caller can DO with each.
 *
 * THE POPULATION IS THE ANSWER, NOT THIS TABLE: the gate below enumerates the keys of the actions `planShape` really
 * returns, so a field added anywhere in `PublishedPlanAction` reaches it without an edit - and lands here as
 * `agent_visible_field_is_our_bookkeeping:<field>` unless this table says what she can do with it. The reasons are the only
 * place a field may be kept, and every entry expires: a reason naming a field the answer no longer carries is red, so this
 * cannot become a list of excuses that outlived their fields.
 *
 * WHY THIS IS A GATE AND NOT A STYLE NOTE. `lifecycle` rode along in every shape answer until it was removed: the Mod's
 * release maturity (`published`, `live_verified`, `experimental`) printed per action, which decides nothing she can act on -
 * the vocabulary she is handed already contains exactly the plannable actions, and the Mod refuses the rest by name. A field
 * of ours in an answer she reads costs her a guess about what to do with it, and it is invisible in any test that only
 * asserts the answer's size.
 */
const PLAN_SHAPE_FIELDS_A_CALLER_CAN_ACT_ON: Readonly<Record<string, string>> = Object.freeze({
  actionId: "the name the script writes",
  familyId: "the family `stardew_plan_shape` and the vocabulary grouping select by",
  arguments: "the arguments the call must pass",
  outputFacts: "the facts a later node can bind from this one",
  resourceClaims: "the claims an admission refusal names",
  toolRequirement: "the tool, upgrade level and range a step needs before it can run",
  approachRequirement: "where the actor must stand first",
  targetFamily: "the snapshot family whose rows carry this action's targets",
  effects: "what this step requires of the world and what it changes - the fact a later step's dependency is made of",
});

/**
 * The fields of a shape answer that are our bookkeeping: `agent_visible_field_is_our_bookkeeping:<field>`.
 *
 * The answer is asked for every action in the vocabulary, so the population is the whole answer rather than one sampled
 * action: a field carried by one family and not another is still a field she meets.
 */
function bookkeepingFieldsInPlanShape(actions: readonly PublishedPlanAction[]): readonly string[] {
  const answer = planShape(actions, { actionIds: actions.map((action) => action.actionId) });
  if (!answer.ok) return Object.freeze([`plan_shape_answer_refused:${answer.reasonCode}`]);
  return Object.freeze(
    [...new Set(answer.actions.flatMap((action) => Object.keys(action)))]
      .filter((field) => PLAN_SHAPE_FIELDS_A_CALLER_CAN_ACT_ON[field] === undefined)
      .sort()
      .map((field) => `agent_visible_field_is_our_bookkeeping:${field}`),
  );
}

test("every field the shape answer carries is one a caller can act on", () => {
  assert.ok(CATALOG_ACTIONS.length > 0, "blocked: the vocabulary is empty, so a shape answer could not carry a field");
  const answer = planShape(CATALOG_ACTIONS, { actionIds: CATALOG_ACTIONS.map((action) => action.actionId) });
  assert.equal(answer.ok, true, "blocked: the shape answer refused the vocabulary it was handed");
  const carried = new Set(answer.ok ? answer.actions.flatMap((action) => Object.keys(action)) : []);
  // An exemption must expire: a reason for a field the answer no longer carries is a rule nobody reads, and it would let a
  // future field of the same name be silently excused.
  assert.deepEqual(
    Object.keys(PLAN_SHAPE_FIELDS_A_CALLER_CAN_ACT_ON)
      .filter((field) => !carried.has(field))
      .sort(),
    [],
    "the reasons table names a field the shape answer does not carry, so its exemption outlived its field",
  );
  assert.deepEqual(
    bookkeepingFieldsInPlanShape(CATALOG_ACTIONS),
    [],
    `the shape answer carries fields she can do nothing with (${String(carried.size)} fields examined: ` +
      `${[...carried].sort().join(", ")})`,
  );
});

/**
 * The falsifier: the field this gate removed is put back, and the gate must name it.
 *
 * It is the shape a future change takes - a field of ours rides along because it was convenient in the code that builds the
 * answer - so the gate is driven through the SAME reading the test above uses, not through a second one.
 */
test("the shape-answer gate names our bookkeeping when it rides along again", () => {
  // A distinct id on purpose: `planShape` answers one row per id, so a field added to an action whose id the vocabulary
  // already carries would never reach the answer and this falsifier would pass by looking at the wrong row.
  const withLifecycle = Object.freeze({
    ...CATALOG_ACTIONS[0]!,
    actionId: "patch_scythe",
    lifecycle: "published",
  }) as unknown as PublishedPlanAction;
  assert.deepEqual(
    bookkeepingFieldsInPlanShape(Object.freeze([...CATALOG_ACTIONS, withLifecycle])),
    ["agent_visible_field_is_our_bookkeeping:lifecycle"],
    "a field that is our release maturity rather than a fact she can act on is named, once, by its own name",
  );
});

test("the description's example uses a published action and that action's own declared argument names", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  const call = /builder\.([a-z0-9_]+)\(\{ (.*) \}\);/u.exec(description);
  assert.ok(call, "the description carries one builder call as an example");
  const action = SURFACE.find((entry) => entry.actionId === call[1]);
  assert.ok(action, `${String(call[1])} in the example is an action the surface publishes`);
  assert.deepEqual(
    [...(call[2] as string).matchAll(/([A-Za-z0-9_]+):/gu)].map((match) => match[1]),
    Object.keys(action.argumentSchema ?? {}),
    "the example's argument names are that action's declared ones, in order",
  );
});

/**
 * The one reading of the prose budget, so the gate and its falsifiers take the same predicate: the description and the Game
 * floor's own size, counted TOGETHER.
 *
 * The budget is `GAME_PROSE_PAIR_BUDGET_CHARS` - a declared constant in the product, not a number written here - and the
 * answer names the pair, the budget and BOTH sides, because a reader who saw only one side would think prose had been added
 * when a sentence had only moved between the two.
 */
function prosePairOverBudget(description: string, floorChars: number): string | undefined {
  const pair = description.length + floorChars;
  return pair <= GAME_PROSE_PAIR_BUDGET_CHARS
    ? undefined
    : `game_prose_pair_exceeds_budget:${String(pair)}:${String(GAME_PROSE_PAIR_BUDGET_CHARS)}:plan_${String(description.length)}:floor_${String(floorChars)}`;
}

/**
 * The Game floor's size, READ FROM THE FLOOR'S OWN RECORDED READING rather than from the module that composes it.
 *
 * The floor block is the pair's other half, and the floor's suite already holds its recorded size against the prompt the
 * product builds (`GAME_SURFACE_PROMPT_FLOOR.conductBlock.chars`), so reading it there keeps this gate from carrying a second
 * measurement of the same text. The reading is required to be a SIZE: `undefined` here is a blocked reading, never a zero,
 * because a side that silently became 0 would turn the pair into the description alone and pass.
 */
function floorCharsOf(reading: unknown): number | undefined {
  const conduct = (reading as { conductBlock?: { readonly chars?: unknown } }).conductBlock;
  const chars = conduct?.chars;
  return typeof chars === "number" && chars > 0 ? chars : undefined;
}

/**
 * THE PARTIAL CONTRACT REACHES THE ONE PLACE THE COMPANION LEARNS IT.
 *
 * `planStatus` is the field that stops an answer from claiming the whole plan ran, and a field nobody is told about is a
 * field she will not read: the description is handed to her every Game turn and is the only place the answer's contract
 * is stated. The rule it replaced - "one call the compiler refuses voids the whole plan" - was true until this contract
 * and is false now, so it may not survive in the text that teaches the rule.
 */
test("the description teaches that a refused call costs its own call, and names the field that says so", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  assert.match(
    description,
    /planStatus: partial/u,
    "the answer's own field has to be named where the contract is taught",
  );
  assert.doesNotMatch(
    description,
    /voids the whole plan/u,
    "a rule no longer in force may not be taught: it is the sentence that made one typo cost the batch",
  );
});

/**
 * THE ONE PLAN CALL WITH A PRECONDITION, AND THE DESCRIPTION IS NOW ITS ONLY HOME.
 *
 * <p>
 * `sleep()` is not like the other rows: it takes no arguments and it is refused outdoors. The Game prompt floor carried
 * that fact as `SLEEPING_IS_AN_ACTION` until 2026-11-19 - "in stardew_plan_work, call builder.sleep() (with no arguments)
 * after entering the farmhouse" - written because a run spent a whole night announcing goodnight beside a body that never
 * moved. It moved here, because this is where the call is declared: a precondition a caller needs AT THE MOMENT OF THE
 * CALL belongs beside the call, and the floor is the last thing she reads rather than the place she writes the script.
 * The floor stating it too was a second spelling; `game-surface-prompt-floor.test.ts` now holds that half of the move.
 * </p>
 *
 * <p>
 * THE WORDS COME FROM THE PROJECTION, NOT FROM THIS FILE. The answer an outdoor attempt gets is published by the Mod and
 * worded once, in `SLEEP_DAY_END_TEXT.refusesHere`, so the refusal code and the room are EXTRACTED from that line and
 * required here - a description that stops naming them leaves the day's end refused with nothing having said so, and the
 * finding names `sleep` and the token it lost.
 * </p>
 */
function sleepPreconditionTokens(): readonly string[] {
  const line = SLEEP_DAY_END_TEXT.refusesHere;
  const codes = [...line.matchAll(/`([a-z][a-z0-9_]*)`/gu)].map((match) => match[1]!);
  const room = /inside your own [a-z]+ or [a-z]+/u.exec(line)?.[0];
  return Object.freeze(room === undefined ? codes : [...codes, room]);
}

function sleepPreconditionFindings(description: string): readonly string[] {
  return sleepPreconditionTokens()
    .filter((token) => !description.includes(token))
    .map((token) => `sleep_precondition_missing:${token}`);
}

test("the plan description states `sleep()`'s precondition, which is now the only place it is stated", () => {
  const tokens = sleepPreconditionTokens();
  // Zero (or half) population is BLOCKED rather than green: a projection that stopped naming the refusal would make a
  // description naming nothing agree with it.
  assert.ok(
    tokens.length >= 2,
    `blocked: SLEEP_DAY_END_TEXT.refusesHere named ${String(tokens.length)} of the two facts this gate reads (the ` +
      "refusal code and the room the day ends in), so its silence about the description would mean nothing",
  );
  assert.deepEqual(
    sleepPreconditionFindings(planWorkDescription(CATALOG_ACTIONS)),
    [],
    `the description stopped stating what \`sleep()\` needs (${tokens.join(", ")}): the Game prompt floor no longer ` +
      "carries it either - `SLEEPING_IS_AN_ACTION` moved into this description - so nothing would tell her the day's end " +
      "is refused outdoors",
  );
});

/**
 * The falsifier: the moved sentence is taken back out of the description, and the gate must name `sleep` and what it lost.
 *
 * The removal is the old rendering (`\`sleep()\` takes none`), so the case is the regression the sentence was moved to
 * prevent rather than a synthetic edit. A description rewritten around the sentence leaves this falsifier BLOCKED by its
 * own `notEqual`, which is the loud shape a rotted falsifier has to take.
 */
test("the precondition gate names `sleep` and the lost precondition when the moved sentence comes out", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  const without = description.replace(
    /`sleep\(\)` takes none, and ends the day only from inside your own farmhouse or cabin \(`not_home` outdoors\)/u,
    "`sleep()` takes none",
  );
  assert.notEqual(
    without,
    description,
    "blocked: the sentence this gate protects is not in the description as this falsifier removes it, so nothing below " +
      "was examined",
  );
  assert.deepEqual(
    sleepPreconditionFindings(without),
    ["sleep_precondition_missing:not_home", "sleep_precondition_missing:inside your own farmhouse or cabin"],
    "a description that drops the moved sentence is named by the precondition it lost, so the sentence is load-bearing " +
      "where it now lives",
  );
});

test("the pair's floor side is a size or it is blocked, never a zero that quietly halves the budget", () => {
  assert.equal(floorCharsOf(READING), READING.conductBlock.chars, "the gate reads the floor's own recorded size");
  // The three shapes a missing reading takes: renamed away, never stated, and stated as zero. All three are BLOCKED by the
  // gate (`pair_budget_not_measured:...`), and none of them may be read as "the floor contributes nothing".
  assert.equal(floorCharsOf({}), undefined, "a renamed reading is not a size");
  assert.equal(floorCharsOf({ conductBlock: {} }), undefined, "a reading that states no characters is not a size");
  assert.equal(floorCharsOf({ conductBlock: { chars: 0 } }), undefined, "zero is the one value that must never pass");
});

test("the plan description and the Game floor fit the pair budget their own constant declares", () => {
  assert.ok(GAME_PROSE_PAIR_BUDGET_CHARS > 0, "the budget must be a size, not a placeholder");
  const description = planWorkDescription(CATALOG_ACTIONS);
  const floor = floorCharsOf(READING);
  // BLOCKED, never green and never zero: the floor's size is the pair's other half, and a reading that went missing would
  // make "the pair fits" agree with a pair that is the description alone.
  assert.ok(
    floor !== undefined,
    "pair_budget_not_measured:game-surface-prompt-floor.test-support.ts:GAME_SURFACE_PROMPT_FLOOR.conductBlock.chars - " +
      "the Game floor's own recorded size is the other half of this budget, so a missing reading cannot be read as zero",
  );
  // Printed on every run: the pair is what has to fit, and each side is printed with where its number came from, so a change
  // that MOVED a sentence is not read as prose nobody paid for.
  process.stdout.write(
    `\ngame prose: plan description ${String(description.length)} (live) · game floor ${String(floor)} (recorded ` +
      `reading) · pair ${String(description.length + floor)} · budget ${String(GAME_PROSE_PAIR_BUDGET_CHARS)}\n`,
  );
  assert.equal(
    prosePairOverBudget(description, floor),
    undefined,
    "both halves are handed to the model on every Game turn, so what they carry together is what has to fit: a sentence " +
      "may move between them, and nothing may be added to the pair",
  );
});

/**
 * THE PAIR'S RED, IN THE TWO SHAPES IT EXISTS TO TELL APART: prose that was ADDED, and a sentence that MOVED without
 * leaving its old home. The first has no old home to pay for it; the second is the move done halfway, which reads as a
 * deduction on one side and an increase on the other - and nothing but the pair notices that the increase had no payer.
 *
 * <p>
 * WHAT THE PAIR CANNOT SEE, SAID HERE RATHER THAN LEFT TO BE DISCOVERED: its floor side is a recorded NUMBER
 * (`READING.conductBlock.chars`), not the floor's text, so the pair can only read a move that changes the floor's SIZE.
 * A sentence carried back into the floor while another sentence left it - the same size, two writers - is invisible to
 * this arithmetic, and so is a recorded reading that was re-recorded to match. The second reading below is therefore the
 * floor's own TEXT, where a sentence that came back has nowhere to hide, and the `a_rule_the_prompt_states_has_an_owner`
 * gate in `game-surface-prompt-floor.test.ts` is what refuses any behaviour sentence the header has no owner for.
 * </p>
 *
 * Both directions are driven through the SAME predicate the gate uses, and both name the pair with each side's size, so a
 * red says which side grew rather than only that the total did. `GAME_PROSE_PAIR_BUDGET_CHARS` was re-recorded on
 * 2026-11-24 with the floor's own shrink: against the older ceiling BOTH directions passed, because the pair had fallen
 * 3,226 characters below a budget nothing lowered - a gate that could not fail.
 */
test("the pair gate turns red on added prose, and on a sentence that moved without leaving its old home", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  const floor = floorCharsOf(READING);
  assert.ok(
    floor !== undefined,
    "pair_budget_not_measured:game-surface-prompt-floor.test-support.ts:GAME_SURFACE_PROMPT_FLOOR.conductBlock.chars - " +
      "this falsifier reads the same recorded size the gate does, and a zero would make both reds unreachable",
  );

  // THE PADDING IS DERIVED FROM THE BUDGET, one character past it, because a fixed hundred assumed the pair had no
  // headroom - true from `remeasured_2026_11_24_b` to `_c` (7,514 of 7,517) and false since `_d`, where the floor lost the
  // machine-vocabulary line and the pair fell to 7,396. A falsifier that assumed a full budget would have stopped being a
  // falsifier without saying so.
  const pastBudget = (text: string, floorChars: number): string =>
    `${text}${"x".repeat(Math.max(0, GAME_PROSE_PAIR_BUDGET_CHARS + 1 - (text.length + floorChars)))}`;

  // Direction one: prose nobody removed from anywhere else.
  const planned = pastBudget(description, floor);
  assert.equal(
    prosePairOverBudget(planned, floor),
    `game_prose_pair_exceeds_budget:${String(planned.length + floor)}:${String(GAME_PROSE_PAIR_BUDGET_CHARS)}:plan_${String(planned.length)}:floor_${String(floor)}`,
    "a description that grew by prose nothing paid for is refused by name, with the pair and both sides",
  );

  // Direction two: the sentence is here AND still in the floor. The halfway state is the floor's own size PLUS the clause it
  // did not give up, read from the real description rather than from a copy of the deleted rule.
  const movedClause = /`sleep\(\)` takes none, and ends the day only[^;]*?outdoors\)/u.exec(description)?.[0];
  assert.ok(
    movedClause !== undefined,
    "blocked: the moved clause is not in the description as this falsifier copies it back to its old home",
  );
  const halfway = floor + 1 + movedClause.length;
  const duplicated = pastBudget(description, halfway);
  assert.equal(
    prosePairOverBudget(duplicated, halfway),
    `game_prose_pair_exceeds_budget:${String(duplicated.length + halfway)}:${String(GAME_PROSE_PAIR_BUDGET_CHARS)}:plan_${String(duplicated.length)}:floor_${String(halfway)}`,
    "the same sentence in both places is refused by the pair - the `floor_` side is what counts the duplicate - because a " +
      "floor keeping it makes this a duplicated fact rather than a move, and the floor's own claim reader names it there too",
  );
  // The control: the pair as the tree really composes it fits, so the two reds above are the shapes and not the reading.
  assert.equal(prosePairOverBudget(description, floor), undefined);

  // THE SECOND READING, AND IT IS THE ONE THAT CAN SEE A SENTENCE IN BOTH HOMES: the floor's own text. The clause moved
  // into the description on 2026-11-19, so its return is a red here whether or not the recorded size moved with it.
  assert.doesNotMatch(
    GAME_SURFACE_INPUT_HEADER,
    /ends the day only from inside your own/u,
    "the moved sentence is back in the floor's own text: one fact, two writers, and the description is the one that owns it",
  );
});

/**
 * The three program tools' descriptions as the model is handed them: `stardew_plan_work` is compiled here, and the two
 * readers are written inline beside the tools that mount them, so they are read off that source.
 *
 * One reader for all three, because the defect this pins is a CONVERSATION between them: `plan_work` holds a short plan's
 * turn and answers a longer one on acceptance, so a description that advertises watching the plan is the instruction that
 * fills the gap - whichever of the three states it.
 */
function programToolDescriptions(): Readonly<Record<"planWork" | "programStatus" | "programEvents", string>> {
  const source = readFileSync(
    resolve(
      hostRoot,
      "src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts",
    ),
    "utf8",
  );
  return Object.freeze({
    planWork: planWorkDescription(CATALOG_ACTIONS),
    programStatus: descriptionOfToolAfter(source, 'name: "stardew_action_program_status"'),
    programEvents: descriptionOfToolAfter(source, 'name: "stardew_action_program_events"'),
  });
}

/**
 * The description literal of the tool declared at `marker`, quoted either way.
 *
 * The status tool's description is SINGLE-quoted (its own sentences are full of apostrophes) and the events tool's is
 * double-quoted, so a reader that understood only one quoting silently read the NEXT tool's description instead: this
 * gate asserted the status contract against the events text from the commit that wrote it, and could not have passed.
 */
function descriptionOfToolAfter(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${marker} is gone, so where its description is written is no longer checkable`);
  const literal = /description:\s*\n?\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/u.exec(source.slice(at));
  const body = literal?.[1] ?? literal?.[2];
  assert.ok(body !== undefined, `${marker} still carries its description as one string literal`);
  return body.replace(/\\([\s\S])/gu, "$1");
}

test("stardew_plan_work says when it returns, for which plan, and that the turn keeps composing", () => {
  // THE TWO ARMS ARE TWO FACTS, and the condition between them is the product's own threshold rather than a number
  // written here: a description that said "two nodes" while the rule waited for nine would be a second spelling of the
  // same fact, and the model would plan against the wrong one. `round84` is why the first arm exists at all - 33 of 59
  // programmes were 1-3 nodes and a plan runs in 1-4 s, so for most of her work the turn boundary cost more than the
  // work (`1,265.2 s` of the run's `1,702.7 s` between programmes), while a description that said nothing about a wake
  // produced 48 `stardew_action_program_status` calls and 248 s blocked (`round29`).
  const { planWork } = programToolDescriptions();
  assert.match(
    planWork,
    new RegExp(`A plan of ${String(MAX_PLAN_SELF_WAIT_NODES)} nodes or fewer is held until it settles`, "u"),
    "the condition under which the call holds its turn is stated, with the rule's own threshold",
  );
  assert.match(
    planWork,
    /so its outcome is in this answer/u,
    "and what that buys: the outcome is in the answer, so the same turn carries on",
  );
  assert.match(
    planWork,
    /a longer plan returns as soon as it is accepted/u,
    "the other arm says when IT returns, so neither plan is left guessing",
  );
  assert.match(planWork, /do NOT poll/u, "and forbids polling it");
  assert.match(
    planWork,
    /each step's receipt arrives later as a new message/u,
    "naming the fact that wakes the companion instead of a tool it would have to call",
  );
  assert.match(
    planWork,
    /Keep composing/u,
    "and what the turn is for is stated: composing work, not one call and a wait",
  );
  assert.match(
    planWork,
    /end the turn only when you have nothing more to plan/u,
    'so "end the turn" means "no more to plan", never "I submitted something"',
  );
  // The sentence this replaces said "...so END YOUR TURN", which made one script a turn: measured `round66`, 40 turns
  // bought 16 world-changing actions (2.2 requests a turn) while `round42` - whose description said nothing of the kind -
  // bought 13.8 actions a turn. The anti-polling fact stays; the instruction to stop is the defect.
  // Whether she says anything with that turn is the preset's (`说清就停`), not the tool's: a description says how to
  // call the tool. Removed 2026-11-15 - "...so end your turn and speak to the player" made every settled plan owe a
  // bubble, and `conversational-stance-gate.test.ts` is what keeps it out.
  assert.doesNotMatch(planWork, /speak to the player/u, "and the description leaves speaking to the preset");
  assert.match(
    planWork,
    /stardew_action_program_status is for a plan that is not moving, not a progress bar/u,
    "and the status tool is pointed at its one remaining use",
  );
});

test("stardew_action_program_status is described as a diagnostic with a rare opt-in wait", () => {
  const { programStatus } = programToolDescriptions();
  assert.match(programStatus, /DIAGNOSTIC, not a progress bar/u, "the tool says what it is not");
  assert.match(
    programStatus,
    /not after every submission/u,
    "and when it is not to be read, which is the instruction the old text got wrong",
  );
  assert.match(programStatus, /`waitMs` is a rare opt-in/u, "waitMs is documented as the exception, not the default");
  assert.match(
    programStatus,
    /while it holds the turn you cannot stop, append or steer/iu,
    "with the cost that makes it rare: a held turn cannot be interrupted",
  );
});

/**
 * No program tool description may tell the model to poll.
 *
 * <p>
 * The failure is measurable: `stardew_action_program_status` was called 48-89 times per run for 248-452 s of blocked
 * turns (`round29`, `round7`), because one description said "Use it after submitting a plan to see which node ran" and the
 * other said "Pass waitMs to wait for the plan to finish". The same invitation sat in the event log's description, which
 * sold the page as the way "a running plan can be followed". All three are read here sentence by sentence, since that is
 * the unit a model acts on, and a sentence that carries a prohibition ("do NOT poll", "not after every submission") is
 * the contract rather than the defect.
 * </p>
 */
test("no program tool description tells the model to poll", () => {
  const descriptions = programToolDescriptions();
  for (const [tool, text] of Object.entries(descriptions))
    assert.match(
      text,
      /(?:do NOT poll|not a progress bar)/u,
      `${tool} no longer states that it is not to be polled, which is the whole contract after plan_work stopped waiting`,
    );

  const prescription = /\b(?:use|read|call|ask|pass|choose|keep|poll)\w*/iu;
  const progressNoun = /\b(?:wait\w*|progress\w*|again|poll\w*)\b/iu;
  const prohibition = /\b(?:not|never|no|unless|instead|rather than)\b/iu;
  for (const [tool, text] of Object.entries(descriptions)) {
    const offending = text
      .split(/(?<=[.;:])\s+/u)
      .filter((sentence) => prescription.test(sentence) && progressNoun.test(sentence) && !prohibition.test(sentence));
    assert.deepEqual(offending, [], `${tool} tells the model to poll for progress: ${offending.join(" | ")}`);
  }
});

/**
 * THE ACCEPTED PLAN'S OWN ANSWER, IN THE REGISTER PI-AFT'S RECEIPTS USE.
 *
 * The product owner's words: *"body-program receipts should follow pi-aft - ideally almost exactly the same, only a few
 * words swapped."* `edit` answers `Applied 1 edit to src/foo.ts` or `Error: oldString not found in x.ts`: one line, what
 * happened, to what, and how much. What this answer said instead was a paragraph about a MESSAGE - "the settlement
 * arrives as its own message - a fact - once the last node reaches a terminal state, the same answer comes back until
 * then, and `stardew_action_program_status` `waitMs` only holds a turn until that moment."
 *
 * The measurement it was written for was real (`round43`: 29 of 96 turns were `stardew_action_program_status` calls), but
 * the sentence answered with the delivery of a future message, with "the same answer comes back", and with the purpose of
 * a bound on a tool she had not called. A receipt states the outcome of the call it belongs to; whether a later delivery
 * arrives is the description's business, and `game-surface-receipt.test.ts` is what keeps it out of every answer.
 */
test("an accepted plan's answer is one line: what was accepted, how many, and as which program", () => {
  const note = planSettlementNote(3, "plan_2f9c41ab");
  assert.match(note, /^Accepted /u, "what happened comes first, as `Applied 1 edit` opens the harness's own receipt");
  assert.match(note, /\b3 nodes\b/u, "how much it was");
  assert.match(note, /plan_2f9c41ab/u, "and what it happened to: the program she has to name to stop it");
  // One line: no second sentence, no dash-appended explanation, and nothing about a message, a turn or a wait. The
  // register is checked word for word in `game-surface-receipt.test.ts`; here it is the shape a reader sees.
  assert.equal(note.match(/\.\s/u), null, "it is ONE sentence, not a paragraph");
  assert.equal(note.endsWith("."), true, "and it ends");
  assert.equal(
    /\b(?:message|fact|turn|turns|wait|waitMs|until|later|arrives?)\b/iu.test(note),
    false,
    `a receipt states what happened, never what will arrive: ${note}`,
  );
  // A one-node plan is not "1 nodes": the count is read by a model that notices.
  assert.match(planSettlementNote(1, "plan_2f9c41ab"), /^Accepted 1 node as /u);
});

/**
 * ONE `plan_shape` CALL ANSWERS THE ARGUMENT TABLE FOR EVERY ACTION THE COMPANION ASKED ABOUT.
 *
 * Measured in `.tmp/fork-why-slow.jsonl` (73 `stardew_plan_work` calls, 6 `stardew_plan_shape` calls): every one of the
 * six named a SINGLE action id, so a companion writing a batch over several families had to spend one round trip per
 * action before it could write the script - and the companion's own account is that it kept the batch small instead.
 * The table it reads has to carry the one fact whose absence produced 7 of the 14 voided batches: every argument listed
 * is REQUIRED. `harvest_crop` publishes four, the measured script passed `x`, `y` and `expectedTargetId`, and the whole
 * batch of six calls died on the fourth.
 */
test("one plan_shape call answers three actions whose argument tables differ, each argument marked required", () => {
  const requested = ["cut_weeds", "move_to_tile", "respond_level_up"];
  const shape = planShape(ACTIONS, { actionIds: requested });
  assert.ok(shape.ok, "three published actions are plannable");
  assert.deepEqual(
    shape.actions.map((action) => action.actionId),
    requested,
    "the answer keeps the order the caller asked in, so it can be read positionally against the script",
  );
  for (const action of shape.actions) assert.deepEqual(action.arguments, surfaceArguments(action.actionId));
  const tables = shape.actions.map((action) => action.arguments.map((argument) => argument.name).join(","));
  assert.equal(new Set(tables).size, 3, "three genuinely different tables, not one repeated");
  // A closed set travels with the argument that declares it, and a `description` with the argument the Mod explains.
  const choice = shape.actions
    .find((action) => action.actionId === "respond_level_up")!
    .arguments.find((argument) => argument.name === "choice");
  assert.deepEqual(choice?.enum, ["confirm", "branch_a", "branch_b"]);
  assert.equal(choice?.required, true, "a bounded argument is no more optional than an unbounded one");
  const slot = shape.actions
    .find((action) => action.actionId === "cut_weeds")!
    .arguments.find((argument) => argument.name === "slot");
  assert.ok(
    (slot?.description?.length ?? 0) > 0,
    "the Mod's own words for `slot` travel with the action that takes it",
  );
  // The two fields that used to be one call away per action: which family supplies targets, and where the body must stand.
  for (const action of shape.actions) {
    assert.ok("targetFamily" in action, `${action.actionId} answers its target family, null included`);
    assert.ok("approachRequirement" in action, `${action.actionId} answers its approach requirement`);
    const approach = action.approachRequirement;
    if (approach.declared) assert.equal(typeof approach.relation, "string", `${action.actionId} names its relation`);
    else assert.equal(approach.reasonCode, "approach_requirement_undeclared");
  }
});

/**
 * The `required` flag is not a constant this file added: it is the compiler's own rule, and this gate ties the two
 * together over the published surface. Every argument the shape marks required must be one whose omission the builder
 * refuses by name - and an argument the shape would mark optional has to be one an omission survives, which is the
 * case that does not exist today and the reason the Mod's protocol has no optional arguments.
 */
test("every argument plan_shape marks required is one whose omission the builder refuses", () => {
  const faults: string[] = [];
  let optional = 0;
  for (const action of ACTIONS.filter((candidate) => candidate.arguments.length > 0)) {
    const shape = planShape(ACTIONS, { actionIds: [action.actionId] });
    if (!shape.ok) {
      faults.push(`${action.actionId}: a published action answered ${shape.reasonCode}`);
      continue;
    }
    for (const argument of shape.actions[0]!.arguments) {
      const omitted = compilePlanScript(
        { script: callScript(action, { omit: [argument.name] }) },
        { snapshot: snapshot(SOURCE_SNAPSHOT), actions: ACTIONS },
      );
      const code = omitted.status === "compiled" ? "accepted" : omitted.reasonCode;
      const refuses = code.startsWith(`plan_script_missing_argument:${action.actionId}.${argument.name}:`);
      // THE SAME THREE ANSWERS ONE LEVEL UP: `required` is the MOD's requirement, and this compiler satisfies it either
      // by refusing the omission or by reading the row - `boundFromSnapshot` names which, per call. A TILE refusal is a
      // different argument's business, so it is neither answer to this question.
      const reads = PLAN_SNAPSHOT_READINGS.has(argument.name) && (code === "accepted" || TARGET_TILE_CLAIM.test(code));
      if (argument.required === true && !refuses && !reads)
        faults.push(`${action.actionId}.${argument.name}: marked required, but an omission answered ${code}`);
      // AN ARGUMENT THE BODY ANSWERS FOR IS NEVER THE REASON A REFUSAL NAMES: the Mod resolves it at execution, so an
      // omission is either compiled (the node leaves it out, `resolvedAfter` says so) or refused for something else.
      if (argument.required !== true) {
        optional += 1;
        if (refuses)
          faults.push(
            `${action.actionId}.${argument.name}: marked resolved-at-execution, but an omission is refused by ${code}`,
          );
      }
    }
  }
  console.log(
    `every argument plan_shape marks required is one whose omission the builder refuses: optional ${String(optional)}`,
  );
  assert.ok(optional > 0, "examined no argument the body answers for, so the second half of this gate could not run");
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * A wrong id inside a batch must not void the read: the companion asks about nine actions at once and ONE typo must not
 * cost the round trip. It is named, and the rest of the table still arrives. Only a read that found nothing is the
 * refusal, and that one carries the vocabulary that does exist.
 */
test("a shape call for several actions answers the ones that exist and names the ones that do not", () => {
  const partial = planShape(ACTIONS, { actionIds: ["cut_weeds", "brew_potion", "move_to_tile"] });
  assert.ok(partial.ok, "one unknown id must not void a shape read of three actions");
  assert.deepEqual(
    partial.actions.map((action) => action.actionId),
    ["cut_weeds", "move_to_tile"],
  );
  assert.deepEqual(partial.unknownActionIds, ["brew_potion"]);

  const repeated = planShape(ACTIONS, { actionIds: ["cut_weeds", "cut_weeds"] });
  assert.ok(repeated.ok);
  assert.deepEqual(
    repeated.actions.map((action) => action.actionId),
    ["cut_weeds"],
    "the same action asked twice is answered once",
  );

  const nothing = planShape(ACTIONS, { actionIds: ["brew_potion", "mend_fence"] });
  assert.ok(!nothing.ok, "a read that found nothing is the refusal");
  assert.equal(nothing.reasonCode, "plan_shape_unknown_action:brew_potion");
  assert.deepEqual(
    nothing.legalActionIds,
    ACTIONS.slice(0, 20).map((action) => action.actionId),
  );
});

/**
 * ONE REFUSED CALL COSTS THE CALL IT NAMES, AND THE REST OF THE BATCH RUNS.
 *
 * This is the first of the fourteen voided batches measured in `.tmp/fork-why-slow.jsonl`, replayed verbatim: six calls,
 * two of which pass every argument and four of which omit `expectedQualifiedItemId` on a `harvest_crop` that declares it.
 * The companion's own words - "write 30 nodes and any one miss zeroes the batch" - are why it kept its bets at 2.8 nodes
 * per plan, and why every extra call she writes costs her a turn instead of saving one.
 *
 * The rule that answered the ORIGINAL forgery (at `3d249ff1` a refused call was simply left out and the answer still said
 * `ok: true`; round40 is `accepted: true` beside `droppedCount: 15`) was "refuse the whole plan", and it bought that
 * honesty with the five calls that were right. `partial` keeps both: the five run under a real program id, the answer says
 * `partial` rather than claiming the plan ran, and `dropped` names the one call that did not.
 */
test("a refused call costs the call it names and no others, and the batch runs as partial", () => {
  const measured = `
builder.move_to_tile({ x: 60, y: 11 });
builder.harvest_crop({ x: 60, y: 10, expectedTargetId: "crop_72f6ce55311cf7c3" });
builder.move_to_tile({ x: 60, y: 8 });
builder.harvest_crop({ x: 60, y: 9, expectedQualifiedItemId: "(O)24", expectedTargetId: "crop_2a7e1fd59d0206a0" });
builder.move_to_tile({ x: 59, y: 14 });
builder.harvest_crop({ x: 58, y: 14, expectedQualifiedItemId: "(O)24", expectedTargetId: "crop_5481d34df6f60c18" });
`;
  const result = compile(measured, {
    ...SOURCE_SNAPSHOT,
    // THE SNAPSHOT THE SESSION WAS IN, for the three tiles it harvested: a plan naming a tile the world does not hold is
    // now refused at submit (`body-program-snapshot-readings.test.ts`), and this replay is about the ONE refusal that is
    // an omitted argument - so the two steps that were CORRECT must name rows this world really publishes.
    harvestTargets: [
      { ...SOURCE_SNAPSHOT.harvestTargets![0]!, targetId: "harvest_measured_6010", x: 60, y: 10 },
      { ...SOURCE_SNAPSHOT.harvestTargets![0]!, targetId: "harvest_measured_609", x: 60, y: 9 },
      { ...SOURCE_SNAPSHOT.harvestTargets![0]!, targetId: "harvest_measured_5814", x: 58, y: 14 },
    ],
  });
  // Calls 2, 4 and 6 were the same mistake in the measured session; this replay supplies the argument on 4 and 6 so the
  // reading is "one refused call, five that were fine", which is the property, not the session's arithmetic.
  assert.equal(result.status, "partial", "one call did not become a step, so the answer may not say `compiled`");
  assert.equal(
    result.status === "partial" ? result.reasonCode : "compiled",
    "plan_script_missing_argument:harvest_crop.expectedQualifiedItemId:string:snapshot.harvestTargets[].qualifiedHarvestItemId",
    "the first refused call's own code, unchanged, is the reason to fix first",
  );
  // THE FIVE THAT WERE CORRECT RUN. This is the assertion the whole state exists for: before it, one refused call voided
  // the batch and these five had no program to be part of.
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["move_to_tile", "move_to_tile", "harvest_crop", "move_to_tile", "harvest_crop"],
    "the refused call is the one absent, in its own position, and nothing else moved",
  );
  // AND WHAT RUNS IS A CANDIDATE THE MOD ACCEPTS: a partial plan is submitted like any other, so it must satisfy the
  // wire's own shape check and the compiler's claim-rule self-check - running is not a licence to emit garbage.
  const nodes = nodesOf(result);
  assert.equal(
    result.snapshotRevision,
    snapshot(SOURCE_SNAPSHOT).revision,
    "a partial plan carries the revision it was built against, because it is submitted against one",
  );
  assert.equal(validateBodyProgramCandidateRequest({ programId: planProgramId("session_a", 11, nodes), nodes }), null);
  assert.deepEqual(planResourceConflictCodes(nodes, ACTIONS), []);
  assert.deepEqual(rejectionsOf(result), [
    {
      call: 2,
      actionId: "harvest_crop",
      reasonCode:
        "plan_script_missing_argument:harvest_crop.expectedQualifiedItemId:string:snapshot.harvestTargets[].qualifiedHarvestItemId",
      missingArguments: ["expectedQualifiedItemId"],
    },
  ]);
  assert.deepEqual(accountOf(result).dropped, [
    "n02:plan_script_missing_argument:harvest_crop.expectedQualifiedItemId:string:snapshot.harvestTargets[].qualifiedHarvestItemId",
  ]);
  // THE OTHER FIVE ARE NOT LOST SILENTLY IN EITHER DIRECTION: they are named as the calls that compiled, in the order she
  // wrote them, so she can resend them with the one broken step repaired.
  assert.deepEqual(accountOf(result).acceptedSteps, ["n01", "n03", "n04", "n05", "n06"]);
  assert.equal(result.acceptedStepsCount, 5);
  assert.equal(result.droppedCount, 1);
  assert.equal(result.noStepNeededCount, 0, "every call is in exactly one of the lists");
});

/**
 * The property above, at the boundary that decides how far a refusal reaches: its POSITION in the batch.
 *
 * A rule that dropped the calls written AFTER the refusal would still pass a test whose bad call came last, so the same
 * three-call batch is compiled with the refused call first, in the middle and last. Every arrangement must keep the two
 * calls that were written correctly - which is the difference between "costs the call it names" and "costs the batch".
 */
test("a refused call costs only itself wherever the author wrote it", () => {
  const first = "builder.move_to_tile({ x: 12, y: 8 });";
  const second = "builder.move_to_tile({ x: 13, y: 8 });";
  // `till_soil` declares `x`, `y` and `charge`, so a call with none of them is refused by the surface's own declaration.
  const refused = "builder.till_soil({});";
  const arrangements = [
    ["first", `${refused}\n${first}\n${second}`],
    ["middle", `${first}\n${refused}\n${second}`],
    ["last", `${first}\n${second}\n${refused}`],
  ] as const;
  for (const [position, script] of arrangements) {
    const result = compile(script);
    assert.equal(result.status, "partial", `a refusal written ${position} leaves two calls that compiled`);
    assert.equal(
      nodesOf(result).length,
      2,
      `a refusal written ${position} must cost one call, not the batch: ${JSON.stringify(accountOf(result))}`,
    );
    assert.equal(result.droppedCount, 1, `a refusal written ${position} is named exactly once`);
  }
});

/**
 * THE BOUNDARY OF `partial`: A BATCH WITH NO STEP IS STILL A REFUSAL, and the code says which kind of empty it is.
 *
 * `partial` exists because a program with SOME of the author's steps can run. With NONE of them there is no program, so
 * there is nothing to submit and nothing to name - and a state that ran an empty program would be the mirror image of the
 * forgery this contract was built to stop. The three ways a script produces no step are different mistakes and are named
 * differently: it never called a builder at all, it called one and nothing was added, or it called a method the builder
 * does not have - which cannot be interpreted past, because the runtime cannot know what that call would have added.
 */
test("a script that produced no step is refused, never an empty partial plan", () => {
  // A well-formed loop whose body calls no builder: the shape round60 sent three times, and the one that must still
  // void - `plan_script_empty_no_builder_call` is a diagnosis of the script, not a refusal of any call it made.
  const askedNothing = compile("for (let index = 0; index < 3; index += 1) { const tile = index; }");
  assert.equal(askedNothing.status, "refused", "zero steps is zero program");
  assert.equal(refusalOf(askedNothing), "plan_script_empty_no_builder_call");
  // Every call refused: there is a count to name, and it is not the same mistake as asking for nothing.
  const allRefused = compile("builder.till_soil({});\nbuilder.move_to_tile({});");
  assert.equal(allRefused.status, "refused");
  assert.equal(allRefused.droppedCount, 2);
  assert.equal(allRefused.acceptedStepsCount, 0);
  // A method the builder does not publish ends the SCRIPT: nothing after it can be interpreted.
  const unknownMethod = compile("builder.for_each({ source: 'cropTargets' });");
  assert.equal(unknownMethod.status, "refused");
  assert.equal(refusalOf(unknownMethod), "plan_script_unknown_action:for_each");
});

/**
 * The dependent case, with the one dependency a script can actually express: `equipFor` ANSWERS a slot, and the call
 * after it consumes that answer. When the equip step is refused there is no slot, so the action that would have named it
 * must not become a node - it is refused too, not silently written with a missing argument the Mod would hit at runtime.
 * Both refusals are named against the call that caused them, and the walk they followed still runs: a dependent refusal
 * costs its own call, never the calls before it.
 */
test("a call that consumes a refused call's answer does not run, and both are named", () => {
  const result = compile(
    `
builder.move_to_tile({ x: 12, y: 8 });
const slot = builder.equipFor('cut_weeds');
builder.cut_weeds({ x: 10, y: 10, slot: slot, expectedTargetId: 'weed_01' });
`,
    // No pack slot publishes a category at all, so the scythe cannot be resolved and the equip step is refused by name.
    {},
  );
  assert.deepEqual(
    rejectionsOf(result).map(({ call, actionId }) => ({ call, actionId })),
    [
      { call: 2, actionId: "cut_weeds" },
      { call: 3, actionId: "cut_weeds" },
    ],
  );
  assert.equal(
    result.status === "compiled" ? null : rejectionsOf(result)[0]?.reasonCode,
    "plan_script_tool_slot_unresolved:cut_weeds:scythe",
  );
  assert.match(
    result.status === "compiled" ? "" : (rejectionsOf(result)[1]?.reasonCode ?? ""),
    /^plan_script_argument_not_canonical:cut_weeds\.slot:/u,
  );
  assert.match(result.status === "compiled" ? "" : (rejectionsOf(result)[1]?.reasonCode ?? ""), /:got:missing$/u);
  assert.deepEqual(accountOf(result).acceptedSteps, ["n01"], "the walk before the refusal compiled, and is named");
  assert.equal(result.droppedCount, 2);
  // THE WALK STILL RUNS. Two refused calls in a three-call script used to mean nothing ran at all.
  assert.equal(nodesOf(result).length, 1, "the one step that compiled is the program");
});

/**
 * `accepted: false` survives for the one case it was always true of: a script whose every call was refused has no plan.
 * The teaching payload is still there, and it now names EVERY missing argument - the measured refusal 12
 * (`claim_mail_attachment({ expectedTargetId })`) named `x` alone, so fixing `x` bought a second refusal for `y`.
 */
test("a batch in which nothing was accepted is still a refusal, and it names every missing argument", () => {
  const result = compile(`
builder.claim_mail_attachment({ expectedTargetId: 'mailbox_a21663c33741df54' });
builder.move_to_tile({ x: 10 });
`);
  assert.equal(result.status, "refused", "no accepted node is not a plan");
  assert.match(result.reasonCode, /^plan_script_missing_argument:claim_mail_attachment\.x:/u);
  assert.deepEqual(result.missingArguments, ["x", "y"]);
  assert.equal(result.requirement?.actionId, "claim_mail_attachment");
  assert.deepEqual(
    result.rejected.map(({ call, actionId, missingArguments }) => ({ call, actionId, missingArguments })),
    [
      { call: 1, actionId: "claim_mail_attachment", missingArguments: ["x", "y"] },
      { call: 2, actionId: "move_to_tile", missingArguments: ["y"] },
    ],
  );
});
/**
 * EVERY CALL SHE WROTE IS ACCOUNTED FOR EXACTLY ONCE, over the whole published vocabulary.
 *
 * This is the compiler's half of `tools/check-plan-legal-fixpoint.mjs`: that gate drives the same property across the
 * pairs its own reading builds, and this one over every action the surface publishes, alone. The population is the
 * vocabulary itself - never a list written here - and a zero population FAILS, because a check that examined nothing
 * agrees with itself.
 *
 * A call in NONE of the lists is the defect the whole account exists for (an `ok` answer carrying a step that was
 * quietly thrown away); a call in TWO of them is a bookkeeping bug that would hide the first. Both are named with the
 * entry that broke, so the next reader knows which action and which list.
 */
test("every authored call is accounted for exactly once, across the whole published vocabulary", () => {
  assert.ok(ACTIONS.length > 20, `the vocabulary is a real population, not ${ACTIONS.length} actions`);
  const faults: string[] = [];
  let examined = 0;
  const accountOfScript = (script: string, calls: number, label: string) => {
    const result = compile(script, { ...SOURCE_SNAPSHOT });
    examined += 1;
    const lists = {
      acceptedSteps: result.acceptedSteps,
      noStepNeeded: result.noStepNeeded,
      dropped: result.dropped,
    };
    const counted = result.acceptedStepsCount + result.noStepNeededCount + result.droppedCount;
    if (counted !== calls)
      faults.push(
        `${label}: ${calls} call(s) written, ${counted} accounted for (${JSON.stringify(lists)}) examined ${examined}`,
      );
    const seen = new Map<string, string>();
    for (const [list, entries] of Object.entries(lists))
      for (const entry of entries) {
        // The call's own position is the first field of every entry, whatever the list: `n07`, `n07:into=n03:...`.
        const step = entry.split(":")[0]!;
        const previous = seen.get(step);
        if (previous !== undefined)
          faults.push(`${label}: ${step} is in both ${previous} and ${list} (examined ${examined})`);
        seen.set(step, list);
      }
  };
  for (const action of ACTIONS) accountOfScript(builderCall(action.actionId), 1, action.actionId);
  // The shapes that put more than one disposition in one script: a body-yielding step (an insertion, both calls accepted),
  // and a script whose second call cannot be written at all (one accepted, one dropped).
  accountOfScript(
    'builder.talk_to_npc({ x: 13, y: 8, expectedTargetId: "npc_pierre" });\nbuilder.move_to_tile({ x: 12, y: 8 });',
    2,
    "talk_to_npc->move_to_tile",
  );
  accountOfScript("builder.move_to_tile({ x: 12, y: 8 });\nbuilder.move_to_tile({ x: 12 });", 2, "second call refused");
  assert.ok(examined > 20, `the account was measured over ${examined} answers`);
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * THE LOOP SHAPES THIS TOOL COULD TEACH, each named with the property it breaks.
 *
 * The first four are the only batch constructs the description could carry, and exactly one of them is the shape a plan
 * is written in: `for`. The rest are the vocabulary of the form that was removed - a second way to write a loop in a
 * script that is already JavaScript, written in our row model rather than in hers - so their return is the defect this
 * gate exists for, whatever spelling it comes back under.
 */
const LOOP_SHAPES: readonly Readonly<{ name: string; pattern: RegExp }>[] = Object.freeze([
  Object.freeze({ name: "for", pattern: /for \(/u }),
  Object.freeze({ name: "while", pattern: /while \(/u }),
  Object.freeze({ name: "do", pattern: /do \{/u }),
  Object.freeze({ name: "forEach", pattern: /\.forEach\(/u }),
  Object.freeze({ name: "for_each", pattern: /\bfor_each\b/u }),
  Object.freeze({ name: "where", pattern: /\bwhere\b/u }),
  Object.freeze({ name: "occupant", pattern: /\boccupant\b/u }),
  Object.freeze({ name: "row", pattern: /\brow\b/u }),
  Object.freeze({ name: "source", pattern: /\bsource\b/u }),
]);

function taughtLoopShapes(description: string): readonly string[] {
  return LOOP_SHAPES.filter((shape) => shape.pattern.test(description)).map((shape) => shape.name);
}

/**
 * `two_ways_to_write_a_loop`, as one reading both the gate and its falsifier take.
 *
 * THE POPULATION IS THE TWO AUTHORITIES, not a list of wishes: the plan grammar's own form list (`PLAN_FORM_ACTION_IDS`,
 * the ids the compiler can emit that are not published actions) and the loop vocabulary the description actually carries.
 * The property is that there is exactly one loop shape - `for` - and no form beside it.
 */
function twoWaysToWriteALoopFinding(description: string, forms: readonly string[]): string | undefined {
  const taught = taughtLoopShapes(description);
  const verdict = `forms examined ${String(LOOP_SHAPES.length + forms.length)} · loops ${String(taught.length)} · other ${String(forms.length)}`;
  if (forms.length > 0)
    return `two_ways_to_write_a_loop:${forms.join(",")}: a plan form is a second way to write a loop this script can already write - ${verdict}`;
  const other = taught.filter((shape) => shape !== "for");
  if (taught.length !== 1 || other.length > 0)
    return `two_ways_to_write_a_loop:${other.length === 0 ? "none" : other.join(",")}: the script is JavaScript and the batch is one \`for\` loop - ${verdict}`;
  return undefined;
}

/**
 * `a_script_form_is_reachable_from_the_description`, as one reading both the gate and its falsifier take.
 *
 * The absence of this gate is why a form can live while nobody uses it: the grammar accepted `for_each` and the
 * description taught it, and when the teaching was withdrawn the form stayed - accepted by the grammar, named nowhere a
 * model reads. A form the compiler accepts and the description does not teach is a call nothing can learn, so it is red
 * BY NAME here, and the day the list stops being empty it must be taught in the same edit.
 */
function scriptFormReachabilityFinding(description: string, forms: readonly string[]): string | undefined {
  for (const form of forms)
    if (!description.includes(form))
      return `a_script_form_is_reachable_from_the_description:${form}: the grammar accepts it and the description never teaches it`;
  return undefined;
}

test("two_ways_to_write_a_loop: exactly one loop shape is taught and accepted", () => {
  assert.equal(
    twoWaysToWriteALoopFinding(planWorkDescription(CATALOG_ACTIONS), PLAN_FORM_ACTION_IDS),
    undefined,
    "the description teaches one loop shape over a snapshot family, and the grammar accepts no form beside it",
  );
  assert.deepEqual(
    taughtLoopShapes(planWorkDescription(CATALOG_ACTIONS)),
    ["for"],
    "and the shape it teaches is `for`, this time read back from the rendered text rather than assumed",
  );
});

test("two_ways_to_write_a_loop is red on a second loop shape, and names it", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  // A second way to write the same batch, in the spelling a model most plausibly reaches for.
  const second =
    description + "\nfor (const tile of snapshot.soilTiles) snapshot.soilTiles.forEach((t) => void t); // .forEach(\n";
  assert.match(
    twoWaysToWriteALoopFinding(second, []) ?? "",
    /^two_ways_to_write_a_loop:forEach: .*forms examined \d+ · loops \d+ · other 0$/u,
    "a description that teaches two loop shapes is refused by name, with the population it examined",
  );
  assert.match(
    twoWaysToWriteALoopFinding(description, ["for_each"]) ?? "",
    /^two_ways_to_write_a_loop:for_each: /u,
    "and a grammar that accepts a form beside the language is refused by the form's own name",
  );
});

test("a_script_form_is_reachable_from_the_description: every accepted form is taught", () => {
  assert.equal(
    scriptFormReachabilityFinding(planWorkDescription(CATALOG_ACTIONS), PLAN_FORM_ACTION_IDS),
    undefined,
    "no plan form exists, so every node the compiler writes is an action the description already names",
  );
  // ZERO POPULATION IS STATED, NOT SILENT: the list is empty by decision, and a form added to it without teaching it is
  // the defect this gate catches - which the next case proves it still does.
  assert.deepEqual(PLAN_FORM_ACTION_IDS, [], "the declared form list is empty: a batch is a `for` loop");
});

test("a_script_form_is_reachable_from_the_description is red on a form the description never names", () => {
  const message = scriptFormReachabilityFinding(planWorkDescription(CATALOG_ACTIONS), ["for_each"]);
  assert.match(
    message ?? "",
    /^a_script_form_is_reachable_from_the_description:for_each: /u,
    "a form the grammar accepts and the description does not teach is refused by name",
  );
});

/**
 * THE EXAMPLE IN THE DESCRIPTION IS A SCRIPT, AND A SCRIPT IS EITHER ONE THE COMPILER ACCEPTS OR A LESSON IN NOT
 * COPYING IT.
 *
 * <p>
 * MEASURED WHILE READING `round81`: the till loop printed `charge: charge: 0`. The `charge` pair is composed by
 * `planExampleCharge` (name and value, read from the wire's own integer bound) and one call site wrote `charge: ` beside
 * it, so the example was a `SyntaxError` - `plan_script_threw:SyntaxError`, which is not even a refusal the author can act
 * on, because it names the parser and not the call. Every companion that copied the taught batch therefore had to write
 * her own loop, and a loop written from a sentence about a family is a loop without the family's condition.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE RENDERED EXAMPLE, taken from the description's own `// In order:` block to its end and compiled
 * VERBATIM - comments included, because a companion copying the block copies them. Two calls were unreadable there: the
 * till loop printed `charge: charge: 0` (a `SyntaxError`, so the example taught a loop nobody could run), and the sentence
 * naming the refused words (`timers`, eval, the network) sat INSIDE the block, where a verbatim copy was refused
 * `plan_script_uses_forbidden:eval` and lost the whole script with it. That sentence now sits above the block: it is prose
 * about the language, not a line of the example.
 *
 * `round81`'s patch is bare on purpose - a plan that composes nothing would answer `plan_script_empty_no_builder_call`,
 * which is a different defect and would hide a syntax error behind itself.
 * </p>
 */
test("the recipe's examples are a script the compiler accepts", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  const example = description.slice(description.indexOf("// In order:"));
  assert.ok(example.length > 0, "blocked: the description carries no example block to compile");
  const compiled = compile(example, {
    enabledActionIds: ["till_soil", "water_crop"],
    soilTiles: [
      { x: 60, y: 18, hoeDirt: false, blockX: 60, blockY: 18, blockW: 2, blockH: 1 },
      { x: 61, y: 18, hoeDirt: false, blockX: 60, blockY: 18, blockW: 2, blockH: 1 },
    ],
    cropTargets: [crop("crop_01", 11, 10)],
  });
  if (compiled.status !== "compiled")
    assert.doesNotMatch(
      compiled.reasonCode,
      /^plan_script_(?:threw|unknown_action):/u,
      `a call the description teaches is a call the compiler refuses (${compiled.reasonCode}): ${example}`,
    );
  const written = compiled.status === "refused" ? [] : nodesOf(compiled).map((node) => node.actionId);
  for (const taught of ["till_soil", "water_crop"])
    assert.ok(
      written.includes(taught),
      `${taught}'s loop in the example composes its step, so the example is a shape she can copy: ${written.join(", ")}`,
    );
});

// ---------------------------------------------------------------------------------------------------------------
// GATE `a_row_a_plan_iterates_says_when_iterating_it_is_work:<family>`
// ---------------------------------------------------------------------------------------------------------------
//
// A ROW A PLAN ITERATES IS A TARGET LIST, AND THE LIST SAYS NOTHING ABOUT WHICH OF ITS ROWS STILL NEED THE WORK.
// Measured `round81` (2026-11-20, first three minutes): `plan_35` wrote 25 `till_soil` nodes over a 13x3 patch whose
// every tile was already HoeDirt - `soil_already_tilled` 25 times, `succeeded 25 · rejected 0`, because the settlement
// proves the postcondition was already true and is right to say so. The settlement was fixed; the twenty-five node
// executions were still bought for nothing, because nothing in the composition said a tilled row is not a till target.
//
// THE POPULATION IS THE RENDERED RECIPE, not this file: every `snapshot.<family>` the description really iterates is
// parsed out of `planWorkDescription`'s own output, so a family added to the example joins the gate by being written.
//
// EACH FAMILY MUST CARRY ONE OF THE TWO SHAPES `PLAN_ITERATION_CONDITIONS` declares - a row field its loop guards on,
// or a statement that the family publishes only rows that need the work - and the guard is read OFF THE TEXT rather than
// off the declaration, so deleting it from the example turns the family red by name.
//
// AND BOTH DIRECTIONS EXPIRE: a declared family the recipe no longer iterates is red too, because a table of conditions
// for loops nobody writes is a rule nobody reads.
//
// AND A GUARD THE ROW DOES NOT PRINT IS NOT A CONDITION SHE CAN READ. `round80`'s tree (`e7fd043f`) is the real-history
// replay: the soil loop already guarded on `soil.hoeDirt`, and `ROW_STATE_FIELDS` had no `soilTiles` entry, so no row of
// the family printed the state the guard asked about - the block called a worked 10x3 block 「可锄的地块」 and the Mod
// answered `soil_already_tilled` 54 times. The crossing below is red on that tree by the family's own name.

type IteratedFamilyReading = Readonly<{
  families: readonly string[];
  conditioned: number;
  bare: readonly string[];
  expired: readonly string[];
}>;

/**
 * The loops the recipe writes, as family -> the variable it binds that family's row to.
 *
 * The pattern is the one loop shape the description teaches (`for (const row of snapshot.<family>)`), so the population
 * is the recipe's own iterated families: a family mentioned in prose is not iterated by a plan and is not judged here.
 */
function iteratedLoops(description: string): ReadonlyMap<string, string> {
  const loops = new Map<string, string>();
  for (const match of description.matchAll(/for \(const ([a-z][A-Za-z0-9_]*) of snapshot\.([a-z][A-Za-z0-9_]*)/gu))
    loops.set(match[2] as string, match[1] as string);
  return loops;
}

/**
 * The recipe text from one family's mention to the end of the loop it is named in, or `undefined` when the recipe never
 * names it.
 *
 * The end is the closing brace of the first block after the mention, so the slice covers the `if` a guard is written as
 * and stops before the next family's loop - which is what makes a guard count for the family it is written under.
 */
function loopBodyOf(description: string, family: string): string | undefined {
  const at = description.indexOf(`snapshot.${family}`);
  if (at < 0) return undefined;
  const rest = description.slice(at);
  const end = rest.search(/\n\}/u);
  return end < 0 ? rest : rest.slice(0, end);
}

function iteratedFamilyReading(
  description: string,
  declared: Readonly<Record<string, PlanIterationCondition>> = PLAN_ITERATION_CONDITIONS,
): IteratedFamilyReading {
  const loops = iteratedLoops(description);
  const families = [...loops.keys()].sort();
  const bare: string[] = [];
  let conditioned = 0;
  for (const family of families) {
    const entry = declared[family];
    if (entry === undefined) {
      bare.push(family);
      continue;
    }
    if ("rowField" in entry) {
      const body = loopBodyOf(description, family) ?? "";
      const guard = new RegExp(`if \\(${loops.get(family) as string}\\.${entry.rowField}\\b`, "u");
      if (!guard.test(body)) {
        bare.push(family);
        continue;
      }
    }
    conditioned += 1;
  }
  const expired = Object.keys(declared)
    .filter((family) => !families.includes(family))
    .sort();
  return Object.freeze({
    families: Object.freeze(families),
    conditioned,
    bare: Object.freeze(bare),
    expired: Object.freeze(expired),
  });
}

/**
 * The wire's own declaration of one family's row fields, read from the document rather than restated here.
 *
 * A `rowField` a condition names has to be a property the Mod really publishes on that family's rows: without this the
 * table could declare a guard the example also writes and the two would agree about a field nothing publishes.
 */
function wireRowFieldNames(family: string): readonly string[] {
  const schema = JSON.parse(readFileSync(resolve(hostRoot, "../protocol/bridge-v1.schema.json"), "utf8")) as {
    $defs?: Record<string, { properties?: Record<string, { items?: { $ref?: string } }> }>;
  };
  const reference = schema.$defs?.snapshot?.properties?.[family]?.items?.$ref;
  if (typeof reference !== "string") return [];
  const properties = schema.$defs?.[reference.slice(reference.lastIndexOf("/") + 1)]?.properties;
  return properties === undefined ? [] : Object.keys(properties).sort();
}

/**
 * The row-prints-the-guarded-state crossing: a guard on a field no row of that family prints is not a condition she can
 * read.
 *
 * THE REPLAY IS `e7fd043f` (`round80`): the recipe already wrote `if (soil.hoeDirt !== true)` over `snapshot.soilTiles`,
 * and `ROW_STATE_FIELDS` carried `colorTargets` alone - so a row of the soil family printed its tile and nothing about
 * the Hoe, the block called a worked block 「可锄的地块」, and 54 tills were dispatched at ground already under it. This
 * reading names the family and the field, on a tree where both halves of `PLAN_ITERATION_CONDITIONS` would have said the
 * condition was declared.
 */
function unprintedGuardFindings(
  reading: IteratedFamilyReading,
  printed: Readonly<Record<string, Readonly<{ field: string; label: string }>>> = ROW_STATE_FIELDS,
): readonly string[] {
  return reading.families.flatMap((family) => {
    const entry = PLAN_ITERATION_CONDITIONS[family];
    if (entry === undefined || !("rowField" in entry)) return [];
    const field = printed[family]?.field;
    if (field === entry.rowField) return [];
    return [
      `a_row_a_plan_iterates_says_when_iterating_it_is_work:${family}:${entry.rowField} ` +
        `(the recipe guards on it and a row prints ${field === undefined ? "no state at all" : `\`${field}\``})`,
    ];
  });
}

/** The Mod source a `publishedAsWork` reason cites, in the one spelling a citation may take: `<file>.cs:<from>-<to>`. */
const PUBLICATION_CITATION = /`([A-Za-z][A-Za-z0-9_.]*)\.cs:(\d+)-(\d+)`/u;

/**
 * The anchor a `publishedAsWork` reason owes: a citation of the Mod code whose publication predicate makes the family the
 * condition, and a named symbol that citation really contains.
 *
 * WITHOUT THIS, `publishedAsWork` IS A FREE-TEXT EXCUSE: the exemption would be prose a lane could write about any family
 * - the list of reasons that outlive their reason, which is what every other table in this tree avoids by deriving its
 * population. A reason that names real C# and a range that really mentions the symbol is as far as a test can reach into
 * another language, and it is enough to make the escape hatch cost a citation.
 */
function publicationAnchorFindings(family: string, reason: string): readonly string[] {
  const prefix = `a_row_a_plan_iterates_says_when_iterating_it_is_work:${family}:published-as-work`;
  const cited = PUBLICATION_CITATION.exec(reason);
  if (cited === null) return [`${prefix} (the reason cites no \`<file>.cs:<from>-<to>\`)`];
  const source = readFileSync(resolve(hostRoot, `../integrations/stardew/${cited[1] as string}.cs`), "utf8").split(
    "\n",
  );
  const from = Number(cited[2]);
  const to = Number(cited[3]);
  if (!(from >= 1 && to >= from && to <= source.length))
    return [
      `${prefix} (${cited[1] as string}.cs has ${String(source.length)} lines, and the reason cites ${String(from)}-${String(to)})`,
    ];
  const citedLines = source.slice(from - 1, to).join("\n");
  const symbols = [...reason.replace(cited[0], "").matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/gu)].map(
    (match) => match[1] as string,
  );
  const anchored = symbols.filter((symbol) => citedLines.includes(symbol));
  if (anchored.length > 0) return [];
  return [
    `${prefix} (none of ${symbols.length === 0 ? "the reason's own symbols, of which it names none" : symbols.join(", ")} ` +
      `is in ${cited[1] as string}.cs:${String(from)}-${String(to)})`,
  ];
}

test("a_row_a_plan_iterates_says_when_iterating_it_is_work: every family the recipe iterates states its condition", () => {
  const reading = iteratedFamilyReading(planWorkDescription(CATALOG_ACTIONS));
  console.log(
    `a_row_a_plan_iterates_says_when_iterating_it_is_work: families ${String(reading.families.length)} · ` +
      `with-a-condition ${String(reading.conditioned)} · bare ${String(reading.bare.length)} ` +
      `(${reading.families.join(", ")})`,
  );
  // Refuse to pass on nothing: a recipe that iterates no family agrees with every assertion below.
  assert.ok(
    reading.families.length > 0,
    "blocked: the recipe iterates no snapshot family, so this gate examined nothing",
  );
  assert.deepEqual(
    reading.bare,
    [],
    `these families are iterated by a recipe that never says when iterating them is work: ${reading.bare.join(", ")}`,
  );
  assert.deepEqual(
    reading.expired,
    [],
    `these conditions outlived the loops that named them: ${reading.expired.join(", ")}`,
  );
  assert.deepEqual(
    unprintedGuardFindings(reading),
    [],
    "a loop guards on a state no row of its family prints, which is `round80`'s tree",
  );
  // A condition may only name a field the wire publishes for that family's rows, and a `publishedAsWork` reason may only
  // claim a publication the Mod's own source really holds.
  const unanchored = reading.families.flatMap((family) => {
    const entry = PLAN_ITERATION_CONDITIONS[family];
    if (entry === undefined) return [];
    if ("publishedAsWork" in entry) return publicationAnchorFindings(family, entry.publishedAsWork);
    const fields = wireRowFieldNames(family);
    return fields.includes(entry.rowField)
      ? []
      : [
          `a_row_a_plan_iterates_says_when_iterating_it_is_work:${family}:${entry.rowField} ` +
            `(the wire publishes ${fields.length === 0 ? "no row record for this family" : fields.join(", ")})`,
        ];
  });
  assert.deepEqual(unanchored, [], `a condition rests on something nothing publishes: ${unanchored.join(" | ")}`);
});

/**
 * The loop the recipe writes over one family, taken out of the rendered description: from its `for (` to its closing
 * brace.
 *
 * The script a test compiles below is the product's own sentence, not a second copy of it - which is what makes the
 * reading a statement about what the recipe composes rather than about what this file would have written.
 */
function loopSourceOf(description: string, family: string): string {
  const start = description.search(new RegExp(`for \\(const [a-z][A-Za-z0-9_]* of snapshot\\.${family}\\)`, "u"));
  if (start < 0) assert.fail(`the recipe writes no loop over \`${family}\``);
  const end = description.indexOf("\n}", start);
  assert.notEqual(end, -1, `the \`${family}\` loop is closed`);
  return description.slice(start, end + 2);
}

/**
 * ROUND81, MEASURED WITHOUT A LIVE RUN: the recipe's own soil loop, compiled against the patch `plan_35` was written for.
 *
 * <p>
 * The live reading is the measurement this stands in for and it cannot be re-taken here (one run is in progress): `plan_35`
 * composed 25 `till_soil` nodes over x 58..70, y 18..20, every one answered `soil_already_tilled` with
 * `before=HoeDirt;settled_by=engine_flag:hoedirt=present`, and the run carries no `soil_tilled` receipt at all - so the
 * field was under the Hoe from the first observation, which is what the save template copies. What is measurable without
 * the game is what the RECIPE does with those rows, because the loop is a script and the compiler is in this tree.
 * </p>
 *
 * <p>
 * The two halves are the same sentence: over a patch whose rows say `hoeDirt: true` the loop writes NO call at all (the
 * compiler answers `plan_script_empty_no_builder_call`, which is the count of a plan that composed nothing), and over the
 * same patch with `hoeDirt: false` it writes the tills. That is the property the row's word has to carry: her reading said
 * `可种植 true`, and nothing in that word is the `hoeDirt` the guard tests.
 * </p>
 */
test("round81_composition: the recipe's own soil loop writes no till node over a patch already under the Hoe", () => {
  const loop = loopSourceOf(planWorkDescription(CATALOG_ACTIONS), "soilTiles");
  const patch = (hoeDirt: boolean) =>
    Array.from({ length: 39 }, (_, index) => ({
      x: 58 + (index % 13),
      y: 18 + Math.floor(index / 13),
      hoeDirt,
      blockX: 58,
      blockY: 18,
      blockW: 13,
      blockH: 3,
    }));
  const worked = compile(loop, { enabledActionIds: ["till_soil"], soilTiles: patch(true) });
  assert.equal(worked.status, "refused", "a patch already under the Hoe is a loop with nothing to do");
  assert.equal(
    refusalOf(worked),
    "plan_script_empty_no_builder_call",
    "and the answer says so by name rather than submitting an empty programme",
  );
  const bare = compile(loop, { enabledActionIds: ["till_soil"], soilTiles: patch(false) });
  assert.notEqual(
    bare.status,
    "refused",
    `the same loop over ground the Hoe admits composes work: ${String(bare.status)}`,
  );
  assert.ok(
    nodesOf(bare).every((node) => node.actionId === "till_soil"),
    "and every node it writes is the till the rows asked for",
  );
});

test("a_row_a_plan_iterates_says_when_iterating_it_is_work is red on a bare family, and names it", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  // No declaration at all: every family the recipe iterates is named, which is the state a new family arrives in.
  assert.deepEqual(
    iteratedFamilyReading(description, {}).bare,
    ["cropTargets", "soilTiles"],
    "a family iterated by the recipe with no declared condition is named by the gate",
  );
  // The guard taken out of the example is the row condition gone from the text, and the family whose state it tested is
  // named - which is what makes this a reading of the recipe rather than of the table beside it.
  const unguarded = description.replace("if (soil.hoeDirt !== true) ", "");
  assert.notEqual(unguarded, description, "the example guards the soil loop over the row's own state");
  assert.deepEqual(
    iteratedFamilyReading(unguarded).bare,
    ["soilTiles"],
    "deleting the guard from the recipe leaves the family it guarded with no condition, and the gate says which",
  );
  // An entry cannot outlive its loop.
  assert.deepEqual(
    iteratedFamilyReading(description, { ...PLAN_ITERATION_CONDITIONS, machineTargets: { rowField: "machineType" } })
      .expired,
    ["machineTargets"],
    "a condition for a family the recipe no longer iterates is red by that family's own name",
  );
  // A guard no row of the family prints is refused: this is `e7fd043f` with the state table taken back to its two-entry
  // shape, and the reading names the family and the field the guard asks about.
  assert.deepEqual(
    unprintedGuardFindings(iteratedFamilyReading(description), { colorTargets: { field: "color", label: "色" } }),
    [
      "a_row_a_plan_iterates_says_when_iterating_it_is_work:soilTiles:hoeDirt (the recipe guards on it and a row prints no state at all)",
    ],
    "a loop whose guarded state no row prints is the composition defect itself, named by family and field",
  );
  // And a `publishedAsWork` reason has to cite Mod source that really carries the symbols it names.
  assert.match(
    publicationAnchorFindings("cropTargets", "every row needs water")[0] ?? "",
    /^a_row_a_plan_iterates_says_when_iterating_it_is_work:cropTargets:published-as-work \(the reason cites no /u,
    "an excuse with no citation is a reason and not an anchor",
  );
  assert.match(
    publicationAnchorFindings(
      "cropTargets",
      "`DiscoverCropTargets` answers only `CropNeedsWater` rows (`farmhandexecutioncontroller.targetdiscovery.cs:1-3`)",
    )[0] ?? "",
    /is in farmhandexecutioncontroller\.targetdiscovery\.cs:1-3/u,
    "a citation that names a range not containing what it cites does not anchor the reason",
  );
  assert.deepEqual(
    publicationAnchorFindings(
      "cropTargets",
      (PLAN_ITERATION_CONDITIONS.cropTargets as { publishedAsWork: string }).publishedAsWork,
    ),
    [],
    "the shipped reason denotes the Mod code that publishes only rows needing the work",
  );
});

/**
 * A TILE OUTSIDE THE SNAPSHOT'S WINDOW IS NOT A TILE THE SNAPSHOT MEASURED EMPTY.
 *
 * <p>
 * Every displaced family is published through the Mod's Chebyshev discovery radius
 * (`ExecutionManager.TargetDiscoveryRadius`, six tiles), so past it the submit-moment snapshot holds no row for ANY
 * tile - not "no target", but "not asked". The compiler folded the two and refused a 3x20 strip the session had just
 * read tile by tile: `patch-3x20` dropped 30 of 30 clear nodes with
 * `plan_script_target_not_in_the_submitted_snapshot:weedTargets:51,7` for a strip that was genuinely full of weeds.
 * </p>
 *
 * <p>
 * THE ONE READING THAT REACHES SUCH A TILE is the rectangle query, and its rows reached only the model's answer. This
 * suite drives that reading into the compile the way the bridge now records it, and asserts the answers apart:
 * (1) INSIDE the window a family listing nothing is a measurement, and it refuses the step whose value has to be COPIED
 * (`remove_placed_item`'s id, `plan_script_target_not_in_the_submitted_snapshot`) while the same silence is no refusal at
 * all for a reading the body MINTS; (2) OUTSIDE it, a tile nothing on this side named is refused as
 * `plan_script_target_outside_the_read`, which states how many tiles the surviving read covers - or `replaced`, because
 * only the last read survives; (3) OUTSIDE it, a tile this session DID read is admitted when the action's reading is the
 * body's to mint at execution, and refused by name when it is not.
 * </p>
 *
 * <p>
 * WHY THE MINTS DECIDE WHICH SILENCE REFUSES: a value the executor answers for is answered from the LIVE tile at the
 * moment it acts, so a row this side never read is not a proof that the step cannot run - it is the reason the step is
 * written with a tile and no id. Only a reading that has to be COPIED can be refused for a missing row, which is the one
 * distinction every case below turns on.
 * </p>
 *
 * <p>
 * WHY ADMITTED AT ALL: the read is a PERMISSION, not a promise. It says what stood on the tile when she looked; the
 * promise is kept by the Mod, which mints the target at the moment it acts and refuses `*_target_changed` when the world
 * moved. That is why no revision equality is asserted anywhere below - a stale read that names the right tile and kind
 * is still good enough to let the node exist.
 * </p>
 */
const STRIP = Object.freeze({ x: 30, y: 4, w: 3, h: 20 });

/** One answered rectangle's rows: the coordinate, and what the Mod's classifier found standing there. */
function readRows(
  rectangle: Readonly<{ x: number; y: number; w: number; h: number }>,
  occupantKind: string,
): readonly Readonly<{ x: number; y: number; occupantKind: string }>[] {
  const rows: { x: number; y: number; occupantKind: string }[] = [];
  for (let offsetY = 0; offsetY < rectangle.h; offsetY += 1)
    for (let offsetX = 0; offsetX < rectangle.w; offsetX += 1)
      rows.push({ x: rectangle.x + offsetX, y: rectangle.y + offsetY, occupantKind });
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

function readOf(
  rows: readonly Readonly<{ x: number; y: number; occupantKind: string }>[],
  overrides: Partial<StardewTileRead> = {},
): StardewTileRead {
  return Object.freeze({
    location: "Farm",
    revision: 11,
    x: STRIP.x,
    y: STRIP.y,
    w: STRIP.w,
    h: STRIP.h,
    reads: 1,
    rows,
    ...overrides,
  });
}

/** The strip's first thirty tiles, written as the loop a plan would carry - the measured 30-node shape. */
function stripCalls(actionId: string, extra: string, tiles = 30): string {
  const body = tiles === 30 ? "y <= 13" : "y <= 23";
  return `for (let y = 4; ${body}; y += 1) for (let x = 30; x <= 32; x += 1) builder.${actionId}({ x, y${extra} });`;
}

test("inside the window a family that lists nothing for her tile measures it, and refuses only the reading that must be copied", () => {
  // (8,8) is Chebyshev 2 from her tile at (10,10): the published families reach it, so `worldObjectTargets: []` is the
  // snapshot MEASURING the tile. `remove_placed_item`'s identity has to be COPIED - `worldObjectTargets` has no arm in
  // `TileTargetMint` - so the measurement refuses the step, with the code and the words it always had.
  const copying = `builder.remove_placed_item({ x: 8, y: 8, expectedTargetId: "twig_named_by_hand" });`;
  assert.equal(
    firstRefusalOf(compile(copying, { worldObjectTargets: [] })),
    "plan_script_target_not_in_the_submitted_snapshot:worldObjectTargets:8,8",
  );
  // AND A READ THAT NAMES THE TILE DOES NOT OVERRULE IT. Inside the radius the family's silence is a measurement; if a
  // session read contradicts one, the compile answers with the snapshot's own claim rather than quietly preferring the
  // reading nobody re-checked.
  assert.equal(
    firstRefusalOf(compile(copying, { worldObjectTargets: [] }, readOf(readRows({ x: 8, y: 8, w: 1, h: 1 }, "twig")))),
    "plan_script_target_not_in_the_submitted_snapshot:worldObjectTargets:8,8",
  );
  // THE SAME SILENCE IS NOT A REFUSAL FOR A READING THE BODY MINTS: `cut_weeds` names `weedTargets` and its identity is
  // the executor's, so the tile is answered at the swing instead of the plan losing a step over a row nobody had to copy.
  const minted = compile(`builder.cut_weeds({ x: 8, y: 8 });`, { weedTargets: [] });
  assert.equal(minted.status, "compiled", JSON.stringify(minted.status === "refused" ? minted.reasonCode : null));
  assert.deepEqual(
    Object.keys(nodesOf(minted)[0]!.arguments).sort(),
    ["x", "y"],
    "the tile is the whole step - the executor names the weed",
  );
});

test("outside the window the refusal names the read, and says no reading was made", () => {
  const result = compile(`builder.remove_placed_item({ x: 30, y: 4, expectedTargetId: "world_named_by_hand" });`, {
    worldObjectTargets: [],
  });
  assert.equal(firstRefusalOf(result), "plan_script_target_outside_the_read:worldObjectTargets:30,4:read_covers=0");
});

test("outside the window a read that does not name the tile covers a stated number of tiles, not hers", () => {
  const elsewhere = readOf(readRows({ x: 40, y: 40, w: 3, h: 3 }, "twig"));
  assert.equal(
    firstRefusalOf(
      compile(
        `builder.remove_placed_item({ x: 30, y: 4, expectedTargetId: "world_named_by_hand" });`,
        { worldObjectTargets: [] },
        elsewhere,
      ),
    ),
    "plan_script_target_outside_the_read:worldObjectTargets:30,4:read_covers=9",
  );
});

test("outside the window a session that read twice says replaced, never a count that meant another read", () => {
  // Only the last read survives, so this side cannot say which of the session's readings the plan was written from - and
  // the number of the surviving one would silently mean "a different read".
  const second = readOf(readRows({ x: 40, y: 40, w: 3, h: 3 }, "twig"), { reads: 2 });
  assert.equal(
    firstRefusalOf(
      compile(
        `builder.remove_placed_item({ x: 30, y: 4, expectedTargetId: "world_named_by_hand" });`,
        { worldObjectTargets: [] },
        second,
      ),
    ),
    "plan_script_target_outside_the_read:worldObjectTargets:30,4:read_covers=replaced",
  );
});

test("a strip this session read compiles its plantings, and every node says where the proof came from", () => {
  // `patch-3x20`'s shape, on the reading that reaches the tiles: thirty plantings down a 3-wide strip the session read as
  // ONE rectangle. `seedTargets` is published and holds nothing, because the strip is twenty tiles outside the window -
  // which is exactly the fold this test exists to keep apart.
  const result = compile(
    stripCalls("plant_seed", `, expectedQualifiedItemId: "(O)472"`),
    { seedTargets: [] },
    readOf(readRows(STRIP, "none")),
  );
  assert.equal(
    result.status,
    "compiled",
    JSON.stringify(result.status === "refused" ? result.reasonCode : result.dropped),
  );
  const nodes = result.status === "compiled" ? result.program.nodes : [];
  assert.equal(nodes.length, 30, "thirty tiles, thirty nodes");
  for (const node of nodes) {
    assert.equal(Object.hasOwn(node.arguments, "expectedTargetId"), false, "the body mints the id at execution");
    assert.equal(Object.hasOwn(node.arguments, "slot"), false, "the body resolves the pack slot at execution");
  }
  // TWO READINGS PER NODE (the id and the slot), each naming the family, the tile it was proved on and the kind the read
  // found there - so a reader can tell "she read it" from "it is assumed".
  assert.equal(result.status === "compiled" ? result.resolvedFromObservationCount : 0, 60);
  const lines = result.status === "compiled" ? result.resolvedFromObservation : [];
  assert.equal(lines.length, MAX_REPORTED_PLAN_READINGS, "the list is bounded and the count is the population");
  for (const line of lines) {
    assert.match(
      line,
      /^n\d+:resolved_from_observation=plant_seed\.(expectedTargetId|slot);family=seedTargets;tile=3[0-2],\d+;kind=none$/u,
      "the proof names the node that carries it, the reading it answered, and the tile the session read",
    );
  }
  assert.equal(
    result.status === "compiled" ? result.resolvedAfterCount : -1,
    0,
    "no step of this plan made those tiles, so nothing is reported as a producer",
  );
});

test("the same strip of clear nodes compiles now that the body answers for its own tool slot", () => {
  // THE SAME STRIP, THE SAME READ, AND THE STEP EXISTS. `cut_weeds` declares TWO readings - the weed's opaque id and the
  // scythe's backpack slot - and the Mod's own row now says the body answers for both (`ResolvesToolSlotAtExecution`,
  // `try_select_declared_tool` in the handler), so nothing is left for this side to copy: the weed is minted from the
  // live tile when she swings and the tool is the one the row's `tool:scythe` claim selects. The rectangle read is the
  // whole proof, and the answer says so per node.
  const result = compile(stripCalls("cut_weeds", ""), { weedTargets: [] }, readOf(readRows(STRIP, "weed")));
  assert.equal(
    result.status,
    "compiled",
    JSON.stringify(result.status === "refused" ? result.reasonCode : result.dropped),
  );
  assert.equal(result.status === "compiled" ? result.program.nodes.length : -1, 30, "thirty tiles, thirty swings");
  for (const node of result.status === "compiled" ? result.program.nodes : [])
    assert.deepEqual(
      Object.keys(node.arguments).sort(),
      ["x", "y"],
      "every reading of this swing is the body's: no target id and no slot travel in the node",
    );
  assert.equal(
    result.status === "compiled" ? result.resolvedFromObservationCount : -1,
    60,
    "two readings per node, one for the weed and one for the scythe's slot",
  );
});

test("a fifteen-node clear program over a three-wide strip compiles, each node proved by the read", () => {
  // THE MEASURED SHAPE: nine weeds and six stones down a three-wide strip twenty tiles from her, read as ONE rectangle.
  // `weedTargets` and `rockSourceTargets` are published and hold nothing for those tiles, so each family's silence is
  // "not asked" rather than "measured empty" - and every node resolves BOTH of its readings from the tile it names: the
  // occupant's opaque id and the tool's backpack slot.
  const rows = [
    ...readRows({ x: STRIP.x, y: 4, w: 3, h: 3 }, "weed"),
    ...readRows({ x: STRIP.x, y: 7, w: 3, h: 2 }, "stone"),
  ];
  const script = [
    "for (let y = 4; y <= 6; y += 1) for (let x = 30; x <= 32; x += 1) builder.cut_weeds({ x, y });",
    "for (let y = 7; y <= 8; y += 1) for (let x = 30; x <= 32; x += 1) builder.break_rock({ x, y });",
  ].join("\n");
  const result = compile(script, { weedTargets: [], rockSourceTargets: [] }, readOf(rows));
  assert.equal(
    result.status,
    "compiled",
    JSON.stringify(result.status === "refused" ? result.reasonCode : result.dropped),
  );
  assert.equal(result.status === "compiled" ? result.program.nodes.length : -1, 15, "nine weeds and six stones");
  assert.deepEqual(
    result.status === "compiled" ? [...new Set(result.program.nodes.map((node) => node.actionId))].sort() : [],
    ["break_rock", "cut_weeds"],
  );
  // THIRTY READINGS: fifteen targets and fifteen tool slots, every one of them the body's to mint. The count is the
  // population, so a reading that quietly stopped being resolved fails here instead of passing on a shorter list.
  assert.equal(result.status === "compiled" ? result.resolvedFromObservationCount : -1, 30);
});

/**
 * THE THIRD ACTION OF THE MEASURED PROGRAM IS STILL REFUSED, AND FOR A DIFFERENT READING.
 *
 * `remove_placed_item` now resolves its SLOT like the other fourteen (`ResolvesToolSlotAtExecution`), and its
 * `expectedTargetId` is still the caller's: `worldObjectTargets` has no arm in `TileTargetMint`, so the Mod cannot mint a
 * twig's identity from a tile and the declaration that would let a plan omit it does not exist. The refusal therefore
 * names `expectedTargetId` rather than `slot`, which is the one fact a reader needs to know before writing the next node
 * - and it is pinned here so the day that mint learns the family, this line goes red and the test is re-read.
 * </p>
 *
 * <p>
 * AND IT IS NOT A PROMISE ABOUT THE WORLD, WHICH THIS SIDE STILL DOES NOT CHECK. A rectangle read proves what stood where
 * she looked, and the Mod refuses a tile that holds something else by name (`break_rock_target_changed:stone:tree`,
 * `named_tile=30,4`) - which
 * `WorkThatIsAlreadyDoneIsTheOutcomeTests.ABreakRockSwingGivenNoTargetOrSlotOverATreeRefusesAndNamesTheTile` drives. A
 * per-action occupant rule here would be a second spelling of the `Clears` declaration the Mod already enforces.
 * </p>
 */
test("the third action of the measured program is refused for the reading the mint still cannot name", () => {
  const result = compile(
    `builder.remove_placed_item({ x: 30, y: 9 });`,
    { worldObjectTargets: [] },
    readOf([...readRows({ x: 30, y: 9, w: 1, h: 1 }, "twig")]),
  );
  assert.equal(
    firstRefusalOf(result),
    "plan_script_reading_outside_the_submitted_snapshot:remove_placed_item.expectedTargetId:worldObjectTargets:30,9",
  );
});

test("a read of another map proves nothing about this one", () => {
  const town = readOf(readRows(STRIP, "none"), { location: "Town" });
  const result = compile(stripCalls("plant_seed", `, expectedQualifiedItemId: "(O)472"`), { seedTargets: [] }, town);
  // THE STEPS EXIST BECAUSE THE BODY MINTS THEIR IDS, NOT BECAUSE SHE LOOKED. `plant_seed`'s slot and identity are
  // declared resolved at execution, so a strip past the snapshot's window is writable without a single row - and the
  // read she DID make named another map, so not one node claims a proof. A read is a permission this side records, never
  // the condition of the step existing.
  assert.equal(result.status, "compiled", JSON.stringify(result.status === "refused" ? result.reasonCode : null));
  assert.equal(result.status === "compiled" ? result.program.nodes.length : -1, 30, "thirty tiles, thirty plantings");
  assert.equal(
    result.status === "compiled" ? result.resolvedFromObservationCount : -1,
    0,
    "a read of another map proved nothing about these tiles, and nothing may report it as if it had",
  );
  assert.deepEqual(result.status === "compiled" ? result.resolvedFromObservation : [], []);
});

/**
 * THE TILE IS THE ADDRESS, AND NOTHING ELSE HAS TO BE: `round99`'s plan, written as the plan it should have been.
 *
 * <p>
 * Twenty `move_to_tile` steps to a crop nine to thirty-five tiles away, then the swing. `harvestTargets` publishes nothing
 * for that tile - its family reaches six tiles, so the tile is past the window - and this session made no rectangle read,
 * so there is no row and no proof to copy. The plan compiles anyway: `harvest_crop`'s own row declares `expectedTargetId`
 * resolved at execution, so the executor mints the crop's identity from the LIVE tile when it swings.
 * </p>
 *
 * <p>
 * WHAT IS ASSERTED IS THE OMISSION AND ITS HONESTY. Not one node carries an id, so a caller can write the plan from the
 * block she is standing on; and nothing reports a reading that was never made (`resolvedFromObservation` empty), because
 * an omission the executor answers for is not a measurement this side took.
 * </p>
 */
test("a plan that walks twenty tiles and then harvests compiles with no id anywhere in it", () => {
  const result = compile(
    [
      "for (let step = 1; step <= 20; step += 1) builder.move_to_tile({ x: 10, y: 10 + step });",
      `builder.harvest_crop({ x: 10, y: 30, expectedQualifiedItemId: "(O)24" });`,
    ].join("\n"),
    { harvestTargets: [] },
  );
  assert.equal(result.status, "compiled", JSON.stringify(result.status === "refused" ? result.reasonCode : null));
  const nodes = nodesOf(result);
  assert.equal(nodes.length, 21, "twenty walks and the swing");
  assert.equal(nodes.at(-1)!.actionId, "harvest_crop");
  assert.deepEqual(
    Object.keys(nodes.at(-1)!.arguments).sort(),
    ["expectedQualifiedItemId", "x", "y"],
    "the crop she means and the tile she names - the identity is the executor's",
  );
  assert.equal(
    JSON.stringify(nodes).includes("expectedTargetId"),
    false,
    "no node of the plan carries an id, so the whole script can be written from the blocks she was handed",
  );
  assert.equal(
    result.status === "compiled" ? result.resolvedFromObservationCount : -1,
    0,
    "nobody read this tile, so no proof is reported - the omission is the executor's answer, not this side's measurement",
  );
  assert.equal(
    validateBodyProgramCandidateRequest({ programId: planProgramId("session_a", 11, nodes), nodes }),
    null,
    "the plan is one the real Body Program validator accepts",
  );
});

/**
 * THE WINDOW THIS COMPILER REFUSES OUTSIDE IS THE MOD'S OWN RADIUS, read from the Mod's declaration.
 *
 * // source-invariant: the Host carries one number that only the Mod can decide - how far a published family reaches -
 * //   and no compiler can hold a C# const to a TypeScript const.
 * // source-expiry: when `TargetDiscoveryRadius` stops being a `const int` on `ExecutionManager` (a wire field, a config
 * //   value, a per-family radius), this read answers nothing and must be replaced by the publication that states it.
 */
test("the window the compiler splits the silence on is the Mod's TargetDiscoveryRadius", () => {
  const source = readFileSync(resolve(hostRoot, "../integrations/stardew/farmhandexecutioncontroller.cs"), "utf8");
  const declared = /internal const int TargetDiscoveryRadius = (\d+);/u.exec(source);
  assert.ok(declared, "the Mod still declares TargetDiscoveryRadius as a constant this gate can read");
  assert.equal(
    PLAN_SNAPSHOT_DISCOVERY_RADIUS,
    Number(declared[1]),
    `the compiler's window (${String(PLAN_SNAPSHOT_DISCOVERY_RADIUS)}) must be the Mod's published radius (${declared[1]})`,
  );
});
