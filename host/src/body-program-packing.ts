/**
 * The plan compiler's packing: how one area becomes the FEWEST NATIVE USES, and therefore the fewest walks.
 *
 * THE MEASUREMENT THIS EXISTS FOR. Walking is 93.6% of a node's time (76,473 ms of 81,700 ms over 18 nodes); a native
 * use is 0.05% (44 ms in total) and per-node overhead between two `mod.execute` spans is p50 16 ms. So a charged use
 * covering 18 tiles does not mainly save 17 native calls - it saves **17 stand-and-walk sequences**. The resolver's
 * guarantee is therefore about FOOTPRINTS, not counts: no step may name a tile an earlier step already covered, and the
 * union of the emitted footprints must be exactly the region the caller named.
 *
 * THE ONE DECLARED TABLE. `TOOL_FOOTPRINT_TILES_BY_CHARGE` is the engine's own ladder (`Tool.tilesAffected`,
 * `Tool.cs:913-1074`) expressed as the rectangle ONE charged use covers, relative to the named tile: how far it reaches
 * along the facing axis (`forward`), how wide it is across it (`across`), and how many of those across-rows lie BEFORE
 * the named tile's own row (`back`).
 *
 * <para>
 * `back` is not decoration: the ladder is not centred on the named tile. A 3x3 spans one row either side of it
 * (`:972-982`), a 3x6 does the same (`:983-989`), and the 5x5 is centred two tiles forward (`:1062-1072`). A packing that
 * ignores it either re-tills a row it already tilled or leaves the patch's first row untouched. It lives on the Host
 * because the Host is what packs, and it is pinned to the engine by `ToolFootprintTableParityTests`, which enumerates
 * charge 0..5 through the engine's own `tilesAffected` (a test-only subclass, because the member is `protected`) and
 * compares tiles, forward, across AND back, failing as
 * `footprint_table_disagrees_with_engine:<charge>:<host>:<engine>`.
 * </para>
 *
 * THE LADDER IS NOT A DESCRIPTOR FACT. How far one use reaches depends on the HELD TOOL'S upgrade level - runtime state,
 * published in the snapshot as `toolSlots[].upgradeLevel`, bounded by `Game1.cs:13032-13051` - so no wire field is added
 * anywhere: the resolver reads the snapshot's fact and this table's geometry.
 */

/** One charged use's geometry, relative to the named tile. */
export type ToolFootprintShape = Readonly<{
  /** Tiles covered. */
  tiles: number;
  /** Reach along the facing axis; the named tile is the first one. */
  forward: number;
  /** Width across the facing axis. */
  across: number;
  /** How many across-rows lie BEFORE the named tile's own row. */
  back: number;
}>;

export const TOOL_FOOTPRINT_TILES_BY_CHARGE: readonly ToolFootprintShape[] = Object.freeze([
  // charge 0: the named tile alone (`:916-917`).
  Object.freeze({ tiles: 1, forward: 1, across: 1, back: 0 }),
  // charge 1: 1x3 forward (`:962-966`).
  Object.freeze({ tiles: 3, forward: 3, across: 1, back: 0 }),
  // charge 2: 1x5 forward (`:967-971`).
  Object.freeze({ tiles: 5, forward: 5, across: 1, back: 0 }),
  // charge 3: 3x3, the named tile on its near edge and one row either side (`:972-982`).
  Object.freeze({ tiles: 9, forward: 3, across: 3, back: 1 }),
  // charge 4: 3x6, the 3x3 plus a copy three tiles forward (`:983-989`).
  Object.freeze({ tiles: 18, forward: 6, across: 3, back: 1 }),
  // charge 5: 5x5 centred two tiles forward (`:1062-1072`); only reachable with the Reaching enchantment.
  Object.freeze({ tiles: 25, forward: 5, across: 5, back: 2 }),
] as const);

/** The top of the ladder: the charge argument's own last value (`ToolCharge.Maximum` on the Mod side). */
export const TOOL_FOOTPRINT_MAXIMUM_CHARGE = TOOL_FOOTPRINT_TILES_BY_CHARGE.length - 1;

/**
 * What the engine makes one native use cost, declared ONCE so the packing objective can weigh a charge against a walk.
 *
 * <p>
 * `swingMs` and `walkMsPerTile` are not this file's numbers: they are `tools/lib/action-pace.mjs`'s declared pace
 * (`ANIMATION_CLASS.toolSwing` = 8 frames x 60 ms, `Tool.cs:610-620`; `WALK_MS_PER_TILE`, computed from the engine's own
 * tile size, walk speed and movement multiplier). `ToolFootprintTableParityTests` reads that module and fails if the two
 * disagree, so this is a copy that cannot drift silently - and the day the pace standard changes the test names it rather
 * than letting the packing optimise against a stale price.
 * </p>
 * <p>
 * `chargeMsPerLevel` is the one number the pace standard does NOT declare: the hold before a charged release, per level
 * above the tap. It is declared here because the Packing objective cannot be expressed without it, and a second copy of
 * 600 anywhere else is the same "two spellings of one fact" defect the rest of this work has been removing.
 * </p>
 */
