import assert from "node:assert/strict";
import test from "node:test";
import {
  PORTFOLIO_INTEGRATION_ID,
  PORTFOLIO_TOPOLOGY,
  newPortfolioEnvelope,
  validatePortfolioMessage,
  validatePortfolioSnapshot,
  validatePortfolioSleepDayReceipt,
  validatePortfolioSleepDayRequest,
  validatePortfolioSleepDayCancelRequest,
  materializePortfolioSleepDayReceipt,
  PORTFOLIO_MINE_ELEVATOR_ACTION,
  validatePortfolioMineElevatorRequest,
  validatePortfolioMineElevatorProbe,
  materializePortfolioMineElevatorProbe,
  validatePortfolioMineElevatorFreshFloorRequest,
  validatePortfolioMineElevatorFreshFloor,
  materializePortfolioMineElevatorFreshFloor,
  validatePortfolioMineElevatorCancelRequest,
  validatePortfolioMineElevatorReceipt,
} from "./portfolio-protocol.js";

const scope = {
  integrationId: PORTFOLIO_INTEGRATION_ID,
  topology: PORTFOLIO_TOPOLOGY,
  saveId: "save_01",
  worldId: "world_01",
  localPlayerId: "player_01",
  companionId: "companion_01",
  bindingGeneration: 1,
  bindingHash: "a".repeat(64),
} as const;
const snapshot = {
  protocolVersion: 1,
  integrationId: PORTFOLIO_INTEGRATION_ID,
  topology: PORTFOLIO_TOPOLOGY,
  saveId: scope.saveId,
  worldId: scope.worldId,
  localPlayerId: scope.localPlayerId,
  companionId: scope.companionId,
  bindingGeneration: 1,
  bindingHash: scope.bindingHash,
  revision: 1,
  worldReady: true,
  singlePlayer: true,
  currentLocalPlayerMatches: true,
  state: "ready",
  reasonCode: "accepted",
} as const;

const identity = {
  integrationId: PORTFOLIO_INTEGRATION_ID,
  topology: PORTFOLIO_TOPOLOGY,
  saveId: scope.saveId,
  worldId: scope.worldId,
  localPlayerId: scope.localPlayerId,
  companionId: scope.companionId,
  bindingGeneration: scope.bindingGeneration,
  bindingHash: scope.bindingHash,
} as const;

function successfulReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const phases = ["fresh_observed", "accepted", "native_sleep_started", "saving", "saved", "day_started", "close_requested", "reopened", "terminal"].map((phase, index) => ({
    requestId: "request_01", traceId: "trace_01", executionId: "execution_01", phase,
    revision: index < 3 ? 1 : 4, reasonCode: "observed",
  }));
  return {
    requestId: "request_01", traceId: "trace_01", executionId: "execution_01", state: "succeeded", revision: 4,
    reasonCode: "single_player_sleep_and_advance_day_completed",
    evidence: { identity, phaseTrace: phases, irreversiblePhase: "native_sleep_started", nativeSleepObserved: true, savingObserved: true, savedObserved: true, dayStartedObserved: true, newDayIdentity: "day_02", closeObserved: true, reopenObserved: true },
    postcondition: { beforeRevision: 1, afterRevision: 4, dayAdvanced: true, freshDayStarted: true, reopened: true, newDayIdentity: "day_02" },
    ...overrides,
  };
}

test("Portfolio protocol accepts only exact topology-scoped hello and observe messages", () => {
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("hello", scope, { token: "portfolio_test_token_1234" }), scope), null);
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("observe_request", scope, {}), scope), null);
  assert.equal(validatePortfolioMessage({ ...newPortfolioEnvelope("observe_request", scope, {}), payload: { extra: true } }, scope), "invalid_portfolio_observe_request");
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("execution_request" as never, scope, {}), scope), "portfolio_message_type_rejected");
  assert.equal(validatePortfolioSnapshot(snapshot), null);
});

