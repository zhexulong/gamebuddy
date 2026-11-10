/**
 * The per-family target-fact predicates: pure readings of an untrusted bridge value.
 *
 * They were protocol.ts's own private helpers until that file's size ratchet required the
 * extraction; nothing here consults state, and every predicate answers only about the value it
 * was handed, so the family stands alone.
 */

export function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

/**
 * The Mod's canonical tool categories (`FarmhandActionCatalog.ToolEnum`): the words a `tool:<category>` claim and an
 * `equip_tool` selector share. Kept here because the tool slot's published `category` is that same vocabulary.
 */
export const TOOL_CATEGORY_VALUES: ReadonlySet<string> = new Set([
  "axe",
  "pickaxe",
  "hoe",
  "watering_can",
  "fishing_rod",
  "weapon",
  "scythe",
  "shears",
  "milk_pail",
  "pan",
]);

/** The category a tool the Mod has no word for reports, instead of the nearest-looking guess. */
const UNKNOWN_TOOL_CATEGORY = "unknown";

export function isToolSlotFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["slot", "label", "upgradeLevel", "category"]) &&
    isToolSlot(value.slot) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 128 &&
    // Optional because the Mod reports it only for tools that have an upgrade level; an absent value is
    // "this tool does not upgrade", never "unknown".
    (value.upgradeLevel === undefined ||
      (typeof value.upgradeLevel === "number" && Number.isInteger(value.upgradeLevel) && value.upgradeLevel >= 0)) &&
    // Optional at the wire level: a Mod older than the category projection publishes none. When it is present it must
    // be one of the Mod's own words or `unknown`, never free text, because a planner reads it to satisfy a claim.
    (value.category === undefined || isToolSlotCategory(value.category))
  );
}

/** The category word one tool slot publishes: a canonical tool category, or `unknown`. */
function isToolSlotCategory(value: unknown): value is string {
  return typeof value === "string" && (value === UNKNOWN_TOOL_CATEGORY || TOOL_CATEGORY_VALUES.has(value));
}

export function isForageTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetId", "x", "y", "qualifiedItemId", "stack", "displayName", "isForage"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    value.stack <= 999 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    // Optional at the wire: a Mod older than this field publishes no answer, and one that carries it publishes
    // `Object.isForage()`, so a non-boolean is a malformed row rather than a missing measurement.
    (value.isForage === undefined || typeof value.isForage === "boolean")
  );
}

export function isItemTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "qualifiedItemId", "stack", "displayName"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    value.stack <= 999 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isWateringCanFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "qualifiedItemId", "label", "water", "max"]) &&
    isToolSlot(value.slot) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 128 &&
    typeof value.water === "number" &&
    Number.isSafeInteger(value.water) &&
    value.water >= 0 &&
    value.water <= 100 &&
    typeof value.max === "number" &&
    Number.isSafeInteger(value.max) &&
    value.max > 0 &&
    value.max <= 100 &&
    value.water <= value.max
  );
}

export function isRefillWateringCanTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

/**
 * One row of `waterTargets`: the engine's own castable water tile and the opaque id `fish_here` binds it with.
 *
 * The SAME shape as the refill family, deliberately: both name a water tile by a hash the Mod derives from the location
 * and the tile, and both carry nothing else. The two families differ in the PREDICATE that produced them
 * (`CanRefillWateringCanOnTile` vs `canFishHere` + `isTileFishable`), not in the row the wire carries.
 */
export function isWaterTargetFact(value: unknown): boolean {
  return isRefillWateringCanTargetFact(value);
}

/**
 * The CLOSED vocabulary of location-fixed interaction points, mirrored by the Mod's
 * `FixedInteractionPointKinds` and by the wire schema's own `enum` for the same field.
 *
 * <p>
 * The schema is the authority: `schema-contract.test.ts` compares this set with the schema's enum, so a
 * token added on one side alone fails there by name instead of producing `invalid_snapshot` on a real map.
 * The four `mine_*` words name the Buildings-layer tile indices `MineShaft.checkAction` dispatches on
 * (`MineShaft.cs:3057-3096`); `action_tile` and `touch_action_tile` name the engine's two tile properties.
 * </p>
 */
const FIXED_INTERACTION_POINT_KINDS: ReadonlySet<string> = new Set([
  "mine_elevator",
  "mine_ladder_up",
  "mine_ladder_down",
  "mine_shaft",
  "action_tile",
  "touch_action_tile",
]);

/**
 * One interaction point the MAP fixes at a tile: a mine ladder, a shop counter, a television.
 *
 * <p>
 * `actionWord` is the engine's own first word at that tile (`MinecartTransport` out of
 * `Action: MinecartTransport Default`) and is `null` where the engine carries no word at all - a mine
 * ladder is a tile INDEX, so it has nothing to quote. It is required-but-nullable rather than optional:
 * `hasExactKeys` then proves the Mod sends the member, and a null reads as "no word" instead of as
 * "this Mod is too old to have one".
 * </p>
 */
export function isFixedInteractionPointFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["x", "y", "kind", "actionWord"]) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.kind === "string" &&
    FIXED_INTERACTION_POINT_KINDS.has(value.kind) &&
    (value.actionWord === null || isBoundedNonEmptyString(value.actionWord, 64))
  );
}

export function isPetBowlTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

export function isSlimeHutchTroughTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

/**
 * `CropData.RegrowDays` as the engine reports it: -1 means the crop does not regrow at all, 0 means it regrows on the
 * day it is picked, and a positive number is the gap between harvests. The Host accepts the engine's range instead of a
 * normalised copy of it - the copy is what refused a real farm for 131 seconds.
 */
function isRegrowDays(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1;
}

export function isCropTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "targetId",
      "x",
      "y",
      "cropId",
      "displayName",
      "watered",
      "harvestable",
      "daysToHarvest",
      "regrowDays",
      "harvestMethod",
      "isRaised",
      "seasons",
      "fullyGrown",
      "tileBlockedNow",
      "cropFactsUnknown",
    ]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.cropId === "string" &&
    value.cropId.length > 0 &&
    value.cropId.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    // Optional at the wire: a Mod older than 2026-11-05 publishes neither, and a row that carries one publishes the
    // engine's own `isWatered()` / `readyForHarvest()` answer, so a non-boolean is a malformed row rather than a
    // missing measurement.
    (value.watered === undefined || typeof value.watered === "boolean") &&
    (value.harvestable === undefined || typeof value.harvestable === "boolean") &&
    // The `Data/Crops` half. Every one of these is absent together when the engine cannot resolve the crop's data row
    // (`cropFactsUnknown: "crop_data_missing"`), so absence is a stated fact rather than a default: a row may not carry a
    // number here and no data, and it may not carry the gap token and a number.
    (value.daysToHarvest === undefined || isNonNegativeSafeInteger(value.daysToHarvest)) &&
    // `CropData.RegrowDays` is **-1** for a crop that does not regrow; zero is a different answer (the engine's own
    // "regrows on day 0", which a modded crop may use). Measured 2026-11-09: a runner rejected a whole snapshot because
    // this validator demanded `>= 0` while the Mod published the engine's -1 faithfully (named at last as
    // `invalid_snapshot:cropTargets:entry0:keys=...`). The engine's range is the contract; a normalised copy of it is not.
    (value.regrowDays === undefined || isRegrowDays(value.regrowDays)) &&
    (value.harvestMethod === undefined || isBoundedNonEmptyString(value.harvestMethod, 32)) &&
    (value.isRaised === undefined || typeof value.isRaised === "boolean") &&
    (value.seasons === undefined || isCropSeasons(value.seasons)) &&
    (value.fullyGrown === undefined || typeof value.fullyGrown === "boolean") &&
    (value.tileBlockedNow === undefined || typeof value.tileBlockedNow === "boolean") &&
    (value.cropFactsUnknown === undefined || isBoundedNonEmptyString(value.cropFactsUnknown, 64)) &&
    !(value.cropFactsUnknown !== undefined && value.daysToHarvest !== undefined)
  );
}

