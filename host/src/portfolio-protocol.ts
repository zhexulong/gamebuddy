import { randomUUID } from "node:crypto";

export const PORTFOLIO_PROTOCOL_VERSION = 1;
export const PORTFOLIO_INTEGRATION_ID = "stardew_portfolio";
export const PORTFOLIO_TOPOLOGY = "single_player_native_companion";
export const PORTFOLIO_MAX_MESSAGE_BYTES = 16 * 1024;

/** Closed reason-code vocabulary for this versioned wire contract. */
export const PORTFOLIO_REASON_CODES = [
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
] as const;
export type PortfolioReasonCode = (typeof PORTFOLIO_REASON_CODES)[number];

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

export const PORTFOLIO_SLEEP_DAY_ACTION = "single_player_sleep_and_advance_day" as const;
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
export type PortfolioSleepDayPhaseName = (typeof PORTFOLIO_SLEEP_DAY_PHASES)[number];
export type PortfolioSleepDayTerminalState =
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled"
  | "expired"
  | "rejected"
  | "uncertain";

/** Opaque correlation identifiers are carried, but never interpreted, by the Host. */
export type PortfolioTraceId = string;

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

export type PortfolioSleepDayCancelRequest = Readonly<{
  action: typeof PORTFOLIO_SLEEP_DAY_ACTION;
  requestId: string;
  traceId: PortfolioTraceId;
  executionId: string;
  cancellationToken: string;
}>;

export const PORTFOLIO_MINE_ELEVATOR_ACTION = "select_mine_elevator_floor" as const;
export const PORTFOLIO_MINE_ELEVATOR_MINIMUM_CHECKPOINT = 5;
export const PORTFOLIO_MINE_ELEVATOR_MAXIMUM_CHECKPOINT = 120;
export const PORTFOLIO_MINE_ELEVATOR_PHASES = [
  "fresh_observed", "accepted", "transition_started", "postcondition", "terminal",
] as const;
export const PORTFOLIO_MINE_ELEVATOR_PHASE_REASONS: Readonly<Record<PortfolioMineElevatorPhaseName, PortfolioReasonCode>> = {
  fresh_observed: "fresh_observed",
  accepted: "accepted",
  transition_started: "mine_elevator_transition_started",
  postcondition: "postcondition_observed",
  terminal: "mine_elevator_floor_selected",
};
export type PortfolioMineElevatorPhaseName = (typeof PORTFOLIO_MINE_ELEVATOR_PHASES)[number];
export type PortfolioMineElevatorTerminalState =
  | "succeeded" | "blocked" | "failed" | "cancelled" | "expired" | "rejected" | "uncertain";
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
  scope: PortfolioScope;
  type: TType;
  payload: TPayload;
}>;

export type PortfolioMessage =
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
  | PortfolioEnvelope<"error", Readonly<{ reasonCode: string }>>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const REASON = /^[a-z0-9_:-]{1,128}$/;
const REASON_SET = new Set<string>(PORTFOLIO_REASON_CODES);

export function newPortfolioEnvelope<TType extends PortfolioMessage["type"], TPayload>(
  type: TType,
  scope: PortfolioScope,
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
    !validPortfolioScope(expectedScope) ||
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
    !samePortfolioScope(value.scope, expectedScope) ||
    typeof value.type !== "string" ||
    !isRecord(value.payload)
  )
    return "invalid_portfolio_envelope";
  switch (value.type) {
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
    case "error":
      return hasExactKeys(value.payload, ["reasonCode"]) && validReason(value.payload.reasonCode)
        ? null
        : "invalid_portfolio_error";
    default:
      return "portfolio_message_type_rejected";
  }
}

export function validatePortfolioMineElevatorRequest(value: unknown, expectedScope: PortfolioScope, nowMs = Date.now()): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["action", "requestId", "traceId", "idempotencyKey", "selectedCheckpoint", "expectedRevision", "deadlineMs", "cancellationToken", "scope"]) ||
    value.action !== PORTFOLIO_MINE_ELEVATOR_ACTION || !validId(value.requestId) || !validId(value.traceId) || !validId(value.idempotencyKey) ||
    !isMineElevatorCheckpoint(value.selectedCheckpoint) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
    !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs <= nowMs || value.deadlineMs > nowMs + 30 * 60_000 ||
    !validToken(value.cancellationToken) || !samePortfolioScope(value.scope, expectedScope))
    return "invalid_portfolio_mine_elevator_request";
  return null;
}

