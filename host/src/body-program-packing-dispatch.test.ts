import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TOOL_FOOTPRINT_MAXIMUM_CHARGE,
  TOOL_FOOTPRINT_TILES_BY_CHARGE,
  footprintTiles,
  heldToolChargeCeiling,
  packingKindOf,
} from "./body-program-packing.js";
import { type CompiledPlan, compilePlanScript, planActionsFromRegistrations } from "./body-program-script.js";
import { type ActionRegistration, type Snapshot } from "./protocol.js";

/**
 * THE LOOP IS BYPASSED, NOT TAUGHT TO PACK.
 *
 * `for_each` expands one target per tile on the game thread (`FarmhandForEachExpansion.cs:373`), so a loop over a 3x20
 * patch at `charge: 3` becomes 60 dispatches of which 57 are refused `soil_already_tilled` - every walk the packing just
 * saved, handed back. The compiler therefore emits the packed steps as ordinary nodes instead, and this file is the gate
 * that keeps that true: the packed plan's footprints must cover the rectangle EXACTLY, and a caller who cannot be packed
 * must be left with the loop rather than with a guess.
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
          },
        }),
  }),
);

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

/** A 3x20 patch: the rectangle the pace work is measured against. */
const PATCH = Object.freeze({ x: 60, y: 18, w: 3, h: 20 });

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

function nodesOf(result: CompiledPlan): readonly (Record<string, unknown> & { arguments: Record<string, unknown> })[] {
  if (!result.ok) assert.fail(`expected a plan, received ${result.reasonCode}`);
  return [...result.program.nodes] as unknown as readonly (Record<string, unknown> & {
    arguments: Record<string, unknown>;
  })[];
}

function tillArea(charge: number | undefined): string {
  const step = charge === undefined ? '{ action: "till_soil" }' : `{ action: "till_soil", charge: ${String(charge)} }`;
  return `builder.for_each({ source: { area: { x: ${String(PATCH.x)}, y: ${String(PATCH.y)}, w: ${String(PATCH.w)}, h: ${String(PATCH.h)} } }, do: ${step} });`;
}

/** The tile each node names, from its canonicalised arguments. */
function tileOf(node: { arguments: Record<string, unknown> }): { x: number; y: number; charge: number } {
  const read = (name: string): number => Number((node.arguments[name] as { canonicalValue: string }).canonicalValue);
  return { x: read("x"), y: read("y"), charge: read("charge") };
}

test("a gold hoe packs a 3x20 patch into the native uses that cover it exactly", () => {
  // THE WORKED EXAMPLE, and it is measured rather than asserted: `native_gold_tools_v1` sets gold tools, the snapshot
  // reports upgradeLevel 3, and one `till_soil charge:3` completes `tiles_changed=9` over exactly the 3x3.
  const nodes = nodesOf(compile(tillArea(3), { upgradeLevel: 3 }));

  assert.equal(nodes.length, 12, "a 3x20 patch at gold is twelve native uses, not sixty dispatches");
  const covered = new Map<string, number>();
  let packed = 0;
  let tail = 0;
  for (const node of nodes) {
    assert.equal(node.actionId, "till_soil", "each packed step is the published action, not the loop form");
    const tile = tileOf(node);
    // SIX 3x3 USES COVER EIGHTEEN OF THE TWENTY ROWS; THE LAST TWO ROWS HAVE NO SHAPE ON THE LADDER THAT FITS THEM (a
    // 1x3 or 1x5 band is one column wide, and a 3x3 needs three rows), so they are worked one tile per step rather than
    // left uncovered or covered by a footprint that reaches past the patch.
    assert.ok(tile.charge === 3 || tile.charge === 0, `charge ${String(tile.charge)} is not what a gold hoe asks for`);
    if (tile.charge === 3) packed += 1;
    else tail += 1;
    const shape = TOOL_FOOTPRINT_TILES_BY_CHARGE[tile.charge]!;
    for (const cell of footprintTiles({ x: tile.x, y: tile.y }, shape, "y")) {
      const key = `${String(cell.x)}:${String(cell.y)}`;
      covered.set(key, (covered.get(key) ?? 0) + 1);
    }
  }
  assert.deepEqual({ packed, tail }, { packed: 6, tail: 6 }, "six charged uses and six single-tile steps for the tail");
  assert.deepEqual(
    [...covered.entries()].filter(([, count]) => count > 1),
    [],
    "no step may re-till a tile an earlier step covered: that walk is refused and buys nothing",
  );
  assert.equal(covered.size, PATCH.w * PATCH.h, "the union of the twelve footprints is the whole patch");
});