test("sleep/day success requires exact identity, trace, reason, order, and revisions", () => {
  assert.equal(validatePortfolioSleepDayReceipt(successfulReceipt()), null);
  assert.equal(validatePortfolioSleepDayReceipt(successfulReceipt({ traceId: "other_trace" })), "invalid_portfolio_sleep_day_receipt");
  assert.equal(validatePortfolioSleepDayReceipt(successfulReceipt({ reasonCode: "accepted" })), "invalid_portfolio_sleep_day_receipt");
  assert.equal(validatePortfolioSleepDayReceipt(successfulReceipt({ evidence: { ...((successfulReceipt() as any).evidence), irreversiblePhase: "none" } })), "portfolio_sleep_day_success_before_fresh_reopen");
  assert.throws(() => materializePortfolioSleepDayReceipt(successfulReceipt({ evidence: { ...((successfulReceipt() as any).evidence), identity: { ...identity, bindingHash: "b".repeat(64) } } }), { requestId: "request_01", traceId: "trace_01", expectedRevision: 1 }, scope), /portfolio_sleep_day_request_correlation_mismatch/);
  const receipt = successfulReceipt() as any;
  assert.equal(validatePortfolioSleepDayReceipt({ ...receipt, evidence: { ...receipt.evidence, identity: { ...identity, topology: "native_ai_farmhand_multiplayer" } } }), "invalid_portfolio_sleep_day_receipt");
  assert.equal(validatePortfolioSleepDayReceipt({ ...receipt, evidence: { ...receipt.evidence, phaseTrace: receipt.evidence.phaseTrace.map((phase: any, index: number) => index === 4 ? { ...phase, revision: 1 } : phase) } }), "invalid_portfolio_sleep_day_phase_trace");
  assert.equal(validatePortfolioSleepDayReceipt({ ...receipt, evidence: { ...receipt.evidence, phaseTrace: receipt.evidence.phaseTrace.slice(0, 7) } }), "invalid_portfolio_sleep_day_phase_trace");
  assert.equal(validatePortfolioSleepDayReceipt({ ...receipt, evidence: { ...receipt.evidence, newDayIdentity: "day_03" } }), "invalid_portfolio_sleep_day_receipt");
});

test("Portfolio validators enforce request deadline bounds and closed reason codes", () => {
  const now = 1_000_000;
  const request = { action: "single_player_sleep_and_advance_day" as const, requestId: "request_01", traceId: "trace_01", idempotencyKey: "idem_01", expectedRevision: 1, deadlineMs: now + 30 * 60_000, cancellationToken: "cancel_01" };
  assert.equal(validatePortfolioSleepDayRequest(request, now), null);
  assert.equal(validatePortfolioSleepDayRequest({ ...request, deadlineMs: now + 30 * 60_000 + 1 }, now), "invalid_portfolio_sleep_day_request");
  assert.equal(validatePortfolioSleepDayRequest({ ...request, deadlineMs: now }, now), "invalid_portfolio_sleep_day_request");
  const cancel = { action: "single_player_sleep_and_advance_day" as const, requestId: "request_01", traceId: "trace_01", executionId: "execution_01", cancellationToken: "cancel_01" };
  assert.equal(validatePortfolioSleepDayCancelRequest(cancel), null);
  assert.equal(validatePortfolioSleepDayCancelRequest({ ...cancel, traceId: undefined }), "invalid_portfolio_sleep_day_cancel_request");
  assert.equal(validatePortfolioSleepDayCancelRequest({ ...cancel, extra: true }), "invalid_portfolio_sleep_day_cancel_request");
  assert.equal(validatePortfolioSleepDayReceipt({ ...successfulReceipt({ state: "failed", reasonCode: "unknown_reason" }), evidence: { ...((successfulReceipt() as any).evidence), phaseTrace: (successfulReceipt() as any).evidence.phaseTrace.slice(0, 2), irreversiblePhase: "none", nativeSleepObserved: false, savingObserved: false, savedObserved: false, dayStartedObserved: false, newDayIdentity: "none", closeObserved: false, reopenObserved: false }, postcondition: { beforeRevision: 1, afterRevision: 1, dayAdvanced: false, freshDayStarted: false, reopened: false, newDayIdentity: "none" }, revision: 1 }), "invalid_portfolio_sleep_day_receipt");
});