export function validatePortfolioMineElevatorProbe(value: unknown, expectedScope: PortfolioScope): string | null {
  return isRecord(value) && hasExactKeys(value, ["requestId", "traceId", "scope", "revision", "fresh", "entryObserved", "currentFloor", "lowestMineLevel", "targetUnlocked", "selectedCheckpoint"]) &&
    validId(value.requestId) && validId(value.traceId) && samePortfolioScope(value.scope, expectedScope) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 && typeof value.fresh === "boolean" &&
    typeof value.entryObserved === "boolean" && Number.isSafeInteger(value.currentFloor) && value.currentFloor >= 0 &&
    Number.isSafeInteger(value.lowestMineLevel) && value.lowestMineLevel >= 0 && typeof value.targetUnlocked === "boolean" &&
    isMineElevatorCheckpoint(value.selectedCheckpoint)
    ? null : "invalid_portfolio_mine_elevator_probe";
}

export function materializePortfolioMineElevatorProbe(
  value: unknown,
  expectedRequest: Pick<PortfolioMineElevatorRequest, "requestId" | "traceId" | "expectedRevision" | "selectedCheckpoint">,
  expectedScope: PortfolioScope,
): PortfolioMineElevatorProbe {
  const fault = validatePortfolioMineElevatorProbe(value, expectedScope);
  if (fault !== null) throw new Error(fault);
  const probe = value as PortfolioMineElevatorProbe;
  if (probe.requestId !== expectedRequest.requestId || probe.traceId !== expectedRequest.traceId ||
      probe.revision !== expectedRequest.expectedRevision || probe.selectedCheckpoint !== expectedRequest.selectedCheckpoint)
    throw new Error("portfolio_mine_elevator_probe_correlation_mismatch");
  return Object.freeze({ ...probe, scope: Object.freeze({ ...probe.scope }) });
}

export function validatePortfolioMineElevatorFreshFloorRequest(value: unknown, expectedScope: PortfolioScope, nowMs = Date.now()): string | null {
  return isRecord(value) && hasExactKeys(value, ["action", "requestId", "traceId", "executionId", "expectedRevision", "deadlineMs", "cancellationToken", "scope"]) &&
    value.action === PORTFOLIO_MINE_ELEVATOR_ACTION && validId(value.requestId) && validId(value.traceId) && validId(value.executionId) &&
    Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 && Number.isSafeInteger(value.deadlineMs) && value.deadlineMs > nowMs && value.deadlineMs <= nowMs + 30 * 60_000 &&
    validToken(value.cancellationToken) && samePortfolioScope(value.scope, expectedScope)
    ? null : "invalid_portfolio_mine_elevator_fresh_floor_request";
}
export function validatePortfolioMineElevatorFreshFloor(value: unknown, expectedScope: PortfolioScope): string | null {
  return isRecord(value) && hasExactKeys(value, ["requestId", "traceId", "executionId", "scope", "revision", "fresh", "currentFloor", "lowestMineLevel"]) &&
    validId(value.requestId) && validId(value.traceId) && validId(value.executionId) && samePortfolioScope(value.scope, expectedScope) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 && value.fresh === true && Number.isSafeInteger(value.currentFloor) && value.currentFloor >= 0 &&
    Number.isSafeInteger(value.lowestMineLevel) && value.lowestMineLevel >= value.currentFloor
    ? null : "invalid_portfolio_mine_elevator_fresh_floor";
}
export function materializePortfolioMineElevatorFreshFloor(value: unknown, expectedRequest: PortfolioMineElevatorFreshFloorRequest, expectedScope: PortfolioScope): PortfolioMineElevatorFreshFloor {
  const fault = validatePortfolioMineElevatorFreshFloor(value, expectedScope);
  if (fault !== null) throw new Error(fault);
  const floor = value as PortfolioMineElevatorFreshFloor;
  if (floor.requestId !== expectedRequest.requestId || floor.traceId !== expectedRequest.traceId || floor.executionId !== expectedRequest.executionId || floor.revision <= expectedRequest.expectedRevision)
    throw new Error("portfolio_mine_elevator_fresh_floor_correlation_mismatch");
  return Object.freeze({ ...floor, scope: Object.freeze({ ...floor.scope }) });
}

