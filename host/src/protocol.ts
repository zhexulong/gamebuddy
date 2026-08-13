import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_EVENTS_PER_WINDOW = 32;
export const EVENT_WINDOW_MS = 1_000;

export type Scope = Readonly<{
  integrationId: string;
  saveId: string;
  worldId: string;
  playerId: string;
  companionId: string;
}>;

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

export type ActiveExecution = Readonly<{
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
  /** Older Mod snapshots may omit fields added after the initial bridge contract. */
  currentTool?: string | null;
  inventorySlots?: number;
  activeExecution?: ActiveExecution | null;
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
    stack: number;
  }>[];
  /** Nearby native item drops available through Debris.collect. */
  itemTargets?: readonly Readonly<{ targetId: string; x: number; y: number; qualifiedItemId: string; stack: number }>[];
  /** Exact live Watering Can facts for a bounded refill request. */
  wateringCanFacts?: readonly Readonly<{
    slot: number;
    qualifiedItemId: string;
    label: string;
    water: number;
    max: number;
  }>[];
  /** Adjacent legal native Watering Can refill sources. */
  refillWateringCanTargets?: readonly Readonly<{ targetId: string; x: number; y: number }>[];
  /** Nearby unwatered crops available through the native WateringCan path. */
  cropTargets?: readonly Readonly<{ targetId: string; x: number; y: number; cropId: string }>[];
  /** Nearby ready, ordinary Grab crops available through native Crop.harvest. */
  harvestTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    cropId: string;
    qualifiedHarvestItemId: string;
    regrowsAfterHarvest: boolean;
  }>[];
  /** Nearby empty HoeDirt targets paired with a live inventory seed slot. */
  seedTargets?: readonly Readonly<{ targetId: string; slot: number; x: number; y: number; qualifiedItemId: string }>[];
  /** Nearby ground HoeDirt targets paired with a live fertilizer slot. */
  fertilizerTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: string;
  }>[];
  /** Fresh empty Farm tiles paired with one qualified (O)322 inventory slot. */
  woodFenceTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)322";
  }>[];
  /** Same-location native non-gate Fence result published only after placement. */
  woodFenceResultTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)322";
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
  }>[];
  /** Same-location native Crab Pot result published only after placement. */
  crabPotResultTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)710";
    ownerId: number;
    offsetX: number;
    offsetY: number;
    overlayTiles: readonly { x: number; y: number; count: number }[];
  }>[];
  /** Current-player-owned unbaited (O)710 Crab Pots paired with one owned (O)685 Bait source. */
  baitCrabPotTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    slot: number;
    x: number;
    y: number;
    qualifiedItemId: "(O)710";
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
  /** Nearby native machines; an idle Keg may expose the one exact Coffee Bean input slot accepted by machine_load, and a ready Coffee result may expose collection eligibility. */
  machineTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    qualifiedItemId: string;
    readyForHarvest: boolean;
    minutesUntilReady: number;
    heldObjectQualifiedItemId?: string | null;
    lastInputQualifiedItemId?: string | null;
    loadInputSlot?: number | null;
    loadInputQualifiedItemId?: "(O)433" | null;
    loadInputStack?: 5 | null;
    collectOutputReady?: boolean | null;
  }>[];
  /** Nearby ordinary tree sources observed for read-only native shake discovery. */
  treeShakeSourceTargets?: readonly Readonly<{
    targetId: string;
    location: string;
    x: number;
    y: number;
    treeType: string;
    growthStage: number;
    health: number;
    moss: boolean;
    tapped: boolean;
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
  /** Nearby native pets that have not been petted today. */
  petTargets?: readonly Readonly<{
    targetId: string;
    x: number;
    y: number;
    petType: string;
    friendship: number;
    pettedToday: boolean;
  }>[];
  /** Nearby adult farm animals with a specific native MilkPail/Shears target and capacity for their current produce. */
  animalProductTargets?: readonly Readonly<{
    targetId: string;
    slot: number;
    x: number;
    y: number;
    animalType: string;
    qualifiedProduceItemId: string;
    toolKind: "milk_pail" | "shears";
    produceStack: number;
  }>[];
  /** Nearby empty native AnimalHouse Trough tiles paired with an owned Hay slot. Placement does not prove an animal has eaten. */
  feedTroughTargets?: readonly Readonly<{ targetId: string; slot: number; x: number; y: number; hayStack: number }>[];
  /** Bounded live inventory facts, currently published only for animal-product output rereads. */
  inventoryItemFacts?: readonly Readonly<{ slot: number; qualifiedItemId: string; stack: number }>[];
  /** Owned, ordinary edible inventory items available through the native eat path. */
  foodTargets?: readonly Readonly<{
    slot: number;
    qualifiedItemId: string;
    stack: number;
    edibility: number;
    isDrink: boolean;
  }>[];
}>;