test("the compiler chooses the charge: the step's own value does not cap the footprint", () => {
  // THE MODEL MUST NOT HAVE TO WRITE A CHARGE. It names the patch; the compiler reads the held tool from the snapshot and
  // packs with the ladder that tool can reach. The value a step writes is a per-ROW fact and not a limit on that choice, so
  // at gold every charge at or below the held tool compiles to the SAME twelve uses - the description teaches `charge: 0`,
  // the wire's own minimum, and a compiler that read that as the intent handed the walk straight back.
  const gold = nodesOf(compile(tillArea(3), { upgradeLevel: 3 })).map(tileOf);
  for (const written of [0, 1, 2]) {
    assert.deepEqual(
      nodesOf(compile(tillArea(written), { upgradeLevel: 3 })).map(tileOf),
      gold,
      `a written charge of ${String(written)} packs the same plan as the ceiling`,
    );
  }
  assert.deepEqual(
    nodesOf(compile(tillArea(undefined), { upgradeLevel: 3 })).map(tileOf),
    gold,
    "an omitted charge packs exactly as the charge the held tool can reach",
  );
});

test("a packing that saves no step is left as the loop, which resolves its rows live", () => {
  // At level 0 there is nothing to pack: sixty single-tile steps are sixty nodes AND sixty walks, while one loop node is
  // one node whose rows the Mod resolves against the world. Emitting them would make the plan larger for no saving.
  const nodes = nodesOf(compile(tillArea(0), { upgradeLevel: 0 }));
  assert.equal(nodes.length, 1, "one loop, because the packing would not shorten the walk");
  assert.equal(nodes[0]!.actionId, "for_each");
});

test("an unreadable held tool leaves the loop alone instead of assuming level 0", () => {
  // `upgradeLevel` is absent on a Mod older than that projection and `currentToolSlot` is absent when nothing is held.
  // Reading either as level 0 would plan a one-tile patch for a gold hoe; packing from a guess is worse than not packing,
  // so the loop is emitted unchanged and the Mod runs it at the charge the caller wrote.
  const nodes = nodesOf(compile(tillArea(3), null));
  assert.equal(nodes.length, 1, "no packing without a readable ceiling");
  assert.equal(nodes[0]!.actionId, "for_each", "the caller's loop is the program they wrote, not a refusal");
});

test("the ceiling is read from the held slot and never invented", () => {
  assert.equal(heldToolChargeCeiling({ currentToolSlot: 0, toolSlots: [{ slot: 0, upgradeLevel: 3 }] }), 3);
  assert.equal(
    heldToolChargeCeiling({ currentToolSlot: 1, toolSlots: [{ slot: 0, upgradeLevel: 3 }] }),
    undefined,
    "the held slot is not in the tool list, so nothing is known about it",
  );
  assert.equal(
    heldToolChargeCeiling({ currentToolSlot: 0, toolSlots: [{ slot: 0 }] }),
    undefined,
    "an absent upgrade level is unknown, not zero",
  );
  assert.equal(
    heldToolChargeCeiling({ currentToolSlot: 0, toolSlots: [{ slot: 0, upgradeLevel: 9 }] }),
    TOOL_FOOTPRINT_MAXIMUM_CHARGE,
    "a level past the ladder is the top of the ladder, which is where the engine stops",
  );
});