export function validatePortfolioMineElevatorCancelRequest(value: unknown, expectedScope: PortfolioScope): string | null {
  return isRecord(value) && hasExactKeys(value, ["action", "requestId", "traceId", "executionId", "cancellationToken", "scope"]) &&
    value.action === PORTFOLIO_MINE_ELEVATOR_ACTION && validId(value.requestId) && validId(value.traceId) && validId(value.executionId) &&
    validToken(value.cancellationToken) && samePortfolioScope(value.scope, expectedScope)
    ? null : "invalid_portfolio_mine_elevator_cancel_request";
}

export function validatePortfolioMineElevatorPhase(value: unknown): string | null {
  return isRecord(value) && hasExactKeys(value, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    validId(value.requestId) && validId(value.traceId) && validId(value.executionId) && isMineElevatorPhaseName(value.phase) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 && validReason(value.reasonCode)
    ? null : "invalid_portfolio_mine_elevator_phase";
}

const MINE_ELEVATOR_UNCERTAIN_REASONS = new Set<PortfolioReasonCode>([
  "native_operation_uncertain", "postcondition_observation_invalid", "stale_callback_revision", "portfolio_bridge_disconnected",
]);
const MINE_ELEVATOR_REJECTED_REASONS = new Set<PortfolioReasonCode>([
  "invalid_mine_elevator_request", "invalid_mine_elevator_observation", "invalid_portfolio_mine_elevator_cancel_request",
  "invalid_envelope", "revision_mismatch", "deadline_expired", "mine_observation_invalid", "mine_elevator_target_invalid",
  "idempotency_key_reused_with_different_request", "execution_not_active", "cancellation_token_mismatch",
]);
const MINE_ELEVATOR_BLOCKED_REASONS = new Set<PortfolioReasonCode>([
  "portfolio_binding_invalid", "portfolio_binding_generation_invalid", "execution_already_active", "adapter_unavailable",
  "irreversible_phase_reached", "portfolio_action_not_allowed", "portfolio_world_not_ready", "portfolio_single_player_required",
  "portfolio_scope_mismatch", "portfolio_mine_elevator_not_armed",
]);

function validMineElevatorTerminalReason(state: PortfolioMineElevatorTerminalState, reason: PortfolioReasonCode): boolean {
  switch (state) {
    case "succeeded": return reason === "mine_elevator_floor_selected";
    case "cancelled": return reason === "cancelled";
    case "expired": return reason === "deadline_expired";
    case "failed": return reason === "native_operation_failed";
    case "uncertain": return MINE_ELEVATOR_UNCERTAIN_REASONS.has(reason);
    case "rejected": return MINE_ELEVATOR_REJECTED_REASONS.has(reason);
    case "blocked": return MINE_ELEVATOR_BLOCKED_REASONS.has(reason);
  }
}

export function validatePortfolioMineElevatorReceipt(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["requestId", "traceId", "executionId", "state", "revision", "reasonCode", "evidence", "postcondition"]) ||
    !validId(value.requestId) || !validId(value.traceId) || !validId(value.executionId) || !isMineElevatorTerminalState(value.state) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || !validReason(value.reasonCode) || value.reasonCode === "execution_armed" ||
    !isRecord(value.evidence) || !hasExactKeys(value.evidence, ["scope", "phaseTrace", "entryObserved", "currentFloorBefore", "lowestMineLevelBefore", "opaqueElevatorTarget", "nativeElevatorTransitionObserved", "currentFloorAfter", "lowestMineLevelAfter", "lowestMineLevelObserved"]) ||
    !validPortfolioScope(value.evidence.scope as PortfolioScope) || !Array.isArray(value.evidence.phaseTrace) || value.evidence.phaseTrace.length < 2 ||
    value.evidence.phaseTrace.some((phase) => validatePortfolioMineElevatorPhase(phase) !== null) ||
    typeof value.evidence.entryObserved !== "boolean" || !Number.isSafeInteger(value.evidence.currentFloorBefore) || value.evidence.currentFloorBefore < 0 ||
    !Number.isSafeInteger(value.evidence.lowestMineLevelBefore) || value.evidence.lowestMineLevelBefore < 0 ||
    (value.evidence.opaqueElevatorTarget !== null && !validId(value.evidence.opaqueElevatorTarget)) ||
    typeof value.evidence.nativeElevatorTransitionObserved !== "boolean" || !Number.isSafeInteger(value.evidence.currentFloorAfter) || value.evidence.currentFloorAfter < 0 ||
    !Number.isSafeInteger(value.evidence.lowestMineLevelAfter) || value.evidence.lowestMineLevelAfter < 0 || typeof value.evidence.lowestMineLevelObserved !== "boolean" ||
    !isRecord(value.postcondition) || !hasExactKeys(value.postcondition, ["selectedCheckpoint", "actualCurrentFloor", "observedLowestMineLevel", "opaqueElevatorTarget", "freshObservation", "sameExecution"]) ||
    (value.postcondition.selectedCheckpoint !== null && !isMineElevatorCheckpoint(value.postcondition.selectedCheckpoint)) || !Number.isSafeInteger(value.postcondition.actualCurrentFloor) || value.postcondition.actualCurrentFloor < 0 ||
    !Number.isSafeInteger(value.postcondition.observedLowestMineLevel) || value.postcondition.observedLowestMineLevel < 0 ||
    (value.postcondition.opaqueElevatorTarget !== null && !validId(value.postcondition.opaqueElevatorTarget)) ||
    typeof value.postcondition.freshObservation !== "boolean" || typeof value.postcondition.sameExecution !== "boolean")
    return "invalid_portfolio_mine_elevator_receipt";
  const phases = value.evidence.phaseTrace as readonly PortfolioMineElevatorPhase[];
  if (phases[0]?.phase !== "fresh_observed" || phases.at(-1)?.phase !== "terminal" ||
      !isMonotonicMineElevatorPhaseTrace(phases) ||
      phases.some((phase) => phase.requestId !== value.requestId || phase.traceId !== value.traceId || phase.executionId !== value.executionId) ||
      phases.at(-1)?.revision !== value.revision ||
      (value.postcondition.opaqueElevatorTarget !== value.evidence.opaqueElevatorTarget &&
        !(value.postcondition.opaqueElevatorTarget === null && value.evidence.opaqueElevatorTarget === null)) ||
      value.postcondition.actualCurrentFloor !== value.evidence.currentFloorAfter || value.postcondition.observedLowestMineLevel !== value.evidence.lowestMineLevelAfter ||
      phases.at(-1)?.reasonCode !== value.reasonCode)
    return "invalid_portfolio_mine_elevator_phase_trace";
  const shortFailure = value.state !== "succeeded" &&
    ((phases.length === 2 && phases[0]!.phase === "fresh_observed" && phases[0]!.reasonCode === "fresh_observed" &&
      phases[1]!.phase === "terminal" && phases[0]!.revision === phases[1]!.revision) ||
     (phases.length === 3 && phases[0]!.phase === "fresh_observed" && phases[0]!.reasonCode === "fresh_observed" &&
      phases[1]!.phase === "accepted" && phases[1]!.reasonCode === "accepted" && phases[1]!.revision === phases[0]!.revision &&
      phases[2]!.phase === "terminal" && phases[2]!.revision === phases[1]!.revision));
  const completeSuccess = phases.length === PORTFOLIO_MINE_ELEVATOR_PHASES.length &&
    phases.every((phase, index) => phase.phase === PORTFOLIO_MINE_ELEVATOR_PHASES[index] &&
      phase.reasonCode === PORTFOLIO_MINE_ELEVATOR_PHASE_REASONS[phase.phase]) &&
    phases[0]!.revision === phases[1]!.revision && phases[2]!.revision > phases[1]!.revision &&
    phases[3]!.revision > phases[2]!.revision && phases[4]!.revision === phases[3]!.revision;
  if (!validMineElevatorTerminalReason(value.state as PortfolioMineElevatorTerminalState, value.reasonCode as PortfolioReasonCode))
    return "invalid_portfolio_mine_elevator_receipt";
  if (value.state === "succeeded" && (!completeSuccess || value.reasonCode !== "mine_elevator_floor_selected" || !value.evidence.entryObserved ||
      !value.evidence.nativeElevatorTransitionObserved || !value.evidence.lowestMineLevelObserved || !value.postcondition.freshObservation ||
      !value.postcondition.sameExecution || value.evidence.opaqueElevatorTarget === null || value.postcondition.opaqueElevatorTarget === null ||
      value.postcondition.selectedCheckpoint === null || !isMineElevatorCheckpoint(value.postcondition.selectedCheckpoint) ||
      value.postcondition.actualCurrentFloor !== value.postcondition.selectedCheckpoint ||
      value.evidence.currentFloorAfter !== value.postcondition.selectedCheckpoint))
    return "invalid_portfolio_mine_elevator_receipt";
  if (value.state !== "succeeded" && !shortFailure)
    return "invalid_portfolio_mine_elevator_phase_trace";
  return null;
}

