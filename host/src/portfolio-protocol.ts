import { createHash, randomUUID } from "node:crypto";

const PORTFOLIO_PROTOCOL_VERSION = 1;
export const PORTFOLIO_INTEGRATION_ID = "stardew_portfolio";
export const PORTFOLIO_TOPOLOGY = "single_player_native_companion";
export const PORTFOLIO_MAX_MESSAGE_BYTES = 16 * 1024;

/** Closed reason-code vocabulary for this versioned wire contract. */
const PORTFOLIO_REASON_CODES = [
  "accepted",
  "observed",
  "fresh_observed",
  "native_sleep_started",
  "saving",
  "saved",
  "day_started",
  "close_requested",
  "reopened",
  "terminal",
  "cancelled",
  "single_player_sleep_and_advance_day_completed",
  "revision_mismatch",
  "deadline_expired",
  "execution_already_active",
  "adapter_unavailable",
  "not_armed",
  "execution_not_active",
  "cancellation_token_mismatch",
  "cancellation_already_requested",
  "irreversible_phase_reached",
  "reopen_observation_invalid",
  "execution_armed",
  "native_operation_failed",
  "idempotency_key_reused_with_different_request",
  "portfolio_configuration_invalid",
  "portfolio_world_not_ready",
  "portfolio_single_player_required",
  "portfolio_scope_mismatch",
  "portfolio_binding_invalid",
  "portfolio_binding_generation_invalid",
  "portfolio_bridge_disconnected",
  "portfolio_saving",
  "message_too_large",
  "message_not_serializable",
  "invalid_portfolio_sleep_day_request",
  "invalid_portfolio_sleep_day_cancel_request",
  "invalid_envelope",
  "invalid_json",
  "stale_or_invalid_timestamp",
  "authentication_failed",
  "already_authenticated",
  "unauthenticated",
  "portfolio_message_type_rejected",
  "invalid_request",
  "response_serialization_failed",
  "portfolio_sleep_day_not_armed",
  "invalid_portfolio_bootstrap_hello",
  "invalid_portfolio_bootstrap_hello_ack",
  "portfolio_bootstrap_scope_mismatch",
  "portfolio_bootstrap_not_allowed",
  "invalid_portfolio_mine_elevator_request",
  "invalid_portfolio_mine_elevator_cancel_request",
  "invalid_mine_elevator_request",
  "invalid_mine_elevator_observation",
  "mine_observation_invalid",
  "mine_elevator_target_invalid",
  "mine_elevator_transition_started",
  "postcondition_observed",
  "postcondition_observation_invalid",
  "mine_elevator_floor_selected",
  "native_operation_uncertain",
  "stale_callback_revision",
  "portfolio_action_not_allowed",
  "portfolio_mine_elevator_not_armed",
  "invalid_portfolio_mine_elevator_probe_request",
  "invalid_portfolio_mine_elevator_fresh_floor_request",
  "invalid_portfolio_mine_elevator_fresh_floor",
  "invalid_portfolio_mine_ladder_request",
  "invalid_portfolio_mine_ladder_probe_request",
  "invalid_portfolio_mine_ladder_fresh_floor_request",
  "invalid_portfolio_mine_ladder_cancel_request",
  "invalid_portfolio_mine_ladder_fresh_floor",
  "invalid_portfolio_mine_ladder_receipt",
  "invalid_portfolio_mine_ladder_phase",
  "invalid_portfolio_mine_ladder_probe",
  "invalid_mine_ladder_request",
  "invalid_mine_ladder_observation",
  "mine_ladder_target_invalid",
  "mine_ladder_transition_started",
  "mine_ladder_floor_used",
  "portfolio_mine_ladder_not_armed",
  "mine_observation_invalid",
  "invalid_portfolio_enter_mine_request",
  "invalid_portfolio_enter_mine_probe_request",
  "invalid_portfolio_enter_mine_fresh_floor_request",
  "invalid_portfolio_enter_mine_cancel_request",
  "invalid_portfolio_enter_mine_fresh_floor",
  "invalid_portfolio_enter_mine_receipt",
  "invalid_portfolio_enter_mine_phase",
  "invalid_portfolio_enter_mine_probe",
  "invalid_enter_mine_request",
  "invalid_enter_mine_observation",
  "enter_mine_target_invalid",
  "enter_mine_transition_started",
  "enter_mine_floor_used",
  "portfolio_enter_mine_not_armed",
  "invalid_portfolio_skip_event_request",
  "invalid_portfolio_skip_event_cancel_request",
  "invalid_portfolio_skip_event_receipt",
  "invalid_portfolio_skip_event_phase",
  "invalid_skip_event_request",
  "invalid_skip_event_observation",
  "skip_event_no_active_event",
  "skip_event_target_invalid",
  "skip_event_native_skip",
  "skip_event_completed",
  "portfolio_skip_event_not_armed",
] as const;
type PortfolioReasonCode = (typeof PORTFOLIO_REASON_CODES)[number];

export type PortfolioScope = Readonly<{
  integrationId: typeof PORTFOLIO_INTEGRATION_ID;
  topology: typeof PORTFOLIO_TOPOLOGY;
  saveId: string;
  worldId: string;
  localPlayerId: string;
  companionId: string;
  bindingGeneration: number;
  bindingHash: string;
}>;
export type PortfolioBootstrapIdentity = Readonly<{
  saveId: string;
  worldId: string;
  localPlayerId: string;
  companionId: string;
}>;
export type PortfolioBootstrapScope = Readonly<
  Omit<PortfolioScope, "bindingGeneration" | "bindingHash"> & {
    bindingGeneration: 0;
    bindingHash: string;
  }
>;
type PortfolioWireScope = PortfolioScope | PortfolioBootstrapScope;
export function computePortfolioBindingHash(scope: PortfolioBootstrapIdentity & { bindingGeneration: number }): string {
  return createHash("sha256")
    .update(
      `${PORTFOLIO_TOPOLOGY}\n${scope.saveId}\n${scope.worldId}\n${scope.localPlayerId}\n${scope.companionId}\n1.6.15\n24356\n${scope.bindingGeneration}`,
      "utf8",
    )
    .digest("hex");
}
export function bootstrapScope(identity: PortfolioBootstrapIdentity): PortfolioBootstrapScope {
  return {
    integrationId: PORTFOLIO_INTEGRATION_ID,
    topology: PORTFOLIO_TOPOLOGY,
    ...identity,
    bindingGeneration: 0,
    bindingHash: computePortfolioBindingHash({ ...identity, bindingGeneration: 0 }),
  };
}

const PORTFOLIO_SLEEP_DAY_ACTION = "single_player_sleep_and_advance_day" as const;
/** The only phases a Host may materialize for the bounded day lifecycle. */
export const PORTFOLIO_SLEEP_DAY_PHASES = [
  "fresh_observed",
  "accepted",
  "native_sleep_started",
  "saving",
  "saved",
  "day_started",
  "close_requested",
  "reopened",
  "terminal",
] as const;
type PortfolioSleepDayPhaseName = (typeof PORTFOLIO_SLEEP_DAY_PHASES)[number];
type PortfolioSleepDayTerminalState =
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "expired"
  | "rejected"
  | "uncertain";

/** Opaque correlation identifiers are carried, but never interpreted, by the Host. */
type PortfolioTraceId = string;

export type PortfolioSleepDayRequest = Readonly<{
  action: typeof PORTFOLIO_SLEEP_DAY_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  idempotencyKey: string;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
}>;

export type PortfolioSleepDayPhase = Readonly<{
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  phase: PortfolioSleepDayPhaseName;
  revision: number;
  reasonCode: string;
}>;

export type PortfolioSleepDayEvidenceIdentity = Readonly<{
  integrationId: typeof PORTFOLIO_INTEGRATION_ID;
  topology: typeof PORTFOLIO_TOPOLOGY;
  saveId: string;
  worldId: string;
  localPlayerId: string;
  companionId: string;
  bindingGeneration: number;
  bindingHash: string;
}>;

export type PortfolioSleepDayReceipt = Readonly<{
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  state: PortfolioSleepDayTerminalState;
  revision: number;
  reasonCode: string;
  evidence: Readonly<{
    identity: PortfolioSleepDayEvidenceIdentity;
    phaseTrace: readonly PortfolioSleepDayPhase[];
    irreversiblePhase: "none" | "native_sleep_started";
    nativeSleepObserved: boolean;
    savingObserved: boolean;
    savedObserved: boolean;
    dayStartedObserved: boolean;
    newDayIdentity: string;
    closeObserved: boolean;
    reopenObserved: boolean;
  }>;
  postcondition: Readonly<{
    beforeRevision: number;
    afterRevision: number;
    dayAdvanced: boolean;
    freshDayStarted: boolean;
    reopened: boolean;
    newDayIdentity: string;
  }>;
}>;

type PortfolioSleepDayCancelRequest = Readonly<{
  action: typeof PORTFOLIO_SLEEP_DAY_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  cancellationToken: string;
}>;

export const PORTFOLIO_MINE_ELEVATOR_ACTION = "select_mine_elevator_floor" as const;
const PORTFOLIO_MINE_ELEVATOR_MINIMUM_CHECKPOINT = 5;
const PORTFOLIO_MINE_ELEVATOR_MAXIMUM_CHECKPOINT = 120;
export const PORTFOLIO_MINE_ELEVATOR_PHASES = [
  "fresh_observed",
  "accepted",
  "transition_started",
  "postcondition",
  "terminal",
] as const;
const PORTFOLIO_MINE_ELEVATOR_PHASE_REASONS: Readonly<
  Record<PortfolioMineElevatorPhaseName, PortfolioReasonCode>
> = {
  fresh_observed: "fresh_observed",
  accepted: "accepted",
  transition_started: "mine_elevator_transition_started",
  postcondition: "postcondition_observed",
  terminal: "mine_elevator_floor_selected",
};
type PortfolioMineElevatorPhaseName = (typeof PORTFOLIO_MINE_ELEVATOR_PHASES)[number];
type PortfolioMineElevatorTerminalState =
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "expired"
  | "rejected"
  | "uncertain";
export type PortfolioMineElevatorRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_ELEVATOR_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  idempotencyKey: string;
  selectedCheckpoint: number;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineElevatorProbe = Readonly<{
  requestId: string;
  traceId: PortfolioTraceId;
  scope: PortfolioScope;
  revision: number;
  fresh: boolean;
  entryObserved: boolean;
  currentFloor: number;
  lowestMineLevel: number;
  targetUnlocked: boolean;
  elevatorObserved: boolean;
  selectedCheckpoint: number;
}>;

export type PortfolioMineElevatorFreshFloorRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_ELEVATOR_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineElevatorFreshFloor = Readonly<{
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  scope: PortfolioScope;
  revision: number;
  fresh: boolean;
  currentFloor: number;
  lowestMineLevel: number;
}>;

export type PortfolioMineElevatorCancelRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_ELEVATOR_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineElevatorPhase = Readonly<{
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  phase: PortfolioMineElevatorPhaseName;
  revision: number;
  reasonCode: PortfolioReasonCode;
}>;
export type PortfolioMineElevatorReceipt = Readonly<{
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  state: PortfolioMineElevatorTerminalState;
  revision: number;
  reasonCode: PortfolioReasonCode;
  evidence: Readonly<{
    scope: PortfolioScope;
    phaseTrace: readonly PortfolioMineElevatorPhase[];
    entryObserved: boolean;
    currentFloorBefore: number;
    lowestMineLevelBefore: number;
    opaqueElevatorTarget: string | null;
    nativeElevatorTransitionObserved: boolean;
    currentFloorAfter: number;
    lowestMineLevelAfter: number;
    lowestMineLevelObserved: boolean;
  }>;
  postcondition: Readonly<{
    selectedCheckpoint: number | null;
    actualCurrentFloor: number;
    observedLowestMineLevel: number;
    opaqueElevatorTarget: string | null;
    freshObservation: boolean;
    sameExecution: boolean;
  }>;
}>;

export const PORTFOLIO_SKIP_EVENT_ACTION = "skip_event" as const;
export const PORTFOLIO_SKIP_EVENT_PHASES = [
  "fresh_observed",
  "accepted",
  "native_skip",
  "postcondition",
  "terminal",
] as const;
type PortfolioSkipEventPhaseName = (typeof PORTFOLIO_SKIP_EVENT_PHASES)[number];
type PortfolioSkipEventTerminalState = PortfolioMineElevatorTerminalState;
export type PortfolioSkipEventRequest = Readonly<{
  action: typeof PORTFOLIO_SKIP_EVENT_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  idempotencyKey: string;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioSkipEventCancelRequest = Readonly<{
  action: typeof PORTFOLIO_SKIP_EVENT_ACTION;
  requestId: string;
  traceId: string;
  executionId: string;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioSkipEventProbe = Readonly<{
  requestId: string;
  traceId: string;
  scope: PortfolioScope;
  revision: number;
  fresh: boolean;
  eventObserved: boolean;
  eventSkippable: boolean;
  opaqueEventTarget: string | null;
}>;
export type PortfolioSkipEventPhase = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  phase: PortfolioSkipEventPhaseName;
  revision: number;
  reasonCode: PortfolioReasonCode;
}>;
export type PortfolioSkipEventReceipt = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  state: PortfolioSkipEventTerminalState;
  revision: number;
  reasonCode: PortfolioReasonCode;
  evidence: Readonly<{
    scope: PortfolioScope;
    phaseTrace: readonly PortfolioSkipEventPhase[];
    eventObserved: boolean;
    eventSkippable: boolean;
    opaqueEventTarget: string | null;
    nativeEventId: string | null;
    nativeSkipObserved: boolean;
    eventCleared: boolean;
    postEventStateClean: boolean;
  }>;
  postcondition: Readonly<{
    postEventStateClean: boolean;
    freshObservation: boolean;
    sameExecution: boolean;
  }>;
}>;

