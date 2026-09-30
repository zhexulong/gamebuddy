import { randomUUID } from "node:crypto";

const PROTOCOL_VERSION = 1;
// Mirrors BridgeProtocol.MaximumMessageBytes (C#): hello_ack carries the
// complete published action catalog (~16.7 KiB at 34 actions), so the frame
// bound must admit the full publication plus growth.
export const MAX_MESSAGE_BYTES = 32 * 1024;
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
  | { type: "destination_selector"; destination: Readonly<{ kind: "label"; label: string } | { kind: "ref"; ref: string }> }
>;
export type FarmhandPolicyIdentity = Readonly<{ value: string; capabilityRevision: number }>;
export type BodyPolicyIdentity = Readonly<{ value: string; capabilityRevision: number }>;
export type BodyExecutionBinding = Readonly<{ programId: string; nodeId: string; nodeAttempt: number; requestId: string; idempotencyKey: string; executionId: string }>;
export type BodyNodeAdmissionChallenge = Readonly<{
  programId: string; nodeId: string; nodeAttempt: number; admissionAttempt: number;
  stopEpoch: number; catalogRevision: number; policyIdentity: BodyPolicyIdentity; actionId: string;
  canonicalBoundArgs: Readonly<Record<string, BodyCanonicalValue>>;
  derivedResourceClaims: Readonly<Record<string, string>>; deadlineMs: number;
}>;
export type BodyNodeAdmissionGrant = BodyNodeAdmissionChallenge & Readonly<{
  grantId: string; attachmentGeneration: string; policyRevision: string;
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
 * own accrued consequence, not a transient read. Optional for older Mod
 * snapshots; false when the world is not ready.
 */
exhausted?: boolean;
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
  /** Live native warp targets; older Mod snapshots may omit this field. */
  warps?: readonly Readonly<{
    sourceX: number;
    sourceY: number;
    targetLocation: string;
    targetX: number;
    targetY: number;
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
  itemTargets?: readonly Readonly<{ targetId: string; x: number; y: number; qualifiedItemId: string;
    displayName: string; stack: number }>[];
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
  seedTargets?: readonly Readonly<{ targetId: string; slot: number; x: number; y: number; qualifiedItemId: string; displayName: string }>[];
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
  /** Adjacent intact `(O)590` artifact spots for one native Basic Hoe use. */
  artifactSpotTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    qualifiedItemId: "(O)590";
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
  treeSaplingTargets?: readonly Readonly<{ targetId: string; slot: number; x: number; y: number; qualifiedItemId: string; displayName: string }>[];
  /** Nearby Weed objects cuttable by an equipped scythe (cut_weeds). */
  weedTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number; health: number }>[];
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
  chestStoreTargets?: readonly Readonly<{ targetId: string; x: number; y: number; slot: number; qualifiedItemId: string;
    displayName: string; stack: number }>[];
  /** Nearby player-owned ordinary Chests holding an item retrievable into the Farmhand inventory (chest_retrieve). */
  chestRetrieveTargets?: readonly Readonly<{ targetId: string; x: number; y: number; qualifiedItemId: string;
    displayName: string; stack: number }>[];
  /** Bounded live inventory facts, currently published only for animal-product output rereads. */
  inventoryItemFacts?: readonly Readonly<{ slot: number; qualifiedItemId: string;
    displayName: string; stack: number }>[];
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
  shippingBinTargets?: readonly Readonly<{ targetId: string; x: number; y: number; slot: number; qualifiedItemId: string;
    displayName: string; stack: number }>[];
  /** Learned crafting recipes, each under the exact expectedTargetId craft_item accepts. */
  craftingRecipeTargets?: readonly Readonly<{ targetId: string; displayName: string; ingredientsAvailable: boolean }>[];
  /** Learned cooking recipes, each under the exact expectedTargetId cook_recipe accepts. */
  cookingRecipeTargets?: readonly Readonly<{ targetId: string; displayName: string; ingredientsAvailable: boolean }>[];
  /** Live cooking stations (vanilla kitchen action tile or a placed (BC)278 cookout kit) on the current map. */
  cookingStationTargets?: readonly Readonly<{ targetId: string; location: string; x: number; y: number;
    stationKind: "kitchen" | "cookout_kit" }>[];
   /** Available native minecart rides from a station on the current map, as
    * advertised for the `ride_minecart` action. */
  minecartTargets?: readonly Readonly<{ targetId: string; networkId: string; destinationId: string;
    displayName: string; price: number; stationX: number; stationY: number; targetLocation: string;
    targetTileX: number; targetTileY: number }>[];
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
    | "ride_minecart"
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
    | "scythe_crop"
    | "interact_npc_with_item"
    | "craft_item"
    | "cook_recipe"
    | "collect_crab_pot_output"
    | "ship_item"
    | "water_pet_bowl"
    | "water_slime_hutch_trough"
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
  kind: "npc" | "chest" | "crop" | "tree" | "animal" | "forage" | "door" | "machine" | "water_source" | "weed" | "stone" | "debris" | "artifact_spot";
  name: string;
  distance: number;
  direction: "North" | "South" | "East" | "West" | "CurrentTile";
  actionHint: string | null;
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
type BodyProgramDestinationSelector = Readonly<
  | { kind: "label"; label: string }
  | { kind: "ref"; ref: string }
>;
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
      }>
    >
  | Envelope<"observe_request", Readonly<Record<string, never>>>
  | Envelope<"navigation_read_request", NavigationReadRequest>
  | Envelope<"navigation_read_result", NavigationReadResult>
  | Envelope<"observe_scene_request", ObserveSceneRequest>
  | Envelope<"observe_scene_result", ObserveSceneResult>
  | Envelope<"snapshot", Snapshot>
  | Envelope<"catalog_update", Readonly<{ catalogRevision: number; policyIdentity: FarmhandPolicyIdentity; enabledActionIds: readonly string[] }>>
  | Envelope<"execution_request", ExecutionRequest>
  | Envelope<"body_node_admission_challenge", BodyNodeAdmissionChallenge>
  | Envelope<"body_node_admission_grant", BodyNodeAdmissionGrant>
  | Envelope<"body_node_admission_result", BodyNodeAdmissionResult>
  | Envelope<"execution_receipt_query", ExecutionReceiptQuery>
  | Envelope<"cancel_request", CancelRequestPayload>
  | Envelope<"companion_presentation_request", CompanionPresentationRequest>
  | Envelope<"system_notice_request", SystemNoticeRequest>
  | Envelope<"system_notice_receipt", SystemNoticeReceipt>
  | Envelope<"companion_presentation_receipt", Readonly<{ expressionId: string; revision: number; presentationEpoch: number }>>
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
  "hello", "hello_ack", "observe_request", "navigation_read_request", "navigation_read_result", "observe_scene_request", "observe_scene_result", "snapshot", "catalog_update",
  "execution_request", "body_node_admission_challenge", "body_node_admission_grant", "body_node_admission_result", "execution_receipt_query", "cancel_request", "companion_presentation_request", "system_notice_request",
  "system_notice_receipt", "companion_presentation_receipt", "player_control_receipt", "execution_receipt",
  "program_submit", "program_submit_result", "program_status", "program_status_result",
  "program_events", "program_events_result", "error", "semantic_event", "lifecycle", "world_fact",
] as const;