/** `CropData.Seasons` as the engine's season keys: at most four, each a bounded word. */
function isCropSeasons(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 4 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 16)
  );
}

export function isHarvestTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "targetId",
      "x",
      "y",
      "cropId",
      "qualifiedHarvestItemId",
      "displayName",
      "regrowsAfterHarvest",
      "readyForHarvest",
      "forageCrop",
      "harvestMethod",
    ]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.cropId === "string" &&
    value.cropId.length > 0 &&
    value.cropId.length <= 128 &&
    typeof value.qualifiedHarvestItemId === "string" &&
    value.qualifiedHarvestItemId.length > 0 &&
    value.qualifiedHarvestItemId.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    typeof value.regrowsAfterHarvest === "boolean" &&
    (value.readyForHarvest === undefined || typeof value.readyForHarvest === "boolean") &&
    (value.forageCrop === undefined || typeof value.forageCrop === "boolean") &&
    (value.harvestMethod === undefined || isHarvestMethodWord(value.harvestMethod))
  );
}

/**
 * The engine's own `StardewValley.GameData.Crops.HarvestMethod` members, lower-cased.
 *
 * Published as the fact rather than as the engine call name, because it is what the two crop actions branch on:
 * `HoeDirt.performUseAction` harvests a `grab` crop through `Crop.harvest` and hands a `scythe` crop to the scythe
 * branch (HoeDirt.cs:488-529). The target version's enum declares exactly these two members; a third one would arrive
 * here as a named `invalid_snapshot`, which is the intended loud failure.
 */
function isHarvestMethodWord(value: unknown): boolean {
  return typeof value === "string" && (value === "grab" || value === "scythe");
}

export function isWoodFenceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "slot", "x", "y", "qualifiedItemId", "displayName"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.qualifiedItemId === "(O)322" &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isWoodFenceResultTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "location",
      "slot",
      "x",
      "y",
      "qualifiedItemId",
      "isFence",
      "isGate",
      "health",
      "maxHealth",
      "displayName",
    ]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.qualifiedItemId === "(O)322" &&
    value.isFence === true &&
    value.isGate === false &&
    isFiniteNumber(value.health) &&
    isFiniteNumber(value.maxHealth) &&
    value.health > 0 &&
    value.maxHealth >= value.health &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isCrabPotTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "slot", "x", "y", "qualifiedItemId", "displayName"]) &&
    isCrabPotCore(value) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isCrabPotCollectTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "location",
      "x",
      "y",
      "qualifiedItemId",
      "outputQualifiedItemId",
      "outputStack",
      "displayName",
    ]) &&
    typeof value.targetId === "string" &&
    /^collect_crab_pot_[a-f0-9]{16}$/u.test(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length >= 1 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.qualifiedItemId === "(O)710" &&
    typeof value.outputQualifiedItemId === "string" &&
    value.outputQualifiedItemId.length >= 1 &&
    typeof value.outputStack === "number" &&
    Number.isSafeInteger(value.outputStack) &&
    value.outputStack >= 1 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isCrabPotResultTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "location",
      "slot",
      "x",
      "y",
      "qualifiedItemId",
      "ownerId",
      "offsetX",
      "offsetY",
      "overlayTiles",
      "displayName",
    ]) &&
    isCrabPotCore(value) &&
    typeof value.ownerId === "number" &&
    Number.isSafeInteger(value.ownerId) &&
    value.ownerId >= 0 &&
    isFiniteNumber(value.offsetX) &&
    isFiniteNumber(value.offsetY) &&
    Array.isArray(value.overlayTiles) &&
    value.overlayTiles.length <= 4 &&
    value.overlayTiles.every(
      (tile) =>
        isRecord(tile) &&
        hasExactKeys(tile, ["x", "y", "count"]) &&
        isTileCoordinate(tile.x) &&
        isTileCoordinate(tile.y) &&
        typeof tile.count === "number" &&
        Number.isSafeInteger(tile.count) &&
        tile.count > 0,
    ) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isBaitCrabPotTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "location",
      "slot",
      "x",
      "y",
      "qualifiedItemId",
      "baitQualifiedItemId",
      "ownerId",
      "baitStack",
      "displayName",
    ]) &&
    isCrabPotCore(value) &&
    value.baitQualifiedItemId === "(O)685" &&
    typeof value.ownerId === "string" &&
    /^[0-9]{1,20}$/.test(value.ownerId) &&
    value.baitStack === 1 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

function isCrabPotCore(value: Record<string, unknown>): boolean {
  return (
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.qualifiedItemId === "(O)710"
  );
}

export function isSeedTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "targetId",
      "slot",
      "x",
      "y",
      "qualifiedItemId",
      "displayName",
      "canPlantThisSeedHere",
      "crop",
    ]) &&
    isOpaqueId(value.targetId) &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    // Optional at the wire: a Mod older than these fields publishes neither, and a row that carries one publishes the
    // engine's own `HoeDirt.canPlantThisSeedHere` / `HoeDirt.crop is not null` answer.
    (value.canPlantThisSeedHere === undefined || typeof value.canPlantThisSeedHere === "boolean") &&
    (value.crop === undefined || typeof value.crop === "boolean")
  );
}

export function isFertilizerTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetId", "slot", "x", "y", "qualifiedItemId", "displayName", "canApplyFertilizer"]) &&
    isOpaqueId(value.targetId) &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    // Optional at the wire for the same reason as the seed row's own two facts; the value is
    // `HoeDirt.CanApplyFertilizer`, the predicate `fertilize_tile` refuses on.
    (value.canApplyFertilizer === undefined || typeof value.canApplyFertilizer === "boolean")
  );
}

export function isDebrisTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "slot",
      "x",
      "y",
      "parentSheetIndex",
      "toolKind",
      "requiredUpgradeLevel",
      "health",
    ]) &&
    isOpaqueId(value.targetId) &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.parentSheetIndex === "number" &&
    Number.isSafeInteger(value.parentSheetIndex) &&
    value.parentSheetIndex >= 0 &&
    value.parentSheetIndex <= 2000 &&
    typeof value.toolKind === "string" &&
    /^(axe|pickaxe)$/.test(value.toolKind) &&
    typeof value.requiredUpgradeLevel === "number" &&
    Number.isSafeInteger(value.requiredUpgradeLevel) &&
    value.requiredUpgradeLevel >= 0 &&
    value.requiredUpgradeLevel <= 4 &&
    typeof value.health === "number" &&
    Number.isSafeInteger(value.health) &&
    value.health > 0 &&
    value.health <= 100
  );
}

export function isArtifactSpotTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetId", "location", "x", "y", "qualifiedItemId", "displayName"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 128 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    // Both diggable ids are legal: `(O)590` and `(O)SeedSpot` reach the identical
    // `t is Hoe` branch (Object.cs:1310) and every spawn site picks between them
    // (GameLocation.cs:15233, Mountain.cs:272). Pinning only `(O)590` hid roughly a
    // sixth of the artifact spots from the Agent.
    isBoundedNonEmptyString(value.qualifiedItemId, 128) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isClearHoeDirtTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetId", "location", "x", "y", "crop", "ground"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 128 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.crop === false &&
    value.ground === true
  );
}

