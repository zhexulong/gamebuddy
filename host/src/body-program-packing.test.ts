import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_PACKING_FOOTPRINT_UNKNOWN,
  PLAN_PACKING_NOT_PACKABLE,
  TOOL_FOOTPRINT_MAXIMUM_CHARGE,
  TOOL_FOOTPRINT_TILES_BY_CHARGE,
  footprintTiles,
  packAreaSteps,
} from "./body-program-packing.js";

/** The patch the user's question is about: three wide, twenty tall. */
const PATCH = Object.freeze({ x: 10, y: 20, w: 3, h: 20 });

/**
 * The tiers the pace table carries, from the snapshot's toolSlots upgrade level plus Reaching
 * (Game1.cs:13032-13051). `standingPositions` is the number the walk cost follows, because walking is 93.6% of a node.
 */
const TIERS = Object.freeze([
  { tier: "level_0_basic", maximumCharge: 0, expectedSteps: 60, expectedStandingPositions: 60 },
  { tier: "copper", maximumCharge: 1, expectedSteps: 24, expectedStandingPositions: 24 },
  { tier: "steel", maximumCharge: 2, expectedSteps: 12, expectedStandingPositions: 12 },
  { tier: "gold", maximumCharge: 3, expectedSteps: 12, expectedStandingPositions: 12 },
  { tier: "iridium", maximumCharge: 4, expectedSteps: 9, expectedStandingPositions: 9 },
  { tier: "iridium_reaching", maximumCharge: 5, expectedSteps: 9, expectedStandingPositions: 9 },
]);

test("the declared ladder is the engine's own shape, and its rows agree with themselves", () => {
  assert.equal(
    TOOL_FOOTPRINT_MAXIMUM_CHARGE,
    5,
    "the charge argument's own last value (Tool.cs:1062 compares power >= 6)",
  );
  for (const [charge, shape] of TOOL_FOOTPRINT_TILES_BY_CHARGE.entries()) {
    assert.equal(
      shape.tiles,
      shape.forward * shape.across,
      "charge " + String(charge) + ": tiles must be forward x across",
    );
    assert.ok(shape.forward >= 1 && shape.across >= 1, "charge " + String(charge) + ": a footprint has two sides");
    assert.ok(
      shape.back >= 0 && shape.back < shape.across,
      "charge " + String(charge) + ": back must shift inside the footprint",
    );
    assert.equal(
      footprintTiles({ x: 0, y: 0 }, shape, "y").length,
      shape.tiles,
      "charge " + String(charge) + ": footprintTiles must emit exactly the declared tile count",
    );
    if (charge > 0)
      assert.ok(
        shape.tiles > TOOL_FOOTPRINT_TILES_BY_CHARGE[charge - 1]!.tiles,
        "charge " + String(charge) + ": the ladder only grows",
      );
  }
});