const SNAPSHOT_KEYS = [
  "revision",
  "location",
  "tile",
  "stamina",
  "exhausted",
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
  "scytheCropTargets",
  "npcRelationshipTargets",
  "villagerWhereabouts",
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
  "minecartTargets",
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
  if (message.type === "body_node_admission_challenge" || message.type === "body_node_admission_grant" || message.type === "body_node_admission_result") {
    try { serializeBounded(message); } catch (error) { return error instanceof Error ? error.message : "message_not_serializable"; }
  }
  switch (message.type) {
    case "hello":
      return hasExactKeys(payload, ["token"]) && validToken(payload.token) ? null : "invalid_hello_token";
    case "hello_ack":
      return hasExactKeys(payload, [
        "sessionId",
        "capabilities",
        "catalogRevision",
        "policyIdentity",
        "enabledActionIds",
        "presentationLocale",
        "registrations",
        "runtimeRole",
        "launchGeneration",
      ]) &&
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
      return hasExactKeys(payload, ["programId"]) && isOpaqueId(payload.programId) ? null : "invalid_body_program_request";
    case "program_status_result":
      return validateBodyProgramStatusResult(payload);
    case "program_events":
      return hasExactKeys(payload, ["programId", "cursor", "pageSize"]) && isOpaqueId(payload.programId) &&
        isNonNegativeSafeInteger(payload.cursor) && Number.isSafeInteger(payload.pageSize) &&
        (payload.pageSize as number) >= 1 && (payload.pageSize as number) <= 32 ? null : "invalid_body_program_request";
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
    if (!hasExactKeys(value, ["result", "programId", "nodeId", "nodeAttempt", "admissionAttempt", "stopEpoch", "catalogRevision", "policyIdentity", "actionId", "canonicalBoundArgs", "derivedResourceClaims", "deadlineMs", "grantId", "attachmentGeneration", "policyRevision", "executionBinding"]))
      return "invalid_body_node_admission_result";
    const { result: _result, ...grant } = value;
    return validateBodyNodeAdmissionGrant(grant);
  }
  if (value.result === "rejected" || value.result === "unavailable") {
    if (!hasExactKeys(value, ["result", "code", "programId", "nodeId", "nodeAttempt", "admissionAttempt", "stopEpoch", "catalogRevision", "policyIdentity", "actionId", "canonicalBoundArgs", "derivedResourceClaims", "deadlineMs"]))
      return "invalid_body_node_admission_result";
    if (typeof value.code !== "string" || !isReasonCode(value.code) || (value.result === "unavailable" && value.code !== "admission_unavailable"))
      return "invalid_body_node_admission_result";
    const { result: _result, code: _code, ...challenge } = value;
    return validateBodyNodeAdmissionChallenge(challenge);
  }
  return "invalid_body_node_admission_result";
}

function validateBodyNodeAdmissionChallenge(value: Record<string, unknown>, grant = false): string | null {
  const base = ["programId","nodeId","nodeAttempt","admissionAttempt","stopEpoch","catalogRevision","policyIdentity","actionId","canonicalBoundArgs","derivedResourceClaims","deadlineMs"];
  if (grant) base.push("grantId", "attachmentGeneration", "policyRevision", "executionBinding");
  if (!hasExactKeys(value, base) || !isOpaqueId(value.programId) || !isOpaqueId(value.nodeId) || !isOpaqueId(value.actionId)) return "invalid_body_node_admission_challenge";
  if (!["nodeAttempt","admissionAttempt"].every(k => isPositiveSafeInteger(value[k]) && (value[k] as number) <= 2_147_483_647) || !["stopEpoch","catalogRevision"].every(k => isNonNegativeSafeInteger(value[k])) || !isPositiveSafeInteger(value.deadlineMs)) return "invalid_body_node_admission_challenge";
  if (!isRecord(value.policyIdentity) || !hasExactKeys(value.policyIdentity,["value","capabilityRevision"]) || !isAdmissionOpaque(value.policyIdentity.value) || !isNonNegativeSafeInteger(value.policyIdentity.capabilityRevision) || !isRecord(value.canonicalBoundArgs) || !isRecord(value.derivedResourceClaims)) return "invalid_body_node_admission_challenge";
  return Object.keys(value.derivedResourceClaims).length <= 16 && Object.keys(value.canonicalBoundArgs).length <= 32 && Object.entries(value.derivedResourceClaims).every(([k,v])=>isAdmissionMapKey(k)&&isOpaqueId(v)) && Object.entries(value.canonicalBoundArgs).every(([k,v])=>isAdmissionMapKey(k)&&isBodyCanonicalValue(v)) ? null : "invalid_body_node_admission_challenge";
}
function validateBodyNodeAdmissionGrant(value: Record<string, unknown>): string | null {
  const err = validateBodyNodeAdmissionChallenge(value, true); if (err) return "invalid_body_node_admission_grant";
  if (!hasExactKeys(value,["programId","nodeId","nodeAttempt","admissionAttempt","stopEpoch","catalogRevision","policyIdentity","actionId","canonicalBoundArgs","derivedResourceClaims","deadlineMs","grantId","attachmentGeneration","policyRevision","executionBinding"]) || !isOpaqueId(value.grantId) || !isAdmissionOpaque(value.attachmentGeneration) || !isAdmissionOpaque(value.policyRevision)) return "invalid_body_node_admission_grant";
  const binding = value.executionBinding;
  return binding === null || (isRecord(binding) && hasExactKeys(binding, ["programId", "nodeId", "nodeAttempt", "requestId", "idempotencyKey", "executionId"])
    && binding.programId === value.programId && binding.nodeId === value.nodeId && binding.nodeAttempt === value.nodeAttempt
    && isOpaqueId(binding.requestId) && isOpaqueId(binding.idempotencyKey) && isOpaqueId(binding.executionId)) ? null : "invalid_body_node_admission_grant";
}
function isFarmhandPolicyIdentity(value: unknown): value is FarmhandPolicyIdentity {
  return isRecord(value) && hasExactKeys(value, ["value", "capabilityRevision"]) &&
    typeof value.value === "string" && /^[0-9a-f]{32}$/iu.test(value.value) &&
    isPositiveSafeInteger(value.capabilityRevision);
}

function isAdmissionMapKey(value: unknown): value is string {
  return isOpaqueId(value) && value !== "__proto__";
}
function isAdmissionOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function isBodyCanonicalValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "destination_selector") {
    const destination = value.destination;
    return hasExactKeys(value, ["type", "destination"]) && isRecord(destination) && (
      (hasExactKeys(destination, ["kind", "label"]) && destination.kind === "label" && typeof destination.label === "string"
        && destination.label.length >= 1 && destination.label.length <= 128 && destination.label.trim().length > 0 && destination.label.normalize("NFC") === destination.label)
      || (hasExactKeys(destination, ["kind", "ref"]) && destination.kind === "ref" && typeof destination.ref === "string" && /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/u.test(destination.ref)));
  }
  if (!hasExactKeys(value, ["type", "canonicalValue"]) || typeof value.canonicalValue !== "string" || value.canonicalValue.length > 512) return false;
  if (value.type === "string") return true;
  if (value.type === "boolean") return value.canonicalValue === "true" || value.canonicalValue === "false";
  if (value.type !== "integer" || !/^(?:0|-?[1-9][0-9]*)$/u.test(value.canonicalValue)) return false;
  const integer = BigInt(value.canonicalValue);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}
function isPositiveSafeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

const OBSERVE_SCENE_KINDS = new Set(["npc", "chest", "crop", "tree", "animal", "forage", "door", "machine", "water_source", "weed", "stone", "debris", "artifact_spot"]);
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
  if (!isRecord(value) ||
      !hasExactKeys(value, ["dominantKind", "dominantTileCount", "scannedTileCount", "exceptions", "omittedExceptionTileCount"])) return false;
  if (typeof value.dominantKind !== "string" || !SCENE_GROUND_KINDS.has(value.dominantKind)) return false;
  if (!Number.isSafeInteger(value.dominantTileCount) || (value.dominantTileCount as number) < 0) return false;
  if (!Number.isSafeInteger(value.scannedTileCount) || (value.scannedTileCount as number) < 0) return false;
  if ((value.dominantTileCount as number) > (value.scannedTileCount as number)) return false;
  if (!Number.isSafeInteger(value.omittedExceptionTileCount) || (value.omittedExceptionTileCount as number) < 0) return false;
  if (!Array.isArray(value.exceptions) || value.exceptions.length > MAXIMUM_SCENE_GROUND_EXCEPTIONS) return false;
  return value.exceptions.every((tile) => isRecord(tile) &&
    hasExactKeys(tile, ["tileX", "tileY", "kind"]) &&
    Number.isSafeInteger(tile.tileX) && Number.isSafeInteger(tile.tileY) &&
    typeof tile.kind === "string" && SCENE_GROUND_KINDS.has(tile.kind));
}

export function isValidObserveSceneRequest(value: unknown): value is ObserveSceneRequest {
  return isRecord(value) && validateObserveSceneRequest(value) === null;
}

export function isValidObserveSceneResult(value: unknown): value is ObserveSceneResult {
  return isRecord(value) && validateObserveSceneResult(value) === null;
}

function validateObserveSceneRequest(value: Record<string, unknown>): string | null {
  if (hasExactKeys(value, [])) return null;
  return hasExactKeys(value, ["radius"]) && Number.isSafeInteger(value.radius) &&
    (value.radius as number) >= 0 && (value.radius as number) <= 30
    ? null
    : "invalid_observe_scene_request";
}