export function isArtifactSpotResultTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetId", "location", "x", "y", "crop", "ground"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 128 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.crop === false &&
    value.ground === true
  );
}

export function isRockSourceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "qualifiedItemId", "health", "displayName"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    // The native breakable-stone category is `Category == -999 && Name == "Stone"`
    // (Object.cs:6082), not one item id: the engine gives 8/10/12/14/25 their own
    // durability and routes every other stone id through the `default` arm at
    // durability 1 (Object.cs:920-943). Pinning `(O)2` here rejected the Mod's own
    // correct discovery on any other one-hit stone id. The id stays an opaque
    // bounded token; the native predicate is the authority.
    isBoundedNonEmptyString(value.qualifiedItemId, 128) &&
    // `health` is the rock's DURABILITY, which the native category does not bound and
    // `Pickaxe.DoFunction` lowers by `Math.Max(1, upgradeLevel + 1) + additionalPower`
    // per swing (Pickaxe.cs:139-140). It used to be `const 1` - "the basic pickaxe
    // removes it in one swing" - which refused every multi-hit rock the Mod had
    // correctly discovered, so the whole snapshot failed and no action could run.
    //
    // Both bounds are the ENGINE's, cited rather than rounded:
    //
    //   1..25  Every path that creates a breakable stone writes 1 or more and never 0:
    //          the constructor's `default` arm writes 1 and 8/10/12/14/25 get their own
    //          durability (Object.cs:920-943), the mountain writes 2-16 (Farm.cs:551-601,
    //          Mountain.cs:259-317), a mine node writes 1 up to 25 (MineShaft.cs:4354-4359),
    //          the volcano writes 1-16 (VolcanoDungeon.cs:1521-1556). 25 is the largest
    //          value ANY of them writes, and nothing clamps above it - so 25 is a measured
    //          ceiling, not a round number near one (the previous `100` was exactly that).
    //          A stone only reaches 0 INSIDE the swing that removes it - the subtraction at
    //          Object.cs:1129-1133 / Pickaxe.cs:139-146 is followed by the object's removal
    //          at Pickaxe.cs:169-178 in the same call - and `DiscoverRockSourceTargets` runs
    //          on the game thread, so 0 is never a discoverable stone. The floor stays 1.
    //
    // A value outside these is a malformed frame, not a gameplay judgement this layer makes.
    typeof value.health === "number" &&
    Number.isSafeInteger(value.health) &&
    value.health >= 1 &&
    value.health <= 25 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

/**
 * What one machine's rows declare it takes: the derived entries, and how many the cap withheld.
 *
 * `inputs` is the machine's own `Data/Machines` `ItemPlacedInMachine` trigger rows in the machine's order (an item id, a
 * `tag:` selector, or `any`), each with the count the row consumes; `omitted` counts what the cap withheld. Empty
 * `inputs` means the machine declares no load input - which is NOT the same fact as a `null` acceptance beside it.
 *
 * The cap is the language-neutral wire cap (`protocol/bridge-v1.schema.json`
 * `$defs.machineAcceptance.properties.inputs.maxItems`) and the Mod's `MachineInputAcceptance.InputLimit`; this validator
 * is bound to the same number, and `protocol.test.ts` reads it out of the schema rather than trusting this comment.
 */
const MACHINE_ACCEPTANCE_INPUT_LIMIT = 8;

function isMachineAcceptanceFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["inputs", "omitted"]) &&
    Array.isArray(value.inputs) &&
    value.inputs.length <= MACHINE_ACCEPTANCE_INPUT_LIMIT &&
    value.inputs.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 64) &&
    isNonNegativeSafeInteger(value.omitted)
  );
}

export function isMachineTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "targetId",
      "x",
      "y",
      "qualifiedItemId",
      "readyForHarvest",
      "minutesUntilReady",
      "heldObjectQualifiedItemId",
      "lastInputQualifiedItemId",
      "loadInputSlot",
      "loadInputQualifiedItemId",
      "loadInputStack",
      "collectOutputReady",
      "accepts",
      "displayName",
      "machineData",
    ]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.readyForHarvest === "boolean" &&
    typeof value.minutesUntilReady === "number" &&
    Number.isSafeInteger(value.minutesUntilReady) &&
    value.minutesUntilReady >= 0 &&
    value.minutesUntilReady <= 100000 &&
    (value.heldObjectQualifiedItemId === undefined ||
      value.heldObjectQualifiedItemId === null ||
      typeof value.heldObjectQualifiedItemId === "string") &&
    (value.lastInputQualifiedItemId === undefined ||
      value.lastInputQualifiedItemId === null ||
      typeof value.lastInputQualifiedItemId === "string") &&
    (value.loadInputSlot === undefined || value.loadInputSlot === null || isToolSlot(value.loadInputSlot)) &&
    (value.loadInputQualifiedItemId === undefined ||
      value.loadInputQualifiedItemId === null ||
      isQualifiedItemId(value.loadInputQualifiedItemId)) &&
    (value.loadInputStack === undefined ||
      value.loadInputStack === null ||
      isMachineInputCount(value.loadInputStack)) &&
    (value.collectOutputReady === undefined ||
      value.collectOutputReady === null ||
      typeof value.collectOutputReady === "boolean") &&
    // Optional at the wire: `Object.GetMachineData() is not null`, the answer that makes this object a machine.
    (value.machineData === undefined || typeof value.machineData === "boolean") &&
    // What the machine's own Data/Machines rows declare it takes. ABSENT is not a fourth state here: the Mod writes the
    // key even when it cannot answer, so `null` is "the data could not answer" and `{"inputs": []}` is "it takes
    // nothing" - two facts a reader must be able to tell apart. Absent only means a Mod build older than the field.
    (value.accepts === undefined || value.accepts === null || isMachineAcceptanceFact(value.accepts)) &&
    // The three load fields are one fact: the slot that holds the input, the item it holds, and the count the machine's
    // own rows consume. Half a load is not a smaller promise, it is an unusable one, so all three appear together.
    ((value.loadInputSlot === undefined &&
      value.loadInputQualifiedItemId === undefined &&
      value.loadInputStack === undefined) ||
      (isToolSlot(value.loadInputSlot) &&
        isQualifiedItemId(value.loadInputQualifiedItemId) &&
        isMachineInputCount(value.loadInputStack))) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isTreeChopSourceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "location",
      "x",
      "y",
      "treeType",
      "growthStage",
      "health",
      "stump",
      "moss",
      "tapped",
    ]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.treeType === "string" &&
    value.treeType.length > 0 &&
    value.treeType.length <= 32 &&
    typeof value.growthStage === "number" &&
    Number.isSafeInteger(value.growthStage) &&
    value.growthStage >= 5 &&
    value.growthStage <= 20 &&
    // HEALTH IS THE DURABILITY LEFT, NOT A FLAG, and this read `=== 1`.
    //
    // A mature tree starts at 10 (`Tree.cs:187/203`) and one axe swing removes 1 (`Tree.cs:1177-1200`), so `1` is a tree
    // one swing from falling - only that one was admitted. The Mod's discovery predicate was the same mistake (`== 1f`)
    // and was fixed to `> 0f`; this half was not, so the moment the Mod started publishing a real tree the first snapshot
    // was refused `invalid_snapshot:treeChopSourceTargets` and the bridge closed. Measured 2026-10-31: six submissions,
    // then a dead pipe.
    //
    // The bound is the engine's: a tree is felled at `<= 0`, and 10 is a mature tree's starting value.
    typeof value.health === "number" &&
    value.health > 0 &&
    value.health <= 10 &&
    value.stump === false &&
    value.moss === false &&
    value.tapped === false
  );
}