test("a 3x20 patch is tiled EXACTLY: no overlap, no gap, no tile outside the region", () => {
  // THE GUARANTEE THE WALK COST NEEDS. A packed step is only cheaper if it does not send the body into ground an earlier
  // step already worked: a re-tilled tile is refused (soil_already_tilled) after a walk that bought nothing, and a tile
  // outside the region is a side effect the caller never named. Both are checked per tier from the FOOTPRINTS
  // themselves rather than from the step count.
  const region = new Set<string>();
  for (let y = PATCH.y; y < PATCH.y + PATCH.h; y++)
    for (let x = PATCH.x; x < PATCH.x + PATCH.w; x++) region.add(String(x) + ":" + String(y));

  const rows: string[] = [];
  for (const { tier, maximumCharge, expectedSteps, expectedStandingPositions } of TIERS) {
    const plan = packAreaSteps({ area: PATCH, kind: "charged_rectangle", maximumCharge });
    assert.equal(plan.status, "packed", tier + ": a readable ceiling packs");
    assert.equal(plan.reason, null, tier + ": a packed plan carries no refusal");
    assert.equal(plan.steps.length, expectedSteps, tier + ": steps for a 3x20 patch");
    assert.equal(plan.standingPositions, expectedStandingPositions, tier + ": standing positions (the walk cost)");

    const covered = new Map<string, number>();
    for (const step of plan.steps) {
      assert.ok(step.charge <= maximumCharge, tier + ": a step never asks for a charge the held tool cannot reach");
      const shape = TOOL_FOOTPRINT_TILES_BY_CHARGE[step.charge]!;
      const tiles = footprintTiles({ x: step.x, y: step.y }, shape, "y");
      assert.equal(tiles.length, step.tiles, tier + ": the step's declared tile count is its footprint's size");
      for (const tile of tiles) {
        const key = String(tile.x) + ":" + String(tile.y);
        assert.ok(region.has(key), tier + ": a step covers " + key + ", which is outside the named region");
        covered.set(key, (covered.get(key) ?? 0) + 1);
      }
    }
    const overlapped = [...covered.entries()].filter(([, count]) => count > 1);
    assert.deepEqual(overlapped, [], tier + ": no tile may be covered twice");
    assert.equal(covered.size, PATCH.w * PATCH.h, tier + ": the union of the footprints must be the whole patch");
    for (const key of region) assert.ok(covered.has(key), tier + ": " + key + " was never covered");
    rows.push(tier + "=" + String(plan.steps.length) + "/" + String(plan.standingPositions));
  }
  // Pinned as one string so a change to ANY tier names the tier, the steps and the standing positions.
  assert.equal(
    rows.join(" "),
    "level_0_basic=60/60 copper=24/24 steel=12/12 gold=12/12 iridium=9/9 iridium_reaching=9/9",
  );
});

test("GOLD is the worked example: a charge-3 use is one 3x3, which is what a real world read measured", () => {
  // native_gold_tools_v1 (ModEntry.Fixtures.ScenarioInitializers.cs:129) sets gold tools before bridge attachment, the
  // snapshot reports upgradeLevel 3, and one till_soil charge:3 completed tiles_changed=9 over exactly the 3x3
  // (GoldToolAreaCoverageTests). So the resolver's first step at ceiling 3 must be that same rectangle: the table is
  // measured, not asserted.
  const plan = packAreaSteps({ area: PATCH, kind: "charged_rectangle", maximumCharge: 3 });
  const first = plan.steps[0]!;
  assert.equal(first.charge, 3);
  assert.equal(first.tiles, 9, "one gold use covers nine tiles");
  const tiles = footprintTiles({ x: first.x, y: first.y }, TOOL_FOOTPRINT_TILES_BY_CHARGE[3]!, "y");
  const xs = [...new Set(tiles.map((tile) => tile.x))].sort((a, b) => a - b);
  const ys = [...new Set(tiles.map((tile) => tile.y))].sort((a, b) => a - b);
  assert.deepEqual(xs, [PATCH.x, PATCH.x + 1, PATCH.x + 2], "three columns");
  assert.deepEqual(ys, [PATCH.y, PATCH.y + 1, PATCH.y + 2], "three rows starting at the region's first row");
});

test("the charge is chosen by TIME, not by step count", () => {
  // THE OBJECTIVE IS THE ENGINE'S OWN CLOCK. Charge time grows with the level while coverage does not, so a plan with more
  // steps can be the faster one: on a 3-wide strip steel's 1x5 costs twelve uses of 1,680 ms and a 77-tile walk, while
  // gold's 3x3 covers the same strip in the same twelve uses with a 26-tile walk. A resolver that minimised steps would
  // still pick gold here - and would pick iridium on a 20-wide strip only by accident.
  const strip = { x: 10, y: 20, w: 3, h: 20 };
  const times = TIERS.map(({ tier, maximumCharge }) => {
    const plan = packAreaSteps({ area: strip, kind: "charged_rectangle", maximumCharge });
    return `${tier}=${String(plan.timeMs)}`;
  });
  assert.deepEqual(times, [
    "level_0_basic=77785",
    "copper=71305",
    "steel=59045",
    "gold=29690",
    "iridium=24650",
    "iridium_reaching=24650",
  ]);
  // The chosen charges, which is what an objective on steps alone cannot produce: the tail of two rows has no ladder shape
  // that fits it, so it is worked one tile per step while the body of the patch is charged.
  const chargesOf = (maximumCharge: number): string =>
    [...packAreaSteps({ area: strip, kind: "charged_rectangle", maximumCharge }).steps]
      .map((step) => step.charge)
      .sort((a, b) => a - b)
      .join("");
  assert.equal(chargesOf(3), "000000333333", "gold: six charged 3x3 uses and a six-tile tail");
  assert.equal(chargesOf(4), "000000444", "iridium: three charged 3x6 uses and a six-tile tail");
  assert.equal(chargesOf(2), "222222222222", "steel: every use fits five rows of the strip exactly");
});