export type PortfolioSnapshot = Readonly<{
  protocolVersion: number;
  integrationId: typeof PORTFOLIO_INTEGRATION_ID;
  topology: typeof PORTFOLIO_TOPOLOGY;
  saveId: string;
  worldId: string;
  localPlayerId: string;
  companionId: string;
  bindingGeneration: number;
  bindingHash: string;
  revision: number;
  worldReady: boolean;
  singlePlayer: boolean;
  currentLocalPlayerMatches: boolean;
  state: "ready" | "invalidated";
  reasonCode: string;
}>;

type PortfolioEnvelope<TType extends string, TPayload> = Readonly<{
  protocolVersion: number;
  messageId: string;
  correlationId: string;
  timestampMs: number;
  scope: PortfolioWireScope;
  type: TType;
  payload: TPayload;
}>;

export type PortfolioMessage =
  | PortfolioEnvelope<"bootstrap_hello", Readonly<{ token: string }>>
  | PortfolioEnvelope<
      "bootstrap_hello_ack",
      Readonly<{ sessionId: string; bindingGeneration: number; bindingHash: string }>
    >
  | PortfolioEnvelope<"hello", Readonly<{ token: string }>>
  | PortfolioEnvelope<"hello_ack", Readonly<{ sessionId: string; bindingGeneration: number; bindingHash: string }>>
  | PortfolioEnvelope<"observe_request", Readonly<Record<string, never>>>
  | PortfolioEnvelope<"snapshot", PortfolioSnapshot>
  | PortfolioEnvelope<"sleep_day_request", PortfolioSleepDayRequest>
  | PortfolioEnvelope<"sleep_day_cancel_request", PortfolioSleepDayCancelRequest>
  | PortfolioEnvelope<"sleep_day_phase", PortfolioSleepDayPhase>
  | PortfolioEnvelope<"sleep_day_receipt", PortfolioSleepDayReceipt>
  | PortfolioEnvelope<"mine_elevator_request", PortfolioMineElevatorRequest>
  | PortfolioEnvelope<"mine_elevator_probe_request", PortfolioMineElevatorRequest>
  | PortfolioEnvelope<"mine_elevator_probe", PortfolioMineElevatorProbe>
  | PortfolioEnvelope<"mine_elevator_fresh_floor_request", PortfolioMineElevatorFreshFloorRequest>
  | PortfolioEnvelope<"mine_elevator_fresh_floor", PortfolioMineElevatorFreshFloor>
  | PortfolioEnvelope<"mine_elevator_cancel_request", PortfolioMineElevatorCancelRequest>
  | PortfolioEnvelope<"mine_elevator_phase", PortfolioMineElevatorPhase>
  | PortfolioEnvelope<"mine_elevator_receipt", PortfolioMineElevatorReceipt>
  | PortfolioEnvelope<"enter_mine_request", PortfolioMineEntryRequest>
  | PortfolioEnvelope<"enter_mine_probe_request", PortfolioMineEntryRequest>
  | PortfolioEnvelope<"enter_mine_probe", PortfolioMineEntryProbe>
  | PortfolioEnvelope<"enter_mine_fresh_floor_request", PortfolioMineEntryFreshFloorRequest>
  | PortfolioEnvelope<"enter_mine_fresh_floor", PortfolioMineEntryFreshFloor>
  | PortfolioEnvelope<"enter_mine_cancel_request", PortfolioMineEntryCancelRequest>
  | PortfolioEnvelope<"enter_mine_phase", PortfolioMineEntryPhase>
  | PortfolioEnvelope<"enter_mine_receipt", PortfolioMineEntryReceipt>
  | PortfolioEnvelope<"skip_event_request", PortfolioSkipEventRequest>
  | PortfolioEnvelope<"skip_event_probe_request", PortfolioSkipEventRequest>
  | PortfolioEnvelope<"skip_event_probe", PortfolioSkipEventProbe>
  | PortfolioEnvelope<"skip_event_cancel_request", PortfolioSkipEventCancelRequest>
  | PortfolioEnvelope<"skip_event_phase", PortfolioSkipEventPhase>
  | PortfolioEnvelope<"skip_event_receipt", PortfolioSkipEventReceipt>
  | PortfolioEnvelope<"mine_ladder_request", PortfolioMineLadderRequest>
  | PortfolioEnvelope<"mine_ladder_probe_request", PortfolioMineLadderRequest>
  | PortfolioEnvelope<"mine_ladder_probe", PortfolioMineLadderProbe>
  | PortfolioEnvelope<"mine_ladder_fresh_floor_request", PortfolioMineLadderFreshFloorRequest>
  | PortfolioEnvelope<"mine_ladder_fresh_floor", PortfolioMineLadderFreshFloor>
  | PortfolioEnvelope<"mine_ladder_cancel_request", PortfolioMineLadderCancelRequest>
  | PortfolioEnvelope<"mine_ladder_phase", PortfolioMineLadderPhase>
  | PortfolioEnvelope<"mine_ladder_receipt", PortfolioMineLadderReceipt>
  | PortfolioEnvelope<"error", Readonly<{ reasonCode: string }>>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const REASON = /^[a-z0-9_:-]{1,128}$/;
const REASON_SET = new Set<string>(PORTFOLIO_REASON_CODES);

export function newPortfolioEnvelope<TType extends PortfolioMessage["type"], TPayload>(
  type: TType,
  scope: PortfolioWireScope,
  payload: TPayload,
  correlationId = randomUUID(),
  timestampMs = Date.now(),
): PortfolioEnvelope<TType, TPayload> {
  return {
    protocolVersion: PORTFOLIO_PROTOCOL_VERSION,
    messageId: randomUUID(),
    correlationId,
    timestampMs,
    scope,
    type,
    payload,
  };
}

export function validatePortfolioMessage(
  value: unknown,
  expectedScope: PortfolioScope,
  nowMs = Date.now(),
): string | null {
  if (
    (!validPortfolioScope(expectedScope) && !isBootstrapScope(expectedScope)) ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "messageId",
      "correlationId",
      "timestampMs",
      "scope",
      "type",
      "payload",
    ]) ||
    value.protocolVersion !== PORTFOLIO_PROTOCOL_VERSION ||
    !validId(value.messageId) ||
    !validId(value.correlationId) ||
    typeof value.timestampMs !== "number" ||
    !Number.isSafeInteger(value.timestampMs) ||
    Math.abs(nowMs - value.timestampMs) > 5 * 60_000 ||
    (value.type !== "bootstrap_hello_ack" && !samePortfolioScope(value.scope, expectedScope)) ||
    (value.type === "bootstrap_hello_ack" && (!isBootstrapScope(expectedScope) || !isRecord(value.scope))) ||
    typeof value.type !== "string" ||
    !isRecord(value.payload)
  )
    return "invalid_portfolio_envelope";
  switch (value.type) {
    case "bootstrap_hello":
      return isBootstrapScope(expectedScope) &&
        hasExactKeys(value.payload, ["token"]) &&
        validToken(value.payload.token)
        ? null
        : "invalid_portfolio_bootstrap_hello";
    case "bootstrap_hello_ack":
      return validatePortfolioBootstrapAck(value, expectedScope);
    case "hello":
      return hasExactKeys(value.payload, ["token"]) && validToken(value.payload.token)
        ? null
        : "invalid_portfolio_hello";
    case "hello_ack":
      return hasExactKeys(value.payload, ["sessionId", "bindingGeneration", "bindingHash"]) &&
        validId(value.payload.sessionId) &&
        value.payload.bindingGeneration === expectedScope.bindingGeneration &&
        value.payload.bindingHash === expectedScope.bindingHash
        ? null
        : "invalid_portfolio_hello_ack";
    case "observe_request":
      return hasExactKeys(value.payload, []) ? null : "invalid_portfolio_observe_request";
    case "snapshot": {
      const fault = validatePortfolioSnapshot(value.payload);
      if (fault !== null) return fault;
      return samePortfolioSnapshotScope(value.payload, expectedScope) ? null : "portfolio_snapshot_scope_mismatch";
    }
    case "sleep_day_request":
      return validatePortfolioSleepDayRequest(value.payload, nowMs);
    case "sleep_day_cancel_request":
      return validatePortfolioSleepDayCancelRequest(value.payload);
    case "sleep_day_phase":
      return validatePortfolioSleepDayPhase(value.payload);
    case "sleep_day_receipt":
      return validatePortfolioSleepDayReceipt(value.payload);
    case "mine_elevator_request":
      return validatePortfolioMineElevatorRequest(value.payload, expectedScope, nowMs);
    case "mine_elevator_probe_request":
      return validatePortfolioMineElevatorRequest(value.payload, expectedScope, nowMs);
    case "mine_elevator_probe":
      return validatePortfolioMineElevatorProbe(value.payload, expectedScope);
    case "mine_elevator_fresh_floor_request":
      return validatePortfolioMineElevatorFreshFloorRequest(value.payload, expectedScope, nowMs);
    case "mine_elevator_fresh_floor":
      return validatePortfolioMineElevatorFreshFloor(value.payload, expectedScope);
    case "mine_elevator_cancel_request":
      return validatePortfolioMineElevatorCancelRequest(value.payload, expectedScope);
    case "mine_elevator_phase":
      return validatePortfolioMineElevatorPhase(value.payload);
    case "mine_elevator_receipt":
      return validatePortfolioMineElevatorReceipt(value.payload);
    case "enter_mine_request":
    case "enter_mine_probe_request":
      return validatePortfolioMineEntryRequest(value.payload, expectedScope, nowMs);
    case "enter_mine_probe":
      return validatePortfolioMineEntryProbe(value.payload, expectedScope);
    case "enter_mine_fresh_floor_request":
      return validatePortfolioMineEntryFreshFloorRequest(value.payload, expectedScope, nowMs);
    case "enter_mine_fresh_floor":
      return validatePortfolioMineEntryFreshFloor(value.payload, expectedScope);
    case "enter_mine_cancel_request":
      return validatePortfolioMineEntryCancelRequest(value.payload, expectedScope);
    case "enter_mine_phase":
      return validatePortfolioMineEntryPhase(value.payload);
    case "enter_mine_receipt":
      return validatePortfolioMineEntryReceipt(value.payload);
    case "skip_event_request":
    case "skip_event_probe_request":
      return validatePortfolioSkipEventRequest(value.payload, expectedScope, nowMs);
    case "skip_event_probe":
      return validatePortfolioSkipEventProbe(value.payload, expectedScope);
    case "skip_event_cancel_request":
      return validatePortfolioSkipEventCancelRequest(value.payload, expectedScope);
    case "skip_event_phase":
      return validatePortfolioSkipEventPhase(value.payload);
    case "skip_event_receipt":
      return validatePortfolioSkipEventReceipt(value.payload, expectedScope);
    case "mine_ladder_request":
    case "mine_ladder_probe_request":
      return validatePortfolioMineLadderRequest(value.payload, expectedScope, nowMs);
    case "mine_ladder_probe":
      return validatePortfolioMineLadderProbe(value.payload, expectedScope);
    case "mine_ladder_fresh_floor_request":
      return validatePortfolioMineLadderFreshFloorRequest(value.payload, expectedScope, nowMs);
    case "mine_ladder_fresh_floor":
      return validatePortfolioMineLadderFreshFloor(value.payload, expectedScope);
    case "mine_ladder_cancel_request":
      return validatePortfolioMineLadderCancelRequest(value.payload, expectedScope);
    case "mine_ladder_phase":
      return validatePortfolioMineLadderPhase(value.payload);
    case "mine_ladder_receipt":
      return validatePortfolioMineLadderReceipt(value.payload);
    case "error":
      return hasExactKeys(value.payload, ["reasonCode"]) && validReason(value.payload.reasonCode)
        ? null
        : "invalid_portfolio_error";
    default:
      return "portfolio_message_type_rejected";
  }
}

export function validatePortfolioMineElevatorRequest(
  value: unknown,
  expectedScope: PortfolioScope,
  nowMs = Date.now(),
): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "action",
      "requestId",
      "traceId",
      "idempotencyKey",
      "selectedCheckpoint",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
    ]) ||
    value.action !== PORTFOLIO_MINE_ELEVATOR_ACTION ||
    !validId(value.requestId) ||
    !validId(value.traceId) ||
    !validId(value.idempotencyKey) ||
    !isMineElevatorCheckpoint(value.selectedCheckpoint) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !Number.isSafeInteger(value.deadlineMs) ||
    value.deadlineMs <= nowMs ||
    value.deadlineMs > nowMs + 30 * 60_000 ||
    !validToken(value.cancellationToken) ||
    !samePortfolioScope(value.scope, expectedScope)
  )
    return "invalid_portfolio_mine_elevator_request";
  return null;
}