test("the compiler reads each action's declared arguments, so charge is known only where it is declared", () => {
  // WIRE-ACCEPTS / PLAN-REFUSES WAS A LIVE SPLIT: `protocol.ts` accepted `charge` while the plan grammar refused it as
  // `plan_script_unknown_argument:till_soil.charge`, so a packed step would be rejected by the grammar that emitted it.
  // The grammar is not taught `charge` by name - it reads the action's declared argument rows - which is why packing works
  // and why this red proof is aimed at an action that does NOT declare it.
  const declared = compile(tillArea(3), { upgradeLevel: 3 });
  assert.ok(declared.ok, `a declared charge compiles: ${declared.ok ? "" : declared.reasonCode}`);

  const undeclared = compile("builder.move_to_tile({ x: 10, y: 10, charge: 0 });", { upgradeLevel: 3 });
  assert.equal(undeclared.ok, false, "move_to_tile declares no charge, so the plan must refuse it");
  assert.match(
    undeclared.ok ? "" : undeclared.reasonCode,
    /^plan_script_unknown_argument:move_to_tile[.]charge:allowed:x,y:declared_by:/,
    "the refusal names the argument, the set that action declares, and the actions that do declare it",
  );
});

test("packing is a property of the action's own declaration, not a list of ids", () => {
  assert.equal(packingKindOf(["x", "y", "charge"]), "charged_rectangle", "a tile, a charge and no per-tile identity");
  assert.equal(
    packingKindOf(["x", "y", "expectedTargetId", "charge"]),
    "single_tile",
    "a crop's opaque id cannot be manufactured for tiles the caller never named",
  );
  assert.equal(packingKindOf(["x", "y", "slot", "charge"]), "single_tile", "a backpack slot is not a tile fact");
  assert.equal(packingKindOf(["x", "y"]), "single_tile", "no charge, no rectangle");
});

/**
 * THE COMPLAINT, MEASURED AT THE LEVEL A PLAN IS READ AT: a 3x20 patch becomes the native uses the HELD TOOL covers.
 *
 * <p>
 * The script is the one `planWorkDescription` prints - an area and the wire's minimum charge, which is what a model
 * copies. Before this unit that value was read as the intent, so every level compiled to ONE loop node, the Mod expanded
 * sixty rows (`RouteReenteringBodyProgramExecutor.cs:442`), and the walk the resolver exists to save was handed back by
 * the tool's own example. The rows below are read back from the emitted NODES, which is what the Mod receives.
 * </p>
 *
 * <p>
 * red-proof: make `maximumCharge` the step's own `charge` again -> every line becomes `1_loop`, and level 3 costs sixty
 * standing positions instead of twelve.
 * </p>
 */
test("a 3x20 patch is the native uses the held tool covers, at every level, from the shape the tool teaches", () => {
  const rows: string[] = [];
  for (const level of [0, 1, 2, 3, 4]) {
    const nodes = nodesOf(compile(tillArea(0), { upgradeLevel: level }));
    // Level 0 has nothing to pack: sixty one-tile uses ARE the work, so the loop is left and the Mod expands the same
    // sixty rows from it. Emitting them as nodes would make the plan larger without making the walk shorter.
    if (nodes.length === 1 && nodes[0]!.actionId === "for_each") {
      rows.push(`level_${String(level)}=1_loop`);
      continue;
    }
    const covered = new Map<string, number>();
    const footprints = new Set<string>();
    let highest = 0;
    for (const node of nodes) {
      const tile = tileOf(node);
      highest = Math.max(highest, tile.charge);
      const shape = TOOL_FOOTPRINT_TILES_BY_CHARGE[tile.charge]!;
      footprints.add(`${String(shape.across)}x${String(shape.forward)}`);
      for (const cell of footprintTiles({ x: tile.x, y: tile.y }, shape, "y")) {
        const key = `${String(cell.x)}:${String(cell.y)}`;
        covered.set(key, (covered.get(key) ?? 0) + 1);
      }
    }
    assert.ok(highest <= level, `level ${String(level)}: no row asks for a charge the held tool cannot reach`);
    assert.deepEqual(
      [...covered.entries()].filter(([, count]) => count > 1),
      [],
      `level ${String(level)}: no tile may be worked twice`,
    );
    assert.equal(
      covered.size,
      PATCH.w * PATCH.h,
      `level ${String(level)}: the union of the footprints is the whole patch`,
    );
    rows.push(`level_${String(level)}=${String(nodes.length)}:${[...footprints].join("+")}`);
  }
  // One line per level: the rows the compiler emits, and the engine footprint each row declares. The tail of the patch
  // has no ladder shape that fits it (a 3x3 needs three rows), so it is worked one tile per step rather than covered by a
  // footprint reaching past the patch - which is why level 1 carries a 1x1 tail behind its 1x3 bands.
  assert.deepEqual(rows, [
    "level_0=1_loop",
    "level_1=24:1x3+1x1",
    "level_2=12:1x5",
    "level_3=12:3x3+1x1",
    "level_4=9:3x6+1x1",
  ]);
});