function validateObserveSceneResult(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["observationId", "currentLocation", "currentRegion", "affordances", "summary", "partial", "truncatedReason", "ground"]) ||
      !isOpaqueId(value.observationId) ||
      !boundedSceneText(value.currentLocation, 128) || !boundedSceneText(value.currentRegion, 128) ||
      !boundedSceneText(value.summary, 512) || typeof value.partial !== "boolean" ||
      !Array.isArray(value.affordances) || value.affordances.length > 20 ||
      (value.partial
        ? typeof value.truncatedReason !== "string" || !OBSERVE_SCENE_TRUNCATION_REASONS.has(value.truncatedReason)
        : value.truncatedReason !== null) ||
      !validateObserveSceneGround(value.ground))
    return "invalid_observe_scene_result";
  const refs = new Set<string>();
  return value.affordances.every((affordance) => {
    if (!isRecord(affordance) || !hasExactKeys(affordance, ["ref", "kind", "name", "distance", "direction", "actionHint"]) ||
        !isSceneReference(affordance.ref) || typeof affordance.kind !== "string" || !OBSERVE_SCENE_KINDS.has(affordance.kind) ||
        !boundedSceneText(affordance.name, 128) || !Number.isSafeInteger(affordance.distance) ||
        (affordance.distance as number) < 0 || (affordance.distance as number) > 30 ||
        typeof affordance.direction !== "string" || !OBSERVE_SCENE_DIRECTIONS.has(affordance.direction) ||
        (affordance.actionHint !== null && !boundedSceneText(affordance.actionHint, 160)) || refs.has(affordance.ref))
      return false;
    refs.add(affordance.ref as string);
    return true;
  }) ? null : "invalid_observe_scene_result";
}

function boundedSceneText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength && !/[\u0000-\u001f\u007f\u0080-\u009f]/u.test(value);
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
      Array.isArray(value.entries) && value.entries.length <= 20 && value.entries.every(isNavigationWorldMapEntry) &&
      (value.nextCursor === null || isOpaqueId(value.nextCursor)) &&
      value.candidates === null && value.destination === null && value.unlockState === null
      ? null : "invalid_navigation_read_result";
  }
  if (value.status === "resolved") {
    return (value.reason === "exact_current_locale" || value.reason === "exact_fallback_locale" || value.reason === "exact_alias") &&
      value.entries === null && value.nextCursor === null && value.candidates === null &&
      isNavigationSelector(value.destination) && value.unlockState === "unknown"
      ? null : "invalid_navigation_read_result";
  }
  if (value.status === "candidates") {
    return (value.reason === "ambiguous_exact" || value.reason === "fuzzy_match") &&
      value.entries === null && value.nextCursor === null && Array.isArray(value.candidates) &&
      value.candidates.length >= 1 && value.candidates.length <= 3 && value.candidates.every(isNavigationSearchCandidate) &&
      value.destination === null && value.unlockState === null
      ? null : "invalid_navigation_read_result";
  }
  const validTerminal =
    (value.status === "not_found" && value.reason === "destination_not_found") ||
    (value.status === "invalid" && value.reason === "destination_search_invalid") ||
    (value.status === "blocked" && isReasonCode(value.reason));
  return validTerminal && value.entries === null && value.nextCursor === null && value.candidates === null &&
    value.destination === null && value.unlockState === null
    ? null : "invalid_navigation_read_result";
}

function isExecutionNavigationDestinationSelector(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  return value.kind === "label"
    ? hasExactKeys(value, ["kind", "label"]) && isBoundedNonEmptyString(value.label, 128)
    : value.kind === "ref" && hasExactKeys(value, ["kind", "ref"]) && typeof value.ref === "string" && /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/.test(value.ref);
}

function isNavigationSelector(value: unknown): value is NavigationSelector {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "label", "ref"])) return false;
  return value.kind === "label"
    ? isBoundedNonEmptyString(value.label, 128) && value.ref === null
    : value.kind === "ref" && value.label === null && (value.ref === null || isOpaqueId(value.ref));
}

function isNavigationWorldMapEntry(value: unknown): value is NavigationWorldMapEntry {
  return isRecord(value) && hasExactKeys(value, ["label", "contextLabel", "nodeRef", "destination"]) &&
    isBoundedNonEmptyString(value.label, 128) &&
    (value.contextLabel === null || isBoundedNonEmptyString(value.contextLabel, 128)) &&
    (value.nodeRef === null || isOpaqueId(value.nodeRef)) &&
    (value.destination === null || isNavigationSelector(value.destination));
}

function isNavigationSearchCandidate(value: unknown): value is NavigationSearchCandidate {
  return isRecord(value) && hasExactKeys(value, ["label", "contextLabel", "destination", "unlockState"]) &&
    isBoundedNonEmptyString(value.label, 128) &&
    (value.contextLabel === null || isBoundedNonEmptyString(value.contextLabel, 128)) &&
    isNavigationSelector(value.destination) && value.unlockState === "unknown";
}

function isBoundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

