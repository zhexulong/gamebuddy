import { randomUUID } from "node:crypto";

import {
  hasExactKeys,
  hasOnlyKeys,
  isAnimalDoorTargetFact,
  isAnimalProductTargetFact,
  isArtifactSpotResultTargetFact,
  isArtifactSpotTargetFact,
  isBaitCrabPotTargetFact,
  isBoundedNonEmptyString,
  isBuildingChestTargetFact,
  isBushTargetFact,
  isCaskTargetFact,
  isChestRetrieveTargetFact,
  isChestStoreTargetFact,
  isClearHoeDirtTargetFact,
  isColorTargetFact,
  isCookingStationTargetFact,
  isCrabPotCollectTargetFact,
  isCrabPotResultTargetFact,
  isCrabPotTargetFact,
  isCropTargetFact,
  isDailyQuestTargetFact,
  isDebrisTargetFact,
  isFacilityTargetFact,
  isFarmBuildingTargetFact,
  isFeedTroughTargetFact,
  isFenceGateTargetFact,
  isFiniteNumber,
  isFishPondTargetFact,
  isFoodTargetFact,
  isForageTargetFact,
  isGrassTargetFact,
  isHarvestTargetFact,
  isHarvestWhereaboutsFact,
  isHorseTargetFact,
  isInventoryItemFact,
  isItemTargetFact,
  isLanternSlotFact,
  isMachineTargetFact,
  isMailboxTargetFact,
  isMineElevatorFloorFact,
  isMineEntranceTargetFact,
  isMinecartTargetFact,
  isMuseumRewardTargetFact,
  isNonNegativeSafeInteger,
  isNpcRelationshipTargetFact,
  isObeliskTargetFact,
  isOpaqueId,
  isPanSiteFact,
  isPedestalTargetFact,
  isPetBowlTargetFact,
  isPetTargetFact,
  isRaftTargetFact,
  isRecipeTargetFact,
  isRecord,
  isRefillWateringCanTargetFact,
  isRockSourceTargetFact,
  isScytheCropTargetFact,
  isSeedTargetFact,
  isShippingBinTargetFact,
  isShopTargetFact,
  isSignTargetFact,
  isSiloTargetFact,
  isSlimeHutchTroughTargetFact,
  isSpecialOrderTargetFact,
  isStringArray,
  isTailoringTargetFact,
  isTileCoordinate,
  isToolSlot,
  isToolSlotFact,
  isTreeChopResultTargetFact,
  isTreeChopSourceTargetFact,
  isTreeSaplingTargetFact,
  isTreeStumpTargetFact,
  isVillagerWhereaboutsFact,
  isWarpItemTargetFact,
  isWateringCanFact,
  isWearableTargetFact,
  isWeedTargetFact,
  isWoodFenceResultTargetFact,
  isWoodFenceTargetFact,
  isWorldObjectTargetFact,
} from "./protocol-target-facts.js";

const PROTOCOL_VERSION = 1;
// Mirrors BridgeProtocol.MaximumMessageBytes (C#): hello_ack carries the
// complete published action catalog, so the frame bound must admit the full
// publication plus growth.
//
// RAISED 2026-10-07 from 32 KiB, which the catalog had outgrown: it crossed the
// old bound at 70 registered actions and every live gate began failing with
// message_too_large, because every runner's first call is hello. The previous
// justification (~16.7 KiB at 34 actions) recorded the surface as it stood, not a
// bound derived from one; the catalog costs ~365 bytes per action. Both sides of
// the pipe MUST move together, or one end will reject what the other accepts.
//
// Not a security boundary — the frame travels over a local, authenticated,
// owner-scoped named pipe. Its job is to bound one allocation per frame.
export const MAX_MESSAGE_BYTES = 128 * 1024;
/** World-fact JSON is bounded below the frame limit so conversion never accepts an unbounded raw blob. */
export const MAX_WORLD_FACT_PAYLOAD_JSON_BYTES = 8 * 1024;
export const MAX_EVENTS_PER_WINDOW = 32;
export const EVENT_WINDOW_MS = 1_000;

export type Scope = Readonly<{
  integrationId: string;
  saveId: string;
  worldId: string;
  playerId: string;
  companionId: string;
}>;

export type BodyCanonicalValue = Readonly<
  | { type: "integer" | "string" | "boolean"; canonicalValue: string }
  | {
      type: "destination_selector";
      destination: Readonly<{ kind: "label"; label: string } | { kind: "ref"; ref: string }>;
    }
>;
export type FarmhandPolicyIdentity = Readonly<{ value: string; capabilityRevision: number }>;
export type BodyPolicyIdentity = Readonly<{ value: string; capabilityRevision: number }>;
export type BodyExecutionBinding = Readonly<{
  programId: string;
  nodeId: string;
  nodeAttempt: number;
  requestId: string;
  idempotencyKey: string;
  executionId: string;
}>;
export type BodyNodeAdmissionChallenge = Readonly<{
  programId: string;
  nodeId: string;
  nodeAttempt: number;
  admissionAttempt: number;
  stopEpoch: number;
  catalogRevision: number;
  policyIdentity: BodyPolicyIdentity;
  actionId: string;
  canonicalBoundArgs: Readonly<Record<string, BodyCanonicalValue>>;
  derivedResourceClaims: Readonly<Record<string, string>>;
  deadlineMs: number;
}>;
export type BodyNodeAdmissionGrant = BodyNodeAdmissionChallenge &
  Readonly<{
    grantId: string;
    attachmentGeneration: string;
    policyRevision: string;
    executionBinding: BodyExecutionBinding | null;
  }>;
export type BodyNodeAdmissionResult =
  | (BodyNodeAdmissionGrant & Readonly<{ result: "granted" }>)
  | (BodyNodeAdmissionChallenge & Readonly<{ result: "rejected"; code: string }>)
  | (BodyNodeAdmissionChallenge & Readonly<{ result: "unavailable"; code: "admission_unavailable" }>);

export type BodyNodeAdmissionChallengeHandler = (
  challenge: BodyNodeAdmissionChallenge,
) => Promise<BodyNodeAdmissionResult> | BodyNodeAdmissionResult;

export type Envelope<TType extends string, TPayload> = Readonly<{
  protocolVersion: number;
  messageId: string;
  correlationId: string;
  timestampMs: number;
  scope: Scope;
  type: TType;
  payload: TPayload;
}>;

export const EXECUTION_STATES = [
  "accepted",
  "running",
  "meaningful_progress",
  "blocked",
  "invalidated",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "rejected",
  "uncertain",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export type FactKind = "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle" | "world_fact";

type ActiveExecution = Readonly<{
  executionId: string;
  requestId: string;
  action: string;
  state: ExecutionState;
  reasonCode: string;
  evidence: Readonly<Record<string, unknown>> | null;
  /** Who owns the body, when the Mod names it; present only during an in-flight execution. */
  ownerKind?: string;
  /** Whether a new command can take that owner over. */
  interruptible?: boolean;
  /**
   * The holder's PHASE, when the Mod names it: `approaching` while the actor is still walking to the target,
   * `committed` once the native call has taken over. Cancel safety is a property of this phase rather than of an
   * action id - an approach leg is held in the same KIND as `move_to_tile` and can be braked, a committed step can
   * only exit through its terminal receipt.
   */
  phase?: string;
  /** Whether this hold can still be released. Derived by the Mod from the phase, so it cannot disagree with it. */
  cancelSafe?: boolean;
}>;

export type Snapshot = Readonly<{
  revision: number;
  location: string;
  tile: Readonly<{ x: number; y: number }>;
  stamina: number;
  health: number;
  actionable: boolean;
  capabilities: readonly string[];
  catalogRevision: number;
  enabledActionIds: readonly string[];
  /** Older Mod snapshots may omit fields added after the initial bridge contract. */
  currentTool?: string | null;
  inventorySlots?: number;
  /**
   * The persistent native exhaustion flag. While set, Farmer's day-update
   * restores only half of MaxStamina the next morning, so this is the agent's
   * own accrued consequence, not a transient read. Required on every Mod snapshot:
   * while it was optional an absent field was indistinguishable from a real false,
   * so the projection reported "not exhausted" to the Agent for a Mod that simply
   * did not send it. The world-not-ready snapshot sends false.
   */
  exhausted: boolean;
  /** The World Model’s disposition for this snapshot’s tick: which of idle / modal / event / pass_out /
   * transient holds the body. `actorDispositionDetail` names the modal class or transient kind when the kind
   * carries one. Published so a planner can see WHAT is holding the actor, not only that it is held. */
  actorDispositionKind?: string;
  actorDispositionDetail?: string | null;
  actorDispositionActionOwned?: boolean;
  activeExecution?: ActiveExecution | null;
  /** Exact current Mod BCP-47 presentation locale; required on every Mod snapshot. */
  presentationLocale: string;
  /**
   * Macro time context, read straight from the game clock and calendar.
   *
   * Native behaviour is time-driven: a Pet sleeps from 20:00, villagers follow
   * schedules, shops open and close, crops advance. The snapshot previously
   * published no time at all, so the companion could not reason about any of it
   * -- including that the animal it was trying to reach was about to settle for
   * the night. These are the same values the native code reads, published
   * without interpretation: no derived phase such as "morning", no advice about
   * what the hour implies. Zero when the world is not ready.
   */
  timeOfDay: number;
  dayOfMonth: number;
  seasonIndex: number;
  year: number;
  /**
   * Native weather flags projected to one stable token ("sunny" | "rain" |
   * "snow" | "lightning" | "debris" | "unknown"). Same macro-context rule as
   * the date fields: plain reads of Game1 state, no interpretation.
   */
  weather: string;
  /** Live native warp targets; older Mod snapshots may omit this field. */
  warps?: readonly Readonly<{
    sourceX: number;
    sourceY: number;
    targetLocation: string;
    targetX: number;
    targetY: number;
    /**
     * Whether this exit's target location passes the engine's own accessibility gate
     * (`Game1.isLocationAccessible`). The Mod omits a null member, so ABSENT means the leg
     * was not measured and must never be read as `false`.
     */
    accessible?: boolean | null;
  }>[];
  /** Current live native door/entrance targets. */
  doorTargets?: readonly Readonly<{
    sourceX: number;
    sourceY: number;
    targetLocation: string;
    targetX: number;
    targetY: number;
  }>[];
  /** Current live tiles that the target-version Hoe can potentially till. */
  soilTiles?: readonly Readonly<{ x: number; y: number }>[];
  /** Current Farmhand inventory Tool slots, with bounded labels only. */
  toolSlots?: readonly Readonly<{ slot: number; label: string }>[];
  /** Nearby native forage objects available through GameLocation.checkAction. */
  forageTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
  }>[];
  /** Nearby native item drops available through Debris.collect. */
  itemTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
  }>[];
  /** Exact live Watering Can facts for a bounded refill request. */
  wateringCanFacts?: readonly Readonly<{
    slot: number;
    qualifiedItemId: string;
    displayName: string;
    label: string;
    water: number;
    max: number;
  }>[];
  /** Adjacent legal native Watering Can refill sources. */
  refillWateringCanTargets?: readonly Readonly<{ targetId: string; x: number; y: number }>[];
  /** Nearby unwatered crops available through the native WateringCan path. */
  cropTargets?: readonly Readonly<{ targetId: string; x: number; y: number; cropId: string; displayName: string }>[];
  /** The current location's completed, unwatered native Pet Bowl (water_pet_bowl). */
  petBowlTargets?: readonly Readonly<{ targetId: string; x: number; y: number }>[];
  /** The current Slime Hutch's unwatered trough tiles (water_slime_hutch_trough). */
  slimeHutchTroughTargets?: readonly Readonly<{ targetId: string; x: number; y: number }>[];
  /** Current location's live, in-bloom berry bushes available to native shake. */
  bushTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number }>[];
  fruitTreeTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number }>[];
  shakeTreeTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number }>[];
  pedestalTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    stack: number;
  }>[];
  fenceGateTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number; isOpen: boolean }>[];
  /** Nearby ready, ordinary Grab crops available through native Crop.harvest. */
  harvestTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    cropId: string;
    qualifiedHarvestItemId: string;
    displayName: string;
    regrowsAfterHarvest: boolean;
  }>[];
  /** Nearby empty HoeDirt targets paired with a live inventory seed slot. */
  seedTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
  }>[];
  /** Nearby ground HoeDirt targets paired with a live fertilizer slot. */
  fertilizerTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
  }>[];
  /** Fresh empty Farm tiles paired with one qualified (O)322 inventory slot. */
  woodFenceTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)322";
    displayName: string;
  }>[];
  /** Same-location native non-gate Fence result published only after placement. */
  woodFenceResultTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)322";
    displayName: string;
    isFence: true;
    isGate: false;
    health: number;
    maxHealth: number;
  }>[];
  /** Fresh valid Farm water tiles paired with one qualified (O)710 inventory slot. */
  crabPotTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)710";
    displayName: string;
  }>[];
  /** Same-location native Crab Pot result published only after placement. */
  crabPotResultTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)710";
    displayName: string;
    ownerId: number;
    offsetX: number;
    offsetY: number;
    overlayTiles: readonly { x: number; y: number; count: number }[];
  }>[];
  /** Live mature (714) current-player-owned Crab Pots whose output may be collected (collect_crab_pot_output). */
  crabPotCollectTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    qualifiedItemId: "(O)710";
    displayName: string;
    outputQualifiedItemId: string;
    outputStack: number;
  }>[];
  /** Current-player-owned unbaited (O)710 Crab Pots paired with one owned (O)685 Bait source. */
  baitCrabPotTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)710";
    displayName: string;
    baitQualifiedItemId: "(O)685";
    /** Decimal-string because Stardew multiplayer IDs may exceed JSON safe-integer range. */
    ownerId: string;
    baitStack: number;
  }>[];
  /** Same-pot native bait result published only after a successful (O)685 attachment. */
  baitCrabPotResultTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)710";
    displayName: string;
    baitQualifiedItemId: "(O)685";
    /** Decimal-string because Stardew multiplayer IDs may exceed JSON safe-integer range. */
    ownerId: string;
    baitStack: number;
  }>[];
  /** Nearby native ResourceClump targets paired with a usable tool slot. */
  debrisTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    parentSheetIndex: number;
    toolKind: string;
    requiredUpgradeLevel: number;
    health: number;
  }>[];
  /** Nearby one-hit ordinary breakable stone sources for the bounded native Pickaxe path. */
  rockSourceTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    health: number;
  }>[];
  /** Adjacent live empty ground HoeDirt targets for one Basic Pickaxe clear. */
  clearHoeDirtTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    crop: false;
    ground: true;
  }>[];
  /**
   * Adjacent intact diggable artifact spots for one native Basic Hoe use. The id
   * stays an opaque bounded token: `(O)590` and `(O)SeedSpot` reach the identical
   * `t is Hoe` branch (`Object.cs:1310`) and every spawn site picks between them
   * (`GameLocation.cs:15233`, `Mountain.cs:272`), so the native predicate is the
   * authority rather than any one id.
   */
  artifactSpotTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
  }>[];
  /** Same-location plain ground HoeDirt created by dig_artifact_spot, published only after that action. */
  artifactSpotResultTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    crop: false;
    ground: true;
  }>[];
  /** Global Farm source count, published only while dig_artifact_spot is capable. */
  artifactSpotFarmSourceCount?: number | null;
  /** Ordinary mature untapped non-moss trees at native terminal-fell starting health 1. */
  treeChopSourceTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    treeType: string;
    growthStage: number;
    health: number;
    stump: false;
    moss: false;
    tapped: false;
  }>[];
  /** Same-location native stump results after a terminal chop-tree-source strike. */
  treeChopResultTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    treeType: string;
    health: number;
    stump: true;
    moss: false;
    tapped: false;
  }>[];
  /** Nearby TerrainFeature Tree stumps (stump.Value == true) chippable by chop_stump; ResourceClumps stay in debrisTargets. */
  treeStumpTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    treeType: string;
    health: number;
  }>[];
  /** Nearby open plantable tiles paired with an owned wild-tree sapling slot (plant_sapling). */
  treeSaplingTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
  }>[];
  /** Nearby Weed objects cuttable by an equipped scythe (cut_weeds). */
  weedTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number; health: number }>[];
  /** Nearby Grass tufts (TerrainFeature) cuttable by an equipped scythe (cut_grass); grassType 1/7 drops Hay into a silo, 6 drops rare items. */
  grassTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    grassType: number;
    numberOfWeeds: number;
  }>[];
  /** Nearby live Casks available to clear_cask. */
  caskTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    hasHeldObject: boolean;
    heldQualifiedItemId: string | null;
  }>[];
  mannequinTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number }>[];
  signTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    hasDisplayItem: boolean;
    displayQualifiedItemId: string | null;
  }>[];
  siloTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number; hay: number }>[];
  lanternSlots?: readonly Readonly<{ slot: number; isOn: boolean; fuelLeft: number }>[];
  /** Nearby ready Scythe-method crops harvestable by an equipped scythe (scythe_crop). */
  scytheCropTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    cropId: string;
    qualifiedHarvestItemId: string;
    displayName: string;
  }>[];
  /** Nearby native machines; an idle Keg may expose the one exact Coffee Bean input slot accepted by machine_load, and a ready Coffee result may expose collection eligibility. */
  machineTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    readyForHarvest: boolean;
    minutesUntilReady: number;
    heldObjectQualifiedItemId?: string | null;
    lastInputQualifiedItemId?: string | null;
    loadInputSlot?: number | null;
    loadInputQualifiedItemId?: "(O)433" | null;
    loadInputStack?: 5 | null;
    collectOutputReady?: boolean | null;
  }>[];
  /** Nearby live NPCs with an existing Farmhand friendship record; inspection is read-only. */
  npcRelationshipTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    npcName: string;
    friendshipPoints: number;
    friendshipStatus: string;
    talkedToToday: boolean;
    giftsToday: number;
    giftsThisWeek: number;
  }>[];
  /**
   * Where every instantiated villager currently is, across the loaded world.
   * The per-location target arrays only describe the current map, so this is the
   * only fact that tells the Agent a villager is elsewhere instead of making it
   * search map by map.
   */
  villagerWhereabouts?: readonly Readonly<{
    npcName: string;
    displayName: string;
    location: string;
    x: number;
    y: number;
    inCurrentLocation: boolean;
  }>[];
  /**
   * Every loaded location's ready-for-harvest crop summary, across the loaded
   * world. The per-location harvestTargets array is Chebyshev-bounded to the
   * player's neighbourhood, so this is the only planning fact that tells the
   * Agent a ripe crop exists elsewhere — same role as villagerWhereabouts. The
   * nearest tile lets the Agent route to the location before the bounded
   * discovery takes over.
   */
  harvestWhereabouts?: readonly Readonly<{
    location: string;
    readyForHarvestCount: number;
    nearestX: number;
    nearestY: number;
  }>[];
  /** Nearby native pets that have not been petted today. */
  petTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    petType: string;
    friendship: number;
    pettedToday: boolean;
    /**
     * The pet's native `WalkInDirection` for its current behaviour, negated.
     *
     * A Pet moves only in behaviours whose `WalkInDirection` is true (Walk,
     * Sprint, LeapJump); in the others (SitDown, SitSide, Flop) it holds still
     * for a while. That makes this the fact that answers "can I reach it right
     * now": a wandering pet will not be where it was when you observed it, and
     * the native interaction needs it to still be within one tile at the moment
     * of dispatch. Publishing the native flag rather than a phase name keeps the
     * Mod a projector -- adding idle/wandering/resting would be an interpretation
     * the game does not make and that this repo would then have to keep aligned
     * with Data/Pets across versions.
     */
    stationary: boolean;
  }>[];
  /** Nearby adult farm animals with a specific native MilkPail/Shears target and capacity for their current produce. */
  animalProductTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    animalType: string;
    qualifiedProduceItemId: string;
    displayName: string;
    toolKind: "milk_pail" | "shears";
    produceStack: number;
  }>[];
  /** Nearby empty native AnimalHouse Trough tiles paired with an owned Hay slot. Placement does not prove an animal has eaten. */
  feedTroughTargets?: readonly Readonly<{ targetId: string; slot: number; x: number; y: number; hayStack: number }>[];
  /** Nearby player-owned ordinary Chests with a storable item in the Farmhand inventory (chest_store). */
  chestStoreTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    slot: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
  }>[];
  /** Nearby player-owned ordinary Chests holding an item retrievable into the Farmhand inventory (chest_retrieve). */
  chestRetrieveTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
  }>[];
  /** Bounded live inventory facts, currently published only for animal-product output rereads. */
  inventoryItemFacts?: readonly Readonly<{
    slot: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
  }>[];
  /** Owned, ordinary edible inventory items available through the native eat path. */
  foodTargets?: readonly Readonly<{
    slot: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
    edibility: number;
    isDrink: boolean;
  }>[];
  /** The current Farm's single native Shipping Bin paired with one shippable inventory slot (ship_item). */
  shippingBinTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    slot: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
  }>[];
  /** Learned crafting recipes, each under the exact expectedTargetId craft_item accepts. */
  craftingRecipeTargets?: readonly Readonly<{ targetId: string; displayName: string; ingredientsAvailable: boolean }>[];
  /** Learned cooking recipes, each under the exact expectedTargetId cook_recipe accepts. */
  cookingRecipeTargets?: readonly Readonly<{ targetId: string; displayName: string; ingredientsAvailable: boolean }>[];
  /** Live cooking stations (vanilla kitchen action tile or a placed (BC)278 cookout kit) on the current map. */
  cookingStationTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    stationKind: "kitchen" | "cookout_kit";
  }>[];
  /** Available native minecart rides from a station on the current map, as
   * advertised for the `ride_minecart` action. */
  /** Floors the mine elevator offers right now. The Mod derives them from the live
   * lowest level reached; a floor outside this list is refused on the game thread. */
  /** Shops whose owner is eligible AND standing in the actor's current location. The
   * owner tile is published so the Agent can walk into reach itself; this action
   * deliberately does not path. */
  shopTargets?: readonly Readonly<{
    targetId: string;
    shopId: string;
    ownerName: string;
    location: string;
    ownerTileX: number;
    ownerTileY: number;
    ownerInReach: boolean;
    stockCount: number;
    /** What the shop can sell right now, so callers do not have to guess an id. */
    stockItemIds: readonly string[];
  }>[];
  mineElevatorFloorTargets?: readonly Readonly<{
    targetId: string;
    floor: number;
    isCurrentFloor: boolean;
    isMineEntrance: boolean;
  }>[];
  minecartTargets?: readonly Readonly<{
    targetId: string;
    networkId: string;
    destinationId: string;
    displayName: string;
    price: number;
    stationX: number;
    stationY: number;
    targetLocation: string;
    targetTileX: number;
    targetTileY: number;
  }>[];
  /** Adjacent native water tiles where the equipped Raft can be launched. */
  raftTargets?: readonly Readonly<{ targetId: string; x: number; y: number }>[];
  horseTargets?: readonly Readonly<{ targetId: string; x: number; y: number; name: string }>[];
  mineEntranceTargets?: readonly Readonly<{ targetId: string; x: number; y: number }>[];
  /** Warp obelisks the actor can reach. `route` names which native path reaches it (a
   * Data/Buildings obelisk building, or the island farm obelisk tile) and the opaque id
   * carries it, so an island-tile target can never be replayed against a building. */
  /** A building's animal door. `isOpen` is published because the action's postcondition is that the
   * state FLIPPED, and a target whose identity ignores its state cannot be verified. */
  animalDoorTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    buildingType: string;
    isOpen: boolean;
  }>[];

  /** Built fish ponds that currently HOLD fish. `occupants` is how many fish the action would eject
   * and `fishType` is what they are, because the fish land on the ground for the Agent to collect - a
   * count alone does not say whether they are what the errand wanted. An empty pond is never published,
   * since it has nothing to clear. */
  fishPondTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    buildingType: string;
    occupants: number;
    fishType: string;
  }>[];

  /** One object the world-object lane can act on at a world tile, plus the backpack slot that
   * acts. `kind` is what the live object IS for this lane ('placement_candidate',
   * 'removable_object', 'non_removable_object', 'breakable_container'); `slot` is the backpack
   * slot the named action must act through, or -1 when the actor owns no tool for it. */
  worldObjectTargets?: readonly Readonly<{
    targetId: string;
    kind: string;
    location: string;
    x: number;
    y: number;
    slot: number;
    qualifiedItemId: string;
    displayName: string;
  }>[];
  /** One farm-building fact the build_farm_building caller can name. `kind` is what the fact IS
   * for this lane: 'build_site' is a free footprint the named building type could go on now (the
   * structure does not exist yet, so `buildingId` is the literal 'none' and `daysOfConstructionLeft`
   * is -1), and 'built' is a building already standing in the current location, carrying its durable
   * id and construction days. `buildCost` and `buildDays` are the type's own Data/Buildings facts -
   * what the commission charges and how long it takes. */
  farmBuildingTargets?: readonly Readonly<{
    targetId: string;
    kind: string;
    location: string;
    x: number;
    y: number;
    buildingType: string;
    displayName: string;
    buildCost: number;
    buildDays: number;
    buildingId: string;
    daysOfConstructionLeft: number;
  }>[];
  /** The day's posted help-wanted quests the actor can name, and whether today's has already been
   * accepted. `acceptedDailyQuest` is the world flag the accept turns true, so a quest is never
   * offered twice; `questType` is the native `Quest.questType`. */
  dailyQuestTargets?: readonly Readonly<{ targetId: string; questType: number; title: string }>[];
  acceptedDailyQuest?: boolean;
  specialOrderTargets?: readonly Readonly<{
    targetId: string;
    questKey: string;
    orderType: string;
    generationSeed: number;
  }>[];
  activeSpecialOrderKeys?: readonly string[];
  museumRewardTargets?: readonly Readonly<{ targetId: string; location: string; rewardCount: number }>[];
  /** The sewing-machine targets this actor can act on right now: the pair of backpack slots and the
   * item ids they hold, the kind of act (`recipe` or `dye`), the qualified id the act produces, and -
   * for a dye target - the garment's CURRENT colour and name. `garmentColour` is the fact
   * `dye_clothing_with_item` changes, and this projection is the only read of it. */
  /** One placed chest the actor can repaint right now, with the colour it already carries. Published only
   * while `color_placed_object` is advertised. */
  colorTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number; color: string }>[];
  tailoringTargets?: readonly Readonly<{
    targetId: string;
    kind: string;
    leftSlot: number;
    rightSlot: number;
    leftQualifiedItemId: string;
    rightQualifiedItemId: string;
    outputQualifiedItemId: string;
    garmentColour: string | null;
    garmentName: string | null;
  }>[];
  /** One body slot's occupant, if any. `bodySlot` is the slot a request names; the occupant fields
   * say what is really there, which is what makes a stale request detectable and what an unequip moves. */
  wearableTargets?: readonly Readonly<{
    targetId: string;
    bodySlot: string;
    occupantQualifiedItemId: string | null;
    occupantDisplayName: string | null;
  }>[];
  /** A held warp totem and the destination the totem ITSELF names. */
  warpItemTargets?: readonly Readonly<{
    slot: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
    destination: string;
    destinationX: number;
    destinationY: number;
  }>[];
  /** The location's live ore-pan point; the game owns at most one per location. */
  panSites?: readonly Readonly<{ x: number; y: number }>[];
  /** One mailbox tile, with the number of letters waiting. */
  mailboxTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    pendingCount: number;
  }>[];
  /** A building's own declared chest (Data/Buildings -> BuildingData.Chests). `branch` is the native
   * branch the chest takes (`load` or `collect`; the Chest type is never published, because it can
   * only open a container menu) and `stackCount`/`itemCount` are the LIVE chest's own counts:
   * collect auto-collects exactly one stack and load moves whole `RequiredCount` quanta, so a target
   * whose identity ignored them could not be used to decide whether a call can succeed. */
  buildingChestTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    buildingType: string;
    chestId: string;
    branch: "load" | "collect";
    stackCount: number;
    itemCount: number;
    loadInputSlot?: number;
    loadInputQualifiedItemId?: string;
    loadInputStack?: number;
  }>[];
  obeliskTargets?: readonly Readonly<{
    targetId: string;
    route: string;
    location: string;
    x: number;
    y: number;
    displayName: string;
    destination: string;
    forceDismount: boolean;
  }>[];
}>;