test("a filtered loop is never packed: the tiles its predicate excludes are never covered", () => {
  // THE HARD INVARIABLE, at the one place the compiler could still break it. `where` decides a row against the LIVE world,
  // so a loop that carries one names a subset of its rectangle - here the path columns of an intercropped patch - and the
  // compiler cannot know which tiles those are. A packed use covers every tile of its footprint, so packing it would till
  // the columns the caller excluded: the same rule the Mod's own sweep applies to an arc nobody named
  // (`farmhandexecutioncontroller.resourcetoolactions.cs:1428-1439`).
  const wide = "{ area: { x: 60, y: 18, w: 20, h: 3 } }";
  const unfiltered = nodesOf(
    compile(`builder.for_each({ source: ${wide}, do: { action: "till_soil", charge: 0 } });`, { upgradeLevel: 3 }),
  );
  assert.equal(
    unfiltered.length,
    8,
    "the same rectangle with no predicate IS packed, so the filter is the only variable",
  );
  const covered = new Set<string>();
  for (const node of unfiltered) {
    const tile = tileOf(node);
    for (const cell of footprintTiles({ x: tile.x, y: tile.y }, TOOL_FOOTPRINT_TILES_BY_CHARGE[tile.charge]!, "y"))
      covered.add(`${String(cell.x)}:${String(cell.y)}`);
  }
  assert.equal(
    covered.size,
    60,
    "those eight rows cover all twenty columns, which is exactly what a filtered loop may not",
  );
  // AND THE ROW IS NOT THE TILE: a charged use is named on ONE tile and works the tiles its footprint reaches, so the
  // tile a predicate would have excluded is reached by a row named somewhere else. Measured on the packed patch: the
  // middle of a 3x3 band is covered by the row named one tile north of it, which is why "packed unless filtered" is a
  // correctness rule and not a preference.
  const reachedFromElsewhere = unfiltered.filter((node) => {
    const tile = tileOf(node);
    const namesIt = tile.x === PATCH.x + 1 && tile.y === PATCH.y + 1;
    return (
      tile.charge > 0 &&
      !namesIt &&
      footprintTiles({ x: tile.x, y: tile.y }, TOOL_FOOTPRINT_TILES_BY_CHARGE[tile.charge]!, "y").some(
        (cell) => cell.x === PATCH.x + 1 && cell.y === PATCH.y + 1,
      )
    );
  });
  assert.equal(reachedFromElsewhere.length, 1, "one row covers that tile without being named on it");

  const filtered = nodesOf(
    compile(
      `builder.for_each({ source: ${wide}, where: [{ col: { every: 3, offset: 0 } }], do: { action: "till_soil", charge: 0 } });`,
      { upgradeLevel: 3 },
    ),
  );
  assert.equal(filtered.length, 1, "the filtered loop stays the caller's loop, whose rows the Mod decides live");
  assert.equal(filtered[0]!.actionId, "for_each");
});

test("a charge the held tool cannot reach is left to the Mod's per-row refusal, never packed at the ceiling", () => {
  // The one bound on the compiler's choice: a copper hoe and a `charge: 3` step is not silently repacked at 1, because the
  // native use the caller asked for is not the one this side would spend. The loop's rows answer
  // `charge_exceeds_tool_upgrade:3:1` by name, which is a repair the caller can make.
  const nodes = nodesOf(compile(tillArea(3), { upgradeLevel: 1 }));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.actionId, "for_each");
});