/** Mod-local player policy is summarized as live capabilities, not bearer tokens. */
export type ExecutionRequest = Readonly<{
  requestId: string;
  idempotencyKey: string;
  action:
    | "move_to_tile"
    | "equip_tool"
    | "travel"
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
    | "tree_first_hit"
    | "chop_tree_source"
    | "break_rock_source"
    | "clear_hoedirt"
    | "dig_artifact_spot"
    | "inspect_self";
  args: Readonly<Record<string, unknown>>;
  expectedRevision: number;
  deadlineMs: number;
}>;

export type ExecutionReceipt = Readonly<{
  executionId: string;
  requestId: string;
  state: ExecutionState;
  reasonCode: string;
  revision: number;
  evidence: Readonly<Record<string, unknown>> | null;
}>;

export type BodyTrace = Readonly<{
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

export type SemanticEvent = Readonly<{
  kind:
    | "snapshot_changed"
    | "execution_state"
    | "connection_state"
    | "lifecycle"
    | BodyTrace["category"];
  revision: number;
  activeExecution: ActiveExecution | null;
  reasonCode: string;
  bodyTrace?: BodyTrace;
}>;

export type BridgeMessage =
  | Envelope<"hello", Readonly<{ token: string }>>
  | Envelope<"hello_ack", Readonly<{ sessionId: string; capabilities: readonly string[] }>>
  | Envelope<"observe_request", Readonly<Record<string, never>>>
  | Envelope<"snapshot", Snapshot>
  | Envelope<"execution_request", ExecutionRequest>
  | Envelope<"cancel_request", Readonly<{ requestId: string; executionId: string; reasonCode: string }>>
  | Envelope<"execution_receipt", ExecutionReceipt>
  | Envelope<"error", Readonly<{ reasonCode: string }>>
  | Envelope<"semantic_event", SemanticEvent>
  | Envelope<"lifecycle", Readonly<{ state: "connected" | "disconnected" | "world_unavailable"; reasonCode: string }>>;

export const BRIDGE_MESSAGE_TYPES = [
  "hello",
  "hello_ack",
  "observe_request",
  "snapshot",
  "execution_request",
  "cancel_request",
  "execution_receipt",
  "error",
  "semantic_event",
  "lifecycle",
] as const;

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

export function validateScope(expected: Scope, actual: Scope): string | null {
  for (const key of Object.keys(expected) as (keyof Scope)[]) {
    if (expected[key] !== actual[key]) return `scope_mismatch:${key}`;
  }
  return null;
}

export function validateEnvelope(value: unknown, expectedScope: Scope, nowMs = Date.now()): string | null {
  if (!isRecord(value)) return "invalid_envelope";
  if (value.protocolVersion !== PROTOCOL_VERSION) return "unsupported_protocol_version";
  if (typeof value.messageId !== "string" || !isOpaqueId(value.messageId)) return "invalid_message_id";
  if (typeof value.correlationId !== "string" || !isOpaqueId(value.correlationId)) return "invalid_correlation_id";
  if (
    typeof value.timestampMs !== "number" ||
    !Number.isFinite(value.timestampMs) ||
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
  switch (message.type) {
    case "hello":
      return validToken(payload.token) ? null : "invalid_hello_token";
    case "hello_ack":
      return isOpaqueId(payload.sessionId) && isStringArray(payload.capabilities) ? null : "invalid_hello_ack";
    case "observe_request":
      return Object.keys(payload).length === 0 ? null : "invalid_observe_request";
    case "snapshot":
      return validateSnapshot(payload);
    case "execution_request":
      return validateExecutionRequestEnvelope(payload);
    case "cancel_request":
      return isOpaqueId(payload.requestId) && isOpaqueId(payload.executionId) && isReasonCode(payload.reasonCode)
        ? null
        : "invalid_cancel_request";
    case "execution_receipt":
      return validateReceipt(payload);
    case "error":
      return isReasonCode(payload.reasonCode) ? null : "invalid_error";
    case "semantic_event":
      return validateSemanticEvent(payload);
    case "lifecycle":
      return (payload.state === "connected" ||
        payload.state === "disconnected" ||
        payload.state === "world_unavailable") &&
        isReasonCode(payload.reasonCode)
        ? null
        : "invalid_lifecycle";
  }
}

export function validateExecutionRequest(value: unknown, snapshot: Snapshot, nowMs = Date.now()): string | null {
  if (!isRecord(value)) return "invalid_request";
  if (!isOpaqueId(value.requestId) || !isOpaqueId(value.idempotencyKey)) return "invalid_request_id";
  if (
    value.action !== "move_to_tile" &&
    value.action !== "equip_tool" &&
    value.action !== "travel" &&
    value.action !== "enter_exit" &&
    value.action !== "till_soil" &&
    value.action !== "pickup_forage" &&
    value.action !== "pickup_item" &&
    value.action !== "water_crop" &&
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
    value.action !== "tree_first_hit" &&
    value.action !== "chop_tree_source" &&
    value.action !== "break_rock_source" &&
    value.action !== "clear_hoedirt" &&
    value.action !== "dig_artifact_spot" &&
    value.action !== "inspect_self"
  )
    return "unknown_action";
  if (!isRecord(value.args)) return "invalid_args";
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== snapshot.revision)
    return "stale_snapshot";
  if (
    typeof value.deadlineMs !== "number" ||
    !Number.isFinite(value.deadlineMs) ||
    value.deadlineMs < nowMs ||
    value.deadlineMs > nowMs + 60_000
  )
    return "invalid_deadline";
  if (!snapshot.actionable && value.action !== "inspect_self") return "player_not_actionable";
  if (!snapshot.capabilities.includes(value.action)) return "capability_not_declared";
  if (value.action === "move_to_tile") {
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_target_tile";
  } else if (value.action === "equip_tool") {
    if (!isToolSlot(value.args.slot)) return "invalid_tool_slot";
  } else if (value.action === "travel") {
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_warp_source";
  } else if (value.action === "enter_exit") {
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_door_target";
  } else if (value.action === "till_soil") {
    if (!isTileCoordinate(value.args.x) || !isTileCoordinate(value.args.y)) return "invalid_soil_target";
  } else if (value.action === "pickup_forage") {
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128 ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_forage_target";
  } else if (value.action === "pickup_item") {
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
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_crop_target";
  } else if (value.action === "harvest_crop") {
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
    if (
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
    if (
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
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_debris_target";
  } else if (value.action === "machine_inspect") {
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_machine_target";
  } else if (value.action === "machine_load") {
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
    if (
      !hasOnlyKeys(value.args, ["x", "y", "expectedTargetId"]) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_machine_collect_target";
  } else if (value.action === "npc_relationship") {
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_npc_relationship_target";
  } else if (value.action === "pet_animal") {
    if (
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_pet_target";
  } else if (value.action === "collect_animal_product") {
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_animal_product_target";
  } else if (value.action === "feed_animal") {
    if (
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_feed_trough_target";
  } else if (value.action === "break_rock_source") {
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
    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_clear_hoedirt_target";
  } else if (value.action === "tree_first_hit") {
    if (
      !hasOnlyKeys(value.args, ["slot", "x", "y", "expectedTargetId"]) ||
      !isToolSlot(value.args.slot) ||
      !isTileCoordinate(value.args.x) ||
      !isTileCoordinate(value.args.y) ||
      typeof value.args.expectedTargetId !== "string" ||
      !isOpaqueId(value.args.expectedTargetId)
    )
      return "invalid_tree_first_hit_target";
  } else if (value.action === "chop_tree_source") {
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
    if (
      !isToolSlot(value.args.slot) ||
      typeof value.args.expectedQualifiedItemId !== "string" ||
      value.args.expectedQualifiedItemId.length === 0 ||
      value.args.expectedQualifiedItemId.length > 128
    )
      return "invalid_item_use_target";
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
  return json;
}

function diagnoseSnapshot(value: Record<string, unknown>): string {
  if (!Number.isSafeInteger(value.revision)) return "invalid_snapshot:revision";
  if (typeof value.location !== "string") return "invalid_snapshot:location";
  if (!isRecord(value.tile) || !isFiniteNumber(value.tile.x) || !isFiniteNumber(value.tile.y))
    return "invalid_snapshot:tile";
  if (!isFiniteNumber(value.stamina)) return "invalid_snapshot:stamina";
  if (!isFiniteNumber(value.health)) return "invalid_snapshot:health";
  if (typeof value.actionable !== "boolean") return "invalid_snapshot:actionable";
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
    value.treeShakeSourceTargets !== undefined &&
    (!Array.isArray(value.treeShakeSourceTargets) ||
      value.treeShakeSourceTargets.length > 64 ||
      !value.treeShakeSourceTargets.every(isTreeShakeSourceTargetFact))
  )
    return "invalid_snapshot:treeShakeSourceTargets";
  if (
    value.npcRelationshipTargets !== undefined &&
    (!Array.isArray(value.npcRelationshipTargets) ||
      value.npcRelationshipTargets.length > 64 ||
      !value.npcRelationshipTargets.every(isNpcRelationshipTargetFact))
  )
    return "invalid_snapshot:npcRelationshipTargets";
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
  if (!isStringArray(value.capabilities)) return "invalid_snapshot:capabilities";
  if (
    value.activeExecution !== undefined &&
    value.activeExecution !== null &&
    (!isRecord(value.activeExecution) || validateActiveExecution(value.activeExecution) !== null)
  )
    return "invalid_snapshot:activeExecution";
  return "accepted";
}

function validateSnapshot(value: Record<string, unknown>): string | null {
  return Number.isSafeInteger(value.revision) &&
    typeof value.location === "string" &&
    isRecord(value.tile) &&
    isFiniteNumber(value.tile.x) &&
    isFiniteNumber(value.tile.y) &&
    isFiniteNumber(value.stamina) &&
    isFiniteNumber(value.health) &&
    typeof value.actionable === "boolean" &&
    (value.currentTool === undefined || value.currentTool === null || typeof value.currentTool === "string") &&
    (value.inventorySlots === undefined || Number.isSafeInteger(value.inventorySlots)) &&
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
    (value.treeShakeSourceTargets === undefined ||
      (Array.isArray(value.treeShakeSourceTargets) &&
        value.treeShakeSourceTargets.length <= 64 &&
        value.treeShakeSourceTargets.every(isTreeShakeSourceTargetFact))) &&
    (value.npcRelationshipTargets === undefined ||
      (Array.isArray(value.npcRelationshipTargets) &&
        value.npcRelationshipTargets.length <= 64 &&
        value.npcRelationshipTargets.every(isNpcRelationshipTargetFact))) &&
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
    (value.inventoryItemFacts === undefined ||
      (Array.isArray(value.inventoryItemFacts) &&
        value.inventoryItemFacts.length <= 36 &&
        value.inventoryItemFacts.every(isInventoryItemFact))) &&
    (value.foodTargets === undefined ||
      (Array.isArray(value.foodTargets) &&
        value.foodTargets.length <= 36 &&
        value.foodTargets.every(isFoodTargetFact))) &&
    isStringArray(value.capabilities) &&
    (value.activeExecution === undefined ||
      value.activeExecution === null ||
      (isRecord(value.activeExecution) && validateActiveExecution(value.activeExecution) === null))
    ? null
    : "invalid_snapshot";
}

function validateExecutionRequestEnvelope(value: Record<string, unknown>): string | null {
  return isOpaqueId(value.requestId) &&
    isOpaqueId(value.idempotencyKey) &&
    (value.action === "move_to_tile" ||
      value.action === "equip_tool" ||
      value.action === "travel" ||
      value.action === "enter_exit" ||
      value.action === "till_soil" ||
      value.action === "pickup_forage" ||
      value.action === "pickup_item" ||
      value.action === "water_crop" ||
      value.action === "refill_watering_can" ||
      value.action === "harvest_crop" ||
      value.action === "plant_seed" ||
      value.action === "fertilize_tile" ||
      value.action === "place_wood_fence" ||
      value.action === "place_crab_pot" ||
      value.action === "clear_debris" ||
      value.action === "machine_inspect" ||
      value.action === "machine_load" ||
      value.action === "machine_collect_output" ||
      value.action === "npc_relationship" ||
      value.action === "pet_animal" ||
      value.action === "collect_animal_product" ||
      value.action === "feed_animal" ||
      value.action === "use_item" ||
      value.action === "tree_first_hit" ||
      value.action === "chop_tree_source" ||
      value.action === "break_rock_source" ||
      value.action === "clear_hoedirt" ||
      value.action === "dig_artifact_spot" ||
      value.action === "inspect_self") &&
    isRecord(value.args) &&
    Number.isSafeInteger(value.expectedRevision) &&
    typeof value.deadlineMs === "number" &&
    Number.isFinite(value.deadlineMs)
    ? null
    : "invalid_execution_request";
}

function validateReceipt(value: Record<string, unknown>): string | null {
  return isOpaqueId(value.executionId) &&
    isOpaqueId(value.requestId) &&
    typeof value.state === "string" &&
    EXECUTION_STATES.includes(value.state as ExecutionState) &&
    isReasonCode(value.reasonCode) &&
    Number.isSafeInteger(value.revision) &&
    (value.evidence === null || isRecord(value.evidence))
    ? null
    : "invalid_receipt";
}

function validateSemanticEvent(value: Record<string, unknown>): string | null {
  const bodyTraceKind = isBodyTraceCategory(value.kind);
  return (value.kind === "snapshot_changed" ||
    value.kind === "execution_state" ||
    value.kind === "connection_state" ||
    value.kind === "lifecycle" ||
    bodyTraceKind) &&
    Number.isSafeInteger(value.revision) &&
    isReasonCode(value.reasonCode) &&
    (value.activeExecution === null ||
      (isRecord(value.activeExecution) && validateActiveExecution(value.activeExecution) === null)) &&
    (bodyTraceKind
      ? isRecord(value.bodyTrace) && validateBodyTrace(value.bodyTrace) === null && value.bodyTrace.category === value.kind
      : value.bodyTrace === undefined)
    ? null
    : "invalid_semantic_event";
}

function isBodyTraceCategory(value: unknown): value is BodyTrace["category"] {
  return value === "execution_started" ||
    value === "route_progress" ||
    value === "execution_settled_succeeded" ||
    value === "execution_settled_cancelled" ||
    value === "execution_settled_failed" ||
    value === "execution_invalidated" ||
    value === "body_idle";
}

function validateBodyTrace(value: Record<string, unknown>): string | null {
  return isBodyTraceCategory(value.category) &&
    isOpaqueId(value.executionId) &&
    isOpaqueId(value.requestId) &&
    typeof value.tick === "number" &&
    Number.isSafeInteger(value.tick) &&
    value.tick >= 0 &&
    Number.isSafeInteger(value.revision) &&
    (value.location === undefined || (typeof value.location === "string" && value.location.length >= 1 && value.location.length <= 256)) &&
    (value.tile === undefined || (isRecord(value.tile) && isTileCoordinate(value.tile.x) && isTileCoordinate(value.tile.y)))
    ? null
    : "invalid_body_trace";
}

function isSoilTile(value: unknown): boolean {
  return isRecord(value) && isTileCoordinate(value.x) && isTileCoordinate(value.y);
}

function isToolSlotFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isToolSlot(value.slot) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 128
  );
}

function isForageTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    value.stack <= 999
  );
}

function isItemTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    value.stack <= 999
  );
}

function isWateringCanFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
  return isRecord(value) && isOpaqueId(value.targetId) && isTileCoordinate(value.x) && isTileCoordinate(value.y);
}

function isCropTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.cropId === "string" &&
    value.cropId.length > 0 &&
    value.cropId.length <= 128
  );
}

function isHarvestTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOpaqueId(value.targetId) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.cropId === "string" &&
    value.cropId.length > 0 &&
    value.cropId.length <= 128 &&
    typeof value.qualifiedHarvestItemId === "string" &&
    value.qualifiedHarvestItemId.length > 0 &&
    value.qualifiedHarvestItemId.length <= 128 &&
    typeof value.regrowsAfterHarvest === "boolean"
  );
}

function isWoodFenceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.qualifiedItemId === "(O)322"
  );
}

function isWoodFenceResultTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
    value.maxHealth >= value.health
  );
}

function isCrabPotTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
function isCrabPotResultTargetFact(value: unknown): boolean {
  return (
    isCrabPotTargetFact(value) &&
    isRecord(value) &&
    typeof value.ownerId === "number" &&
    Number.isSafeInteger(value.ownerId) &&
    isFiniteNumber(value.offsetX) &&
    isFiniteNumber(value.offsetY) &&
    Array.isArray(value.overlayTiles) &&
    value.overlayTiles.length <= 4 &&
    value.overlayTiles.every(
      (tile) =>
        isRecord(tile) &&
        isTileCoordinate(tile.x) &&
        isTileCoordinate(tile.y) &&
        typeof tile.count === "number" &&
        Number.isSafeInteger(tile.count) &&
        tile.count > 0,
    )
  );
}
function isBaitCrabPotTargetFact(value: unknown): boolean {
  return (
    isCrabPotTargetFact(value) &&
    isRecord(value) &&
    value.baitQualifiedItemId === "(O)685" &&
    typeof value.ownerId === "string" &&
    /^[0-9]{1,20}$/.test(value.ownerId) &&
    value.baitStack === 1
  );
}
function isSeedTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOpaqueId(value.targetId) &&
    isToolSlot(value.slot) &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128
  );
}

function isDebrisTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
    hasOnlyKeys(value, ["targetId", "location", "x", "y", "qualifiedItemId"]) &&
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 128 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.qualifiedItemId === "(O)590"
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
    isOpaqueId(value.targetId) &&
    typeof value.location === "string" &&
    value.location.length > 0 &&
    value.location.length <= 256 &&
    isTileCoordinate(value.x) &&
    isTileCoordinate(value.y) &&
    value.qualifiedItemId === "(O)2" &&
    typeof value.health === "number" &&
    Number.isSafeInteger(value.health) &&
    value.health === 1
  );
}

function isMachineTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
      (isToolSlot(value.loadInputSlot) && value.loadInputQualifiedItemId === "(O)433" && value.loadInputStack === 5))
  );
}

function isTreeChopSourceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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

function isTreeShakeSourceTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
    value.growthStage >= 0 &&
    value.growthStage <= 20 &&
    isFiniteNumber(value.health) &&
    value.health >= -100 &&
    value.health <= 100 &&
    typeof value.moss === "boolean" &&
    typeof value.tapped === "boolean"
  );
}

function isNpcRelationshipTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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

function isPetTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
    value.pettedToday === false
  );
}

function isAnimalProductTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
    (value.produceStack === 1 || value.produceStack === 2)
  );
}

function isFeedTroughTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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

function isInventoryItemFact(value: unknown): boolean {
  return (
    isRecord(value) &&
    isToolSlot(value.slot) &&
    typeof value.qualifiedItemId === "string" &&
    value.qualifiedItemId.length > 0 &&
    value.qualifiedItemId.length <= 128 &&
    typeof value.stack === "number" &&
    Number.isSafeInteger(value.stack) &&
    value.stack > 0 &&
    value.stack <= 999
  );
}

function isFoodTargetFact(value: unknown): boolean {
  return (
    isRecord(value) &&
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
    typeof value.isDrink === "boolean"
  );
}

function isWarp(value: unknown): boolean {
  if (!isRecord(value)) return false;
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
  return isOpaqueId(value.executionId) &&
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
function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
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
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isTileCoordinate(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 1000;
}
function isToolSlot(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0 && value <= 36;
}