export const NATIVE_COST = Object.freeze({
  /** One tool swing's animation, the class `till_soil` falls in: 8 frames x 60 ms (`Tool.cs:610-620`). */
  swingMs: 480,
  /** One level of charge held before release. */
  chargeMsPerLevel: 600,
  /** One tile walked at run speed, the same figure `tools/lib/action-pace.mjs` computes. */
  walkMsPerTile: 505,
});

/**
 * The held tool's charge ceiling, read from the snapshot's own facts: which slot is held and what that slot's tool is
 * upgraded to (`toolSlots[].upgradeLevel`).
 *
 * <para>
 * `undefined` means the reading is UNAVAILABLE, not zero: `upgradeLevel` is absent on a Mod older than that projection and
 * `currentToolSlot` is absent when nothing is held, and a plan that read either as "level 0" would silently plan a
 * one-tile patch for a gold hoe. The caller must fall back and say so instead.
 * </para>
 */
export function heldToolChargeCeiling(
  snapshot: Readonly<{
    currentToolSlot?: number | null;
    toolSlots?: readonly Readonly<{ slot: number; upgradeLevel?: number }>[];
  }>,
): number | undefined {
  const held = snapshot.currentToolSlot;
  if (typeof held !== "number" || !Number.isInteger(held)) return undefined;
  const row = (snapshot.toolSlots ?? []).find((candidate) => candidate.slot === held);
  if (row === undefined) return undefined;
  const level = row.upgradeLevel;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 0) return undefined;
  return Math.min(level, TOOL_FOOTPRINT_MAXIMUM_CHARGE);
}

/**
 * How an action's area is packed, DERIVED from its own declared arguments rather than from a list kept here.
 *
 * A `charged_rectangle` action declares the tile, the charge and NO per-tile identity: a `targetId` or a backpack `slot`
 * cannot be manufactured for tiles the caller never named, so an action that declares one is never packed and its area
 * stays one step per tile resolved live. Today that admits `till_soil` and excludes `water_crop` (which binds a crop's
 * opaque id), which is the whole reason the distinction is a property of the declaration and not a preference.
 */
export function packingKindOf(argumentNames: readonly string[]): PackingKind {
  const declared = new Set(argumentNames);
  const charged = declared.has("x") && declared.has("y") && declared.has("charge");
  if (charged && !declared.has("expectedTargetId") && !declared.has("slot")) return "charged_rectangle";
  return "single_tile";
}

/**
 * How an action's area is packed.
 *
 * `charged_rectangle` - one charged native use covers the declared rectangle, so tiles are packed into the fewest uses.
 * `body_arc` - the footprint is the engine's swing arc anchored on the actor's bounding box, so it cannot be packed: which
 *   tiles a swing covers is a live pixel fact (10-16 distinct tiles, up to two tiles of movement inside one tile's 4096
 *   standing positions), not a rectangle a compiler can promise.
 * `single_tile` - no area at all; one step per tile, unchanged.
 */
export type PackingKind = "charged_rectangle" | "body_arc" | "single_tile";

/** The packing refusals the plan compiler mints, in the vocabulary the script refusals already use. */
export const PLAN_PACKING_FOOTPRINT_UNKNOWN = "plan_packing_footprint_unknown";
export const PLAN_PACKING_NOT_PACKABLE = "plan_packing_not_packable";

export type PackedStep = Readonly<{
  /** The tile the native use is named on. */
  x: number;
  y: number;
  /** The charge to request, never above the held tool's ceiling. */
  charge: number;
  /** How many tiles this step's footprint covers, from the declared table. */
  tiles: number;
  /**
   * The tile the actor must STAND on for this step: one tile before the named tile along the sweep axis, which is the
   * cardinal neighbour a native swing requires. Carried because the walk is the cost - 93.6% of a node - so a planner can
   * order the stances into one path instead of discovering them one refusal at a time.
   */
  stanceX: number;
  stanceY: number;
}>;

export type PackingInput = Readonly<{
  area: Readonly<{ x: number; y: number; w: number; h: number }>;
  kind: PackingKind;
  /** The held tool's ceiling from the snapshot (`toolSlots[].upgradeLevel` + Reaching). `undefined` = unreadable. */
  maximumCharge: number | undefined;
  /** `y` sweeps down a column (the farm's usual strip), `x` along a row. */
  axis?: "x" | "y";
}>;

