import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ONE_CROP_PER_TILE_TARGET_FAMILIES } from "./body-program-planting.js";
import {
  type CompiledPlan,
  compilePlanScript,
  type PublishedPlanAction,
  planActionsFromRegistrations,
} from "./body-program-script.js";
import type { StardewTileRead } from "./game-connection.js";
import type { ActionRegistration, Snapshot } from "./protocol.js";

/**
 * ONE CROP PER TILE: a plan that sows a tile twice buys a dispatch the engine can only refuse.
 *
 * <p>
 * MEASURED `round97` (2026-11-23, ninth minute): 44 sow calls over 36 tiles, every duplication answered
 * `seed_target_unavailable;reason=soil_has_crop` - the receipt naming the item and the slot of a tile a node of the SAME
 * plan had just sown. `round84` (2026-11-20) is the same shape inside one program: of 54 `plant_seed` nodes, the tiles
 * `(59,18)` and `(59,12)` were each submitted twice, and 22 of the 54 answered `seed_target_unavailable`.
 * </p>
 *
 * <p>
 * THE FIELD THAT DOES NOT ANSWER IT IS `hoeDirt`, and that is the confusion this file pins: `soilTiles` publishes both soil
 * states, `hoeDirt: true` means "a HoeDirt is here" - the record of work already done - and a crop does not change it. So
 * "tilled" and "sowable" are two states under one word, and the guard that reads it is a TILL guard. The family that does
 * answer it is `seedTargets`, whose publication predicate is `dirt.crop is null && canPlantThisSeedHere`
 * (`DiscoverSeedTargets`), and a `HoeDirt` holds ONE crop.
 * </p>
 *
 * <p>
 * AND THE SNAPSHOT CANNOT ANSWER IT FOR TILE A PLAN HAS SOWN ITSELF: it was read before the plan ran, so the row is still
 * there saying the tile is empty. The program's own nodes are the only exact record, which is why the rule is asked there
 * (`planSecondSowRefusal`) and why the cost it pays - a tile an EARLIER PROGRAM sowed stays invisible - is stated in that
 * module rather than hidden.
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
  argumentSchema?: Readonly<
    Record<string, { type: string; enum?: readonly string[]; description?: string; resolvedAtExecution?: boolean }>
  >;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
  targetFamily?: string;
  approach?: Readonly<{ relation: string; withinTiles?: number }>;
}>;

const SURFACE = (JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { actions: readonly SurfaceAction[] }).actions;

/** The registrations the Mod publishes on hello_ack, rebuilt from the surface artifact the product ships. */
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
            ...(action.approach === undefined ? {} : { approach: action.approach }),
          },
        }),
  }),
);

const ACTIONS: readonly PublishedPlanAction[] = planActionsFromRegistrations(REGISTRATIONS);

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

function compile(script: string, overrides: Partial<Snapshot> = {}, tileRead?: StardewTileRead): CompiledPlan {
  return compilePlanScript(
    { script },
    {
      snapshot: { ...BASE_SNAPSHOT, ...overrides } as Snapshot,
      actions: ACTIONS,
      ...(tileRead === undefined ? {} : { tileRead }),
    },
  );
}

/** One `seedTargets` row per tile of a rectangle, in the shape the Mod publishes: empty HoeDirt and a live seed slot. */
function seedRows(rectangle: Readonly<{ x: number; y: number; w: number; h: number }>, slot = 19) {
  const rows: {
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    canPlantThisSeedHere: boolean;
    crop: boolean;
  }[] = [];
  for (let offsetY = 0; offsetY < rectangle.h; offsetY += 1)
    for (let offsetX = 0; offsetX < rectangle.w; offsetX += 1)
      rows.push({
        targetId: `seed_${String(rectangle.x + offsetX)}_${String(rectangle.y + offsetY)}`,
        slot,
        x: rectangle.x + offsetX,
        y: rectangle.y + offsetY,
        qualifiedItemId: "(O)472",
        displayName: "Parsnip Seeds",
        canPlantThisSeedHere: true,
        crop: false,
      });
  return rows;
}

