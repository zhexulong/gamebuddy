import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PLAN_PACKING_FOOTPRINT_UNKNOWN,
  PLAN_PACKING_NOT_PACKABLE,
  TOOL_FOOTPRINT_MAXIMUM_CHARGE,
  TOOL_FOOTPRINT_TILES_BY_CHARGE,
  footprintTiles,
  heldToolChargeCeiling,
  packAreaSteps,
  packingTimeMs,
  toolChargeCeilingForClaim,
} from "./body-program-packing.js";
import { repositoryRoot } from "./wire-declaration.test-support.js";

/**
 * The pace this file must price a plan with, read from the module the perf gate reads it from.
 *
 * The two numbers are NOT restated here: `ANIMATION_CLASS.toolSwing` is the engine's swing and `BODY_WALK_MS_PER_TILE` is
 * the pace our own body crosses a tile at, measured from the route receipts. A test holding its own copy of either would
 * agree with the resolver today and stop agreeing the day the pace standard changes - which is the defect the parity test
 * below exists for.
 */
const pace = (await import(
  pathToFileURL(join(repositoryRoot(import.meta.dirname), "tools", "lib", "action-pace.mjs")).href
)) as Readonly<{
  ANIMATION_CLASS: Readonly<{ toolSwing: number }>;
  BODY_WALK_MS_PER_TILE: Readonly<{ value: number }>;
  WALK_MS_PER_TILE: number;
}>;

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

test("the swing and the walk are the pace standard's numbers, not this file's", () => {
  // ONE DECLARATION, ONE COPY THAT CANNOT DRIFT. `NATIVE_COST` lives in the resolver because the Host cannot import an
  // `.mjs` from `tools/` at build time, so this compares the copy against the declaration it exists to mirror - through
  // `packingTimeMs`, on a real plan, rather than against a second hard-coded number here.
  const tap = packAreaSteps({ area: { x: 10, y: 20, w: 1, h: 1 }, kind: "charged_rectangle", maximumCharge: 4 });
  assert.equal(
    packingTimeMs(tap.steps, 0),
    pace.ANIMATION_CLASS.toolSwing,
    "one tap's priced time is one engine swing and nothing else",
  );
  const strip = packAreaSteps({ area: PATCH, kind: "charged_rectangle", maximumCharge: 4 });
  assert.ok(strip.walkTiles > 0, "the population must walk, or the comparison below agrees with itself");
  assert.equal(
    packingTimeMs(strip.steps) - packingTimeMs(strip.steps, 0),
    strip.walkTiles * pace.BODY_WALK_MS_PER_TILE.value,
    "the walk the resolver prices is the walk the body's own receipts measure, and not the engine's walking pace",
  );
  assert.notEqual(
    pace.BODY_WALK_MS_PER_TILE.value,
    pace.WALK_MS_PER_TILE,
    "the body's measured pace and the engine's walking floor are different facts: pricing a plan with the floor is the" +
      " defect this file was corrected for",
  );
});

