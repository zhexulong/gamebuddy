import { MAX_PLAN_NODES } from "./body-program-script.js";
import type { Snapshot } from "./protocol.js";

/**
 * What one observation cost the model after the bound, and what the bound took away.
 *
 * Published beside the snapshot so a reader can tell "the Mod never learned this recipe" from "the
 * ingredients are missing right now" - without the counts the two are the same absence.
 */
export interface ObservationBudget {
  /**
   * Roster rows reduced to `{ npcName, displayName, location }` because the villager is on another map.
   *
   * One count for the whole reduction: such a row loses its tile AND the `inCurrentLocation` flag, and both
   * are absent for the same reason, so two counters would be two spellings of one fact.
   */
  readonly elidedVillagerRows: number;
  /** Learned recipes withheld because they are not craftable from the current inventory. */
  readonly withheldUnavailableRecipes: number;
  /** Plantable tiles withheld because they are farther than the nearest `MAX_PLAN_NODES` of their held stack. */
  readonly withheldDistantSeedTargets: number;
  /** Plantable tiles withheld because they are farther than the nearest `MAX_PLAN_NODES` of their held stack. */
  readonly withheldDistantSaplingTargets: number;
  /** Bytes the bound removed from this observation's own JSON. Zero when there was nothing to remove. */
  readonly bytesRemoved: number;
}

/**
 * One observation, bounded to what an action can be dispatched with.
 *
 * Measured on the 2026-10-26 multi-day run: 26 `stardew_observe` calls carrying 643,712 bytes
 * (mean 24,758, max 30,267). Two families held bytes no dispatch decision can consume:
 *
 *  - `villagerWhereabouts` rows for villagers on OTHER maps (108,782 B over the run, 16.9%). Every
 *    row stayed `inCurrentLocation: false`, and the one reader in the repo
 *    (`tools/run-stardew-native-local-player-talk-to-npc-smoke.mjs` `locateVillagerTile`) requires
 *    `location === snapshot.location` before it reads a tile. A tile on a map the actor is not on
 *    can address no action, so its two integers are not published; the roster fact - which villager,
 *    which map - is what the family exists for (protocol.ts "the only fact that tells the Agent a
 *    villager is elsewhere instead of making it search map by map") and it stays.
 *
 *    Re-measured on 2026-10-30 (`round8`): this family was 173,597 B of 688,746 B - 25.2% of every
 *    observation byte, the single largest family in the run. `inCurrentLocation` was the most
 *    expensive FIELD on those rows (1,092 B of the 3,663 B family at the largest observation): the row
 *    reaches this branch only when both signals said "elsewhere", so `false` there restates what the
 *    elided tile already said and what `location` still names. No reader asks it - the Host's own
 *    reader filters `inCurrentLocation === true` before reading anything (`formatNearbyVillagers`,
 *    runtime-core.internal.ts), and the tile reader requires a location match first - so it is dropped
 *    with the tile. The two NAMES are not droppable: they are the roster's whole content, `npcName` is
 *    the native identity a destination query resolves against and `displayName` is what the companion
 *    says to the player.
 *
 *  - `craftingRecipeTargets` / `cookingRecipeTargets` rows whose `ingredientsAvailable` is false
 *    (21,056 B over the run, 3.3%; 270 of 312 rows). A recipe that cannot be made from this
 *    inventory has exactly one decision attached - make it now - and that decision cannot be taken.
 *    `craft_recipe`/`cook_recipe` copy `expectedTargetId` from a row that IS craftable. The counts
 *    below keep the planning fact that those recipes are known.
 *
 * Measured on the 2026-10-29 run `round7` (session `game-1793296897723`, the largest observation
 * 32,826 B, 33 `stardew_observe` calls for 1,720 KB - 90.6% of every tool result in the run, which
 * ended in `stopReason: length`): two more families are CATALOGUES rather than addresses.
 *
 *  - `seedTargets` (6.8 KB, 64 rows on 14 of 33 observations) and `treeSaplingTargets` (7.2 KB,
 *    64 rows on 22 of 33). The Mod enumerates every plantable tile within `TargetDiscoveryRadius`
 *    (6) around the actor, once per qualifying inventory stack, capped at 64 rows GLOBALLY
 *    (`farmhandexecutioncontroller.cs:2919` / `:3890`). On every measured observation the 64 rows
 *    were ONE stack - `slot 14 (O)770` or `slot 13 (O)309` - so the family answered "where could
 *    this stack go" with 64 alternatives and the model's own reasoning spent turns deciding
 *    whether a row was a seed or a tile (`"seedTargets list huge number of spots but those are
 *    just potential tiles, not seeds"`).
 *
 *    A row IS addressable (its `targetId` hashes location:slot:tile:item and `plant_seed` /
 *    `plant_sapling` echo it), so a row may not vanish from under a plan that already named it: the
 *    nearest `MAX_PLAN_NODES` rows of each stack are published, which is every row a single plan
 *    can reach. One plan holds `MAX_PLAN_NODES` (16) nodes, so it can plant at most 16 times; rows
 *    past the 16th nearest of a stack cannot be named by any plan that also names the nearer ones.
 *    The order is Chebyshev distance then the Mod's own published order, the same `NearestFirst`
 *    ranking the Mod applies to `weedTargets`/`caskTargets` before their own `Take`, so the first
 *    row is the tile the actor can plant on soonest. Each stack keeps its own window: a plan may mix
 *    stacks, and tile rows from one stack's slot can never address another's. A stack that already
 *    fits the window is published untouched, not re-ranked.
 *
 * Everything else is copied through untouched, because a dispatched action reads it: target ids,
 * tiles and slots of every `*Targets` row, `tile`, `toolSlots`, `currentToolSlot`, `inventorySlots`,
 * `timeOfDay`/`dayOfMonth`/`seasonIndex`/`year`, `stamina`, `health`, and `revision`. An EMPTY family
 * is also kept as an empty array: plan scripts loop `for (const row of snapshot.<family>)`, and a
 * dropped key throws in the compiler instead of iterating zero times.
 */
