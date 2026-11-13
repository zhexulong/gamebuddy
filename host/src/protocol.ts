import { randomUUID } from "node:crypto";

import { isForEachLoopDocument, type PlanForEachLoop } from "./body-program-for-each.js";
import {
  hasExactKeys,
  hasExactKeysOrOptional,
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
  isChestStateFact,
  isChestsSummaryFact,
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
  isFarmAnimalPetTargetFact,
  isFarmBuildingTargetFact,
  isFeedTroughTargetFact,
  isFenceGateTargetFact,
  isFertilizerTargetFact,
  isFiniteNumber,
  isFishPondTargetFact,
  isFixedInteractionPointFact,
  isFoodTargetFact,
  isForageTargetFact,
  isGrassTargetFact,
  isHarvestTargetFact,
  isHarvestWhereaboutsFact,
  isWateringWhereaboutsFact,
  isHorseTargetFact,
  isInventoryItemFact,
  isItemTargetFact,
  isLanternSlotFact,
  isLevelUpChoiceFact,
  isMachineInputCount,
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
  isQualifiedItemId,
  isRaftTargetFact,
  isRecipeTargetFact,
  isRecord,
  isRefillWateringCanTargetFact,
  isWaterTargetFact,
  isRockSourceTargetFact,
  isScytheCropTargetFact,
  isSeedSupplyTargetFact,
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
  TOOL_CATEGORY_VALUES,
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
  | (BodyNodeAdmissionChallenge & Readonly<{ result: "unavailable"; code: string }>);

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
  /**
   * The engine's pending level-ups, as `skill@level` (0 Farming … 5 Luck) - what the next night boundary will ask the
   * companion to decide. Published 2026-10-19 because the harness was learning this pair by PARSING THE REFUSAL receipt
   * of `dismiss_modal`: the pair is a product fact, not a failure to be reverse-engineered. Older Mod snapshots may omit
   * the field, and an empty array means "nothing pending".
   */
  pendingLevelUps?: readonly string[];
  /**
   * The pending profession MILESTONES (levels 5 and 10) the next night boundary will offer, each with the two
   * candidates the engine's own rule puts on the left and right cards, carrying the engine's own title and
   * description, and the level-5 profession a level-10 pair continues from. Published because a profession branch
   * is a permanent, synced save write: the companion has to SEE the options before `respond_level_up` writes one,
   * and `branch_a` addresses `leftId` while `branch_b` addresses `rightId`. Older Mod snapshots may omit the field.
   */
  pendingLevelUpChoices?: readonly Readonly<{
    skill: number;
    level: number;
    previousProfession?: number;
    leftId: number;
    leftTitle: string;
    leftDescription: string;
    rightId: number;
    rightTitle: string;
    rightDescription: string;
  }>[];
  /**
   * The actor's own profession ids. A fresh read of this set is how a caller sees that a milestone branch landed on
   * the chosen id and NOT on the other card. Older Mod snapshots may omit the field.
   */
  professions?: readonly number[];
  /** Older Mod snapshots may omit fields added after the initial bridge contract. */
  currentTool?: string | null;
  /**
   * The farmer's active tool slot (`Farmer.CurrentToolIndex`). The tool-family actions take a `slot` that must EQUAL
   * this index and hold the exact tool, so the slot cannot be judged statically: it is published here instead.
   */
  currentToolSlot?: number | null;
  /**
   * The qualified item id occupying `currentToolSlot`, whatever its kind, or null when that slot is empty.
   *
   * The held-slot actions (`dress_mannequin`, `set_sign_display`, `deposit_silo_hay`, `clear_cask`) refuse unless the
   * named slot holds the exact item AND is the held one (`CurrentToolIndex == slot`), so `currentToolSlot` alone says
   * where the hand is without saying what is in it. Read together, a present occupant beside an absent `currentTool`
   * reads as "holding something that is not a tool" rather than as an equip that silently did nothing.
   */
  currentToolSlotItem?: string | null;
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
  /**
   * The map's OWN fixed interaction points, WHOLE MAP and without entities: a mine level's ladder tiles,
   * a shop counter, a television.
   *
   * <p>
   * Every other family on this type is either an entity within the Mod's six-tile discovery radius or a
   * table the engine keeps for itself (`warps`, `doorTargets`). A mine level's ladder-up is a
   * Buildings-layer TILE INDEX, so it is in neither, and no radius ever reaches it from anywhere - which
   * is why a companion in a mine could name no way out. `kind` is the closed vocabulary the wire schema
   * declares; `actionWord` is the engine's own first word at that tile and is null where it carries none.
   * Older Mod snapshots may omit the field.
   * </p>
   */
  fixedInteractionPoints?: readonly Readonly<{
    x: number;
    y: number;
    kind: string;
    actionWord: string | null;
  }>[];
  /**
   * The fixed interaction points the Mod's cap left out of `fixedInteractionPoints`, so a truncated list
   * says so instead of reading as the whole map. Absent on a Mod older than the field; null when the
   * family itself was not measured.
   */
  fixedInteractionPointsOmitted?: number | null;
  /**
   * The actor's own neighbourhood soil, in both states a soil action acts on: `hoeDirt` true for a tile that
   * already carries a HoeDirt (the `plant_seed`/`fertilize_tile`/`water_crop` target, and the record of work the
   * actor has already done), false for ground the Hoe would still admit. Radius-bounded and nearest-first.
   */
  soilTiles?: readonly Readonly<{ x: number; y: number; hoeDirt?: boolean }>[];
  /**
   * The soil tiles the Mod's cap left out of `soilTiles`, so a neighbourhood larger than the bound says so
   * instead of reading as a complete patch. Absent on a Mod older than the field; null when the family itself
   * was not measured (`till_soil` not advertised).
   */
  soilTilesOmitted?: number | null;
  /**
   * The farm buildings the Mod's cap left out of `farmBuildingTargets`, so a farm with more buildings than the bound
   * says so instead of reading as exactly the bound. Null when the family itself was not measured
   * (`build_farm_building` not advertised).
   */
  farmBuildingTargetsOmitted?: number | null;
  /**
   * What discovery WITHHELD, and why - the sibling of the truncation counts above.
   *
   * <p>
   * `soilTilesOmitted` states "the cap took rows"; this states "the filter took rows, and here is the reason". A
   * family that filters its subjects and says nothing about the filter answers two different questions with one empty
   * list: "there is a tree on this tile but you cannot chop it" and "there is no tree here". The companion then plans
   * against an empty world - measured as a gate whose farm held only weeds scoring 100%.
   * </p>
   *
   * <p>
   * `family` is the WIRE FIELD NAME of the list the row explains (`treeChopSourceTargets`, `petTargets`, ...), so one
   * array still attributes every row to its family; `reason` is a member of the closed vocabulary below; `count` is at
   * least 1 and is a COUNT, never an identity - the subject the filter removed is by definition not addressable.
   * ABSENT means no exclusion-reporting family was measured this snapshot; an empty array means one was measured and
   * nothing was withheld. The two are different answers, exactly as `soilTiles` null differs from `soilTiles: []`.
   * </p>
   */
  discoveryExclusions?: readonly Readonly<{ family: string; reason: string; count: number }>[];
  /**
   * The distinct (family, reason) rows the Mod's cap left out of `discoveryExclusions`, so a truncated register says
   * so instead of reading as complete. Absent on a Mod older than the field; null when the family itself was not
   * measured.
   */
  discoveryExclusionsOmitted?: number | null;
  /**
   * Current Farmhand inventory Tool slots: the slot, its bounded label, the tool's upgrade level and the category word
   * a `tool:<category>` claim uses. `category` is absent on a Mod older than that projection.
   */
  toolSlots?: readonly Readonly<{ slot: number; label: string; upgradeLevel?: number; category?: string }>[];
  /** Nearby native forage objects available through GameLocation.checkAction. `isForage` is `Object.isForage()`, the predicate that separates this family from `itemTargets`. */
  forageTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    stack: number;
    isForage?: boolean;
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
  /**
   * The tiles the ENGINE says a rod may be cast at in this location (`canFishHere` + `isTileFishable`), nearest first
   * and capped at 32. The address `fish_here` takes as `expectedTargetId`, recomputed by the Mod from the same location
   * identity and tile. A row promises no particular fish: which fish swims here is decided inside the engine at the bite.
   */
  waterTargets?: readonly Readonly<{ targetId: string; x: number; y: number }>[];
  /**
   * Nearby unwatered crops available through the native WateringCan path, each stating whether its tile is watered and
   * whether the crop is ready to harvest (`water_crop`/`harvest_crop` decide from these), plus the `Data/Crops` facts
   * that decide what to do with the tile: the row can be joined to a `look_up` answer by `cropId` instead of costing a
   * second question. Measured 2026-11-09: `look_up({table:"Crops"})` was never asked across a day of runs, so a trellis
   * crop's blocking column was in no working set at all.
   */
  cropTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    cropId: string;
    displayName: string;
    watered?: boolean;
    harvestable?: boolean;
    /** The sum of `CropData.DaysInPhase`, the same derivation the `Crops` data answer publishes. Absent with `cropFactsUnknown` for a crop whose data row the engine cannot resolve. */
    daysToHarvest?: number;
    /** `CropData.RegrowDays`; zero is a single-harvest crop. */
    regrowDays?: number;
    /** The engine's harvest-method word (`grab`/`scythe`), the same spelling `harvestTargets` publishes. */
    harvestMethod?: string;
    /** `CropData.IsRaised`: a trellis crop, planted on a tile that stops being walkable. */
    isRaised?: boolean;
    /** `CropData.Seasons`, as the engine's season keys (`spring`...`winter`). */
    seasons?: readonly string[];
    /**
     * `Crop.fullyGrown`: this plant has finished its phases. Deliberately NOT the same question as `harvestable`
     * (`HoeDirt.readyForHarvest()`): a crop just picked and regrowing is `fullyGrown` and not yet harvestable.
     */
    fullyGrown?: boolean;
    /**
     * Whether a farmer cannot walk onto this tile at the moment of publication - `GameLocation.isCollidingPosition`
     * over the tile's own 62x62 box, the admission test `PathFindController.cs:222` makes. Not
     * `GameLocation.isTilePassable`, which reads only the map's Back/Buildings layers and reports a trellis crop as
     * open ground. A reading of one instant: a plan made later re-observes rather than reusing it.
     */
    tileBlockedNow?: boolean;
    /** `crop_data_missing` when the engine has no `Data/Crops` row for this crop, which is why the five data facts above are absent. */
    cropFactsUnknown?: string;
  }>[];
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
    readyForHarvest?: boolean;
    forageCrop?: boolean;
    harvestMethod?: string;
  }>[];
  /** Nearby empty HoeDirt targets paired with a live inventory seed slot. */
  seedTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    canPlantThisSeedHere?: boolean;
    crop?: boolean;
  }>[];
  /** Nearby ground HoeDirt targets paired with a live fertilizer slot. */
  fertilizerTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
    displayName: string;
    canApplyFertilizer?: boolean;
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
  /**
   * Nearby ordinary breakable stone sources for the bounded native Pickaxe path. `health` is the rock's remaining
   * durability, which one swing lowers by `Math.Max(1, upgradeLevel + 1) + additionalPower` (Pickaxe.cs:139-140) -
   * so most of these need more than one swing, and that is what the figure is for.
   */
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
  /** Ordinary mature untapped non-moss trees that are still standing (`health > 0`), with the durability that is left. */
  treeChopSourceTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    treeType: string;
    growthStage: number;
    /** Durability remaining out of a mature tree's 10. An axe swing removes 1, so this is 10 on a fresh tree. */
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
  /** Nearby Weed objects cuttable by an equipped scythe (cut_weeds). `isWeeds` is `Object.IsWeeds()`. */
  weedTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    health: number;
    isWeeds?: boolean;
  }>[];
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
    readyForHarvest?: boolean;
    dead?: boolean;
    forageCrop?: boolean;
    harvestMethod?: string;
  }>[];
  /**
   * Nearby native machines. An idle machine whose own `Data/Machines` rows accept a carried stack publishes that stack
   * (`loadInputSlot`/`loadInputQualifiedItemId`/`loadInputStack`), and a machine the game itself marked ready to harvest
   * publishes `collectOutputReady`. Both are the machine's own facts, not a table kept here.
   */
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
    loadInputQualifiedItemId?: string | null;
    loadInputStack?: number | null;
    collectOutputReady?: boolean | null;
    machineData?: boolean;
    /**
     * What this machine's own `Data/Machines` rows declare it takes, published so a caller does not have to guess: a
     * furnace says five copper ore, not coffee beans. Empty `inputs` means the machine declares no load input; `null`
     * means its data could not answer, which is a different fact from "takes nothing"; `omitted` counts what the cap
     * withheld. The live load hint (`loadInputSlot`/`loadInputQualifiedItemId`) stays the machine's own probe of the
     * carried stack, so the declaration and the current affordance are two answers to two questions.
     */
    accepts?: Readonly<{ inputs: readonly string[]; omitted: number }> | null;
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
    /**
     * The villager's address: `BuildNpcRelationshipTargetId(location, npcName)`, the identical id `npcRelationshipTargets`
     * publishes and `talk_to_npc` re-resolves on the game thread.
     *
     * Published here because that family is bounded to the Mod's 6-tile discovery envelope: a villager 40 tiles away on
     * the actor's own map had a tile in this roster and no id anywhere, so no legal `talk_to_npc` node could name her.
     */
    targetId: string;
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
   * Agent a ripe crop exists elsewhere — same role as villagerWhereabouts.
   *
   * `nearestX`/`nearestY` are a BOTH-OR-NEITHER pair and are published only for
   * the map the actor stands on: another map's coordinate is not an address, so
   * an off-map row carries its count and no tile at all.
   */
  harvestWhereabouts?: readonly Readonly<{
    location: string;
    readyForHarvestCount: number;
    nearestX?: number;
    nearestY?: number;
  }>[];
  /** The same row shape, for the crops that still need water. */
  wateringWhereabouts?: readonly Readonly<{
    location: string;
    needsWaterCount: number;
    nearestX?: number;
    nearestY?: number;
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
  /** Nearby farm animals (barn/coop stock) this actor has NOT petted today. */
  farmAnimalPetTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    /** The animal's native `type` (e.g. "White Chicken"), straight from `FarmAnimal.type`. */
    animalType: string;
    /** `FarmAnimal.friendshipTowardFarmer`, the field the pet itself raises (capped at 1000). */
    friendship: number;
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
  /**
   * Every storage container the actor can reach, each carrying its own contents.
   *
   * A container is one ENTITY: the chest and the items inside it. The two families this replaced
   * (`chestStoreTargets`, `chestRetrieveTargets`) flattened that entity into a cross product of
   * (container x pack slot) and (container x chest item), which had to truncate to fit a window and
   * therefore could not publish a container's contents whole. Perception mirrors the world here;
   * execution takes its own safe slice by naming `chestId`/`itemId` out of this mirror.
   *
   * `items` is never truncated. The number of CONTAINERS is capped by `SNAPSHOT_FAMILY_RULES`.
   */
  chests?: readonly Readonly<{
    chestId: string;
    x: number;
    y: number;
    displayName: string;
    isFridge: boolean;
    items: readonly Readonly<{ slot: number; qualifiedItemId: string; displayName: string; stack: number }>[];
  }>[];
  /**
   * The current location's chests as ONE line: how many there are, how many items they hold between them, and how
   * many have no free slot left.
   *
   * `chests` above is the entity family and cannot answer "what is in my chests" without the reader counting rows and
   * adding stacks - and its list is bounded to the Mod's six-tile discovery radius, so a chest across the farm is not
   * in it at all. This is the summary beside it, the split `wateringWhereabouts` already makes beside `cropTargets`.
   *
   * It carries no `location` member because it describes `snapshot.location`: the count is that location's, never a
   * world total, and the fact line that renders it says so. A radius-bounded count presented as a total is the defect
   * `待浇水作物: 0` was - measured 2026-10-31 - so the count is location-wide and the wording is qualified.
   *
   * `itemCount` is the sum of every occupied slot's stack, not the number of slots. `fullCount` counts containers at
   * the engine's own `Chest.GetActualCapacity()`, which is where `Chest.addItem` stops taking a new stack.
   */
  chestsSummary?: Readonly<{ chestCount: number; itemCount: number; fullCount: number }>;
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
  /**
   * Where the seeds this actor HOLDS are sold, what the menu charges, and whether the shop's own hours query says it is
   * open now. One row per (held plantable seed x shop that stocks it).
   *
   * This is the SUPPLY half of a shortage and it exists because `shopTargets` cannot answer it: that family publishes
   * only shops whose owner stands in the CURRENT location, so on the farm at 06:00 it is empty, and no field anywhere
   * carried a price or a trading window. `hoursCondition` is the shop row's own game-state query verbatim and `openNow`
   * is the engine's answer to it; `openNow` absent means the question could not be asked, never "closed".
   *
   * Absent means NOT MEASURED (`plant_seed` was not advertised); an empty array is the measured answer "this actor holds
   * no plantable seed".
   */
  seedSupplyTargets?: readonly Readonly<{
    qualifiedItemId: string;
    displayName: string;
    /** Summed from the published `inventoryItemFacts` rows for the slots that hold this seed; absent = not measured. */
    heldCount?: number;
    /** The shop that stocks it. Absent = no shop in `Data/Shops` stocks this seed (no known source). */
    shopId?: string;
    shopDisplayName?: string;
    ownerName?: string;
    /** The owner entry's own hours query, verbatim (vanilla spells the trading window this way). */
    hoursCondition?: string;
    /** What the menu would charge now (`ItemStockInformation.Price`, after the shop's and the entry's modifiers). */
    price?: number;
    /** The `Data/Shops` row's declared number, when that row names this item literally. */
    declaredPrice?: number;
    currency?: number;
    openNow?: boolean;
    /** Why `openNow` could not be answered (`no_owner_entry`, `owner_condition_unreadable`). */
    openNowReason?: string;
    /**
     * Where the counter IS, when it is in the location the actor is standing in: the `shopTargets` row this shop's
     * counter occupies, copied member for member (its id, its tile, its location) so `shop_purchase` resolves the same
     * counter. EXACTLY ONE of this, `shopLocation` and `shopLocationUnknown` is written per row.
     */
    shopDestination?: Readonly<{
      location: string;
      targetId: string;
      tile: Readonly<{ x: number; y: number }>;
      label: string;
    }>;
    /** The room the counter is in when it is elsewhere - enough to head for, and deliberately not a destination. */
    shopLocation?: string;
    /** Why neither a destination nor a location could be read (`shop_location_unreadable`, `no_shop_stocks_this_seed`). */
    shopLocationUnknown?: string;
  }>[];
  /**
   * How many supply rows the Mod's cap left out of `seedSupplyTargets`, beside the family it truncates, so a cap of
   * eight rows says so instead of reading as the whole seed supply. Absent on a Mod older than the field; null when the
   * family itself was not measured (`plant_seed` not advertised).
   */
  seedSupplyTargetsOmitted?: number | null;
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
   * 'removable_object', 'non_removable_object', 'breakable_container', 'placed_furniture', 'empty_pedestal');
   * `slot`
   * is the backpack slot the named action must act through, or -1 when the actor owns no tool for
   * it. */
  worldObjectTargets?: readonly Readonly<{
    targetId: string;
    kind: string;
    location: string;
    x: number;
    y: number;
    slot: number;
    qualifiedItemId: string;
    displayName: string;
    /** The piece's live `currentRotation`, and the size of its own rotation cycle. Both are
     * `null` for every kind that is not a piece of furniture - never 0 and never -1, because 0
     * is a legal rotation and a sentinel that reads as a value gets compared as one. */
    rotation: number | null;
    rotations: number | null;
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
    | "move_placed_furniture"
    | "rotate_furniture"
    | "remove_fence"
    | "put_item_in_fish_tank"
    | "place_item_on_pedestal"
    | "break_container"
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
    | "open_geode"
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
    | "use_mine_ladder"
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
    | "break_resource_clump"
    | "fish_here"
    | "machine_inspect"
    | "machine_load"
    | "machine_collect_output"
    | "npc_relationship"
    | "talk_to_npc"
    | "equip_wearable"
    | "unequip_wearable"
    | "dismount_transport"
    | "pet_animal"
    | "pet_farm_animal"
    | "collect_animal_product"
    | "feed_animal"
    | "use_item"
    | "chop_tree"
    | "break_rock"
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
    | "sweep_scythe"
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
    | "sleep";
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

/**
 * One engine content-table query: a table name, and optionally one row of it.
 *
 * `table` is an ENGINE table name (`FarmAnimals`, `Shops`, `Machines`, ...), resolved by the Mod against its own
 * registry. It is a free string here on purpose: the Mod is the authority on which tables exist, so a table added to
 * a future game version needs no Host edit, and a name the engine does not have comes back as a named `unknown_table`
 * rather than as an empty answer.
 */
export type DataQueryRequest = Readonly<{ table: string; key: string | null }>;

/**
 * A projected field value. Scalars, string arrays and null only: a row is never a nested document.
 *
 * `null` is a real answer - `FarmAnimalData.HarvestTool` is null for a hen - and it is distinct from an ABSENT key,
 * which means the projection does not carry that field at all. Two different facts must not share one spelling.
 */
export type DataQueryFieldValue = string | number | boolean | null | readonly (string | number | boolean)[];

/** One content-table row, projected by the Mod to the fields that decide an action. */
export type DataQueryRow = Readonly<{ id: string; fields: Readonly<Record<string, DataQueryFieldValue>> }>;

/**
 * The answer to one content-table query.
 *
 * `population` is how many rows the table has, and it is -1 exactly when no table was found to count. That is what
 * keeps "the table is empty", "the table has no such row" and "there is no such table" three different answers.
 */
export type DataQueryResult =
  | Readonly<{
      status: "index";
      table: string;
      population: number;
      ids: readonly string[];
      row: null;
      detail: null;
    }>
  | Readonly<{
      status: "row";
      table: string;
      population: number;
      ids: null;
      row: DataQueryRow;
      detail: null;
    }>
  | Readonly<{
      status: "absent_row" | "unknown_table" | "not_projectable";
      table: string;
      population: number;
      ids: null;
      row: null;
      detail: string;
    }>;

/**
 * One rectangle question: the tiles `x..x+w-1` by `y..y+h-1` of the actor's current location.
 *
 * The four numbers are bounded by the wire's own corruption bound on both sides; the AREA bound belongs to the Mod's
 * answer (`area_too_large`), not to this frame, because a caller that asks for 11x10 must be told the limit rather than
 * have its request rejected with no statement of it.
 */
export type TileAreaRequest = Readonly<{ x: number; y: number; w: number; h: number }>;

/**
 * One tile of a rectangle: the facts a planner decides from, each owned by one function on the Mod.
 *
 * `tillable` is the Hoe's own admission predicate, `passable` the planner's own step test, and `occupant` the engine's
 * stored thing on the tile (`none` when free). There is no `fixture` field: a fixture plants real engine entities, so
 * the occupant and soil facts already carry it.
 */
export type TileAreaRow = Readonly<{
  x: number;
  y: number;
  tillable: boolean;
  occupant: string;
  hoed: boolean;
  watered: boolean;
  crop: boolean;
  passable: boolean;
}>;

/**
 * The answer to one rectangle question.
 *
 * `status` is the Mod's own closed vocabulary and `detail` names the refusal in full
 * (`inspect_tiles_area_too_large:100:11x10`). `omitted` is what the answer dropped for any reason OTHER than the area
 * bound, so an answered rectangle satisfies `rows.length + omitted === w * h` - a bound can never truncate in silence.
 */
export type TileAreaResult = Readonly<{
  status: "answered" | "area_too_large" | "invalid_rectangle" | "off_map" | "world_unavailable";
  detail: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  location: string | null;
  revision: number;
  areaLimit: number;
  rows: readonly TileAreaRow[] | null;
  omitted: number;
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
  /**
   * The STOP epoch this bubble was admitted under. It is the only ordering claim a presentation
   * makes: a request queued before a stop must not land after it. World revision is deliberately
   * absent — presentation mutates no world state, and no caller can know the Mod's exact current
   * action-transaction revision (see `farmhand-companion-presentation.ts`).
   */
  presentationEpoch: number;
}>;

export type SystemNoticeRequest = Readonly<{
  noticeId: string;
  /**
   * One of the Host-authored lines the game thread knows how to draw. The Mod validates the
   * copy under every key, so this union and `BridgeSession.IsValidSystemNoticeCopy` are the
   * same set: `system.provider.unavailable` is the one member whose text carries third-party
   * bytes, and it is accepted only behind its registered sentence.
   */
  key:
    | "system.stop.active_turn_cancelled"
    | "system.stop.queued_turn_cancelled"
    | "system.stop.no_active_turn"
    | "system.provider.waiting"
    | "system.provider.unavailable";
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
  /**
   * What this argument MEANS, in the Mod's own words.
   *
   * The field exists because a single Host-side sentence about a shared argument name cannot be true for every action
   * that takes it. Measured 2026-10-29: `PLAN_TOOL_SLOT_MEANING` said a `slot` is "never a backpack index", and all
   * thirteen actions that take a `slot` read a backpack index - three of them additionally require it to be the held
   * tool. The meaning belongs to the action, so the action's owner states it and it cannot drift from the handler.
   */
  description?: string;
}>;

export type ActionRegistrationDescriptor = Readonly<{
  arguments?: readonly ActionDescriptorArgument[];
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[]; description?: string }>>;
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
  /**
   * Where the body must already stand, in the Mod's own words, or absent when this action declares no such
   * precondition. Published because one the Mod enforces and never declares can only be learned by being
   * refused: measured 2026-10-25, `enter_exit` refused with `door_out_of_range` from six tiles away.
   *
   * `withinTiles` is ABSENT when the Mod's relation states no distance (its serializer omits nulls), which is never
   * the same statement as zero tiles.
   */
  approach?: Readonly<{ relation: string; withinTiles?: number }>;
  postcondition?: string | Readonly<{ name: string }>;
  /**
   * The snapshot family that supplies this action's targets (`cropTargets`), or absent when the surface declares none.
   *
   * A `BridgeSnapshot` FIELD name, which is why `isValidActionDescriptor` holds it to a lower-camel name rather than
   * to the action-id rule: `move_to_tile` is a snake_case verb phrase and `toolSlots` is a serialized property.
   */
  targetFamily?: string;
  /**
   * `true` on an action whose effect happens WITHOUT the NPC counter the player would use: the Mod spends the cost and
   * places the result itself instead of opening the shop or menu that owns the transaction (`build_farm_building`
   * deducts the `Data/Buildings` cost and materials and calls `GameLocation.buildStructure`, never Robin's carpenter
   * menu). ABSENT on every action that does go through its counter - the Mod omits the member when it is false - so a
   * reader can tell a counter purchase from one the companion performed on its own.
   *
   * Present-but-`false` is refused: the member is a claim, and the Mod never publishes the opposite of one.
   */
  synthetic?: boolean;
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
/**
 * Exact Host runtime value. Scalar kinds retain canonicalValue; destination_selector retains its typed object payload.
 *
 * `loop` is the one DECLARATIVE kind: the `for_each` plan form carried whole, because expansion happens on the game
 * thread against live state and a pre-resolved row list would be the observation-bound behaviour the form exists to
 * remove. Its grammar is owned by `body-program-for-each.ts`, the same module the plan compiler writes it with.
 */
type BodyProgramRuntimeValue =
  | Readonly<{ type: "integer" | "string" | "boolean"; canonicalValue: string }>
  | Readonly<{ type: "destination_selector"; destination: BodyProgramDestinationSelector }>
  | (Readonly<{ type: "loop" }> & PlanForEachLoop);
type BodyProgramFactReference = Readonly<{ nodeId: string; factName: string }>;
type BodyProgramNode = Readonly<{
  nodeId: string;
  actionId: string;
  arguments: Readonly<Record<string, BodyProgramRuntimeValue>>;
  /** The CONSUMPTION edge: not startable until these succeeded, and skipped when one fails. */
  dependsOn: readonly string[];
  /**
   * The ORDERING edge: not startable until these are terminal, and never skipped. Absent means no such edge - the
   * meaning the field has had since it reached the wire (`isBodyProgramNode` reads absent and empty alike).
   */
  orderedAfter?: readonly string[];
  bindings: Readonly<Record<string, BodyProgramFactReference>>;
}>;
/**
 * Frozen maximum Body Program node count on the WIRE, shared with C# `BodyProgramValidation.MaximumNodes`.
 *
 * A corruption bound like `MAX_NATIVE_NOTICES` below it, not a budget: a 16-node program is ordinary, so this refuses a
 * peer that could not have written this journal rather than limiting what one plan may do. It was 16, which meant the
 * reader enforced the writer's policy - see the C# declaration for the measurement (8 of 26 programs sat exactly on it).
 */
export const MAX_BODY_PROGRAM_NODES = 256;
/** Frozen native-notice bounds, shared with the C# NativeNoticeObserver. */
const MAX_NATIVE_NOTICES = 8;
const MAX_NATIVE_NOTICE_CHARS = 512;
/** Frozen per-node binding-map bound, aligned with the existing C# Core verifier bound of 4. */
export const MAX_BODY_PROGRAM_BINDINGS_PER_NODE = 4;
export type BodyProgramCandidateRequest = Readonly<{ programId: string; nodes: readonly BodyProgramNode[] }>;
export type BodyProgramStatusRequest = Readonly<{ programId?: string }>;

/**
 * A stop, fenced by the caller's STOP epoch.
 *
 * `stopEpoch` is not a timestamp and not a retry counter: the Mod refuses a stop whose epoch is not strictly greater than
 * the one already recorded for that program, which is what makes a replayed or reordered stop harmless. It has to travel
 * over the wire because only the Mod's journal can decide whether an intent is newer than the one that produced the
 * program.
 */
export type BodyProgramStopRequest = Readonly<{ programId: string; stopEpoch: number }>;

/**
 * Every node state the Mod's journal can settle a node in, in ONE declaration that also says what each one OWES a reader.
 *
 * The population is the Mod's own `BodyProgramNodeState` (eleven durable values, `BodyProgramModels.cs`), and it is
 * declared here as a value rather than as eleven `||` arms for one reason: the state list is what
 * `isBodyProgramNodeState` accepts AND what every reader of a plan row has to answer for, and a rule that says "only a
 * node that STOPPED owes a reason" cannot derive its population from a boolean function's source.
 *
 * `skipped_dependency` and `abandoned` are in it because the journal really settles nodes there: 30 skipped and 1
 * abandoned against ZERO `recovery_required` in one measured run, while the wire projection named nine states and folded
 * both into `recovery_required` - a vocabulary collapse that read as a condition.
 *
 * THE VERDICT IS PART OF THE STATE, not a second list beside it, because a waiter that decided this for itself would be
 * a second authority over the same fact:
 *  - `moving` - not stopped; nothing has ended, so a reader is owed no reason at all.
 *  - `stopped_succeeded` - stopped, and the receipt proved the effect; the effect IS the answer.
 *  - `stopped_without_success` - stopped short of the effect; it owes a reason, and a settlement that named none anywhere
 *    on its row is a defect the reader must be told about (`unknown_reason:<state>`) instead of having quietly passed over.
 *
 * `partially_succeeded` answers `stopped_without_success` rather than a fourth verdict, and the word is exact there: the
 * node did NOT fully succeed, so it owes the reason for the part that did not happen - while its `state` token, which
 * travels verbatim on the same row, is what says it also did something. A fourth verdict would be a second spelling of that
 * distinction in the one place that only needs to know whether a reason is owed.
 */
export const BODY_PROGRAM_NODE_STATE_VERDICTS = Object.freeze({
  pending: "moving",
  awaiting_host_admission: "moving",
  host_admitted: "moving",
  running: "moving",
  succeeded: "stopped_succeeded",
  // Stopped short of the effect - it did PART of it - so it owes the reason for the rest, exactly as a `failed` node does.
  partially_succeeded: "stopped_without_success",
  failed: "stopped_without_success",
  cancelled: "stopped_without_success",
  recovery_required: "stopped_without_success",
  rejected: "stopped_without_success",
  skipped_dependency: "stopped_without_success",
  abandoned: "stopped_without_success",
} as const);
export type BodyProgramNodeState = keyof typeof BODY_PROGRAM_NODE_STATE_VERDICTS;
/** What one node state owes a reader: nothing while it moves, nothing when it succeeded, a reason when it stopped short. */
export type BodyProgramNodeStateVerdict = (typeof BODY_PROGRAM_NODE_STATE_VERDICTS)[BodyProgramNodeState];

/**
 * The same states as an ordered list, DERIVED from the verdicts above so the two cannot disagree about which state a node
 * can be in. A reader that only needs membership uses this; one that needs the reason rule asks the declaration.
 */
export const BODY_PROGRAM_NODE_STATES: readonly BodyProgramNodeState[] = Object.freeze(
  Object.keys(BODY_PROGRAM_NODE_STATE_VERDICTS) as BodyProgramNodeState[],
);

/** What the declaration says about one state - `undefined` for a token it does not name (the Host's own `unknown`). */
export function bodyProgramNodeStateVerdict(state: string): BodyProgramNodeStateVerdict | undefined {
  return Object.hasOwn(BODY_PROGRAM_NODE_STATE_VERDICTS, state)
    ? BODY_PROGRAM_NODE_STATE_VERDICTS[state as BodyProgramNodeState]
    : undefined;
}
/**
 * The states a node may carry `refusalDetail` on: the ones where it settled without succeeding.
 *
 * The same four the Mod's journal permits (`BodyProgramValidation.MayCarryRefusalDetail`), stated over the wire token: a
 * `succeeded` node proves an effect, an in-flight one has refused nothing, and `recovery_required` says why in
 * `recoveryDiagnostic` instead. `partially_succeeded` is in the set because what part of it did NOT happen is a refusal
 * of exactly that kind, one row at a time. A state the Mod allows here and this set does not is a frame the Mod sends
 * and this validator refuses, which `local-stardew-bridge.ts` answers by closing the transport;
 * `tools/check-refusal-detail-state-parity.mjs` derives both sides from those declarations and names the drifting state
 * rather than leaving the disagreement to a live run. Exported so a gate can exercise the real-detail arm on exactly the
 * states the wire permits it, instead of on a second list written in the test.
 */
export const BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES: ReadonlySet<BodyProgramNodeState> = new Set([
  "failed",
  "cancelled",
  "rejected",
  "partially_succeeded",
]);

/** The Mod's own bound on a refusal detail (`BodyProgramValidation.MaximumNodeRefusalDetailLength`). */
export const MAX_BODY_PROGRAM_REFUSAL_DETAIL_LENGTH = 512;

/** The Mod's own bound on a recovery diagnostic (`BodyProgramValidation.MaximumRecoveryDiagnosticLength`). */
export const MAX_BODY_PROGRAM_RECOVERY_DIAGNOSTIC_LENGTH = 4096;
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
  /** Why the node holds this state, when the Mod recorded a reason. Absent when there is none. */
  rejectionCode?: string | null;
  /**
   * Why a dispatched node settled without succeeding, in the action-owned receipt's own words
   * (`door_out_of_range`, `player_not_actionable`). Only on `failed`/`cancelled`, absent otherwise.
   *
   * A cause, never proof of an effect: those states still carry no receipt, evidence, postcondition or facts.
   */
  failureCode?: string | null;
  /**
   * Where the caller can go instead, when the reason is that the target has no route.
   *
   * A hint, not evidence: it claims nothing happened and proves no effect, which is why it can ride beside `failureCode`
   * on a node whose evidence is deliberately absent (ADR-006). `closest=49,14;closest_distance=1` is the shape.
   */
  hint?: string | null;
  /**
   * WHY a node settled without succeeding, in the refusing layer's own words - e.g.
   * `owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1`.
   *
   * A reason detail, never proof of an effect: it is legal exactly on the states the declaration
   * `BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES` names and never on `succeeded`, which is the same footing `failureCode`
   * has. Absent when the Mod had nothing more to say than the code, and the plan answer then says so instead of staying
   * silent (`program-status-wait.ts:planNodeReasonDetail`).
   */
  refusalDetail?: string | null;
  /**
   * The journal's own diagnostic for a node whose outcome cannot be determined (`execution_uncertain`).
   *
   * Only on `recovery_required`. Without it that state reaches a caller as a state with no reason at all, and a reader
   * that then has to say "no reason" would be saying something it already knew to be false.
   */
  recoveryDiagnostic?: string | null;
  /**
   * The action this node runs, from the journal's own compiled descriptor.
   *
   * REQUIRED, unlike every other addition here, because the whole point of it is that a reader that has lost its
   * `programId` can still say what it did: a frame without it is one this Host refuses rather than one it reports as
   * "an action that is not named".
   */
  actionId: string;
  /**
   * The tile this node addressed, read from the canonical arguments the Mod bound at admission. `x` and `y` travel
   * together, and both are null for a node whose arguments name no tile - which is a fact, not a missing value.
   */
  x?: number | null;
  y?: number | null;
}>;
export type BodyProgramStatusSnapshot = Readonly<{
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
/**
 * One query answer: by id (`snapshot`) or, when the caller named no id, the journal's newest programs (`programs`).
 *
 * `programCount` is the journal's TOTAL on both paths, so a bounded page can be reported as "read 8 of 143" instead of
 * reading as a short history. Exactly one of the two paths is populated on a `found` answer; both are null when the query
 * did not succeed.
 */
export type BodyProgramStatusResult = Readonly<{
  code: "found" | "not_found" | "invalid_input";
  snapshot: BodyProgramStatusSnapshot | null;
  programs: readonly BodyProgramStatusSnapshot[] | null;
  programCount: number;
}>;
/**
 * What a stop answers: the controller's own vocabulary, verbatim.
 *
 * The three codes a caller must be able to tell apart are `program_not_active` (nothing to stop - retrying is pointless),
 * `invalid_input` (the epoch was not newer than the one on record - retrying with the same epoch is wrong) and
 * `persistence_write_failed` (the journal could not record the cancellation - retrying is dangerous until that resolves).
 * Folding them into a boolean would collapse all three into "no".
 */
export type BodyProgramStopResult = Readonly<{
  code:
    | "succeeded"
    | "not_found"
    | "invalid_input"
    | "program_not_active"
    | "node_not_eligible"
    | "policy_identity_stale"
    | "grant_mismatch"
    | "execution_binding_mismatch"
    | "fact_provenance_mismatch"
    | "invalid_fact"
    | "terminal_proof_missing"
    | "recovery_required"
    | "persistence_write_failed"
    | "deadline_expired";
  snapshot: BodyProgramStatusSnapshot | null;
}>;
/**
 * One addressed journal event.
 *
 * `atMs` is the Mod's own monotonic stamp of the moment it appended this event - the native dispatch on
 * `native_dispatch`, the action's settlement on `node_completed`/`node_settled` - carried verbatim so no reader has to
 * substitute the moment it received the frame for the moment the game acted.
 */
type BodyProgramEvent = Readonly<{
  cursor: number;
  programId: string;
  kind: string;
  catalogRevision: number;
  nodeId: string | null;
  nodeAttempt: number | null;
  atMs: number;
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
  | Envelope<"data_query_request", DataQueryRequest>
  | Envelope<"data_query_result", DataQueryResult>
  | Envelope<"tile_area_request", TileAreaRequest>
  | Envelope<"tile_area_result", TileAreaResult>
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
  | Envelope<"companion_presentation_receipt", Readonly<{ expressionId: string; presentationEpoch: number }>>
  | Envelope<"player_control_receipt", PlayerControlReceipt>
  | Envelope<"execution_receipt", ExecutionReceipt>
  | Envelope<"program_submit", BodyProgramCandidateRequest>
  | Envelope<"program_submit_result", BodyProgramSubmitResult>
  | Envelope<"program_status", BodyProgramStatusRequest>
  | Envelope<"program_status_result", BodyProgramStatusResult>
  | Envelope<"program_stop", BodyProgramStopRequest>
  | Envelope<"program_stop_result", BodyProgramStopResult>
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
  "data_query_request",
  "data_query_result",
  "tile_area_request",
  "tile_area_result",
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
  "program_stop",
  "program_stop_result",
  "program_events",
  "program_events_result",
  "error",
  "semantic_event",
  "lifecycle",
  "world_fact",
] as const;

/**
 * Every key a Mod snapshot may carry: the bridge's admission boundary, and the population any consumer of a
 * snapshot must be checked against.
 */
export const SNAPSHOT_KEYS = [
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
  "currentToolSlot",
  "currentToolSlotItem",
  "inventorySlots",
  "actionable",
  "capabilities",
  "catalogRevision",
  "pendingLevelUps",
  "pendingLevelUpChoices",
  "professions",
  "enabledActionIds",
  "presentationLocale",
  "timeOfDay",
  "dayOfMonth",
  "seasonIndex",
  "year",
  "activeExecution",
  "warps",
  "doorTargets",
  "fixedInteractionPoints",
  "fixedInteractionPointsOmitted",
  "soilTiles",
  "soilTilesOmitted",
  "farmBuildingTargetsOmitted",
  "discoveryExclusions",
  "discoveryExclusionsOmitted",
  "toolSlots",
  "wateringCanFacts",
  "refillWateringCanTargets",
  "waterTargets",
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
  "wateringWhereabouts",
  "petTargets",
  "farmAnimalPetTargets",
  "animalProductTargets",
  "feedTroughTargets",
  "chests",
  "chestsSummary",
  "inventoryItemFacts",
  "foodTargets",
  "shippingBinTargets",
  "craftingRecipeTargets",
  "cookingRecipeTargets",
  "cookingStationTargets",
  "shopTargets",
  "seedSupplyTargets",
  "seedSupplyTargetsOmitted",
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
    case "data_query_request":
      return validateDataQueryRequest(payload);
    case "data_query_result":
      return validateDataQueryResult(payload);
    case "tile_area_request":
      return validateTileAreaRequest(payload);
    case "tile_area_result":
      return validateTileAreaResult(payload);
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
      const presentationEpoch = payload.presentationEpoch;
      if (typeof presentationEpoch !== "number" || !Number.isSafeInteger(presentationEpoch) || presentationEpoch < 0)
        return "invalid_companion_presentation_request";
      return hasExactKeys(payload, ["expressionId", "sourceEventId", "text", "locale", "presentationEpoch"]) &&
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
      return hasExactKeys(payload, ["expressionId", "presentationEpoch"]) && isOpaqueId(payload.expressionId)
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
    case "program_stop":
      // Both fields required, and the epoch must be a non-negative safe integer: a stop without a fence would be a cancel
      // any replay could re-issue.
      return hasExactKeys(payload, ["programId", "stopEpoch"]) &&
        isOpaqueId(payload.programId) &&
        isNonNegativeSafeInteger(payload.stopEpoch)
        ? null
        : "invalid_body_program_stop_request";
    case "program_stop_result":
      return validateBodyProgramStopResult(payload);
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
      (value.result === "unavailable" && !value.code.startsWith("admission_unavailable"))
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
    Object.entries(value.derivedResourceClaims).every(
      ([k, v]) => isResourceClaimKey(k) && isDerivedResourceClaimValue(v),
    ) &&
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

/** A resource-claim key's length bound, mirroring the Mod's `BodyProgramValidation.IsResourceClaimKey`. */
const MAX_RESOURCE_CLAIM_KEY_LENGTH = 128;
/**
 * The resource-claim key's segment bound. N segments need at least `2N - 1` characters, so 64 is the largest
 * count the length bound already allows; it is kept explicit because the contract names the bound, not to add
 * a second restriction on top of the length.
 */
const MAX_RESOURCE_CLAIM_KEY_SEGMENTS = 64;

/**
 * A derived resource claim's KEY: one or more lowercase identifier segments joined by `:`, so `embodied_actor`
 * and `tool:scythe` are the same shape. This is the Mod's own rule (`BodyProgramValidation.IsResourceClaimKey`)
 * and the reason the claim map cannot reuse `isAdmissionMapKey`: the key IS the resource identity the Mod
 * derives, persists and conflicts on, so it is admitted by name or refused, never re-spelled. The `__proto__`
 * refusal is kept from the old key rule so a JSON-owned key cannot be mistaken for an own property.
 * `canonicalBoundArgs` is a different map and keeps the bare rule, because the Mod parses those names with
 * `IsOpaqueId` (BridgeProtocol) and `IsIdentifier` (journal) and can never carry a colon.
 */
function isResourceClaimKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_RESOURCE_CLAIM_KEY_LENGTH) return false;
  if (value === "__proto__") return false;
  const segments = value.split(":");
  if (segments.length > MAX_RESOURCE_CLAIM_KEY_SEGMENTS) return false;
  return segments.every((segment) => /^[a-z0-9_]+$/u.test(segment));
}