export function isTreeChopResultTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "treeType", "health", "stump", "moss", "tapped"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.treeType === "string" &&
    value.treeType.length > 0 &&
    value.treeType.length <= 32 &&
    value.health === 5 &&
    value.stump === true &&
    value.moss === false &&
    value.tapped === false
  );
}

export function isTreeStumpTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "treeType", "health"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.treeType === "string" &&
    value.treeType.length > 0 &&
    value.treeType.length <= 128 &&
    typeof value.health === "number" &&
    Number.isFinite(value.health) &&
    value.health >= 0 &&
    value.health <= 1000
  );
}

export function isTreeSaplingTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "slot", "x", "y", "qualifiedItemId", "displayName"]) &&
    isOpaqueId(value.targetId) &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isWeedTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetId", "location", "x", "y", "health", "isWeeds"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.health === "number" &&
    Number.isSafeInteger(value.health) &&
    value.health >= 0 &&
    value.health <= 1000 &&
    // Optional at the wire: `Object.IsWeeds()`, the litter predicate `cut_weeds` re-checks on the target.
    (value.isWeeds === undefined || typeof value.isWeeds === "boolean")
  );
}

export function isGrassTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "grassType", "numberOfWeeds"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.grassType === "number" &&
    Number.isSafeInteger(value.grassType) &&
    value.grassType >= 1 &&
    value.grassType <= 8 &&
    typeof value.numberOfWeeds === "number" &&
    Number.isSafeInteger(value.numberOfWeeds) &&
    value.numberOfWeeds >= 1 &&
    value.numberOfWeeds <= 1000
  );
}

export function isPedestalTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "qualifiedItemId", "stack"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    Number.isSafeInteger(value.stack) &&
    (value.stack as number) > 0 &&
    (value.stack as number) <= 999
  );
}

export function isFenceGateTargetFact(value: unknown): boolean {
  return (
    isBushTargetFact({
      targetId: value && isRecord(value) ? value.targetId : null,
      location: value && isRecord(value) ? value.location : null,
      x: value && isRecord(value) ? value.x : null,
      y: value && isRecord(value) ? value.y : null,
    }) &&
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "isOpen"]) &&
    typeof value.isOpen === "boolean"
  );
}

export function isBushTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

export function isCaskTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "hasHeldObject", "heldQualifiedItemId"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.hasHeldObject === "boolean" &&
    // A cask that claims to hold an object must name it. A name without the
    // flag is tolerated: discovery reads the held object directly (the fixture
    // and the runner disagree on whether an empty cask may carry a stray id).
    !(value.hasHeldObject === true && value.heldQualifiedItemId === null) &&
    (value.heldQualifiedItemId === null ||
      (typeof value.heldQualifiedItemId === "string" &&
        value.heldQualifiedItemId.length > 0 &&
        value.heldQualifiedItemId.length <= 128))
  );
}

export function isFacilityTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

export function isSignTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "hasDisplayItem", "displayQualifiedItemId"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.hasDisplayItem === "boolean" &&
    (value.displayQualifiedItemId === null ||
      (typeof value.displayQualifiedItemId === "string" &&
        value.displayQualifiedItemId.length > 0 &&
        value.displayQualifiedItemId.length <= 128))
  );
}

export function isSiloTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "hay"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    Number.isSafeInteger(value.hay) &&
    (value.hay as number) >= 0
  );
}

export function isLanternSlotFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "isOn", "fuelLeft"]) &&
    isToolSlot(value.slot) &&
    typeof value.isOn === "boolean" &&
    Number.isSafeInteger(value.fuelLeft) &&
    (value.fuelLeft as number) >= 0 &&
    (value.fuelLeft as number) <= 100
  );
}

export function isScytheCropTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "targetId",
      "location",
      "x",
      "y",
      "cropId",
      "qualifiedHarvestItemId",
      "displayName",
      "readyForHarvest",
      "dead",
      "forageCrop",
      "harvestMethod",
    ]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.cropId === "string" &&
    value.cropId.length > 0 &&
    value.cropId.length <= 128 &&
    typeof value.qualifiedHarvestItemId === "string" &&
    value.qualifiedHarvestItemId.length > 0 &&
    value.qualifiedHarvestItemId.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    // Optional at the wire. These are the four facts the action's two terminals differ on - a dead tile can only be
    // cleared, and the harvest branch needs readiness, a non-forage crop and the scythe method.
    (value.readyForHarvest === undefined || typeof value.readyForHarvest === "boolean") &&
    (value.dead === undefined || typeof value.dead === "boolean") &&
    (value.forageCrop === undefined || typeof value.forageCrop === "boolean") &&
    (value.harvestMethod === undefined || isHarvestMethodWord(value.harvestMethod))
  );
}

export function isNpcRelationshipTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "x",
      "y",
      "npcName",
      "friendshipPoints",
      "friendshipStatus",
      "talkedToToday",
      "giftsToday",
      "giftsThisWeek",
    ]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.npcName === "string" &&
    value.npcName.length > 0 &&
    value.npcName.length <= 64 &&
    typeof value.friendshipPoints === "number" &&
    Number.isSafeInteger(value.friendshipPoints) &&
    value.friendshipPoints >= -1 &&
    value.friendshipPoints <= 10000 &&
    typeof value.friendshipStatus === "string" &&
    value.friendshipStatus.length > 0 &&
    value.friendshipStatus.length <= 32 &&
    typeof value.talkedToToday === "boolean" &&
    typeof value.giftsToday === "number" &&
    Number.isSafeInteger(value.giftsToday) &&
    value.giftsToday >= 0 &&
    value.giftsToday <= 10 &&
    typeof value.giftsThisWeek === "number" &&
    Number.isSafeInteger(value.giftsThisWeek) &&
    value.giftsThisWeek >= 0 &&
    value.giftsThisWeek <= 20
  );
}

export function isVillagerWhereaboutsFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "npcName", "displayName", "location", "x", "y", "inCurrentLocation"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.npcName === "string" &&
    value.npcName.length > 0 &&
    value.npcName.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.inCurrentLocation === "boolean"
  );
}

/**
 * One loaded location's ready-for-harvest crop summary. The count is bounded
 * to a safe non-negative integer (a full farm cannot exceed a few thousand
 * crops; 1_000_000 is a generous but still finite ceiling).
 *
 * `nearestX`/`nearestY` are OPTIONAL AND A PAIR. A count is a fact every loaded map has; the nearest tile is a fact only
 * the map the actor stands on has, so an off-map row publishes its count with neither coordinate. Requiring both when
 * either is present is what keeps a half-address - one axis of a tile, which names no place at all - out of the snapshot.
 */
export function isHarvestWhereaboutsFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeysOrOptional(value, ["location", "readyForHarvestCount"], ["nearestX", "nearestY"]) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isNonNegativeSafeInteger(value.readyForHarvestCount) &&
    value.readyForHarvestCount <= 1_000_000 &&
    (value.nearestX === undefined
      ? value.nearestY === undefined
      : isTileCoordinate(value.nearestX) && isTileCoordinate(value.nearestY))
  );
}

export function isWateringWhereaboutsFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeysOrOptional(value, ["location", "needsWaterCount"], ["nearestX", "nearestY"]) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isNonNegativeSafeInteger(value.needsWaterCount) &&
    value.needsWaterCount <= 1_000_000 &&
    (value.nearestX === undefined
      ? value.nearestY === undefined
      : isTileCoordinate(value.nearestX) && isTileCoordinate(value.nearestY))
  );
}

/**
 * The Mod's projected weather token. "unknown" is the world-not-ready
 * placeholder; the live tokens are the four native flags plus the sunny
 * default. Strict whitelist so a malformed Mod can never smuggle free text.
 */