export function validatePortfolioMineElevatorPhaseTrace(value: readonly PortfolioMineElevatorPhase[]): string | null {
  return value.length >= 2 && value.some((phase) => validatePortfolioMineElevatorPhase(phase) !== null) === false &&
    value[0]?.phase === "fresh_observed" && value.at(-1)?.phase === "terminal" && isMonotonicMineElevatorPhaseTrace(value)
    ? null : "invalid_portfolio_mine_elevator_phase_trace";
}

export function materializePortfolioMineElevatorReceipt(
  value: unknown,
  expectedRequest: Pick<PortfolioMineElevatorRequest, "requestId" | "traceId" | "expectedRevision">,
  expectedScope: PortfolioScope,
): PortfolioMineElevatorReceipt {
  const fault = validatePortfolioMineElevatorReceipt(value);
  if (fault !== null) throw new Error(fault);
  const receipt = value as PortfolioMineElevatorReceipt;
  if (receipt.requestId !== expectedRequest.requestId || receipt.traceId !== expectedRequest.traceId ||
      receipt.evidence.phaseTrace.some((phase) => phase.requestId !== expectedRequest.requestId || phase.traceId !== expectedRequest.traceId) ||
      !samePortfolioScope(receipt.evidence.scope, expectedScope) || receipt.evidence.phaseTrace[0]?.revision !== expectedRequest.expectedRevision)
    throw new Error("portfolio_mine_elevator_request_correlation_mismatch");
  return Object.freeze({ ...receipt, evidence: Object.freeze({ ...receipt.evidence, phaseTrace: Object.freeze([...receipt.evidence.phaseTrace]) }), postcondition: Object.freeze({ ...receipt.postcondition }) });
}