export function boundObservedSnapshot(
  snapshot: Snapshot,
  /**
   * The catalog revision the model was last shown the action surface for, or `undefined` for "never".
   *
   * `capabilities` (97 strings) and `enabledActionIds` (92) only change when the Mod republishes its surface -
   * `catalogRevision` is that fact. Measured 2026-10-27: those two fields are 2634 of 2781 bytes on a minimal
   * snapshot, so re-sending them on every observation spends the largest single block saying the same thing.
   */
  surfaceRevisionShownToModel?: number,
): Readonly<{
  snapshot: Readonly<Record<string, unknown>>;
  budget: ObservationBudget;
}> {
  let elidedVillagerRows = 0;
  let withheldUnavailableRecipes = 0;
  let withheldDistantSeedTargets = 0;
  let withheldDistantSaplingTargets = 0;
  const bounded: Record<string, unknown> = { ...snapshot };

  // A surface the model has already been shown is not re-described. The revision travels WITH the omission so a
  // reader can still tell which surface the current step belongs to.
  if (surfaceRevisionShownToModel !== undefined && surfaceRevisionShownToModel === snapshot.catalogRevision) {
    delete bounded.capabilities;
    delete bounded.enabledActionIds;
    bounded.actionSurfaceUnchangedSinceRevision = snapshot.catalogRevision;
  }

  for (const field of ["craftingRecipeTargets", "cookingRecipeTargets"] as const) {
    const rows = snapshot[field];
    if (rows === undefined) continue;
    const craftable = rows.filter((row) => row.ingredientsAvailable === true);
    withheldUnavailableRecipes += rows.length - craftable.length;
    bounded[field] = craftable;
  }

  const whereabouts = snapshot.villagerWhereabouts;
  if (whereabouts !== undefined) {
    bounded.villagerWhereabouts = whereabouts.map((row) => {
      // Either signal may say the villager is here: the Mod's own flag, or a location match. Keeping
      // the tile when EITHER agrees cannot drop a reachable coordinate for a caller reading the other.
      if (row.inCurrentLocation === true || row.location === snapshot.location) return row;
      elidedVillagerRows += 1;
      // Reachable only when BOTH signals said "elsewhere", so the flag here could only be `false`: it is the
      // elided tile's own reason, spelled a second time, and `location` still names the map the villager is on.
      return { npcName: row.npcName, displayName: row.displayName, location: row.location };
    });
  }

  // Nearest-first, then the Mod's own published order for ties: the first row is the tile the actor can plant on
  // soonest, which is what a script slicing the list (`snapshot.seedTargets.slice(0, 6)`) means by "the next ones".
  // The ranking is the Mod's own `NearestFirst` convention (Chebyshev distance) that `weedTargets`/`caskTargets` are
  // ordered by before their own `Take`. A stack is a backpack slot: rows from one slot can never address another
  // slot's item, so each slot keeps its own `MAX_PLAN_NODES` window and a plan mixing two stacks still has both.
  //
  // A family that fits its windows is returned EXACTLY as the Mod published it - not re-ranked - so a list small
  // enough to be published whole keeps the Mod's own order and its own indices.
  const nearestPerStack = <TRow extends Readonly<{ slot: number; x: number; y: number }>>(
    rows: readonly TRow[],
  ): { readonly kept: readonly TRow[]; readonly withheld: number } => {
    const perStack = new Map<number, number>();
    for (const row of rows) perStack.set(row.slot, (perStack.get(row.slot) ?? 0) + 1);
    if ([...perStack.values()].every((count) => count <= MAX_PLAN_NODES)) return { kept: rows, withheld: 0 };

    const distance = (row: TRow) => Math.max(Math.abs(row.x - snapshot.tile.x), Math.abs(row.y - snapshot.tile.y));
    const taken = new Map<number, number>();
    const kept = [...rows]
      .map((row, index) => ({ row, index }))
      .sort((left, right) => distance(left.row) - distance(right.row) || left.index - right.index)
      .flatMap(({ row }) => {
        const count = taken.get(row.slot) ?? 0;
        if (count >= MAX_PLAN_NODES) return [];
        taken.set(row.slot, count + 1);
        return [row];
      });
    return { kept, withheld: rows.length - kept.length };
  };

  // A plan is at most `MAX_PLAN_NODES` nodes, so it can plant at most that many times: the rows past the nearest
  // `MAX_PLAN_NODES` of a stack are a catalogue no plan can exhaust, and the ones before them are the choices.
  for (const field of ["seedTargets", "treeSaplingTargets"] as const) {
    const rows = snapshot[field];
    if (rows === undefined) continue;
    const { kept, withheld } = nearestPerStack(rows);
    if (field === "seedTargets") withheldDistantSeedTargets += withheld;
    else withheldDistantSaplingTargets += withheld;
    bounded[field] = kept;
  }

  // The bound is DISCLOSED in the payload: without a count a withheld recipe is indistinguishable from
  // one the Mod never taught, so the model would answer "I do not know that recipe" instead of "I lack
  // the ingredients". The disclosure is emitted ONLY when it has something to disclose - a block that
  // says "nothing was withheld" is pure cost on every clean observation. `bytesRemoved` stays operator
  // evidence in `details`: the openai provider sends `msg.content` text blocks only, so a byte count
  // there would never reach the model anyway and would spend payload saying nothing.
  const disclosed =
    elidedVillagerRows === 0 &&
    withheldUnavailableRecipes === 0 &&
    withheldDistantSeedTargets === 0 &&
    withheldDistantSaplingTargets === 0;
  const published = disclosed
    ? Object.freeze({ ...bounded })
    : Object.freeze({
        ...bounded,
        observationBudget: Object.freeze({
          elidedVillagerRows,
          withheldUnavailableRecipes,
          withheldDistantSeedTargets,
          withheldDistantSaplingTargets,
        }),
      });
  return Object.freeze({
    snapshot: published,
    // NET of the disclosure block: the bytes the model actually stops receiving. A gross figure would
    // overstate the saving by exactly the size of the block that carries it.
    budget: Object.freeze({
      elidedVillagerRows,
      withheldUnavailableRecipes,
      withheldDistantSeedTargets,
      withheldDistantSaplingTargets,
      bytesRemoved:
        Buffer.byteLength(JSON.stringify(snapshot), "utf8") - Buffer.byteLength(JSON.stringify(published), "utf8"),
    }),
  });
}