export function isPetTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "petType", "friendship", "pettedToday", "stationary"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.petType === "string" &&
    value.petType.length > 0 &&
    value.petType.length <= 32 &&
    typeof value.friendship === "number" &&
    Number.isSafeInteger(value.friendship) &&
    value.friendship >= 0 &&
    value.friendship <= 1000 &&
    value.pettedToday === false &&
    typeof value.stationary === "boolean"
  );
}

/**
 * One published farm-animal pet target: the opaque identity `FarmAnimal.pet` is addressed by, the animal's live tile,
 * its native type, and the friendship the pet itself raises.
 *
 * There is deliberately no `pettedToday` field. Discovery omits every animal this farmer has already petted today
 * (`FarmAnimal.wasPet`), exactly as `petTargets` omits an already-petted Pet, so the rows this validator sees are the
 * ones still pettable. A stale id for an animal petted after the observation is refused by the Mod with
 * `farm_animal_already_petted_today`, which names the real reason instead of pretending the animal is gone.
 */
export function isFarmAnimalPetTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "animalType", "friendship"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.animalType === "string" &&
    value.animalType.length > 0 &&
    value.animalType.length <= 64 &&
    typeof value.friendship === "number" &&
    Number.isSafeInteger(value.friendship) &&
    value.friendship >= 0 &&
    value.friendship <= 1000
  );
}

export function isAnimalProductTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "slot",
      "x",
      "y",
      "animalType",
      "qualifiedProduceItemId",
      "toolKind",
      "produceStack",
      "displayName",
    ]) &&
    isOpaqueId(value.targetId) &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.animalType === "string" &&
    value.animalType.length > 0 &&
    value.animalType.length <= 64 &&
    typeof value.qualifiedProduceItemId === "string" &&
    value.qualifiedProduceItemId.length > 0 &&
    value.qualifiedProduceItemId.length <= 128 &&
    (value.toolKind === "milk_pail" || value.toolKind === "shears") &&
    typeof value.produceStack === "number" &&
    Number.isSafeInteger(value.produceStack) &&
    (value.produceStack === 1 || value.produceStack === 2) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isFeedTroughTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "slot", "x", "y", "hayStack"]) &&
    isOpaqueId(value.targetId) &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.hayStack === "number" &&
    Number.isSafeInteger(value.hayStack) &&
    value.hayStack > 0 &&
    value.hayStack <= 999
  );
}

/**
 * One storage container as ENTITY STATE: the container, and every item inside it.
 *
 * `items` is deliberately not bounded here, not even at the native chest capacity. A container's contents are a
 * fact about the world, so a chest reports what it holds, whole: the two flattened families this replaced paired a
 * container against the pack and against its own items, and bounding that cross product had to hide pairs (the
 * retired `withheldChestStoreTargets`/`withheldChestRetrieveTargets` counts existed only to admit that). What is bounded
 * is how many CONTAINERS arrive - `SNAPSHOT_FAMILY_RULES` - and the frame itself, which `MAX_MESSAGE_BYTES` refuses.
 */
export function isChestStateFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["chestId", "x", "y", "displayName", "isFridge", "items"]) &&
    isOpaqueId(value.chestId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    isBoundedNonEmptyString(value.displayName, 128) &&
    typeof value.isFridge === "boolean" &&
    Array.isArray(value.items) &&
    value.items.every(isChestItemFact)
  );
}

/** One item inside a container: its slot IN THE CONTAINER, and the stack the slot holds. */
function isChestItemFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "qualifiedItemId", "displayName", "stack"]) &&
    isNonNegativeSafeInteger(value.slot) &&
    isBoundedNonEmptyString(value.qualifiedItemId, 128) &&
    isBoundedNonEmptyString(value.displayName, 128) &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0
  );
}

/**
 * The container SUMMARY: the current location's chest count, item count and full count, in one row.
 *
 * A scalar record rather than an array family, so it is validated here beside the container it summarises and named in
 * `SNAPSHOT_KEYS` - the same treatment `artifactSpotFarmSourceCount` gets for the same reason (one number, not a list of
 * targets). It carries no `location` member on purpose: it describes `snapshot.location`, and a second spelling of that
 * fact could disagree with the field it is read beside.
 *
 * `itemCount` is the sum of every occupied slot's stack, so its ceiling is what a location's containers can hold rather
 * than the 36-slot cap of any one container. `fullCount` cannot exceed `chestCount`, and that is checked rather than
 * assumed: two numbers that describe the same containers must agree about how many there are.
 */
export function isChestsSummaryFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["chestCount", "itemCount", "fullCount"]) &&
    isNonNegativeSafeInteger(value.chestCount) &&
    value.chestCount <= 1_000_000 &&
    isNonNegativeSafeInteger(value.itemCount) &&
    value.itemCount <= 1_000_000_000 &&
    isNonNegativeSafeInteger(value.fullCount) &&
    value.fullCount <= value.chestCount
  );
}

export function isShippingBinTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "slot", "qualifiedItemId", "stack", "displayName"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    isToolSlot(value.slot) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isRecipeTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "displayName", "ingredientsAvailable"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128 &&
    typeof value.ingredientsAvailable === "boolean"
  );
}

export function isCookingStationTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "stationKind"]) &&
    typeof value.targetId === "string" &&
    /^cooking_station_[a-f0-9]{16}$/u.test(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length >= 1 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    (value.stationKind === "kitchen" || value.stationKind === "cookout_kit")
  );
}

export function isRaftTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    typeof value.targetId === "string" &&
    /^raft_[a-f0-9]{16}$/u.test(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

export function isHorseTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "name"]) &&
    typeof value.targetId === "string" &&
    /^horse_[a-f0-9]{16}$/u.test(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 64
  );
}

export function isMineEntranceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    typeof value.targetId === "string" &&
    /^mine_entrance_[a-f0-9]{16}$/u.test(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

export function isShopTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "shopId",
      "ownerName",
      "location",
      "ownerTileX",
      "ownerTileY",
      "ownerInReach",
      "stockCount",
      "stockItemIds",
    ]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    typeof value.shopId === "string" &&
    typeof value.ownerName === "string" &&
    typeof value.location === "string" &&
    typeof value.ownerTileX === "number" &&
    Number.isSafeInteger(value.ownerTileX) &&
    typeof value.ownerTileY === "number" &&
    Number.isSafeInteger(value.ownerTileY) &&
    typeof value.ownerInReach === "boolean" &&
    typeof value.stockCount === "number" &&
    Number.isSafeInteger(value.stockCount) &&
    value.stockCount >= 0 &&
    isStringArray(value.stockItemIds) &&
    (value.stockItemIds as readonly string[]).length <= 16
  );
}

/**
 * One row about a plantable seed the actor HOLDS: the count she holds, and - when a shop stocks it - where it is sold,
 * what the menu charges, whether that shop's own hours query says it is open, and where in the world that shop IS.
 *
 * The nullable keys are the three-valued answers, and they are optional at the wire because the Mod omits a null
 * member. `heldCount` absent means the published stack rows did not cover the holding slots; `shopId` absent means NO
 * shop in `Data/Shops` stocks this seed (a different answer from no row at all, which means she holds no plantable
 * seed, and from no family, which means nothing was measured); `declaredPrice` absent means the shop row names this
 * item as a query rather than literally; `hoursCondition` absent means the owner entry declares no trading window;
 * and `openNow` absent means the question could not be asked, with `openNowReason` naming why. `openNow` absent is
 * NOT `openNow: false` - one means the question could not be asked and the other means the shop is shut.
 *
 * The ADDRESS half is exactly one of three and is READ, never computed: `shopDestination` is the `shopTargets` row the
 * Mod already published for this location, `shopLocation` names the room the counter is in when it is somewhere else,
 * and `shopLocationUnknown` says why neither could be read. A row with two of them, or with none, is refused: two is a
 * counter that is both here and elsewhere, and none is a price with no shop to walk to, which is the defect this half
 * removes. The Host does not join the destination to `shopTargets` and does not turn a `shopLocation` into one.
 */