test("the charge is chosen by TIME, not by step count", () => {
  // THE OBJECTIVE IS THE PLAN'S OWN CLOCK, and every column of the table below is DERIVED from the two authorities rather
  // than restated: `use` is the swing-plus-charge part (`packingTimeMs` at 0 ms/tile), `swing` is the shared engine
  // constant times the uses, `walk` is what the remaining time is made of, and `at the engine's walk` re-prices THE SAME
  // steps at `WALK_MS_PER_TILE` - which is what this resolver used to charge, and which bought exactly these plans while
  // over-pricing every walked tile by 2.3x.
  //
  // AND THE TABLE SAYS WHY THE TOOL LEVEL MATTERS MORE THAN THE CONSTANT. At the fixture's level (0) the packer saves
  // nothing: sixty tiles need sixty uses, `body-program-script.ts` refuses a packing that saves no step
  // (`packing.steps.length >= tiles`), and the round47 job compiles to one `for_each` loop per family. The 49,849 -> 17,162
  // span across the ladder is what an upgraded hoe is worth to this job, and no recorded bundle has one: all 421
  // `toolSlots[].upgradeLevel` readings in `.live-runs` are 0.
  const strip = { x: 10, y: 20, w: 3, h: 20 };
  const rows = TIERS.map(({ tier, maximumCharge }) => {
    const plan = packAreaSteps({ area: strip, kind: "charged_rectangle", maximumCharge });
    const useMs = packingTimeMs(plan.steps, 0);
    const swingMs = plan.steps.length * pace.ANIMATION_CLASS.toolSwing;
    const atEngineWalk = Math.round(packingTimeMs(plan.steps, pace.WALK_MS_PER_TILE));
    return (
      `${tier}: uses ${String(plan.steps.length)} walk ${String(plan.walkTiles)} charge ${String(useMs - swingMs)}` +
      ` swing ${String(swingMs)} walk ${String(plan.timeMs - useMs)} total ${String(plan.timeMs)}` +
      ` (${String(atEngineWalk)}, ${String(plan.timeMs - atEngineWalk)})`
    );
  });
  assert.deepEqual(rows, [
    "level_0_basic: uses 60 walk 97 charge 0 swing 28800 walk 21049 total 49849 (77790, -27941)",
    "copper: uses 24 walk 97 charge 10800 swing 11520 walk 21049 total 43369 (71310, -27941)",
    "steel: uses 12 walk 77 charge 14400 swing 5760 walk 16709 total 36869 (59049, -22180)",
    "gold: uses 12 walk 26 charge 10800 swing 5760 walk 5642 total 22202 (29691, -7489)",
    "iridium: uses 9 walk 26 charge 7200 swing 4320 walk 5642 total 17162 (24651, -7489)",
    "iridium_reaching: uses 9 walk 26 charge 7200 swing 4320 walk 5642 total 17162 (24651, -7489)",
  ]);
  // The chosen charges, which is what an objective on steps alone cannot produce: the tail of two rows has no ladder shape
  // that fits it, so it is worked one tile per step while the body of the patch is charged. The tail is SIX TILE-SIZED
  // POKES and not one charge-2 use, and the price is why rather than an assumption: a 1x5 named anywhere inside the two
  // remaining rows covers three tiles the region never named, so it is not a candidate at all (exactness is a hard
  // constraint), and 1x3 does not fit two rows either.
  const chargesOf = (maximumCharge: number): string =>
    [...packAreaSteps({ area: strip, kind: "charged_rectangle", maximumCharge }).steps]
      .map((step) => step.charge)
      .sort((a, b) => a - b)
      .join("");
  assert.equal(chargesOf(3), "000000333333", "gold: six charged 3x3 uses and a six-tile tail");
  assert.equal(chargesOf(4), "000000444", "iridium: three charged 3x6 uses and a six-tile tail");
  assert.equal(chargesOf(2), "222222222222", "steel: every use fits five rows of the strip exactly");
});

test("the Reaching ladder buys a plan only at the pace the body walks", () => {
  // NINE WIDE BY FIVE TALL IS THE CASE WHERE THE WALK PRICE ALONE DECIDES. Both plans are nine uses, so a resolver scoring
  // step count cannot tell them apart: at the body's 217 ms/tile the Reaching plan (six pokes, a 3x3 and a 5x5 over twenty
  // walked tiles) is the cheap one; at the engine's 505 ms/tile the same two plans swap places and the nine 3x3s win on
  // eight walked tiles. That swap is the red proof for the constant: reverting `NATIVE_COST.walkMsPerTile` to the engine's
  // walking pace makes the first assertion below fail, because `timeMs` would then be the 505-priced column.
  const area = Object.freeze({ x: 10, y: 20, w: 9, h: 5 });
  const reaching = packAreaSteps({ area, kind: "charged_rectangle", maximumCharge: 5 });
  const withoutReaching = packAreaSteps({ area, kind: "charged_rectangle", maximumCharge: 4 });
  assert.equal(
    reaching.steps.length,
    withoutReaching.steps.length,
    "both plans are nine uses: only the price separates them",
  );
  assert.ok(
    reaching.timeMs < withoutReaching.timeMs,
    `at the body's pace the 5x5 plan is cheaper: ${String(reaching.timeMs)} vs ${String(withoutReaching.timeMs)}`,
  );
  assert.ok(
    packingTimeMs(withoutReaching.steps, pace.WALK_MS_PER_TILE) < packingTimeMs(reaching.steps, pace.WALK_MS_PER_TILE),
    "at the engine's walking pace the same two plans swap, which is why the price is not a preference",
  );
  // The shape the operator asked about, where the 5x5 does fit and does win: 5 wide by 20 tall, four uses of five rows,
  // fifteen walked tiles. Its engine-walk price is 21,496 ms and the body's is 17,175.
  const tall = packAreaSteps({ area: { x: 10, y: 20, w: 5, h: 20 }, kind: "charged_rectangle", maximumCharge: 5 });
  assert.equal(tall.steps.length, 4, "four 5x5 uses cover a five-wide twenty-tall patch exactly");
  assert.equal(tall.walkTiles, 15);
  assert.equal(tall.timeMs, 17175);
  assert.ok(
    tall.timeMs <
      packAreaSteps({ area: { x: 10, y: 20, w: 5, h: 20 }, kind: "charged_rectangle", maximumCharge: 4 }).timeMs,
    "with the enchantment the 5x5 is chosen; without it the same patch needs seventeen uses",
  );
});