/** Mod-local player policy is summarized as live capabilities, not bearer tokens. */
export type ExecutionRequest = Readonly<{
  requestId: string;
  idempotencyKey: string;
  action:
    | "move_to_tile"
    | "navigate_to_destination"
    | "equip_tool"
    | "travel"
    | "shop_purchase"
    | "ride_minecart"
    | "select_mine_elevator_floor"
    | "ride_bus"
    | "withdraw_silo_hay"
    | "place_owned_object"
    | "remove_placed_item"
    | "break_container_source"
    | "use_obelisk"
    | "toggle_animal_door"
    | "clear_fish_pond"
    | "accept_daily_quest"
    | "accept_special_order"
    | "claim_museum_reward"
    | "build_farm_building"
    | "redeem_prize_ticket"
    | "tailor_clothing"
    | "dye_clothing_with_item"
    | "color_placed_object"
    | "send_multiplayer_chat"
    | "name_entity"
    | "use_warp_item"
    | "pan_ore"
    | "claim_mail_attachment"
    | "load_building_chest"
    | "collect_building_chest_output"
    | "use_raft"
    | "mount_transport"
    | "enter_mine"
    | "enter_exit"
    | "till_soil"
    | "pickup_forage"
    | "pickup_item"
    | "water_crop"
    | "refill_watering_can"
    | "harvest_crop"
    | "plant_seed"
    | "fertilize_tile"
    | "place_wood_fence"
    | "place_crab_pot"
    | "bait_crab_pot"
    | "clear_debris"
    | "machine_inspect"
    | "machine_load"
    | "machine_collect_output"
    | "npc_relationship"
    | "talk_to_npc"
    | "equip_wearable"
    | "unequip_wearable"
    | "dismount_transport"
    | "pet_animal"
    | "collect_animal_product"
    | "feed_animal"
    | "use_item"
    | "chop_tree_source"
    | "break_rock_source"
    | "clear_hoedirt"
    | "dig_artifact_spot"
    | "express_emote"
    | "face_direction"
    | "chest_store"
    | "chest_retrieve"
    | "chop_stump"
    | "plant_sapling"
    | "cut_weeds"
    | "cut_grass"
    | "clear_cask"
    | "dress_mannequin"
    | "set_sign_display"
    | "deposit_silo_hay"
    | "toggle_tool_light"
    | "scythe_crop"
    | "interact_npc_with_item"
    | "craft_item"
    | "cook_recipe"
    | "collect_crab_pot_output"
    | "ship_item"
    | "water_pet_bowl"
    | "dismiss_modal"
    | "answer_dialogue"
    | "respond_level_up"
    | "water_slime_hutch_trough"
    | "harvest_bush"
    | "harvest_fruit_tree"
    | "shake_tree"
    | "take_pedestal_item"
    | "toggle_fence_gate"
    // The cross-day lifecycle. It carries no arguments: its target is the
    // actor's own bed and its readiness is native state.
    | "advance_day";
  args: Readonly<Record<string, unknown>>;
  expectedRevision: number;
  deadlineMs: number;
}>;

/** Read-only exact recovery identity for a dispatch which may have lost its first receipt. */
export type ExecutionReceiptQuery = Readonly<{
  requestId: string;
  idempotencyKey: string;
}>;

type NavigationSelector = Readonly<{
  kind: "label" | "ref";
  label: string | null;
  ref: string | null;
}>;

export type NavigationReadRequest =
  | Readonly<{ operation: "inspect_world_map"; args: Readonly<Record<string, never>> }>
  | Readonly<{ operation: "inspect_world_map"; args: Readonly<{ nodeRef: string }> }>
  | Readonly<{ operation: "inspect_world_map"; args: Readonly<{ cursor: string }> }>
  | Readonly<{ operation: "find_destination"; args: Readonly<{ query: string }> }>;

/** Typed, read-only scene observation request. The Mod applies the default radius when omitted. */
export type ObserveSceneRequest = Readonly<{ radius?: number }>;

export type ObserveSceneAffordance = Readonly<{
  ref: string;
  kind:
    | "npc"
    | "chest"
    | "crop"
    | "tree"
    | "animal"
    | "forage"
    | "door"
    | "machine"
    | "water_source"
    | "weed"
    | "stone"
    | "debris"
    | "artifact_spot";
  name: string;
  distance: number;
  direction: "North" | "South" | "East" | "West" | "CurrentTile";
  actionHint: string | null;
  /**
   * Whether the actor can act on this target from where it stands (walk onto the tile or stand beside it).
   * ABSENT means undecided — nobody measured it — which is deliberately NOT `false`: "we could not check" is not
   * "you cannot go there". Published so the Agent stops learning reachability from refusals.
   */
  reachable?: boolean;
}>;

/** Bounded, factual scene projection. Scene refs are opaque observation labels, not mutation authority. */
export type ObserveSceneResult = Readonly<{
  /** Fresh identity for this scene; refs are valid only within this observation. */
  observationId: string;
  currentLocation: string;
  currentRegion: string;
  affordances: readonly ObserveSceneAffordance[];
  summary: string;
  partial: boolean;
  truncatedReason: "maximum_affordances" | "payload_limit" | "ground_limit" | null;
  /**
   * Ground underfoot, read from the map's Back-layer `Type` property. Present only
   * when the Mod scanned tiles; `null` means "not reported", not "no ground".
   */
  ground: ObserveSceneGround | null;
}>;

/** One tile that differs from the dominant ground kind. */
export type ObserveSceneGroundTile = Readonly<{
  tileX: number;
  tileY: number;
  kind: SceneGroundKind;
}>;

/**
 * Back-layer surface of a tile. The engine reads the same property for footstep
 * sounds and pathfinding weights, so this is a native fact rather than an
 * inferred label. `other` is the engine's own fallback for unnamed surfaces.
 */
export type SceneGroundKind = "grass" | "dirt" | "stone" | "wood" | "other";

/**
 * Dominant ground plus only the tiles that deviate from it, so a uniform meadow
 * costs one entry instead of restating every scanned tile.
 */
export type ObserveSceneGround = Readonly<{
  dominantKind: SceneGroundKind;
  dominantTileCount: number;
  scannedTileCount: number;
  exceptions: readonly ObserveSceneGroundTile[];
  omittedExceptionTileCount: number;
}>;

type NavigationWorldMapEntry = Readonly<{
  label: string;
  contextLabel: string | null;
  nodeRef: string | null;
  destination: NavigationSelector | null;
}>;

type NavigationSearchCandidate = Readonly<{
  label: string;
  contextLabel: string | null;
  destination: NavigationSelector;
  unlockState: "unknown";
}>;

export type NavigationReadResult =
  | Readonly<{
      status: "succeeded";
      reason: "world_map_observed";
      entries: readonly NavigationWorldMapEntry[];
      nextCursor: string | null;
      candidates: null;
      destination: null;
      unlockState: null;
    }>
  | Readonly<{
      status: "resolved";
      reason: "exact_current_locale" | "exact_fallback_locale" | "exact_alias";
      entries: null;
      nextCursor: null;
      candidates: null;
      destination: NavigationSelector;
      unlockState: "unknown";
    }>
  | Readonly<{
      status: "candidates";
      reason: "ambiguous_exact" | "fuzzy_match";
      entries: null;
      nextCursor: null;
      candidates: readonly NavigationSearchCandidate[];
      destination: null;
      unlockState: null;
    }>
  | Readonly<{
      status: "not_found" | "invalid" | "blocked";
      reason: string;
      entries: null;
      nextCursor: null;
      candidates: null;
      destination: null;
      unlockState: null;
    }>;

export type LocalObservation = Readonly<{
  location: string;
  tileX: number;
  tileY: number;
  facing: number;
  inGameTime: string;
  playerNearby: boolean;
  revision: number;
}>;

export type ExecutionReceipt = Readonly<{
  executionId: string;
  requestId: string;
  /** Exact Mod-authored action lineage; Host must never infer it from tool context. */
  actionId: string;
  state: ExecutionState;
  reasonCode: string;
  revision: number;
  evidence: Readonly<Record<string, unknown>> | null;
  observation?: LocalObservation | null;
  /**
   * Optional bounded destination scene attached to a succeeded Navigation
   * receipt. Host only forwards it; it never resolves/creates observation
   * identity or refs inside it.
   */
  piggybackedScene?: ObserveSceneResult | null;
  /**
   * Raw native HUD notice text the game itself emitted inside the action's
   * synchronous window (for example "Out of season."). Host forwards it
   * verbatim: it never interprets a notice into a reason or an intent.
   */
  nativeNotices?: readonly string[] | null;
}>;

export interface WorldFactPayload {
  readonly eventId: string;
  readonly sourceEventId: string;
  readonly kind: string;
  readonly observedTick: number;
  readonly gameTime?: string | null;
  readonly revision: number;
  readonly deduplicationKey?: string;
  readonly payload?: Readonly<Record<string, unknown>> | null;
  readonly payloadJson?: string | null;
}

export interface WorldFact extends WorldFactPayload {}

/**
 * Typed cancel identity for one exact execution. The Mod rejects a missing,
 * stale (older cancelEpoch), or mismatched (different cancelId/executionId)
 * identity before its action-owned ledger converges, so a cancel can never
 * settle a different execution than the one the Host bound.
 */
export type CancelRequestPayload = Readonly<{
  requestId: string;
  executionId: string;
  cancelId: string;
  cancelEpoch: number;
  reasonCode: string;
}>;

export type CancelIdentity = Readonly<{ cancelId: string; cancelEpoch: number }>;

/**
 * Mint one stable cancelId per request and a strictly increasing cancelEpoch
 * per distinct cancel attempt. Replays of the same attempt keep the same
 * identity tuple; a new attempt raises only the epoch.
 */
export function nextCancelIdentity(previous: CancelIdentity | null): CancelIdentity {
  if (previous === null) return { cancelId: randomUUID(), cancelEpoch: 1 };
  return { cancelId: previous.cancelId, cancelEpoch: previous.cancelEpoch + 1 };
}

type BodyTrace = Readonly<{
  category:
    | "execution_started"
    | "route_progress"
    | "execution_settled_succeeded"
    | "execution_settled_cancelled"
    | "execution_settled_failed"
    | "execution_invalidated"
    | "body_idle";
  executionId: string;
  requestId: string;
  tick: number;
  revision: number;
  location?: string;
  tile?: Readonly<{ x: number; y: number }>;
}>;

type SemanticEvent = Readonly<{
  kind:
    | "snapshot_changed"
    | "execution_state"
    | "connection_state"
    | "lifecycle"
    | "player_input"
    | "stop_all"
    | "body_settled"
    | BodyTrace["category"];
  revision: number;
  activeExecution: ActiveExecution | null;
  reasonCode: string;
  bodyTrace?: BodyTrace;
  /** Mod-authenticated Host-human chat fact, never model-generated text. */
  playerControl?: Readonly<{
    kind: "player_input" | "stop_all";
    controlId: string;
    sourceEventId: string;
    text?: string;
    locale: string;
    issuerPlayerId: string;
  }>;
  /** Mod/game-thread observation after a typed stop control; no Host inference. */
  stopObservation?: Readonly<{
    kind: "body_settled";
    stopId: string;
    sourceEventId: string;
    epoch: number;
  }>;
}>;