export function isSeedSupplyTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "qualifiedItemId",
      "displayName",
      "heldCount",
      "shopId",
      "shopDisplayName",
      "ownerName",
      "hoursCondition",
      "price",
      "declaredPrice",
      "currency",
      "openNow",
      "openNowReason",
      "shopDestination",
      "shopLocation",
      "shopLocationUnknown",
    ]) &&
    isQualifiedItemId(value.qualifiedItemId) &&
    isBoundedNonEmptyString(value.displayName, 128) &&
    (value.heldCount === undefined || isNonNegativeSafeInteger(value.heldCount)) &&
    (value.shopId === undefined || isBoundedNonEmptyString(value.shopId, 256)) &&
    (value.shopDisplayName === undefined ||
      (typeof value.shopDisplayName === "string" && value.shopDisplayName.length <= 256)) &&
    (value.ownerName === undefined || (typeof value.ownerName === "string" && value.ownerName.length <= 256)) &&
    (value.hoursCondition === undefined || isBoundedNonEmptyString(value.hoursCondition, 256)) &&
    (value.price === undefined || isNonNegativeSafeInteger(value.price)) &&
    (value.declaredPrice === undefined || isNonNegativeSafeInteger(value.declaredPrice)) &&
    (value.currency === undefined || isNonNegativeSafeInteger(value.currency)) &&
    (value.openNow === undefined || typeof value.openNow === "boolean") &&
    (value.openNowReason === undefined || isBoundedNonEmptyString(value.openNowReason, 64)) &&
    // The three address keys, of which EXACTLY ONE is written on every row the Mod publishes.
    (value.shopDestination === undefined || isShopDestinationFact(value.shopDestination)) &&
    (value.shopLocation === undefined || isBoundedNonEmptyString(value.shopLocation, 256)) &&
    (value.shopLocationUnknown === undefined || isBoundedNonEmptyString(value.shopLocationUnknown, 64)) &&
    [value.shopDestination, value.shopLocation, value.shopLocationUnknown].filter((member) => member !== undefined)
      .length === 1 &&
    // A shop half is all-or-nothing: a row that names a shop must also say what it charges, and a row that names no
    // shop must carry no half-answer about one. Otherwise a reader could see a price with no shop to walk to.
    (value.shopId === undefined
      ? value.price === undefined && value.currency === undefined && value.openNow === undefined
      : value.price !== undefined && value.currency !== undefined)
  );
}

/**
 * The id `shop_purchase` accepts for a shop counter, and the one spelling the `shopTargets` row it is copied from
 * publishes. The destination carries that row's own id rather than one minted for this family, so a reader can hand it
 * straight to the purchase.
 */
const SHOP_DESTINATION_TARGET_ID = /^shop_[a-f0-9]{16}$/u;

/**
 * The `shopTargets` row for the counter a supply row's shop trades at, copied into the seed family's own frame.
 *
 * Four members exactly, because a walk needs all four and a fifth would be a member the `shop_purchase` row does not
 * publish: the room, the target id in it, the tile that target stands on, and the name to show while walking. The tile
 * is the snapshot's own coordinate (`$defs.tile`), so a destination can be planned from without a second scale.
 */
function isShopDestinationFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["location", "targetId", "tile", "label"]) &&
    isBoundedNonEmptyString(value.location, 256) &&
    typeof value.targetId === "string" &&
    SHOP_DESTINATION_TARGET_ID.test(value.targetId) &&
    isRecord(value.tile) &&
    hasExactKeys(value.tile, ["x", "y"]) &&
    isTileCoordinate(value.tile.x) &&
    isTileCoordinate(value.tile.y) &&
    isBoundedNonEmptyString(value.label, 256)
  );
}

export function isFishPondTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "buildingType", "occupants", "fishType"]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    typeof value.x === "number" &&
    Number.isSafeInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isSafeInteger(value.y) &&
    typeof value.buildingType === "string" &&
    typeof value.occupants === "number" &&
    Number.isSafeInteger(value.occupants) &&
    value.occupants >= 0 &&
    typeof value.fishType === "string"
  );
}

export function isAnimalDoorTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "buildingType", "isOpen"]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    typeof value.x === "number" &&
    Number.isSafeInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isSafeInteger(value.y) &&
    typeof value.buildingType === "string" &&
    typeof value.isOpen === "boolean"
  );
}

export function isWearableTargetFact(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // A missing optional member must be allowed: the Mod omits nulls on the wire.
  return hasExactKeys(record, ["targetId", "bodySlot", "occupantQualifiedItemId", "occupantDisplayName"]);
}

export function isWarpItemTargetFact(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // A missing optional member must be allowed: the Mod omits nulls on the wire.
  return hasExactKeys(record, [
    "slot",
    "qualifiedItemId",
    "displayName",
    "stack",
    "destination",
    "destinationX",
    "destinationY",
  ]);
}

export function isPanSiteFact(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // A missing optional member must be allowed: the Mod omits nulls on the wire.
  return hasExactKeys(record, ["x", "y"]);
}

export function isMailboxTargetFact(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  // A missing optional member must be allowed: the Mod omits nulls on the wire.
  return hasExactKeys(record, ["targetId", "location", "x", "y", "pendingCount"]);
}
/** The world-object lane's projection. Every member is always written (the Mod omits nulls,
 * which is why `kind`, `slot`, `qualifiedItemId` and `displayName` are required here), and a
 * missing or malformed array must fail closed rather than read as a transport fault. */

/** The world-object lane's projection. Every member is always written (the Mod omits nulls by
 * default, which is why `rotation` and `rotations` carry `JsonIgnoreCondition.Never` on the Mod
 * side), and a missing or malformed array must fail closed rather than read as a transport fault. */
export function isWorldObjectTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "kind",
      "location",
      "x",
      "y",
      "slot",
      "qualifiedItemId",
      "displayName",
      "rotation",
      "rotations",
    ]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    // `placed_furniture` is a piece standing in `location.furniture` - where the room's own bed, sofa and rug live, and
    // where `place_owned_object` puts a piece down (Game1.cs:7033-7043) - never in `location.objects`, so none of the four
    // object kinds describes one. Its `slot` is -1 because no tool in this lane lifts furniture, and the piece is named
    // through `move_placed_furniture`, whose published target family IS this one. The Mod emitted this kind for a real
    // frame before this list named it, so the first snapshot carrying a room's furniture was refused
    // `invalid_snapshot:worldObjectTargets` and the bridge closed 331 ms into `round31`.
    (value.kind === "placement_candidate" ||
      value.kind === "removable_object" ||
      value.kind === "non_removable_object" ||
      value.kind === "breakable_container" ||
      value.kind === "placed_furniture" ||
      // `empty_pedestal` is a pedestal standing in `location.objects` that holds NOTHING, which is the only state
      // `place_item_on_pedestal` can address. `pedestalTargets` cannot supply it: that family is the TAKE projection and
      // carries only a pedestal that already holds an item, binding that item's identity and stack.
      value.kind === "empty_pedestal") &&
    typeof value.location === "string" &&
    typeof value.x === "number" &&
    Number.isSafeInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isSafeInteger(value.y) &&
    typeof value.slot === "number" &&
    Number.isSafeInteger(value.slot) &&
    value.slot >= -1 &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    typeof value.displayName === "string" &&
    // `rotation`/`rotations` are the piece's live `currentRotation` and its own cycle length. They are
    // `null` for every kind that is not furniture, and `null` is the ONLY absence this accepts: a 0 or
    // -1 sentinel would pass `Number.isSafeInteger`, and 0 is a legal rotation, so the sentinel would
    // be silently readable as a value. A furniture row that carries no rotation is refused rather than
    // published without the fact the rotation postcondition reads.
    isCurrentRotationFact(value.rotation) &&
    isRotationCycleFact(value.rotations) &&
    (value.kind !== "placed_furniture" || (value.rotation !== null && value.rotations !== null)) &&
    (value.kind === "placed_furniture" || (value.rotation === null && value.rotations === null))
  );
}
/** `Furniture.currentRotation`: one quarter-turn of the engine's own cycle, or the explicit `null`. */
function isCurrentRotationFact(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 3);
}
/** `Furniture.rotations`: how many quarter-turns the piece's own data allows (Data/Furniture's 0, 2 or 4). */
function isRotationCycleFact(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 4);
}
/** One posted help-wanted quest the actor can name: the opaque id it was published under, the native
 * quest type, and the title a human would recognize. */