test("a wide patch changes which tool wins, and that is the point of computing it", () => {
  // 20 columns by 3 rows: the same sixty tiles, a different answer. A 3x3 fits a three-row strip and a 1x5 band does not
  // reach it at all (forward 5 into 3 rows), so steel falls back to copper's plan and gold wins by eight uses at 19,746 ms
  // against 25,723. The REACHING ladder is no further help: a 5x5 covers five rows, and two of them lie outside a
  // three-row patch. The plan this test pinned before the exactness gate below existed - "only the 5x5 fits a twenty-wide
  // strip in four uses" - was four 3x3s, 36 of the sixty tiles, and the time objective preferred it BECAUSE it did less work.
  const wide = { x: 10, y: 20, w: 20, h: 3 };
  const steps = (maximumCharge: number): number =>
    packAreaSteps({ area: wide, kind: "charged_rectangle", maximumCharge }).steps.length;
  assert.equal(steps(0), 60);
  assert.equal(steps(1), 20);
  assert.equal(steps(2), 20, "a 1x5 band cannot fit three rows, so steel falls back to the same plan as copper");
  assert.equal(steps(3), 8, "six 3x3 uses across eighteen columns, then two one-wide strips in three-row bands");
  assert.equal(steps(5), 8, "a 5x5 footprint cannot cover a three-row patch exactly, so Reaching adds nothing here");
  // The price, not the count: steel and copper need the same twenty uses, and gold's eight walk eighteen tiles against
  // their nineteen - so gold wins on both axes and the eight-use gap is not what decided it.
  const time = (maximumCharge: number): number =>
    packAreaSteps({ area: wide, kind: "charged_rectangle", maximumCharge }).timeMs;
  assert.ok(time(3) < time(2), `gold ${String(time(3))} must beat steel ${String(time(2))} on the wide patch`);
});

/**
 * THE GATE, NOT A CASE: every region shape, every ceiling, tiled EXACTLY.
 *
 * <p>
 * The defect this closes lived in a region shape nobody had written a case for: a 20x3 patch at gold emitted seven uses
 * covering 57 of its sixty tiles, and at a Reaching ceiling four uses covering 36 - a plan that says the patch is worked
 * while a third of it is not, and that the time objective then PREFERS because covering less costs less. The size gate
 * above passed throughout, because its population was one region shape.
 * </p>
 * <p>
 * So the population here is the whole space: every width 1..13 against every height 1..13 against every ceiling the
 * ladder declares. Zero population is a failure rather than a pass, and every violation names the shape, the ceiling and
 * the tile, so the next reader does not have to find the region by hand.
 * </p>
 */