export function validatePortfolioSleepDayRequest(value: unknown, nowMs = Date.now()): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["action", "requestId", "traceId", "idempotencyKey", "expectedRevision", "deadlineMs", "cancellationToken"]) ||
    value.action !== PORTFOLIO_SLEEP_DAY_ACTION || !validId(value.requestId) || !validId(value.traceId) || !validId(value.idempotencyKey) ||
    !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !Number.isSafeInteger(value.deadlineMs) ||
    value.deadlineMs <= nowMs || value.deadlineMs > nowMs + 30 * 60_000 || !validId(value.cancellationToken))
    return "invalid_portfolio_sleep_day_request";
  return null;
}

export function validatePortfolioSleepDayCancelRequest(value: unknown): string | null {
  return isRecord(value) && hasExactKeys(value, ["action", "requestId", "traceId", "executionId", "cancellationToken"]) &&
    value.action === PORTFOLIO_SLEEP_DAY_ACTION && validId(value.requestId) && validId(value.traceId) && validId(value.executionId) && validId(value.cancellationToken)
    ? null : "invalid_portfolio_sleep_day_cancel_request";
}

export function validatePortfolioSleepDayPhase(value: unknown): string | null {
  return isRecord(value) && hasExactKeys(value, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) &&
    validId(value.requestId) && validId(value.traceId) && validId(value.executionId) && isSleepDayPhaseName(value.phase) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 && validReason(value.reasonCode)
    ? null : "invalid_portfolio_sleep_day_phase";
}