export function validateExecutionRequest(value: unknown, snapshot: Snapshot, nowMs = Date.now()): string | null {
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
    value.action !== "enter_exit" &&
    value.action !== "till_soil" &&
    value.action !== "pickup_forage" &&
    value.action !== "pickup_item" &&
    value.action !== "water_crop" &&
    value.action !== "water_pet_bowl" &&
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
    value.action !== "scythe_crop" &&
    value.action !== "interact_npc_with_item" &&
    value.action !== "craft_item" &&
    value.action !== "cook_recipe" &&
    value.action !== "collect_crab_pot_output" &&
    value.action !== "ship_item" &&
    value.action !== "advance_day"
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
  if (!snapshot.actionable) return "player_not_actionable";
  if (!snapshot.capabilities.includes(value.action)) return "capability_not_declared";
  if (value.action === "move_to_tile") {
    if (!hasExactKeys(value.args, ["x","y"])) return "invalid_args";
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_target_tile";
  } else if (value.action === "navigate_to_destination") {
    if (!hasExactKeys(value.args, ["destination"])) return "invalid_args";
    
    if (!isExecutionNavigationDestinationSelector(value.args.destination)) return "invalid_navigation_destination";
  } else if (value.action === "equip_tool") {
    if (!hasExactKeys(value.args, ["tool"])) return "invalid_args";
    
    if (!isToolSelector(value.args.tool)) return "invalid_tool_selector";
  } else if (value.action === "travel") {
    if (!hasExactKeys(value.args, ["x","y"])) return "invalid_args";
    
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_warp_source";
  } else if (value.action === "ride_minecart") {
    // The station tile plus one exact published ride. Both x/y and the opaque
    // selector are mandatory: unlike `travel`, there is no "plain" form, so a
    // missing selector is a malformed request rather than an ordinary warp.
    if (!hasExactKeys(value.args, ["x", "y", "expectedTargetId"])) return "invalid_args";
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_minecart_station";
    return validateMinecartRideTarget(value.args, snapshot);
  } else if (value.action === "enter_exit") {
    if (!hasExactKeys(value.args, ["x","y"])) return "invalid_args";
    
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_door_target";
  } else if (value.action === "till_soil") {
    if (!hasExactKeys(value.args, ["x","y"])) return "invalid_args";
    
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_soil_target";
  } else if (value.action === "pickup_forage") {
    if (!hasExactKeys(value.args, ["x","y","expectedQualifiedItemId","expectedTargetId","sceneTarget"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["x","y","expectedQualifiedItemId","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_crop_target";
  } else if (value.action === "water_pet_bowl") {
    if (!hasExactKeys(value.args, ["x","y","expectedTargetId"])) return "invalid_args";
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_pet_bowl_target";
  } else if (value.action === "water_slime_hutch_trough") {
    if (!hasExactKeys(value.args, ["x","y","expectedTargetId"])) return "invalid_args";
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_slime_hutch_trough_target";
  } else if (value.action === "harvest_crop") {
    if (!hasExactKeys(value.args, ["x","y","expectedQualifiedItemId","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedQualifiedItemId","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedQualifiedItemId","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedQualifiedItemId","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_debris_target";
  } else if (value.action === "machine_inspect") {
    if (!hasExactKeys(value.args, ["x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_machine_target";
  } else if (value.action === "machine_load") {
    if (!hasExactKeys(value.args, ["slot","x","y","expectedQualifiedItemId","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !hasOnlyKeys(value.args, ["x", "y", "expectedTargetId"]) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_machine_collect_target";
  } else if (value.action === "npc_relationship") {
    if (!hasExactKeys(value.args, ["x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_npc_relationship_target";
  } else if (value.action === "pet_animal") {
    if (!hasExactKeys(value.args, ["x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_pet_target";
  } else if (value.action === "collect_animal_product") {
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_animal_product_target";
  } else if (value.action === "feed_animal") {
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_feed_trough_target";
  } else if (value.action === "break_rock_source") {
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","x","y","expectedTargetId"])) return "invalid_args";
    
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
    if (!hasExactKeys(value.args, ["slot","expectedQualifiedItemId"])) return "invalid_args";
    
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
    
    if (typeof value.args.direction !== "string" || value.args.direction.length === 0 || value.args.direction.length > 64)
      return "invalid_direction";
  } else if (value.action === "chest_store" || value.action === "chest_retrieve") {
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";
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
  } else if (value.action === "chop_stump" || value.action === "cut_weeds" || value.action === "scythe_crop") {
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
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";
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
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";
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
    if (!hasExactKeys(value.args, ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"])) return "invalid_args";
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
  if (isRecord(value) && (value.type === "body_node_admission_challenge" || value.type === "body_node_admission_grant" || value.type === "body_node_admission_result")) {
    const serialized = JSON.parse(json) as Record<string, unknown>;
    const envelopeError = validateEnvelope(serialized, serialized.scope as Scope, serialized.timestampMs as number);
    const payloadError = !isRecord(serialized.payload) ? "invalid_payload" : serialized.type === "body_node_admission_grant"
      ? validateBodyNodeAdmissionGrant(serialized.payload) : serialized.type === "body_node_admission_result"
        ? validateBodyNodeAdmissionResult(serialized.payload) : validateBodyNodeAdmissionChallenge(serialized.payload);
    if (envelopeError || payloadError) throw new Error(envelopeError ?? payloadError!);
  }
  return json;
}

function diagnoseSnapshot(value: Record<string, unknown>): string {
  if (!Number.isSafeInteger(value.revision)) return "invalid_snapshot:revision";
  if (typeof value.location !== "string") return "invalid_snapshot:location";
  if (!isRecord(value.tile) || !isFiniteNumber(value.tile.x) || !isFiniteNumber(value.tile.y))
    return "invalid_snapshot:tile";
  if (!isFiniteNumber(value.stamina)) return "invalid_snapshot:stamina";
  if (value.exhausted !== undefined && typeof value.exhausted !== "boolean")
    return "invalid_snapshot:exhausted";
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
  if (value.currentTool !== undefined && value.currentTool !== null && typeof value.currentTool !== "string")
    return "invalid_snapshot:currentTool";
  if (value.inventorySlots !== undefined && !Number.isSafeInteger(value.inventorySlots))
    return "invalid_snapshot:inventorySlots";
  if (
    value.warps !== undefined &&
    (!Array.isArray(value.warps) || value.warps.length > 512 || !value.warps.every(isWarp))
  )
    return "invalid_snapshot:warps";
  if (
    value.doorTargets !== undefined &&
    (!Array.isArray(value.doorTargets) || value.doorTargets.length > 64 || !value.doorTargets.every(isWarp))
  )
    return "invalid_snapshot:doorTargets";
  if (
    value.soilTiles !== undefined &&
    (!Array.isArray(value.soilTiles) || value.soilTiles.length > 64 || !value.soilTiles.every(isSoilTile))
  )
    return "invalid_snapshot:soilTiles";
  if (
    value.toolSlots !== undefined &&
    (!Array.isArray(value.toolSlots) || value.toolSlots.length > 36 || !value.toolSlots.every(isToolSlotFact))
  )
    return "invalid_snapshot:toolSlots";
  if (
    value.forageTargets !== undefined &&
    (!Array.isArray(value.forageTargets) ||
      value.forageTargets.length > 64 ||
      !value.forageTargets.every(isForageTargetFact))
  )
    return "invalid_snapshot:forageTargets";
  if (
    value.itemTargets !== undefined &&
    (!Array.isArray(value.itemTargets) || value.itemTargets.length > 64 || !value.itemTargets.every(isItemTargetFact))
  )
    return "invalid_snapshot:itemTargets";
  if (
    value.wateringCanFacts !== undefined &&
    (!Array.isArray(value.wateringCanFacts) ||
      value.wateringCanFacts.length > 36 ||
      !value.wateringCanFacts.every(isWateringCanFact))
  )
    return "invalid_snapshot:wateringCanFacts";
  if (
    value.refillWateringCanTargets !== undefined &&
    (!Array.isArray(value.refillWateringCanTargets) ||
      value.refillWateringCanTargets.length > 8 ||
      !value.refillWateringCanTargets.every(isRefillWateringCanTargetFact))
  )
    return "invalid_snapshot:refillWateringCanTargets";
  if (
    value.cropTargets !== undefined &&
    (!Array.isArray(value.cropTargets) || value.cropTargets.length > 64 || !value.cropTargets.every(isCropTargetFact))
  )
    return "invalid_snapshot:cropTargets";
  if (
    value.petBowlTargets !== undefined &&
    (!Array.isArray(value.petBowlTargets) ||
      value.petBowlTargets.length > 8 ||
      !value.petBowlTargets.every(isPetBowlTargetFact))
  )
    return "invalid_snapshot:petBowlTargets";
  if (
    value.slimeHutchTroughTargets !== undefined &&
    (!Array.isArray(value.slimeHutchTroughTargets) ||
      value.slimeHutchTroughTargets.length > 4 ||
      !value.slimeHutchTroughTargets.every(isSlimeHutchTroughTargetFact))
  )
    return "invalid_snapshot:slimeHutchTroughTargets";
  if (
    value.harvestTargets !== undefined &&
    (!Array.isArray(value.harvestTargets) ||
      value.harvestTargets.length > 64 ||
      !value.harvestTargets.every(isHarvestTargetFact))
  )
    return "invalid_snapshot:harvestTargets";
  if (
    value.seedTargets !== undefined &&
    (!Array.isArray(value.seedTargets) || value.seedTargets.length > 64 || !value.seedTargets.every(isSeedTargetFact))
  )
    return "invalid_snapshot:seedTargets";
  if (
    value.fertilizerTargets !== undefined &&
    (!Array.isArray(value.fertilizerTargets) ||
      value.fertilizerTargets.length > 64 ||
      !value.fertilizerTargets.every(isSeedTargetFact))
  )
    return "invalid_snapshot:fertilizerTargets";
  if (
    value.debrisTargets !== undefined &&
    (!Array.isArray(value.debrisTargets) ||
      value.debrisTargets.length > 64 ||
      !value.debrisTargets.every(isDebrisTargetFact))
  )
    return "invalid_snapshot:debrisTargets";
  if (
    value.rockSourceTargets !== undefined &&
    (!Array.isArray(value.rockSourceTargets) ||
      value.rockSourceTargets.length > 8 ||
      !value.rockSourceTargets.every(isRockSourceTargetFact))
  )
    return "invalid_snapshot:rockSourceTargets";
  if (
    value.clearHoeDirtTargets !== undefined &&
    (!Array.isArray(value.clearHoeDirtTargets) ||
      value.clearHoeDirtTargets.length > 8 ||
      !value.clearHoeDirtTargets.every(isClearHoeDirtTargetFact))
  )
    return "invalid_snapshot:clearHoeDirtTargets";
  if (
    value.artifactSpotTargets !== undefined &&
    (!Array.isArray(value.artifactSpotTargets) ||
      value.artifactSpotTargets.length > 8 ||
      !value.artifactSpotTargets.every(isArtifactSpotTargetFact))
  )
    return "invalid_snapshot:artifactSpotTargets";
  if (
    value.artifactSpotResultTargets !== undefined &&
    (!Array.isArray(value.artifactSpotResultTargets) ||
      value.artifactSpotResultTargets.length > 1 ||
      !value.artifactSpotResultTargets.every(isArtifactSpotResultTargetFact))
  )
    return "invalid_snapshot:artifactSpotResultTargets";
  if (
    value.artifactSpotFarmSourceCount !== undefined &&
    value.artifactSpotFarmSourceCount !== null &&
    (typeof value.artifactSpotFarmSourceCount !== "number" ||
      !Number.isSafeInteger(value.artifactSpotFarmSourceCount) ||
      value.artifactSpotFarmSourceCount < 0)
  )
    return "invalid_snapshot:artifactSpotFarmSourceCount";
  if (
    value.machineTargets !== undefined &&
    (!Array.isArray(value.machineTargets) ||
      value.machineTargets.length > 64 ||
      !value.machineTargets.every(isMachineTargetFact))
  )
    return "invalid_snapshot:machineTargets";
  if (
    value.treeChopSourceTargets !== undefined &&
    (!Array.isArray(value.treeChopSourceTargets) ||
      value.treeChopSourceTargets.length > 64 ||
      !value.treeChopSourceTargets.every(isTreeChopSourceTargetFact))
  )
    return "invalid_snapshot:treeChopSourceTargets";
  if (
    value.treeChopResultTargets !== undefined &&
    (!Array.isArray(value.treeChopResultTargets) ||
      value.treeChopResultTargets.length > 64 ||
      !value.treeChopResultTargets.every(isTreeChopResultTargetFact))
  )
    return "invalid_snapshot:treeChopResultTargets";
  if (
    value.treeStumpTargets !== undefined &&
    (!Array.isArray(value.treeStumpTargets) ||
      value.treeStumpTargets.length > 16 ||
      !value.treeStumpTargets.every(isTreeStumpTargetFact))
  )
    return "invalid_snapshot:treeStumpTargets";
  if (
    value.treeSaplingTargets !== undefined &&
    (!Array.isArray(value.treeSaplingTargets) ||
      value.treeSaplingTargets.length > 64 ||
      !value.treeSaplingTargets.every(isTreeSaplingTargetFact))
  )
    return "invalid_snapshot:treeSaplingTargets";
  if (
    value.weedTargets !== undefined &&
    (!Array.isArray(value.weedTargets) ||
      value.weedTargets.length > 16 ||
      !value.weedTargets.every(isWeedTargetFact))
  )
    return "invalid_snapshot:weedTargets";
  if (
    value.scytheCropTargets !== undefined &&
    (!Array.isArray(value.scytheCropTargets) ||
      value.scytheCropTargets.length > 16 ||
      !value.scytheCropTargets.every(isScytheCropTargetFact))
  )
    return "invalid_snapshot:scytheCropTargets";
  if (
    value.npcRelationshipTargets !== undefined &&
    (!Array.isArray(value.npcRelationshipTargets) ||
      value.npcRelationshipTargets.length > 64 ||
      !value.npcRelationshipTargets.every(isNpcRelationshipTargetFact))
  )
    return "invalid_snapshot:npcRelationshipTargets";
  if (
    value.villagerWhereabouts !== undefined &&
    (!Array.isArray(value.villagerWhereabouts) ||
      value.villagerWhereabouts.length > 64 ||
      !value.villagerWhereabouts.every(isVillagerWhereaboutsFact))
  )
    return "invalid_snapshot:villagerWhereabouts";
  if (
    value.petTargets !== undefined &&
    (!Array.isArray(value.petTargets) || value.petTargets.length > 16 || !value.petTargets.every(isPetTargetFact))
  )
    return "invalid_snapshot:petTargets";
  if (
    value.animalProductTargets !== undefined &&
    (!Array.isArray(value.animalProductTargets) ||
      value.animalProductTargets.length > 32 ||
      !value.animalProductTargets.every(isAnimalProductTargetFact))
  )
    return "invalid_snapshot:animalProductTargets";
  if (
    value.feedTroughTargets !== undefined &&
    (!Array.isArray(value.feedTroughTargets) ||
      value.feedTroughTargets.length > 32 ||
      !value.feedTroughTargets.every(isFeedTroughTargetFact))
  )
    return "invalid_snapshot:feedTroughTargets";
  if (
    value.chestStoreTargets !== undefined &&
    (!Array.isArray(value.chestStoreTargets) ||
      value.chestStoreTargets.length > 16 ||
      !value.chestStoreTargets.every(isChestStoreTargetFact))
  )
    return "invalid_snapshot:chestStoreTargets";
  if (
    value.chestRetrieveTargets !== undefined &&
    (!Array.isArray(value.chestRetrieveTargets) ||
      value.chestRetrieveTargets.length > 16 ||
      !value.chestRetrieveTargets.every(isChestRetrieveTargetFact))
  )
    return "invalid_snapshot:chestRetrieveTargets";
  if (
    value.inventoryItemFacts !== undefined &&
    (!Array.isArray(value.inventoryItemFacts) ||
      value.inventoryItemFacts.length > 36 ||
      !value.inventoryItemFacts.every(isInventoryItemFact))
  )
    return "invalid_snapshot:inventoryItemFacts";
  if (
    value.foodTargets !== undefined &&
    (!Array.isArray(value.foodTargets) || value.foodTargets.length > 36 || !value.foodTargets.every(isFoodTargetFact))
  )
    return "invalid_snapshot:foodTargets";
  if (
    value.shippingBinTargets !== undefined &&
    (!Array.isArray(value.shippingBinTargets) ||
      value.shippingBinTargets.length > 1 ||
      !value.shippingBinTargets.every(isShippingBinTargetFact))
  )
    return "invalid_snapshot:shippingBinTargets";
  if (
    value.craftingRecipeTargets !== undefined &&
    (!Array.isArray(value.craftingRecipeTargets) ||
      value.craftingRecipeTargets.length > 64 ||
      !value.craftingRecipeTargets.every(isRecipeTargetFact))
  )
    return "invalid_snapshot:craftingRecipeTargets";
  if (
    value.cookingRecipeTargets !== undefined &&
    (!Array.isArray(value.cookingRecipeTargets) ||
      value.cookingRecipeTargets.length > 64 ||
      !value.cookingRecipeTargets.every(isRecipeTargetFact))
  )
    return "invalid_snapshot:cookingRecipeTargets";
  if (
    value.cookingStationTargets !== undefined &&
    (!Array.isArray(value.cookingStationTargets) ||
      value.cookingStationTargets.length > 16 ||
      !value.cookingStationTargets.every(isCookingStationTargetFact))
  )
    return "invalid_snapshot:cookingStationTargets";
  if (
    value.minecartTargets !== undefined &&
    (!Array.isArray(value.minecartTargets) ||
      value.minecartTargets.length > 24 ||
      !value.minecartTargets.every(isMinecartTargetFact))
  )
    return "invalid_snapshot:minecartTargets";
  if (!isStringArray(value.capabilities)) return "invalid_snapshot:capabilities";
  if (!isNonNegativeSafeInteger(value.catalogRevision)) return "invalid_snapshot:catalogRevision";
  if (!isUniqueOpaqueIdArray(value.enabledActionIds)) return "invalid_snapshot:enabledActionIds";
  if (
    value.activeExecution !== undefined &&
    value.activeExecution !== null &&
    (!isRecord(value.activeExecution) || validateActiveExecution(value.activeExecution) !== null)
  )
    return "invalid_snapshot:activeExecution";
  return "accepted";
}

function validateSnapshot(value: Record<string, unknown>): string | null {
  return hasOnlyKeys(value, SNAPSHOT_KEYS) &&
    Number.isSafeInteger(value.revision) &&
    typeof value.location === "string" &&
    isRecord(value.tile) &&
    hasExactKeys(value.tile, ["x", "y"]) &&
    isFiniteNumber(value.tile.x) &&
    isFiniteNumber(value.tile.y) &&
    isFiniteNumber(value.stamina) &&
    (value.exhausted === undefined || typeof value.exhausted === "boolean") &&
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
    (value.warps === undefined ||
      (Array.isArray(value.warps) && value.warps.length <= 512 && value.warps.every(isWarp))) &&
    (value.doorTargets === undefined ||
      (Array.isArray(value.doorTargets) && value.doorTargets.length <= 64 && value.doorTargets.every(isWarp))) &&
    (value.soilTiles === undefined ||
      (Array.isArray(value.soilTiles) && value.soilTiles.length <= 64 && value.soilTiles.every(isSoilTile))) &&
    (value.toolSlots === undefined ||
      (Array.isArray(value.toolSlots) && value.toolSlots.length <= 36 && value.toolSlots.every(isToolSlotFact))) &&
    (value.forageTargets === undefined ||
      (Array.isArray(value.forageTargets) &&
        value.forageTargets.length <= 64 &&
        value.forageTargets.every(isForageTargetFact))) &&
    (value.itemTargets === undefined ||
      (Array.isArray(value.itemTargets) &&
        value.itemTargets.length <= 64 &&
        value.itemTargets.every(isItemTargetFact))) &&
    (value.wateringCanFacts === undefined ||
      (Array.isArray(value.wateringCanFacts) &&
        value.wateringCanFacts.length <= 36 &&
        value.wateringCanFacts.every(isWateringCanFact))) &&
    (value.refillWateringCanTargets === undefined ||
      (Array.isArray(value.refillWateringCanTargets) &&
        value.refillWateringCanTargets.length <= 8 &&
        value.refillWateringCanTargets.every(isRefillWateringCanTargetFact))) &&
    (value.cropTargets === undefined ||
      (Array.isArray(value.cropTargets) &&
        value.cropTargets.length <= 64 &&
        value.cropTargets.every(isCropTargetFact))) &&
    (value.petBowlTargets === undefined ||
      (Array.isArray(value.petBowlTargets) &&
        value.petBowlTargets.length <= 8 &&
        value.petBowlTargets.every(isPetBowlTargetFact))) &&
    (value.slimeHutchTroughTargets === undefined ||
      (Array.isArray(value.slimeHutchTroughTargets) &&
        value.slimeHutchTroughTargets.length <= 4 &&
        value.slimeHutchTroughTargets.every(isSlimeHutchTroughTargetFact))) &&
    (value.harvestTargets === undefined ||
      (Array.isArray(value.harvestTargets) &&
        value.harvestTargets.length <= 64 &&
        value.harvestTargets.every(isHarvestTargetFact))) &&
    (value.seedTargets === undefined ||
      (Array.isArray(value.seedTargets) &&
        value.seedTargets.length <= 64 &&
        value.seedTargets.every(isSeedTargetFact))) &&
    (value.fertilizerTargets === undefined ||
      (Array.isArray(value.fertilizerTargets) &&
        value.fertilizerTargets.length <= 64 &&
        value.fertilizerTargets.every(isSeedTargetFact))) &&
    (value.woodFenceTargets === undefined ||
      (Array.isArray(value.woodFenceTargets) &&
        value.woodFenceTargets.length <= 16 &&
        value.woodFenceTargets.every(isWoodFenceTargetFact))) &&
    (value.woodFenceResultTargets === undefined ||
      (Array.isArray(value.woodFenceResultTargets) &&
        value.woodFenceResultTargets.length <= 1 &&
        value.woodFenceResultTargets.every(isWoodFenceResultTargetFact))) &&
    (value.crabPotTargets === undefined ||
      (Array.isArray(value.crabPotTargets) &&
        value.crabPotTargets.length <= 16 &&
        value.crabPotTargets.every(isCrabPotTargetFact))) &&
    (value.crabPotResultTargets === undefined ||
      (Array.isArray(value.crabPotResultTargets) &&
        value.crabPotResultTargets.length <= 1 &&
        value.crabPotResultTargets.every(isCrabPotResultTargetFact))) &&
    (value.crabPotCollectTargets === undefined ||
      (Array.isArray(value.crabPotCollectTargets) &&
        value.crabPotCollectTargets.length <= 16 &&
        value.crabPotCollectTargets.every(isCrabPotCollectTargetFact))) &&
    (value.baitCrabPotTargets === undefined ||
      (Array.isArray(value.baitCrabPotTargets) &&
        value.baitCrabPotTargets.length <= 16 &&
        value.baitCrabPotTargets.every(isBaitCrabPotTargetFact))) &&
    (value.baitCrabPotResultTargets === undefined ||
      (Array.isArray(value.baitCrabPotResultTargets) &&
        value.baitCrabPotResultTargets.length <= 1 &&
        value.baitCrabPotResultTargets.every(isBaitCrabPotTargetFact))) &&
    (value.debrisTargets === undefined ||
      (Array.isArray(value.debrisTargets) &&
        value.debrisTargets.length <= 64 &&
        value.debrisTargets.every(isDebrisTargetFact))) &&
    (value.rockSourceTargets === undefined ||
      (Array.isArray(value.rockSourceTargets) &&
        value.rockSourceTargets.length <= 8 &&
        value.rockSourceTargets.every(isRockSourceTargetFact))) &&
    (value.clearHoeDirtTargets === undefined ||
      (Array.isArray(value.clearHoeDirtTargets) &&
        value.clearHoeDirtTargets.length <= 8 &&
        value.clearHoeDirtTargets.every(isClearHoeDirtTargetFact))) &&
    (value.artifactSpotTargets === undefined ||
      (Array.isArray(value.artifactSpotTargets) &&
        value.artifactSpotTargets.length <= 8 &&
        value.artifactSpotTargets.every(isArtifactSpotTargetFact))) &&
    (value.artifactSpotResultTargets === undefined ||
      (Array.isArray(value.artifactSpotResultTargets) &&
        value.artifactSpotResultTargets.length <= 1 &&
        value.artifactSpotResultTargets.every(isArtifactSpotResultTargetFact))) &&
    (value.artifactSpotFarmSourceCount === undefined ||
      value.artifactSpotFarmSourceCount === null ||
      (typeof value.artifactSpotFarmSourceCount === "number" &&
        Number.isSafeInteger(value.artifactSpotFarmSourceCount) &&
        value.artifactSpotFarmSourceCount >= 0)) &&
    (value.machineTargets === undefined ||
      (Array.isArray(value.machineTargets) &&
        value.machineTargets.length <= 64 &&
        value.machineTargets.every(isMachineTargetFact))) &&
    (value.treeChopSourceTargets === undefined ||
      (Array.isArray(value.treeChopSourceTargets) &&
        value.treeChopSourceTargets.length <= 64 &&
        value.treeChopSourceTargets.every(isTreeChopSourceTargetFact))) &&
    (value.treeChopResultTargets === undefined ||
      (Array.isArray(value.treeChopResultTargets) &&
        value.treeChopResultTargets.length <= 64 &&
        value.treeChopResultTargets.every(isTreeChopResultTargetFact))) &&
    (value.treeStumpTargets === undefined ||
      (Array.isArray(value.treeStumpTargets) &&
        value.treeStumpTargets.length <= 16 &&
        value.treeStumpTargets.every(isTreeStumpTargetFact))) &&
    (value.treeSaplingTargets === undefined ||
      (Array.isArray(value.treeSaplingTargets) &&
        value.treeSaplingTargets.length <= 64 &&
        value.treeSaplingTargets.every(isTreeSaplingTargetFact))) &&
    (value.weedTargets === undefined ||
      (Array.isArray(value.weedTargets) &&
        value.weedTargets.length <= 16 &&
        value.weedTargets.every(isWeedTargetFact))) &&
    (value.scytheCropTargets === undefined ||
      (Array.isArray(value.scytheCropTargets) &&
        value.scytheCropTargets.length <= 16 &&
        value.scytheCropTargets.every(isScytheCropTargetFact))) &&
    (value.npcRelationshipTargets === undefined ||
      (Array.isArray(value.npcRelationshipTargets) &&
        value.npcRelationshipTargets.length <= 64 &&
        value.npcRelationshipTargets.every(isNpcRelationshipTargetFact))) &&
    (value.villagerWhereabouts === undefined ||
      (Array.isArray(value.villagerWhereabouts) &&
        value.villagerWhereabouts.length <= 64 &&
        value.villagerWhereabouts.every(isVillagerWhereaboutsFact))) &&
    (value.petTargets === undefined ||
      (Array.isArray(value.petTargets) && value.petTargets.length <= 16 && value.petTargets.every(isPetTargetFact))) &&
    (value.animalProductTargets === undefined ||
      (Array.isArray(value.animalProductTargets) &&
        value.animalProductTargets.length <= 32 &&
        value.animalProductTargets.every(isAnimalProductTargetFact))) &&
    (value.feedTroughTargets === undefined ||
      (Array.isArray(value.feedTroughTargets) &&
        value.feedTroughTargets.length <= 32 &&
        value.feedTroughTargets.every(isFeedTroughTargetFact))) &&
    (value.chestStoreTargets === undefined ||
      (Array.isArray(value.chestStoreTargets) &&
        value.chestStoreTargets.length <= 16 &&
        value.chestStoreTargets.every(isChestStoreTargetFact))) &&
    (value.chestRetrieveTargets === undefined ||
      (Array.isArray(value.chestRetrieveTargets) &&
        value.chestRetrieveTargets.length <= 16 &&
        value.chestRetrieveTargets.every(isChestRetrieveTargetFact))) &&
    (value.inventoryItemFacts === undefined ||
      (Array.isArray(value.inventoryItemFacts) &&
        value.inventoryItemFacts.length <= 36 &&
        value.inventoryItemFacts.every(isInventoryItemFact))) &&
    (value.foodTargets === undefined ||
      (Array.isArray(value.foodTargets) &&
        value.foodTargets.length <= 36 &&
        value.foodTargets.every(isFoodTargetFact))) &&
    (value.shippingBinTargets === undefined ||
      (Array.isArray(value.shippingBinTargets) &&
        value.shippingBinTargets.length <= 1 &&
        value.shippingBinTargets.every(isShippingBinTargetFact))) &&
    (value.craftingRecipeTargets === undefined ||
      (Array.isArray(value.craftingRecipeTargets) &&
        value.craftingRecipeTargets.length <= 64 &&
        value.craftingRecipeTargets.every(isRecipeTargetFact))) &&
    (value.cookingRecipeTargets === undefined ||
      (Array.isArray(value.cookingRecipeTargets) &&
        value.cookingRecipeTargets.length <= 64 &&
        value.cookingRecipeTargets.every(isRecipeTargetFact))) &&
    (value.cookingStationTargets === undefined ||
      (Array.isArray(value.cookingStationTargets) &&
        value.cookingStationTargets.length <= 16 &&
        value.cookingStationTargets.every(isCookingStationTargetFact))) &&
    (value.minecartTargets === undefined ||
      (Array.isArray(value.minecartTargets) &&
        value.minecartTargets.length <= 24 &&
        value.minecartTargets.every(isMinecartTargetFact))) &&
    isStringArray(value.capabilities) &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    isUniqueOpaqueIdArray(value.enabledActionIds) &&
    (value.activeExecution === undefined ||
      value.activeExecution === null ||
      (isRecord(value.activeExecution) && validateActiveExecution(value.activeExecution) === null))
    ? null
    : "invalid_snapshot";
}

function validateExecutionRequestEnvelope(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["requestId", "idempotencyKey", "action", "args", "expectedRevision", "deadlineMs"]) &&
    isOpaqueId(value.requestId) &&
    isOpaqueId(value.idempotencyKey) &&
    (value.action === "move_to_tile" ||
      value.action === "navigate_to_destination" ||
      value.action === "equip_tool" ||
      value.action === "travel" ||
      value.action === "ride_minecart" ||
      value.action === "enter_exit" ||
      value.action === "till_soil" ||
      value.action === "pickup_forage" ||
      value.action === "pickup_item" ||
      value.action === "water_crop" ||
      value.action === "water_pet_bowl" ||
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
      value.action === "scythe_crop" ||
      value.action === "interact_npc_with_item" ||
      value.action === "craft_item" ||
      value.action === "cook_recipe" ||
      value.action === "collect_crab_pot_output" ||
      value.action === "ship_item" ||
      value.action === "advance_day") &&
    isRecord(value.args) &&
    Object.keys(value.args).length <= 8 &&
    Number.isSafeInteger(value.expectedRevision) &&
    typeof value.deadlineMs === "number" &&
    Number.isFinite(value.deadlineMs)
    ? null
    : "invalid_execution_request";
}

function validateReceipt(value: Record<string, unknown>): string | null {
  const allowedKeys = ["executionId", "requestId", "actionId", "state", "reasonCode", "revision", "evidence"];
  if ("observation" in value) allowedKeys.push("observation");
  if ("piggybackedScene" in value) allowedKeys.push("piggybackedScene");
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
    (!("observation" in value) || value.observation === null || validateLocalObservation(value.observation) === null) &&
    (!("piggybackedScene" in value) || value.piggybackedScene === null || validateObserveSceneResult(value.piggybackedScene as Record<string, unknown>) === null)
    ? null
    : "invalid_receipt";
}

export function validateLocalObservation(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["location", "tileX", "tileY", "facing", "inGameTime", "playerNearby", "revision"])) {
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
  if (!hasExactKeys(value, ["programId", "nodes"]) || !isOpaqueId(value.programId) || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > MAX_BODY_PROGRAM_NODES)
    return "invalid_body_program_request";
  return value.nodes.every(isBodyProgramNode) ? null : "invalid_body_program_request";
}

function isBodyProgramNode(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["nodeId", "actionId", "arguments", "dependsOn", "bindings"]) ||
    !isOpaqueId(value.nodeId) || !isOpaqueId(value.actionId) || !isRecord(value.arguments) || !hasUniqueKeys(value.arguments) ||
    !Array.isArray(value.dependsOn) || value.dependsOn.length > 8 || !value.dependsOn.every(isOpaqueId) ||
    !isRecord(value.bindings) || !hasUniqueKeys(value.bindings) || Object.keys(value.bindings).length > MAX_BODY_PROGRAM_BINDINGS_PER_NODE)
    return false;
  return Object.entries(value.arguments).every(([name, argument]) => isOpaqueId(name) && isBodyProgramRuntimeValue(argument)) &&
    Object.entries(value.bindings).every(([name, binding]) => isOpaqueId(name) && isBodyProgramFactReference(binding));
}
function isBodyProgramRuntimeValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "destination_selector")
    return hasExactKeys(value, ["type", "destination"]) && isBodyProgramDestinationSelector(value.destination);
  return (value.type === "integer" || value.type === "string" || value.type === "boolean") &&
    hasExactKeys(value, ["type", "canonicalValue"]) &&
    typeof value.canonicalValue === "string" && value.canonicalValue.length <= 512;
}
/** Mirrors the C# IsValidBodyProgramSelector: scalar labels are trimmed, run ids are canonical 26-char navigation refs. */
function isBodyProgramDestinationSelector(value: unknown): value is BodyProgramDestinationSelector {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "label")
    return hasExactKeys(value, ["kind", "label"]) && isBodyProgramSelectorLabel(value.label);
  if (value.kind === "ref")
    return hasExactKeys(value, ["kind", "ref"]) &&
      typeof value.ref === "string" && /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/.test(value.ref);
  return false;
}
function isBodyProgramSelectorLabel(value: unknown): value is string {
  // Mirrors the C# ReadPlayerText FormC gate: only already-canonicalized NFC labels are exchangeable.
  return typeof value === "string" && value.length >= 1 && value.length <= 128 &&
    value === value.trim() && value.trim().length > 0 && value.normalize("NFC") === value;
}
function isBodyProgramFactReference(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["nodeId", "factName"]) && isOpaqueId(value.nodeId) && isOpaqueId(value.factName);
}
export function validateBodyProgramVerificationResult(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["accepted", "catalogRevision", "diagnostics"]) &&
    typeof value.accepted === "boolean" &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    Array.isArray(value.diagnostics) && value.diagnostics.length <= 64 && value.diagnostics.every(isBodyProgramDiagnostic)
    ? null : "invalid_body_program_result";
}
export function validateBodyProgramSubmitResult(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["code", "verification", "snapshot"]) ||
    !isBodyProgramSubmitCode(value.code) ||
    validateBodyProgramVerificationResult(value.verification as Record<string, unknown>) !== null)
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
  if (!hasExactKeys(value, ["code", "snapshot"]) || !isBodyProgramQueryCode(value.code)) return "invalid_body_program_result";
  return value.code === "found"
    ? (isBodyProgramStatusSnapshot(value.snapshot) ? null : "invalid_body_program_result")
    : (value.snapshot === null ? null : "invalid_body_program_result");
}
export function validateBodyProgramEventsResult(value: Record<string, unknown>): string | null {
  if (!hasExactKeys(value, ["programId", "code", "events", "nextCursor", "highWater"]) ||
    !isOpaqueId(value.programId) || !isBodyProgramQueryCode(value.code) ||
    !Array.isArray(value.events) || value.events.length > 32 ||
    !isNonNegativeSafeInteger(value.nextCursor) || !isNonNegativeSafeInteger(value.highWater) ||
    (value.code !== "found" && value.events.length !== 0))
    return "invalid_body_program_result";
  return value.events.every(isBodyProgramEvent) &&
    value.events.every((event) => event.programId === value.programId && event.cursor <= (value.highWater as number)) &&
    (value.events.length === 0 || hasExactPageContinuation(value.events as unknown[], value.nextCursor as number))
    ? null : "invalid_body_program_result";
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
  return isRecord(value) && hasExactKeys(value, ["cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt"]) &&
    isNonNegativeSafeInteger(value.cursor) && isOpaqueId(value.programId) && isReasonCode(value.kind) &&
    isNonNegativeSafeInteger(value.catalogRevision) &&
    (value.nodeId === null || isOpaqueId(value.nodeId)) &&
    (value.nodeAttempt === null || isNonNegativeInt32(value.nodeAttempt));
}
function isBodyProgramSubmitCode(value: unknown): boolean {
  return value === "accepted" || value === "rejected" || value === "idempotent" || value === "conflict" ||
    value === "persistence_failure" || value === "quarantined";
}
function isBodyProgramQueryCode(value: unknown): boolean {
  return value === "found" || value === "not_found" || value === "invalid_input";
}
function isBodyProgramDiagnostic(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["severity", "code", "nodeId", "path", "message"]) &&
    value.severity === "error" && isReasonCode(value.code) &&
    (value.nodeId === null || isOpaqueId(value.nodeId)) &&
    typeof value.path === "string" && typeof value.message === "string";
}
function isBodyProgramStatusSnapshot(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["programId", "state", "catalogRevision", "stopEpoch", "eventHighWater", "nodes"]) &&
    isOpaqueId(value.programId) && isBodyProgramState(value.state) &&
    isNonNegativeSafeInteger(value.catalogRevision) && isNonNegativeSafeInteger(value.stopEpoch) &&
    isNonNegativeSafeInteger(value.eventHighWater) && Array.isArray(value.nodes) && value.nodes.length <= MAX_BODY_PROGRAM_NODES &&
    value.nodes.every(isBodyProgramNodeStatus);
}
function isBodyProgramNodeStatus(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["nodeId", "state", "nodeAttempt", "admissionAttempt"]) &&
    isOpaqueId(value.nodeId) && isBodyProgramNodeState(value.state) &&
    isNonNegativeInt32(value.nodeAttempt) && isNonNegativeInt32(value.admissionAttempt);
}
function isBodyProgramState(value: unknown): boolean {
  return value === "active" || value === "succeeded" || value === "failed" || value === "cancelled" ||
    value === "recovery_required" || value === "quarantined";
}
function isBodyProgramNodeState(value: unknown): boolean {
  return value === "pending" || value === "awaiting_host_admission" || value === "host_admitted" || value === "running" ||
    value === "succeeded" || value === "failed" || value === "cancelled" || value === "recovery_required" || value === "rejected";
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

function isToolSlotFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "label"]) &&
    isToolSlot(value.slot) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 128
  );
}

function isForageTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "qualifiedItemId", "stack","displayName"]) &&
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

function isItemTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "qualifiedItemId", "stack","displayName"]) &&
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

function isWateringCanFact(value: unknown): boolean {
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
function isRefillWateringCanTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

function isPetBowlTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

function isSlimeHutchTroughTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y"]) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y)
  );
}

function isCropTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "cropId","displayName"]) &&
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

function isHarvestTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "cropId", "qualifiedHarvestItemId", "displayName", "regrowsAfterHarvest"]) &&
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

function isWoodFenceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "slot", "x", "y", "qualifiedItemId","displayName"]) &&
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

function isWoodFenceResultTargetFact(value: unknown): boolean {
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
      "maxHealth","displayName"]) &&
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

function isCrabPotTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "slot", "x", "y", "qualifiedItemId","displayName"]) &&
    isCrabPotCore(value) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= 128
  );
}
function isCrabPotCollectTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "targetId",
      "location",
      "x",
      "y",
      "qualifiedItemId",
      "outputQualifiedItemId",
      "outputStack","displayName"]) &&
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

function isCrabPotResultTargetFact(value: unknown): boolean {
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
      "overlayTiles","displayName"]) &&
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
function isBaitCrabPotTargetFact(value: unknown): boolean {
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
      "baitStack","displayName"]) &&
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
function isSeedTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "slot", "x", "y", "qualifiedItemId","displayName"]) &&
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

function isDebrisTargetFact(value: unknown): boolean {
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

function isArtifactSpotTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["targetId", "location", "x", "y", "qualifiedItemId","displayName"]) &&
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

function isClearHoeDirtTargetFact(value: unknown): boolean {
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

function isArtifactSpotResultTargetFact(value: unknown): boolean {
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

function isRockSourceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "qualifiedItemId", "health","displayName"]) &&
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