test("every region shape is tiled exactly at every ceiling the ladder declares", () => {
  const failures: string[] = [];
  const failingPairs = new Set<string>();
  let examined = 0;
  for (let w = 1; w <= 13; w++) {
    for (let h = 1; h <= 13; h++) {
      const area = Object.freeze({ x: 10, y: 20, w, h });
      const region = new Set<string>();
      for (let y = area.y; y < area.y + h; y++)
        for (let x = area.x; x < area.x + w; x++) region.add(String(x) + ":" + String(y));
      for (let ceiling = 0; ceiling <= TOOL_FOOTPRINT_MAXIMUM_CHARGE; ceiling++) {
        examined += 1;
        const label = String(w) + "x" + String(h) + "@" + String(ceiling);
        const fail = (detail: string): void => {
          failingPairs.add(label);
          failures.push(label + ": " + detail);
        };
        const plan = packAreaSteps({ area, kind: "charged_rectangle", maximumCharge: ceiling });
        if (plan.status !== "packed") fail("a readable ceiling must pack, not " + plan.status);
        const covered = new Map<string, number>();
        for (const step of plan.steps) {
          if (step.charge > ceiling) fail("a step asks for charge " + String(step.charge));
          const shape = TOOL_FOOTPRINT_TILES_BY_CHARGE[step.charge]!;
          for (const tile of footprintTiles({ x: step.x, y: step.y }, shape, "y")) {
            const key = String(tile.x) + ":" + String(tile.y);
            if (!region.has(key)) fail(key + " is outside the named region");
            covered.set(key, (covered.get(key) ?? 0) + 1);
          }
        }
        for (const [key, count] of covered) if (count > 1) fail(key + " is covered " + String(count) + " times");
        for (const key of region) if (!covered.has(key)) fail(key + " was never covered");
      }
    }
  }
  assert.equal(examined, 13 * 13 * (TOOL_FOOTPRINT_MAXIMUM_CHARGE + 1), "the population is the whole space");
  assert.deepEqual(
    failures.slice(0, 8),
    [],
    String(failingPairs.size) + " of " + String(examined) + " region/ceiling pairs are not tiled exactly",
  );
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

test("an unreadable tool reading refuses by name rather than inventing a footprint", () => {
  for (const [maximumCharge, reason] of [
    [undefined, PLAN_PACKING_FOOTPRINT_UNKNOWN + ":tool_claim"],
    [-1, PLAN_PACKING_FOOTPRINT_UNKNOWN + ":tool_claim_level"],
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

/**
 * THE CEILING IS THE TOOL THE MOD WILL SWING, and every branch of that reading is a different fact.
 *
 * <p>
 * The Mod resolves an action's own `tool:<category>` claim across the WHOLE pack and switches to the best tool it finds
 * for the length of the use (`resourcetoolactions.cs:857-887`, `:980-994`), so the tool in her hand is not the tool the
 * use is priced at. `heldToolChargeCeiling` is the FALLBACK for a pack that publishes no category word at all; the claim
 * decides everywhere else, and `undefined` - never zero - is what an unanswerable claim returns.
 * </p>
 */
test("the ceiling is the best tool the pack carries for the action's own claim", () => {
  const holdBasicOwnGold = {
    currentToolSlot: 1,
    toolSlots: [
      { slot: 1, upgradeLevel: 0, category: "hoe" },
      { slot: 7, upgradeLevel: 3, category: "hoe" },
    ],
  };
  const hoe = { category: "hoe", minimumUpgradeLevel: 0, maximumUpgradeLevel: null };
  assert.equal(
    toolChargeCeilingForClaim(holdBasicOwnGold, hoe),
    3,
    "a gold hoe in the bag is the tool `till_soil` is priced at, not the basic one in her hand",
  );
  // INVERSE: which slot the hand is in changes nothing about the tool the action takes.
  assert.equal(
    toolChargeCeilingForClaim({ ...holdBasicOwnGold, currentToolSlot: 7 }, hoe),
    3,
    "the same pack answers the same ceiling whichever hoe she happens to hold",
  );
  // BOUNDARY: a pack that publishes no category at all is a Mod older than that projection, so the held tool is the only
  // reading left - and a surface that declares no claim reads the same way.
  assert.equal(toolChargeCeilingForClaim({ currentToolSlot: 1, toolSlots: [{ slot: 1, upgradeLevel: 2 }] }, hoe), 2);
  assert.equal(toolChargeCeilingForClaim(holdBasicOwnGold, undefined), 0);
  // CROSS-CHECK: where her hand already holds the best, the two readings MUST agree - the defect was never the fallback,
  // it was using the fallback as the rule.
  const holdGold = { currentToolSlot: 7, toolSlots: [{ slot: 7, upgradeLevel: 3, category: "hoe" }] };
  assert.equal(toolChargeCeilingForClaim(holdGold, hoe), heldToolChargeCeiling(holdGold));
  // A pack that publishes categories and none of them is the claim's does not own the tool: `tool_not_owned` is the Mod's
  // refusal to make, and a footprint invented here would be spent on a swing the Mod refuses row by row.
  assert.equal(
    toolChargeCeilingForClaim({ currentToolSlot: 1, toolSlots: [{ slot: 1, upgradeLevel: 0, category: "axe" }] }, hoe),
    undefined,
  );
  // A claim that permits only the basic tier is satisfied by the basic hoe and NOT by the gold one, which is the level
  // range `ResolveOwnedTool` filters by before it ranks.
  assert.equal(
    toolChargeCeilingForClaim(
      { currentToolSlot: 7, toolSlots: [{ slot: 7, upgradeLevel: 3, category: "hoe" }] },
      { ...hoe, maximumUpgradeLevel: 0 },
    ),
    undefined,
  );
  // An absent level is the wire's own statement that the tool does not upgrade, and an absence is never read as zero.
  assert.equal(
    toolChargeCeilingForClaim({ toolSlots: [{ slot: 3, category: "scythe" }] }, { ...hoe, category: "scythe" }),
    undefined,
  );
  // The ladder stops at its own top, which is where the engine's own hold stops.
  assert.equal(
    toolChargeCeilingForClaim({ toolSlots: [{ slot: 1, upgradeLevel: 9, category: "hoe" }] }, hoe),
    TOOL_FOOTPRINT_MAXIMUM_CHARGE,
  );
});