export type CompanionPresentationRequest = Readonly<{
  expressionId: string;
  sourceEventId: string;
  text: string;
  locale: string;
  expectedRevision: number;
  presentationEpoch: number;
}>;

export type SystemNoticeRequest = Readonly<{
  noticeId: string;
  key: "system.stop.active_turn_cancelled" | "system.stop.queued_turn_cancelled" | "system.stop.no_active_turn";
  text: string;
  locale: string;
}>;

type SystemNoticeReceipt = Readonly<{
  noticeId: string;
  revision: number;
}>;

/** Host acknowledgement only after its registered listener has synchronously received a native player-control fact. */
type PlayerControlReceipt = Readonly<{
  controlId: string;
  sourceEventId: string;
  status: "accepted";
}>;

export type ActionDescriptorArgument = Readonly<{
  name: string;
  type: string;
  enum?: readonly string[];
  boundedEnumValues?: readonly string[];
}>;

export type ActionRegistrationDescriptor = Readonly<{
  arguments?: readonly ActionDescriptorArgument[];
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  /** Mod-owned opt-in required before Host can project pickup_forage sceneTarget. */
  sceneTarget?: Readonly<{
    type: string;
    version: number;
    required: boolean;
    requiredProperties: readonly string[];
  }>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }> | string;
  effect?: "read" | "write";
  evidenceSchema?: string | Readonly<Record<string, unknown>>;
  nativeBinding?: string;
  canonicalCodec?: string;
  /**
   * The Mod's OWN watchdog for this action, in milliseconds: hang protection it already owns (`WatchdogMs` on the
   * Mod's descriptor; the lifecycle actions carry 600s because a night waits on other players, the save and the day
   * start). Published so a dispatch deadline can be sized the way the action was designed to be waited on, instead
   * of one hard-coded number for every action - measured 2026-10-17: `advance_day` went out with a 30s deadline
   * against a 600s watchdog, so it timed out by construction and the failure read as the companion being unable to
   * sleep.
   */
  watchdogMs?: number;
  postcondition?: string | Readonly<{ name: string }>;
}>;

export type ActionRegistration = Readonly<{
  actionId: string;
  familyId: string;
  identityVersion: number;
  lifecycle: "published" | "live_verified" | "experimental";
  kind: "execution" | "read_only";
  descriptor?: ActionRegistrationDescriptor;
}>;

/** Typed destination selector accepted by the C# Body Program wire contract. */
type BodyProgramDestinationSelector = Readonly<{ kind: "label"; label: string } | { kind: "ref"; ref: string }>;
/** Exact Host runtime value. Scalar kinds retain canonicalValue; destination_selector retains its typed object payload. */
type BodyProgramRuntimeValue =
  | Readonly<{ type: "integer" | "string" | "boolean"; canonicalValue: string }>
  | Readonly<{ type: "destination_selector"; destination: BodyProgramDestinationSelector }>;
type BodyProgramFactReference = Readonly<{ nodeId: string; factName: string }>;
type BodyProgramNode = Readonly<{
  nodeId: string;
  actionId: string;
  arguments: Readonly<Record<string, BodyProgramRuntimeValue>>;
  dependsOn: readonly string[];
  bindings: Readonly<Record<string, BodyProgramFactReference>>;
}>;
/** Frozen maximum Body Program node count, shared with C# BodyProgramValidation.MaximumNodes. */
const MAX_BODY_PROGRAM_NODES = 16;
/** Frozen native-notice bounds, shared with the C# NativeNoticeObserver. */
const MAX_NATIVE_NOTICES = 8;
const MAX_NATIVE_NOTICE_CHARS = 512;
/** Frozen per-node binding-map bound, aligned with the existing C# Core verifier bound of 4. */
export const MAX_BODY_PROGRAM_BINDINGS_PER_NODE = 4;
export type BodyProgramCandidateRequest = Readonly<{ programId: string; nodes: readonly BodyProgramNode[] }>;
export type BodyProgramStatusRequest = Readonly<{ programId: string }>;
export type BodyProgramEventsRequest = Readonly<{ programId: string; cursor: number; pageSize: number }>;
type BodyProgramDiagnostic = Readonly<{
  severity: string;
  code: string;
  nodeId: string | null;
  path: string;
  message: string;
}>;
type BodyProgramVerification = Readonly<{
  accepted: boolean;
  catalogRevision: number;
  diagnostics: readonly BodyProgramDiagnostic[];
}>;
type BodyProgramNodeStatus = Readonly<{
  nodeId: string;
  state: string;
  nodeAttempt: number;
  admissionAttempt: number;
}>;
type BodyProgramStatusSnapshot = Readonly<{
  programId: string;
  state: string;
  catalogRevision: number;
  stopEpoch: number;
  eventHighWater: number;
  nodes: readonly BodyProgramNodeStatus[];
}>;
export type BodyProgramSubmitResult = Readonly<{
  code: "accepted" | "rejected" | "idempotent" | "conflict" | "persistence_failure" | "quarantined";
  verification: BodyProgramVerification;
  snapshot: BodyProgramStatusSnapshot | null;
}>;
export type BodyProgramStatusResult = Readonly<{
  code: "found" | "not_found" | "invalid_input";
  snapshot: BodyProgramStatusSnapshot | null;
}>;
type BodyProgramEvent = Readonly<{
  cursor: number;
  programId: string;
  kind: string;
  catalogRevision: number;
  nodeId: string | null;
  nodeAttempt: number | null;
}>;
export type BodyProgramEventsResult = Readonly<{
  programId: string;
  code: "found" | "not_found" | "invalid_input";
  events: readonly BodyProgramEvent[];
  nextCursor: number;
  highWater: number;
}>;

export type BridgeMessage =
  | Envelope<"hello", Readonly<{ token: string }>>
  | Envelope<
      "hello_ack",
      Readonly<{
        sessionId: string;
        capabilities: readonly string[];
        catalogRevision: number;
        policyIdentity: FarmhandPolicyIdentity;
        enabledActionIds: readonly string[];
        presentationLocale: string;
        registrations: readonly ActionRegistration[];
        runtimeRole: "farmhand_client" | "native_local_fixture" | "unattested";
        launchGeneration: string | null;
        /**
         * Why this Mod cannot honour an ActionProgram, when it says so on the ack. Absent means it did not say, which
         * the mount gate treats as available (the pre-existing behaviour); present means the Host must not mount the
         * program tools, because advertising a capability the Mod refuses on every call reads as a broken tool rather
         * than an absent one (measured 2026-10-18).
         */
        bodyProgramUnavailableReason?: string | null;
      }>
    >
  | Envelope<"observe_request", Readonly<Record<string, never>>>
  | Envelope<"navigation_read_request", NavigationReadRequest>
  | Envelope<"navigation_read_result", NavigationReadResult>
  | Envelope<"observe_scene_request", ObserveSceneRequest>
  | Envelope<"observe_scene_result", ObserveSceneResult>
  | Envelope<"snapshot", Snapshot>
  | Envelope<
      "catalog_update",
      Readonly<{ catalogRevision: number; policyIdentity: FarmhandPolicyIdentity; enabledActionIds: readonly string[] }>
    >
  | Envelope<"execution_request", ExecutionRequest>
  | Envelope<"body_node_admission_challenge", BodyNodeAdmissionChallenge>
  | Envelope<"body_node_admission_grant", BodyNodeAdmissionGrant>
  | Envelope<"body_node_admission_result", BodyNodeAdmissionResult>
  | Envelope<"execution_receipt_query", ExecutionReceiptQuery>
  | Envelope<"cancel_request", CancelRequestPayload>
  | Envelope<"companion_presentation_request", CompanionPresentationRequest>
  | Envelope<"system_notice_request", SystemNoticeRequest>
  | Envelope<"system_notice_receipt", SystemNoticeReceipt>
  | Envelope<
      "companion_presentation_receipt",
      Readonly<{ expressionId: string; revision: number; presentationEpoch: number }>
    >
  | Envelope<"player_control_receipt", PlayerControlReceipt>
  | Envelope<"execution_receipt", ExecutionReceipt>
  | Envelope<"program_submit", BodyProgramCandidateRequest>
  | Envelope<"program_submit_result", BodyProgramSubmitResult>
  | Envelope<"program_status", BodyProgramStatusRequest>
  | Envelope<"program_status_result", BodyProgramStatusResult>
  | Envelope<"program_events", BodyProgramEventsRequest>
  | Envelope<"program_events_result", BodyProgramEventsResult>
  | Envelope<"error", Readonly<{ reasonCode: string }>>
  | Envelope<"semantic_event", SemanticEvent>
  | Envelope<"lifecycle", Readonly<{ state: "connected" | "disconnected" | "world_unavailable"; reasonCode: string }>>
  | Envelope<"world_fact", WorldFactPayload>;

const BRIDGE_MESSAGE_TYPES = [
  "hello",
  "hello_ack",
  "observe_request",
  "navigation_read_request",
  "navigation_read_result",
  "observe_scene_request",
  "observe_scene_result",
  "snapshot",
  "catalog_update",
  "execution_request",
  "body_node_admission_challenge",
  "body_node_admission_grant",
  "body_node_admission_result",
  "execution_receipt_query",
  "cancel_request",
  "companion_presentation_request",
  "system_notice_request",
  "system_notice_receipt",
  "companion_presentation_receipt",
  "player_control_receipt",
  "execution_receipt",
  "program_submit",
  "program_submit_result",
  "program_status",
  "program_status_result",
  "program_events",
  "program_events_result",
  "error",
  "semantic_event",
  "lifecycle",
  "world_fact",
] as const;

const SNAPSHOT_KEYS = [
  "revision",
  "location",
  "tile",
  "stamina",
  "exhausted",
  "actorDispositionKind",
  "actorDispositionDetail",
  "actorDispositionActionOwned",
  "health",
  "currentTool",
  "inventorySlots",
  "actionable",
  "capabilities",
  "catalogRevision",
  "enabledActionIds",
  "presentationLocale",
  "timeOfDay",
  "dayOfMonth",
  "seasonIndex",
  "year",
  "activeExecution",
  "warps",
  "doorTargets",
  "soilTiles",
  "toolSlots",
  "wateringCanFacts",
  "refillWateringCanTargets",
  "forageTargets",
  "itemTargets",
  "cropTargets",
  "petBowlTargets",
  "slimeHutchTroughTargets",
  "harvestTargets",
  "seedTargets",
  "fertilizerTargets",
  "woodFenceTargets",
  "woodFenceResultTargets",
  "crabPotTargets",
  "crabPotResultTargets",
  "crabPotCollectTargets",
  "baitCrabPotTargets",
  "baitCrabPotResultTargets",
  "debrisTargets",
  "rockSourceTargets",
  "clearHoeDirtTargets",
  "artifactSpotTargets",
  "artifactSpotResultTargets",
  "artifactSpotFarmSourceCount",
  "machineTargets",
  "treeChopSourceTargets",
  "treeChopResultTargets",
  "treeStumpTargets",
  "treeSaplingTargets",
  "weedTargets",
  "grassTargets",
  "caskTargets",
  "mannequinTargets",
  "signTargets",
  "siloTargets",
  "lanternSlots",
  "scytheCropTargets",
  "npcRelationshipTargets",
  "villagerWhereabouts",
  "harvestWhereabouts",
  "petTargets",
  "animalProductTargets",
  "feedTroughTargets",
  "chestStoreTargets",
  "chestRetrieveTargets",
  "inventoryItemFacts",
  "foodTargets",
  "shippingBinTargets",
  "craftingRecipeTargets",
  "cookingRecipeTargets",
  "cookingStationTargets",
  "shopTargets",
  "mineElevatorFloorTargets",
  "animalDoorTargets",
  "fishPondTargets",
  "buildingChestTargets",
  "obeliskTargets",
  "minecartTargets",
  "bushTargets",
  "fruitTreeTargets",
  "shakeTreeTargets",
  "pedestalTargets",
  "fenceGateTargets",

  "worldObjectTargets",
  "farmBuildingTargets",
  "dailyQuestTargets",
  "specialOrderTargets",
  "activeSpecialOrderKeys",
  "museumRewardTargets",
  "colorTargets",
  "tailoringTargets",
  "acceptedDailyQuest",
  "wearableTargets",
  "warpItemTargets",
  "panSites",
  "mailboxTargets",
  "weather",
  "raftTargets",
  "horseTargets",
  "mineEntranceTargets",
] as const;

export function newEnvelope<
  TType extends BridgeMessage["type"],
  TPayload extends Extract<BridgeMessage, Readonly<{ type: TType }>>["payload"],
>(
  type: TType,
  scope: Scope,
  payload: TPayload,
  correlationId?: string,
  timestampMs?: number,
): Envelope<TType, TPayload>;
/** Build malformed envelopes in protocol validator tests without weakening production validation. */
export function newEnvelope<TType extends BridgeMessage["type"], TPayload>(
  type: TType,
  scope: Scope,
  payload: TPayload,
  correlationId?: string,
  timestampMs?: number,
): Envelope<TType, TPayload>;
export function newEnvelope<TType extends BridgeMessage["type"], TPayload>(
  type: TType,
  scope: Scope,
  payload: TPayload,
  correlationId: string = randomUUID(),
  timestampMs = Date.now(),
): Envelope<TType, TPayload> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    correlationId,
    timestampMs,
    scope,
    type,
    payload,
  };
}

function validateScope(expected: Scope, actual: Scope): string | null {
  for (const key of Object.keys(expected) as (keyof Scope)[]) {
    if (expected[key] !== actual[key]) return `scope_mismatch:${key}`;
  }
  return null;
}

export function validateEnvelope(value: unknown, expectedScope: Scope, nowMs = Date.now()): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["protocolVersion", "messageId", "correlationId", "timestampMs", "scope", "type", "payload"])
  )
    return "invalid_envelope";
  if (value.protocolVersion !== PROTOCOL_VERSION) return "unsupported_protocol_version";
  if (typeof value.messageId !== "string" || !isOpaqueId(value.messageId)) return "invalid_message_id";
  if (typeof value.correlationId !== "string" || !isOpaqueId(value.correlationId)) return "invalid_correlation_id";
  if (
    typeof value.timestampMs !== "number" ||
    !Number.isSafeInteger(value.timestampMs) ||
    Math.abs(nowMs - value.timestampMs) > 5 * 60_000
  )
    return "stale_or_invalid_timestamp";
  if (!isScope(value.scope)) return "invalid_scope";
  if (
    typeof value.type !== "string" ||
    !BRIDGE_MESSAGE_TYPES.includes(value.type as (typeof BRIDGE_MESSAGE_TYPES)[number])
  )
    return "unknown_message_type";
  if (!("payload" in value) || !isRecord(value.payload)) return "invalid_payload";
  return validateScope(expectedScope, value.scope);
}

export function diagnoseBridgeMessage(value: unknown, expectedScope: Scope, nowMs = Date.now()): string | null {
  const envelopeError = validateEnvelope(value, expectedScope, nowMs);
  if (envelopeError !== null) return envelopeError;
  if (isRecord(value) && value.type === "snapshot" && isRecord(value.payload)) return diagnoseSnapshot(value.payload);
  return validateBridgeMessage(value, expectedScope, nowMs);
}

export function validateBridgeMessage(value: unknown, expectedScope: Scope, nowMs = Date.now()): string | null {
  const envelopeError = validateEnvelope(value, expectedScope, nowMs);
  if (envelopeError !== null) return envelopeError;
  const message = value as BridgeMessage;
  const payload = message.payload as Record<string, unknown>;
  if (
    message.type === "body_node_admission_challenge" ||
    message.type === "body_node_admission_grant" ||
    message.type === "body_node_admission_result"
  ) {
    try {
      serializeBounded(message);
    } catch (error) {
      return error instanceof Error ? error.message : "message_not_serializable";
    }
  }
  switch (message.type) {
    case "hello":
      return hasExactKeys(payload, ["token"]) && validToken(payload.token) ? null : "invalid_hello_token";
    case "hello_ack":
      // `bodyProgramUnavailableReason` is OPTIONAL, and the two shapes are accepted on purpose: the Mod
      // serializes it only when it has one, so a session that can honour a program keeps the ack byte-identical
      // to before (every existing fixture and the golden sequence stay valid), while a session that cannot says so
      // and the Host refuses to mount the program tools. Two exact-key shapes beat one permissive shape here: an
      // unknown key is still a defect.
      return (hasExactKeys(payload, [
        "sessionId",
        "capabilities",
        "catalogRevision",
        "policyIdentity",
        "enabledActionIds",
        "presentationLocale",
        "registrations",
        "runtimeRole",
        "launchGeneration",
      ]) ||
        hasExactKeys(payload, [
          "sessionId",
          "capabilities",
          "catalogRevision",
          "policyIdentity",
          "enabledActionIds",
          "presentationLocale",
          "registrations",
          "runtimeRole",
          "launchGeneration",
          "bodyProgramUnavailableReason",
        ])) &&
        (payload.bodyProgramUnavailableReason === undefined || isOpaqueId(payload.bodyProgramUnavailableReason)) &&
        isOpaqueId(payload.sessionId) &&
        isStringArray(payload.capabilities) &&
        isNonNegativeSafeInteger(payload.catalogRevision) &&
        isFarmhandPolicyIdentity(payload.policyIdentity) &&
        isUniqueOpaqueIdArray(payload.enabledActionIds) &&
        isBcp47Locale(payload.presentationLocale) &&
        isValidActionRegistrations(payload.registrations) &&
        isValidRuntimeAttestation(payload.runtimeRole, payload.launchGeneration)
        ? null
        : "invalid_hello_ack";
    case "observe_request":
      return hasExactKeys(payload, []) ? null : "invalid_observe_request";
    case "navigation_read_request":
      return validateNavigationReadRequest(payload);
    case "navigation_read_result":
      return validateNavigationReadResult(payload);
    case "observe_scene_request":
      return validateObserveSceneRequest(payload);
    case "observe_scene_result":
      return validateObserveSceneResult(payload);
    case "snapshot":
      return validateSnapshot(payload);
    case "catalog_update":
      return hasExactKeys(payload, ["catalogRevision", "policyIdentity", "enabledActionIds"]) &&
        isNonNegativeSafeInteger(payload.catalogRevision) &&
        isFarmhandPolicyIdentity(payload.policyIdentity) &&
        isUniqueOpaqueIdArray(payload.enabledActionIds)
        ? null
        : "invalid_catalog_update";
    case "execution_request":
      return validateExecutionRequestEnvelope(payload);
    case "execution_receipt_query":
      return hasExactKeys(payload, ["requestId", "idempotencyKey"]) &&
        isOpaqueId(payload.requestId) &&
        isOpaqueId(payload.idempotencyKey)
        ? null
        : "invalid_execution_receipt_query";
    case "cancel_request": {
      const cancelEpoch = payload.cancelEpoch;
      return hasExactKeys(payload, ["requestId", "executionId", "cancelId", "cancelEpoch", "reasonCode"]) &&
        isOpaqueId(payload.requestId) &&
        isOpaqueId(payload.executionId) &&
        isOpaqueId(payload.cancelId) &&
        Number.isSafeInteger(cancelEpoch) &&
        (cancelEpoch as number) >= 1 &&
        isReasonCode(payload.reasonCode)
        ? null
        : "invalid_cancel_request";
    }
    case "companion_presentation_request": {
      const expectedRevision = payload.expectedRevision;
      const presentationEpoch = payload.presentationEpoch;
      if (
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        typeof presentationEpoch !== "number" ||
        !Number.isSafeInteger(presentationEpoch) ||
        presentationEpoch < 0
      )
        return "invalid_companion_presentation_request";
      return hasExactKeys(payload, [
        "expressionId",
        "sourceEventId",
        "text",
        "locale",
        "expectedRevision",
        "presentationEpoch",
      ]) &&
        isOpaqueId(payload.expressionId) &&
        isOpaqueId(payload.sourceEventId) &&
        typeof payload.text === "string" &&
        payload.text.trim().length > 0 &&
        payload.text.length <= 4_000 &&
        isBcp47Locale(payload.locale)
        ? null
        : "invalid_companion_presentation_request";
    }
    case "system_notice_request":
      return hasExactKeys(payload, ["noticeId", "key", "text", "locale"]) &&
        isOpaqueId(payload.noticeId) &&
        (payload.key === "system.stop.active_turn_cancelled" ||
          payload.key === "system.stop.queued_turn_cancelled" ||
          payload.key === "system.stop.no_active_turn") &&
        typeof payload.text === "string" &&
        payload.text.trim().length > 0 &&
        payload.text.length <= 256 &&
        isBcp47Locale(payload.locale)
        ? null
        : "invalid_system_notice_request";
    case "system_notice_receipt":
      return hasExactKeys(payload, ["noticeId", "revision"]) &&
        isOpaqueId(payload.noticeId) &&
        Number.isSafeInteger(payload.revision) &&
        (payload.revision as number) >= 0
        ? null
        : "invalid_system_notice_receipt";
    case "companion_presentation_receipt": {
      const presentationEpoch = payload.presentationEpoch;
      if (typeof presentationEpoch !== "number" || !Number.isSafeInteger(presentationEpoch) || presentationEpoch < 0)
        return "invalid_companion_presentation_receipt";
      return hasExactKeys(payload, ["expressionId", "revision", "presentationEpoch"]) &&
        isOpaqueId(payload.expressionId) &&
        Number.isSafeInteger(payload.revision)
        ? null
        : "invalid_companion_presentation_receipt";
    }
    case "player_control_receipt":
      return hasExactKeys(payload, ["controlId", "sourceEventId", "status"]) &&
        isOpaqueId(payload.controlId) &&
        isOpaqueId(payload.sourceEventId) &&
        payload.status === "accepted"
        ? null
        : "invalid_player_control_receipt";
    case "execution_receipt":
      return validateReceipt(payload);
    case "body_node_admission_challenge":
      return validateBodyNodeAdmissionChallenge(payload);
    case "body_node_admission_grant":
      return validateBodyNodeAdmissionGrant(payload);
    case "body_node_admission_result":
      return validateBodyNodeAdmissionResult(payload);
    case "program_submit":
      return validateBodyProgramCandidateRequest(payload);
    case "program_submit_result":
      return validateBodyProgramSubmitResult(payload);
    case "program_status":
      return hasExactKeys(payload, ["programId"]) && isOpaqueId(payload.programId)
        ? null
        : "invalid_body_program_request";
    case "program_status_result":
      return validateBodyProgramStatusResult(payload);
    case "program_events":
      return hasExactKeys(payload, ["programId", "cursor", "pageSize"]) &&
        isOpaqueId(payload.programId) &&
        isNonNegativeSafeInteger(payload.cursor) &&
        Number.isSafeInteger(payload.pageSize) &&
        (payload.pageSize as number) >= 1 &&
        (payload.pageSize as number) <= 32
        ? null
        : "invalid_body_program_request";
    case "program_events_result":
      return validateBodyProgramEventsResult(payload);
    case "error":
      return hasExactKeys(payload, ["reasonCode"]) && isReasonCode(payload.reasonCode) ? null : "invalid_error";
    case "semantic_event":
      return validateSemanticEvent(payload);
    case "lifecycle":
      return hasExactKeys(payload, ["state", "reasonCode"]) &&
        (payload.state === "connected" || payload.state === "disconnected" || payload.state === "world_unavailable") &&
        isReasonCode(payload.reasonCode)
        ? null
        : "invalid_lifecycle";
    case "world_fact":
      return validateWorldFact(payload);
  }
}

