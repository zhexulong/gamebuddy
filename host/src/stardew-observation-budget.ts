import type { Snapshot } from "./protocol.js";

/**
 * What one observation cost the model after the bound, and what the bound took away.
 *
 * Published beside the snapshot so a reader can tell "the Mod never learned this recipe" from "the
 * ingredients are missing right now" - without the counts the two are the same absence.
 */
export interface ObservationBudget {
  /** Villagers listed without a tile because they are on another map. The roster row itself stays. */
  readonly elidedVillagerCoordinates: number;
  /** Learned recipes withheld because they are not craftable from the current inventory. */
  readonly withheldUnavailableRecipes: number;
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
 *  - `craftingRecipeTargets` / `cookingRecipeTargets` rows whose `ingredientsAvailable` is false
 *    (21,056 B over the run, 3.3%; 270 of 312 rows). A recipe that cannot be made from this
 *    inventory has exactly one decision attached - make it now - and that decision cannot be taken.
 *    `craft_recipe`/`cook_recipe` copy `expectedTargetId` from a row that IS craftable. The counts
 *    below keep the planning fact that those recipes are known.
 *
 * Everything else is copied through untouched, because a dispatched action reads it: target ids,
 * tiles and slots of every `*Targets` row, `tile`, `toolSlots`, `currentToolSlot`, `inventorySlots`,
 * `timeOfDay`/`dayOfMonth`/`seasonIndex`/`year`, `stamina`, `health`, and `revision`. An EMPTY family
 * is also kept as an empty array: plan scripts loop `for (const row of snapshot.<family>)`, and a
 * dropped key throws in the compiler instead of iterating zero times.
 */
export function boundObservedSnapshot(snapshot: Snapshot): Readonly<{
  snapshot: Readonly<Record<string, unknown>>;
  budget: ObservationBudget;
}> {
  let elidedVillagerCoordinates = 0;
  let withheldUnavailableRecipes = 0;
  const bounded: Record<string, unknown> = { ...snapshot };

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
      elidedVillagerCoordinates += 1;
      return {
        npcName: row.npcName,
        displayName: row.displayName,
        location: row.location,
        inCurrentLocation: row.inCurrentLocation,
      };
    });
  }

  // The bound is DISCLOSED in the payload: without a count a withheld recipe is indistinguishable from
  // one the Mod never taught, so the model would answer "I do not know that recipe" instead of "I lack
  // the ingredients". The disclosure is emitted ONLY when it has something to disclose - a block that
  // says "nothing was withheld" is pure cost on every clean observation. `bytesRemoved` stays operator
  // evidence in `details`: the openai provider sends `msg.content` text blocks only, so a byte count
  // there would never reach the model anyway and would spend payload saying nothing.
  const disclosed = elidedVillagerCoordinates === 0 && withheldUnavailableRecipes === 0;
  const published = disclosed
    ? Object.freeze({ ...bounded })
    : Object.freeze({
        ...bounded,
        observationBudget: Object.freeze({ elidedVillagerCoordinates, withheldUnavailableRecipes }),
      });
  return Object.freeze({
    snapshot: published,
    // NET of the disclosure block: the bytes the model actually stops receiving. A gross figure would
    // overstate the saving by exactly the size of the block that carries it.
    budget: Object.freeze({
      elidedVillagerCoordinates,
      withheldUnavailableRecipes,
      bytesRemoved:
        Buffer.byteLength(JSON.stringify(snapshot), "utf8") - Buffer.byteLength(JSON.stringify(published), "utf8"),
    }),
  });
}
