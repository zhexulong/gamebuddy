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
 * THE LADDER IS NOT A DESCRIPTOR FACT. How far one use reaches depends on the upgrade level of the tool the ACTION will
 * swing - runtime state, published in the snapshot as `toolSlots[].upgradeLevel`, bounded by `Game1.cs:13032-13051` - so
 * no wire field is added anywhere: the resolver reads the snapshot's fact and this table's geometry. See
 * `toolChargeCeilingForClaim` for which of the pack's tools that is.
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
 * What one native use and one walked tile cost, declared ONCE so the packing objective can weigh a charge against a walk.
 *
 * <p>
 * No number here is this file's invention. `swingMs` is `tools/lib/action-pace.mjs`'s `ANIMATION_CLASS.toolSwing` (8 frames x
 * 60 ms, `Tool.cs:610-620`), the class `till_soil` falls in - the only action this file can pack. `walkMsPerTile` is that
 * same module's `BODY_WALK_MS_PER_TILE`: the pace OUR body actually crosses a tile at, measured from the route receipts
 * (217 ms, cited there), NOT `WALK_MS_PER_TILE`, which is what the engine forces a player *walking* to spend (505 ms) and
 * which is the floor a speed verdict divides by rather than the price a plan is bought at. `chargeMsPerLevel` is the
 * engine's own hold: `Game1.cs:13040` sets `toolHold = 600 * AnimationSpeedModifier` and `:13045-13048` raises one power
 * level each time it runs out.
 * </p>
 * <p>
 * `chargeMsPerLevel` is the one number the pace standard does NOT declare, and it is declared here because the packing
 * objective cannot be expressed without it; a second copy of 600 anywhere else would be the "two spellings of one fact"
 * defect the rest of this work has been removing. `body-program-packing.test.ts` imports the pace module at run time and
 * fails on any disagreement with the two numbers it does declare, naming the constant that drifted.
 * </p>
 */
const NATIVE_COST = Object.freeze({
  /** One tool swing's animation, the class `till_soil` falls in: 8 frames x 60 ms (`Tool.cs:610-620`). */
  swingMs: 480,
  /** One level of charge held before release (`Game1.cs:13040`, `:13045-13048`). */
  chargeMsPerLevel: 600,
  /** One tile walked by OUR body, the pace its own route receipts measure (`BODY_WALK_MS_PER_TILE`). */
  walkMsPerTile: 217,
});

/** The snapshot facts either ceiling is read from: which slot is held, and what tools the pack carries. */
type ToolSlotFacts = Readonly<{
  currentToolSlot?: number | null;
  toolSlots?: readonly Readonly<{ slot: number; upgradeLevel?: number; category?: string }>[];
}>;

/** The tool one action's own `tool:<category>` claim declares, reduced to the facts a ceiling needs. */
type ClaimedTool = Readonly<{
  category: string;
  minimumUpgradeLevel: number | null;
  maximumUpgradeLevel: number | null;
}>;

/**
 * The HELD tool's charge ceiling, read from the snapshot's own facts: which slot is held and what that slot's tool is
 * upgraded to (`toolSlots[].upgradeLevel`).
 *
 * <para>
 * This is the fallback, not the rule: a tool action does not swing the tool in her hand (see
 * `toolChargeCeilingForClaim`), so this reading answers only for a snapshot whose slots publish no category at all.
 * </para>
 * <para>
 * `undefined` means the reading is UNAVAILABLE, not zero: `upgradeLevel` is absent on a Mod older than that projection and
 * `currentToolSlot` is absent when nothing is held, and a plan that read either as "level 0" would silently plan a
 * one-tile patch for a gold hoe. The caller must fall back and say so instead.
 * </para>
 */
export function heldToolChargeCeiling(snapshot: ToolSlotFacts): number | undefined {
  const held = snapshot.currentToolSlot;
  if (typeof held !== "number" || !Number.isInteger(held)) return undefined;
  const row = (snapshot.toolSlots ?? []).find((candidate) => candidate.slot === held);
  if (row === undefined) return undefined;
  const level = publishedLevel(row.upgradeLevel);
  return level === undefined ? undefined : ladderCharge(level);
}