/**
 * A derived resource claim's VALUE: an opaque id (a scoped player, an action identity) or the claim-key form
 * the Mod publishes verbatim for a tool-family claim (`tool:scythe` names itself on both sides of the map).
 * Mirrors the Mod's `ReadResourceClaimValue`.
 */
function isDerivedResourceClaimValue(value: unknown): value is string {
  return isOpaqueId(value) || isResourceClaimKey(value);
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
    // `reachable` and `identity` are OPTIONAL and independent.
    //
    // `reachable` is tri-state: `false` is a measured no, ABSENT or null is undecided (nobody checked), and a `null` may
    // never read as `false`. `identity` is the id the advertised action validates - published only for the kinds whose
    // action has one, because the payload is measured against a byte ceiling.
    //
    // Both are decided BEFORE the exact-key check: a key set that does not name every field the Mod may send refuses
    // every observation that uses one, and that closed the bridge at `round16` (`invalid_observe_scene_result`) exactly as
    // it did when `sceneTarget` was added to the catalog and `chest_retrieve`'s host branch still expected the old shape.
    const allowReachable = affordance.reachable !== undefined;
    const allowIdentity = affordance.identity !== undefined;
    const expectedKeys = ["ref", "kind", "name", "distance", "direction", "actionHint"];
    if (allowReachable) expectedKeys.push("reachable");
    if (allowIdentity) expectedKeys.push("identity");
    if (
      !isRecord(affordance) ||
      !hasExactKeys(affordance, expectedKeys) ||
      (allowIdentity && !boundedSceneText(affordance.identity, 128)) ||
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

function validateDataQueryRequest(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["table", "key"])) return "invalid_data_query_request";
  if (!isBoundedNonEmptyString(value.table, 64)) return "invalid_data_query_request";
  if (value.key !== null && !isBoundedNonEmptyString(value.key, 128)) return "invalid_data_query_request";
  return null;
}