export function validatePortfolioMineElevatorProbe(value: unknown, expectedScope: PortfolioScope): string | null {
  return isRecord(value) &&
    hasExactKeys(value, [
      "requestId",
      "traceId",
      "scope",
      "revision",
      "fresh",
      "entryObserved",
      "currentFloor",
      "lowestMineLevel",
      "targetUnlocked",
      "elevatorObserved",
      "selectedCheckpoint",
    ]) &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    samePortfolioScope(value.scope, expectedScope) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.fresh === "boolean" &&
    typeof value.entryObserved === "boolean" &&
    Number.isSafeInteger(value.currentFloor) &&
    value.currentFloor >= 0 &&
    Number.isSafeInteger(value.lowestMineLevel) &&
    value.lowestMineLevel >= 0 &&
    typeof value.targetUnlocked === "boolean" &&
    typeof value.elevatorObserved === "boolean" &&
    isMineElevatorCheckpoint(value.selectedCheckpoint)
    ? null
    : "invalid_portfolio_mine_elevator_probe";
}

export function materializePortfolioMineElevatorProbe(
  value: unknown,
  expectedRequest: Pick<
    PortfolioMineElevatorRequest,
    "requestId" | "traceId" | "expectedRevision" | "selectedCheckpoint"
  >,
  expectedScope: PortfolioScope,
): PortfolioMineElevatorProbe {
  const fault = validatePortfolioMineElevatorProbe(value, expectedScope);
  if (fault !== null) throw new Error(fault);
  const probe = value as PortfolioMineElevatorProbe;
  if (
    probe.requestId !== expectedRequest.requestId ||
    probe.traceId !== expectedRequest.traceId ||
    probe.revision !== expectedRequest.expectedRevision ||
    probe.selectedCheckpoint !== expectedRequest.selectedCheckpoint
  )
    throw new Error("portfolio_mine_elevator_probe_correlation_mismatch");
  return Object.freeze({ ...probe, scope: Object.freeze({ ...probe.scope }) });
}

export function validatePortfolioMineElevatorFreshFloorRequest(
  value: unknown,
  expectedScope: PortfolioScope,
  nowMs = Date.now(),
): string | null {
  return isRecord(value) &&
    hasExactKeys(value, [
      "action",
      "requestId",
      "traceId",
      "executionId",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
    ]) &&
    value.action === PORTFOLIO_MINE_ELEVATOR_ACTION &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.executionId) &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    Number.isSafeInteger(value.deadlineMs) &&
    value.deadlineMs > nowMs &&
    value.deadlineMs <= nowMs + 30 * 60_000 &&
    validToken(value.cancellationToken) &&
    samePortfolioScope(value.scope, expectedScope)
    ? null
    : "invalid_portfolio_mine_elevator_fresh_floor_request";
}
export function validatePortfolioMineElevatorFreshFloor(value: unknown, expectedScope: PortfolioScope): string | null {
  return isRecord(value) &&
    hasExactKeys(value, [
      "requestId",
      "traceId",
      "executionId",
      "scope",
      "revision",
      "fresh",
      "currentFloor",
      "lowestMineLevel",
    ]) &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.executionId) &&
    samePortfolioScope(value.scope, expectedScope) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    value.fresh === true &&
    Number.isSafeInteger(value.currentFloor) &&
    value.currentFloor >= 0 &&
    Number.isSafeInteger(value.lowestMineLevel) &&
    value.lowestMineLevel >= value.currentFloor
    ? null
    : "invalid_portfolio_mine_elevator_fresh_floor";
}
export function materializePortfolioMineElevatorFreshFloor(
  value: unknown,
  expectedRequest: PortfolioMineElevatorFreshFloorRequest,
  expectedScope: PortfolioScope,
): PortfolioMineElevatorFreshFloor {
  const fault = validatePortfolioMineElevatorFreshFloor(value, expectedScope);
  if (fault !== null) throw new Error(fault);
  const floor = value as PortfolioMineElevatorFreshFloor;
  if (
    floor.requestId !== expectedRequest.requestId ||
    floor.traceId !== expectedRequest.traceId ||
    floor.executionId !== expectedRequest.executionId ||
    floor.revision <= expectedRequest.expectedRevision
  )
    throw new Error("portfolio_mine_elevator_fresh_floor_correlation_mismatch");
  return Object.freeze({ ...floor, scope: Object.freeze({ ...floor.scope }) });
}

export function validatePortfolioMineElevatorCancelRequest(
  value: unknown,
  expectedScope: PortfolioScope,
): string | null {
  return isRecord(value) &&
    hasExactKeys(value, ["action", "requestId", "traceId", "executionId", "cancellationToken", "scope"]) &&
    value.action === PORTFOLIO_MINE_ELEVATOR_ACTION &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.executionId) &&
    validToken(value.cancellationToken) &&
    samePortfolioScope(value.scope, expectedScope)
    ? null
    : "invalid_portfolio_mine_elevator_cancel_request";
}

function validatePortfolioMineElevatorPhase(value: unknown): string | null {
  return isRecord(value) &&
    hasExactKeys(value, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.executionId) &&
    isMineElevatorPhaseName(value.phase) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    validReason(value.reasonCode)
    ? null
    : "invalid_portfolio_mine_elevator_phase";
}

const MINE_ELEVATOR_UNCERTAIN_REASONS = new Set<PortfolioReasonCode>([
  "native_operation_uncertain",
  "postcondition_observation_invalid",
  "stale_callback_revision",
  "portfolio_bridge_disconnected",
]);
const MINE_ELEVATOR_REJECTED_REASONS = new Set<PortfolioReasonCode>([
  "invalid_mine_elevator_request",
  "invalid_mine_elevator_observation",
  "invalid_portfolio_mine_elevator_cancel_request",
  "invalid_envelope",
  "revision_mismatch",
  "deadline_expired",
  "mine_observation_invalid",
  "mine_elevator_target_invalid",
  "idempotency_key_reused_with_different_request",
  "execution_not_active",
  "cancellation_token_mismatch",
]);
const MINE_ELEVATOR_BLOCKED_REASONS = new Set<PortfolioReasonCode>([
  "portfolio_binding_invalid",
  "portfolio_binding_generation_invalid",
  "execution_already_active",
  "adapter_unavailable",
  "irreversible_phase_reached",
  "portfolio_action_not_allowed",
  "portfolio_world_not_ready",
  "portfolio_single_player_required",
  "portfolio_scope_mismatch",
  "portfolio_mine_elevator_not_armed",
]);

function validMineElevatorTerminalReason(
  state: PortfolioMineElevatorTerminalState,
  reason: PortfolioReasonCode,
): boolean {
  switch (state) {
    case "succeeded":
      return reason === "mine_elevator_floor_selected";
    case "cancelled":
      return reason === "cancelled";
    case "expired":
      return reason === "deadline_expired";
    case "failed":
      return reason === "native_operation_failed";
    case "uncertain":
      return MINE_ELEVATOR_UNCERTAIN_REASONS.has(reason);
    case "rejected":
      return MINE_ELEVATOR_REJECTED_REASONS.has(reason);
    case "blocked":
      return MINE_ELEVATOR_BLOCKED_REASONS.has(reason);
  }
}

export function validatePortfolioMineElevatorReceipt(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "requestId",
      "traceId",
      "executionId",
      "state",
      "revision",
      "reasonCode",
      "evidence",
      "postcondition",
    ]) ||
    !validId(value.requestId) ||
    !validId(value.traceId) ||
    !validId(value.executionId) ||
    !isMineElevatorTerminalState(value.state) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !validReason(value.reasonCode) ||
    value.reasonCode === "execution_armed" ||
    !isRecord(value.evidence) ||
    !hasExactKeys(value.evidence, [
      "scope",
      "phaseTrace",
      "entryObserved",
      "currentFloorBefore",
      "lowestMineLevelBefore",
      "opaqueElevatorTarget",
      "nativeElevatorTransitionObserved",
      "currentFloorAfter",
      "lowestMineLevelAfter",
      "lowestMineLevelObserved",
    ]) ||
    !validPortfolioScope(value.evidence.scope as PortfolioScope) ||
    !Array.isArray(value.evidence.phaseTrace) ||
    value.evidence.phaseTrace.length < 2 ||
    value.evidence.phaseTrace.some((phase) => validatePortfolioMineElevatorPhase(phase) !== null) ||
    typeof value.evidence.entryObserved !== "boolean" ||
    !Number.isSafeInteger(value.evidence.currentFloorBefore) ||
    value.evidence.currentFloorBefore < 0 ||
    !Number.isSafeInteger(value.evidence.lowestMineLevelBefore) ||
    value.evidence.lowestMineLevelBefore < 0 ||
    (value.evidence.opaqueElevatorTarget !== null && !validId(value.evidence.opaqueElevatorTarget)) ||
    typeof value.evidence.nativeElevatorTransitionObserved !== "boolean" ||
    !Number.isSafeInteger(value.evidence.currentFloorAfter) ||
    value.evidence.currentFloorAfter < 0 ||
    !Number.isSafeInteger(value.evidence.lowestMineLevelAfter) ||
    value.evidence.lowestMineLevelAfter < 0 ||
    typeof value.evidence.lowestMineLevelObserved !== "boolean" ||
    !isRecord(value.postcondition) ||
    !hasExactKeys(value.postcondition, [
      "selectedCheckpoint",
      "actualCurrentFloor",
      "observedLowestMineLevel",
      "opaqueElevatorTarget",
      "freshObservation",
      "sameExecution",
    ]) ||
    (value.postcondition.selectedCheckpoint !== null &&
      !isMineElevatorCheckpoint(value.postcondition.selectedCheckpoint)) ||
    !Number.isSafeInteger(value.postcondition.actualCurrentFloor) ||
    value.postcondition.actualCurrentFloor < 0 ||
    !Number.isSafeInteger(value.postcondition.observedLowestMineLevel) ||
    value.postcondition.observedLowestMineLevel < 0 ||
    (value.postcondition.opaqueElevatorTarget !== null && !validId(value.postcondition.opaqueElevatorTarget)) ||
    typeof value.postcondition.freshObservation !== "boolean" ||
    typeof value.postcondition.sameExecution !== "boolean"
  )
    return "invalid_portfolio_mine_elevator_receipt";
  const phases = value.evidence.phaseTrace as readonly PortfolioMineElevatorPhase[];
  if (
    phases[0]?.phase !== "fresh_observed" ||
    phases.at(-1)?.phase !== "terminal" ||
    !isMonotonicMineElevatorPhaseTrace(phases) ||
    phases.some(
      (phase) =>
        phase.requestId !== value.requestId ||
        phase.traceId !== value.traceId ||
        phase.executionId !== value.executionId,
    ) ||
    phases.at(-1)?.revision !== value.revision ||
    (value.postcondition.opaqueElevatorTarget !== value.evidence.opaqueElevatorTarget &&
      !(value.postcondition.opaqueElevatorTarget === null && value.evidence.opaqueElevatorTarget === null)) ||
    value.postcondition.actualCurrentFloor !== value.evidence.currentFloorAfter ||
    value.postcondition.observedLowestMineLevel !== value.evidence.lowestMineLevelAfter ||
    phases.at(-1)?.reasonCode !== value.reasonCode
  )
    return "invalid_portfolio_mine_elevator_phase_trace";
  const shortFailure =
    value.state !== "succeeded" &&
    ((phases.length === 2 &&
      phases[0]!.phase === "fresh_observed" &&
      phases[0]!.reasonCode === "fresh_observed" &&
      phases[1]!.phase === "terminal" &&
      phases[0]!.revision === phases[1]!.revision) ||
      (phases.length === 3 &&
        phases[0]!.phase === "fresh_observed" &&
        phases[0]!.reasonCode === "fresh_observed" &&
        phases[1]!.phase === "accepted" &&
        phases[1]!.reasonCode === "accepted" &&
        phases[1]!.revision === phases[0]!.revision &&
        phases[2]!.phase === "terminal" &&
        phases[2]!.revision === phases[1]!.revision));
  const postTransitionFailure =
    phases.length === 4 &&
    phases[0]?.phase === "fresh_observed" &&
    phases[0]?.reasonCode === "fresh_observed" &&
    phases[1]?.phase === "accepted" &&
    phases[1]?.reasonCode === "accepted" &&
    phases[2]?.phase === "transition_started" &&
    phases[2]?.reasonCode === "mine_elevator_transition_started" &&
    phases[3]?.phase === "terminal" &&
    phases[0]!.revision === phases[1]!.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision === phases[2]!.revision &&
    ((value.state === "failed" && value.reasonCode === "native_operation_failed") ||
      (value.state === "uncertain" && MINE_ELEVATOR_UNCERTAIN_REASONS.has(value.reasonCode as PortfolioReasonCode)));
  const completeSuccess =
    phases.length === PORTFOLIO_MINE_ELEVATOR_PHASES.length &&
    phases.every(
      (phase, index) =>
        phase.phase === PORTFOLIO_MINE_ELEVATOR_PHASES[index] &&
        phase.reasonCode === PORTFOLIO_MINE_ELEVATOR_PHASE_REASONS[phase.phase],
    ) &&
    phases[0]!.revision === phases[1]!.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision > phases[2]!.revision &&
    phases[4]!.revision === phases[3]!.revision;
  if (
    !validMineElevatorTerminalReason(
      value.state as PortfolioMineElevatorTerminalState,
      value.reasonCode as PortfolioReasonCode,
    )
  )
    return "invalid_portfolio_mine_elevator_receipt";
  if (
    value.state === "succeeded" &&
    (!completeSuccess ||
      value.reasonCode !== "mine_elevator_floor_selected" ||
      !value.evidence.entryObserved ||
      !value.evidence.nativeElevatorTransitionObserved ||
      !value.evidence.lowestMineLevelObserved ||
      !value.postcondition.freshObservation ||
      !value.postcondition.sameExecution ||
      value.evidence.opaqueElevatorTarget === null ||
      value.postcondition.opaqueElevatorTarget === null ||
      value.postcondition.selectedCheckpoint === null ||
      !isMineElevatorCheckpoint(value.postcondition.selectedCheckpoint) ||
      value.postcondition.actualCurrentFloor !== value.postcondition.selectedCheckpoint ||
      value.evidence.currentFloorAfter !== value.postcondition.selectedCheckpoint)
  )
    return "invalid_portfolio_mine_elevator_receipt";
  if (value.state !== "succeeded" && !shortFailure && !postTransitionFailure)
    return "invalid_portfolio_mine_elevator_phase_trace";
  return null;
}