export function validateBodyNodeAdmissionPayload(value: unknown, grant = false): string | null {
  if (!isRecord(value)) return grant ? "invalid_body_node_admission_grant" : "invalid_body_node_admission_challenge";
  return grant ? validateBodyNodeAdmissionGrant(value) : validateBodyNodeAdmissionChallenge(value);
}

function validateBodyNodeAdmissionResult(value: Record<string, unknown>): string | null {
  if (value.result === "granted") {
    if (
      !hasExactKeys(value, [
        "result",
        "programId",
        "nodeId",
        "nodeAttempt",
        "admissionAttempt",
        "stopEpoch",
        "catalogRevision",
        "policyIdentity",
        "actionId",
        "canonicalBoundArgs",
        "derivedResourceClaims",
        "deadlineMs",
        "grantId",
        "attachmentGeneration",
        "policyRevision",
        "executionBinding",
      ])
    )
      return "invalid_body_node_admission_result";
    const { result: _result, ...grant } = value;
    return validateBodyNodeAdmissionGrant(grant);
  }
  if (value.result === "rejected" || value.result === "unavailable") {
    if (
      !hasExactKeys(value, [
        "result",
        "code",
        "programId",
        "nodeId",
        "nodeAttempt",
        "admissionAttempt",
        "stopEpoch",
        "catalogRevision",
        "policyIdentity",
        "actionId",
        "canonicalBoundArgs",
        "derivedResourceClaims",
        "deadlineMs",
      ])
    )
      return "invalid_body_node_admission_result";
    if (
      typeof value.code !== "string" ||
      !isReasonCode(value.code) ||
      (value.result === "unavailable" && value.code !== "admission_unavailable")
    )
      return "invalid_body_node_admission_result";
    const { result: _result, code: _code, ...challenge } = value;
    return validateBodyNodeAdmissionChallenge(challenge);
  }
  return "invalid_body_node_admission_result";
}

function validateBodyNodeAdmissionChallenge(value: Record<string, unknown>, grant = false): string | null {
  const base = [
    "programId",
    "nodeId",
    "nodeAttempt",
    "admissionAttempt",
    "stopEpoch",
    "catalogRevision",
    "policyIdentity",
    "actionId",
    "canonicalBoundArgs",
    "derivedResourceClaims",
    "deadlineMs",
  ];
  if (grant) base.push("grantId", "attachmentGeneration", "policyRevision", "executionBinding");
  if (
    !hasExactKeys(value, base) ||
    !isOpaqueId(value.programId) ||
    !isOpaqueId(value.nodeId) ||
    !isOpaqueId(value.actionId)
  )
    return "invalid_body_node_admission_challenge";
  if (
    !["nodeAttempt", "admissionAttempt"].every(
      (k) => isPositiveSafeInteger(value[k]) && (value[k] as number) <= 2_147_483_647,
    ) ||
    !["stopEpoch", "catalogRevision"].every((k) => isNonNegativeSafeInteger(value[k])) ||
    !isPositiveSafeInteger(value.deadlineMs)
  )
    return "invalid_body_node_admission_challenge";
  if (
    !isRecord(value.policyIdentity) ||
    !hasExactKeys(value.policyIdentity, ["value", "capabilityRevision"]) ||
    !isAdmissionOpaque(value.policyIdentity.value) ||
    !isNonNegativeSafeInteger(value.policyIdentity.capabilityRevision) ||
    !isRecord(value.canonicalBoundArgs) ||
    !isRecord(value.derivedResourceClaims)
  )
    return "invalid_body_node_admission_challenge";
  return Object.keys(value.derivedResourceClaims).length <= 16 &&
    Object.keys(value.canonicalBoundArgs).length <= 32 &&
    Object.entries(value.derivedResourceClaims).every(([k, v]) => isAdmissionMapKey(k) && isOpaqueId(v)) &&
    Object.entries(value.canonicalBoundArgs).every(([k, v]) => isAdmissionMapKey(k) && isBodyCanonicalValue(v))
    ? null
    : "invalid_body_node_admission_challenge";
}
function validateBodyNodeAdmissionGrant(value: Record<string, unknown>): string | null {
  const err = validateBodyNodeAdmissionChallenge(value, true);
  if (err) return "invalid_body_node_admission_grant";
  if (
    !hasExactKeys(value, [
      "programId",
      "nodeId",
      "nodeAttempt",
      "admissionAttempt",
      "stopEpoch",
      "catalogRevision",
      "policyIdentity",
      "actionId",
      "canonicalBoundArgs",
      "derivedResourceClaims",
      "deadlineMs",
      "grantId",
      "attachmentGeneration",
      "policyRevision",
      "executionBinding",
    ]) ||
    !isOpaqueId(value.grantId) ||
    !isAdmissionOpaque(value.attachmentGeneration) ||
    !isAdmissionOpaque(value.policyRevision)
  )
    return "invalid_body_node_admission_grant";
  const binding = value.executionBinding;
  return binding === null ||
    (isRecord(binding) &&
      hasExactKeys(binding, ["programId", "nodeId", "nodeAttempt", "requestId", "idempotencyKey", "executionId"]) &&
      binding.programId === value.programId &&
      binding.nodeId === value.nodeId &&
      binding.nodeAttempt === value.nodeAttempt &&
      isOpaqueId(binding.requestId) &&
      isOpaqueId(binding.idempotencyKey) &&
      isOpaqueId(binding.executionId))
    ? null
    : "invalid_body_node_admission_grant";
}
function isFarmhandPolicyIdentity(value: unknown): value is FarmhandPolicyIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["value", "capabilityRevision"]) &&
    typeof value.value === "string" &&
    /^[0-9a-f]{32}$/iu.test(value.value) &&
    isPositiveSafeInteger(value.capabilityRevision)
  );
}

function isAdmissionMapKey(value: unknown): value is string {
  return isOpaqueId(value) && value !== "__proto__";
}
function isAdmissionOpaque(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}
function isBodyCanonicalValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "destination_selector") {
    const destination = value.destination;
    return (
      hasExactKeys(value, ["type", "destination"]) &&
      isRecord(destination) &&
      ((hasExactKeys(destination, ["kind", "label"]) &&
        destination.kind === "label" &&
        typeof destination.label === "string" &&
        destination.label.length >= 1 &&
        destination.label.length <= 128 &&
        destination.label.trim().length > 0 &&
        destination.label.normalize("NFC") === destination.label) ||
        (hasExactKeys(destination, ["kind", "ref"]) &&
          destination.kind === "ref" &&
          typeof destination.ref === "string" &&
          /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/u.test(destination.ref)))
    );
  }
  if (
    !hasExactKeys(value, ["type", "canonicalValue"]) ||
    typeof value.canonicalValue !== "string" ||
    value.canonicalValue.length > 512
  )
    return false;
  if (value.type === "string") return true;
  if (value.type === "boolean") return value.canonicalValue === "true" || value.canonicalValue === "false";
  if (value.type !== "integer" || !/^(?:0|-?[1-9][0-9]*)$/u.test(value.canonicalValue)) return false;
  const integer = BigInt(value.canonicalValue);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}
function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

const OBSERVE_SCENE_KINDS = new Set([
  "npc",
  "chest",
  "crop",
  "tree",
  "animal",
  "forage",
  "door",
  "machine",
  "water_source",
  "weed",
  "stone",
  "debris",
  "artifact_spot",
]);
const OBSERVE_SCENE_DIRECTIONS = new Set(["North", "South", "East", "West", "CurrentTile"]);
const OBSERVE_SCENE_TRUNCATION_REASONS = new Set(["maximum_affordances", "payload_limit", "ground_limit"]);
const SCENE_GROUND_KINDS = new Set(["grass", "dirt", "stone", "wood", "other"]);
const MAXIMUM_SCENE_GROUND_EXCEPTIONS = 12;

/**
 * Validate the ground summary. `null` means the Mod did not scan tiles, which is
 * different from "scanned and found nothing"; the counts must otherwise stay
 * self-consistent so the Agent can trust `dominantTileCount`.
 */
function validateObserveSceneGround(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "dominantKind",
      "dominantTileCount",
      "scannedTileCount",
      "exceptions",
      "omittedExceptionTileCount",
    ])
  )
    return false;
  if (typeof value.dominantKind !== "string" || !SCENE_GROUND_KINDS.has(value.dominantKind)) return false;
  if (!Number.isSafeInteger(value.dominantTileCount) || (value.dominantTileCount as number) < 0) return false;
  if (!Number.isSafeInteger(value.scannedTileCount) || (value.scannedTileCount as number) < 0) return false;
  if ((value.dominantTileCount as number) > (value.scannedTileCount as number)) return false;
  if (!Number.isSafeInteger(value.omittedExceptionTileCount) || (value.omittedExceptionTileCount as number) < 0)
    return false;
  if (!Array.isArray(value.exceptions) || value.exceptions.length > MAXIMUM_SCENE_GROUND_EXCEPTIONS) return false;
  return value.exceptions.every(
    (tile) =>
      isRecord(tile) &&
      hasExactKeys(tile, ["tileX", "tileY", "kind"]) &&
      Number.isSafeInteger(tile.tileX) &&
      Number.isSafeInteger(tile.tileY) &&
      typeof tile.kind === "string" &&
      SCENE_GROUND_KINDS.has(tile.kind),
  );
}

export function isValidObserveSceneRequest(value: unknown): value is ObserveSceneRequest {
  return isRecord(value) && validateObserveSceneRequest(value) === null;
}

export function isValidObserveSceneResult(value: unknown): value is ObserveSceneResult {
  return isRecord(value) && validateObserveSceneResult(value) === null;
}

function validateObserveSceneRequest(value: Record<string, unknown>): string | null {
  if (hasExactKeys(value, [])) return null;
  return hasExactKeys(value, ["radius"]) &&
    Number.isSafeInteger(value.radius) &&
    (value.radius as number) >= 0 &&
    (value.radius as number) <= 30
    ? null
    : "invalid_observe_scene_request";
}

function validateObserveSceneResult(value: Record<string, unknown>): string | null {
  if (
    !hasExactKeys(value, [
      "observationId",
      "currentLocation",
      "currentRegion",
      "affordances",
      "summary",
      "partial",
      "truncatedReason",
      "ground",
    ]) ||
    !isOpaqueId(value.observationId) ||
    !boundedSceneText(value.currentLocation, 128) ||
    !boundedSceneText(value.currentRegion, 128) ||
    !boundedSceneText(value.summary, 512) ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.affordances) ||
    value.affordances.length > 20 ||
    (value.partial
      ? typeof value.truncatedReason !== "string" || !OBSERVE_SCENE_TRUNCATION_REASONS.has(value.truncatedReason)
      : value.truncatedReason !== null) ||
    !validateObserveSceneGround(value.ground)
  )
    return "invalid_observe_scene_result";
  const refs = new Set<string>();
  return value.affordances.every((affordance) => {
    // `reachable` is OPTIONAL and tri-state: `false` is a measured no, ABSENT or null is undecided (nobody checked),
    // and a `null` may never read as `false`. Presence changes the exact-key set, so it is decided before that check.
    const allowReachable = affordance.reachable !== undefined;
    if (
      !isRecord(affordance) ||
      !hasExactKeys(
        affordance,
        allowReachable
          ? ["ref", "kind", "name", "distance", "direction", "actionHint", "reachable"]
          : ["ref", "kind", "name", "distance", "direction", "actionHint"],
      ) ||
      !isSceneReference(affordance.ref) ||
      typeof affordance.kind !== "string" ||
      !OBSERVE_SCENE_KINDS.has(affordance.kind) ||
      !boundedSceneText(affordance.name, 128) ||
      !Number.isSafeInteger(affordance.distance) ||
      (affordance.distance as number) < 0 ||
      (affordance.distance as number) > 30 ||
      typeof affordance.direction !== "string" ||
      !OBSERVE_SCENE_DIRECTIONS.has(affordance.direction) ||
      (affordance.actionHint !== null && !boundedSceneText(affordance.actionHint, 160)) ||
      (allowReachable && affordance.reachable !== null && typeof affordance.reachable !== "boolean") ||
      refs.has(affordance.ref)
    )
      return false;
    refs.add(affordance.ref as string);
    return true;
  })
    ? null
    : "invalid_observe_scene_result";
}

function boundedSceneText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f\u0080-\u009f]/u.test(value)
  );
}

function isSceneReference(value: unknown): value is string {
  return typeof value === "string" && /^sr1_[A-Za-z0-9_-]{16}$/.test(value);
}

/** Exact Host projection of the Mod-owned ObservationBinding/v1 opt-in target. */
function isObservationBindingV1(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["observationId", "ref"])) return false;
  return isOpaqueId(value.observationId) && isSceneReference(value.ref);
}

function validateNavigationReadRequest(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["operation", "args"]) || !isRecord(value.args)) return "invalid_navigation_read_request";
  if (value.operation === "inspect_world_map") {
    if (hasExactKeys(value.args, [])) return null;
    if (hasExactKeys(value.args, ["nodeRef"]) && isOpaqueId(value.args.nodeRef)) return null;
    if (hasExactKeys(value.args, ["cursor"]) && isOpaqueId(value.args.cursor)) return null;
  } else if (
    value.operation === "find_destination" &&
    hasExactKeys(value.args, ["query"]) &&
    isBoundedNonEmptyString(value.args.query, 128)
  ) {
    return null;
  }
  return "invalid_navigation_read_request";
}

function validateNavigationReadResult(value: Record<string, unknown>): string | null {
  const keys = ["status", "reason", "entries", "nextCursor", "candidates", "destination", "unlockState"];
  if (!hasExactKeys(value, keys) || !isReasonCode(value.reason)) return "invalid_navigation_read_result";
  if (value.status === "succeeded") {
    return value.reason === "world_map_observed" &&
      Array.isArray(value.entries) &&
      value.entries.length <= 20 &&
      value.entries.every(isNavigationWorldMapEntry) &&
      (value.nextCursor === null || isOpaqueId(value.nextCursor)) &&
      value.candidates === null &&
      value.destination === null &&
      value.unlockState === null
      ? null
      : "invalid_navigation_read_result";
  }
  if (value.status === "resolved") {
    return (value.reason === "exact_current_locale" ||
      value.reason === "exact_fallback_locale" ||
      value.reason === "exact_alias") &&
      value.entries === null &&
      value.nextCursor === null &&
      value.candidates === null &&
      isNavigationSelector(value.destination) &&
      value.unlockState === "unknown"
      ? null
      : "invalid_navigation_read_result";
  }
  if (value.status === "candidates") {
    return (value.reason === "ambiguous_exact" || value.reason === "fuzzy_match") &&
      value.entries === null &&
      value.nextCursor === null &&
      Array.isArray(value.candidates) &&
      value.candidates.length >= 1 &&
      value.candidates.length <= 3 &&
      value.candidates.every(isNavigationSearchCandidate) &&
      value.destination === null &&
      value.unlockState === null
      ? null
      : "invalid_navigation_read_result";
  }
  const validTerminal =
    (value.status === "not_found" && value.reason === "destination_not_found") ||
    (value.status === "invalid" && value.reason === "destination_search_invalid") ||
    (value.status === "blocked" && isReasonCode(value.reason));
  return validTerminal &&
    value.entries === null &&
    value.nextCursor === null &&
    value.candidates === null &&
    value.destination === null &&
    value.unlockState === null
    ? null
    : "invalid_navigation_read_result";
}

function isExecutionNavigationDestinationSelector(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  return value.kind === "label"
    ? hasExactKeys(value, ["kind", "label"]) && isBoundedNonEmptyString(value.label, 128)
    : value.kind === "ref" &&
        hasExactKeys(value, ["kind", "ref"]) &&
        typeof value.ref === "string" &&
        /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/.test(value.ref);
}

function isNavigationSelector(value: unknown): value is NavigationSelector {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "label", "ref"])) return false;
  return value.kind === "label"
    ? isBoundedNonEmptyString(value.label, 128) && value.ref === null
    : value.kind === "ref" && value.label === null && (value.ref === null || isOpaqueId(value.ref));
}

