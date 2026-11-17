import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TOOL_FOOTPRINT_TILES_BY_CHARGE, footprintTiles, packAreaSteps } from "./body-program-packing.js";
import { type CompiledPlan, compilePlanScript, planActionsFromRegistrations } from "./body-program-script.js";
import type { ActionRegistration, Snapshot } from "./protocol.js";

/**
 * THE BATCH IS A `for` LOOP, AND PACKING IS WHAT MAKES THAT AFFORDABLE.
 *
 * <p>
 * A loop over a 3x20 patch written as one builder call per tile is sixty dispatches, and at the wire's minimum charge
 * fifty-seven of them are refused `soil_already_tilled` - every walk the packing exists to save, handed straight back.
 * The packing pass therefore does not depend on a loop FORM: it reads the tiles the author named, and a run of
 * consecutive steps of the same action at the same charge whose tiles form a filled rectangle becomes the native uses
 * that cover exactly that rectangle. This file is the gate on that reading, and it is written against the author's own
 * nodes rather than against a vocabulary.
 * </p>
 * <p>
 * THE SECOND HALF IS THE CONSUMER RULE, AND IT IS THE PART THAT CAN BE WRONG SILENTLY. `dependsOn` means "skip me if
 * that failed"; `orderedAfter` means "wait for it, then run anyway". A step written on a tile a packed use covers must
 * consume THAT USE, so a use that failed skips the step written on the ground it did not work - not the node that used
 * to sit there (which no longer exists) and not merely the previous node in written order (which runs either way).
 * </p>
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
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[]; description?: string }>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
  targetFamily?: string;
}>;

const SURFACE = (
  JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { schema: unknown; actions: readonly SurfaceAction[] }
).actions;

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
            // The consumer rule is keyed on the family the Mod declares (`soilTiles`, `seedTargets`), so a fixture that
            // drops it makes every node address no world state - and the rule this file guards would pass vacuously.
            ...(action.targetFamily === undefined ? {} : { targetFamily: action.targetFamily }),
          },
        }),
  }),
);

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

/** A 2x3 patch: small enough to read, and the same shape as the strip the packing work is measured against. */
const PATCH = Object.freeze({ x: 60, y: 18, w: 2, h: 3 });

const PATCH_TILES: readonly { x: number; y: number }[] = Object.freeze(
  Array.from({ length: PATCH.w * PATCH.h }, (_, index) =>
    Object.freeze({ x: PATCH.x + (index % PATCH.w), y: PATCH.y + Math.floor(index / PATCH.w) }),
  ),
);

/** A gold hoe: `upgradeLevel` 3 is the ceiling the ladder reads, and the surface publishes no tool category here. */
const GOLD_HOE = Object.freeze({ upgradeLevel: 3 });

function snapshotWith(held: { upgradeLevel?: number } | null): Snapshot {
  return {
    revision: 11,
    location: "Farm",
    tile: { x: 60, y: 17 },
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
    ...(held === null ? {} : { currentToolSlot: 0, toolSlots: [{ slot: 0, label: "Hoe", ...held }] }),
  } as Snapshot;
}

function compile(script: string, held: { upgradeLevel?: number } | null): CompiledPlan {
  return compilePlanScript({ script }, { snapshot: snapshotWith(held), actions: ACTIONS });
}

/** The one `for` loop this file is written about: one builder call per tile of the patch. */
function tillPatch(charge: number): string {
  return `for (const tile of ${JSON.stringify(PATCH_TILES)}) builder.till_soil({ x: tile.x, y: tile.y, charge: ${String(charge)} });\n`;
}

/** A second action on one tile, so the consumer rule has something to decide. */
function plantOn(x: number, y: number): string {
  return `builder.plant_seed({ x: ${String(x)}, y: ${String(y)}, slot: 0, expectedQualifiedItemId: "(O)472", expectedTargetId: "target:${String(x)},${String(y)}" });\n`;
}