/**
 * A content-table answer, in the Mod's own closed vocabulary.
 *
 * `population` is -1 exactly when no table was found to count, and every status that carries no rows says why in
 * `detail`: an answer that names nothing is the defect this shape exists to prevent.
 */
function validateDataQueryResult(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["status", "table", "population", "ids", "row", "detail"]))
    return "invalid_data_query_result";
  if (!isBoundedNonEmptyString(value.table, 64)) return "invalid_data_query_result";
  if (typeof value.population !== "number" || !Number.isSafeInteger(value.population))
    return "invalid_data_query_result";
  if (value.status === "index")
    return value.population >= 0 && isDataQueryIds(value.ids) && value.row === null && value.detail === null
      ? null
      : "invalid_data_query_result";
  if (value.status === "row")
    return value.population >= 0 && value.ids === null && isDataQueryRow(value.row) && value.detail === null
      ? null
      : "invalid_data_query_result";
  if (value.status === "absent_row" || value.status === "unknown_table" || value.status === "not_projectable")
    return value.population >= -1 &&
      value.ids === null &&
      value.row === null &&
      isBoundedNonEmptyString(value.detail, 512)
      ? null
      : "invalid_data_query_result";
  return "invalid_data_query_result";
}

/** The wire's own bound on one rectangle coordinate and one side, mirrored by the Mod's request parser. */
const TILE_AREA_COORDINATE_LIMIT = 1000;
const TILE_AREA_SIDE_LIMIT = 1000;
/** The Mod's own area bound (`TileAreaQuery.AreaLimit`), which is also the widest row list one answer can carry. */
const TILE_AREA_ROW_LIMIT = 100;

/**
 * One rectangle question.
 *
 * The AREA bound is deliberately absent here: a request for 11x10 must reach the Mod, whose answer names the limit and
 * the requested size. Refusing it at this layer would turn a stated bound into a schema error that states nothing.
 */
function validateTileAreaRequest(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["x", "y", "w", "h"])) return "invalid_tile_area_request";
  const coordinate = (entry: unknown): boolean =>
    Number.isSafeInteger(entry) && Math.abs(entry as number) <= TILE_AREA_COORDINATE_LIMIT;
  const side = (entry: unknown): boolean =>
    Number.isSafeInteger(entry) && (entry as number) >= 1 && (entry as number) <= TILE_AREA_SIDE_LIMIT;
  return coordinate(value.x) && coordinate(value.y) && side(value.w) && side(value.h)
    ? null
    : "invalid_tile_area_request";
}

/**
 * One rectangle answer, in the Mod's own closed vocabulary.
 *
 * The rectangle is echoed on every status so a refusal names the question it refused, and the answered arm carries the
 * population invariant that makes a silent truncation impossible: `rows.length + omitted === w * h`.
 */