function isNavigationWorldMapEntry(value: unknown): value is NavigationWorldMapEntry {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["label", "contextLabel", "nodeRef", "destination"]) &&
    isBoundedNonEmptyString(value.label, 128) &&
    (value.contextLabel === null || isBoundedNonEmptyString(value.contextLabel, 128)) &&
    (value.nodeRef === null || isOpaqueId(value.nodeRef)) &&
    (value.destination === null || isNavigationSelector(value.destination))
  );
}

function isNavigationSearchCandidate(value: unknown): value is NavigationSearchCandidate {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["label", "contextLabel", "destination", "unlockState"]) &&
    isBoundedNonEmptyString(value.label, 128) &&
    (value.contextLabel === null || isBoundedNonEmptyString(value.contextLabel, 128)) &&
    isNavigationSelector(value.destination) &&
    value.unlockState === "unknown"
  );
}

export function validateExecutionRequest(value: unknown, snapshot: Snapshot, nowMs = Date.now()): string | null {
  const worldObjectArgsVerdict = validateWorldObjectActionArgs(value);
  if (worldObjectArgsVerdict !== null) return worldObjectArgsVerdict;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["requestId", "idempotencyKey", "action", "args", "expectedRevision", "deadlineMs"])
  )
    return "invalid_request";
  if (!isOpaqueId(value.requestId) || !isOpaqueId(value.idempotencyKey)) return "invalid_request_id";
  if (
    value.action !== "move_to_tile" &&
    value.action !== "navigate_to_destination" &&
    value.action !== "equip_tool" &&
    value.action !== "travel" &&
    value.action !== "ride_minecart" &&
    value.action !== "ride_bus" &&
    value.action !== "withdraw_silo_hay" &&
    value.action !== "use_obelisk" &&
    value.action !== "toggle_animal_door" &&
    value.action !== "clear_fish_pond" &&
    value.action !== "accept_daily_quest" &&
    value.action !== "accept_special_order" &&
    value.action !== "claim_museum_reward" &&
    value.action !== "redeem_prize_ticket" &&
    value.action !== "tailor_clothing" &&
    value.action !== "dye_clothing_with_item" &&
    value.action !== "color_placed_object" &&
    value.action !== "build_farm_building" &&
    value.action !== "send_multiplayer_chat" &&
    value.action !== "name_entity" &&
    value.action !== "place_owned_object" &&
    value.action !== "remove_placed_item" &&
    value.action !== "break_container_source" &&
    value.action !== "use_warp_item" &&
    value.action !== "pan_ore" &&
    value.action !== "claim_mail_attachment" &&
    value.action !== "load_building_chest" &&
    value.action !== "collect_building_chest_output" &&
    value.action !== "shop_purchase" &&
    value.action !== "select_mine_elevator_floor" &&
    value.action !== "use_raft" &&
    value.action !== "mount_transport" &&
    value.action !== "enter_mine" &&
    value.action !== "enter_exit" &&
    value.action !== "till_soil" &&
    value.action !== "pickup_forage" &&
    value.action !== "pickup_item" &&
    value.action !== "water_crop" &&
    value.action !== "water_pet_bowl" &&
    value.action !== "dismiss_modal" &&
    value.action !== "answer_dialogue" &&
    value.action !== "respond_level_up" &&
    value.action !== "water_slime_hutch_trough" &&
    value.action !== "refill_watering_can" &&
    value.action !== "harvest_crop" &&
    value.action !== "plant_seed" &&
    value.action !== "fertilize_tile" &&
    value.action !== "place_wood_fence" &&
    value.action !== "place_crab_pot" &&
    value.action !== "bait_crab_pot" &&
    value.action !== "clear_debris" &&
    value.action !== "machine_inspect" &&
    value.action !== "machine_load" &&
    value.action !== "machine_collect_output" &&
    value.action !== "npc_relationship" &&
    value.action !== "talk_to_npc" &&
    value.action !== "equip_wearable" &&
    value.action !== "unequip_wearable" &&
    value.action !== "dismount_transport" &&
    value.action !== "pet_animal" &&
    value.action !== "collect_animal_product" &&
    value.action !== "feed_animal" &&
    value.action !== "use_item" &&
    value.action !== "chop_tree_source" &&
    value.action !== "break_rock_source" &&
    value.action !== "clear_hoedirt" &&
    value.action !== "dig_artifact_spot" &&
    value.action !== "express_emote" &&
    value.action !== "face_direction" &&
    value.action !== "chest_store" &&
    value.action !== "chest_retrieve" &&
    value.action !== "chop_stump" &&
    value.action !== "plant_sapling" &&
    value.action !== "cut_weeds" &&
    value.action !== "cut_grass" &&
    value.action !== "clear_cask" &&
    value.action !== "dress_mannequin" &&
    value.action !== "set_sign_display" &&
    value.action !== "deposit_silo_hay" &&
    value.action !== "toggle_tool_light" &&
    value.action !== "scythe_crop" &&
    value.action !== "interact_npc_with_item" &&
    value.action !== "craft_item" &&
    value.action !== "cook_recipe" &&
    value.action !== "collect_crab_pot_output" &&
    value.action !== "ship_item" &&
    value.action !== "advance_day" &&
    value.action !== "harvest_bush" &&
    value.action !== "harvest_fruit_tree" &&
    value.action !== "shake_tree" &&
    value.action !== "take_pedestal_item" &&
    value.action !== "toggle_fence_gate"
  )
    return "unknown_action";
  if (!isRecord(value.args)) return "invalid_args";

  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== snapshot.revision)
    return "stale_snapshot";
  if (
    typeof value.deadlineMs !== "number" ||
    !Number.isFinite(value.deadlineMs) ||
    value.deadlineMs < nowMs ||
    // A co-op night waits on other players' native ready state, a host save and
    // a new-day transition, so it shares the navigation ceiling rather than the
    // ordinary one-minute action ceiling.
    value.deadlineMs >
      nowMs + (value.action === "navigate_to_destination" || value.action === "advance_day" ? 600_000 : 60_000)
  )
    return "invalid_deadline";
  // REMOVED HERE: the `actionable` short-circuit that returned `player_not_actionable` before the Mod could
  // see the request. (The sentence deliberately does not repeat the code verbatim: a comment that matches the
  // removed pattern makes a grep-based check report the defect as still present.)
  //
  // That line was a SECOND implementation of the Mod's admission rule, and it was the harmful one. WIA §4.2
  // makes the Mod the single authority on whether the actor's body is free, and `snapshot.actionable` is
  // false in exactly the situation the modal family exists for (a mounted dialogue), so the gateway refused
  // `dismiss_modal` and `answer_dialogue` at the moment they were the only way out - the whole
  // interruption-and-resume loop was unreachable on the Host path. It also collapsed five different holds
  // into one blind code before the Mod could name them. The request now travels, and the Mod answers with a
  // named hold (WorldModel.HoldReasonCode) plus the facts its countermeasure needs.
  if (!snapshot.capabilities.includes(value.action)) return "capability_not_declared";
  if (value.action === "move_to_tile") {
    if (!hasExactKeys(value.args, ["x", "y"])) return "invalid_args";
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_target_tile";
  } else if (value.action === "navigate_to_destination") {
    if (!hasExactKeys(value.args, ["destination"])) return "invalid_args";

    if (!isExecutionNavigationDestinationSelector(value.args.destination)) return "invalid_navigation_destination";
  } else if (value.action === "equip_tool") {
    if (!hasExactKeys(value.args, ["tool"])) return "invalid_args";

    if (!isToolSelector(value.args.tool)) return "invalid_tool_selector";
  } else if (value.action === "travel") {
    if (!hasExactKeys(value.args, ["x", "y"])) return "invalid_args";

    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_warp_source";
  } else if (value.action === "use_raft") {
    const args = value.args;
    if (!hasExactKeys(args, ["slot", "x", "y"])) return "invalid_args";
    if (!isToolSlot(args.slot) || !isTileCoordinate(args.x) || !isTileCoordinate(args.y)) return "invalid_raft_target";
    const targets = snapshot.raftTargets;
    if (!Array.isArray(targets) || !targets.some((target) => target.x === args.x && target.y === args.y))
      return "invalid_raft_target";
  } else if (value.action === "mount_transport") {
    const mountArgs = value.args;
    if (!hasExactKeys(mountArgs, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (!isTileCoordinate(mountArgs.x) || !isTileCoordinate(mountArgs.y) || !isOpaqueId(mountArgs.expectedTargetId))
      return "invalid_horse_target";
    if (
      !snapshot.horseTargets?.some(
        (target) =>
          target.targetId === mountArgs.expectedTargetId && target.x === mountArgs.x && target.y === mountArgs.y,
      )
    )
      return "invalid_horse_target";
  } else if (value.action === "enter_mine") {
    const mineArgs = value.args;
    if (!hasExactKeys(mineArgs, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (!isTileCoordinate(mineArgs.x) || !isTileCoordinate(mineArgs.y) || !isOpaqueId(mineArgs.expectedTargetId))
      return "invalid_mine_entrance";
    if (
      !snapshot.mineEntranceTargets?.some(
        (target) => target.targetId === mineArgs.expectedTargetId && target.x === mineArgs.x && target.y === mineArgs.y,
      )
    )
      return "invalid_mine_entrance";
  } else if (value.action === "ride_minecart") {
    // The station tile plus one exact published ride. Both x/y and the opaque
    // selector are mandatory: unlike `travel`, there is no "plain" form, so a
    // missing selector is a malformed request rather than an ordinary warp.
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_minecart_station";
    return validateMinecartRideTarget(value.args, snapshot);
  } else if (value.action === "select_mine_elevator_floor") {
    // Only the opaque floor target: the floor SET is derived by the Mod from the
    // live lowest level reached, so there is no coordinate or raw level to check
    // here beyond the shape and the opaque-id form.
    if (!hasExactKeys(value.args, ["expectedTargetId"])) return "invalid_args";
    if (!isOpaqueId(value.args.expectedTargetId)) return "invalid_mine_elevator_floor";
  } else if (value.action === "shop_purchase") {
    // An opaque shop target, the good's wire identity, and a positive quantity. The
    // Mod re-resolves the target and clamps the quantity against live stock and the
    // purse on the game thread, so nothing here needs to model pricing or stock.
    if (!hasExactKeys(value.args, ["expectedTargetId", "expectedQualifiedItemId", "quantity"])) return "invalid_args";
    if (!isOpaqueId(value.args.expectedTargetId)) return "invalid_shop_target";
    if (typeof value.args.expectedQualifiedItemId !== "string" || value.args.expectedQualifiedItemId.length === 0)
      return "invalid_expected_item";
    if (!Number.isSafeInteger(value.args.quantity) || (value.args.quantity as number) < 1) return "invalid_quantity";
  } else if (
    value.action === "withdraw_silo_hay" ||
    value.action === "use_obelisk" ||
    value.action === "clear_fish_pond" ||
    value.action === "toggle_animal_door"
  ) {
    // The shared { x, y, expectedTargetId } shape and no slot.
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_execution_request";
  } else if (value.action === "color_placed_object") {
    // The chest tile, the opaque target id, and the palette index the repaint asks for. The palette's own
    // SIZE belongs to the game (`DiscreteColorPicker.totalColors`), so the wire only refuses a negative
    // index; the Mod names `invalid_color_selection` for one past the palette.
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId", "colorSelection"])) return "invalid_execution_request";
    if (!Number.isSafeInteger(value.args.colorSelection) || (value.args.colorSelection as number) < 0)
      return "invalid_color_selection";
  } else if (value.action === "accept_daily_quest") {
    // The quest identity ALONE. `dailyQuestTargets` publishes no tile, and the Mod's own wire parser
    // pins exactly { expectedTargetId } (BridgeProtocol.ExecutionArgumentProperties, asserted by
    // AcceptDailyQuestActionTests). Demanding x/y here - as this branch once did, sharing the sibling
    // branch above - refused every request the Mod would have accepted, so the action was advertised
    // and could never execute.
    if (!hasExactKeys(value.args, ["expectedTargetId"])) return "invalid_execution_request";
  } else if (value.action === "accept_special_order" || value.action === "claim_museum_reward") {
    // The offer's / reward set's identity ALONE. Neither projection publishes a tile, and the Mod's own
    // wire parser pins exactly { expectedTargetId } for both (BridgeProtocol.ExecutionArgumentProperties),
    // so this branch is not the sibling { x, y, expectedTargetId } shape.
    if (!hasExactKeys(value.args, ["expectedTargetId"])) return "invalid_execution_request";
  } else if (value.action === "send_multiplayer_chat") {
    // One string and nothing else, bounded by the SAME length the Mod enforces (its
    // ChatMessageMaximumLength): an argument the wire accepts but the handler refuses would be a
    // registered capability that cannot be invoked.
    if (!hasExactKeys(value.args, ["text"])) return "invalid_execution_request";
    if (typeof value.args.text !== "string" || value.args.text.trim().length === 0) return "invalid_execution_request";
    if (value.args.text.length > 256) return "invalid_execution_request";
  } else if (value.action === "name_entity") {
    // One string and nothing else - the name to write. Bounded by the SAME length the Mod
    // enforces (EntityNameMaximumLength): an argument the wire accepts but the handler refuses
    // would be a registered capability that cannot be invoked.
    if (!hasExactKeys(value.args, ["text"])) return "invalid_execution_request";
    if (typeof value.args.text !== "string" || value.args.text.trim().length === 0) return "invalid_execution_request";
    if (value.args.text.length > 64) return "invalid_execution_request";
  } else if (value.action === "build_farm_building") {
    // The Data/Buildings type id, the top-left footprint tile and the opaque site id. The Mod
    // re-resolves the type against Game1.buildingData and the site against the LIVE world.
    if (!hasExactKeys(value.args, ["buildingType", "x", "y", "expectedTargetId"])) return "invalid_execution_request";
    if (
      typeof value.args.buildingType !== "string" ||
      value.args.buildingType.length === 0 ||
      value.args.buildingType.length > 128
    )
      return "invalid_build_building_type";
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_build_site";
    if (typeof value.args.expectedTargetId !== "string" || !isOpaqueId(value.args.expectedTargetId))
      return "invalid_build_target";
  } else if (value.action === "collect_building_chest_output") {
    // All four take the shared { x, y, expectedTargetId } shape and no slot.
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_execution_request";
  } else if (value.action === "claim_mail_attachment") {
    // The mailbox tile plus the opaque id that binds the pending count AND the head letter.
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_execution_request";
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_mailbox_target";
  } else if (value.action === "pan_ore") {
    // The pan slot plus the live ore-pan site the Mod re-resolves against `orePanPoint`.
    if (!hasExactKeys(value.args, ["slot", "x", "y"])) return "invalid_execution_request";
    if (!Number.isSafeInteger(value.args.slot) || (value.args.slot as number) < 0) return "invalid_pan_slot";
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_pan_site";
  } else if (value.action === "use_warp_item") {
    // The slot that must hold the totem plus the totem's wire identity; both are re-read on
    // the game thread, so this only checks the shape.
    if (!hasExactKeys(value.args, ["slot", "expectedQualifiedItemId"])) return "invalid_execution_request";
    if (!Number.isSafeInteger(value.args.slot) || (value.args.slot as number) < 0) return "invalid_warp_item_slot";
    if (typeof value.args.expectedQualifiedItemId !== "string" || value.args.expectedQualifiedItemId.length === 0)
      return "invalid_expected_item";
  } else if (value.action === "load_building_chest") {
    // load_building_chest carries a required `slot` on top of that shape: the native Load branch
    // reads who.ActiveObject (the HELD item, i.e. Items[CurrentToolIndex]), not "some item in the
    // pack", so the request must name the slot that is already the held one.
    if (!hasExactKeys(value.args, ["x", "y", "slot", "expectedTargetId"])) return "invalid_execution_request";
  } else if (value.action === "redeem_prize_ticket") {
    // No client-supplied target at all: the prize track head is the game's own `ticketPrizesClaimed`
    // state and the subject is the actor's own ticket stack, so the args must be exactly empty - the
    // Mod's own wire parser pins the empty set (BridgeProtocol.ExecutionArgumentProperties). A target
    // id "for safety" would make every request invalid.
    if (!hasExactKeys(value.args, [])) return "invalid_args";
  } else if (value.action === "tailor_clothing" || value.action === "dye_clothing_with_item") {
    // The sewing-machine pair names the TWO backpack slots and the opaque pair identity discovery
    // published; there is no coordinate. The Mod's own wire parser pins exactly this shape
    // (BridgeProtocol.ExecutionArgumentProperties).
    if (!hasExactKeys(value.args, ["leftSlot", "rightSlot", "expectedTargetId"])) return "invalid_execution_request";
    if (!isNonNegativeSafeInteger(value.args.leftSlot) || !isNonNegativeSafeInteger(value.args.rightSlot))
      return "invalid_execution_request";
  } else if (value.action === "ride_bus") {
    // The ticket machine of the current location is the whole input: there is no
    // client-supplied target to validate, so the args must be exactly empty.
    if (!hasExactKeys(value.args, [])) return "invalid_args";
  } else if (value.action === "enter_exit") {
    if (!hasExactKeys(value.args, ["x", "y"])) return "invalid_args";

    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_door_target";
  } else if (value.action === "till_soil") {
    if (!hasExactKeys(value.args, ["x", "y"])) return "invalid_args";

    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_soil_target";
  } else if (value.action === "pickup_forage") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedQualifiedItemId", "expectedTargetId", "sceneTarget"]))
      return "invalid_args";

    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId) ||
      !isObservationBindingV1(value.args.sceneTarget)
    )
      return "invalid_forage_target";
  } else if (value.action === "pickup_item") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";

    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_item_target";
  } else if (value.action === "refill_watering_can") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_refill_watering_can_target";
  } else if (value.action === "water_crop") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_crop_target";
  } else if (value.action === "water_pet_bowl") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_pet_bowl_target";
  } else if (value.action === "dismiss_modal") {
    if (!hasExactKeys(value.args, [])) return "invalid_args";
  } else if (value.action === "answer_dialogue") {
    if (!hasExactKeys(value.args, ["responseKey"])) return "invalid_args";
    if (
      typeof value.args.responseKey !== "string" ||
      value.args.responseKey.length < 1 ||
      value.args.responseKey.length > 128
    )
      return "invalid_response_key";
  } else if (value.action === "respond_level_up") {
    // The pair is the binding, so the Host refuses an unshaped request before it can reach the Mod: a persistent
    // save write must not be dispatchable without naming the level-up it is for.
    //
    // The three values are the Mod's OWN published vocabulary (`FarmhandActionCatalog.LevelUpChoiceEnum`,
    // projected onto the descriptor and onto the generated action surface) and the Mod's registry acceptance
    // refuses anything outside it on the game thread. They are spelled here so the refusal is specific and
    // pre-bridge; `game-tools-argument-contract.test.ts` holds this list and the published one equal, and a
    // value the Mod's contract declares legal can never be refused here.
    if (!hasExactKeys(value.args, ["choice", "expectedSkill", "expectedLevel"])) return "invalid_args";
    if (
      typeof value.args.choice !== "string" ||
      !["confirm", "branch_a", "branch_b"].includes(value.args.choice) ||
      !Number.isSafeInteger(value.args.expectedSkill) ||
      (value.args.expectedSkill as number) < 0 ||
      (value.args.expectedSkill as number) > 5 ||
      !Number.isSafeInteger(value.args.expectedLevel) ||
      (value.args.expectedLevel as number) < 1 ||
      (value.args.expectedLevel as number) > 10
    )
      return "invalid_level_up_choice";
  } else if (value.action === "water_slime_hutch_trough") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_slime_hutch_trough_target";
  } else if (value.action === "harvest_crop") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";

    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128
    )
      return "invalid_harvest_target";
  } else if (value.action === "plant_seed") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_seed_target";
  } else if (value.action === "fertilize_tile") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_fertilizer_target";
  } else if (
    value.action === "place_wood_fence" ||
    value.action === "place_crab_pot" ||
    value.action === "bait_crab_pot"
  ) {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      value.args.expectedQualifiedItemId !==
        (value.action === "place_wood_fence" ? "(O)322" : value.action === "place_crab_pot" ? "(O)710" : "(O)685") ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return value.action === "place_wood_fence"
        ? "invalid_wood_fence_target"
        : value.action === "bait_crab_pot"
          ? "invalid_bait_crab_pot_target"
          : "invalid_crab_pot_target";
  } else if (value.action === "clear_debris") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_debris_target";
  } else if (value.action === "machine_inspect") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_machine_target";
  } else if (value.action === "machine_load") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      value.args.expectedQualifiedItemId !== "(O)433" ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_machine_load_target";
  } else if (value.action === "machine_collect_output") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["x", "y", "expectedTargetId"]) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_machine_collect_target";
  } else if (value.action === "npc_relationship") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_npc_relationship_target";
  } else if (value.action === "talk_to_npc") {
    // The NPC family's shared shape: the opaque family target id names the villager and
    // x/y is only the published tile the walk leg heads for. The Mod re-resolves the person
    // from the id on the game thread, so there is nothing else to model here.
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_npc_talk_target";
  } else if (value.action === "equip_wearable") {
    // The wearable family's shape: an opaque body-slot target id, the backpack slot the item comes
    // from, and that item's wire identity. The Mod re-resolves the slot and its occupant on the
    // game thread, so there is nothing else to model here.
    if (!hasExactKeys(value.args, ["slot", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_equip_wearable_target";
  } else if (value.action === "unequip_wearable") {
    // No item id: the item is whatever the named body slot already holds, and `slot` is the EMPTY
    // backpack slot the removed wearable must land in.
    if (!hasExactKeys(value.args, ["slot", "expectedTargetId"])) return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_unequip_wearable_target";
  } else if (value.action === "dismount_transport") {
    // No arguments at all: the subject is the actor's own mount and its readiness is native state.
    if (!hasExactKeys(value.args, [])) return "invalid_args";
  } else if (value.action === "pet_animal") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_pet_target";
  } else if (value.action === "collect_animal_product") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_animal_product_target";
  } else if (value.action === "feed_animal") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_feed_trough_target";
  } else if (value.action === "break_rock_source") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_break_rock_source_target";
  } else if (value.action === "dig_artifact_spot") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_dig_artifact_spot_target";
  } else if (value.action === "clear_hoedirt") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_clear_hoedirt_target";
  } else if (value.action === "chop_tree_source") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";

    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_chop_tree_source_target";
  } else if (value.action === "use_item") {
    if (!hasExactKeys(value.args, ["slot", "expectedQualifiedItemId"])) return "invalid_args";

    if (
      !isToolSlot(value.args.slot) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128
    )
      return "invalid_item_use_target";
  } else if (value.action === "express_emote") {
    if (!hasExactKeys(value.args, ["emote"])) return "invalid_args";

    if (typeof value.args.emote !== "string" || value.args.emote.length === 0 || value.args.emote.length > 64)
      return "invalid_emote";
  } else if (value.action === "face_direction") {
    if (!hasExactKeys(value.args, ["direction"])) return "invalid_args";

    if (
      typeof value.args.direction !== "string" ||
      value.args.direction.length === 0 ||
      value.args.direction.length > 64
    )
      return "invalid_direction";
  } else if (value.action === "chest_store" || value.action === "chest_retrieve") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_chest_target";
  } else if (value.action === "clear_cask") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_cask_target";
  } else if (
    value.action === "dress_mannequin" ||
    value.action === "set_sign_display" ||
    value.action === "deposit_silo_hay"
  ) {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_facility_target";
  } else if (value.action === "toggle_tool_light") {
    if (!hasExactKeys(value.args, ["slot", "x", "y"])) return "invalid_args";
    if (!isToolSlot(value.args.slot) || !isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y))
      return "invalid_lantern_slot";
  } else if (
    value.action === "chop_stump" ||
    value.action === "cut_weeds" ||
    value.action === "cut_grass" ||
    value.action === "scythe_crop"
  ) {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_tool_target";
  } else if (value.action === "plant_sapling") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_sapling_target";
  } else if (value.action === "interact_npc_with_item") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_npc_item_interaction_target";
  } else if (value.action === "craft_item" || value.action === "cook_recipe") {
    if (!hasExactKeys(value.args, ["expectedTargetId"])) return "invalid_args";
    if (typeof value.args.expectedTargetId !== "string" || !isOpaqueId(value.args.expectedTargetId))
      return "invalid_recipe_target";
  } else if (value.action === "collect_crab_pot_output") {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_crab_pot_target";
  } else if (value.action === "ship_item") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"]))
      return "invalid_args";
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_ship_target";
  } else if (
    ["harvest_bush", "harvest_fruit_tree", "shake_tree", "take_pedestal_item", "toggle_fence_gate"].includes(
      value.action,
    )
  ) {
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return `invalid_${value.action}_target`;
  } else if (value.action === "advance_day") {
    // No client-supplied target: the bed and the ready state are native facts.
    if (!hasExactKeys(value.args, [])) return "invalid_args";
  }
  return null;
}