test("M8 probe requires exact typed facts and binds request scope, checkpoint, and revision", () => {
  const request = { action: PORTFOLIO_MINE_ELEVATOR_ACTION, requestId: "request_probe", traceId: "trace_probe", idempotencyKey: "idem_probe", selectedCheckpoint: 10, expectedRevision: 1, deadlineMs: 1_030_000, cancellationToken: "cancel_probe_token", scope } as const;
  const probe = { requestId: request.requestId, traceId: request.traceId, scope, revision: 1, fresh: true, entryObserved: true, currentFloor: 5, lowestMineLevel: 10, targetUnlocked: true, selectedCheckpoint: 10 };
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("mine_elevator_probe", scope, probe, "00000000-0000-4000-8000-000000000001", 1_000_000), scope, 1_000_000), null);
  assert.equal(validatePortfolioMineElevatorProbe(probe, scope), null);
  assert.equal(materializePortfolioMineElevatorProbe(probe, request, scope).targetUnlocked, true);
  assert.equal(validatePortfolioMineElevatorProbe({ ...probe, scope: { ...scope, saveId: "other" } }, scope), "invalid_portfolio_mine_elevator_probe");
  assert.throws(() => materializePortfolioMineElevatorProbe({ ...probe, revision: 2 }, request, scope), /probe_correlation_mismatch/);
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("mine_elevator_probe_request", scope, { ...request, scope: { ...scope, worldId: "other" } }, "00000000-0000-4000-8000-000000000002", 1_000_000), scope, 1_000_000), "invalid_portfolio_mine_elevator_request");
  assert.equal(validatePortfolioMineElevatorRequest({ ...request, cancellationToken: "short" }, scope, 1_000_000), "invalid_portfolio_mine_elevator_request");
});

test("M8 terminal fresh-floor reader requires exact succeeded execution identity and scope", () => {
  const request = { action: PORTFOLIO_MINE_ELEVATOR_ACTION, requestId: "request_floor", traceId: "trace_floor", executionId: "execution_floor", expectedRevision: 9, deadlineMs: Date.now() + 10_000, cancellationToken: "cancel_floor_token", scope } as const;
  const floor = { requestId: request.requestId, traceId: request.traceId, executionId: request.executionId, scope, revision: 10, fresh: true, currentFloor: 10, lowestMineLevel: 10 };
  assert.equal(validatePortfolioMineElevatorFreshFloorRequest(request, scope), null);
  assert.equal(validatePortfolioMineElevatorFreshFloorRequest({ ...request, cancellationToken: "short" }, scope), "invalid_portfolio_mine_elevator_fresh_floor_request");
  assert.equal(validatePortfolioMineElevatorFreshFloor(floor, scope), null);
  assert.equal(materializePortfolioMineElevatorFreshFloor(floor, request, scope).currentFloor, 10);
  assert.throws(() => materializePortfolioMineElevatorFreshFloor({ ...floor, requestId: "other_request" }, request, scope), /fresh_floor_correlation_mismatch/);
  assert.throws(() => materializePortfolioMineElevatorFreshFloor({ ...floor, traceId: "other_trace" }, request, scope), /fresh_floor_correlation_mismatch/);
  assert.throws(() => materializePortfolioMineElevatorFreshFloor({ ...floor, executionId: "other_execution" }, request, scope), /fresh_floor_correlation_mismatch/);
  assert.equal(validatePortfolioMineElevatorFreshFloor({ ...floor, scope: { ...scope, saveId: "other_save" } }, scope), "invalid_portfolio_mine_elevator_fresh_floor");
});