/** One posted help-wanted quest the actor can name: the opaque id it was published under, the native
 * quest type, and the title a human would recognize. */
export function isDailyQuestTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "questType", "title"]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    typeof value.questType === "number" &&
    Number.isSafeInteger(value.questType) &&
    typeof value.title === "string"
  );
}

/** One offered special order: the opaque id it was published under, its `Data/SpecialOrders` key, its
 * board type (empty for the town board is legal), and the seed the pool generation chose for it. */

/** One offered special order: the opaque id it was published under, its `Data/SpecialOrders` key, its
 * board type (empty for the town board is legal), and the seed the pool generation chose for it. */
export function isSpecialOrderTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "questKey", "orderType", "generationSeed"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.questKey === "string" &&
    value.questKey.length > 0 &&
    typeof value.orderType === "string" &&
    typeof value.generationSeed === "number" &&
    Number.isSafeInteger(value.generationSeed)
  );
}

/** The museum's whole current reward set: the opaque id it was published under, the museum location, and
 * how many item rewards a claim would collect. */

/** The museum's whole current reward set: the opaque id it was published under, the museum location, and
 * how many item rewards a claim would collect. */
export function isMuseumRewardTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "rewardCount"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    typeof value.rewardCount === "number" &&
    Number.isSafeInteger(value.rewardCount) &&
    value.rewardCount > 0
  );
}

/** One placed chest the actor can repaint: the opaque id discovery published, its location and tile, and
 * the colour it currently carries (the field the write changes, so the caller can see whether a repaint
 * would move anything). */

/** One placed chest the actor can repaint: the opaque id discovery published, its location and tile, and
 * the colour it currently carries (the field the write changes, so the caller can see whether a repaint
 * would move anything). */
export function isColorTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "color"]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    typeof value.x === "number" &&
    Number.isSafeInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isSafeInteger(value.y) &&
    typeof value.color === "string" &&
    value.color.length > 0
  );
}

/**
 * One pending profession milestone the companion may be asked to choose: the `(skill, level)` pair, the two
 * candidate ids in the game's own card order (`branch_a` is the left card, `branch_b` the right) with the engine's
 * own title and description, and the level-5 profession a level-10 pair continues from. `previousProfession` is
 * ABSENT when the pair does not depend on an earlier choice - the Mod's serializer omits null members - so it is
 * optional here while its VALUE, when present, is still bounded.
 */
export function isLevelUpChoiceFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "skill",
      "level",
      "previousProfession",
      "leftId",
      "leftTitle",
      "leftDescription",
      "rightId",
      "rightTitle",
      "rightDescription",
    ]) &&
    isNonNegativeSafeInteger(value.skill) &&
    value.skill <= 5 &&
    isNonNegativeSafeInteger(value.level) &&
    value.level <= 10 &&
    (value.previousProfession === undefined || isNonNegativeSafeInteger(value.previousProfession)) &&
    isNonNegativeSafeInteger(value.leftId) &&
    isBoundedNonEmptyString(value.leftTitle, 128) &&
    isBoundedNonEmptyString(value.leftDescription, 512) &&
    isNonNegativeSafeInteger(value.rightId) &&
    isBoundedNonEmptyString(value.rightTitle, 128) &&
    isBoundedNonEmptyString(value.rightDescription, 512)
  );
}

/** One sewing-machine target: the pair of backpack slots and the item ids they hold, the kind of act
 * (`recipe` or `dye`), the qualified id the act produces, and - for a dye target - the garment's
 * CURRENT colour and name. `garmentColour` is the fact `dye_clothing_with_item`'s postcondition
 * changes, so a target whose identity ignored it could not be verified. */

/** One sewing-machine target: the pair of backpack slots and the item ids they hold, the kind of act
 * (`recipe` or `dye`), the qualified id the act produces, and - for a dye target - the garment's
 * CURRENT colour and name. `garmentColour` is the fact `dye_clothing_with_item`'s postcondition
 * changes, so a target whose identity ignored it could not be verified. */
export function isTailoringTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    // The two garment fields are OPTIONAL: the bridge omits null members, so a craft target carries neither, and
    // `hasExactKeys` would refuse a value with fewer keys than it lists (that refusal was the live failure).
    hasOnlyKeys(value, [
      "targetId",
      "kind",
      "leftSlot",
      "rightSlot",
      "leftQualifiedItemId",
      "rightQualifiedItemId",
      "outputQualifiedItemId",
      "garmentColour",
      "garmentName",
    ]) &&
    typeof value.targetId !== "undefined" &&
    typeof value.kind !== "undefined" &&
    typeof value.leftSlot !== "undefined" &&
    typeof value.rightSlot !== "undefined" &&
    typeof value.leftQualifiedItemId !== "undefined" &&
    typeof value.rightQualifiedItemId !== "undefined" &&
    typeof value.outputQualifiedItemId !== "undefined" &&
    isOpaqueId(value.targetId) &&
    (value.kind === "recipe" || value.kind === "dye") &&
    isNonNegativeSafeInteger(value.leftSlot) &&
    isNonNegativeSafeInteger(value.rightSlot) &&
    typeof value.leftQualifiedItemId === "string" &&
    value.leftQualifiedItemId.length > 0 &&
    typeof value.rightQualifiedItemId === "string" &&
    value.rightQualifiedItemId.length > 0 &&
    typeof value.outputQualifiedItemId === "string" &&
    value.outputQualifiedItemId.length > 0 &&
    (value.garmentColour === undefined || value.garmentColour === null || typeof value.garmentColour === "string") &&
    (value.garmentName === undefined || value.garmentName === null || typeof value.garmentName === "string")
  );
}

export function isFarmBuildingTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "kind",
      "location",
      "x",
      "y",
      "buildingType",
      "displayName",
      "buildCost",
      "buildDays",
      "buildingId",
      "daysOfConstructionLeft",
    ]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    (value.kind === "build_site" || value.kind === "built") &&
    typeof value.location === "string" &&
    typeof value.x === "number" &&
    Number.isSafeInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isSafeInteger(value.y) &&
    typeof value.buildingType === "string" &&
    value.buildingType.length > 0 &&
    typeof value.displayName === "string" &&
    typeof value.buildCost === "number" &&
    Number.isSafeInteger(value.buildCost) &&
    value.buildCost >= 0 &&
    typeof value.buildDays === "number" &&
    Number.isSafeInteger(value.buildDays) &&
    value.buildDays >= 0 &&
    typeof value.buildingId === "string" &&
    typeof value.daysOfConstructionLeft === "number" &&
    Number.isSafeInteger(value.daysOfConstructionLeft) &&
    value.daysOfConstructionLeft >= -1
  );
}