export function materializePortfolioSleepDayReceipt(
  value: unknown,
  expectedRequest: Pick<PortfolioSleepDayRequest, "requestId" | "traceId" | "expectedRevision">,
  expectedScope?: PortfolioScope,
): PortfolioSleepDayReceipt {
  const fault = validatePortfolioSleepDayReceipt(value);
  if (fault !== null) throw new Error(fault);
  const receipt = value as PortfolioSleepDayReceipt;
  if (receipt.requestId !== expectedRequest.requestId || receipt.traceId !== expectedRequest.traceId || receipt.postcondition.beforeRevision !== expectedRequest.expectedRevision ||
      (expectedScope !== undefined && !samePortfolioEvidenceIdentity(receipt.evidence.identity, expectedScope)))
    throw new Error("portfolio_sleep_day_request_correlation_mismatch");
  return Object.freeze({
    ...receipt,
    evidence: Object.freeze({ ...receipt.evidence, phaseTrace: Object.freeze([...receipt.evidence.phaseTrace]) }),
    postcondition: Object.freeze({ ...receipt.postcondition }),
  });
}

export function validatePortfolioSleepDayReceipt(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["requestId", "traceId", "executionId", "state", "revision", "reasonCode", "evidence", "postcondition"]) ||
    !validId(value.requestId) || !validId(value.traceId) || !validId(value.executionId) || !isSleepDayTerminalState(value.state) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || !validReason(value.reasonCode) ||
    !isRecord(value.evidence) || !hasExactKeys(value.evidence, ["identity", "phaseTrace", "irreversiblePhase", "nativeSleepObserved", "savingObserved", "savedObserved", "dayStartedObserved", "newDayIdentity", "closeObserved", "reopenObserved"]) ||
    !validPortfolioSleepDayEvidenceIdentity(value.evidence.identity) ||
    !Array.isArray(value.evidence.phaseTrace) || value.evidence.phaseTrace.length < 1 || value.evidence.phaseTrace.some((phase) => validatePortfolioSleepDayPhase(phase) !== null) ||
    (value.evidence.irreversiblePhase !== "none" && value.evidence.irreversiblePhase !== "native_sleep_started") ||
    typeof value.evidence.nativeSleepObserved !== "boolean" ||
    typeof value.evidence.savingObserved !== "boolean" ||
    typeof value.evidence.savedObserved !== "boolean" ||
    typeof value.evidence.dayStartedObserved !== "boolean" ||
    !validId(value.evidence.newDayIdentity) ||
    typeof value.evidence.closeObserved !== "boolean" ||
    typeof value.evidence.reopenObserved !== "boolean" ||
    !isRecord(value.postcondition) || !hasExactKeys(value.postcondition, ["beforeRevision", "afterRevision", "dayAdvanced", "freshDayStarted", "reopened", "newDayIdentity"]) ||
    !Number.isSafeInteger(value.postcondition.beforeRevision) || value.postcondition.beforeRevision < 0 ||
    !Number.isSafeInteger(value.postcondition.afterRevision) || value.postcondition.afterRevision < 0 ||
    typeof value.postcondition.dayAdvanced !== "boolean" || typeof value.postcondition.freshDayStarted !== "boolean" || typeof value.postcondition.reopened !== "boolean" ||
    !validId(value.postcondition.newDayIdentity))
    return "invalid_portfolio_sleep_day_receipt";
  const phases = value.evidence.phaseTrace as readonly PortfolioSleepDayPhase[];
  if (phases[0]?.phase !== "fresh_observed" || phases.at(-1)?.phase !== "terminal" || !isMonotonicSleepDayPhaseTrace(phases))
    return "invalid_portfolio_sleep_day_phase_trace";
  if (phases.some((phase) => phase.requestId !== value.requestId || phase.traceId !== value.traceId || phase.executionId !== value.executionId) ||
      phases.at(-1)?.revision !== value.revision ||
      value.postcondition.afterRevision !== value.revision ||
      value.postcondition.beforeRevision > value.postcondition.afterRevision)
    return "invalid_portfolio_sleep_day_receipt";
  if (value.state === "succeeded" &&
      (value.reasonCode !== "single_player_sleep_and_advance_day_completed" ||
       value.postcondition.afterRevision <= value.postcondition.beforeRevision ||
       phases.some((phase, index) => index > 0 && phase.revision < phases[index - 1]!.revision) ||
       phases[0]!.revision !== value.postcondition.beforeRevision ||
       phases.at(-1)!.revision !== value.postcondition.afterRevision))
    return "invalid_portfolio_sleep_day_receipt";
  if (value.evidence.newDayIdentity !== value.postcondition.newDayIdentity)
    return "invalid_portfolio_sleep_day_receipt";
  if (value.state === "succeeded" &&
      (phases.length !== PORTFOLIO_SLEEP_DAY_PHASES.length ||
       phases.some((phase, index) => phase.phase !== PORTFOLIO_SLEEP_DAY_PHASES[index]) ||
       value.evidence.irreversiblePhase !== "native_sleep_started" ||
       !value.evidence.nativeSleepObserved || !value.evidence.savingObserved || !value.evidence.savedObserved ||
       !value.evidence.dayStartedObserved || !value.evidence.closeObserved || !value.evidence.reopenObserved ||
       !value.postcondition.dayAdvanced || !value.postcondition.freshDayStarted || !value.postcondition.reopened))
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
  return isRecord(value) && hasExactKeys(value, ["integrationId", "topology", "saveId", "worldId", "localPlayerId", "companionId", "bindingGeneration", "bindingHash"]) &&
    value.integrationId === PORTFOLIO_INTEGRATION_ID && value.topology === PORTFOLIO_TOPOLOGY &&
    validId(value.saveId) && validId(value.worldId) && validId(value.localPlayerId) && validId(value.companionId) &&
    Number.isSafeInteger(value.bindingGeneration) && value.bindingGeneration > 0 && validHash(value.bindingHash);
}
function samePortfolioEvidenceIdentity(actual: PortfolioSleepDayEvidenceIdentity, expected: PortfolioScope): boolean {
  return actual.integrationId === expected.integrationId && actual.topology === expected.topology &&
    actual.saveId === expected.saveId && actual.worldId === expected.worldId &&
    actual.localPlayerId === expected.localPlayerId && actual.companionId === expected.companionId &&
    actual.bindingGeneration === expected.bindingGeneration && actual.bindingHash === expected.bindingHash;
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= PORTFOLIO_MINE_ELEVATOR_MINIMUM_CHECKPOINT &&
    value <= PORTFOLIO_MINE_ELEVATOR_MAXIMUM_CHECKPOINT && value % 5 === 0;
}
function isMineElevatorPhaseName(value: unknown): value is PortfolioMineElevatorPhaseName {
  return typeof value === "string" && (PORTFOLIO_MINE_ELEVATOR_PHASES as readonly string[]).includes(value);
}
function isMineElevatorTerminalState(value: unknown): value is PortfolioMineElevatorTerminalState {
  return value === "succeeded" || value === "blocked" || value === "failed" || value === "cancelled" || value === "expired" || value === "rejected" || value === "uncertain";
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
  return value === "succeeded" || value === "blocked" || value === "failed" || value === "cancelled" || value === "expired" || value === "rejected" || value === "uncertain";
}

const SLEEP_DAY_PHASE_ORDER: readonly PortfolioSleepDayPhaseName[] = PORTFOLIO_SLEEP_DAY_PHASES;
function phaseIndexRevisionInvalid(phases: readonly PortfolioSleepDayPhase[], phase: PortfolioSleepDayPhase): boolean {
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

export function validatePortfolioSleepDayPhaseTrace(value: readonly PortfolioSleepDayPhase[]): string | null {
  if (value.length < 2 || value.some((phase) => validatePortfolioSleepDayPhase(phase) !== null) ||
      value[0]?.phase !== "fresh_observed" || value.at(-1)?.phase !== "terminal" || !isMonotonicSleepDayPhaseTrace(value))
    return "invalid_portfolio_sleep_day_phase_trace";
  return null;
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