function validatePortfolioMineElevatorPhaseTrace(value: readonly PortfolioMineElevatorPhase[]): string | null {
  return value.length >= 2 &&
    value.some((phase) => validatePortfolioMineElevatorPhase(phase) !== null) === false &&
    value[0]?.phase === "fresh_observed" &&
    value.at(-1)?.phase === "terminal" &&
    isMonotonicMineElevatorPhaseTrace(value)
    ? null
    : "invalid_portfolio_mine_elevator_phase_trace";
}

export function materializePortfolioMineElevatorReceipt(
  value: unknown,
  expectedRequest: Pick<PortfolioMineElevatorRequest, "requestId" | "traceId" | "expectedRevision">,
  expectedScope: PortfolioScope,
): PortfolioMineElevatorReceipt {
  const fault = validatePortfolioMineElevatorReceipt(value);
  if (fault !== null) throw new Error(fault);
  const receipt = value as PortfolioMineElevatorReceipt;
  if (
    receipt.requestId !== expectedRequest.requestId ||
    receipt.traceId !== expectedRequest.traceId ||
    receipt.evidence.phaseTrace.some(
      (phase) => phase.requestId !== expectedRequest.requestId || phase.traceId !== expectedRequest.traceId,
    ) ||
    !samePortfolioScope(receipt.evidence.scope, expectedScope) ||
    receipt.evidence.phaseTrace[0]?.revision !== expectedRequest.expectedRevision
  )
    throw new Error("portfolio_mine_elevator_request_correlation_mismatch");
  return Object.freeze({
    ...receipt,
    evidence: Object.freeze({ ...receipt.evidence, phaseTrace: Object.freeze([...receipt.evidence.phaseTrace]) }),
    postcondition: Object.freeze({ ...receipt.postcondition }),
  });
}

export function validatePortfolioSleepDayRequest(value: unknown, nowMs = Date.now()): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "action",
      "requestId",
      "traceId",
      "idempotencyKey",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
    ]) ||
    value.action !== PORTFOLIO_SLEEP_DAY_ACTION ||
    !validId(value.requestId) ||
    !validId(value.traceId) ||
    !validId(value.idempotencyKey) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !Number.isSafeInteger(value.deadlineMs) ||
    value.deadlineMs <= nowMs ||
    value.deadlineMs > nowMs + 30 * 60_000 ||
    !validId(value.cancellationToken)
  )
    return "invalid_portfolio_sleep_day_request";
  return null;
}

export function validatePortfolioSleepDayCancelRequest(value: unknown): string | null {
  return isRecord(value) &&
    hasExactKeys(value, ["action", "requestId", "traceId", "executionId", "cancellationToken"]) &&
    value.action === PORTFOLIO_SLEEP_DAY_ACTION &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.executionId) &&
    validId(value.cancellationToken)
    ? null
    : "invalid_portfolio_sleep_day_cancel_request";
}

function validatePortfolioSleepDayPhase(value: unknown): string | null {
  return isRecord(value) &&
    hasExactKeys(value, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.executionId) &&
    isSleepDayPhaseName(value.phase) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    validReason(value.reasonCode)
    ? null
    : "invalid_portfolio_sleep_day_phase";
}

export function materializePortfolioSleepDayReceipt(
  value: unknown,
  expectedRequest: Pick<PortfolioSleepDayRequest, "requestId" | "traceId" | "expectedRevision">,
  expectedScope?: PortfolioScope,
): PortfolioSleepDayReceipt {
  const fault = validatePortfolioSleepDayReceipt(value);
  if (fault !== null) throw new Error(fault);
  const receipt = value as PortfolioSleepDayReceipt;
  if (
    receipt.requestId !== expectedRequest.requestId ||
    receipt.traceId !== expectedRequest.traceId ||
    receipt.postcondition.beforeRevision !== expectedRequest.expectedRevision ||
    (expectedScope !== undefined && !samePortfolioEvidenceIdentity(receipt.evidence.identity, expectedScope))
  )
    throw new Error("portfolio_sleep_day_request_correlation_mismatch");
  return Object.freeze({
    ...receipt,
    evidence: Object.freeze({ ...receipt.evidence, phaseTrace: Object.freeze([...receipt.evidence.phaseTrace]) }),
    postcondition: Object.freeze({ ...receipt.postcondition }),
  });
}

export function validatePortfolioSleepDayReceipt(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "requestId",
      "traceId",
      "executionId",
      "state",
      "revision",
      "reasonCode",
      "evidence",
      "postcondition",
    ]) ||
    !validId(value.requestId) ||
    !validId(value.traceId) ||
    !validId(value.executionId) ||
    !isSleepDayTerminalState(value.state) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !validReason(value.reasonCode) ||
    !isRecord(value.evidence) ||
    !hasExactKeys(value.evidence, [
      "identity",
      "phaseTrace",
      "irreversiblePhase",
      "nativeSleepObserved",
      "savingObserved",
      "savedObserved",
      "dayStartedObserved",
      "newDayIdentity",
      "closeObserved",
      "reopenObserved",
    ]) ||
    !validPortfolioSleepDayEvidenceIdentity(value.evidence.identity) ||
    !Array.isArray(value.evidence.phaseTrace) ||
    value.evidence.phaseTrace.length < 1 ||
    value.evidence.phaseTrace.some((phase) => validatePortfolioSleepDayPhase(phase) !== null) ||
    (value.evidence.irreversiblePhase !== "none" && value.evidence.irreversiblePhase !== "native_sleep_started") ||
    typeof value.evidence.nativeSleepObserved !== "boolean" ||
    typeof value.evidence.savingObserved !== "boolean" ||
    typeof value.evidence.savedObserved !== "boolean" ||
    typeof value.evidence.dayStartedObserved !== "boolean" ||
    !validId(value.evidence.newDayIdentity) ||
    typeof value.evidence.closeObserved !== "boolean" ||
    typeof value.evidence.reopenObserved !== "boolean" ||
    !isRecord(value.postcondition) ||
    !hasExactKeys(value.postcondition, [
      "beforeRevision",
      "afterRevision",
      "dayAdvanced",
      "freshDayStarted",
      "reopened",
      "newDayIdentity",
    ]) ||
    !Number.isSafeInteger(value.postcondition.beforeRevision) ||
    value.postcondition.beforeRevision < 0 ||
    !Number.isSafeInteger(value.postcondition.afterRevision) ||
    value.postcondition.afterRevision < 0 ||
    typeof value.postcondition.dayAdvanced !== "boolean" ||
    typeof value.postcondition.freshDayStarted !== "boolean" ||
    typeof value.postcondition.reopened !== "boolean" ||
    !validId(value.postcondition.newDayIdentity)
  )
    return "invalid_portfolio_sleep_day_receipt";
  const phases = value.evidence.phaseTrace as readonly PortfolioSleepDayPhase[];
  if (
    phases[0]?.phase !== "fresh_observed" ||
    phases.at(-1)?.phase !== "terminal" ||
    !isMonotonicSleepDayPhaseTrace(phases)
  )
    return "invalid_portfolio_sleep_day_phase_trace";
  if (
    phases.some(
      (phase) =>
        phase.requestId !== value.requestId ||
        phase.traceId !== value.traceId ||
        phase.executionId !== value.executionId,
    ) ||
    phases.at(-1)?.revision !== value.revision ||
    value.postcondition.afterRevision !== value.revision ||
    value.postcondition.beforeRevision > value.postcondition.afterRevision
  )
    return "invalid_portfolio_sleep_day_receipt";
  if (
    value.state === "succeeded" &&
    (value.reasonCode !== "single_player_sleep_and_advance_day_completed" ||
      value.postcondition.afterRevision <= value.postcondition.beforeRevision ||
      phases.some((phase, index) => index > 0 && phase.revision < phases[index - 1]!.revision) ||
      phases[0]!.revision !== value.postcondition.beforeRevision ||
      phases.at(-1)!.revision !== value.postcondition.afterRevision)
  )
    return "invalid_portfolio_sleep_day_receipt";
  if (value.evidence.newDayIdentity !== value.postcondition.newDayIdentity)
    return "invalid_portfolio_sleep_day_receipt";
  if (
    value.state === "succeeded" &&
    (phases.length !== PORTFOLIO_SLEEP_DAY_PHASES.length ||
      phases.some((phase, index) => phase.phase !== PORTFOLIO_SLEEP_DAY_PHASES[index]) ||
      value.evidence.irreversiblePhase !== "native_sleep_started" ||
      !value.evidence.nativeSleepObserved ||
      !value.evidence.savingObserved ||
      !value.evidence.savedObserved ||
      !value.evidence.dayStartedObserved ||
      !value.evidence.closeObserved ||
      !value.evidence.reopenObserved ||
      !value.postcondition.dayAdvanced ||
      !value.postcondition.freshDayStarted ||
      !value.postcondition.reopened)
  )
    return "portfolio_sleep_day_success_before_fresh_reopen";
  return null;
}

export function validatePortfolioSnapshot(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "integrationId",
      "topology",
      "saveId",
      "worldId",
      "localPlayerId",
      "companionId",
      "bindingGeneration",
      "bindingHash",
      "revision",
      "worldReady",
      "singlePlayer",
      "currentLocalPlayerMatches",
      "state",
      "reasonCode",
    ]) ||
    value.protocolVersion !== PORTFOLIO_PROTOCOL_VERSION ||
    value.integrationId !== PORTFOLIO_INTEGRATION_ID ||
    value.topology !== PORTFOLIO_TOPOLOGY ||
    !validId(value.saveId) ||
    !validId(value.worldId) ||
    !validId(value.localPlayerId) ||
    !validId(value.companionId) ||
    !Number.isSafeInteger(value.bindingGeneration) ||
    value.bindingGeneration <= 0 ||
    !validHash(value.bindingHash) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.worldReady !== "boolean" ||
    typeof value.singlePlayer !== "boolean" ||
    typeof value.currentLocalPlayerMatches !== "boolean" ||
    (value.state !== "ready" && value.state !== "invalidated") ||
    !validReason(value.reasonCode)
  )
    return "invalid_portfolio_snapshot";
  return null;
}

export function serializePortfolioBounded(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("portfolio_message_not_serializable");
  if (Buffer.byteLength(json, "utf8") > PORTFOLIO_MAX_MESSAGE_BYTES) throw new Error("portfolio_message_too_large");
  return json;
}