export type PackingResult = Readonly<{
  status: "packed" | "refused";
  steps: readonly PackedStep[];
  reason: string | null;
  /** Distinct standing tiles the plan asks the body to visit: the number the pace table carries. */
  standingPositions: number;
  /** Tiles of walking along the emitted order (Manhattan between consecutive stances). */
  walkTiles: number;
  /** What this plan costs in the engine times declared in NATIVE_COST: swing + charge per use, walk between stances. */
  timeMs: number;
}>;

/**
 * The tiles ONE footprint covers, relative to the named tile, along the sweep axis.
 *
 * Exported because the packing test asserts the union of these over the emitted steps EQUALS the region with no overlap -
 * the guarantee that makes a packed plan cheaper than a walk, rather than a walk into ground it already tilled.
 */
export function footprintTiles(
  anchor: Readonly<{ x: number; y: number }>,
  shape: ToolFootprintShape,
  axis: "x" | "y",
): readonly Readonly<{ x: number; y: number }>[] {
  const tiles: { x: number; y: number }[] = [];
  for (let forward = 0; forward < shape.forward; forward++) {
    for (let across = 0; across < shape.across; across++) {
      const offset = across - shape.back;
      tiles.push(
        axis === "y"
          ? { x: anchor.x + offset, y: anchor.y + forward }
          : { x: anchor.x + forward, y: anchor.y + offset },
      );
    }
  }
  return tiles;
}

/** The steps ONE region costs: exact footprints, no overlap, and the stance each one needs. */
export function packAreaSteps(input: PackingInput): PackingResult {
  const { area, kind } = input;
  const axis = input.axis ?? "y";
  if (!Number.isInteger(area.x) || !Number.isInteger(area.y) || area.w < 1 || area.h < 1)
    return refuse(singleTiles(area, axis), `${PLAN_PACKING_FOOTPRINT_UNKNOWN}:area_invalid`);
  if (kind === "single_tile") return packedTiles(singleTiles(area, axis));
  if (kind === "body_arc") return refuse(singleTiles(area, axis), `${PLAN_PACKING_NOT_PACKABLE}:body_arc`);
  const ceiling = input.maximumCharge;
  if (ceiling === undefined || !Number.isInteger(ceiling))
    return refuse(singleTiles(area, axis), `${PLAN_PACKING_FOOTPRINT_UNKNOWN}:held_tool`);
  if (ceiling < 0) return refuse(singleTiles(area, axis), `${PLAN_PACKING_FOOTPRINT_UNKNOWN}:held_tool_level`);

  const bounded = Math.min(ceiling, TOOL_FOOTPRINT_MAXIMUM_CHARGE);
  // THE OBJECTIVE IS TIME, NOT STEP COUNT. Charge time grows linearly with the level while coverage does not, so the
  // fewest steps is not the fastest plan: on a 3-wide strip a steel hoe (charge 2, 1x5) beats a gold one (charge 3, 3x3)
  // because the two need the same twelve uses and steel spends 600 ms less on each. Every candidate that tiles the region
  // EXACTLY is scored, and exactness is a hard constraint rather than a term in the score: a footprint that overlaps
  // re-tills a tile the engine refuses (`soil_already_tilled`) and the walk that got there is pure loss.
  let best: Tiling | undefined;
  for (let charge = bounded; charge >= 0; charge--) {
    const candidate = tileAtCharge(area, axis, charge);
    if (best === undefined || candidate.timeMs < best.timeMs) best = candidate;
  }
  return packed(best!.steps, best!.timeMs);
}

/** One exact tiling of the region, every packed use at `charge` (with a one-tile tail the ladder cannot express). */
type Tiling = Readonly<{ steps: readonly PackedStep[]; timeMs: number }>;