/**
 * The ceiling of the use the Mod WILL ACTUALLY MAKE for one action: the highest upgrade level the pack carries among the
 * tools whose published category is the one the action's own `tool:<category>` claim names.
 *
 * <para>
 * THE MOD SWITCHES TOOLS, SO THIS READING MUST AGREE WITH IT. A tool action does not use the tool in her hand: the Mod
 * resolves the action's claim across the WHOLE pack, keeps the highest `UpgradeLevel` among the tools that satisfy it
 * (ties to the smallest slot) and points `CurrentToolIndex` at that slot for the length of the use, restoring it after
 * (`integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs:857-887`, `:969-994`), and the charge ceiling
 * is the SELECTED tool's (`:557-558` into `farmhandexecutioncontroller.cs:4768`). That ranking is declared in the Mod, not
 * in the Host - the Host's only other reading of it is `publishedSlotOfCategory`, which resolves an equip SLOT from the
 * same rule - so the C# is cited here and `DeclaredToolSelectionTests.AnUpgradedPickaxeSatisfiesTheClaimAndIsPreferred`
 * pins it from the Mod's side. Reading `currentToolSlot` here instead is what packed the same 3x20 patch for charge 0
 * while the Mod swung a gold hoe: sixty single-tile rows where the Mod needed twelve uses.
 * </para>
 * <para>
 * EACH FALLBACK IS A DIFFERENT FACT. The claim's category decides while the pack publishes categories at all; a Mod older
 * than that projection publishes none, and then the held tool is the only tool this side can name. `undefined` anywhere
 * else means the action cannot be packed here - an unreadable level, no owned tool of that category, or none inside the
 * level range the claim allows - and the Mod names that per row (`tool_not_owned`, `tool_upgrade_insufficient`) rather
 * than this side inventing a footprint for a swing that will be refused.
 * </para>
 */
export function toolChargeCeilingForClaim(snapshot: ToolSlotFacts, claim: ClaimedTool | undefined): number | undefined {
  const rows = snapshot.toolSlots ?? [];
  if (claim === undefined || !rows.some((row) => typeof row.category === "string"))
    return heldToolChargeCeiling(snapshot);
  let best: number | undefined;
  for (const row of rows) {
    if (row.category !== claim.category) continue;
    const level = publishedLevel(row.upgradeLevel);
    if (level === undefined) return undefined;
    if (level < (claim.minimumUpgradeLevel ?? 0)) continue;
    if (claim.maximumUpgradeLevel !== null && level > claim.maximumUpgradeLevel) continue;
    if (best === undefined || level > best) best = level;
  }
  return best === undefined ? undefined : ladderCharge(best);
}

/** One published upgrade level as a number, or `undefined` when the wire carried none - an absence is not a zero. */
function publishedLevel(level: number | undefined): number | undefined {
  return typeof level === "number" && Number.isInteger(level) && level >= 0 ? level : undefined;
}