function validateTileAreaResult(value: Record<string, unknown>): string | null {
  if (
    !hasExactKeys(value, [
      "status",
      "detail",
      "x",
      "y",
      "w",
      "h",
      "location",
      "revision",
      "areaLimit",
      "rows",
      "omitted",
    ])
  )
    return "invalid_tile_area_result";
  if (!["x", "y", "w", "h"].every((key) => Number.isSafeInteger(value[key]))) return "invalid_tile_area_result";
  if (!isNonNegativeSafeInteger(value.revision) || !isPositiveSafeInteger(value.areaLimit))
    return "invalid_tile_area_result";
  if (!isNonNegativeSafeInteger(value.omitted)) return "invalid_tile_area_result";
  if (value.status === "answered") {
    if (!boundedSceneText(value.location, 128) || value.detail !== null) return "invalid_tile_area_result";
    const rows = value.rows;
    if (
      !Array.isArray(rows) ||
      rows.length > TILE_AREA_ROW_LIMIT ||
      (value.w as number) * (value.h as number) !== rows.length + (value.omitted as number)
    )
      return "invalid_tile_area_result";
    return rows.every((row) => isTileAreaRow(row)) ? null : "invalid_tile_area_result";
  }
  if (
    value.status === "area_too_large" ||
    value.status === "invalid_rectangle" ||
    value.status === "off_map" ||
    value.status === "world_unavailable"
  )
    return value.rows === null && value.location === null && isBoundedNonEmptyString(value.detail, 512)
      ? null
      : "invalid_tile_area_result";
  return "invalid_tile_area_result";
}

function isTileAreaRow(value: unknown): value is TileAreaRow {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["x", "y", "tillable", "occupant", "hoed", "watered", "crop", "passable"]) &&
    Number.isSafeInteger(value.x) &&
    Number.isSafeInteger(value.y) &&
    typeof value.tillable === "boolean" &&
    isBoundedNonEmptyString(value.occupant, 64) &&
    typeof value.hoed === "boolean" &&
    typeof value.watered === "boolean" &&
    typeof value.crop === "boolean" &&
    typeof value.passable === "boolean"
  );
}

function isDataQueryIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 4096 && value.every((id) => isBoundedNonEmptyString(id, 128));
}

/** One projected row: an id, and the fields the Mod kept - scalars and string arrays only, never a nested document. */
function isDataQueryRow(value: unknown): value is DataQueryRow {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "fields"]) || !isBoundedNonEmptyString(value.id, 128))
    return false;
  if (!isRecord(value.fields)) return false;
  const fields = Object.entries(value.fields);
  if (fields.length > 32) return false;
  return fields.every(([, field]) => isDataQueryFieldValue(field));
}

function isDataQueryFieldValue(value: unknown): value is DataQueryFieldValue {
  if (value === null) return true;
  if (typeof value === "string") return value.length <= 256;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (entry) =>
        (typeof entry === "string" && entry.length <= 256) ||
        (typeof entry === "number" && Number.isFinite(entry)) ||
        typeof entry === "boolean",
    )
  );
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

/**
 * What one row of the execution-request declaration decides.
 *
 * `field` and `shape` are what a refusal points at, and `refusal` is the code it returns. The codes are the ones this
 * validator has always returned, word for word, because a validator that stops saying which field it rejected is worse
 * than a long one. `violated` is the same reading with that one fact broken, so a test walks the rows instead of
 * trusting them; `execution-request-declaration.test.ts` does exactly that, one row at a time.
 */
export type ExecutionRequestRequirement = Readonly<{
  field: string;
  shape: string;
  refusal: string;
  /**
   * The exact argument names this row pins, for the rows that pin a set.
   *
   * `field` and `shape` describe the row to a READER; this is the same fact as data, so a gate that compares the Host's
   * demand against the Mod's published `argumentSchema` reads a key list instead of parsing a sentence.
   */
  argumentNames?: readonly string[];
  /**
   * The whole-number range this row pins, for the rows that pin one.
   *
   * The range used to exist only inside the predicate and the prose `shape`, so every surface that had to state the same
   * argument again - the tool schema the model reads, the plan example it copies - wrote the bounds a second time, and a
   * second copy of a range the validator enforces is a disagreement waiting for someone to change one of them.
   */
  integerBound?: ExecutionRequestIntegerBound;
  isMet: (reading: ExecutionRequestReading) => boolean;
  violated: (reading: ExecutionRequestReading) => ExecutionRequestReading;
}>;

/** One whole-number argument and the range the wire accepts for it, as data rather than as a sentence. */
export type ExecutionRequestIntegerBound = Readonly<{
  argument: string;
  minimum: number;
  /** `null` is no ceiling, which is not the same as a ceiling nobody wrote down. */
  maximum: number | null;
}>;

/**
 * The payload under judgement, plus the two facts a row may consult beyond it.
 *
 * `args` is the payload's own `args` read as a key set. The `invalid_args` envelope row refuses a payload whose `args` is
 * not a record before any argument row is reached, so the empty object left here for an unreadable `args` is never the
 * reason a row agrees.
 */
export type ExecutionRequestReading = Readonly<{
  request: Readonly<Record<string, unknown>>;
  args: Readonly<Record<string, unknown>>;
  snapshot: Snapshot;
  nowMs: number;
}>;

function requirement(
  field: string,
  shape: string,
  refusal: string,
  isMet: ExecutionRequestRequirement["isMet"],
  violated: ExecutionRequestRequirement["violated"],
  argumentNames?: readonly string[],
  integerBound?: ExecutionRequestIntegerBound,
): ExecutionRequestRequirement {
  return Object.freeze({
    field,
    shape,
    refusal,
    ...(argumentNames === undefined ? {} : { argumentNames }),
    ...(integerBound === undefined ? {} : { integerBound }),
    isMet,
    violated,
  });
}

/** The reading with one argument value replaced, in the payload as well as in the key set the rows read. */
function withArg(name: string, value: unknown): ExecutionRequestRequirement["violated"] {
  return (reading) => {
    const args = { ...reading.args, [name]: value };
    return { ...reading, args, request: { ...reading.request, args } };
  };
}

/** The reading with one required argument REMOVED: the smallest faithful violation of an exact key set. */
function withoutArg(name: string): ExecutionRequestRequirement["violated"] {
  return (reading) => {
    const args = Object.fromEntries(Object.entries(reading.args).filter(([key]) => key !== name));
    return { ...reading, args, request: { ...reading.request, args } };
  };
}

/** The one construction of a reading: the payload, its own `args` as a key set, and the facts a row may consult. */
export function executionRequestReading(
  request: Readonly<Record<string, unknown>>,
  snapshot: Snapshot,
  nowMs: number,
): ExecutionRequestReading {
  return { request, args: isRecord(request.args) ? request.args : {}, snapshot, nowMs };
}

/** The exact argument set the action's own Mod-side wire parser pins (`BridgeProtocol.ExecutionArgumentProperties`). */
function exactArgs(names: readonly string[], refusal: string): ExecutionRequestRequirement {
  return requirement(
    "args",
    names.length === 0 ? "no arguments at all" : `exactly [${names.join(", ")}] and nothing else`,
    refusal,
    (reading) => hasExactKeys(reading.args, names),
    names.length === 0 ? withArg("unexpected", true) : withoutArg(names[0] ?? ""),
    names,
  );
}

/** `args.x`/`args.y` as a walkable tile: the in-map range, not the warp-source range. */
function tileRow(refusal: string): ExecutionRequestRequirement {
  return requirement(
    "args.x, args.y",
    "a tile inside the map",
    refusal,
    (reading) => isTileCoordinate(reading.args.x) && isTileCoordinate(reading.args.y),
    withArg("x", -1),
  );
}

/**
 * `args.x`/`args.y` as a WARP SOURCE.
 *
 * A map declares an edge exit with its source outside the grid (`-1 53 BusStop 42 23`) and `snapshot.warps[]` publishes
 * exactly that source, so requiring an in-map tile here refused the very exit the snapshot had just advertised: the model
 * copied `{sourceX, sourceY}` and the Host answered `invalid_warp_source`. `isWarpSourceCoordinate` is this side's one
 * declaration of that range and is already what the `warps` rows are validated with, so reading and asking agree.
 */
function warpSourceRow(refusal: string): ExecutionRequestRequirement {
  return requirement(
    "args.x, args.y",
    "a warp source, which may sit at -1 on a boundary axis",
    refusal,
    (reading) => isWarpSourceCoordinate(reading.args.x) && isWarpSourceCoordinate(reading.args.y),
    withArg("x", -2),
  );
}

/** `args.slot`: a backpack slot. */
function slotRow(refusal: string): ExecutionRequestRequirement {
  return requirement(
    "args.slot",
    "a backpack slot",
    refusal,
    (reading) => isToolSlot(reading.args.slot),
    withArg("slot", 99),
  );
}

/** `args.expectedTargetId`: the opaque id a snapshot family published. */
function targetRow(refusal: string): ExecutionRequestRequirement {
  return requirement(
    "args.expectedTargetId",
    "an opaque target id the snapshot published",
    refusal,
    (reading) => isOpaqueId(reading.args.expectedTargetId),
    withArg("expectedTargetId", "not an id"),
  );
}

/** `args.expectedQualifiedItemId`: the item's own wire identity, non-empty. */
function itemRow(refusal: string): ExecutionRequestRequirement {
  return requirement(
    "args.expectedQualifiedItemId",
    "the item's own wire identity",
    refusal,
    (reading) =>
      typeof reading.args.expectedQualifiedItemId === "string" && reading.args.expectedQualifiedItemId.length > 0,
    withArg("expectedQualifiedItemId", ""),
  );
}

/** The same, at the ceiling the action's own Mod-side handler also enforces. */
function boundedItemRow(refusal: string, maxLength: number): ExecutionRequestRequirement {
  return requirement(
    "args.expectedQualifiedItemId",
    `the item's own wire identity, at most ${maxLength} characters`,
    refusal,
    (reading) => isBoundedNonEmptyString(reading.args.expectedQualifiedItemId, maxLength),
    withArg("expectedQualifiedItemId", ""),
  );
}

/** The same, as the engine's qualified form `(prefix)id`. */
function qualifiedItemRow(refusal: string): ExecutionRequestRequirement {
  return requirement(
    "args.expectedQualifiedItemId",
    "the engine's qualified item id, `(prefix)id`",
    refusal,
    (reading) => isQualifiedItemId(reading.args.expectedQualifiedItemId),
    withArg("expectedQualifiedItemId", "Carrot"),
  );
}

/**
 * The same, pinned to the ONE item the action places.
 *
 * A fence, a crab pot and a bait pot are placed from a specific carried item, so the wire names it and the Host refuses
 * any other: a request that reached the Mod with a different stack would place something the caller did not ask for.
 */
function pinnedItemRow(refusal: string, qualifiedItemId: string): ExecutionRequestRequirement {
  return requirement(
    "args.expectedQualifiedItemId",
    `the pinned item \`${qualifiedItemId}\``,
    refusal,
    (reading) => reading.args.expectedQualifiedItemId === qualifiedItemId,
    withArg("expectedQualifiedItemId", ``),
  );
}

/** `args.<name>` as an opaque id. */
function opaqueArgRow(name: string, refusal: string): ExecutionRequestRequirement {
  return requirement(
    `args.${name}`,
    "an opaque id",
    refusal,
    (reading) => isOpaqueId(reading.args[name]),
    withArg(name, "not an id"),
  );
}

/** `args.<name>` as a whole number in `[minimum, maximum]`, where a null `maximum` is no ceiling. */
function integerRow(
  name: string,
  minimum: number,
  maximum: number | null,
  refusal: string,
): ExecutionRequestRequirement {
  return requirement(
    `args.${name}`,
    maximum === null ? `a whole number of at least ${minimum}` : `a whole number from ${minimum} to ${maximum}`,
    refusal,
    (reading) =>
      Number.isSafeInteger(reading.args[name]) &&
      (reading.args[name] as number) >= minimum &&
      (maximum === null || (reading.args[name] as number) <= maximum),
    withArg(name, minimum - 1),
    undefined,
    Object.freeze({ argument: name, minimum, maximum }),
  );
}

/** `args.<name>` as a non-empty string of at most `maxLength` characters. */
function boundedTextRow(name: string, maxLength: number, refusal: string): ExecutionRequestRequirement {
  return requirement(
    `args.${name}`,
    `a non-empty string of at most ${maxLength} characters`,
    refusal,
    (reading) => isBoundedNonEmptyString(reading.args[name], maxLength),
    withArg(name, ""),
  );
}

/**
 * `args.<name>` as `""` or a string of at most `maxLength` characters: the shape of an argument whose EMPTY value is a
 * meaning rather than an omission.
 *
 * `fish_here`'s `requestedFish` is the only member today: `""` asks for any fish, and the ceiling is the same number
 * the Mod enforces (`FarmhandActionCatalog.RequestedFishMaximumLength`) for the same reason
 * `send_multiplayer_chat`'s text is bounded on both sides - the value is echoed into the refusal that reports a
 * mismatch (`fish_species_mismatch:<requested>:<caught>`), and a reason code no frame can carry is not a refusal.
 */
function optionalTextRow(name: string, maxLength: number, refusal: string): ExecutionRequestRequirement {
  return requirement(
    `args.${name}`,
    `an empty string, or a string of at most ${maxLength} characters`,
    refusal,
    (reading) => typeof reading.args[name] === "string" && (reading.args[name] as string).length <= maxLength,
    withArg(name, "x".repeat(maxLength + 1)),
  );
}

/**
 * `args.text` as the action's ONLY argument.
 *
 * One row and not two, because here the arguments are one field: the key set, the blankness and the ceiling are that
 * field's shape, and all three are refused under the same code.
 */
function textOnlyRow(maxLength: number): ExecutionRequestRequirement {
  return requirement(
    "args.text",
    `the only argument, a non-blank string of at most ${maxLength} characters`,
    "invalid_execution_request",
    (reading) =>
      hasExactKeys(reading.args, ["text"]) &&
      typeof reading.args.text === "string" &&
      reading.args.text.trim().length > 0 &&
      reading.args.text.length <= maxLength,
    withArg("text", ""),
    ["text"],
  );
}

/**
 * The opaque family target the same snapshot published AT THAT TILE: the horse, the mine entrance, the ladder.
 *
 * The tile alone is not enough and the id alone is not enough. The id is re-resolved on the Mod's game thread against the
 * live world, so a pair that only one of the two could satisfy is a request the snapshot did not offer.
 */
function publishedTargetRow(
  shape: string,
  refusal: string,
  family: (snapshot: Snapshot) => readonly Readonly<{ targetId: string; x: number; y: number }>[] | undefined,
): ExecutionRequestRequirement {
  return requirement(
    "args.expectedTargetId, args.x, args.y",
    shape,
    refusal,
    (reading) =>
      family(reading.snapshot)?.some(
        (target) =>
          target.targetId === reading.args.expectedTargetId &&
          target.x === reading.args.x &&
          target.y === reading.args.y,
      ) === true,
    withArg("x", 12),
  );
}

/** The `{x, y, expectedTargetId}` shape, refused under the one code the action's own handler names. */
function tileAndTarget(refusal: string): readonly ExecutionRequestRequirement[] {
  return [tileRow(refusal), targetRow(refusal)];
}

/** The `{slot, x, y, expectedTargetId}` shape. */
function toolTileAndTarget(refusal: string): readonly ExecutionRequestRequirement[] {
  return [slotRow(refusal), tileRow(refusal), targetRow(refusal)];
}

/** The `{x, y, expectedQualifiedItemId, expectedTargetId}` shape. */
function tileItemAndTarget(refusal: string, item: ExecutionRequestRequirement): readonly ExecutionRequestRequirement[] {
  return [tileRow(refusal), item, targetRow(refusal)];
}

/** The `{slot, x, y, expectedQualifiedItemId, expectedTargetId}` shape. */
function toolTileItemAndTarget(
  refusal: string,
  item: ExecutionRequestRequirement,
): readonly ExecutionRequestRequirement[] {
  return [slotRow(refusal), tileRow(refusal), item, targetRow(refusal)];
}

/**
 * The most arguments an execution request may carry, whatever its action takes.
 *
 * The wire layer held this bound anonymously - `Object.keys(value.args).length <= 8` inside the envelope expression - and
 * a bound written inside an `&&` is a bound nobody can find. It is declared here and named by the row below. Which
 * arguments an action takes is that action's own row list, and every one of those sets is smaller than this ceiling: what
 * this row says is how many arguments a frame may carry before the frame is no longer the shape of an execution request.
 *
 * Because it fires before the action's exact-set row, a nine-argument payload is now refused `invalid_args` where the
 * actions whose exact-set row carries `invalid_execution_request` used to answer with that code. The count is the
 * envelope's fact and the names are the action's, so the more specific code is the one that belongs to the payload.
 */