function tileAtCharge(
  area: Readonly<{ x: number; y: number; w: number; h: number }>,
  axis: "x" | "y",
  charge: number,
): Tiling {
  const acrossPatch = axis === "y" ? area.w : area.h;
  const alongPatch = axis === "y" ? area.h : area.w;
  const acrossOrigin = axis === "y" ? area.x : area.y;
  const alongOrigin = axis === "y" ? area.y : area.x;
  const steps: PackedStep[] = [];
  // The widest footprint this charge fits the region's width with: a shape wider than the region would cover tiles the
  // caller never named, which is the surprise the destruction rule exists to refuse.
  const stripWidth = Math.max(1, Math.min(acrossPatch, TOOL_FOOTPRINT_TILES_BY_CHARGE[charge]!.across));
  const strips = Math.ceil(acrossPatch / stripWidth);
  for (let strip = 0; strip < strips; strip++) {
    const stripStart = acrossOrigin + strip * stripWidth;
    const width = Math.min(stripWidth, acrossOrigin + acrossPatch - stripStart);
    let position = 0;
    // A PARTIAL STRIP NEEDS A NARROWER FOOTPRINT. A 3x3 on a region whose last strip is two tiles wide would cover a
    // column the caller never named, so the charge is reduced to the widest shape that still fits THIS strip.
    const chargeForWidth = chargeFittingWidth(charge, width);
    while (position < alongPatch) {
      const remaining = alongPatch - position;
      const usable = chargeFittingAlong(chargeForWidth, remaining);
      if (usable === null) {
        // Nothing at this charge fits what is left: one tile per step, so the region is still covered exactly.
        for (let along = position; along < alongPatch; along++) {
          for (let across = 0; across < width; across++) {
            const x = axis === "y" ? stripStart + across : alongOrigin + along;
            const y = axis === "y" ? alongOrigin + along : stripStart + across;
            steps.push(stepFor(x, y, 0, axis));
          }
        }
        break;
      }
      const shape = TOOL_FOOTPRINT_TILES_BY_CHARGE[usable]!;
      const anchorAlong = alongOrigin + position;
      const anchorAcross = stripStart + shape.back;
      steps.push(
        axis === "y"
          ? stepFor(anchorAcross, anchorAlong, usable, axis)
          : stepFor(anchorAlong, anchorAcross, usable, axis),
      );
      position += shape.forward;
    }
  }
  return Object.freeze({ steps: Object.freeze(steps), timeMs: packingTimeMs(steps) });
}

/**
 * What a plan costs in the engine's own time: every native use pays its swing plus the charge held for it, and every
 * change of standing position pays the walk between them.
 *
 * The three numbers are NOT this file's invention - see `NATIVE_COST` - and the walk is counted between CONSECUTIVE
 * stances rather than as a straight line, because that is the path the plan asks the body to take.
 */
export function packingTimeMs(steps: readonly PackedStep[]): number {
  let total = 0;
  for (const [index, step] of steps.entries()) {
    total += NATIVE_COST.swingMs + step.charge * NATIVE_COST.chargeMsPerLevel;
    if (index > 0) {
      const previous = steps[index - 1]!;
      total +=
        (Math.abs(step.stanceX - previous.stanceX) + Math.abs(step.stanceY - previous.stanceY)) *
        NATIVE_COST.walkMsPerTile;
    }
  }
  return total;
}

/** The largest charge at or below `ceiling` whose footprint is not wider than `width`. */
function chargeFittingWidth(ceiling: number, width: number): number {
  for (let charge = ceiling; charge > 0; charge--) {
    if (TOOL_FOOTPRINT_TILES_BY_CHARGE[charge]!.across <= width) return charge;
  }
  return 0;
}

/** The largest charge at or below `ceiling` whose footprint fits the rows still uncovered; `null` when none does. */
function chargeFittingAlong(ceiling: number, remaining: number): number | null {
  for (let charge = ceiling; charge >= 1; charge--) {
    if (TOOL_FOOTPRINT_TILES_BY_CHARGE[charge]!.forward <= remaining) return charge;
  }
  return null;
}

function stepFor(x: number, y: number, charge: number, axis: "x" | "y"): PackedStep {
  const shape = TOOL_FOOTPRINT_TILES_BY_CHARGE[charge]!;
  // The stance is the cardinal neighbour a swing requires: one tile BEFORE the named tile along the sweep axis.
  const stance = axis === "y" ? { x, y: y - 1 } : { x: x - 1, y };
  return Object.freeze({ x, y, charge, tiles: shape.tiles, stanceX: stance.x, stanceY: stance.y });
}

function singleTiles(area: Readonly<{ x: number; y: number; w: number; h: number }>, axis: "x" | "y"): PackedStep[] {
  const steps: PackedStep[] = [];
  for (let row = 0; row < area.h; row++) {
    for (let column = 0; column < area.w; column++) steps.push(stepFor(area.x + column, area.y + row, 0, axis));
  }
  return steps;
}

function packed(steps: readonly PackedStep[], timeMs: number): PackingResult {
  const stances = new Set(steps.map((step) => `${String(step.stanceX)}:${String(step.stanceY)}`));
  let walk = 0;
  for (let index = 1; index < steps.length; index++) {
    const previous = steps[index - 1]!;
    const current = steps[index]!;
    walk += Math.abs(current.stanceX - previous.stanceX) + Math.abs(current.stanceY - previous.stanceY);
  }
  return Object.freeze({
    status: "packed" as const,
    steps: Object.freeze([...steps]),
    reason: null,
    standingPositions: stances.size,
    walkTiles: walk,
    timeMs,
  });
}

function packedTiles(steps: readonly PackedStep[]): PackingResult {
  return packed(steps, packingTimeMs(steps));
}

function refuse(steps: readonly PackedStep[], reason: string): PackingResult {
  return Object.freeze({ ...packed(steps, packingTimeMs(steps)), status: "refused" as const, reason });
}