function isMachineTargetFact(value: unknown): boolean {
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
      "collectOutputReady","displayName"]) &&
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

function isTreeChopSourceTargetFact(value: unknown): boolean {
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

function isTreeChopResultTargetFact(value: unknown): boolean {
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

function isTreeStumpTargetFact(value: unknown): boolean {
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

function isTreeSaplingTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "slot", "x", "y", "qualifiedItemId","displayName"]) &&
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

function isWeedTargetFact(value: unknown): boolean {
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

function isScytheCropTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "location", "x", "y", "cropId", "qualifiedHarvestItemId","displayName"]) &&
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


function isNpcRelationshipTargetFact(value: unknown): boolean {
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

function isVillagerWhereaboutsFact(value: unknown): boolean {
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

function isPetTargetFact(value: unknown): boolean {
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

function isAnimalProductTargetFact(value: unknown): boolean {
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
      "produceStack","displayName"]) &&
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

function isFeedTroughTargetFact(value: unknown): boolean {
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

function isChestStoreTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "slot", "qualifiedItemId", "stack","displayName"]) &&
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

function isChestRetrieveTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "qualifiedItemId", "stack","displayName"]) &&
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

function isShippingBinTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["targetId", "x", "y", "slot", "qualifiedItemId", "stack","displayName"]) &&
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