export const EXECUTION_REQUEST_ARGUMENT_CEILING = 8;

/**
 * The fields of the execution-request payload the Host validates, in the order it decides them.
 *
 * Shape plus code per row, and the order IS the contract: a caller is told the FIRST fact that stopped it, so moving a
 * row moves which refusal a doubly-wrong payload receives.
 */
export const EXECUTION_REQUEST_REQUIREMENTS: readonly ExecutionRequestRequirement[] = Object.freeze([
  requirement(
    "the payload",
    "exactly {requestId, idempotencyKey, action, args, expectedRevision, deadlineMs}",
    "invalid_request",
    (reading) =>
      hasExactKeys(reading.request, [
        "requestId",
        "idempotencyKey",
        "action",
        "args",
        "expectedRevision",
        "deadlineMs",
      ]),
    (reading) => ({ ...reading, request: {} }),
  ),
  requirement(
    "requestId, idempotencyKey",
    "each an opaque id",
    "invalid_request_id",
    (reading) => isOpaqueId(reading.request.requestId) && isOpaqueId(reading.request.idempotencyKey),
    (reading) => ({ ...reading, request: { ...reading.request, idempotencyKey: "not an opaque id" } }),
  ),
  requirement(
    "action",
    "one of the action ids this declaration carries argument rows for",
    "unknown_action",
    (reading) => isExecutionAction(reading.request.action),
    (reading) => ({ ...reading, request: { ...reading.request, action: "sell_item" } }),
  ),
  requirement(
    "args",
    "a record",
    "invalid_args",
    (reading) => isRecord(reading.request.args),
    (reading) => ({ ...reading, request: { ...reading.request, args: 5 } }),
  ),
  requirement(
    "args",
    `at most ${EXECUTION_REQUEST_ARGUMENT_CEILING} arguments`,
    "invalid_args",
    (reading) => Object.keys(reading.args).length <= EXECUTION_REQUEST_ARGUMENT_CEILING,
    (reading) => {
      const args = Object.fromEntries(
        Array.from({ length: EXECUTION_REQUEST_ARGUMENT_CEILING + 1 }, (_, index) => [`argument${index}`, index]),
      );
      return { ...reading, args, request: { ...reading.request, args } };
    },
  ),
  requirement(
    "expectedRevision",
    "the revision of the snapshot the request is dispatched against",
    "stale_snapshot",
    (reading) =>
      Number.isSafeInteger(reading.request.expectedRevision) &&
      reading.request.expectedRevision === reading.snapshot.revision,
    (reading) => ({ ...reading, request: { ...reading.request, expectedRevision: reading.snapshot.revision + 1 } }),
  ),
  requirement(
    "deadlineMs",
    "a finite number at or after now and no more than the action's own ceiling beyond it",
    "invalid_deadline",
    (reading) => {
      const { deadlineMs, action } = reading.request;
      if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs) || deadlineMs < reading.nowMs) return false;
      // A co-op night waits on other players' native ready state, a host save and a new-day transition, so it shares
      // the navigation ceiling rather than the ordinary one-minute action ceiling.
      const ceiling = action === "navigate_to_destination" || action === "sleep" ? 600_000 : 60_000;
      return deadlineMs <= reading.nowMs + ceiling;
    },
    (reading) => ({ ...reading, request: { ...reading.request, deadlineMs: reading.nowMs - 1 } }),
  ),
  // REMOVED HERE, and deliberately not replaced: the `actionable` short-circuit that returned `player_not_actionable`
  // before the Mod could see the request. That line was a SECOND implementation of the Mod's admission rule, and it was
  // the harmful one. WIA §4.2 makes the Mod the single authority on whether the actor's body is free, and
  // `snapshot.actionable` is false in exactly the situation the modal family exists for (a mounted dialogue), so the
  // gateway refused `dismiss_modal` and `answer_dialogue` at the moment they were the only way out - the whole
  // interruption-and-resume loop was unreachable on the Host path. It also collapsed five different holds into one blind
  // code before the Mod could name them. The request now travels, and the Mod answers with a named hold
  // (WorldModel.HoldReasonCode) plus the facts its countermeasure needs.
  requirement(
    "action",
    "declared in the snapshot's live capabilities",
    "capability_not_declared",
    (reading) =>
      typeof reading.request.action === "string" && reading.snapshot.capabilities.includes(reading.request.action),
    (reading) => ({ ...reading, snapshot: { ...reading.snapshot, capabilities: [] } }),
  ),
]);

/** The world-object removal shape: the tile, the tool slot and the opaque object target, and nothing else. */
const REMOVES_PLACED_OBJECT: readonly ExecutionRequestRequirement[] = Object.freeze([
  exactArgs(["x", "y", "slot", "expectedTargetId"], "invalid_args"),
  tileRow("invalid_world_object_tile"),
  slotRow("invalid_world_object_slot"),
]);

/**
 * The argument rows per action id.
 *
 * This is the per-action half of the request as a DECLARATION rather than a ladder of `value.action === …` arms: each
 * action lists the fields its Mod-side wire parser pins and the code the Host returns for each, and `satisfies` holds the
 * table to `ExecutionRequest["action"]` in BOTH directions - an action without rows, or rows for an id the union does
 * not declare, is a compile error rather than a silent shortfall in a chain. The rows are read, not restated, by
 * `execution-request-declaration.test.ts`, which walks each one against a payload that breaks exactly it.
 *
 * Where a group of actions genuinely shares one decision the rows are one frozen list referenced by each of them
 * (`REMOVES_PLACED_OBJECT`); where two actions differ only in a code, the code is what the row says. Every refusal string
 * here is the one this validator has always returned, so a caller reading a receipt sees no change.
 */