type PlanNode = Readonly<{
  nodeId: string;
  actionId: string;
  arguments: Readonly<Record<string, unknown>>;
  dependsOn: readonly string[];
  orderedAfter?: readonly string[];
}>;

function nodesOf(result: CompiledPlan): readonly PlanNode[] {
  if (!result.ok) assert.fail(`expected a plan, received ${result.reasonCode}`);
  return result.program.nodes as unknown as readonly PlanNode[];
}

function integerOf(node: PlanNode, name: string): number {
  return Number((node.arguments[name] as { canonicalValue: string }).canonicalValue);
}

function tileOf(node: PlanNode): { x: number; y: number } {
  return { x: integerOf(node, "x"), y: integerOf(node, "y") };
}

/** The tiles one node's use covers, read from the same ladder the packer reads. */
function coveredBy(node: PlanNode): readonly { x: number; y: number }[] {
  return footprintTiles(tileOf(node), TOOL_FOOTPRINT_TILES_BY_CHARGE[integerOf(node, "charge")]!, "y");
}

function byId(nodes: readonly PlanNode[], nodeId: string): PlanNode {
  const found = nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) assert.fail(`the program has no node ${nodeId}`);
  return found;
}

function stepOn(nodes: readonly PlanNode[], actionId: string, tile: { x: number; y: number }): PlanNode {
  const found = nodes.find(
    (node) => node.actionId === actionId && integerOf(node, "x") === tile.x && integerOf(node, "y") === tile.y,
  );
  if (found === undefined) assert.fail(`the program has no ${actionId} on ${String(tile.x)},${String(tile.y)}`);
  return found;
}

test("a `for` loop over a patch is tilled in the uses that cover it, not one node per tile", () => {
  const nodes = nodesOf(compile(tillPatch(0), GOLD_HOE));
  // The packer is the authority for HOW MANY, so this compares against it rather than against a number written here.
  const expected = packAreaSteps({ area: PATCH, kind: "charged_rectangle", maximumCharge: 3 });
  assert.equal(expected.status, "packed", "a 2x3 patch is a rectangle the ladder can cover");
  assert.ok(
    expected.steps.length < PATCH_TILES.length,
    `the packing must actually save steps before this case means anything: ${String(expected.steps.length)} of ${String(PATCH_TILES.length)}`,
  );
  assert.equal(
    nodes.length,
    expected.steps.length,
    "one builder call per tile compiles to the native uses that cover the patch, not one dispatch per tile",
  );
  for (const node of nodes) assert.equal(node.actionId, "till_soil", "each packed step is the published action");
  // EXACT COVERAGE: the union of the footprints is the patch, and no tile is covered twice (`soil_already_tilled`).
  const covered = new Set<string>();
  let tiles = 0;
  for (const node of nodes)
    for (const tile of coveredBy(node)) {
      covered.add(`${String(tile.x)},${String(tile.y)}`);
      tiles += 1;
    }
  assert.equal(tiles, covered.size, "no two packed uses cover the same tile");
  assert.deepEqual(
    [...covered].sort(),
    PATCH_TILES.map((tile) => `${String(tile.x)},${String(tile.y)}`).sort(),
    "the packed uses cover exactly the tiles the loop named, and nothing outside them",
  );
});