/** That level as a charge: the ladder stops at its own top, which is where the engine's own hold stops. */
function ladderCharge(level: number): number {
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

type PackedStep = Readonly<{
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
  /** The ceiling the action's own tool reaches (`toolChargeCeilingForClaim`). `undefined` = unreadable. */
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
  /** What this plan costs in the times declared in NATIVE_COST: swing + charge per use, walk between stances at the body's measured pace. */
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
    return refuse(singleTiles(area, axis), `${PLAN_PACKING_FOOTPRINT_UNKNOWN}:tool_claim`);
  if (ceiling < 0) return refuse(singleTiles(area, axis), `${PLAN_PACKING_FOOTPRINT_UNKNOWN}:tool_claim_level`);

  const bounded = Math.min(ceiling, TOOL_FOOTPRINT_MAXIMUM_CHARGE);
  // THE OBJECTIVE IS TIME, NEITHER STEP COUNT NOR CHARGE. Every candidate that tiles the region EXACTLY is scored at
  // `packingTimeMs`, so a plan wins by being cheaper and not by being smaller or by charging harder, and the two usually
  // disagree: on a 3x20 strip iridium's nine 3x6 uses beat gold's twelve 3x3 uses by 5,040 ms, while steel's twelve 1x5
  // uses lose to gold by 14,667 ms - the same twelve uses, 51 more walked tiles and 3,600 ms more charge. Exactness is a
  // hard constraint rather than a term in the score: a footprint that overlaps re-tills a tile the engine refuses
  // (`soil_already_tilled`) and the walk that got there is pure loss.
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
  // THE ACROSS AXIS IS TILED, NOT APPROXIMATED. Every strip is exactly as wide as some shape the ceiling reaches, so its
  // footprint spans the strip and nothing else. Splitting by `min(acrossPatch, shape.across)` instead left a remainder two
  // tiles wide - no 2-wide shape exists - which the 1-wide shape then half-covered: 57 of a 20x3 patch's sixty tiles were
  // worked, 36 of 60 at a Reaching ceiling, and the time objective preferred the smaller plan BECAUSE it did less work.
  for (const { start: stripStart, width } of acrossStrips(acrossOrigin, acrossPatch, charge)) {
    let position = 0;
    while (position < alongPatch) {
      const remaining = alongPatch - position;
      // The charge must fit the strip's WIDTH as well as the rows left: reducing along the facing axis must never narrow
      // the footprint across it, or the strip's remaining columns go unworked.
      const usable = chargeFittingAlong(charge, width, remaining);
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
 *
 * `walkMsPerTile` is a parameter with a default rather than a second table: the resolver scores with the body's measured
 * pace, and the test prices the SAME steps at the engine's own `WALK_MS_PER_TILE` to show which plan that price would have
 * bought instead. A plan optimiser whose answer nobody can re-price under the other clock is one whose answer nobody can
 * check.
 */
export function packingTimeMs(steps: readonly PackedStep[], walkMsPerTile: number = NATIVE_COST.walkMsPerTile): number {
  let total = 0;
  for (const [index, step] of steps.entries()) {
    total += NATIVE_COST.swingMs + step.charge * NATIVE_COST.chargeMsPerLevel;
    if (index > 0) {
      const previous = steps[index - 1]!;
      total += (Math.abs(step.stanceX - previous.stanceX) + Math.abs(step.stanceY - previous.stanceY)) * walkMsPerTile;
    }
  }
  return total;
}

/**
 * The across-axis split, in widths a shape at or below `ceiling` covers EXACTLY.
 *
 * Widest first, and `across` 1 is on the ladder at charge 0, so any width terminates. The widths come from the declared
 * ladder rather than from a second copy of it, which is what makes a new shape a change to this function's answer.
 */
function acrossStrips(
  acrossOrigin: number,
  acrossPatch: number,
  ceiling: number,
): readonly { start: number; width: number }[] {
  const widths = [...new Set(TOOL_FOOTPRINT_TILES_BY_CHARGE.slice(0, ceiling + 1).map((shape) => shape.across))].sort(
    (left, right) => right - left,
  );
  const strips: { start: number; width: number }[] = [];
  let position = 0;
  while (position < acrossPatch) {
    const width = widths.find((candidate) => candidate <= acrossPatch - position) ?? 1;
    strips.push({ start: acrossOrigin + position, width });
    position += width;
  }
  return strips;
}

/**
 * The largest charge at or below `ceiling` whose footprint is `width` ACROSS and fits the rows still uncovered; `null`
 * when none does, which is what leaves the one-tile tail.
 */
function chargeFittingAlong(ceiling: number, width: number, remaining: number): number | null {
  for (let charge = ceiling; charge >= 1; charge--) {
    const shape = TOOL_FOOTPRINT_TILES_BY_CHARGE[charge]!;
    if (shape.across === width && shape.forward <= remaining) return charge;
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
