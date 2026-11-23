/**
 * One crop per tile: the rule that keeps a plan from sowing a tile a step of its own already sowed.
 *
 * <p>
 * MEASURED `round97` (2026-11-23, ninth minute): 44 sow calls over 36 tiles, and every duplication answered
 * `seed_target_unavailable;reason=soil_has_crop` - the receipt naming the item and the slot of a tile a node of the SAME
 * plan had just sown. `round84` (2026-11-20) had the shape inside one program too: of 54 `plant_seed` nodes, the tiles
 * `(59,18)` and `(59,12)` were each submitted twice. The refusal is honest and the dispatch was bought for nothing.
 * </p>
 *
 * <p>
 * THE FIELD THAT DOES NOT ANSWER IT IS `hoeDirt`. `soilTiles` publishes BOTH soil states, `hoeDirt: true` means "a HoeDirt
 * is here" - the record of work already done - and a crop does not change it. So the one soil word the product declares
 * covers "tilled" and, wrongly, "sowable"; the guard that reads it is a TILL guard, and no reading of that family can
 * decide a sowing. The field that does answer it is `seedTargets`: `DiscoverSeedTargets` publishes a row only where
 * `dirt.crop is null` and `canPlantThisSeedHere` holds (`farmhandexecutioncontroller.targetdiscovery.cs:1417-1419`), and a
 * `HoeDirt` holds ONE crop.
 * </p>
 *
 * <p>
 * WHY THE SNAPSHOT CANNOT DECIDE IT EITHER. The submit-moment snapshot was read before the plan ran, so a tile this plan
 * sows is still published as empty soil in it - the row is there, `canPlantThisSeedHere` is true, and `crop` is false
 * because the family never publishes a cropped tile. Nothing on the wire can be asked "does a crop stand here" after the
 * fact: `soilTiles` carries `hoeDirt` and no crop field, `cropTargets` publishes only crops that need water, and
 * `seedTargets` speaks only about tiles that are still empty.
 * </p>
 *
 * <p>
 * SO THE PROGRAM ANSWERS FOR ITS OWN EFFECTS, which is the one record that is exact: its nodes are the sows that will have
 * happened by the time the second call runs. The COST, stated rather than hidden: a tile sowed by an EARLIER PROGRAM - or
 * by the player - is invisible here, and the Mod's own `soil_has_crop` stays the authority on it. The alternative, a
 * pre-dispatch re-read of the world per node, would spend a Mod round trip on every step of every plan to buy an answer
 * dispatch already gives, and would still race the plan's own in-flight nodes.
 * </p>
 */
export const ONE_CROP_PER_TILE_TARGET_FAMILIES: readonly string[] = Object.freeze(["seedTargets"]);

/** The little a step and a node of a program have to say for this rule: what they act as, and what they are. */
type SowStep = Readonly<{ actionId: string; targetFamily: string | null }>;

/** The step this one is written after, as the program records it: its id, and the action it was written from. */
type EarlierSowStep = Readonly<{ nodeId: string; actionId: string }>;

/**
 * The refusal for a step whose tile an earlier step of the same program already sowed, or `null`.
 *
 * `family` is the surface's own `targetFamily`; `earlier` is the nearest step before this one that addresses the tile, and
 * its family is read from the published vocabulary rather than from a second list here - an earlier step of ANOTHER family
 * on the same tile is the composition the product wants (`till_soil` then `plant_seed`, `plant_seed` then `water_crop`).
 */
export function planSecondSowRefusal(
  step: Readonly<{ actionId: string; targetFamily: string | null; place: string | null }>,
  earlier: EarlierSowStep | undefined,
  actions: readonly SowStep[],
): string | null {
  const family = step.targetFamily;
  if (family === null || step.place === null) return null;
  if (!ONE_CROP_PER_TILE_TARGET_FAMILIES.includes(family)) return null;
  if (earlier === undefined) return null;
  if (actions.find((candidate) => candidate.actionId === earlier.actionId)?.targetFamily !== family) return null;
  return `plan_script_tile_sown_twice:${family}:${step.place}:sown_by=${earlier.nodeId}`;
}