/** One building-declared chest. The counts are the live chest's own (`stackCount` slots, `itemCount`
 * items) and the branch is the native branch the chest's data declares; a Chest-type chest is never
 * published, so the union below is closed. */

/** One building-declared chest. The counts are the live chest's own (`stackCount` slots, `itemCount`
 * items) and the branch is the native branch the chest's data declares; a Chest-type chest is never
 * published, so the union below is closed. */
export function isBuildingChestTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    // hasOnlyKeys, not hasExactKeys: the three load-input hint fields are omitted entirely when
    // the actor holds nothing this chest accepts (the Mod's serializer omits nulls), exactly like
    // the optional members of `machineTargets`.
    hasOnlyKeys(value, [
      "targetId",
      "location",
      "x",
      "y",
      "buildingType",
      "chestId",
      "branch",
      "stackCount",
      "itemCount",
      "loadInputSlot",
      "loadInputQualifiedItemId",
      "loadInputStack",
    ]) &&
    typeof value.targetId === "string" &&
    /^building_chest_[a-f0-9]{16}$/u.test(value.targetId) &&
    isBoundedNonEmptyString(value.location, 256) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    isBoundedNonEmptyString(value.buildingType, 128) &&
    isBoundedNonEmptyString(value.chestId, 64) &&
    (value.branch === "load" || value.branch === "collect") &&
    isNonNegativeSafeInteger(value.stackCount) &&
    isNonNegativeSafeInteger(value.itemCount) &&
    (value.loadInputSlot === undefined || value.loadInputSlot === null || isToolSlot(value.loadInputSlot)) &&
    (value.loadInputQualifiedItemId === undefined ||
      value.loadInputQualifiedItemId === null ||
      isBoundedNonEmptyString(value.loadInputQualifiedItemId, 128)) &&
    (value.loadInputStack === undefined ||
      value.loadInputStack === null ||
      (Number.isSafeInteger(value.loadInputStack) && (value.loadInputStack as number) >= 1)) &&
    ((value.loadInputSlot === undefined &&
      value.loadInputQualifiedItemId === undefined &&
      value.loadInputStack === undefined) ||
      (isToolSlot(value.loadInputSlot) &&
        isBoundedNonEmptyString(value.loadInputQualifiedItemId, 128) &&
        Number.isSafeInteger(value.loadInputStack) &&
        (value.loadInputStack as number) >= 1))
  );
}

export function isObeliskTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "route", "location", "x", "y", "displayName", "destination", "forceDismount"]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    typeof value.route === "string" &&
    typeof value.location === "string" &&
    typeof value.x === "number" &&
    Number.isSafeInteger(value.x) &&
    typeof value.y === "number" &&
    Number.isSafeInteger(value.y) &&
    typeof value.displayName === "string" &&
    typeof value.destination === "string" &&
    typeof value.forceDismount === "boolean"
  );
}

export function isMineElevatorFloorFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "floor", "isCurrentFloor", "isMineEntrance"]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    typeof value.floor === "number" &&
    Number.isSafeInteger(value.floor) &&
    value.floor >= 0 &&
    value.floor <= 120 &&
    typeof value.isCurrentFloor === "boolean" &&
    typeof value.isMineEntrance === "boolean"
  );
}

export function isMinecartTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "networkId",
      "destinationId",
      "displayName",
      "price",
      "stationX",
      "stationY",
      "targetLocation",
      "targetTileX",
      "targetTileY",
    ]) &&
    typeof value.targetId === "string" &&
    /^minecart_[a-f0-9]{16}$/u.test(value.targetId) &&
    isBoundedNonEmptyString(value.networkId, 128) &&
    isBoundedNonEmptyString(value.destinationId, 128) &&
    isBoundedNonEmptyString(value.displayName, 128) &&
    typeof value.price === "number" &&
    Number.isSafeInteger(value.price) &&
    value.price >= 0 &&
    isTileCoordinate(value.stationX) &&
    isTileCoordinate(value.stationY) &&
    isBoundedNonEmptyString(value.targetLocation, 256) &&
    isTileCoordinate(value.targetTileX) &&
    isTileCoordinate(value.targetTileY)
  );
}

export function isInventoryItemFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "qualifiedItemId", "stack", "displayName"]) &&
    isToolSlot(value.slot) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    value.stack <= 999 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isFoodTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "qualifiedItemId", "stack", "edibility", "isDrink", "displayName"]) &&
    isToolSlot(value.slot) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    value.stack <= 999 &&
    typeof value.edibility === "number" &&
    Number.isSafeInteger(value.edibility) &&
    value.edibility >= -299 &&
    value.edibility <= 1000 &&
    typeof value.isDrink === "boolean" &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

export function hasExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

/**
 * The exact set, plus a named set of keys that may be present but need not be.
 *
 * A shape that grew one optional field used to force a choice between `hasExactKeys` (which refuses the new field) and
 * `keys.every(includes)` (which stops noticing any unexpected field at all). This keeps both properties: the required
 * set is exact, and the allowance is enumerated rather than implied.
 */
export function hasExactKeysOrOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * A qualified item id: the engine's bracketed type prefix, then the item's own id - `(O)433`, `(O)Carrot`,
 * `(BC)Dehydrator`, `(T)WateringCan`, `(TR)FrogEgg`.
 *
 * The engine concatenates exactly those two parts (`QualifiedItemId => TypeDefinitionId + ItemId`, Item.cs:187-197).
 * The prefix is whatever `IItemDataDefinition.Identifier` a type registers (ItemRegistry.cs:22-58 publishes `(O)`,
 * `(BC)`, `(B)`, `(F)`, `(FL)`, `(H)`, `(M)`, `(P)`, `(S)`, `(T)`, `(TR)`, `(W)`, `(WP)`; mods register their own),
 * so it is named here by its SHAPE and not by a copy of that list. The body is the item's `ItemId`, documented as
 * "alphanumeric, underscore, and dot characters" (Item.cs:161-166) and NOT restricted to digits: 1.6 ships letter
 * ids such as `(O)SeedSpot`, `(O)CarrotSeeds` and `(T)WateringCan`. A digits-only body refused those rows as
 * `invalid_snapshot`, and the bridge CLOSES on that verdict (local-stardew-bridge.ts:853), so the digits were the
 * one spelling the engine never promised. What this admits that names no item compares false against the LIVE
 * qualified id the Mod resolves and comes back as a refusal - the failure this pattern can afford; the one it
 * cannot afford is refusing a row the engine really published.
 */
export function isQualifiedItemId(value: unknown): value is string {
  return typeof value === "string" && /^\([^()\s]+\)[^()\s]+$/.test(value);
}

/**
 * How many items a machine row consumes: a positive count. The engine reads the same number off the trigger rule that
 * matched (`MachineOutputTriggerRule.RequiredCount`) and refuses the load when the carried stack is smaller than it
 * (MachineDataUtility.cs:90-95), so a zero or negative count is not a smaller load - it is not a load.
 */
export function isMachineInputCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 9999;
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 128);
}

/** `ride_minecart` args are exactly {x, y, expectedTargetId} with an opaque `minecart_` selector. */

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** C# attempt counters are Int32 wire fields; the Host must not admit Int64-backed counters it cannot exchange. */

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isTileCoordinate(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 1000;
}

export function isToolSlot(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 36;
}