test("a wide patch changes which tool wins, and that is the point of computing it", () => {
  // 20 columns by 3 rows: the same sixty tiles, the opposite answer. The 5x5 at charge 5 fits a twenty-wide strip and the
  // 3x6 at charge 4 does not fit three rows, so only a Reaching tool reaches four uses - the packing is a property of the
  // PATCH SHAPE as much as of the tool.
  const wide = { x: 10, y: 20, w: 20, h: 3 };
  const steps = (maximumCharge: number): number =>
    packAreaSteps({ area: wide, kind: "charged_rectangle", maximumCharge }).steps.length;
  assert.equal(steps(0), 60);
  assert.equal(steps(1), 20);
  assert.equal(steps(2), 20, "a 1x5 band cannot fit three rows, so steel falls back to the same plan as copper");
  assert.equal(steps(3), 7);
  assert.equal(steps(5), 4, "only the 5x5 fits a twenty-wide strip in four uses");
});

test("a shape wider than the patch is never used, even at the top of the ladder", () => {
  const plan = packAreaSteps({ area: PATCH, kind: "charged_rectangle", maximumCharge: 5 });
  assert.equal(plan.status, "packed");
  assert.equal(
    Math.max(...plan.steps.map((step) => step.charge)),
    4,
    "the 5-wide footprint must not be used on a 3-wide patch",
  );
});

test("a body-anchored arc is not packable and says so instead of guessing", () => {
  const plan = packAreaSteps({ area: PATCH, kind: "body_arc", maximumCharge: 4 });
  assert.equal(plan.status, "refused");
  assert.equal(plan.reason, PLAN_PACKING_NOT_PACKABLE + ":body_arc");
  assert.equal(plan.steps.length, 60, "the fallback is exactly one native use per tile");
  assert.equal(plan.standingPositions, 60);
});

test("an unreadable held tool refuses by name rather than inventing a footprint", () => {
  for (const [maximumCharge, reason] of [
    [undefined, PLAN_PACKING_FOOTPRINT_UNKNOWN + ":held_tool"],
    [-1, PLAN_PACKING_FOOTPRINT_UNKNOWN + ":held_tool_level"],
  ] as const) {
    const plan = packAreaSteps({ area: PATCH, kind: "charged_rectangle", maximumCharge });
    assert.equal(plan.status, "refused", String(maximumCharge));
    assert.equal(plan.reason, reason);
    assert.equal(plan.steps.length, 60, "the named refusal still returns the tile-per-step plan a human would write");
  }
});

test("a single-tile action keeps one step per tile and carries no refusal", () => {
  const plan = packAreaSteps({ area: { x: 2, y: 3, w: 2, h: 2 }, kind: "single_tile", maximumCharge: 4 });
  assert.equal(plan.status, "packed");
  assert.equal(plan.reason, null);
  assert.deepEqual(
    plan.steps.map((step) => [step.x, step.y, step.charge]),
    [
      [2, 3, 0],
      [3, 3, 0],
      [2, 4, 0],
      [3, 4, 0],
    ],
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.stanceX, step.stanceY]),
    [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ],
  );
});