export const EXECUTION_REQUEST_ARGUMENT_RULES = Object.freeze({
  move_to_tile: [exactArgs(["x", "y"], "invalid_args"), tileRow("invalid_target_tile")],
  navigate_to_destination: [
    exactArgs(["destination"], "invalid_args"),
    requirement(
      "args.destination",
      "the label-or-ref selector discovery published",
      "invalid_navigation_destination",
      (reading) => isExecutionNavigationDestinationSelector(reading.args.destination),
      withArg("destination", { kind: "label" }),
    ),
  ],
  equip_tool: [
    exactArgs(["tool"], "invalid_args"),
    requirement(
      "args.tool",
      "one of the tool categories the Mod publishes",
      "invalid_tool_selector",
      (reading) => isToolSelector(reading.args.tool),
      withArg("tool", "not_a_tool"),
    ),
  ],
  travel: [exactArgs(["x", "y"], "invalid_args"), warpSourceRow("invalid_warp_source")],
  shop_purchase: [
    exactArgs(["expectedTargetId", "expectedQualifiedItemId", "quantity"], "invalid_args"),
    targetRow("invalid_shop_target"),
    itemRow("invalid_expected_item"),
    // The Mod re-resolves the target and clamps the quantity against live stock and the purse on the game thread, so
    // nothing here models pricing or stock.
    integerRow("quantity", 1, null, "invalid_quantity"),
  ],
  // The station tile plus one exact published ride. Both x/y and the opaque selector are mandatory: unlike `travel`
  // there is no "plain" form, so a missing selector is a malformed request rather than an ordinary warp.
  ride_minecart: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_minecart_station"),
    // The Mod's own `hasMinecartRideArgs` refused a malformed selector by returning `invalid_args`, and this row keeps
    // that code: what is wrong is the argument's shape, not the station.
    requirement(
      "args.expectedTargetId",
      "a published `minecart_` ride selector",
      "invalid_args",
      (reading) =>
        typeof reading.args.expectedTargetId === "string" &&
        /^minecart_[a-f0-9]{16}$/u.test(reading.args.expectedTargetId),
      withArg("expectedTargetId", "minecart_not_a_selector"),
    ),
    requirement(
      "args.expectedTargetId, args.x, args.y",
      "one ride this exact snapshot advertised from that station tile",
      "invalid_minecart_station",
      (reading) =>
        Array.isArray(reading.snapshot.minecartTargets) &&
        reading.snapshot.minecartTargets.some(
          (target) =>
            target.targetId === reading.args.expectedTargetId &&
            target.stationX === reading.args.x &&
            target.stationY === reading.args.y,
        ),
      withArg("x", 12),
    ),
  ],
  // Only the opaque floor target: the floor SET is derived by the Mod from the live lowest level reached, so there is no
  // coordinate or raw level to check here beyond the shape and the opaque-id form.
  select_mine_elevator_floor: [
    exactArgs(["expectedTargetId"], "invalid_args"),
    opaqueArgRow("expectedTargetId", "invalid_mine_elevator_floor"),
  ],
  ride_bus: [exactArgs([], "invalid_args")],
  withdraw_silo_hay: [exactArgs(["x", "y", "expectedTargetId"], "invalid_execution_request")],
  // The native placement path needs the item to be the HELD one, so the slot and the identity are both mandatory. No
  // target: the tile is the placement.
  place_owned_object: [
    exactArgs(["x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_placement_tile"),
    slotRow("invalid_placement_slot"),
    itemRow("invalid_placement_item"),
  ],
  remove_placed_item: REMOVES_PLACED_OBJECT,
  // No slot: which backpack slot receives the piece is the game's own decision
  // (`GameLocation.removeQueuedFurniture`, GameLocation.cs:8084-8093), so a caller-supplied one would be a value nothing
  // reads. The id itself is re-derived by the Mod on the game thread and a stale one is refused there by name.
  move_placed_furniture: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_world_object_tile"),
  ],
  // No angle either: which rotation the turn lands on is the piece's own cycle (`Furniture.rotate`, Furniture.cs:1153-
  // 1162), so a caller-supplied angle would have to pretend to accept orientations the game does not have.
  rotate_furniture: [exactArgs(["x", "y", "expectedTargetId"], "invalid_args"), tileRow("invalid_world_object_tile")],
  remove_fence: REMOVES_PLACED_OBJECT,
  // The native method deposits whatever the actor is HOLDING (`who.ActiveObject`/`who.CurrentItem`,
  // FishTankFurniture.cs:235), so the slot is what selects the stack and the id is what proves the stack is still the one
  // the caller saw.
  put_item_in_fish_tank: [
    exactArgs(["x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_world_object_tile"),
    slotRow("invalid_world_object_slot"),
    itemRow("invalid_placement_item"),
  ],
  place_item_on_pedestal: [
    exactArgs(["x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_world_object_tile"),
    slotRow("invalid_world_object_slot"),
    itemRow("invalid_placement_item"),
  ],
  break_container: REMOVES_PLACED_OBJECT,
  use_obelisk: [exactArgs(["x", "y", "expectedTargetId"], "invalid_execution_request")],
  toggle_animal_door: [exactArgs(["x", "y", "expectedTargetId"], "invalid_execution_request")],
  clear_fish_pond: [exactArgs(["x", "y", "expectedTargetId"], "invalid_execution_request")],
  // The quest identity ALONE. `dailyQuestTargets` publishes no tile, and the Mod's own wire parser pins exactly
  // { expectedTargetId } (BridgeProtocol.ExecutionArgumentProperties, asserted by AcceptDailyQuestActionTests).
  // Demanding x/y here - as this row once did, sharing the sibling shape - refused every request the Mod would have
  // accepted, so the action was advertised and could never execute.
  accept_daily_quest: [exactArgs(["expectedTargetId"], "invalid_execution_request")],
  // The offer's identity alone: that projection publishes no tile either.
  accept_special_order: [exactArgs(["expectedTargetId"], "invalid_execution_request")],
  claim_museum_reward: [exactArgs(["expectedTargetId"], "invalid_execution_request")],
  // The Data/Buildings type id, the top-left footprint tile and the opaque site id. The Mod re-resolves the type against
  // Game1.buildingData and the site against the LIVE world.
  build_farm_building: [
    exactArgs(["buildingType", "x", "y", "expectedTargetId"], "invalid_execution_request"),
    boundedTextRow("buildingType", 128, "invalid_build_building_type"),
    tileRow("invalid_build_site"),
    opaqueArgRow("expectedTargetId", "invalid_build_target"),
  ],
  // No client-supplied target at all: the prize track head is the game's own `ticketPrizesClaimed` state and the subject
  // is the actor's own ticket stack, so the args must be exactly empty - the Mod's own wire parser pins the empty set. A
  // target id "for safety" would make every request invalid.
  redeem_prize_ticket: [exactArgs([], "invalid_args")],
  // The sewing-machine pair names the TWO backpack slots and the opaque pair identity discovery published; there is no
  // coordinate. The Mod's own wire parser pins exactly this shape.
  tailor_clothing: [
    exactArgs(["leftSlot", "rightSlot", "expectedTargetId"], "invalid_execution_request"),
    integerRow("leftSlot", 0, null, "invalid_execution_request"),
    integerRow("rightSlot", 0, null, "invalid_execution_request"),
  ],
  // The same two-slot shape over the dye route: the garment slot, the dye slot and the opaque pair identity.
  dye_clothing_with_item: [
    exactArgs(["leftSlot", "rightSlot", "expectedTargetId"], "invalid_execution_request"),
    integerRow("leftSlot", 0, null, "invalid_execution_request"),
    integerRow("rightSlot", 0, null, "invalid_execution_request"),
  ],
  // The geode travels to the blacksmith's counter as the CURSOR item, so the request names the one backpack slot it comes
  // from and the id it expects to find there. No coordinate: the counter is Clint's own dialogue case
  // (`Game1.activeClickableMenu = new GeodeMenu()`, GameLocation.cs:12345-12346), and no opaque target id: the slot's own
  // live item identifies it.
  open_geode: [
    exactArgs(["slot", "expectedQualifiedItemId"], "invalid_execution_request"),
    integerRow("slot", 0, null, "invalid_execution_request"),
    boundedItemRow("invalid_execution_request", 128),
  ],
  // The chest tile, the opaque target id, and the palette index the repaint asks for. The palette's own SIZE belongs to
  // the game (`DiscreteColorPicker.totalColors`), so the wire only refuses a negative index; the Mod names
  // `invalid_color_selection` for one past the palette.
  color_placed_object: [
    exactArgs(["x", "y", "expectedTargetId", "colorSelection"], "invalid_execution_request"),
    integerRow("colorSelection", 0, null, "invalid_color_selection"),
  ],
  // One string and nothing else, bounded by the SAME length the Mod enforces (its ChatMessageMaximumLength): an argument
  // the wire accepts but the handler refuses would be a registered capability that cannot be invoked.
  send_multiplayer_chat: [textOnlyRow(256)],
  // The name to write, bounded by the SAME length the Mod enforces (EntityNameMaximumLength).
  name_entity: [textOnlyRow(64)],
  // The slot that must hold the totem plus the totem's wire identity; both are re-read on the game thread.
  use_warp_item: [
    exactArgs(["slot", "expectedQualifiedItemId"], "invalid_execution_request"),
    integerRow("slot", 0, null, "invalid_warp_item_slot"),
    itemRow("invalid_expected_item"),
  ],
  // The pan slot plus the live ore-pan site the Mod re-resolves against `orePanPoint`.
  pan_ore: [
    exactArgs(["slot", "x", "y"], "invalid_execution_request"),
    integerRow("slot", 0, null, "invalid_pan_slot"),
    tileRow("invalid_pan_site"),
  ],
  // The mailbox tile plus the opaque id that binds the pending count AND the head letter.
  claim_mail_attachment: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_execution_request"),
    tileRow("invalid_mailbox_target"),
  ],
  // load_building_chest carries a required `slot` on top of the tile shape: the native Load branch reads
  // who.ActiveObject (the HELD item), not "some item in the pack", so the request must name the slot that is already the
  // held one.
  load_building_chest: [exactArgs(["x", "y", "slot", "expectedTargetId"], "invalid_execution_request")],
  collect_building_chest_output: [exactArgs(["x", "y", "expectedTargetId"], "invalid_execution_request")],
  use_raft: [
    exactArgs(["slot", "x", "y"], "invalid_args"),
    slotRow("invalid_raft_target"),
    tileRow("invalid_raft_target"),
    requirement(
      "args.x, args.y",
      "a raft site this exact snapshot published",
      "invalid_raft_target",
      (reading) =>
        Array.isArray(reading.snapshot.raftTargets) &&
        reading.snapshot.raftTargets.some((target) => target.x === reading.args.x && target.y === reading.args.y),
      withArg("y", 12),
    ),
  ],
  mount_transport: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_horse_target"),
    opaqueArgRow("expectedTargetId", "invalid_horse_target"),
    publishedTargetRow(
      "the horse this exact snapshot published at that tile",
      "invalid_horse_target",
      (snapshot) => snapshot.horseTargets,
    ),
  ],
  enter_mine: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_mine_entrance"),
    opaqueArgRow("expectedTargetId", "invalid_mine_entrance"),
    publishedTargetRow(
      "the mine entrance this exact snapshot published at that tile",
      "invalid_mine_entrance",
      (snapshot) => snapshot.mineEntranceTargets,
    ),
  ],
  // The mine level's own way OUT. The wire shape is `enter_mine`'s - the ladder tile plus the opaque id the
  // `mineEntranceTargets` row published - because both are rows of that one family and the Mod is the side that can tell
  // the kinds apart. The Host only proves the pair was published; which ladder it names is decided on the game thread,
  // where a row of the other kind is refused by name with the action that owns it.
  use_mine_ladder: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    tileRow("invalid_mine_exit_ladder"),
    opaqueArgRow("expectedTargetId", "invalid_mine_exit_ladder"),
    publishedTargetRow(
      "the ladder this exact snapshot published at that tile",
      "invalid_mine_exit_ladder",
      (snapshot) => snapshot.mineEntranceTargets,
    ),
  ],
  // The same WARP SOURCE range as `travel`: `enter_exit` resolves the door or warp from this tile, and an edge exit lives
  // at `-1` on the axis it is the boundary of. The in-map floor belongs to the walk targets, not to the tile a transition
  // leaves from.
  enter_exit: [exactArgs(["x", "y"], "invalid_args"), warpSourceRow("invalid_door_target")],
  // till_soil names the tile and the tool charge ONE native use covers. `charge` is required, not optional: the Mod's
  // own argument whitelist demands exact arity (an optional argument is not expressible there), and `0` is how a caller
  // asks for the single named tile. The ladder's ends are the engine's (`Tool.tilesAffected`'s last case is `power >= 6`);
  // a charge above the HELD tool's ceiling is refused by the Mod by name, never clamped.
  till_soil: [
    exactArgs(["x", "y", "charge"], "invalid_args"),
    tileRow("invalid_soil_target"),
    integerRow("charge", 0, 5, "invalid_args"),
  ],
  pickup_forage: [
    exactArgs(["x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...tileItemAndTarget("invalid_forage_target", boundedItemRow("invalid_forage_target", 128)),
  ],
  pickup_item: [
    exactArgs(["x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...tileItemAndTarget("invalid_item_target", boundedItemRow("invalid_item_target", 128)),
  ],
  water_crop: [
    exactArgs(["x", "y", "expectedTargetId", "charge"], "invalid_args"),
    ...tileAndTarget("invalid_crop_target"),
    integerRow("charge", 0, 5, "invalid_args"),
  ],
  refill_watering_can: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_refill_watering_can_target"),
  ],
  harvest_crop: [
    exactArgs(["x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...tileItemAndTarget("invalid_harvest_target", boundedItemRow("invalid_harvest_target", 128)),
  ],
  plant_seed: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_seed_target", boundedItemRow("invalid_seed_target", 128)),
  ],
  fertilize_tile: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_fertilizer_target", boundedItemRow("invalid_fertilizer_target", 128)),
  ],
  // The three placement actions name the item they place, and the pinned identity IS the check.
  place_wood_fence: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_wood_fence_target", pinnedItemRow("invalid_wood_fence_target", "(O)322")),
  ],
  place_crab_pot: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_crab_pot_target", pinnedItemRow("invalid_crab_pot_target", "(O)710")),
  ],
  bait_crab_pot: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_bait_crab_pot_target", pinnedItemRow("invalid_bait_crab_pot_target", "(O)685")),
  ],
  // The clump's own native switch decides which tool it needs, so the wire carries no `slot`: the handler resolves,
  // selects and restores the tool itself.
  clear_debris: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_debris_target"),
  ],
  break_resource_clump: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_clump_target"),
  ],
  // `requestedFish` is the species she wants, and `""` is how she asks for any: it is REQUIRED for the same reason
  // `till_soil`'s `charge` is (an optional argument is not expressible in this stack - the Mod's frame reader,
  // `BodyProgramVerifier.ArgumentsMatch` and the plan grammar all demand exact arity), and the empty string is the
  // spelling `ResourceToolCall` already uses for "named none". Nothing here compares it with a fish: which fish bites is
  // the engine's own decision at the bite, so the species is checked AFTER the catch and a different one is refused by
  // name (`fish_species_mismatch:<requested>:<caught>`) rather than reported as the fish she asked for.
  fish_here: [
    exactArgs(["x", "y", "expectedTargetId", "requestedFish"], "invalid_args"),
    ...tileAndTarget("invalid_fish_here_target"),
    optionalTextRow("requestedFish", 128, "invalid_args"),
  ],
  machine_inspect: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_machine_target"),
  ],
  machine_load: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_machine_load_target", qualifiedItemRow("invalid_machine_load_target")),
    requirement(
      "args.slot, args.expectedQualifiedItemId",
      "the load the machine's own published row offers",
      "machine_load_input_not_published",
      (reading) => validateMachineLoadAgainstPublishedRow(reading.args, reading.snapshot) === null,
      withArg("slot", 3),
    ),
  ],
  machine_collect_output: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_machine_collect_target"),
  ],
  npc_relationship: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_npc_relationship_target"),
  ],
  // The NPC family's shared shape: the opaque family target id names the villager and x/y is only the published tile the
  // walk leg heads for. The Mod re-resolves the person from the id on the game thread.
  talk_to_npc: [exactArgs(["x", "y", "expectedTargetId"], "invalid_args"), ...tileAndTarget("invalid_npc_talk_target")],
  // The wearable family's shape: an opaque body-slot target id, the backpack slot the item comes from, and that item's
  // wire identity. The Mod re-resolves the slot and its occupant on the game thread.
  equip_wearable: [
    exactArgs(["slot", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    slotRow("invalid_equip_wearable_target"),
    itemRow("invalid_equip_wearable_target"),
    targetRow("invalid_equip_wearable_target"),
  ],
  // No item id: the item is whatever the named body slot already holds, and `slot` is the EMPTY backpack slot the removed
  // wearable must land in.
  unequip_wearable: [
    exactArgs(["slot", "expectedTargetId"], "invalid_args"),
    slotRow("invalid_unequip_wearable_target"),
    targetRow("invalid_unequip_wearable_target"),
  ],
  // No arguments at all: the subject is the actor's own mount and its readiness is native state.
  dismount_transport: [exactArgs([], "invalid_args")],
  pet_animal: [exactArgs(["x", "y", "expectedTargetId"], "invalid_args"), ...tileAndTarget("invalid_pet_target")],
  // The farm-animal family's shape: the tile the animal was published at (only the approach leg's destination), and the
  // opaque `farmAnimalPetTargets` id. The Mod re-resolves the animal from its CURRENT location and measures reach against
  // its live tile, so a barn animal that wandered is refused by name rather than petted through a stale coordinate.
  pet_farm_animal: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_farm_animal_pet_target"),
  ],
  collect_animal_product: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_animal_product_target"),
  ],
  feed_animal: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_feed_trough_target"),
  ],
  use_item: [
    exactArgs(["slot", "expectedQualifiedItemId"], "invalid_args"),
    slotRow("invalid_item_use_target"),
    boundedItemRow("invalid_item_use_target", 128),
  ],
  chop_tree: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_chop_tree_target"),
  ],
  break_rock: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_break_rock_target"),
  ],
  clear_hoedirt: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_clear_hoedirt_target"),
  ],
  dig_artifact_spot: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_dig_artifact_spot_target"),
  ],
  express_emote: [exactArgs(["emote"], "invalid_args"), boundedTextRow("emote", 64, "invalid_emote")],
  face_direction: [exactArgs(["direction"], "invalid_args"), boundedTextRow("direction", 64, "invalid_direction")],
  // THE CONTAINER IS THE TARGET, so these take a container id and an item id - not a slot, a tile and a target id.
  //
  // This row once read the pre-`chests` shape (`slot`, `x`, `y`, `expectedTargetId`). Both the Mod's descriptors
  // (`ContainerItemTarget`, FarmhandActionDefinitions.cs:290-291) and the generated catalog had moved to
  // `[chestId, expectedQualifiedItemId]`, so **every** `chest_store`/`chest_retrieve` request was refused `invalid_args`
  // here before anyone looked at it: the model read the new shape from the catalog and the Host demanded the old one.
  chest_store: [
    exactArgs(["chestId", "expectedQualifiedItemId"], "invalid_args"),
    opaqueArgRow("chestId", "invalid_chest_target"),
    boundedItemRow("invalid_chest_target", 128),
  ],
  chest_retrieve: [
    exactArgs(["chestId", "expectedQualifiedItemId"], "invalid_args"),
    opaqueArgRow("chestId", "invalid_chest_target"),
    boundedItemRow("invalid_chest_target", 128),
  ],
  chop_stump: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_tool_target"),
  ],
  plant_sapling: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_sapling_target", itemRow("invalid_sapling_target")),
  ],
  cut_weeds: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_tool_target"),
  ],
  cut_grass: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_tool_target"),
  ],
  // sweep_scythe names the tile the actor must FACE and nothing else: no slot (the scythe comes from the action's own
  // `tool:scythe` claim, as till_soil's hoe does) and no target id (the arc covers a SET of occupants, so one occupant's
  // opaque id could not describe it). The Mod refuses a diagonal stance, an arc that misses the named tile, an arc that
  // would destroy a planted tuft or a crop the caller did not name, and an arc with nothing cuttable on it.
  sweep_scythe: [exactArgs(["x", "y"], "invalid_args"), tileRow("invalid_tool_target")],
  clear_cask: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_cask_target"),
  ],
  dress_mannequin: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_facility_target"),
  ],
  set_sign_display: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_facility_target"),
  ],
  deposit_silo_hay: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_facility_target"),
  ],
  toggle_tool_light: [
    exactArgs(["slot", "x", "y"], "invalid_args"),
    slotRow("invalid_lantern_slot"),
    tileRow("invalid_lantern_slot"),
  ],
  scythe_crop: [
    exactArgs(["slot", "x", "y", "expectedTargetId"], "invalid_args"),
    ...toolTileAndTarget("invalid_tool_target"),
  ],
  interact_npc_with_item: [
    exactArgs(["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...toolTileItemAndTarget("invalid_npc_item_interaction_target", itemRow("invalid_npc_item_interaction_target")),
  ],
  craft_item: [
    exactArgs(["expectedTargetId"], "invalid_args"),
    opaqueArgRow("expectedTargetId", "invalid_recipe_target"),
  ],
  cook_recipe: [
    exactArgs(["expectedTargetId"], "invalid_args"),
    opaqueArgRow("expectedTargetId", "invalid_recipe_target"),
  ],
  collect_crab_pot_output: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_crab_pot_target"),
  ],
  // No `slot`: a walk to a bin takes tens of ticks, and a magnet pickup or a stack merge on the way shifts every slot
  // behind the one that changed. The item id is the intent; the Mod resolves the first carried stack of it on arrival and
  // names the slot it actually shipped in the receipt.
  ship_item: [
    exactArgs(["x", "y", "expectedQualifiedItemId", "expectedTargetId"], "invalid_args"),
    ...tileItemAndTarget("invalid_ship_target", itemRow("invalid_ship_target")),
  ],
  water_pet_bowl: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_pet_bowl_target"),
  ],
  dismiss_modal: [exactArgs([], "invalid_args")],
  answer_dialogue: [
    exactArgs(["responseKey"], "invalid_args"),
    boundedTextRow("responseKey", 128, "invalid_response_key"),
  ],
  // The pair is the binding, so the Host refuses an unshaped request before it can reach the Mod: a persistent save
  // write must not be dispatchable without naming the level-up it is for.
  //
  // The three values are the Mod's OWN published vocabulary (`FarmhandActionCatalog.LevelUpChoiceEnum`, projected onto the
  // descriptor and onto the generated action surface) and the Mod's registry acceptance refuses anything outside it on the
  // game thread. They are spelled here so the refusal is specific and pre-bridge; `game-tools-argument-contract.test.ts`
  // holds this list and the published one equal, so a value the Mod's contract declares legal can never be refused here.
  respond_level_up: [
    exactArgs(["choice", "expectedSkill", "expectedLevel"], "invalid_args"),
    requirement(
      "args.choice",
      "one of the published level-up choices",
      "invalid_level_up_choice",
      (reading) =>
        typeof reading.args.choice === "string" && ["confirm", "branch_a", "branch_b"].includes(reading.args.choice),
      withArg("choice", "branch_c"),
    ),
    integerRow("expectedSkill", 0, 5, "invalid_level_up_choice"),
    integerRow("expectedLevel", 1, 10, "invalid_level_up_choice"),
  ],
  water_slime_hutch_trough: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_slime_hutch_trough_target"),
  ],
  harvest_bush: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_harvest_bush_target"),
  ],
  harvest_fruit_tree: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_harvest_fruit_tree_target"),
  ],
  shake_tree: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_shake_tree_target"),
  ],
  take_pedestal_item: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_take_pedestal_item_target"),
  ],
  toggle_fence_gate: [
    exactArgs(["x", "y", "expectedTargetId"], "invalid_args"),
    ...tileAndTarget("invalid_toggle_fence_gate_target"),
  ],
  // The cross-day lifecycle: no client-supplied target, because the bed and the ready state are native facts.
  sleep: [exactArgs([], "invalid_args")],
} satisfies Record<ExecutionRequest["action"], readonly ExecutionRequestRequirement[]>);

/** The action ids this declaration carries rows for: the key set the compiler holds equal to `ExecutionRequest["action"]`. */
const EXECUTION_ACTIONS: ReadonlySet<string> = new Set(Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES));

function isExecutionAction(value: unknown): value is ExecutionRequest["action"] {
  return typeof value === "string" && EXECUTION_ACTIONS.has(value);
}

/**
 * The argument rows for one action id, or none for an id no row declares.
 *
 * The `unknown_action` envelope row runs before this lookup and admits only an id the table carries, so the empty list is
 * unreachable on the decision path; it is what a caller would get if that row ever stopped running.
 */
function argumentRulesFor(action: unknown): readonly ExecutionRequestRequirement[] {
  return isExecutionAction(action) ? EXECUTION_REQUEST_ARGUMENT_RULES[action] : [];
}

/**
 * The whole-number ranges one action's arguments pin, in declaration order.
 *
 * The readers that state an argument a second time - the tool schema the model is handed (`game-tools.ts`) and the plan
 * example it copies (`body-program-script.ts`) - read the range from here instead of writing it again, so a bound that
 * moves in the validator moves on both surfaces. A row that pins no range contributes nothing, and an action whose range
 * is removed shows up as a missing bound in those readers rather than as a stale schema.
 */
export function executionRequestIntegerBounds(
  action: ExecutionRequest["action"],
): readonly ExecutionRequestIntegerBound[] {
  return EXECUTION_REQUEST_ARGUMENT_RULES[action].flatMap((row) =>
    row.integerBound === undefined ? [] : [row.integerBound],
  );
}

/**
 * The first row of a list that refuses the reading, or null when every row is met.
 *
 * A bounded fold over a declaration, exported because it IS the decision: `execution-request-declaration.test.ts` runs it
 * over the full list and over the same list with one row removed, so the table and the behaviour cannot drift apart.
 */
export function firstExecutionRequestRefusal(
  rows: readonly ExecutionRequestRequirement[],
  reading: ExecutionRequestReading,
): string | null {
  for (const row of rows) if (!row.isMet(reading)) return row.refusal;
  return null;
}

/**
 * Whether a dispatch may leave the Host at all, and if not, the one code that says why.
 *
 * A lookup and a bounded fold: the envelope rows decide the payload and the action's own argument rows decide `args`, and
 * neither the order nor a code lives in this function. It was a ladder of `value.action === …` arms 255 cognitive points
 * long; the ladder is now `EXECUTION_REQUEST_REQUIREMENTS` and `EXECUTION_REQUEST_ARGUMENT_RULES` above, and the answer
 * to "which field did it refuse" is a row's `field` rather than a branch a reader has to count.
 */