test("M8 protocol fixes typed request, cancellation scope, and terminal receipt shape", () => {
  const request = { action: PORTFOLIO_MINE_ELEVATOR_ACTION, requestId: "request_m8", traceId: "trace_m8", idempotencyKey: "idem_m8", selectedCheckpoint: 10, expectedRevision: 1, deadlineMs: 1_030_000, cancellationToken: "cancel_m8_token_1", scope } as const;
  assert.equal(validatePortfolioMineElevatorRequest(request, scope, 1_000_000), null);
  assert.equal(validatePortfolioMineElevatorRequest({ ...request, selectedCheckpoint: 11 }, scope, 1_000_000), "invalid_portfolio_mine_elevator_request");
  const cancel = { action: PORTFOLIO_MINE_ELEVATOR_ACTION, requestId: request.requestId, traceId: request.traceId, executionId: "execution_m8", cancellationToken: request.cancellationToken, scope } as const;
  assert.equal(validatePortfolioMineElevatorCancelRequest(cancel, scope), null);
  assert.equal(validatePortfolioMineElevatorCancelRequest({ ...cancel, cancellationToken: "short" }, scope), "invalid_portfolio_mine_elevator_cancel_request");
  assert.equal(validatePortfolioMineElevatorCancelRequest({ ...cancel, scope: { ...scope, saveId: "other" } }, scope), "invalid_portfolio_mine_elevator_cancel_request");
  const phases = [
    { requestId: request.requestId, traceId: request.traceId, executionId: "execution_m8", phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" },
    { requestId: request.requestId, traceId: request.traceId, executionId: "execution_m8", phase: "accepted", revision: 1, reasonCode: "accepted" },
    { requestId: request.requestId, traceId: request.traceId, executionId: "execution_m8", phase: "transition_started", revision: 2, reasonCode: "mine_elevator_transition_started" },
    { requestId: request.requestId, traceId: request.traceId, executionId: "execution_m8", phase: "postcondition", revision: 3, reasonCode: "postcondition_observed" },
    { requestId: request.requestId, traceId: request.traceId, executionId: "execution_m8", phase: "terminal", revision: 3, reasonCode: "mine_elevator_floor_selected" },
  ] as const;
  const receipt = { requestId: request.requestId, traceId: request.traceId, executionId: "execution_m8", state: "succeeded", revision: 3, reasonCode: "mine_elevator_floor_selected", evidence: { scope, phaseTrace: phases, entryObserved: true, currentFloorBefore: 5, lowestMineLevelBefore: 10, opaqueElevatorTarget: "mine_target", nativeElevatorTransitionObserved: true, currentFloorAfter: 10, lowestMineLevelAfter: 10, lowestMineLevelObserved: true }, postcondition: { selectedCheckpoint: 10, actualCurrentFloor: 10, observedLowestMineLevel: 10, opaqueElevatorTarget: "mine_target", freshObservation: true, sameExecution: true } };
  assert.equal(validatePortfolioMineElevatorReceipt(receipt), null);
  assert.equal(validatePortfolioMineElevatorReceipt({ ...receipt, reasonCode: "execution_armed" }), "invalid_portfolio_mine_elevator_receipt");
  assert.equal(validatePortfolioMineElevatorReceipt({ ...receipt, executionId: "other_execution" }), "invalid_portfolio_mine_elevator_phase_trace");
  assert.equal(validatePortfolioMineElevatorReceipt({ ...receipt, evidence: { ...receipt.evidence, phaseTrace: [phases[0], phases[4]] } }), "invalid_portfolio_mine_elevator_receipt");
  assert.equal(validatePortfolioMineElevatorReceipt({ ...receipt, evidence: { ...receipt.evidence, phaseTrace: phases.map((phase, index) => index === 2 ? { ...phase, reasonCode: "native_elevator_transition_started" } : phase) } }), "invalid_portfolio_mine_elevator_receipt");
});

test("M8 non-success short terminal receipts enforce exact state/reason coherence", () => {
  const request = { action: PORTFOLIO_MINE_ELEVATOR_ACTION, requestId: "request_short", traceId: "trace_short", idempotencyKey: "idem_short", selectedCheckpoint: 10, expectedRevision: 1, deadlineMs: 1_030_000, cancellationToken: "cancel_short_token", scope } as const;
  const fresh = { requestId: request.requestId, traceId: request.traceId, executionId: "execution_short", phase: "fresh_observed", revision: 1, reasonCode: "fresh_observed" } as const;
  const terminal = { ...fresh, phase: "terminal" as const, reasonCode: "adapter_unavailable" as const };
  const base = { requestId: request.requestId, traceId: request.traceId, executionId: "execution_short", state: "blocked" as const, revision: 1, reasonCode: "adapter_unavailable" as const,
    evidence: { scope, phaseTrace: [fresh, terminal], entryObserved: false, currentFloorBefore: 5, lowestMineLevelBefore: 10, opaqueElevatorTarget: "mine_target", nativeElevatorTransitionObserved: false, currentFloorAfter: 5, lowestMineLevelAfter: 10, lowestMineLevelObserved: false },
    postcondition: { selectedCheckpoint: 10, actualCurrentFloor: 5, observedLowestMineLevel: 10, opaqueElevatorTarget: "mine_target", freshObservation: true, sameExecution: true } };
  assert.equal(validatePortfolioMineElevatorReceipt(base), null);
  const noTargetRejected = { ...base, state: "rejected", reasonCode: "invalid_mine_elevator_request", evidence: { ...base.evidence, opaqueElevatorTarget: null, phaseTrace: [fresh, { ...terminal, reasonCode: "invalid_mine_elevator_request" }] }, postcondition: { ...base.postcondition, selectedCheckpoint: null, opaqueElevatorTarget: null } };
  assert.equal(validatePortfolioMineElevatorReceipt(noTargetRejected), null);
  assert.equal(validatePortfolioMineElevatorReceipt({ ...noTargetRejected, state: "succeeded", reasonCode: "mine_elevator_floor_selected", evidence: { ...noTargetRejected.evidence, phaseTrace: [fresh, { ...terminal, reasonCode: "mine_elevator_floor_selected" }] } }), "invalid_portfolio_mine_elevator_receipt");
  for (const [state, reason] of [["cancelled", "cancelled"], ["expired", "deadline_expired"], ["failed", "native_operation_failed"], ["uncertain", "native_operation_uncertain"], ["blocked", "adapter_unavailable"], ["blocked", "portfolio_world_not_ready"], ["blocked", "portfolio_action_not_allowed"], ["rejected", "invalid_mine_elevator_request"], ["rejected", "execution_not_active"], ["rejected", "cancellation_token_mismatch"]] as const) {
    const valid = { ...base, state, reasonCode: reason, evidence: { ...base.evidence, phaseTrace: [fresh, { ...terminal, reasonCode: reason }] } };
    assert.equal(validatePortfolioMineElevatorReceipt(valid), null);
    assert.equal(validatePortfolioMineElevatorReceipt({ ...valid, state: "blocked", reasonCode: "accepted", evidence: { ...valid.evidence, phaseTrace: [fresh, { ...terminal, reasonCode: "accepted" }] } }), "invalid_portfolio_mine_elevator_receipt");
  }
  // These are the complete M8 state/reason policy representatives shared by
  // the C# emitter and this Host validator: unavailable world/policy is
  // blocked, while request/correlation faults are rejected.
  assert.equal(validatePortfolioMineElevatorReceipt({ ...base, state: "uncertain", reasonCode: "execution_not_active", evidence: { ...base.evidence, phaseTrace: [fresh, { ...terminal, reasonCode: "execution_not_active" }] } }), "invalid_portfolio_mine_elevator_receipt");
});

test("Portfolio protocol rejects Farmhand scopes and mutation-shaped snapshots", () => {
  const farmhandScope = { ...scope, integrationId: "stardew" as never };
  assert.equal(validatePortfolioMessage(newPortfolioEnvelope("observe_request", farmhandScope, {}), scope), "invalid_portfolio_envelope");
  assert.equal(validatePortfolioSnapshot({ ...snapshot, capabilities: [] }), "invalid_portfolio_snapshot");
  assert.equal(validatePortfolioSnapshot({ ...snapshot, activeExecution: null }), "invalid_portfolio_snapshot");
  assert.equal(validatePortfolioSnapshot({ ...snapshot, topology: "native_ai_farmhand_multiplayer" }), "invalid_portfolio_snapshot");
  assert.equal(validatePortfolioMessage({ ...newPortfolioEnvelope("snapshot", scope, snapshot), payload: { ...snapshot, bindingGeneration: 2 } }, scope), "portfolio_snapshot_scope_mismatch");
});