export function serializeBounded(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error("message_not_serializable");
  }
  if (json === undefined) throw new Error("message_not_serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
  if (
    isRecord(value) &&
    (value.type === "body_node_admission_challenge" ||
      value.type === "body_node_admission_grant" ||
      value.type === "body_node_admission_result")
  ) {
    const serialized = JSON.parse(json) as Record<string, unknown>;
    const envelopeError = validateEnvelope(serialized, serialized.scope as Scope, serialized.timestampMs as number);
    const payloadError = !isRecord(serialized.payload)
      ? "invalid_payload"
      : serialized.type === "body_node_admission_grant"
        ? validateBodyNodeAdmissionGrant(serialized.payload)
        : serialized.type === "body_node_admission_result"
          ? validateBodyNodeAdmissionResult(serialized.payload)
          : validateBodyNodeAdmissionChallenge(serialized.payload);
    if (envelopeError || payloadError) throw new Error(envelopeError ?? payloadError!);
  }
  return json;
}

/**
 * One array-valued snapshot family: the wire field, the entry cap, and the entry predicate.
 *
 * Every family is declared ONCE here. `diagnoseSnapshot` walks this table to NAME the offending
 * field (and, where the publisher needs it, the offending entry) and `validateSnapshot` walks the
 * same table to decide. The two hand-written lists this replaced had already drifted: families were
 * validated while the diagnostic returned its SUCCESS marker, which is how a rejected snapshot
 * surfaced as `bridge_disconnected:accepted` instead of naming its culprit.
 *
 * The table is the Host's projection of `protocol/bridge-v1.schema.json`'s `$defs.snapshot`;
 * `schema-contract.test.ts` proves the field set and every cap against the schema, so a family the
 * schema declares cannot go unvalidated here and a bound changed on one side alone fails the suite.
 */
export type SnapshotFamilyRule = Readonly<{
  field: keyof Snapshot;
  /** Entry cap. Must equal the schema's `maxItems` for the same field. */
  maxItems: number;
  accepts: (entry: unknown) => boolean;
  /** Set only for families whose publisher needs the offending entry named, not just the field. */
  narrate?: (targets: unknown, rule: SnapshotFamilyRule) => string;
}>;

export const SNAPSHOT_FAMILY_RULES: readonly SnapshotFamilyRule[] = Object.freeze([
  { field: "worldObjectTargets", maxItems: 48, accepts: isWorldObjectTargetFact },
  { field: "farmBuildingTargets", maxItems: 16, accepts: isFarmBuildingTargetFact },
  { field: "dailyQuestTargets", maxItems: 16, accepts: isDailyQuestTargetFact },
  { field: "specialOrderTargets", maxItems: 16, accepts: isSpecialOrderTargetFact },
  { field: "activeSpecialOrderKeys", maxItems: 16, accepts: (entry) => typeof entry === "string" && entry.length > 0 },
  { field: "museumRewardTargets", maxItems: 16, accepts: isMuseumRewardTargetFact },
  { field: "tailoringTargets", maxItems: 32, accepts: isTailoringTargetFact, narrate: namedEntryReason },
  { field: "colorTargets", maxItems: 32, accepts: isColorTargetFact, narrate: namedEntryReason },
  { field: "wearableTargets", maxItems: 16, accepts: isWearableTargetFact },
  { field: "warpItemTargets", maxItems: 16, accepts: isWarpItemTargetFact },
  { field: "panSites", maxItems: 16, accepts: isPanSiteFact },
  { field: "mailboxTargets", maxItems: 16, accepts: isMailboxTargetFact },
  { field: "fishPondTargets", maxItems: 16, accepts: isFishPondTargetFact },
  { field: "warps", maxItems: 512, accepts: isWarp },
  { field: "doorTargets", maxItems: 64, accepts: isWarp },
  { field: "soilTiles", maxItems: 64, accepts: isSoilTile },
  { field: "toolSlots", maxItems: 36, accepts: isToolSlotFact },
  { field: "forageTargets", maxItems: 64, accepts: isForageTargetFact },
  { field: "itemTargets", maxItems: 64, accepts: isItemTargetFact },
  { field: "wateringCanFacts", maxItems: 36, accepts: isWateringCanFact },
  { field: "refillWateringCanTargets", maxItems: 8, accepts: isRefillWateringCanTargetFact },
  { field: "cropTargets", maxItems: 64, accepts: isCropTargetFact },
  { field: "petBowlTargets", maxItems: 8, accepts: isPetBowlTargetFact },
  { field: "slimeHutchTroughTargets", maxItems: 4, accepts: isSlimeHutchTroughTargetFact },
  { field: "harvestTargets", maxItems: 64, accepts: isHarvestTargetFact },
  { field: "bushTargets", maxItems: 32, accepts: isBushTargetFact },
  { field: "fruitTreeTargets", maxItems: 16, accepts: isBushTargetFact },
  { field: "shakeTreeTargets", maxItems: 16, accepts: isBushTargetFact },
  { field: "pedestalTargets", maxItems: 16, accepts: isPedestalTargetFact },
  { field: "fenceGateTargets", maxItems: 16, accepts: isFenceGateTargetFact },
  { field: "seedTargets", maxItems: 64, accepts: isSeedTargetFact },
  { field: "fertilizerTargets", maxItems: 64, accepts: isSeedTargetFact },
  { field: "debrisTargets", maxItems: 64, accepts: isDebrisTargetFact },
  { field: "rockSourceTargets", maxItems: 8, accepts: isRockSourceTargetFact },
  { field: "clearHoeDirtTargets", maxItems: 8, accepts: isClearHoeDirtTargetFact },
  { field: "artifactSpotTargets", maxItems: 8, accepts: isArtifactSpotTargetFact },
  { field: "artifactSpotResultTargets", maxItems: 1, accepts: isArtifactSpotResultTargetFact },
  { field: "machineTargets", maxItems: 64, accepts: isMachineTargetFact },
  { field: "treeChopSourceTargets", maxItems: 64, accepts: isTreeChopSourceTargetFact },
  { field: "treeChopResultTargets", maxItems: 64, accepts: isTreeChopResultTargetFact },
  { field: "treeStumpTargets", maxItems: 16, accepts: isTreeStumpTargetFact },
  { field: "treeSaplingTargets", maxItems: 64, accepts: isTreeSaplingTargetFact },
  { field: "weedTargets", maxItems: 16, accepts: isWeedTargetFact },
  { field: "grassTargets", maxItems: 16, accepts: isGrassTargetFact },
  { field: "caskTargets", maxItems: 16, accepts: isCaskTargetFact },
  { field: "mannequinTargets", maxItems: 16, accepts: isFacilityTargetFact },
  { field: "signTargets", maxItems: 16, accepts: isSignTargetFact },
  { field: "siloTargets", maxItems: 16, accepts: isSiloTargetFact },
  { field: "lanternSlots", maxItems: 16, accepts: isLanternSlotFact },
  { field: "scytheCropTargets", maxItems: 16, accepts: isScytheCropTargetFact },
  { field: "npcRelationshipTargets", maxItems: 64, accepts: isNpcRelationshipTargetFact },
  { field: "villagerWhereabouts", maxItems: 64, accepts: isVillagerWhereaboutsFact },
  { field: "harvestWhereabouts", maxItems: 64, accepts: isHarvestWhereaboutsFact },
  { field: "petTargets", maxItems: 16, accepts: isPetTargetFact },
  { field: "animalProductTargets", maxItems: 32, accepts: isAnimalProductTargetFact },
  { field: "feedTroughTargets", maxItems: 32, accepts: isFeedTroughTargetFact },
  { field: "chestStoreTargets", maxItems: 16, accepts: isChestStoreTargetFact },
  { field: "chestRetrieveTargets", maxItems: 16, accepts: isChestRetrieveTargetFact },
  { field: "inventoryItemFacts", maxItems: 36, accepts: isInventoryItemFact },
  { field: "foodTargets", maxItems: 36, accepts: isFoodTargetFact },
  { field: "shippingBinTargets", maxItems: 1, accepts: isShippingBinTargetFact },
  { field: "craftingRecipeTargets", maxItems: 64, accepts: isRecipeTargetFact },
  { field: "cookingRecipeTargets", maxItems: 64, accepts: isRecipeTargetFact },
  { field: "cookingStationTargets", maxItems: 16, accepts: isCookingStationTargetFact },
  { field: "mineElevatorFloorTargets", maxItems: 32, accepts: isMineElevatorFloorFact },
  { field: "minecartTargets", maxItems: 24, accepts: isMinecartTargetFact },
  { field: "raftTargets", maxItems: 16, accepts: isRaftTargetFact },
  { field: "woodFenceTargets", maxItems: 16, accepts: isWoodFenceTargetFact },
  { field: "woodFenceResultTargets", maxItems: 1, accepts: isWoodFenceResultTargetFact },
  { field: "crabPotTargets", maxItems: 16, accepts: isCrabPotTargetFact },
  { field: "crabPotResultTargets", maxItems: 1, accepts: isCrabPotResultTargetFact },
  { field: "crabPotCollectTargets", maxItems: 16, accepts: isCrabPotCollectTargetFact },
  { field: "baitCrabPotTargets", maxItems: 16, accepts: isBaitCrabPotTargetFact },
  { field: "baitCrabPotResultTargets", maxItems: 1, accepts: isBaitCrabPotTargetFact },
  { field: "shopTargets", maxItems: 32, accepts: isShopTargetFact },
  { field: "horseTargets", maxItems: 16, accepts: isHorseTargetFact },
  { field: "mineEntranceTargets", maxItems: 16, accepts: isMineEntranceTargetFact },
  { field: "animalDoorTargets", maxItems: 32, accepts: isAnimalDoorTargetFact },
  { field: "obeliskTargets", maxItems: 32, accepts: isObeliskTargetFact },
  { field: "buildingChestTargets", maxItems: 16, accepts: isBuildingChestTargetFact },
]);

/** The verdict for one family, or null when the field is absent or acceptable. */
function snapshotFamilyVerdict(value: Record<string, unknown>, rule: SnapshotFamilyRule): string | null {
  const targets = value[rule.field];
  if (targets === undefined) return null;
  if (Array.isArray(targets) && targets.length <= rule.maxItems && targets.every(rule.accepts)) return null;
  return rule.narrate?.(targets, rule) ?? `invalid_snapshot:${rule.field}`;
}

/**
 * The reason a family with opaque entries was refused, naming why and which entry: an entry the Mod
 * emitted but the Host cannot read is exactly what a field-only message hides.
 */
function namedEntryReason(targets: unknown, rule: SnapshotFamilyRule): string {
  if (!Array.isArray(targets)) return `invalid_snapshot:${rule.field}:not_an_array`;
  if (targets.length > rule.maxItems) return `invalid_snapshot:${rule.field}:count=${targets.length}`;
  const index = targets.findIndex((entry) => !rule.accepts(entry));
  const entry: unknown = targets[index];
  return `invalid_snapshot:${rule.field}:entry${index}:keys=${
    isRecord(entry) ? Object.keys(entry).join("|") : typeof entry
  }`;
}

/** The first family its table rule refuses, or null when every family is acceptable. */
function firstSnapshotFamilyVerdict(value: Record<string, unknown>): string | null {
  for (const rule of SNAPSHOT_FAMILY_RULES) {
    const verdict = snapshotFamilyVerdict(value, rule);
    if (verdict !== null) return verdict;
  }
  return null;
}

/** `acceptedDailyQuest` is a scalar, but both paths report it, so it lives beside the families. */
function acceptedDailyQuestVerdict(value: Record<string, unknown>): string | null {
  return value.acceptedDailyQuest !== undefined && typeof value.acceptedDailyQuest !== "boolean"
    ? "invalid_snapshot:acceptedDailyQuest"
    : null;
}

function diagnoseSnapshot(value: Record<string, unknown>): string {
  const familyVerdict = firstSnapshotFamilyVerdict(value);
  if (familyVerdict !== null) return familyVerdict;
  const dailyQuestVerdict = acceptedDailyQuestVerdict(value);
  if (dailyQuestVerdict !== null) return dailyQuestVerdict;
  if (!Number.isSafeInteger(value.revision)) return "invalid_snapshot:revision";
  if (typeof value.location !== "string") return "invalid_snapshot:location";
  if (!isRecord(value.tile) || !isFiniteNumber(value.tile.x) || !isFiniteNumber(value.tile.y))
    return "invalid_snapshot:tile";
  if (!isFiniteNumber(value.stamina)) return "invalid_snapshot:stamina";
  if (typeof value.exhausted !== "boolean") return "invalid_snapshot:exhausted";
  // The disposition is a CLOSED set, checked where the decision is made: a planner that switched on an
  // unknown kind would silently treat it as not-a-disposition. An earlier version of this check landed in
  // `diagnoseSnapshot` instead - the two functions share the `exhausted` line, and the edit took the first
  // occurrence - so the decision path accepted a kind the diagnostic would have named.
  if (value.actorDispositionKind !== undefined) {
    if (typeof value.actorDispositionKind !== "string") return "invalid_snapshot:actorDispositionKind";
    if (!["idle", "modal", "event", "pass_out", "transient"].includes(value.actorDispositionKind))
      return `invalid_snapshot:actorDispositionKind:${value.actorDispositionKind}`;
    if (
      value.actorDispositionDetail !== undefined &&
      value.actorDispositionDetail !== null &&
      typeof value.actorDispositionDetail !== "string"
    )
      return "invalid_snapshot:actorDispositionDetail";
    if (value.actorDispositionActionOwned !== undefined && typeof value.actorDispositionActionOwned !== "boolean")
      return "invalid_snapshot:actorDispositionActionOwned";
  }
  if (!isFiniteNumber(value.health)) return "invalid_snapshot:health";
  if (typeof value.actionable !== "boolean") return "invalid_snapshot:actionable";
  if (!isBcp47Locale(value.presentationLocale)) return "invalid_snapshot:presentationLocale";
  // Time context: bounded non-negative integers, so no consumer can be handed a
  // nonsense clock. Zero is the "unknown" value the Mod uses when the world is
  // not ready, which is why non-negative and not positive.
  if (!isNonNegativeSafeInteger(value.timeOfDay) || value.timeOfDay > 2600) return "invalid_snapshot:timeOfDay";
  if (!isNonNegativeSafeInteger(value.dayOfMonth) || value.dayOfMonth > 28) return "invalid_snapshot:dayOfMonth";
  if (!isNonNegativeSafeInteger(value.seasonIndex) || value.seasonIndex > 3) return "invalid_snapshot:seasonIndex";
  if (!isNonNegativeSafeInteger(value.year)) return "invalid_snapshot:year";
  if (value.weather !== undefined && value.weather !== null && !isWeatherToken(value.weather))
    return "invalid_snapshot:weather";
  if (value.currentTool !== undefined && value.currentTool !== null && typeof value.currentTool !== "string")
    return "invalid_snapshot:currentTool";
  if (value.inventorySlots !== undefined && !Number.isSafeInteger(value.inventorySlots))
    return "invalid_snapshot:inventorySlots";
  if (
    value.artifactSpotFarmSourceCount !== undefined &&
    value.artifactSpotFarmSourceCount !== null &&
    (typeof value.artifactSpotFarmSourceCount !== "number" ||
      !Number.isSafeInteger(value.artifactSpotFarmSourceCount) ||
      value.artifactSpotFarmSourceCount < 0)
  )
    return "invalid_snapshot:artifactSpotFarmSourceCount";
  if (!isStringArray(value.capabilities)) return "invalid_snapshot:capabilities";
  if (!isNonNegativeSafeInteger(value.catalogRevision)) return "invalid_snapshot:catalogRevision";
  if (!isUniqueOpaqueIdArray(value.enabledActionIds)) return "invalid_snapshot:enabledActionIds";
  if (
    value.activeExecution !== undefined &&
    value.activeExecution !== null &&
    (!isRecord(value.activeExecution) || validateActiveExecution(value.activeExecution) !== null)
  )
    return "invalid_snapshot:activeExecution";
  // The key set, which this function did NOT check: an unexpected key therefore made it return its
  // "accepted" sentinel, the bridge's guard discarded that, and the operator saw a bare
  // `invalid_snapshot` naming nothing. Keys are schema names, so naming them leaks no player data.
  if (!hasOnlyKeys(value, SNAPSHOT_KEYS)) {
    const unexpected = Object.keys(value)
      .filter((key) => !(SNAPSHOT_KEYS as readonly string[]).includes(key))
      .sort();
    if (unexpected.length > 0) return `invalid_snapshot:unexpected_keys:${unexpected.join(",")}`;
    return "invalid_snapshot:missing_required_key";
  }

  return "accepted";
}

