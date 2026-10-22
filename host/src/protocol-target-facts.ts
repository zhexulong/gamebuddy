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

export function isToolSlotFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "label", "upgradeLevel"]) &&
    isToolSlot(value.slot) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 128 &&
    // Optional because the Mod reports it only for tools that have an upgrade level; an absent value is
    // "this tool does not upgrade", never "unknown".
    (value.upgradeLevel === undefined ||
      (typeof value.upgradeLevel === "number" && Number.isInteger(value.upgradeLevel) && value.upgradeLevel >= 0))
  );
}

export function isForageTargetFact(value: unknown): boolean {
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

export function isCropTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "cropId", "displayName"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.cropId === "string" &&
    value.cropId.length > 0 &&
    value.cropId.length <= 128 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}

export function isHarvestTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "x",
      "y",
      "cropId",
      "qualifiedHarvestItemId",
      "displayName",
      "regrowsAfterHarvest",
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
    typeof value.regrowsAfterHarvest === "boolean"
  );
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
    typeof value.health === "number" &&
    Number.isSafeInteger(value.health) &&
    value.health === 1 &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
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
      "displayName",
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
      value.loadInputQualifiedItemId === "(O)433") &&
    (value.loadInputStack === undefined || value.loadInputStack === null || value.loadInputStack === 5) &&
    (value.collectOutputReady === undefined ||
      value.collectOutputReady === null ||
      typeof value.collectOutputReady === "boolean") &&
    ((value.loadInputSlot === undefined &&
      value.loadInputQualifiedItemId === undefined &&
      value.loadInputStack === undefined) ||
      (isToolSlot(value.loadInputSlot) && value.loadInputQualifiedItemId === "(O)433" && value.loadInputStack === 5)) &&
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
    value.health === 1 &&
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
    hasExactKeys(value, ["targetId", "location", "x", "y", "health"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.health === "number" &&
    Number.isSafeInteger(value.health) &&
    value.health >= 0 &&
    value.health <= 1000
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
    hasExactKeys(value, ["targetId", "location", "x", "y", "cropId", "qualifiedHarvestItemId", "displayName"]) &&
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
    value.displayName.length <= 128
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
    hasExactKeys(value, ["npcName", "displayName", "location", "x", "y", "inCurrentLocation"]) &&
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
 * crops; 1_000_000 is a generous but still finite ceiling), and the nearest
 * tile must be a real in-map coordinate.
 */

/**
 * One loaded location's ready-for-harvest crop summary. The count is bounded
 * to a safe non-negative integer (a full farm cannot exceed a few thousand
 * crops; 1_000_000 is a generous but still finite ceiling), and the nearest
 * tile must be a real in-map coordinate.
 */
export function isHarvestWhereaboutsFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["location", "readyForHarvestCount", "nearestX", "nearestY"]) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isNonNegativeSafeInteger(value.readyForHarvestCount) &&
    value.readyForHarvestCount <= 1_000_000 &&
    isTileCoordinate(value.nearestX) &&
    isTileCoordinate(value.nearestY)
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

export function isChestStoreTargetFact(value: unknown): boolean {
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

export function isChestRetrieveTargetFact(value: unknown): boolean {
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
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
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

/** The world-object lane's projection. Every member is always written (the Mod omits nulls,
 * which is why `kind`, `slot`, `qualifiedItemId` and `displayName` are required here), and a
 * missing or malformed array must fail closed rather than read as a transport fault. */
export function isWorldObjectTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "kind", "location", "x", "y", "slot", "qualifiedItemId", "displayName"]) &&
    typeof value.targetId === "string" &&
    isOpaqueId(value.targetId) &&
    (value.kind === "placement_candidate" ||
      value.kind === "removable_object" ||
      value.kind === "non_removable_object" ||
      value.kind === "breakable_container") &&
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
    typeof value.displayName === "string"
  );
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

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
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