function isRecipeTargetFact(value: unknown): boolean {
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

function isCookingStationTargetFact(value: unknown): boolean {
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

function isMinecartTargetFact(value: unknown): boolean {
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

function isInventoryItemFact(value: unknown): boolean {  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "qualifiedItemId", "stack","displayName"]) &&
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

function isFoodTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["slot", "qualifiedItemId", "stack", "edibility", "isDrink","displayName"]) &&
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

function isWarp(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["sourceX", "sourceY", "targetLocation", "targetX", "targetY"]))
    return false;
  return (
    isTileCoordinate(value.sourceX) &&
    isTileCoordinate(value.sourceY) &&
    typeof value.targetLocation === "string" &&
    value.targetLocation.length > 0 &&
    value.targetLocation.length <= 256 &&
    isTileCoordinate(value.targetX) &&
    isTileCoordinate(value.targetY)
  );
}

function validateActiveExecution(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["executionId", "requestId", "action", "state", "reasonCode", "evidence"]) &&
    isOpaqueId(value.executionId) &&
    isOpaqueId(value.requestId) &&
    typeof value.action === "string" &&
    value.action.length <= 128 &&
    typeof value.state === "string" &&
    EXECUTION_STATES.includes(value.state as ExecutionState) &&
    isReasonCode(value.reasonCode) &&
    (value.evidence === null || isRecord(value.evidence))
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}
function hasExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}
function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
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
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 128);
}