/**
 * The non-family snapshot members the decision path requires.
 *
 * These rules are deliberately NOT shared with `diagnoseSnapshot`: three of them genuinely differ
 * (the exact `tile` key set is only demanded here, `weather` may not be null here, and the disposition
 * is only type-checked here while the diagnostic enforces the closed set), so merging the two would
 * change which snapshots the bridge admits.
 */
function snapshotDecisionScalarsAccepted(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.revision) &&
    typeof value.location === "string" &&
    isRecord(value.tile) &&
    hasExactKeys(value.tile, ["x", "y"]) &&
    isFiniteNumber(value.tile.x) &&
    isFiniteNumber(value.tile.y) &&
    isFiniteNumber(value.stamina) &&
    typeof value.exhausted === "boolean" &&
    (value.actorDispositionKind === undefined || typeof value.actorDispositionKind === "string") &&
    isFiniteNumber(value.health) &&
    typeof value.actionable === "boolean" &&
    (value.currentTool === undefined || value.currentTool === null || typeof value.currentTool === "string") &&
    (value.inventorySlots === undefined || Number.isSafeInteger(value.inventorySlots)) &&
    isBcp47Locale(value.presentationLocale) &&
    isNonNegativeSafeInteger(value.timeOfDay) &&
    value.timeOfDay <= 2600 &&
    isNonNegativeSafeInteger(value.dayOfMonth) &&
    value.dayOfMonth <= 28 &&
    isNonNegativeSafeInteger(value.seasonIndex) &&
    value.seasonIndex <= 3 &&
    isNonNegativeSafeInteger(value.year) &&
    (value.weather === undefined || isWeatherToken(value.weather)) &&
    (value.artifactSpotFarmSourceCount === undefined ||
      value.artifactSpotFarmSourceCount === null ||
      (typeof value.artifactSpotFarmSourceCount === "number" &&
        Number.isSafeInteger(value.artifactSpotFarmSourceCount) &&
        value.artifactSpotFarmSourceCount >= 0)) &&
    isStringArray(value.capabilities) &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    isUniqueOpaqueIdArray(value.enabledActionIds) &&
    (value.activeExecution === undefined ||
      value.activeExecution === null ||
      (isRecord(value.activeExecution) && validateActiveExecution(value.activeExecution) === null))
  );
}

/**
 * The decision path. Every array family is decided by `SNAPSHOT_FAMILY_RULES`, so a family can no
 * longer be validated here and forgotten by the diagnostic. The reason stays the bare
 * `invalid_snapshot` that `local-stardew-bridge` resolves through `diagnoseSnapshot` into the field
 * and entry name; that is why a family fault is reported by name on the diagnostic path and not here.
 */
function validateSnapshot(value: Record<string, unknown>): string | null {
  if (!hasOnlyKeys(value, SNAPSHOT_KEYS)) return "invalid_snapshot";
  if (firstSnapshotFamilyVerdict(value) !== null) return "invalid_snapshot";
  if (acceptedDailyQuestVerdict(value) !== null) return "invalid_snapshot";
  return snapshotDecisionScalarsAccepted(value) ? null : "invalid_snapshot";
}

function validateExecutionRequestEnvelope(value: Record<string, unknown>): string | null {
  return (hasExactKeys(value, ["requestId", "idempotencyKey", "action", "args", "expectedRevision", "deadlineMs"]) &&
    isOpaqueId(value.requestId) &&
    isOpaqueId(value.idempotencyKey) &&
    value.action === "clear_fish_pond") ||
    value.action === "build_farm_building" ||
    value.action === "send_multiplayer_chat" ||
    value.action === "name_entity" ||
    value.action === "accept_daily_quest" ||
    value.action === "accept_special_order" ||
    value.action === "claim_museum_reward" ||
    value.action === "redeem_prize_ticket" ||
    value.action === "tailor_clothing" ||
    value.action === "dye_clothing_with_item" ||
    value.action === "color_placed_object" ||
    value.action === "place_owned_object" ||
    value.action === "remove_placed_item" ||
    value.action === "break_container_source" ||
    value.action === "equip_wearable" ||
    value.action === "unequip_wearable" ||
    value.action === "dismount_transport" ||
    value.action === "load_building_chest" ||
    value.action === "collect_building_chest_output" ||
    value.action === "use_warp_item" ||
    value.action === "pan_ore" ||
    value.action === "claim_mail_attachment" ||
    ((value.action === "move_to_tile" ||
      value.action === "navigate_to_destination" ||
      value.action === "equip_tool" ||
      value.action === "travel" ||
      value.action === "ride_minecart" ||
      value.action === "select_mine_elevator_floor" ||
      value.action === "shop_purchase" ||
      value.action === "ride_bus" ||
      value.action === "withdraw_silo_hay" ||
      value.action === "use_obelisk" ||
      value.action === "toggle_animal_door" ||
      value.action === "use_raft" ||
      value.action === "mount_transport" ||
      value.action === "enter_mine" ||
      value.action === "enter_exit" ||
      value.action === "till_soil" ||
      value.action === "pickup_forage" ||
      value.action === "pickup_item" ||
      value.action === "water_crop" ||
      value.action === "water_pet_bowl" ||
      value.action === "dismiss_modal" ||
      value.action === "answer_dialogue" ||
      value.action === "respond_level_up" ||
      value.action === "water_slime_hutch_trough" ||
      value.action === "refill_watering_can" ||
      value.action === "harvest_crop" ||
      value.action === "plant_seed" ||
      value.action === "fertilize_tile" ||
      value.action === "place_wood_fence" ||
      value.action === "place_crab_pot" ||
      value.action === "bait_crab_pot" ||
      value.action === "clear_debris" ||
      value.action === "machine_inspect" ||
      value.action === "machine_load" ||
      value.action === "machine_collect_output" ||
      value.action === "npc_relationship" ||
      value.action === "talk_to_npc" ||
      value.action === "pet_animal" ||
      value.action === "collect_animal_product" ||
      value.action === "feed_animal" ||
      value.action === "use_item" ||
      value.action === "chop_tree_source" ||
      value.action === "break_rock_source" ||
      value.action === "clear_hoedirt" ||
      value.action === "dig_artifact_spot" ||
      value.action === "express_emote" ||
      value.action === "face_direction" ||
      value.action === "chest_store" ||
      value.action === "chest_retrieve" ||
      value.action === "chop_stump" ||
      value.action === "plant_sapling" ||
      value.action === "cut_weeds" ||
      value.action === "cut_grass" ||
      value.action === "clear_cask" ||
      value.action === "dress_mannequin" ||
      value.action === "set_sign_display" ||
      value.action === "deposit_silo_hay" ||
      value.action === "toggle_tool_light" ||
      value.action === "scythe_crop" ||
      value.action === "interact_npc_with_item" ||
      value.action === "craft_item" ||
      value.action === "cook_recipe" ||
      value.action === "collect_crab_pot_output" ||
      value.action === "ship_item" ||
      value.action === "harvest_bush" ||
      value.action === "harvest_fruit_tree" ||
      value.action === "shake_tree" ||
      value.action === "take_pedestal_item" ||
      value.action === "toggle_fence_gate" ||
      value.action === "advance_day") &&
      isRecord(value.args) &&
      Object.keys(value.args).length <= 8 &&
      Number.isSafeInteger(value.expectedRevision) &&
      typeof value.deadlineMs === "number" &&
      Number.isFinite(value.deadlineMs))
    ? null
    : "invalid_execution_request";
}

function validateWorldObjectActionArgs(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.args)) return null;
  // Only the three world-object actions are this helper's business; everything else is validated by
  // validateExecutionRequestEnvelope and the per-action chain.
  if (
    value.action !== "place_owned_object" &&
    value.action !== "remove_placed_item" &&
    value.action !== "break_container_source"
  )
    return null;
  const args = value.args;
  if (value.action === "place_owned_object") {
    // The tile, the backpack slot holding the item, that item's wire identity and the opaque
    // placement target: the native placement path needs the item to be the HELD one, so the slot
    // and the identity are both mandatory.
    if (!hasExactKeys(args, ["x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";
    if (!isTileCoordinate(args.x) || !isTileCoordinate(args.y)) return "invalid_placement_tile";
    if (!isToolSlot(args.slot)) return "invalid_placement_slot";
    if (typeof args.expectedQualifiedItemId !== "string" || args.expectedQualifiedItemId.length === 0)
      return "invalid_placement_item";
  } else {
    // Removing a placed item and breaking a container both take the tile, the tool slot and the
    // opaque object target, and nothing else.
    if (!hasExactKeys(args, ["x", "y", "slot", "expectedTargetId"])) return "invalid_args";
    if (!isTileCoordinate(args.x) || !isTileCoordinate(args.y)) return "invalid_world_object_tile";
    if (!isToolSlot(args.slot)) return "invalid_world_object_slot";
  }
  return null;
}

function validateReceipt(value: Record<string, unknown>): string | null {
  const allowedKeys = ["executionId", "requestId", "actionId", "state", "reasonCode", "revision", "evidence"];
  if ("observation" in value) allowedKeys.push("observation");
  if ("piggybackedScene" in value) allowedKeys.push("piggybackedScene");
  if ("nativeNotices" in value) allowedKeys.push("nativeNotices");
  return hasExactKeys(value, allowedKeys) &&
    isOpaqueId(value.executionId) &&
    isOpaqueId(value.requestId) &&
    typeof value.actionId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value.actionId) &&
    typeof value.state === "string" &&
    EXECUTION_STATES.includes(value.state as ExecutionState) &&
    isReasonCode(value.reasonCode) &&
    Number.isSafeInteger(value.revision) &&
    (value.evidence === null || isRecord(value.evidence)) &&
    (value.ownerKind === undefined || (typeof value.ownerKind === "string" && value.ownerKind.length <= 128)) &&
    (value.interruptible === undefined || typeof value.interruptible === "boolean") &&
    (!("observation" in value) || value.observation === null || validateLocalObservation(value.observation) === null) &&
    (!("piggybackedScene" in value) ||
      value.piggybackedScene === null ||
      validateObserveSceneResult(value.piggybackedScene as Record<string, unknown>) === null) &&
    (!("nativeNotices" in value) || value.nativeNotices === null || isNativeNotices(value.nativeNotices))
    ? null
    : "invalid_receipt";
}

/**
 * Raw native notice text is forwarded verbatim, so only the transport shape is
 * bounded: at most 8 short strings, each non-empty and single-line.
 */
function isNativeNotices(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_NATIVE_NOTICES &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length >= 1 &&
        item.length <= MAX_NATIVE_NOTICE_CHARS &&
        item.trim().length > 0,
    )
  );
}

export function validateLocalObservation(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["location", "tileX", "tileY", "facing", "inGameTime", "playerNearby", "revision"])
  ) {
    return "invalid_local_observation";
  }
  return typeof value.location === "string" &&
    value.location.length >= 1 &&
    value.location.length <= 256 &&
    Number.isSafeInteger(value.tileX) &&
    Number.isSafeInteger(value.tileY) &&
    Number.isSafeInteger(value.facing) &&
    (value.facing as number) >= 0 &&
    (value.facing as number) <= 3 &&
    typeof value.inGameTime === "string" &&
    value.inGameTime.length <= 64 &&
    typeof value.playerNearby === "boolean" &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0
    ? null
    : "invalid_local_observation";
}

export function validateWorldFact(value: Record<string, unknown>): string | null {
  const allowedKeys = [
    "eventId",
    "sourceEventId",
    "kind",
    "observedTick",
    "gameTime",
    "revision",
    "deduplicationKey",
    "payload",
    "payloadJson",
  ];
  if (!hasOnlyKeys(value, allowedKeys)) return "invalid_world_fact";
  if (
    !("eventId" in value) ||
    !("sourceEventId" in value) ||
    !("kind" in value) ||
    !("observedTick" in value) ||
    !("revision" in value)
  ) {
    return "invalid_world_fact";
  }
  if (
    !isOpaqueId(value.eventId) ||
    !isOpaqueId(value.sourceEventId) ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    value.kind.length > 128 ||
    !isReasonCode(value.kind) ||
    typeof value.observedTick !== "number" ||
    !Number.isSafeInteger(value.observedTick) ||
    value.observedTick < 0 ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return "invalid_world_fact";
  }
  if (
    value.gameTime !== undefined &&
    value.gameTime !== null &&
    (typeof value.gameTime !== "string" || value.gameTime.length === 0 || value.gameTime.length > 64)
  ) {
    return "invalid_world_fact";
  }
  if (value.deduplicationKey !== undefined && !isOpaqueId(value.deduplicationKey)) {
    return "invalid_world_fact";
  }
  const hasPayload = value.payload !== undefined && value.payload !== null;
  const hasPayloadJson = value.payloadJson !== undefined && value.payloadJson !== null;
  if (hasPayload === hasPayloadJson) return "invalid_world_fact";
  if (hasPayload && !isRecord(value.payload)) return "invalid_world_fact";
  if (hasPayloadJson) {
    if (
      typeof value.payloadJson !== "string" ||
      Buffer.byteLength(value.payloadJson, "utf8") > MAX_WORLD_FACT_PAYLOAD_JSON_BYTES
    )
      return "invalid_world_fact";
    let parsed: unknown;
    try {
      parsed = JSON.parse(value.payloadJson);
    } catch {
      return "invalid_world_fact";
    }
    if (!isRecord(parsed)) return "invalid_world_fact";
  }
  return null;
}

export function isWorldFactPayload(value: unknown): value is WorldFactPayload {
  return isRecord(value) && validateWorldFact(value) === null;
}

export function isWorldFactMessage(value: unknown): value is Envelope<"world_fact", WorldFactPayload> {
  return isRecord(value) && value.type === "world_fact" && isWorldFactPayload(value.payload);
}

export function validateBodyProgramCandidateRequest(value: Record<string, unknown>): string | null {
  if (
    !hasExactKeys(value, ["programId", "nodes"]) ||
    !isOpaqueId(value.programId) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length < 1 ||
    value.nodes.length > MAX_BODY_PROGRAM_NODES
  )
    return "invalid_body_program_request";
  return value.nodes.every(isBodyProgramNode) ? null : "invalid_body_program_request";
}