function isBootstrapScope(value: unknown): value is PortfolioBootstrapScope {
  return (
    isRecord(value) &&
    value.integrationId === PORTFOLIO_INTEGRATION_ID &&
    value.topology === PORTFOLIO_TOPOLOGY &&
    validId(value.saveId) &&
    validId(value.worldId) &&
    validId(value.localPlayerId) &&
    validId(value.companionId) &&
    value.bindingGeneration === 0 &&
    validHash(value.bindingHash) &&
    value.bindingHash ===
      computePortfolioBindingHash({
        saveId: value.saveId as string,
        worldId: value.worldId as string,
        localPlayerId: value.localPlayerId as string,
        companionId: value.companionId as string,
        bindingGeneration: 0,
      })
  );
}
function validatePortfolioBootstrapAck(
  value: Record<string, any>,
  expectedScope: PortfolioScope | PortfolioBootstrapScope,
): string | null {
  if (
    !isBootstrapScope(expectedScope) ||
    !hasExactKeys(value.payload, ["sessionId", "bindingGeneration", "bindingHash"]) ||
    !validId(value.payload.sessionId) ||
    !Number.isSafeInteger(value.payload.bindingGeneration) ||
    value.payload.bindingGeneration <= 0 ||
    !validHash(value.payload.bindingHash) ||
    !isRecord(value.scope) ||
    !hasExactKeys(value.scope, [
      "integrationId",
      "topology",
      "saveId",
      "worldId",
      "localPlayerId",
      "companionId",
      "bindingGeneration",
      "bindingHash",
    ]) ||
    value.scope.integrationId !== expectedScope.integrationId ||
    value.scope.topology !== expectedScope.topology ||
    value.scope.saveId !== expectedScope.saveId ||
    value.scope.worldId !== expectedScope.worldId ||
    value.scope.localPlayerId !== expectedScope.localPlayerId ||
    value.scope.companionId !== expectedScope.companionId ||
    !Number.isSafeInteger(value.scope.bindingGeneration) ||
    value.scope.bindingGeneration <= 0 ||
    !validHash(value.scope.bindingHash) ||
    value.payload.bindingGeneration !== value.scope.bindingGeneration ||
    value.payload.bindingHash !== value.scope.bindingHash ||
    value.scope.bindingHash !==
      computePortfolioBindingHash({
        saveId: value.scope.saveId as string,
        worldId: value.scope.worldId as string,
        localPlayerId: value.scope.localPlayerId as string,
        companionId: value.scope.companionId as string,
        bindingGeneration: value.scope.bindingGeneration as number,
      })
  )
    return "invalid_portfolio_bootstrap_hello_ack";
  return null;
}
function validPortfolioScope(value: PortfolioScope): boolean {
  return (
    value.integrationId === PORTFOLIO_INTEGRATION_ID &&
    value.topology === PORTFOLIO_TOPOLOGY &&
    validId(value.saveId) &&
    validId(value.worldId) &&
    validId(value.localPlayerId) &&
    validId(value.companionId) &&
    Number.isSafeInteger(value.bindingGeneration) &&
    value.bindingGeneration > 0 &&
    validHash(value.bindingHash)
  );
}
function samePortfolioScope(actual: unknown, expected: PortfolioScope): boolean {
  if (
    !isRecord(actual) ||
    !hasExactKeys(actual, [
      "integrationId",
      "topology",
      "saveId",
      "worldId",
      "localPlayerId",
      "companionId",
      "bindingGeneration",
      "bindingHash",
    ])
  )
    return false;
  return (
    actual.integrationId === expected.integrationId &&
    actual.topology === expected.topology &&
    actual.saveId === expected.saveId &&
    actual.worldId === expected.worldId &&
    actual.localPlayerId === expected.localPlayerId &&
    actual.companionId === expected.companionId &&
    actual.bindingGeneration === expected.bindingGeneration &&
    actual.bindingHash === expected.bindingHash
  );
}
function validPortfolioSleepDayEvidenceIdentity(value: unknown): value is PortfolioSleepDayEvidenceIdentity {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "integrationId",
      "topology",
      "saveId",
      "worldId",
      "localPlayerId",
      "companionId",
      "bindingGeneration",
      "bindingHash",
    ]) &&
    value.integrationId === PORTFOLIO_INTEGRATION_ID &&
    value.topology === PORTFOLIO_TOPOLOGY &&
    validId(value.saveId) &&
    validId(value.worldId) &&
    validId(value.localPlayerId) &&
    validId(value.companionId) &&
    Number.isSafeInteger(value.bindingGeneration) &&
    value.bindingGeneration > 0 &&
    validHash(value.bindingHash)
  );
}
function samePortfolioEvidenceIdentity(actual: PortfolioSleepDayEvidenceIdentity, expected: PortfolioScope): boolean {
  return (
    actual.integrationId === expected.integrationId &&
    actual.topology === expected.topology &&
    actual.saveId === expected.saveId &&
    actual.worldId === expected.worldId &&
    actual.localPlayerId === expected.localPlayerId &&
    actual.companionId === expected.companionId &&
    actual.bindingGeneration === expected.bindingGeneration &&
    actual.bindingHash === expected.bindingHash
  );
}
function samePortfolioSnapshotScope(actual: Record<string, any>, expected: PortfolioScope): boolean {
  return (
    actual.integrationId === expected.integrationId &&
    actual.topology === expected.topology &&
    actual.saveId === expected.saveId &&
    actual.worldId === expected.worldId &&
    actual.localPlayerId === expected.localPlayerId &&
    actual.companionId === expected.companionId &&
    actual.bindingGeneration === expected.bindingGeneration &&
    actual.bindingHash === expected.bindingHash
  );
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}
function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}
function validReason(value: unknown): value is PortfolioReasonCode {
  return typeof value === "string" && REASON.test(value) && REASON_SET.has(value);
}
function isMineElevatorCheckpoint(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= PORTFOLIO_MINE_ELEVATOR_MINIMUM_CHECKPOINT &&
    value <= PORTFOLIO_MINE_ELEVATOR_MAXIMUM_CHECKPOINT &&
    value % 5 === 0
  );
}
function isMineElevatorPhaseName(value: unknown): value is PortfolioMineElevatorPhaseName {
  return typeof value === "string" && (PORTFOLIO_MINE_ELEVATOR_PHASES as readonly string[]).includes(value);
}
function isMineElevatorTerminalState(value: unknown): value is PortfolioMineElevatorTerminalState {
  return (
    value === "succeeded" ||
    value === "blocked" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "rejected" ||
    value === "uncertain"
  );
}
function isMonotonicMineElevatorPhaseTrace(phases: readonly PortfolioMineElevatorPhase[]): boolean {
  let previous = -1;
  let previousRevision = -1;
  for (const phase of phases) {
    const index = PORTFOLIO_MINE_ELEVATOR_PHASES.indexOf(phase.phase);
    if (index <= previous || phase.revision < previousRevision) return false;
    previous = index;
    previousRevision = phase.revision;
  }
  return true;
}
function isSleepDayPhaseName(value: unknown): value is PortfolioSleepDayPhaseName {
  return typeof value === "string" && (PORTFOLIO_SLEEP_DAY_PHASES as readonly string[]).includes(value);
}
function isSleepDayTerminalState(value: unknown): value is PortfolioSleepDayTerminalState {
  return (
    value === "succeeded" ||
    value === "blocked" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired" ||
    value === "rejected" ||
    value === "uncertain"
  );
}

const SLEEP_DAY_PHASE_ORDER: readonly PortfolioSleepDayPhaseName[] = PORTFOLIO_SLEEP_DAY_PHASES;
function _phaseIndexRevisionInvalid(phases: readonly PortfolioSleepDayPhase[], phase: PortfolioSleepDayPhase): boolean {
  const index = phases.indexOf(phase);
  return index > 0 && phase.revision < phases[index - 1]!.revision;
}
function isMonotonicSleepDayPhaseTrace(phases: readonly PortfolioSleepDayPhase[]): boolean {
  let previous = -1;
  let previousRevision = -1;
  let requestId: string | undefined;
  let traceId: PortfolioTraceId | undefined;
  let executionId: string | undefined;
  for (const phase of phases) {
    const index = SLEEP_DAY_PHASE_ORDER.indexOf(phase.phase);
    if (index <= previous || phase.revision < previousRevision) return false;
    if (requestId === undefined) requestId = phase.requestId;
    if (traceId === undefined) traceId = phase.traceId;
    if (executionId === undefined) executionId = phase.executionId;
    if (phase.requestId !== requestId || phase.traceId !== traceId || phase.executionId !== executionId) return false;
    previous = index;
    previousRevision = phase.revision;
  }
  return true;
}