export function validateExecutionRequest(value: unknown, snapshot: Snapshot, nowMs = Date.now()): string | null {
  if (!isRecord(value)) return "invalid_request";
  const reading = executionRequestReading(value, snapshot, nowMs);
  const envelopeVerdict = firstExecutionRequestRefusal(EXECUTION_REQUEST_REQUIREMENTS, reading);
  if (envelopeVerdict !== null) return envelopeVerdict;
  return firstExecutionRequestRefusal(argumentRulesFor(reading.request.action), reading);
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

/**
 * The closed vocabulary of reasons a discovery family may publish for withholding a subject it could SEE.
 *
 * A reason is admitted ONLY when the engine itself refuses the same action on the same subject today, and each entry
 * carries the engine member that refuses it. That rule is what keeps this list from becoming a place to file
 * inconvenient filters: a filter the engine does not share is a BUG in discovery, and it belongs on
 * `tools/stardew-discovery-exclusions-backlog.json` as "not vanilla", not here as a reason.
 *
 * The Mod publishes the same set (`DiscoveryExclusionReasons` in
 * `integrations/stardew/src/Core/Policy/DiscoveryExclusionReasons.cs`). The comparison is
 * `tools/check-stardew-discovery-exclusions.mjs`, which reads both declarations by name so a token added on one side
 */
export const DISCOVERY_EXCLUSION_REASONS = Object.freeze([
  // `Tree.tapped`: the engine's own chop refuses it - `if (tapped.Value) { return false; }` in `Tree.performToolAction`
  // (Tree.cs:1116-1119).
  "already_tapped",
  // `Tree.stump`: the FELLED phase (`stump.Value = true`, Tree.cs:1495); the remaining wood is `chop_stump`'s subject.
  "stump",
  // `Tree.growthStage < Tree.treeStage`: the chop branch needs `growthStage.Value >= 5` (Tree.cs:1085) and an axe on a
  // growing tree returns false (Tree.cs:1157-1160).
  "not_grown",
  // `Tree.health <= 0` / `Crop.dead`: the engine's own felled/spent terminal (`Tree.performToolAction` returns false at
  // `health.Value <= -99f`, Tree.cs:1081).
  "dead",
  // `Pet.lastPetDay` / `FarmAnimal.wasPet`: today's friendship is already granted (Pet.cs:641-643, FarmAnimal.cs:745-749).
  "petted_today",
  // `HoeDirt.isWatered()` (`state.Value == 1`, HoeDirt.cs:391-394), `PetBowl.watered`, `SlimeHutch.waterSpots[]`.
  "already_watered",
  // `HoeDirt.readyForHarvest()` false (HoeDirt.cs:465); `Building.daysOfConstructionLeft` above zero.
  "not_ready",
  // `Crop.GetHarvestMethod() != HarvestMethod.Grab` (HoeDirt.cs:483): a scythe crop is taken by a tool swing.
  "wrong_harvest_method",
  // `CrabPot.NeedsBait` false because `bait.Value != null` (CrabPot.cs:64-71), and the drop-in is gated on it (:239).
  "already_baited",
  // The shop's resolved owner entry carries `ClosedMessage`: `Utility.TryOpenShopMenu` draws it and opens nothing
  // (Utility.cs:4305-4317), over the entries `ShopBuilder.GetCurrentOwners` left after their condition matched.
  "shop_closed_today",
  // The subject needs a TOOL the actor does not hold at the tier the action needs: `ResourceClump.performToolAction`
  // dispatches on `parentSheetIndex` and returns false unless the activating tool is the matching family at or above
  // that clump's upgrade level (ResourceClump.cs:150-234). The boulder stays in the world; a snapshot that omits it says
  // the farm is clear.
  "tool_insufficient",
] as const);

/**
 * One exclusion row: the family it explains, the reason, and how many subjects the filter took.
 *
 * The family must be a WIRE FIELD NAME this snapshot can carry, so a row cannot name a list nobody publishes; the
 * reason must be in the closed vocabulary; the count is at least one, because a zero-count exclusion is not an
 * exclusion.
 */
function isDiscoveryExclusionFact(entry: unknown): boolean {
  if (!isRecord(entry) || !hasExactKeys(entry, ["family", "reason", "count"])) return false;
  if (typeof entry.family !== "string" || !(SNAPSHOT_KEYS as readonly string[]).includes(entry.family)) return false;
  if (typeof entry.reason !== "string" || !(DISCOVERY_EXCLUSION_REASONS as readonly string[]).includes(entry.reason))
    return false;
  return isNonNegativeSafeInteger(entry.count) && entry.count >= 1;
}

export const SNAPSHOT_FAMILY_RULES: readonly SnapshotFamilyRule[] = Object.freeze([
  { field: "worldObjectTargets", maxItems: 48, accepts: isWorldObjectTargetFact },
  { field: "farmBuildingTargets", maxItems: 16, accepts: isFarmBuildingTargetFact },
  { field: "dailyQuestTargets", maxItems: 16, accepts: isDailyQuestTargetFact },
  { field: "specialOrderTargets", maxItems: 16, accepts: isSpecialOrderTargetFact },
  { field: "activeSpecialOrderKeys", maxItems: 16, accepts: (entry) => typeof entry === "string" && entry.length > 0 },
  // The engine's pending level-ups, as `skill@level`. Bounded at 8 (the engine's own list is a handful) and checked
  // against the vocabulary the receipts already publish, so a malformed entry is a named snapshot refusal rather than a
  // fact the companion reads.
  { field: "pendingLevelUps", maxItems: 8, accepts: (entry) => typeof entry === "string" && /^\d+@\d+$/u.test(entry) },
  // The pending profession milestones, each with both candidates and the level-5 constraint a level-10 pair depends
  // on. Bounded at 8 like the pending pair it is derived from, and validated entry-by-entry so a malformed candidate
  // is a NAMED snapshot refusal rather than a choice the companion reads.
  { field: "pendingLevelUpChoices", maxItems: 8, accepts: isLevelUpChoiceFact, narrate: namedEntryReason },
  // The actor's own profession ids, the set a milestone branch writes and a fresh read confirms.
  { field: "professions", maxItems: 16, accepts: (entry) => isNonNegativeSafeInteger(entry) },
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
  // The map's own fixed interaction points. `isWarp` is the wrong shape here on purpose: a ladder tile names
  // no destination, so this family carries a closed `kind` instead of a target location.
  { field: "fixedInteractionPoints", maxItems: 64, accepts: isFixedInteractionPointFact },
  { field: "soilTiles", maxItems: 64, accepts: isSoilTile },
  { field: "toolSlots", maxItems: 36, accepts: isToolSlotFact },
  { field: "forageTargets", maxItems: 64, accepts: isForageTargetFact },
  { field: "itemTargets", maxItems: 64, accepts: isItemTargetFact },
  { field: "wateringCanFacts", maxItems: 36, accepts: isWateringCanFact },
  { field: "refillWateringCanTargets", maxItems: 8, accepts: isRefillWateringCanTargetFact },
  // The water `fish_here` may cast at. Bounded at the Mod's own cap (32) and validated entry by entry, so a malformed
  // row is a NAMED snapshot refusal rather than a tile the companion aims at.
  { field: "waterTargets", maxItems: 32, accepts: isWaterTargetFact },
  { field: "cropTargets", maxItems: 64, accepts: isCropTargetFact, narrate: namedEntryReason },
  { field: "petBowlTargets", maxItems: 8, accepts: isPetBowlTargetFact },
  { field: "slimeHutchTroughTargets", maxItems: 4, accepts: isSlimeHutchTroughTargetFact },
  { field: "harvestTargets", maxItems: 64, accepts: isHarvestTargetFact },
  { field: "bushTargets", maxItems: 32, accepts: isBushTargetFact },
  { field: "fruitTreeTargets", maxItems: 16, accepts: isBushTargetFact },
  { field: "shakeTreeTargets", maxItems: 16, accepts: isBushTargetFact },
  { field: "pedestalTargets", maxItems: 16, accepts: isPedestalTargetFact },
  { field: "fenceGateTargets", maxItems: 16, accepts: isFenceGateTargetFact },
  { field: "seedTargets", maxItems: 64, accepts: isSeedTargetFact },
  { field: "fertilizerTargets", maxItems: 64, accepts: isFertilizerTargetFact },
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
  { field: "wateringWhereabouts", maxItems: 64, accepts: isWateringWhereaboutsFact },
  { field: "petTargets", maxItems: 16, accepts: isPetTargetFact },
  { field: "farmAnimalPetTargets", maxItems: 16, accepts: isFarmAnimalPetTargetFact },
  { field: "animalProductTargets", maxItems: 32, accepts: isAnimalProductTargetFact },
  { field: "feedTroughTargets", maxItems: 32, accepts: isFeedTroughTargetFact },
  // One container row carries its own contents, so this cap bounds CONTAINERS, not items: `items` is the complete
  // mirror and is never shortened. 64 is the per-family ceiling the snapshot schema already declares for the container
  // families this replaces, and the same ceiling the Mod's `TargetRowBudget.FamilyRowLimit` names.
  { field: "chests", maxItems: 64, accepts: isChestStateFact },
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
  { field: "seedSupplyTargets", maxItems: 8, accepts: isSeedSupplyTargetFact, narrate: namedEntryReason },
  { field: "horseTargets", maxItems: 16, accepts: isHorseTargetFact },
  { field: "mineEntranceTargets", maxItems: 16, accepts: isMineEntranceTargetFact },
  { field: "animalDoorTargets", maxItems: 32, accepts: isAnimalDoorTargetFact },
  { field: "obeliskTargets", maxItems: 32, accepts: isObeliskTargetFact },
  { field: "buildingChestTargets", maxItems: 16, accepts: isBuildingChestTargetFact },
  // What discovery WITHHELD, and why: the sibling of the truncation counts. One array for every family, because one
  // additive field with a closed vocabulary is one validator; `family` carries the wire field name of the list the row
  // explains, so the row is still attributable. `narrate` names the offending entry, because a reason outside the
  // vocabulary is exactly what a field-only message hides.
  { field: "discoveryExclusions", maxItems: 16, accepts: isDiscoveryExclusionFact, narrate: namedEntryReason },
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
  // WHICH FIELD is what the reader needs. A null is the failure this family actually had (measured 2026-11-09: a
  // nullable C# member serialised as `"daysToHarvest": null` and the whole snapshot was refused), and naming only the
  // entry's key set left the reader to diff two lists. The null keys are printed by name.
  const nullKeys = isRecord(entry)
    ? Object.keys(entry).filter((key) => (entry as Record<string, unknown>)[key] === null)
    : [];
  return `invalid_snapshot:${rule.field}:entry${index}:keys=${
    isRecord(entry) ? Object.keys(entry).join("|") : typeof entry
  }${nullKeys.length > 0 ? `:nulls=${nullKeys.join("|")}` : ""}`;
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
  if (
    value.currentToolSlot !== undefined &&
    value.currentToolSlot !== null &&
    !isNonNegativeSafeInteger(value.currentToolSlot)
  )
    return "invalid_snapshot:currentToolSlot";
  if (
    value.currentToolSlotItem !== undefined &&
    value.currentToolSlotItem !== null &&
    typeof value.currentToolSlotItem !== "string"
  )
    return "invalid_snapshot:currentToolSlotItem";
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
  // The count of fixed interaction points the Mod's cap left out. Beside the family it counts, the same way
  // `artifactSpotFarmSourceCount` sits beside its own: one number, checked as a non-negative integer.
  if (
    value.fixedInteractionPointsOmitted !== undefined &&
    value.fixedInteractionPointsOmitted !== null &&
    !isNonNegativeSafeInteger(value.fixedInteractionPointsOmitted)
  )
    return "invalid_snapshot:fixedInteractionPointsOmitted";
  // The same count for the soil family: a bounded slice of the actor's own neighbourhood, and without it a
  // patch larger than the bound is indistinguishable from a complete one.
  if (
    value.soilTilesOmitted !== undefined &&
    value.soilTilesOmitted !== null &&
    !isNonNegativeSafeInteger(value.soilTilesOmitted)
  )
    return "invalid_snapshot:soilTilesOmitted";
  // The same count for the building family, whose cap is eight `built` rows.
  if (
    value.farmBuildingTargetsOmitted !== undefined &&
    value.farmBuildingTargetsOmitted !== null &&
    !isNonNegativeSafeInteger(value.farmBuildingTargetsOmitted)
  )
    return "invalid_snapshot:farmBuildingTargetsOmitted";
  // The same count for the exclusion register: it says how many distinct (family, reason) rows the Mod's cap left
  // out, and without it a bounded register reads as a complete one.
  if (
    value.discoveryExclusionsOmitted !== undefined &&
    value.discoveryExclusionsOmitted !== null &&
    !isNonNegativeSafeInteger(value.discoveryExclusionsOmitted)
  )
    return "invalid_snapshot:discoveryExclusionsOmitted";
  // The same count for the seed supply family, whose cap is the eight rows its rule declares: the harness reads the
  // shortage as `task patch tiles` minus the rows it holds, so a row the cap withheld and no count beside it is a supply
  // that reads as complete - and a count that is not a non-negative integer is a number nobody can subtract.
  if (
    value.seedSupplyTargetsOmitted !== undefined &&
    value.seedSupplyTargetsOmitted !== null &&
    !isNonNegativeSafeInteger(value.seedSupplyTargetsOmitted)
  )
    return "invalid_snapshot:seedSupplyTargetsOmitted";
  // A scalar record, not a family, so it is checked here rather than by `SNAPSHOT_FAMILY_RULES`. Absent means the Mod did
  // not measure it (the container actions were not advertised); a present one must be the whole shape.
  if (value.chestsSummary !== undefined && !isChestsSummaryFact(value.chestsSummary))
    return "invalid_snapshot:chestsSummary";
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
 * (the `tile` key set is only demanded here, `weather` may not be null here, and `actorDispositionKind` is
 * only type-checked here while the diagnostic enforces the closed set), so merging the two would change
 * which snapshots the bridge admits. What they may NOT do is differ by OMISSION: a member this function
 * forgets is a member `validateSnapshot` admits with any value, and a check that exists only in the
 * diagnostic refuses nothing - it runs after the frame was already admitted. `declaration-agreement.test.ts`
 * holds every scalar the Mod publishes to being named here, so a member added to one path and not the other
 * fails by name.
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
    // The disposition's detail and ownership answer, both of which the diagnostic already names: a modal
    // class read as a number and an ownership flag read as a string are the same defect `actorDispositionKind`
    // was moved here for (see the comment in `diagnoseSnapshot`).
    (value.actorDispositionDetail === undefined ||
      value.actorDispositionDetail === null ||
      typeof value.actorDispositionDetail === "string") &&
    (value.actorDispositionActionOwned === undefined || typeof value.actorDispositionActionOwned === "boolean") &&
    isFiniteNumber(value.health) &&
    typeof value.actionable === "boolean" &&
    (value.currentTool === undefined || value.currentTool === null || typeof value.currentTool === "string") &&
    // The tool slot and the item occupying it, the pair `currentTool` is answered with: a slot is a non-negative
    // integer and the occupant is a qualified id or absent. Both were named only by the diagnostic.
    (value.currentToolSlot === undefined ||
      value.currentToolSlot === null ||
      isNonNegativeSafeInteger(value.currentToolSlot)) &&
    (value.currentToolSlotItem === undefined ||
      value.currentToolSlotItem === null ||
      typeof value.currentToolSlotItem === "string") &&
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
    (value.fixedInteractionPointsOmitted === undefined ||
      value.fixedInteractionPointsOmitted === null ||
      isNonNegativeSafeInteger(value.fixedInteractionPointsOmitted)) &&
    (value.soilTilesOmitted === undefined ||
      value.soilTilesOmitted === null ||
      isNonNegativeSafeInteger(value.soilTilesOmitted)) &&
    (value.farmBuildingTargetsOmitted === undefined ||
      value.farmBuildingTargetsOmitted === null ||
      isNonNegativeSafeInteger(value.farmBuildingTargetsOmitted)) &&
    (value.seedSupplyTargetsOmitted === undefined ||
      value.seedSupplyTargetsOmitted === null ||
      isNonNegativeSafeInteger(value.seedSupplyTargetsOmitted)) &&
    (value.discoveryExclusionsOmitted === undefined ||
      value.discoveryExclusionsOmitted === null ||
      isNonNegativeSafeInteger(value.discoveryExclusionsOmitted)) &&
    (value.chestsSummary === undefined || isChestsSummaryFact(value.chestsSummary)) &&
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

/**
 * The structural half of an execution request: what the frame says about itself, decided without a snapshot.
 *
 * Every payload is held to the SAME requirement set whatever its `action` says, and each refusal is the code
 * `EXECUTION_REQUEST_REQUIREMENTS` gives that field - `invalid_request` for the key set, `invalid_request_id` for the two
 * ids, `unknown_action` for the vocabulary, `invalid_args` for `args`, `stale_snapshot` for `expectedRevision` and
 * `invalid_deadline` for `deadlineMs` - so a frame refused here is refused for the reason the declaration would give.
 * What depends on the action is an ARGUMENT rule, and `EXECUTION_REQUEST_ARGUMENT_RULES` is where those live and where
 * they are decided against a snapshot; the vocabulary is that same declaration's key set, read through
 * `isExecutionAction`, so nothing carries a second list of action ids.
 *
 * The rows are decided in the declaration's order. The last two ask only the shape half of their row, because the row on
 * the send path compares `expectedRevision` with the live snapshot and `deadlineMs` with a clock, and the transport
 * boundary has neither.
 *
 * Measured on the expression this replaced (1 + 27 + 74 = 102 actions): `clear_fish_pond` alone had the key set and the
 * two ids; 27 actions were admitted by `value.action === "<id>"` alone, with no field read at all; 74 had `args`,
 * `expectedRevision` and `deadlineMs` but no identity. `&&` binds tighter than `||`, so the grouping read as one
 * conjunction and was three disjuncts - a frame carrying `{ action: "build_farm_building" }` and nothing else was
 * admitted. `protocol.test.ts` walks the declaration's whole population and refuses each action once per required field.
 */
function validateExecutionRequestEnvelope(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["requestId", "idempotencyKey", "action", "args", "expectedRevision", "deadlineMs"]))
    return "invalid_request";
  if (!isOpaqueId(value.requestId) || !isOpaqueId(value.idempotencyKey)) return "invalid_request_id";
  if (!isExecutionAction(value.action)) return "unknown_action";
  if (!isRecord(value.args) || Object.keys(value.args).length > EXECUTION_REQUEST_ARGUMENT_CEILING)
    return "invalid_args";
  if (!Number.isSafeInteger(value.expectedRevision)) return "stale_snapshot";
  if (typeof value.deadlineMs !== "number" || !Number.isFinite(value.deadlineMs)) return "invalid_deadline";
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
    // `orderedAfter` is the SECOND, ordering-only edge: "do not start before these predecessors are terminal, do not skip me
    // if one fails". It is optional because absent is exactly what a node said before the edge existed - nothing is
    // reinterpreted - and it is named here so a frame carrying it is not refused as an unknown key.
    !hasExactKeysOrOptional(value, ["nodeId", "actionId", "arguments", "dependsOn", "bindings"], ["orderedAfter"]) ||
    !isOpaqueId(value.nodeId) ||
    !isOpaqueId(value.actionId) ||
    !isRecord(value.arguments) ||
    !hasUniqueKeys(value.arguments) ||
    !Array.isArray(value.dependsOn) ||
    value.dependsOn.length > 8 ||
    !value.dependsOn.every(isOpaqueId) ||
    !isOrderingPredecessors(value.orderedAfter) ||
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

/** An absent `orderedAfter` is an empty edge; a present one is bounded exactly like `dependsOn`. */
function isOrderingPredecessors(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 8 && value.every(isOpaqueId);
}
function isBodyProgramRuntimeValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "destination_selector")
    return hasExactKeys(value, ["type", "destination"]) && isBodyProgramDestinationSelector(value.destination);
  // THE LOOP FORM IS A DECLARATIVE ARGUMENT, DISCRIMINATED BY `type` LIKE EVERY OTHER ONE, so it can never be mistaken for
  // a `{ type: "string", canonicalValue }` holding the same JSON. Its grammar is read from the one module the plan
  // compiler writes it with (`body-program-for-each.ts`), so the producer and the validator cannot drift apart.
  //
  // WHAT THIS ACCEPTANCE DOES NOT SAY. The Mod's own reader does not know this kind, and that is deliberate: a form the
  // Mod cannot expand must not look executable at the wire boundary. `plan_work` answers
  // `for_each_execution_unavailable` for exactly the nodes whose action id the attached Mod does not publish, so no
  // program carrying a loop is ever sent. This validator describes what the Host can COMPILE and READ BACK.
  if (value.type === "loop") return isForEachLoopDocument(value);
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
const BODY_PROGRAM_STOP_CODES = new Set([
  "succeeded",
  "not_found",
  "invalid_input",
  "program_not_active",
  "node_not_eligible",
  "policy_identity_stale",
  "grant_mismatch",
  "execution_binding_mismatch",
  "fact_provenance_mismatch",
  "invalid_fact",
  "terminal_proof_missing",
  "recovery_required",
  "persistence_write_failed",
  "deadline_expired",
]);

/**
 * A stop answers in the CONTROLLER vocabulary, so its validator cannot reuse the query result's three codes.
 *
 * The snapshot is accepted on success only: a refused stop has no state to report, and a payload that carried one would be
 * claiming the program changed when the refusal says it did not.
 */
function validateBodyProgramStopResult(payload: Record<string, unknown>): string | null {
  if (!hasExactKeys(payload, ["code", "snapshot"])) return "invalid_body_program_stop_result";
  if (typeof payload.code !== "string" || !BODY_PROGRAM_STOP_CODES.has(payload.code))
    return "invalid_body_program_stop_result";
  if (payload.snapshot === null) return payload.code === "succeeded" ? "invalid_body_program_stop_result" : null;
  const snapshotError = isBodyProgramStatusSnapshot(payload.snapshot) ? null : "invalid_body_program_stop_result";
  if (snapshotError !== null) return snapshotError;
  return payload.code === "succeeded" ? null : "invalid_body_program_stop_result";
}

export const MAX_BODY_PROGRAM_RECENT_PROGRAMS = 8;
export function validateBodyProgramStatusResult(value: Record<string, unknown>): string | null {
  if (
    !hasExactKeys(value, ["code", "snapshot", "programs", "programCount"]) ||
    !isBodyProgramQueryCode(value.code) ||
    !isNonNegativeSafeInteger(value.programCount)
  )
    return "invalid_body_program_result";
  if (value.snapshot !== null && !isBodyProgramStatusSnapshot(value.snapshot)) return "invalid_body_program_result";
  if (value.programs !== null) {
    if (
      !Array.isArray(value.programs) ||
      value.programs.length > MAX_BODY_PROGRAM_RECENT_PROGRAMS ||
      !value.programs.every(isBodyProgramStatusSnapshot) ||
      // A page cannot be longer than the journal it came from. The two numbers are printed side by side, so a page that
      // outgrew its own total would be a contradiction the reader cannot resolve.
      value.programs.length > (value.programCount as number)
    )
      return "invalid_body_program_result";
  }
  if (value.code !== "found")
    return value.snapshot === null && value.programs === null ? null : "invalid_body_program_result";
  // A `found` answer is exactly one of the two paths. "The program does not exist" is `not_found`; "the journal has
  // nothing to list" is `found` with an EMPTY page. Collapsing those into one empty list would lose one of them.
  return (value.snapshot === null) !== (value.programs === null) ? null : "invalid_body_program_result";
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
    hasExactKeys(value, ["cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt", "atMs"]) &&
    isNonNegativeSafeInteger(value.cursor) &&
    isOpaqueId(value.programId) &&
    isReasonCode(value.kind) &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    (value.nodeId === null || isOpaqueId(value.nodeId)) &&
    (value.nodeAttempt === null || isNonNegativeInt32(value.nodeAttempt)) &&
    isNonNegativeSafeInteger(value.atMs)
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
    // The exact set is asserted as before, plus the keys the Mod may add. `actionId` is in the REQUIRED half: every node
    // the Mod publishes names its action, and a frame that dropped it would be exactly the defect this projection exists
    // to end. `x`/`y` stay optional because a node that names no tile has none - a null, not an absence.
    hasExactKeysOrOptional(
      value,
      ["nodeId", "state", "nodeAttempt", "admissionAttempt", "actionId"],
      ["rejectionCode", "failureCode", "hint", "refusalDetail", "recoveryDiagnostic", "x", "y"],
    ) &&
    isOpaqueId(value.nodeId) &&
    isOpaqueId(value.actionId) &&
    isCoordinateOrAbsent(value.x) &&
    isCoordinateOrAbsent(value.y) &&
    // One half of a coordinate is not a coordinate: the two travel together or not at all.
    isAbsentCoordinate(value.x) === isAbsentCoordinate(value.y) &&
    (value.rejectionCode === undefined || value.rejectionCode === null || isReasonCode(value.rejectionCode)) &&
    (value.failureCode === undefined || value.failureCode === null || isReasonCode(value.failureCode)) &&
    // A hint is not a reason code - `closest=49,14;closest_distance=1` is outside that grammar - so it carries its own
    // bound. It is the same 256 the Mod's journal enforces, so a frame the wire accepts cannot be one the journal refuses.
    (value.hint === undefined || value.hint === null || (typeof value.hint === "string" && value.hint.length <= 256)) &&
    // The two reasons whose legality depends on the STATE they ride. The bound is the Mod's own declaration
    // (`BodyProgramValidation.MaximumNodeRefusalDetailLength`, `MaximumRecoveryDiagnosticLength`), and the state rule is
    // the same one the journal enforces: a node that proved an effect can never also describe its absence, and an
    // undetermined outcome is the only state whose reason is a diagnostic.
    isOptionalBoundedReason(value.refusalDetail, MAX_BODY_PROGRAM_REFUSAL_DETAIL_LENGTH) &&
    (value.refusalDetail === undefined ||
      value.refusalDetail === null ||
      BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES.has(value.state as BodyProgramNodeState)) &&
    isOptionalBoundedReason(value.recoveryDiagnostic, MAX_BODY_PROGRAM_RECOVERY_DIAGNOSTIC_LENGTH) &&
    (value.recoveryDiagnostic === undefined ||
      value.recoveryDiagnostic === null ||
      value.state === "recovery_required") &&
    isBodyProgramNodeState(value.state) &&
    isNonNegativeInt32(value.nodeAttempt) &&
    isNonNegativeInt32(value.admissionAttempt)
  );
}
function isAbsentCoordinate(value: unknown): boolean {
  return value === undefined || value === null;
}
function isCoordinateOrAbsent(value: unknown): boolean {
  return isAbsentCoordinate(value) || isNonNegativeInt32(value);
}
/** An optional bounded, control-character-free string: the shape both MOD state reasons use. */
function isOptionalBoundedReason(value: unknown, maximum: number): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !/\p{Cc}/u.test(value);
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
  return typeof value === "string" && (BODY_PROGRAM_NODE_STATES as readonly string[]).includes(value);
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
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["x", "y", "hoeDirt"]) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    // Optional at the wire: a Mod older than this field publishes no answer, and one that carries it publishes
    // `GameLocation.GetHoeDirtAtTile`, so a non-boolean is a malformed row rather than a missing measurement.
    (value.hoeDirt === undefined || typeof value.hoeDirt === "boolean")
  );
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
    isWarpSourceCoordinate(value.sourceX) &&
    isWarpSourceCoordinate(value.sourceY) &&
    typeof value.targetLocation === "string" &&
    value.targetLocation.length > 0 &&
    value.targetLocation.length <= 256 &&
    isTileCoordinate(value.targetX) &&
    isTileCoordinate(value.targetY) &&
    (value.accessible === undefined || value.accessible === null || typeof value.accessible === "boolean")
  );
}