test("a step written on a packed tile consumes the use that covers it, so a failed use skips it", () => {
  const nodes = nodesOf(compile(`${tillPatch(0)}${plantOn(60, 20)}${plantOn(61, 19)}`, GOLD_HOE));
  // Two tiles in different uses: a positional answer ("depend on the node before me") names one for both, and a
  // stale reference names a node the packing removed. Only containment separates them.
  const producers = [stepOn(nodes, "plant_seed", { x: 60, y: 20 }), stepOn(nodes, "plant_seed", { x: 61, y: 19 })].map(
    (step) => {
      const x = integerOf(step, "x");
      const y = integerOf(step, "y");
      // The population is the nodes that COVER the tile, read off the nodes themselves - so "exactly one" is asserted as
      // "exactly these", and a packing that emitted two covering uses would name both rather than pass on a count.
      // The `actionId` guard is not decoration: a step carries no footprint, and `coveredBy` on one answers nothing.
      const covering = nodes
        .filter((node) => node.actionId === "till_soil")
        .filter((node) => coveredBy(node).some((tileCovered) => tileCovered.x === x && tileCovered.y === y))
        .map((node) => node.nodeId);
      assert.deepEqual(
        step.dependsOn,
        covering,
        `the step on ${String(x)},${String(y)} consumes exactly the uses that cover it: ${covering.join(", ") || "none"}`,
      );
      return byId(nodes, step.dependsOn[0]!);
    },
  );
  for (const [index, producer] of producers.entries()) {
    const tile = [PATCH_TILES[4]!, PATCH_TILES[3]!][index]!;
    const covered = coveredBy(producer);
    assert.equal(producer.actionId, "till_soil", "what the step consumes is the use that tills its ground");
    assert.ok(
      covered.length > 1,
      `${producer.nodeId} covers ${String(covered.length)} tile(s): the producer of a step on packed ground is the packed use, not one tile's own node`,
    );
    assert.ok(
      covered.some((tileCovered) => tileCovered.x === tile.x && tileCovered.y === tile.y),
      `${producer.nodeId} must cover ${String(tile.x)},${String(tile.y)}: a use that failed has to SKIP the step written on the ground it did not work`,
    );
  }
  assert.notEqual(
    producers[0]!.nodeId,
    producers[1]!.nodeId,
    "two tiles in different uses consume different uses - the producer is the use that covers the tile, not the one written last",
  );
});

test("every edge a packed program carries names a node that is in it, and each node waits for the one before", () => {
  const nodes = nodesOf(compile(`${tillPatch(0)}${plantOn(60, 20)}${plantOn(61, 19)}`, GOLD_HOE));
  const ids = new Set(nodes.map((node) => node.nodeId));
  for (const node of nodes) {
    for (const edge of [...node.dependsOn, ...(node.orderedAfter ?? [])])
      assert.ok(
        ids.has(edge),
        `${node.nodeId} edges to ${edge}, which is not in the program: a packed-away node's id refers to work no node does`,
      );
    // The Mod's own claim rule (`BodyProgramGraphRules.UnorderedClaimPairs`): every published action claims the one
    // body, so two steps ordered by neither are refused with `resource_conflict`. The packed program must not be the
    // first program this compiler produces that the other side refuses.
    const position = nodes.indexOf(node);
    if (position > 0) {
      const previous = nodes[position - 1]!.nodeId;
      const union = new Set([...node.dependsOn, ...(node.orderedAfter ?? [])]);
      assert.ok(
        union.has(previous),
        `${node.nodeId} must be ordered after ${previous}, or the Mod refuses the program as a resource conflict`,
      );
    }
  }
});

test("a run the tool cannot reach is left one node per tile, and each step consumes its own tile", () => {
  // Charge 4 is above the gold ceiling of 3, so the packing declines: the rectangle is still the author's to work, one
  // node per tile, and the Mod answers each over-charged use by name.
  const nodes = nodesOf(compile(`${tillPatch(4)}${plantOn(60, 20)}`, GOLD_HOE));
  assert.equal(
    nodes.filter((node) => node.actionId === "till_soil").length,
    PATCH_TILES.length,
    "an unpackable run is not silently packed at a ceiling the caller did not ask for",
  );
  const plant = stepOn(nodes, "plant_seed", { x: 60, y: 20 });
  assert.equal(plant.dependsOn.length, 1);
  const producer = byId(nodes, plant.dependsOn[0]!);
  assert.deepEqual(
    tileOf(producer),
    { x: 60, y: 20 },
    "with no packing, the producer is the step written on the tile itself",
  );
});