function isBodyProgramNode(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["nodeId", "actionId", "arguments", "dependsOn", "bindings"]) ||
    !isOpaqueId(value.nodeId) ||
    !isOpaqueId(value.actionId) ||
    !isRecord(value.arguments) ||
    !hasUniqueKeys(value.arguments) ||
    !Array.isArray(value.dependsOn) ||
    value.dependsOn.length > 8 ||
    !value.dependsOn.every(isOpaqueId) ||
    !isRecord(value.bindings) ||
    !hasUniqueKeys(value.bindings) ||
    Object.keys(value.bindings).length > MAX_BODY_PROGRAM_BINDINGS_PER_NODE
  )
    return false;
  return (
    Object.entries(value.arguments).every(
      ([name, argument]) => isOpaqueId(name) && isBodyProgramRuntimeValue(argument),
    ) &&
    Object.entries(value.bindings).every(([name, binding]) => isOpaqueId(name) && isBodyProgramFactReference(binding))
  );
}
function isBodyProgramRuntimeValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "destination_selector")
    return hasExactKeys(value, ["type", "destination"]) && isBodyProgramDestinationSelector(value.destination);
  return (
    (value.type === "integer" || value.type === "string" || value.type === "boolean") &&
    hasExactKeys(value, ["type", "canonicalValue"]) &&
    typeof value.canonicalValue === "string" &&
    value.canonicalValue.length <= 512
  );
}
/** Mirrors the C# IsValidBodyProgramSelector: scalar labels are trimmed, run ids are canonical 26-char navigation refs. */
function isBodyProgramDestinationSelector(value: unknown): value is BodyProgramDestinationSelector {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "label") return hasExactKeys(value, ["kind", "label"]) && isBodyProgramSelectorLabel(value.label);
  if (value.kind === "ref")
    return (
      hasExactKeys(value, ["kind", "ref"]) &&
      typeof value.ref === "string" &&
      /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/.test(value.ref)
    );
  return false;
}
function isBodyProgramSelectorLabel(value: unknown): value is string {
  // Mirrors the C# ReadPlayerText FormC gate: only already-canonicalized NFC labels are exchangeable.
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    value.trim().length > 0 &&
    value.normalize("NFC") === value
  );
}
function isBodyProgramFactReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["nodeId", "factName"]) &&
    isOpaqueId(value.nodeId) &&
    isOpaqueId(value.factName)
  );
}
export function validateBodyProgramVerificationResult(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["accepted", "catalogRevision", "diagnostics"]) &&
    typeof value.accepted === "boolean" &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length <= 64 &&
    value.diagnostics.every(isBodyProgramDiagnostic)
    ? null
    : "invalid_body_program_result";
}
export function validateBodyProgramSubmitResult(value: Record<string, unknown>): string | null {
  if (
    !hasExactKeys(value, ["code", "verification", "snapshot"]) ||
    !isBodyProgramSubmitCode(value.code) ||
    validateBodyProgramVerificationResult(value.verification as Record<string, unknown>) !== null
  )
    return "invalid_body_program_result";
  const code = value.code;
  const verification = value.verification as Readonly<{ accepted: boolean }>;
  const snapshot = value.snapshot;
  if (code === "accepted" || code === "idempotent" || code === "conflict") {
    if (!verification.accepted || !isBodyProgramStatusSnapshot(snapshot)) return "invalid_body_program_result";
  } else if (code === "rejected" || code === "quarantined") {
    if (verification.accepted || !(snapshot === null)) return "invalid_body_program_result";
  } else if (code === "persistence_failure") {
    if (!verification.accepted || !(snapshot === null)) return "invalid_body_program_result";
  }
  return null;
}
export function validateBodyProgramStatusResult(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["code", "snapshot"]) || !isBodyProgramQueryCode(value.code))
    return "invalid_body_program_result";
  return value.code === "found"
    ? isBodyProgramStatusSnapshot(value.snapshot)
      ? null
      : "invalid_body_program_result"
    : value.snapshot === null
      ? null
      : "invalid_body_program_result";
}
export function validateBodyProgramEventsResult(value: Record<string, unknown>): string | null {
  if (
    !hasExactKeys(value, ["programId", "code", "events", "nextCursor", "highWater"]) ||
    !isOpaqueId(value.programId) ||
    !isBodyProgramQueryCode(value.code) ||
    !Array.isArray(value.events) ||
    value.events.length > 32 ||
    !isNonNegativeSafeInteger(value.nextCursor) ||
    !isNonNegativeSafeInteger(value.highWater) ||
    (value.code !== "found" && value.events.length !== 0)
  )
    return "invalid_body_program_result";
  return value.events.every(isBodyProgramEvent) &&
    value.events.every((event) => event.programId === value.programId && event.cursor <= (value.highWater as number)) &&
    (value.events.length === 0 || hasExactPageContinuation(value.events as unknown[], value.nextCursor as number))
    ? null
    : "invalid_body_program_result";
}
function hasExactPageContinuation(events: readonly unknown[], nextCursor: number): boolean {
  if (events.length === 0) return true;
  for (let index = 1; index < events.length; index += 1) {
    const prior = (events[index - 1] as BodyProgramEvent).cursor;
    const current = (events[index] as BodyProgramEvent).cursor;
    if (current <= prior) return false;
  }
  return nextCursor === (events[events.length - 1] as BodyProgramEvent).cursor;
}
function isBodyProgramEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt"]) &&
    isNonNegativeSafeInteger(value.cursor) &&
    isOpaqueId(value.programId) &&
    isReasonCode(value.kind) &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    (value.nodeId === null || isOpaqueId(value.nodeId)) &&
    (value.nodeAttempt === null || isNonNegativeInt32(value.nodeAttempt))
  );
}
function isBodyProgramSubmitCode(value: unknown): boolean {
  return (
    value === "accepted" ||
    value === "rejected" ||
    value === "idempotent" ||
    value === "conflict" ||
    value === "persistence_failure" ||
    value === "quarantined"
  );
}
function isBodyProgramQueryCode(value: unknown): boolean {
  return value === "found" || value === "not_found" || value === "invalid_input";
}
function isBodyProgramDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["severity", "code", "nodeId", "path", "message"]) &&
    value.severity === "error" &&
    isReasonCode(value.code) &&
    (value.nodeId === null || isOpaqueId(value.nodeId)) &&
    typeof value.path === "string" &&
    typeof value.message === "string"
  );
}
function isBodyProgramStatusSnapshot(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["programId", "state", "catalogRevision", "stopEpoch", "eventHighWater", "nodes"]) &&
    isOpaqueId(value.programId) &&
    isBodyProgramState(value.state) &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    isNonNegativeSafeInteger(value.stopEpoch) &&
    isNonNegativeSafeInteger(value.eventHighWater) &&
    Array.isArray(value.nodes) &&
    value.nodes.length <= MAX_BODY_PROGRAM_NODES &&
    value.nodes.every(isBodyProgramNodeStatus)
  );
}
function isBodyProgramNodeStatus(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["nodeId", "state", "nodeAttempt", "admissionAttempt"]) &&
    isOpaqueId(value.nodeId) &&
    isBodyProgramNodeState(value.state) &&
    isNonNegativeInt32(value.nodeAttempt) &&
    isNonNegativeInt32(value.admissionAttempt)
  );
}
function isBodyProgramState(value: unknown): boolean {
  return (
    value === "active" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "recovery_required" ||
    value === "quarantined"
  );
}
function isBodyProgramNodeState(value: unknown): boolean {
  return (
    value === "pending" ||
    value === "awaiting_host_admission" ||
    value === "host_admitted" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "recovery_required" ||
    value === "rejected"
  );
}
function hasUniqueKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length <= 32;
}

function validateSemanticEvent(value: Record<string, unknown>): string | null {
  const bodyTraceKind = isBodyTraceCategory(value.kind);
  const playerControlKind = value.kind === "player_input" || value.kind === "stop_all";
  const stopObservationKind = value.kind === "body_settled";
  const expectedKeys = bodyTraceKind
    ? ["kind", "revision", "activeExecution", "reasonCode", "bodyTrace"]
    : playerControlKind
      ? ["kind", "revision", "activeExecution", "reasonCode", "playerControl"]
      : stopObservationKind
        ? ["kind", "revision", "activeExecution", "reasonCode", "stopObservation"]
        : ["kind", "revision", "activeExecution", "reasonCode"];
  return hasExactKeys(value, expectedKeys) &&
    (value.kind === "snapshot_changed" ||
      value.kind === "execution_state" ||
      value.kind === "connection_state" ||
      value.kind === "lifecycle" ||
      playerControlKind ||
      stopObservationKind ||
      bodyTraceKind) &&
    Number.isSafeInteger(value.revision) &&
    isReasonCode(value.reasonCode) &&
    (value.activeExecution === null ||
      (isRecord(value.activeExecution) && validateActiveExecution(value.activeExecution) === null)) &&
    (bodyTraceKind
      ? isRecord(value.bodyTrace) &&
        validateBodyTrace(value.bodyTrace) === null &&
        value.bodyTrace.category === value.kind
      : playerControlKind
        ? isRecord(value.playerControl) && validatePlayerControl(value.playerControl) === null
        : stopObservationKind
          ? isRecord(value.stopObservation) && validateStopObservation(value.stopObservation) === null
          : true)
    ? null
    : "invalid_semantic_event";
}

function validatePlayerControl(value: Record<string, unknown>): string | null {
  const isPlayerInput = value.kind === "player_input";
  const isStopAll = value.kind === "stop_all";
  return hasExactKeys(
    value,
    isPlayerInput
      ? ["kind", "controlId", "sourceEventId", "text", "locale", "issuerPlayerId"]
      : ["kind", "controlId", "sourceEventId", "locale", "issuerPlayerId"],
  ) &&
    (isPlayerInput || isStopAll) &&
    isOpaqueId(value.controlId) &&
    isOpaqueId(value.sourceEventId) &&
    isOpaqueId(value.issuerPlayerId) &&
    typeof value.locale === "string" &&
    /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(value.locale) &&
    (isPlayerInput
      ? typeof value.text === "string" && value.text.trim().length > 0 && value.text.length <= 4_000
      : true)
    ? null
    : "invalid_player_control";
}

function validateStopObservation(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["kind", "stopId", "sourceEventId", "epoch"]) &&
    value.kind === "body_settled" &&
    isOpaqueId(value.stopId) &&
    isOpaqueId(value.sourceEventId) &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 1
    ? null
    : "invalid_stop_observation";
}

function isBodyTraceCategory(value: unknown): value is BodyTrace["category"] {
  return (
    value === "execution_started" ||
    value === "route_progress" ||
    value === "execution_settled_succeeded" ||
    value === "execution_settled_cancelled" ||
    value === "execution_settled_failed" ||
    value === "execution_invalidated" ||
    value === "body_idle"
  );
}

function validateBodyTrace(value: Record<string, unknown>): string | null {
  return hasOnlyKeys(value, ["category", "executionId", "requestId", "tick", "revision", "location", "tile"]) &&
    isBodyTraceCategory(value.category) &&
    isOpaqueId(value.executionId) &&
    isOpaqueId(value.requestId) &&
    typeof value.tick === "number" &&
    Number.isSafeInteger(value.tick) &&
    value.tick >= 0 &&
    Number.isSafeInteger(value.revision) &&
    (value.location === undefined ||
      (typeof value.location === "string" && value.location.length >= 1 && value.location.length <= 256)) &&
    (value.tile === undefined ||
      (isRecord(value.tile) &&
        hasExactKeys(value.tile, ["x", "y"]) &&
        isTileCoordinate(value.tile.x) &&
        isTileCoordinate(value.tile.y)))
    ? null
    : "invalid_body_trace";
}

function isSoilTile(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["x", "y"]) && isTileCoordinate(value.x) && isTileCoordinate(value.y);
}

function isWeatherToken(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value === "sunny" ||
      value === "rain" ||
      value === "snow" ||
      value === "lightning" ||
      value === "debris" ||
      value === "unknown")
  );
}

function isWarp(value: unknown): boolean {
  // `accessible` is OPTIONAL: the Mod's serializer omits a null member (WhenWritingNull), so a leg it
  // could not measure carries no key at all. ABSENT and `null` both mean "not measured" and must never
  // be read as `false`. A `hasExactKeys` list here would refuse the Mod's own payload and close the
  // bridge (the `tailoringTargets` failure), so the key set stays open and the optional member is
  // type-checked when it is present.
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["sourceX", "sourceY", "targetLocation", "targetX", "targetY", "accessible"])
  )
    return false;
  return (
    isTileCoordinate(value.sourceX) &&
    isTileCoordinate(value.sourceY) &&
    typeof value.targetLocation === "string" &&
    value.targetLocation.length > 0 &&
    value.targetLocation.length <= 256 &&
    isTileCoordinate(value.targetX) &&
    isTileCoordinate(value.targetY) &&
    (value.accessible === undefined || value.accessible === null || typeof value.accessible === "boolean")
  );
}

/** The exact key set a wire active execution may carry. */
const ACTIVE_EXECUTION_KEYS = Object.freeze([
  "executionId",
  "requestId",
  "action",
  "state",
  "reasonCode",
  "evidence",
  "ownerKind",
  "interruptible",
  "phase",
  "cancelSafe",
] as const);

function validateActiveExecution(value: Record<string, unknown>): string | null {
  // `ownerKind`/`interruptible`/`phase`/`cancelSafe` are OPTIONAL, so an older Mod that does not send them still
  // validates - but a newer one that does must not be refused, which is exactly what happened when the Mod gained
  // the first two and this list did not (every in-flight snapshot would have been `invalid_snapshot` and closed the
  // bridge). The additions are declared HERE, once, so the next field cannot be forgotten in a second list.
  return hasOnlyKeys(value, [...ACTIVE_EXECUTION_KEYS]) &&
    isOpaqueId(value.executionId) &&
    isOpaqueId(value.requestId) &&
    typeof value.action === "string" &&
    value.action.length <= 128 &&
    typeof value.state === "string" &&
    EXECUTION_STATES.includes(value.state as ExecutionState) &&
    isReasonCode(value.reasonCode) &&
    (value.evidence === null || isRecord(value.evidence)) &&
    // The optional members are type-checked when present: the allowance must not become a hole.
    (value.ownerKind === undefined || (typeof value.ownerKind === "string" && value.ownerKind.length <= 128)) &&
    (value.interruptible === undefined || typeof value.interruptible === "boolean") &&
    (value.phase === undefined || (typeof value.phase === "string" && value.phase.length <= 64)) &&
    (value.cancelSafe === undefined || typeof value.cancelSafe === "boolean")
    ? null
    : "invalid_active_execution";
}
function isScope(value: unknown): value is Scope {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["integrationId", "saveId", "worldId", "playerId", "companionId"]) &&
    ["integrationId", "saveId", "worldId", "playerId", "companionId"].every(
      (key) => typeof value[key] === "string" && isOpaqueId(value[key]),
    )
  );
}
function isBcp47Locale(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/.test(value);
}
function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_:-]{1,128}$/.test(value);
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}
function hasMinecartRideArgs(args: Record<string, unknown>): boolean {
  return (
    hasExactKeys(args, ["x", "y", "expectedTargetId"]) &&
    typeof args.expectedTargetId === "string" &&
    /^minecart_[a-f0-9]{16}$/u.test(args.expectedTargetId)
  );
}

/**
 * A named minecart ride must still be an objective this exact snapshot
 * advertised from the same station tile: the companion may not invent a target,
 * and a stale target from a previous observation is refused.
 */
function validateMinecartRideTarget(args: Record<string, unknown>, snapshot: Snapshot): string | null {
  if (!hasMinecartRideArgs(args)) return "invalid_args";
  const targets = snapshot.minecartTargets;
  if (!Array.isArray(targets)) return "invalid_minecart_station";
  const match = targets.find((target) => target.targetId === args.expectedTargetId);
  if (match === undefined) return "invalid_minecart_station";
  if (match.stationX !== args.x || match.stationY !== args.y) return "invalid_minecart_station";
  return null;
}
const KNOWN_ACTION_DESCRIPTOR_KEYS = [
  "arguments",
  "argumentSchema",
  "sceneTarget",
  "outputFacts",
  "resourceTemplate",
  "effect",
  "evidenceSchema",
  "nativeBinding",
  "canonicalCodec",
  "watchdogMs",
  "postcondition",
] as const;

export function isValidActionDescriptor(value: unknown): value is ActionRegistrationDescriptor {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, KNOWN_ACTION_DESCRIPTOR_KEYS)) return false;

  if ("arguments" in value && value.arguments !== undefined) {
    if (!Array.isArray(value.arguments) || value.arguments.length > 32) return false;
    for (const arg of value.arguments) {
      if (!isRecord(arg)) return false;
      if (!hasOnlyKeys(arg, ["name", "type", "enum", "boundedEnumValues"])) return false;
      if (typeof arg.name !== "string" || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(arg.name)) return false;
      if (typeof arg.type !== "string" || arg.type.length === 0 || arg.type.length > 64) return false;
      if ("enum" in arg && arg.enum !== undefined) {
        if (!Array.isArray(arg.enum) || arg.enum.length === 0 || arg.enum.length > 128) return false;
        if (!arg.enum.every((item) => typeof item === "string" && item.length > 0 && item.length <= 64)) return false;
      }
      if ("boundedEnumValues" in arg && arg.boundedEnumValues !== undefined) {
        if (
          !Array.isArray(arg.boundedEnumValues) ||
          arg.boundedEnumValues.length === 0 ||
          arg.boundedEnumValues.length > 128
        )
          return false;
        if (!arg.boundedEnumValues.every((item) => typeof item === "string" && item.length > 0 && item.length <= 64))
          return false;
      }
    }
  }

  if ("argumentSchema" in value && value.argumentSchema !== undefined) {
    if (!isRecord(value.argumentSchema)) return false;
    for (const [key, prop] of Object.entries(value.argumentSchema)) {
      if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(key)) return false;
      if (!isRecord(prop) || typeof prop.type !== "string") return false;
      if ("enum" in prop && prop.enum !== undefined) {
        if (!Array.isArray(prop.enum) || prop.enum.length === 0 || prop.enum.length > 128) return false;
        if (!prop.enum.every((item) => typeof item === "string" && item.length > 0 && item.length <= 64)) return false;
      }
    }
  }

  if ("sceneTarget" in value && value.sceneTarget !== undefined) {
    if (
      !isRecord(value.sceneTarget) ||
      !hasExactKeys(value.sceneTarget, ["type", "version", "required", "requiredProperties"]) ||
      typeof value.sceneTarget.type !== "string" ||
      value.sceneTarget.type.length === 0 ||
      value.sceneTarget.type.length > 64 ||
      typeof value.sceneTarget.version !== "number" ||
      !Number.isSafeInteger(value.sceneTarget.version) ||
      value.sceneTarget.version < 1 ||
      typeof value.sceneTarget.required !== "boolean" ||
      !Array.isArray(value.sceneTarget.requiredProperties) ||
      value.sceneTarget.requiredProperties.length > 16 ||
      !value.sceneTarget.requiredProperties.every(
        (property) => typeof property === "string" && /^[a-z][a-zA-Z0-9_]{0,63}$/.test(property),
      )
    )
      return false;
  }

  if ("outputFacts" in value && value.outputFacts !== undefined) {
    if (!isRecord(value.outputFacts)) return false;
    for (const [k, v] of Object.entries(value.outputFacts)) {
      if (typeof k !== "string" || typeof v !== "string") return false;
    }
  }

  if ("resourceTemplate" in value && value.resourceTemplate !== undefined) {
    if (typeof value.resourceTemplate === "string") {
      if (value.resourceTemplate.length > 128) return false;
    } else if (isRecord(value.resourceTemplate)) {
      if (!("claims" in value.resourceTemplate) || !Array.isArray(value.resourceTemplate.claims)) return false;
      for (const claim of value.resourceTemplate.claims) {
        if (!isRecord(claim) || typeof claim.key !== "string" || typeof claim.value !== "string") return false;
      }
    } else {
      return false;
    }
  }

  if ("effect" in value && value.effect !== undefined) {
    if (value.effect !== "read" && value.effect !== "write") return false;
  }

  if ("evidenceSchema" in value && value.evidenceSchema !== undefined) {
    if (typeof value.evidenceSchema !== "string" && !isRecord(value.evidenceSchema)) return false;
  }

  if ("nativeBinding" in value && value.nativeBinding !== undefined) {
    if (typeof value.nativeBinding !== "string" || value.nativeBinding.length === 0 || value.nativeBinding.length > 128)
      return false;
  }

  if ("canonicalCodec" in value && value.canonicalCodec !== undefined) {
    if (
      typeof value.canonicalCodec !== "string" ||
      value.canonicalCodec.length === 0 ||
      value.canonicalCodec.length > 128
    )
      return false;
  }

  if ("postcondition" in value && value.postcondition !== undefined) {
    if (typeof value.postcondition === "string") {
      if (value.postcondition.length === 0 || value.postcondition.length > 128) return false;
    } else if (isRecord(value.postcondition)) {
      if (
        typeof value.postcondition.name !== "string" ||
        value.postcondition.name.length === 0 ||
        value.postcondition.name.length > 128
      )
        return false;
    } else {
      return false;
    }
  }

  if ("watchdogMs" in value && value.watchdogMs !== undefined) {
    // A positive, JavaScript-safe integer: the value becomes a deadline, so a negative or fractional one would be a
    // request that can never be waited on.
    if (!Number.isSafeInteger(value.watchdogMs) || (value.watchdogMs as number) <= 0) return false;
  }

  return true;
}

function isValidActionRegistrations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return false;
    const allowedKeys =
      "descriptor" in item
        ? ["actionId", "familyId", "identityVersion", "lifecycle", "kind", "descriptor"]
        : ["actionId", "familyId", "identityVersion", "lifecycle", "kind"];
    if (!hasExactKeys(item, allowedKeys)) return false;
    if (!isOpaqueId(item.actionId) || !isOpaqueId(item.familyId)) return false;
    if (
      typeof item.identityVersion !== "number" ||
      !Number.isSafeInteger(item.identityVersion) ||
      item.identityVersion < 1
    )
      return false;
    if (item.lifecycle !== "published" && item.lifecycle !== "live_verified" && item.lifecycle !== "experimental")
      return false;
    if (item.kind !== "execution" && item.kind !== "read_only") return false;
    if ("descriptor" in item && (item.descriptor === undefined || !isValidActionDescriptor(item.descriptor)))
      return false;
    if (seen.has(item.actionId)) return false;
    seen.add(item.actionId);
  }
  return true;
}
function isNonNegativeInt32(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}
function isUniqueOpaqueIdArray(value: unknown): value is readonly string[] {
  return isStringArray(value) && value.every(isOpaqueId) && new Set(value).size === value.length;
}
function isValidRuntimeAttestation(role: unknown, generation: unknown): boolean {
  return role === "farmhand_client"
    ? isOpaqueId(generation)
    : (role === "native_local_fixture" || role === "unattested") && generation === null;
}
export const TOOL_SELECTOR_VALUES = new Set([
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

/** equip_tool/v2 semantic category selector; slot stays Mod-private. */
function isToolSelector(value: unknown): value is string {
  return typeof value === "string" && TOOL_SELECTOR_VALUES.has(value);
}