/** One answered rectangle of a session's tile read: the tiles, and what the Mod's classifier found standing on them. */
function readOf(rectangle: Readonly<{ x: number; y: number; w: number; h: number }>): StardewTileRead {
  const rows: { x: number; y: number; occupantKind: string }[] = [];
  for (let offsetY = 0; offsetY < rectangle.h; offsetY += 1)
    for (let offsetX = 0; offsetX < rectangle.w; offsetX += 1)
      rows.push({ x: rectangle.x + offsetX, y: rectangle.y + offsetY, occupantKind: "none" });
  return Object.freeze({
    location: "Farm",
    revision: 11,
    x: rectangle.x,
    y: rectangle.y,
    w: rectangle.w,
    h: rectangle.h,
    reads: 1,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
}

/** The tile one node addresses, in the spelling every receipt uses. */
function tileOfNode(node: CompiledPlanNodes[number]): string {
  const text = (name: string): string => {
    const argument = node.arguments[name];
    return argument !== undefined && "canonicalValue" in argument ? String(argument.canonicalValue) : "?";
  };
  return `${text("x")},${text("y")}`;
}

type CompiledPlanNodes = Extract<CompiledPlan, { status: "compiled" }>["program"]["nodes"];

/** The nodes a plan that runs carries, in either state that runs. */
function nodesOf(result: CompiledPlan): readonly CompiledPlanNodes[number][] {
  return result.status === "refused" ? [] : result.program.nodes;
}

/** The calls a compile refused, in the two states that can carry one. */
function rejectionsOf(result: CompiledPlan): CompiledPlanRejections {
  return result.status === "compiled" ? [] : result.rejected;
}

type CompiledPlanRejections = Extract<CompiledPlan, { status: "partial" }>["rejected"];

/** The tiles the guard refused, read out of the refusals themselves rather than counted. */
function refusedTilesOf(result: CompiledPlan): readonly string[] {
  return rejectionsOf(result).map((rejection) => {
    const named = /^plan_script_tile_sown_twice:seedTargets:(\d+,\d+):sown_by=n\d+$/u.exec(rejection.reasonCode);
    assert.ok(named, `a refusal that does not carry the tile and the node that took it: ${rejection.reasonCode}`);
    return named[1] as string;
  });
}

test("round97_composition: a plan that sows a tile twice writes that sow once, and names the step that took it", () => {
  // THE MEASURED SHAPE, on the run's own numbers: 36 rows of sowable ground, and a rectangle loop over 20 tiles of which
  // 8 are tiles the first loop has already sown. The rectangle is twenty tiles from her, so the twelve calls that do NOT
  // duplicate a row are admitted by the session's own rectangle read - which is the other half of the evidence: what the
  // guard refuses is the duplicate, not the strip.
  const SOWN = Object.freeze({ x: 5, y: 5, w: 7, h: 4 });
  const DUPLICATED = Object.freeze({ x: 30, y: 4, w: 2, h: 4 });
  const RECTANGLE = Object.freeze({ x: 30, y: 4, w: 5, h: 4 });
  const script = [
    "for (const seed of snapshot.seedTargets ?? []) builder.plant_seed({ x: seed.x, y: seed.y, expectedQualifiedItemId: seed.qualifiedItemId });",
    "for (let y = 4; y <= 7; y += 1) for (let x = 30; x <= 34; x += 1) builder.plant_seed({ x, y, expectedQualifiedItemId: '(O)472' });",
  ].join("\n");
  const result = compile(script, { seedTargets: [...seedRows(SOWN), ...seedRows(DUPLICATED)] }, readOf(RECTANGLE));
  assert.equal(
    result.status,
    "partial",
    JSON.stringify(result.status === "refused" ? result.reasonCode : result.dropped),
  );
  const nodes = nodesOf(result);
  assert.equal(nodes.length, 48, "36 rows plus the 12 rectangle tiles no row had taken: one node per tile");
  // EVERY CALL IS ACCOUNTED FOR, and the eight the guard refused are the eight rectangle tiles the first loop sowed - the
  // tiles are read out of the refusals, not counted, so a refusal that named the wrong tile fails here.
  assert.deepEqual([...refusedTilesOf(result)].sort(), [
    "30,4",
    "30,5",
    "30,6",
    "30,7",
    "31,4",
    "31,5",
    "31,6",
    "31,7",
  ]);
  assert.equal(
    result.status === "partial" ? result.droppedCount : -1,
    8,
    "and the count is the population, not the bounded list",
  );
  // NO TILE APPEARS TWICE IN THE PROGRAM, which is the property the engine cannot be asked to hold: `HoeDirt.crop` is one
  // slot, so two sows on one tile can only end in `soil_has_crop`.
  const tiles = nodes.map(tileOfNode);
  assert.equal(new Set(tiles).size, tiles.length, `a tile is sown twice: ${tiles.join(" ")}`);
  // AND THE REFUSAL IS NOT SILENT: the author is told which of her own steps took the tile, because that is the step to
  // move or delete.
  const refusals = rejectionsOf(result);
  assert.match(
    refusals[0]!.reasonCode,
    /^plan_script_tile_sown_twice:seedTargets:30,4:sown_by=n\d+$/u,
    "the refusal names the family, the tile and the node of her own program that already sowed it",
  );
});

test("a sow into a tile this plan has not taken still dispatches, and keeps its own step", () => {
  // THE OTHER DIRECTION, without which the guard would be indistinguishable from a blanket ban on plantings: two rows on
  // two distinct tiles, both sowable - two nodes, nothing dropped.
  const result = compile(
    "for (const seed of snapshot.seedTargets ?? []) builder.plant_seed({ x: seed.x, y: seed.y, expectedQualifiedItemId: seed.qualifiedItemId });",
    { seedTargets: seedRows({ x: 8, y: 9, w: 2, h: 1 }) },
  );
  assert.equal(
    result.status,
    "compiled",
    JSON.stringify(result.status === "refused" ? result.reasonCode : result.dropped),
  );
  const nodes = nodesOf(result);
  assert.deepEqual(nodes.map(tileOfNode).sort(), ["8,9", "9,9"]);
});

test("one_crop_per_tile:<family> names a family a published action addresses by its tile", () => {
  // THE SET'S OWN PREMISE, crossed with the one fact the surface publishes: the rule reads the tile a step names, so a
  // member no published action addresses by `x`/`y` would be a refusal nobody can reach. Derived from the members
  // themselves, so a family added to `ONE_CROP_PER_TILE_TARGET_FAMILIES` joins this gate by being declared.
  assert.ok(ONE_CROP_PER_TILE_TARGET_FAMILIES.length > 0, "blocked: the set is empty, so this gate examined nothing");
  const unreachable = ONE_CROP_PER_TILE_TARGET_FAMILIES.flatMap((family) => {
    const addressing = ACTIONS.filter((action) => action.targetFamily === family);
    const declared = new Set(addressing.flatMap((action) => action.arguments.map((argument) => argument.name)));
    return addressing.length > 0 && declared.has("x") && declared.has("y")
      ? []
      : [
          `one_crop_per_tile:${family} (${addressing.length === 0 ? "no published action addresses it" : "no action addressing it declares x and y"})`,
        ];
  });
  assert.deepEqual(unreachable, [], `a family whose tiles no step can name: ${unreachable.join(" | ")}`);
});