function validatePortfolioSleepDayPhaseTrace(value: readonly PortfolioSleepDayPhase[]): string | null {
  if (
    value.length < 2 ||
    value.some((phase) => validatePortfolioSleepDayPhase(phase) !== null) ||
    value[0]?.phase !== "fresh_observed" ||
    value.at(-1)?.phase !== "terminal" ||
    !isMonotonicSleepDayPhaseTrace(value)
  )
    return "invalid_portfolio_sleep_day_phase_trace";
  return null;
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const PORTFOLIO_MINE_LADDER_ACTION = "use_mine_ladder" as const;
export const PORTFOLIO_MINE_LADDER_PHASES = [
  "fresh_observed",
  "accepted",
  "transition_started",
  "postcondition",
  "terminal",
] as const;
type PortfolioMineLadderPhaseName = (typeof PORTFOLIO_MINE_LADDER_PHASES)[number];
type PortfolioMineLadderTerminalState = PortfolioMineElevatorTerminalState;
export type PortfolioMineLadderRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_LADDER_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  idempotencyKey: string;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineLadderProbe = Readonly<{
  requestId: string;
  traceId: string;
  scope: PortfolioScope;
  revision: number;
  fresh: boolean;
  entryObserved: boolean;
  currentFloor: number;
  lowestMineLevel: number;
  targetUnlocked: boolean;
  ladderObserved: boolean;
  targetFloor: number;
}>;
export type PortfolioMineLadderFreshFloorRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_LADDER_ACTION;
  requestId: string;
  traceId: string;
  executionId: string;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineLadderFreshFloor = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  scope: PortfolioScope;
  revision: number;
  fresh: true;
  currentFloor: number;
  lowestMineLevel: number;
}>;
export type PortfolioMineLadderCancelRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_LADDER_ACTION;
  requestId: string;
  traceId: string;
  executionId: string;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineLadderPhase = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  phase: PortfolioMineLadderPhaseName;
  revision: number;
  reasonCode: PortfolioReasonCode;
}>;
export type PortfolioMineLadderReceipt = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  state: PortfolioMineLadderTerminalState;
  revision: number;
  reasonCode: PortfolioReasonCode;
  evidence: Readonly<{
    scope: PortfolioScope;
    phaseTrace: readonly PortfolioMineLadderPhase[];
    entryObserved: boolean;
    currentFloorBefore: number;
    lowestMineLevelBefore: number;
    opaqueLadderTarget: string | null;
    nativeLadderTransitionObserved: boolean;
    currentFloorAfter: number;
    lowestMineLevelAfter: number;
    lowestMineLevelObserved: boolean;
  }>;
  postcondition: Readonly<{
    targetFloor: number | null;
    actualCurrentFloor: number;
    observedLowestMineLevel: number;
    opaqueLadderTarget: string | null;
    freshObservation: boolean;
    sameExecution: boolean;
  }>;
}>;
export function validatePortfolioMineLadderRequest(
  value: unknown,
  expectedScope: PortfolioScope,
  nowMs = Date.now(),
): string | null {
  return isRecord(value) &&
    hasExactKeys(value, [
      "action",
      "requestId",
      "traceId",
      "idempotencyKey",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
    ]) &&
    value.action === PORTFOLIO_MINE_LADDER_ACTION &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.idempotencyKey) &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    Number.isSafeInteger(value.deadlineMs) &&
    value.deadlineMs > nowMs &&
    value.deadlineMs <= nowMs + 1800000 &&
    validToken(value.cancellationToken) &&
    samePortfolioScope(value.scope, expectedScope)
    ? null
    : "invalid_portfolio_mine_ladder_request";
}
function validatePortfolioMineLadderProbe(value: unknown, scope: PortfolioScope): string | null {
  return isRecord(value) &&
    hasExactKeys(value, [
      "requestId",
      "traceId",
      "scope",
      "revision",
      "fresh",
      "entryObserved",
      "currentFloor",
      "lowestMineLevel",
      "targetUnlocked",
      "ladderObserved",
      "targetFloor",
    ]) &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    samePortfolioScope(value.scope, scope) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.fresh === "boolean" &&
    typeof value.entryObserved === "boolean" &&
    Number.isSafeInteger(value.currentFloor) &&
    value.currentFloor >= 0 &&
    Number.isSafeInteger(value.lowestMineLevel) &&
    value.lowestMineLevel >= 0 &&
    typeof value.targetUnlocked === "boolean" &&
    typeof value.ladderObserved === "boolean" &&
    Number.isSafeInteger(value.targetFloor) &&
    value.targetFloor >= 1 &&
    value.targetFloor <= 120
    ? null
    : "invalid_portfolio_mine_ladder_probe";
}
export function materializePortfolioMineLadderProbe(
  value: unknown,
  request: Pick<PortfolioMineLadderRequest, "requestId" | "traceId" | "expectedRevision">,
  scope: PortfolioScope,
): PortfolioMineLadderProbe {
  if (validatePortfolioMineLadderProbe(value, scope) !== null) throw new Error("invalid_portfolio_mine_ladder_probe");
  const p = value as PortfolioMineLadderProbe;
  if (p.requestId !== request.requestId || p.traceId !== request.traceId || p.revision !== request.expectedRevision)
    throw new Error("portfolio_mine_ladder_probe_correlation_mismatch");
  return Object.freeze({ ...p, scope: Object.freeze({ ...p.scope }) });
}
export function validatePortfolioMineLadderFreshFloorRequest(
  v: unknown,
  s: PortfolioScope,
  n = Date.now(),
): string | null {
  return isRecord(v) &&
    hasExactKeys(v, [
      "action",
      "requestId",
      "traceId",
      "executionId",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
    ]) &&
    v.action === PORTFOLIO_MINE_LADDER_ACTION &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    Number.isSafeInteger(v.expectedRevision) &&
    v.expectedRevision >= 0 &&
    Number.isSafeInteger(v.deadlineMs) &&
    v.deadlineMs > n &&
    v.deadlineMs <= n + 1800000 &&
    validToken(v.cancellationToken) &&
    samePortfolioScope(v.scope, s)
    ? null
    : "invalid_portfolio_mine_ladder_fresh_floor_request";
}
export function validatePortfolioMineLadderCancelRequest(v: unknown, s: PortfolioScope): string | null {
  return isRecord(v) &&
    hasExactKeys(v, ["action", "requestId", "traceId", "executionId", "cancellationToken", "scope"]) &&
    v.action === PORTFOLIO_MINE_LADDER_ACTION &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    validToken(v.cancellationToken) &&
    samePortfolioScope(v.scope, s)
    ? null
    : "invalid_portfolio_mine_ladder_cancel_request";
}
export function validatePortfolioMineLadderFreshFloor(v: unknown, s: PortfolioScope): string | null {
  return isRecord(v) &&
    hasExactKeys(v, [
      "requestId",
      "traceId",
      "executionId",
      "scope",
      "revision",
      "fresh",
      "currentFloor",
      "lowestMineLevel",
    ]) &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    samePortfolioScope(v.scope, s) &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    v.fresh === true &&
    Number.isSafeInteger(v.currentFloor) &&
    v.currentFloor >= 0 &&
    Number.isSafeInteger(v.lowestMineLevel) &&
    v.lowestMineLevel >= v.currentFloor
    ? null
    : "invalid_portfolio_mine_ladder_fresh_floor";
}
export function materializePortfolioMineLadderFreshFloor(
  v: unknown,
  r: PortfolioMineLadderFreshFloorRequest,
  s: PortfolioScope,
): PortfolioMineLadderFreshFloor {
  const fault = validatePortfolioMineLadderFreshFloor(v, s);
  if (fault !== null) throw new Error(fault);
  const floor = v as PortfolioMineLadderFreshFloor;
  if (
    floor.requestId !== r.requestId ||
    floor.traceId !== r.traceId ||
    floor.executionId !== r.executionId ||
    floor.revision <= r.expectedRevision
  )
    throw new Error("portfolio_mine_ladder_fresh_floor_correlation_mismatch");
  return Object.freeze({ ...floor, scope: Object.freeze({ ...floor.scope }) });
}
function validatePortfolioMineLadderPhase(v: unknown): string | null {
  return isRecord(v) &&
    hasExactKeys(v, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    typeof v.phase === "string" &&
    (PORTFOLIO_MINE_LADDER_PHASES as readonly string[]).includes(v.phase) &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    validReason(v.reasonCode)
    ? null
    : "invalid_portfolio_mine_ladder_phase";
}
const MINE_LADDER_UNCERTAIN_REASONS = new Set<PortfolioReasonCode>([
  "native_operation_uncertain",
  "postcondition_observation_invalid",
  "stale_callback_revision",
  "portfolio_bridge_disconnected",
]);
function validMineLadderTerminalReason(state: PortfolioMineLadderTerminalState, reason: PortfolioReasonCode): boolean {
  switch (state) {
    case "succeeded":
      return reason === "mine_ladder_floor_used";
    case "cancelled":
      return reason === "cancelled";
    case "expired":
      return reason === "deadline_expired";
    case "failed":
      return reason === "native_operation_failed";
    case "uncertain":
      return MINE_LADDER_UNCERTAIN_REASONS.has(reason);
    case "rejected":
      return (
        reason.startsWith("invalid_") ||
        reason === "revision_mismatch" ||
        reason === "deadline_expired" ||
        reason === "mine_observation_invalid" ||
        reason === "mine_ladder_target_invalid" ||
        reason === "idempotency_key_reused_with_different_request" ||
        reason === "execution_not_active" ||
        reason === "cancellation_token_mismatch"
      );
    case "blocked":
      return (
        reason.startsWith("portfolio_") ||
        reason === "execution_already_active" ||
        reason === "adapter_unavailable" ||
        reason === "irreversible_phase_reached"
      );
  }
}
function isMonotonicMineLadderPhaseTrace(phases: readonly PortfolioMineLadderPhase[]): boolean {
  let prior = -1;
  let revision = -1;
  for (const phase of phases) {
    const index = PORTFOLIO_MINE_LADDER_PHASES.indexOf(phase.phase);
    if (index <= prior || phase.revision < revision) return false;
    prior = index;
    revision = phase.revision;
  }
  return true;
}
export function validatePortfolioMineLadderReceipt(v: unknown): string | null {
  if (
    !isRecord(v) ||
    !hasExactKeys(v, [
      "requestId",
      "traceId",
      "executionId",
      "state",
      "revision",
      "reasonCode",
      "evidence",
      "postcondition",
    ]) ||
    !validId(v.requestId) ||
    !validId(v.traceId) ||
    !validId(v.executionId) ||
    !isMineElevatorTerminalState(v.state) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !validReason(v.reasonCode) ||
    v.reasonCode === "execution_armed" ||
    !isRecord(v.evidence) ||
    !isRecord(v.postcondition)
  )
    return "invalid_portfolio_mine_ladder_receipt";
  const e = v.evidence,
    p = v.postcondition;
  if (
    !hasExactKeys(e, [
      "scope",
      "phaseTrace",
      "entryObserved",
      "currentFloorBefore",
      "lowestMineLevelBefore",
      "opaqueLadderTarget",
      "nativeLadderTransitionObserved",
      "currentFloorAfter",
      "lowestMineLevelAfter",
      "lowestMineLevelObserved",
    ]) ||
    !validPortfolioScope(e.scope as PortfolioScope) ||
    !Array.isArray(e.phaseTrace) ||
    e.phaseTrace.length < 2 ||
    e.phaseTrace.some(validatePortfolioMineLadderPhase) ||
    typeof e.entryObserved !== "boolean" ||
    !Number.isSafeInteger(e.currentFloorBefore) ||
    e.currentFloorBefore < 0 ||
    !Number.isSafeInteger(e.lowestMineLevelBefore) ||
    e.lowestMineLevelBefore < 0 ||
    (e.opaqueLadderTarget !== null && (!validId(e.opaqueLadderTarget) || e.opaqueLadderTarget === "none")) ||
    typeof e.nativeLadderTransitionObserved !== "boolean" ||
    !Number.isSafeInteger(e.currentFloorAfter) ||
    e.currentFloorAfter < 0 ||
    !Number.isSafeInteger(e.lowestMineLevelAfter) ||
    e.lowestMineLevelAfter < 0 ||
    typeof e.lowestMineLevelObserved !== "boolean" ||
    !hasExactKeys(p, [
      "targetFloor",
      "actualCurrentFloor",
      "observedLowestMineLevel",
      "opaqueLadderTarget",
      "freshObservation",
      "sameExecution",
    ]) ||
    (p.targetFloor !== null && (!Number.isSafeInteger(p.targetFloor) || p.targetFloor < 1 || p.targetFloor > 120)) ||
    !Number.isSafeInteger(p.actualCurrentFloor) ||
    p.actualCurrentFloor < 0 ||
    !Number.isSafeInteger(p.observedLowestMineLevel) ||
    p.observedLowestMineLevel < 0 ||
    (p.opaqueLadderTarget !== null && (!validId(p.opaqueLadderTarget) || p.opaqueLadderTarget === "none")) ||
    typeof p.freshObservation !== "boolean" ||
    typeof p.sameExecution !== "boolean"
  )
    return "invalid_portfolio_mine_ladder_receipt";
  const phases = e.phaseTrace as PortfolioMineLadderPhase[];
  if (
    phases[0]?.phase !== "fresh_observed" ||
    phases.at(-1)?.phase !== "terminal" ||
    !isMonotonicMineLadderPhaseTrace(phases) ||
    phases.at(-1)?.reasonCode !== v.reasonCode ||
    phases.at(-1)?.revision !== v.revision ||
    phases.some((x) => x.requestId !== v.requestId || x.traceId !== v.traceId || x.executionId !== v.executionId) ||
    p.opaqueLadderTarget !== e.opaqueLadderTarget ||
    p.actualCurrentFloor !== e.currentFloorAfter ||
    p.observedLowestMineLevel !== e.lowestMineLevelAfter
  )
    return "invalid_portfolio_mine_ladder_phase_trace";
  if (!validMineLadderTerminalReason(v.state, v.reasonCode)) return "invalid_portfolio_mine_ladder_receipt";
  const shortFailure =
    v.state !== "succeeded" &&
    ((phases.length === 2 &&
      phases[0]?.reasonCode === "fresh_observed" &&
      phases[0]?.revision === phases[1]?.revision) ||
      (phases.length === 3 &&
        phases[0]?.reasonCode === "fresh_observed" &&
        phases[1]?.phase === "accepted" &&
        phases[1]?.reasonCode === "accepted" &&
        phases[0]?.revision === phases[1]?.revision &&
        phases[1]?.revision === phases[2]?.revision));
  const postTransitionFailure =
    phases.length === 4 &&
    phases[0]?.phase === "fresh_observed" &&
    phases[0]?.reasonCode === "fresh_observed" &&
    phases[1]?.phase === "accepted" &&
    phases[1]?.reasonCode === "accepted" &&
    phases[2]?.phase === "transition_started" &&
    phases[2]?.reasonCode === "mine_ladder_transition_started" &&
    phases[3]?.phase === "terminal" &&
    phases[0]!.revision === phases[1]!.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision === phases[2]!.revision &&
    ((v.state === "failed" && v.reasonCode === "native_operation_failed") ||
      (v.state === "uncertain" && MINE_LADDER_UNCERTAIN_REASONS.has(v.reasonCode)));
  const success =
    phases.length === 5 &&
    phases.every(
      (x, i) =>
        x.phase === PORTFOLIO_MINE_LADDER_PHASES[i] &&
        x.reasonCode ===
          [
            "fresh_observed",
            "accepted",
            "mine_ladder_transition_started",
            "postcondition_observed",
            "mine_ladder_floor_used",
          ][i],
    ) &&
    phases[0]!.revision === phases[1]!.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision > phases[2]!.revision &&
    phases[4]!.revision === phases[3]!.revision;
  if (
    v.state === "succeeded" &&
    (!success ||
      !e.entryObserved ||
      !e.nativeLadderTransitionObserved ||
      !e.lowestMineLevelObserved ||
      e.opaqueLadderTarget === null ||
      p.targetFloor === null ||
      p.opaqueLadderTarget === null ||
      !p.freshObservation ||
      !p.sameExecution ||
      p.actualCurrentFloor !== p.targetFloor ||
      p.observedLowestMineLevel < p.targetFloor)
  )
    return "invalid_portfolio_mine_ladder_receipt";
  return v.state === "succeeded" || shortFailure || postTransitionFailure
    ? null
    : "invalid_portfolio_mine_ladder_phase_trace";
}
export function materializePortfolioMineLadderReceipt(
  v: unknown,
  r: Pick<PortfolioMineLadderRequest, "requestId" | "traceId" | "expectedRevision">,
  s: PortfolioScope,
): PortfolioMineLadderReceipt {
  if (validatePortfolioMineLadderReceipt(v) !== null) throw new Error("invalid_portfolio_mine_ladder_receipt");
  const x = v as PortfolioMineLadderReceipt;
  if (
    x.requestId !== r.requestId ||
    x.traceId !== r.traceId ||
    !samePortfolioScope(x.evidence.scope, s) ||
    x.evidence.phaseTrace[0]?.revision !== r.expectedRevision
  )
    throw new Error("portfolio_mine_ladder_request_correlation_mismatch");
  return Object.freeze({
    ...x,
    evidence: Object.freeze({ ...x.evidence, phaseTrace: Object.freeze([...x.evidence.phaseTrace]) }),
    postcondition: Object.freeze({ ...x.postcondition }),
  });
}
const PORTFOLIO_MINE_ENTRY_ACTION = "enter_mine" as const;
export const PORTFOLIO_MINE_ENTRY_PHASES = [
  "fresh_observed",
  "accepted",
  "transition_started",
  "postcondition",
  "terminal",
] as const;
type PortfolioMineEntryPhaseName = (typeof PORTFOLIO_MINE_ENTRY_PHASES)[number];
type PortfolioMineEntryTerminalState = PortfolioMineElevatorTerminalState;
export type PortfolioMineEntryRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_ENTRY_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  idempotencyKey: string;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineEntryProbe = Readonly<{
  requestId: string;
  traceId: string;
  scope: PortfolioScope;
  revision: number;
  fresh: boolean;
  entryObserved: boolean;
  currentFloor: number;
  lowestMineLevel: number;
  targetUnlocked: boolean;
  targetFloor: number;
}>;
export type PortfolioMineEntryFreshFloorRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_ENTRY_ACTION;
  requestId: string;
  traceId: string;
  executionId: string;
  expectedRevision: number;
  deadlineMs: number;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineEntryFreshFloor = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  scope: PortfolioScope;
  revision: number;
  fresh: true;
  currentFloor: number;
  lowestMineLevel: number;
}>;
export type PortfolioMineEntryCancelRequest = Readonly<{
  action: typeof PORTFOLIO_MINE_ENTRY_ACTION;
  requestId: string;
  traceId: string;
  executionId: string;
  cancellationToken: string;
  scope: PortfolioScope;
}>;
export type PortfolioMineEntryPhase = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  phase: PortfolioMineEntryPhaseName;
  revision: number;
  reasonCode: PortfolioReasonCode;
}>;
export type PortfolioMineEntryReceipt = Readonly<{
  requestId: string;
  traceId: string;
  executionId: string;
  state: PortfolioMineEntryTerminalState;
  revision: number;
  reasonCode: PortfolioReasonCode;
  evidence: Readonly<{
    scope: PortfolioScope;
    phaseTrace: readonly PortfolioMineEntryPhase[];
    entryObserved: boolean;
    currentFloorBefore: number;
    lowestMineLevelBefore: number;
    opaqueEntryTarget: string | null;
    nativeEntryTransitionObserved: boolean;
    currentFloorAfter: number;
    lowestMineLevelAfter: number;
    lowestMineLevelObserved: boolean;
  }>;
  postcondition: Readonly<{
    targetFloor: number | null;
    actualCurrentFloor: number;
    observedLowestMineLevel: number;
    opaqueEntryTarget: string | null;
    freshObservation: boolean;
    sameExecution: boolean;
  }>;
}>;
export function validatePortfolioMineEntryRequest(
  value: unknown,
  expectedScope: PortfolioScope,
  nowMs = Date.now(),
): string | null {
  return isRecord(value) &&
    hasExactKeys(value, [
      "action",
      "requestId",
      "traceId",
      "idempotencyKey",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
    ]) &&
    value.action === PORTFOLIO_MINE_ENTRY_ACTION &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    validId(value.idempotencyKey) &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision >= 0 &&
    Number.isSafeInteger(value.deadlineMs) &&
    value.deadlineMs > nowMs &&
    value.deadlineMs <= nowMs + 1800000 &&
    validToken(value.cancellationToken) &&
    samePortfolioScope(value.scope, expectedScope)
    ? null
    : "invalid_portfolio_enter_mine_request";
}
function validatePortfolioMineEntryProbe(value: unknown, scope: PortfolioScope): string | null {
  return isRecord(value) &&
    hasExactKeys(value, [
      "requestId",
      "traceId",
      "scope",
      "revision",
      "fresh",
      "entryObserved",
      "currentFloor",
      "lowestMineLevel",
      "targetUnlocked",
      "targetFloor",
    ]) &&
    validId(value.requestId) &&
    validId(value.traceId) &&
    samePortfolioScope(value.scope, scope) &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.fresh === "boolean" &&
    typeof value.entryObserved === "boolean" &&
    Number.isSafeInteger(value.currentFloor) &&
    value.currentFloor >= 0 &&
    Number.isSafeInteger(value.lowestMineLevel) &&
    value.lowestMineLevel >= 0 &&
    typeof value.targetUnlocked === "boolean" &&
    Number.isSafeInteger(value.targetFloor) &&
    value.targetFloor >= 1 &&
    value.targetFloor === 1
    ? null
    : "invalid_portfolio_enter_mine_probe";
}
export function materializePortfolioMineEntryProbe(
  value: unknown,
  request: Pick<PortfolioMineEntryRequest, "requestId" | "traceId" | "expectedRevision">,
  scope: PortfolioScope,
): PortfolioMineEntryProbe {
  if (validatePortfolioMineEntryProbe(value, scope) !== null) throw new Error("invalid_portfolio_enter_mine_probe");
  const p = value as PortfolioMineEntryProbe;
  if (p.requestId !== request.requestId || p.traceId !== request.traceId || p.revision !== request.expectedRevision)
    throw new Error("portfolio_enter_mine_probe_correlation_mismatch");
  return Object.freeze({ ...p, scope: Object.freeze({ ...p.scope }) });
}
export function validatePortfolioMineEntryFreshFloorRequest(
  v: unknown,
  s: PortfolioScope,
  n = Date.now(),
): string | null {
  return isRecord(v) &&
    hasExactKeys(v, [
      "action",
      "requestId",
      "traceId",
      "executionId",
      "expectedRevision",
      "deadlineMs",
      "cancellationToken",
      "scope",
    ]) &&
    v.action === PORTFOLIO_MINE_ENTRY_ACTION &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    Number.isSafeInteger(v.expectedRevision) &&
    v.expectedRevision >= 0 &&
    Number.isSafeInteger(v.deadlineMs) &&
    v.deadlineMs > n &&
    v.deadlineMs <= n + 1800000 &&
    validToken(v.cancellationToken) &&
    samePortfolioScope(v.scope, s)
    ? null
    : "invalid_portfolio_enter_mine_fresh_floor_request";
}
export function validatePortfolioMineEntryCancelRequest(v: unknown, s: PortfolioScope): string | null {
  return isRecord(v) &&
    hasExactKeys(v, ["action", "requestId", "traceId", "executionId", "cancellationToken", "scope"]) &&
    v.action === PORTFOLIO_MINE_ENTRY_ACTION &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    validToken(v.cancellationToken) &&
    samePortfolioScope(v.scope, s)
    ? null
    : "invalid_portfolio_enter_mine_cancel_request";
}
function validatePortfolioMineEntryFreshFloor(v: unknown, s: PortfolioScope): string | null {
  return isRecord(v) &&
    hasExactKeys(v, [
      "requestId",
      "traceId",
      "executionId",
      "scope",
      "revision",
      "fresh",
      "currentFloor",
      "lowestMineLevel",
    ]) &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    samePortfolioScope(v.scope, s) &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    v.fresh === true &&
    Number.isSafeInteger(v.currentFloor) &&
    v.currentFloor >= 0 &&
    Number.isSafeInteger(v.lowestMineLevel) &&
    v.lowestMineLevel >= v.currentFloor
    ? null
    : "invalid_portfolio_enter_mine_fresh_floor";
}
export function materializePortfolioMineEntryFreshFloor(
  v: unknown,
  r: PortfolioMineEntryFreshFloorRequest,
  s: PortfolioScope,
): PortfolioMineEntryFreshFloor {
  const fault = validatePortfolioMineEntryFreshFloor(v, s);
  if (fault !== null) throw new Error(fault);
  const floor = v as PortfolioMineEntryFreshFloor;
  if (
    floor.requestId !== r.requestId ||
    floor.traceId !== r.traceId ||
    floor.executionId !== r.executionId ||
    floor.revision <= r.expectedRevision
  )
    throw new Error("portfolio_enter_mine_fresh_floor_correlation_mismatch");
  return Object.freeze({ ...floor, scope: Object.freeze({ ...floor.scope }) });
}
function validatePortfolioMineEntryPhase(v: unknown): string | null {
  return isRecord(v) &&
    hasExactKeys(v, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    validId(v.requestId) &&
    validId(v.traceId) &&
    validId(v.executionId) &&
    typeof v.phase === "string" &&
    (PORTFOLIO_MINE_ENTRY_PHASES as readonly string[]).includes(v.phase) &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    validReason(v.reasonCode)
    ? null
    : "invalid_portfolio_enter_mine_phase";
}
const MINE_ENTRY_UNCERTAIN_REASONS = new Set<PortfolioReasonCode>([
  "native_operation_uncertain",
  "postcondition_observation_invalid",
  "stale_callback_revision",
  "portfolio_bridge_disconnected",
]);
function validMineEntryTerminalReason(state: PortfolioMineEntryTerminalState, reason: PortfolioReasonCode): boolean {
  switch (state) {
    case "succeeded":
      return reason === "enter_mine_floor_used";
    case "cancelled":
      return reason === "cancelled";
    case "expired":
      return reason === "deadline_expired";
    case "failed":
      return reason === "native_operation_failed";
    case "uncertain":
      return MINE_ENTRY_UNCERTAIN_REASONS.has(reason);
    case "rejected":
      return (
        reason.startsWith("invalid_") ||
        reason === "revision_mismatch" ||
        reason === "deadline_expired" ||
        reason === "mine_observation_invalid" ||
        reason === "enter_mine_target_invalid" ||
        reason === "idempotency_key_reused_with_different_request" ||
        reason === "execution_not_active" ||
        reason === "cancellation_token_mismatch"
      );
    case "blocked":
      return (
        reason.startsWith("portfolio_") ||
        reason === "execution_already_active" ||
        reason === "adapter_unavailable" ||
        reason === "irreversible_phase_reached"
      );
  }
}
function isMonotonicMineEntryPhaseTrace(phases: readonly PortfolioMineEntryPhase[]): boolean {
  let prior = -1;
  let revision = -1;
  for (const phase of phases) {
    const index = PORTFOLIO_MINE_ENTRY_PHASES.indexOf(phase.phase);
    if (index <= prior || phase.revision < revision) return false;
    prior = index;
    revision = phase.revision;
  }
  return true;
}
function validatePortfolioMineEntryReceipt(v: unknown): string | null {
  if (
    !isRecord(v) ||
    !hasExactKeys(v, [
      "requestId",
      "traceId",
      "executionId",
      "state",
      "revision",
      "reasonCode",
      "evidence",
      "postcondition",
    ]) ||
    !validId(v.requestId) ||
    !validId(v.traceId) ||
    !validId(v.executionId) ||
    !isMineElevatorTerminalState(v.state) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !validReason(v.reasonCode) ||
    v.reasonCode === "execution_armed" ||
    !isRecord(v.evidence) ||
    !isRecord(v.postcondition)
  )
    return "invalid_portfolio_enter_mine_receipt";
  const e = v.evidence,
    p = v.postcondition;
  if (
    !hasExactKeys(e, [
      "scope",
      "phaseTrace",
      "entryObserved",
      "currentFloorBefore",
      "lowestMineLevelBefore",
      "opaqueEntryTarget",
      "nativeEntryTransitionObserved",
      "currentFloorAfter",
      "lowestMineLevelAfter",
      "lowestMineLevelObserved",
    ]) ||
    !validPortfolioScope(e.scope as PortfolioScope) ||
    !Array.isArray(e.phaseTrace) ||
    e.phaseTrace.length < 2 ||
    e.phaseTrace.some(validatePortfolioMineEntryPhase) ||
    typeof e.entryObserved !== "boolean" ||
    !Number.isSafeInteger(e.currentFloorBefore) ||
    e.currentFloorBefore < 0 ||
    !Number.isSafeInteger(e.lowestMineLevelBefore) ||
    e.lowestMineLevelBefore < 0 ||
    (e.opaqueEntryTarget !== null && (!validId(e.opaqueEntryTarget) || e.opaqueEntryTarget === "none")) ||
    typeof e.nativeEntryTransitionObserved !== "boolean" ||
    !Number.isSafeInteger(e.currentFloorAfter) ||
    e.currentFloorAfter < 0 ||
    !Number.isSafeInteger(e.lowestMineLevelAfter) ||
    e.lowestMineLevelAfter < 0 ||
    typeof e.lowestMineLevelObserved !== "boolean" ||
    !hasExactKeys(p, [
      "targetFloor",
      "actualCurrentFloor",
      "observedLowestMineLevel",
      "opaqueEntryTarget",
      "freshObservation",
      "sameExecution",
    ]) ||
    (p.targetFloor !== null && (!Number.isSafeInteger(p.targetFloor) || p.targetFloor < 1 || p.targetFloor !== 1)) ||
    !Number.isSafeInteger(p.actualCurrentFloor) ||
    p.actualCurrentFloor < 0 ||
    !Number.isSafeInteger(p.observedLowestMineLevel) ||
    p.observedLowestMineLevel < 0 ||
    (p.opaqueEntryTarget !== null && (!validId(p.opaqueEntryTarget) || p.opaqueEntryTarget === "none")) ||
    typeof p.freshObservation !== "boolean" ||
    typeof p.sameExecution !== "boolean"
  )
    return "invalid_portfolio_enter_mine_receipt";
  const phases = e.phaseTrace as PortfolioMineEntryPhase[];
  if (
    phases[0]?.phase !== "fresh_observed" ||
    phases.at(-1)?.phase !== "terminal" ||
    !isMonotonicMineEntryPhaseTrace(phases) ||
    phases.at(-1)?.reasonCode !== v.reasonCode ||
    phases.at(-1)?.revision !== v.revision ||
    phases.some((x) => x.requestId !== v.requestId || x.traceId !== v.traceId || x.executionId !== v.executionId) ||
    p.opaqueEntryTarget !== e.opaqueEntryTarget ||
    p.actualCurrentFloor !== e.currentFloorAfter ||
    p.observedLowestMineLevel !== e.lowestMineLevelAfter
  )
    return "invalid_portfolio_enter_mine_phase_trace";
  if (!validMineEntryTerminalReason(v.state, v.reasonCode)) return "invalid_portfolio_enter_mine_receipt";
  const shortFailure =
    v.state !== "succeeded" &&
    ((phases.length === 2 &&
      phases[0]?.reasonCode === "fresh_observed" &&
      phases[0]?.revision === phases[1]?.revision) ||
      (phases.length === 3 &&
        phases[0]?.reasonCode === "fresh_observed" &&
        phases[1]?.phase === "accepted" &&
        phases[1]?.reasonCode === "accepted" &&
        phases[0]?.revision === phases[1]?.revision &&
        phases[1]?.revision === phases[2]?.revision));
  const postTransitionFailure =
    phases.length === 4 &&
    phases[0]?.phase === "fresh_observed" &&
    phases[0]?.reasonCode === "fresh_observed" &&
    phases[1]?.phase === "accepted" &&
    phases[1]?.reasonCode === "accepted" &&
    phases[2]?.phase === "transition_started" &&
    phases[2]?.reasonCode === "enter_mine_transition_started" &&
    phases[3]?.phase === "terminal" &&
    phases[0]!.revision === phases[1]!.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision === phases[2]!.revision &&
    ((v.state === "failed" && v.reasonCode === "native_operation_failed") ||
      (v.state === "uncertain" && MINE_ENTRY_UNCERTAIN_REASONS.has(v.reasonCode)));
  const success =
    phases.length === 5 &&
    phases.every(
      (x, i) =>
        x.phase === PORTFOLIO_MINE_ENTRY_PHASES[i] &&
        x.reasonCode ===
          [
            "fresh_observed",
            "accepted",
            "enter_mine_transition_started",
            "postcondition_observed",
            "enter_mine_floor_used",
          ][i],
    ) &&
    phases[0]!.revision === phases[1]!.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision > phases[2]!.revision &&
    phases[4]!.revision === phases[3]!.revision;
  if (
    v.state === "succeeded" &&
    (!success ||
      !e.entryObserved ||
      !e.nativeEntryTransitionObserved ||
      !e.lowestMineLevelObserved ||
      e.opaqueEntryTarget === null ||
      p.targetFloor === null ||
      p.opaqueEntryTarget === null ||
      !p.freshObservation ||
      !p.sameExecution ||
      p.actualCurrentFloor !== p.targetFloor ||
      p.observedLowestMineLevel < p.targetFloor)
  )
    return "invalid_portfolio_enter_mine_receipt";
  return v.state === "succeeded" || shortFailure || postTransitionFailure
    ? null
    : "invalid_portfolio_enter_mine_phase_trace";
}

const SKIP_EVENT_UNCERTAIN_REASONS = new Set<PortfolioReasonCode>([
  "native_operation_uncertain",
  "postcondition_observation_invalid",
  "stale_callback_revision",
  "portfolio_bridge_disconnected",
]);
function isPortfolioSkipEventTerminalState(value: unknown): value is PortfolioSkipEventTerminalState {
  return isMineElevatorTerminalState(value);
}
function isMonotonicPortfolioSkipEventPhaseTrace(phases: readonly PortfolioSkipEventPhase[]): boolean {
  let prior = -1;
  let revision = -1;
  let requestId: string | undefined;
  let traceId: string | undefined;
  let executionId: string | undefined;
  for (const phase of phases) {
    const index = PORTFOLIO_SKIP_EVENT_PHASES.indexOf(phase.phase);
    if (index <= prior || phase.revision < revision) return false;
    requestId ??= phase.requestId;
    traceId ??= phase.traceId;
    executionId ??= phase.executionId;
    if (phase.requestId !== requestId || phase.traceId !== traceId || phase.executionId !== executionId) return false;
    prior = index;
    revision = phase.revision;
  }
  return true;
}
function validPortfolioSkipEventTerminalReason(
  state: PortfolioSkipEventTerminalState,
  reason: PortfolioReasonCode,
): boolean {
  switch (state) {
    case "succeeded": return reason === "skip_event_completed";
    case "cancelled": return reason === "cancelled";
    case "expired": return reason === "deadline_expired";
    case "failed": return reason === "native_operation_failed";
    case "uncertain": return SKIP_EVENT_UNCERTAIN_REASONS.has(reason);
    case "rejected":
      return reason.startsWith("invalid_") || reason === "revision_mismatch" || reason === "deadline_expired" ||
        reason === "skip_event_no_active_event" || reason === "skip_event_target_invalid" ||
        reason === "execution_not_active" ||
        reason === "cancellation_token_mismatch" || reason === "idempotency_key_reused_with_different_request";
    case "blocked":
      return reason.startsWith("portfolio_") || reason === "execution_already_active" ||
        reason === "adapter_unavailable" || reason === "irreversible_phase_reached";
  }
}
export function validatePortfolioSkipEventRequest(
  v: unknown,
  s: PortfolioScope,
  n = Date.now(),
): string | null {
  return isRecord(v) && hasExactKeys(v, ["action", "requestId", "traceId", "idempotencyKey", "expectedRevision", "deadlineMs", "cancellationToken", "scope"]) &&
    v.action === PORTFOLIO_SKIP_EVENT_ACTION && validId(v.requestId) && validId(v.traceId) && validId(v.idempotencyKey) &&
    Number.isSafeInteger(v.expectedRevision) && v.expectedRevision >= 0 && Number.isSafeInteger(v.deadlineMs) &&
    v.deadlineMs > n && v.deadlineMs <= n + 1800000 && validToken(v.cancellationToken) && samePortfolioScope(v.scope, s)
    ? null : "invalid_portfolio_skip_event_request";
}
export function validatePortfolioSkipEventCancelRequest(v: unknown, s: PortfolioScope): string | null {
  return isRecord(v) && hasExactKeys(v, ["action", "requestId", "traceId", "executionId", "cancellationToken", "scope"]) &&
    v.action === PORTFOLIO_SKIP_EVENT_ACTION && validId(v.requestId) && validId(v.traceId) && validId(v.executionId) &&
    validToken(v.cancellationToken) && samePortfolioScope(v.scope, s)
    ? null : "invalid_portfolio_skip_event_cancel_request";
}
export function validatePortfolioSkipEventProbe(v: unknown, s: PortfolioScope): string | null {
  return isRecord(v) && hasExactKeys(v, ["requestId", "traceId", "scope", "revision", "fresh", "eventObserved", "eventSkippable", "opaqueEventTarget"]) &&
    validId(v.requestId) && validId(v.traceId) && samePortfolioScope(v.scope, s) && Number.isSafeInteger(v.revision) && v.revision >= 0 &&
    v.fresh === true && typeof v.eventObserved === "boolean" && typeof v.eventSkippable === "boolean" &&
    (v.opaqueEventTarget === null || (validId(v.opaqueEventTarget) && v.opaqueEventTarget !== "none"))
    ? null : "invalid_portfolio_skip_event_probe";
}
function validatePortfolioSkipEventPhase(v: unknown): string | null {
  return isRecord(v) && hasExactKeys(v, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    validId(v.requestId) && validId(v.traceId) && validId(v.executionId) &&
    typeof v.phase === "string" && (PORTFOLIO_SKIP_EVENT_PHASES as readonly string[]).includes(v.phase) &&
    Number.isSafeInteger(v.revision) && v.revision >= 0 && validReason(v.reasonCode)
    ? null : "invalid_portfolio_skip_event_phase";
}
export function validatePortfolioSkipEventReceipt(v: unknown, s?: PortfolioScope): string | null {
  if (!isRecord(v) || !hasExactKeys(v, ["requestId", "traceId", "executionId", "state", "revision", "reasonCode", "evidence", "postcondition"]) ||
    !validId(v.requestId) || !validId(v.traceId) || !validId(v.executionId) || !isPortfolioSkipEventTerminalState(v.state) ||
    !Number.isSafeInteger(v.revision) || v.revision < 0 || !validReason(v.reasonCode) || !isRecord(v.evidence) || !isRecord(v.postcondition))
    return "invalid_portfolio_skip_event_receipt";
  const e = v.evidence, p = v.postcondition;
  if (!hasExactKeys(e, ["scope", "phaseTrace", "eventObserved", "eventSkippable", "opaqueEventTarget", "nativeEventId", "nativeSkipObserved", "eventCleared", "postEventStateClean"]) ||
    !validPortfolioScope(e.scope as PortfolioScope) || (s !== undefined && !samePortfolioScope(e.scope, s)) || !Array.isArray(e.phaseTrace) || e.phaseTrace.length < 2 ||
    e.phaseTrace.some(validatePortfolioSkipEventPhase) || typeof e.eventObserved !== "boolean" || typeof e.eventSkippable !== "boolean" ||
    (e.opaqueEventTarget !== null && (!validId(e.opaqueEventTarget) || e.opaqueEventTarget === "none")) ||
    (e.nativeEventId !== null && !validId(e.nativeEventId)) || typeof e.nativeSkipObserved !== "boolean" || typeof e.eventCleared !== "boolean" ||
    typeof e.postEventStateClean !== "boolean" || !hasExactKeys(p, ["postEventStateClean", "freshObservation", "sameExecution"]) ||
    typeof p.postEventStateClean !== "boolean" || typeof p.freshObservation !== "boolean" || typeof p.sameExecution !== "boolean")
    return "invalid_portfolio_skip_event_receipt";
  const phases = e.phaseTrace as PortfolioSkipEventPhase[];
  if (phases[0]?.phase !== "fresh_observed" || phases.at(-1)?.phase !== "terminal" || !isMonotonicPortfolioSkipEventPhaseTrace(phases) ||
    phases.at(-1)?.reasonCode !== v.reasonCode || phases.at(-1)?.revision !== v.revision ||
    phases.some((x) => x.requestId !== v.requestId || x.traceId !== v.traceId || x.executionId !== v.executionId) ||
    !validPortfolioSkipEventTerminalReason(v.state, v.reasonCode))
    return "invalid_portfolio_skip_event_phase_trace";
  const shortFailure = v.state !== "succeeded" && ((phases.length === 2 && phases[0]?.revision === phases[1]?.revision) ||
    (phases.length === 3 && phases[1]?.phase === "accepted" && phases[1]?.revision === phases[2]?.revision));
  // A native Event.skipEvent boundary is irreversible. If a later lifecycle
  // invalidation prevents a clean reread, preserve the exact observed native
  // skip as an uncertain terminal rather than discarding its receipt.
  const postNativeFailure = v.state === "uncertain" && v.reasonCode === "native_operation_uncertain" &&
    phases.length === 4 &&
    phases[0]?.phase === "fresh_observed" && phases[0]?.reasonCode === "fresh_observed" &&
    phases[1]?.phase === "accepted" && phases[1]?.reasonCode === "accepted" &&
    phases[2]?.phase === "native_skip" && phases[2]?.reasonCode === "skip_event_native_skip" &&
    phases[3]?.phase === "terminal" && phases[3]?.reasonCode === "native_operation_uncertain" &&
    phases[0]?.revision === phases[1]?.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]?.revision === phases[2]?.revision &&
    e.eventObserved && e.nativeSkipObserved;
  const expectedPhaseReasons = [
    "fresh_observed",
    "accepted",
    "skip_event_native_skip",
    "postcondition_observed",
    "skip_event_completed",
  ];
  const successTrace = phases.length === 5 && phases.every((phase, index) =>
    phase.phase === PORTFOLIO_SKIP_EVENT_PHASES[index] && phase.reasonCode === expectedPhaseReasons[index]
  );
  const successRevisions = phases.length === 5 &&
    phases[0]?.revision === phases[1]?.revision &&
    phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision > phases[2]!.revision &&
    phases[4]!.revision === phases[3]!.revision;
  const success = successTrace && successRevisions;
  if (v.state === "succeeded" && (!success || !e.eventObserved || !e.nativeSkipObserved || !e.eventCleared || !e.postEventStateClean ||
    !p.postEventStateClean || !p.freshObservation || !p.sameExecution)) return "invalid_portfolio_skip_event_receipt";
  return v.state === "succeeded" || shortFailure || postNativeFailure
    ? null
    : "invalid_portfolio_skip_event_phase_trace";
}
export function materializePortfolioSkipEventProbe(v: unknown, r: Pick<PortfolioSkipEventRequest, "requestId" | "traceId" | "expectedRevision">, s: PortfolioScope): PortfolioSkipEventProbe {
  if (validatePortfolioSkipEventProbe(v, s) !== null) throw new Error("invalid_portfolio_skip_event_probe");
  const p = v as PortfolioSkipEventProbe;
  if (p.requestId !== r.requestId || p.traceId !== r.traceId || p.revision !== r.expectedRevision) throw new Error("portfolio_skip_event_probe_correlation_mismatch");
  return Object.freeze({ ...p, scope: Object.freeze({ ...p.scope }) });
}
export function materializePortfolioSkipEventReceipt(v: unknown, r: Pick<PortfolioSkipEventRequest, "requestId" | "traceId" | "expectedRevision">, s: PortfolioScope): PortfolioSkipEventReceipt {
  if (validatePortfolioSkipEventReceipt(v, s) !== null) throw new Error("invalid_portfolio_skip_event_receipt");
  const x = v as PortfolioSkipEventReceipt;
  if (x.requestId !== r.requestId || x.traceId !== r.traceId || x.evidence.phaseTrace[0]?.revision !== r.expectedRevision) throw new Error("portfolio_skip_event_request_correlation_mismatch");
  return Object.freeze({ ...x, evidence: Object.freeze({ ...x.evidence, phaseTrace: Object.freeze([...x.evidence.phaseTrace]) }), postcondition: Object.freeze({ ...x.postcondition }) });
}
export function materializePortfolioMineEntryReceipt(
  v: unknown,
  r: Pick<PortfolioMineEntryRequest, "requestId" | "traceId" | "expectedRevision">,
  s: PortfolioScope,
): PortfolioMineEntryReceipt {
  if (validatePortfolioMineEntryReceipt(v) !== null) throw new Error("invalid_portfolio_enter_mine_receipt");
  const x = v as PortfolioMineEntryReceipt;
  if (
    x.requestId !== r.requestId ||
    x.traceId !== r.traceId ||
    !samePortfolioScope(x.evidence.scope, s) ||
    x.evidence.phaseTrace[0]?.revision !== r.expectedRevision
  )
    throw new Error("portfolio_enter_mine_request_correlation_mismatch");
  return Object.freeze({
    ...x,
    evidence: Object.freeze({ ...x.evidence, phaseTrace: Object.freeze([...x.evidence.phaseTrace]) }),
    postcondition: Object.freeze({ ...x.postcondition }),
  });
}