/** `ride_minecart` args are exactly {x, y, expectedTargetId} with an opaque `minecart_` selector. */
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
        if (!Array.isArray(arg.boundedEnumValues) || arg.boundedEnumValues.length === 0 || arg.boundedEnumValues.length > 128) return false;
        if (!arg.boundedEnumValues.every((item) => typeof item === "string" && item.length > 0 && item.length <= 64)) return false;
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
    if (!isRecord(value.sceneTarget) || !hasExactKeys(value.sceneTarget, ["type", "version", "required", "requiredProperties"]) ||
        typeof value.sceneTarget.type !== "string" || value.sceneTarget.type.length === 0 || value.sceneTarget.type.length > 64 ||
        typeof value.sceneTarget.version !== "number" || !Number.isSafeInteger(value.sceneTarget.version) || value.sceneTarget.version < 1 ||
        typeof value.sceneTarget.required !== "boolean" || !Array.isArray(value.sceneTarget.requiredProperties) ||
        value.sceneTarget.requiredProperties.length > 16 ||
        !value.sceneTarget.requiredProperties.every((property) => typeof property === "string" && /^[a-z][a-zA-Z0-9_]{0,63}$/.test(property)))
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
    if (typeof value.nativeBinding !== "string" || value.nativeBinding.length === 0 || value.nativeBinding.length > 128) return false;
  }

  if ("canonicalCodec" in value && value.canonicalCodec !== undefined) {
    if (typeof value.canonicalCodec !== "string" || value.canonicalCodec.length === 0 || value.canonicalCodec.length > 128) return false;
  }

  if ("postcondition" in value && value.postcondition !== undefined) {
    if (typeof value.postcondition === "string") {
      if (value.postcondition.length === 0 || value.postcondition.length > 128) return false;
    } else if (isRecord(value.postcondition)) {
      if (typeof value.postcondition.name !== "string" || value.postcondition.name.length === 0 || value.postcondition.name.length > 128) return false;
    } else {
      return false;
    }
  }

  return true;
}

function isValidActionRegistrations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return false;
    const allowedKeys = "descriptor" in item
      ? ["actionId", "familyId", "identityVersion", "lifecycle", "kind", "descriptor"]
      : ["actionId", "familyId", "identityVersion", "lifecycle", "kind"];
    if (!hasExactKeys(item, allowedKeys)) return false;
    if (!isOpaqueId(item.actionId) || !isOpaqueId(item.familyId)) return false;
    if (typeof item.identityVersion !== "number" || !Number.isSafeInteger(item.identityVersion) || item.identityVersion < 1) return false;
    if (item.lifecycle !== "published" && item.lifecycle !== "live_verified" && item.lifecycle !== "experimental") return false;
    if (item.kind !== "execution" && item.kind !== "read_only") return false;
    if ("descriptor" in item && (item.descriptor === undefined || !isValidActionDescriptor(item.descriptor))) return false;
    if (seen.has(item.actionId)) return false;
    seen.add(item.actionId);
  }
  return true;
}
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** C# attempt counters are Int32 wire fields; the Host must not admit Int64-backed counters it cannot exchange. */
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
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isTileCoordinate(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 1000;
}
function isToolSlot(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 36;
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