function isWarpSourceCoordinate(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= -1 && value <= 1000;
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
/**
 * A machine load must be the load the machine's own data offered: when the dispatched snapshot publishes that machine,
 * `slot` and `expectedQualifiedItemId` must be the pair on its row (`loadInputSlot`/`loadInputQualifiedItemId`), and the
 * row must name a positive `loadInputStack`. The Mod re-derives all three from the live machine on the game thread, so a
 * request that CONTRADICTS the row it copied is refused before the write instead of being reconciled onto whatever now
 * stands there.
 *
 * A machine the snapshot no longer lists is NOT refused here. It is either busy now or gone, and both are refusals the
 * Mod already names from the live world - including the one that matters: a request re-sent with the identity of a load
 * that already happened must reach the Mod, which replays that request's own receipt instead of letting the Host turn a
 * stale snapshot into a failure for an action the world already performed.
 */
function validateMachineLoadAgainstPublishedRow(args: Record<string, unknown>, snapshot: Snapshot): string | null {
  const targets = snapshot.machineTargets;
  if (!Array.isArray(targets)) return null;
  const match = targets.find((target) => target.targetId === args.expectedTargetId);
  if (match === undefined) return null;
  if (match.loadInputSlot !== args.slot) return "machine_load_input_not_published";
  if (match.loadInputQualifiedItemId !== args.expectedQualifiedItemId) return "machine_load_input_not_published";
  if (!isMachineInputCount(match.loadInputStack)) return "machine_load_input_not_published";
  return null;
}

const KNOWN_ACTION_DESCRIPTOR_KEYS = [
  "arguments",
  "argumentSchema",
  "outputFacts",
  "resourceTemplate",
  "effect",
  "evidenceSchema",
  "nativeBinding",
  "canonicalCodec",
  "watchdogMs",
  "approach",
  "postcondition",
  "targetFamily",
  // The one fact that separates a counter purchase from an effect the Mod performs on its own
  // (`build_farm_building`). It has to be admitted here because this list is the exact-key gate over the descriptor the
  // hello_ack publishes: a member the Mod starts sending and this list lacks refuses the WHOLE registration list as
  // `invalid_hello_ack`.
  "synthetic",
  // The observation binding an action declares. It was in this list when `sceneTarget` entered the catalog (see the
  // note at line 2555), and it went missing while three action lanes merged - which the Mod experiences as
  // `invalid_hello_ack` for the WHOLE registration list, because `hasOnlyKeys` refuses the ack rather than the one
  // descriptor. The derived test beside this file now reads the Mod's own record, so a key this list lacks fails in
  // the Host's own suite instead of after a game launch (measured 2026-11-06: four live runs died at hello).
  "sceneTarget",
] as const;

export function isValidActionDescriptor(value: unknown): value is ActionRegistrationDescriptor {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, KNOWN_ACTION_DESCRIPTOR_KEYS)) return false;

  if ("arguments" in value && value.arguments !== undefined) {
    if (!Array.isArray(value.arguments) || value.arguments.length > 32) return false;
    for (const arg of value.arguments) {
      if (!isRecord(arg)) return false;
      if (!hasOnlyKeys(arg, ["name", "type", "enum", "boundedEnumValues", "description"])) return false;
      if (typeof arg.name !== "string" || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(arg.name)) return false;
      if (typeof arg.type !== "string" || arg.type.length === 0 || arg.type.length > 64) return false;
      if ("description" in arg && arg.description !== undefined) {
        // Bounded like every other published string: an unbounded one would be a way for a future Mod build to spend
        // the agent's context by accident. Empty is refused because a present-but-empty description is a label that
        // says nothing, and an ABSENT one is how the surface says "the name is the whole story".
        if (typeof arg.description !== "string" || arg.description.length === 0 || arg.description.length > 512)
          return false;
      }
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

  if ("approach" in value && value.approach !== undefined) {
    // A relation word plus an optional distance. `withinTiles` is absent when the Mod states no distance (its
    // serializer omits nulls), so a reader must never read absent as "zero tiles"; a third field beside them would be
    // a precondition nobody enforces.
    if (
      !isRecord(value.approach) ||
      !hasExactKeysOrOptional(value.approach, ["relation"], ["withinTiles"]) ||
      typeof value.approach.relation !== "string" ||
      value.approach.relation.length === 0 ||
      value.approach.relation.length > 64
    )
      return false;
    if (
      "withinTiles" in value.approach &&
      !(Number.isSafeInteger(value.approach.withinTiles) && (value.approach.withinTiles as number) > 0)
    )
      return false;
  }

  if ("targetFamily" in value && value.targetFamily !== undefined) {
    // The snapshot family this action's targets come from: an identifier naming a snapshot FIELD, so the same shape a
    // family id is held to. Empty is refused because a present-but-empty family says nothing while an ABSENT one means
    // "this action addresses no published family".
    if (
      typeof value.targetFamily !== "string" ||
      value.targetFamily.length === 0 ||
      value.targetFamily.length > 64 ||
      !/^[a-z][a-zA-Z0-9]{0,63}$/.test(value.targetFamily)
    )
      return false;
  }

  if ("synthetic" in value && value.synthetic !== undefined) {
    // Only ever `true`. The Mod omits the member on every action that goes through its counter, so a published `false`
    // would be a second spelling of "absent" - and a second spelling is how a descriptor outlives the fact it named.
    if (value.synthetic !== true) return false;
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
/** The `equip_tool` selector vocabulary: the same words a tool slot's published `category` and a `tool:<category>`
 * claim use, so a claim, a selector and a slot can never name one tool three ways. */
export const TOOL_SELECTOR_VALUES: ReadonlySet<string> = TOOL_CATEGORY_VALUES;

/** equip_tool/v2 semantic category selector; slot stays Mod-private. */
function isToolSelector(value: unknown): value is string {
  return typeof value === "string" && TOOL_SELECTOR_VALUES.has(value);
}
