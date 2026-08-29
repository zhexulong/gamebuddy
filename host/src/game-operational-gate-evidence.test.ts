import assert from "node:assert/strict";
import test from "node:test";
import type { WorldFact } from "./event-pump.js";
import {
  createGameOperationalGateEvidenceProjection,
  GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
  validateGameOperationalGateEvidence,
  type GameStopSettlementSource,
} from "./game-operational-gate-evidence.js";
import type { IntegrationEventSource } from "./integration-launcher.js";
import type {
  GameIntegrationModule,
  IntegrationExecutionReceipt,
  IntegrationReceiptEvidence,
  IntegrationStateView,
} from "./integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";

const nonce = "a".repeat(64);

function receipt(index: 1 | 2, overrides: Partial<IntegrationExecutionReceipt> = {}): IntegrationExecutionReceipt {
  return Object.freeze({
    requestId: `request_0${index}`,
    executionId: `execution_0${index}`,
    actionId: index === 1 ? "move_to_tile" : "inspect_self",
    state: "succeeded",
    reasonCode: index === 1 ? "target_reached" : "inspect_complete",
    revision: index === 1 ? 7 : 9,
    evidence: Object.freeze({ opaque: `native_${index}` }),
    ...overrides,
  });
}

function fact(index: 1 | 2, overrides: Partial<WorldFact> = {}): WorldFact {
  const current = receipt(index);
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: current.executionId,
    revision: current.revision!,
    executionId: current.executionId,
    requestId: current.requestId,
    payload: Object.freeze({}),
    ...overrides,
  });
}

function state(currentReceipt: IntegrationExecutionReceipt | null, overrides: Partial<IntegrationStateView> = {}): IntegrationStateView {
  return Object.freeze({
    connected: true,
    sessionId: "bridge_session_01",
    capabilities: Object.freeze(["move_to_tile", "inspect_self"]),
    capabilityRevision: 10,
    snapshotRevision: 10,
    activeExecution: null,
    latestReceipt: currentReceipt,
    latestReasonCode: null,
    ...overrides,
  });
}

function setup(
  initialState: IntegrationStateView,
  hasCompletionEvidence: (actionId: string, receipt: IntegrationReceiptEvidence) => boolean = () => true,
) {
  let currentState = initialState;
  let factListener: ((value: WorldFact) => void) | undefined;
  let stopListener: ((value: unknown) => void) | undefined;
  let factUnsubscribes = 0;
  let stopUnsubscribes = 0;
  const events: IntegrationEventSource = Object.freeze({
    onFact: (listener) => {
      factListener = listener;
      return () => {
        factUnsubscribes += 1;
        factListener = undefined;
      };
    },
    onLifecycle: () => () => undefined,
  });
  const stopSource: GameStopSettlementSource = Object.freeze({
    onStopSettled: (listener) => {
      stopListener = listener;
      return () => {
        stopUnsubscribes += 1;
        stopListener = undefined;
      };
    },
  });
  const module = Object.freeze({
    readState: () => currentState,
    defaultPolicy: Object.freeze({}),
    actionCatalog: Object.freeze({
      visibleActions: () => Object.freeze([]),
      hasCompletionEvidence,
    }),
  }) as unknown as GameIntegrationModule;
  const projection = createGameOperationalGateEvidenceProjection(
    module,
    Object.freeze({}) as IntegrationConnection,
    events,
    stopSource,
  );
  return {
    projection,
    emit: (value: WorldFact) => factListener?.(value),
    settleStop: () => stopListener?.(Object.freeze({ opaque: true })),
    setState: (value: IntegrationStateView) => {
      currentState = value;
    },
    listening: () => factListener !== undefined,
    stopListening: () => stopListener !== undefined,
    unsubscribeCounts: () => ({ facts: factUnsubscribes, stop: stopUnsubscribes }),
  };
}

function v2Value(overrides: Record<string, unknown> = {}) {
  return {
    schema: GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
    nonceSha256: nonce,
    piSessionId: "pi_session_01",
    surface: "game",
    capabilityRevision: 15,
    capabilityCount: 2,
    transitions: { count: 2, distinctActionCount: 2, freshObservationCount: 2, allPostconditionsObserved: true },
    terminalState: "completed",
    stopSettled: true,
    ...overrides,
  };
}

test("operational Game v2 evidence is an exact content-free schema", () => {
  const value = v2Value();
  assert.deepEqual(validateGameOperationalGateEvidence(value), value);
  assert.equal(validateGameOperationalGateEvidence({ ...value, receiptId: "leak" }), null);
  assert.equal(validateGameOperationalGateEvidence({ ...value, terminalState: "blocked" }), null);
  assert.equal(validateGameOperationalGateEvidence({ ...value, stopSettled: false }), null);
  assert.equal(validateGameOperationalGateEvidence({ ...value, transitions: { ...value.transitions, count: 1 } }), null);
  assert.equal(validateGameOperationalGateEvidence({ ...value, transitions: { ...value.transitions, distinctActionCount: 1 } }), null);
  assert.equal(validateGameOperationalGateEvidence({ ...value, transitions: { ...value.transitions, evidence: {} } }), null);
});

test("v2 projection requires two exact fresh Mod transitions followed by STOP settlement", async () => {
  const harness = setup(state(receipt(1), { capabilityRevision: 12 }));
  const pending = harness.projection.next();
  harness.emit(fact(1));
  harness.settleStop();
  harness.setState(state(receipt(2), { capabilityRevision: 15 }));
  harness.emit(fact(2));
  assert.equal(harness.listening(), false);
  const projected = await pending;
  assert.deepEqual(projected, {
    schema: GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
    surface: "game",
    capabilityRevision: 15,
    capabilityCount: 2,
    transitions: { count: 2, distinctActionCount: 2, freshObservationCount: 2, allPostconditionsObserved: true },
    terminalState: "completed",
    stopSettled: true,
  });
  assert.equal(harness.listening(), false);
  assert.equal(harness.stopListening(), false);
  assert.deepEqual(harness.unsubscribeCounts(), { facts: 1, stop: 1 });
});

test("v2 projection deduplicates replayed lineage and refuses same lineage at a later revision", async () => {
  const first = receipt(1);
  const harness = setup(state(first));
  const pending = harness.projection.next();
  harness.emit(fact(1));
  harness.emit(fact(1));
  harness.setState(state(Object.freeze({ ...first, revision: 8 })));
  harness.emit(fact(1, { revision: 8 }));
  harness.setState(state(receipt(2)));
  harness.emit(fact(2));
  harness.settleStop();
  const projected = await pending;
  assert.equal(projected.transitions.count, 2);
});

test("v2 projection rejects mismatched, stale, unsuccessful, evidence-free, and predicate-false terminal facts", async () => {
  const harness = setup(state(receipt(1)), (actionId) => actionId === "move_to_tile");
  const pending = harness.projection.next();
  harness.emit(fact(1, { source: "host_local_transport" }));
  harness.emit(fact(1, { executionId: "execution_other", correlationId: "execution_other" }));
  harness.setState(state(receipt(1), { snapshotRevision: 6 }));
  harness.emit(fact(1));
  harness.setState(state(receipt(1, { actionId: undefined })));
  harness.emit(fact(1));
  harness.setState(state(receipt(1, { state: "failed" })));
  harness.emit(fact(1));
  harness.setState(state(receipt(1, { evidence: Object.freeze({}) })));
  harness.emit(fact(1));
  harness.setState(state(receipt(2)));
  harness.emit(fact(2));
  harness.settleStop();
  harness.projection.close();
  await assert.rejects(pending, /game_operational_gate_evidence_unavailable/);
});

test("v2 projection fails closed when final state is stale or unreadable", async () => {
  const harness = setup(state(receipt(1), { capabilityRevision: 12 }));
  const pending = harness.projection.next();
  harness.emit(fact(1));
  harness.setState(state(receipt(2), { capabilityRevision: 15 }));
  harness.emit(fact(2));
  harness.setState(state(receipt(2), { snapshotRevision: 8 }));
  harness.settleStop();
  harness.projection.close();
  await assert.rejects(pending, /game_operational_gate_evidence_unavailable/);

  const disconnected = setup(state(receipt(1), { capabilityRevision: 12 }));
  const disconnectedPending = disconnected.projection.next();
  disconnected.emit(fact(1));
  disconnected.setState(state(receipt(2), { capabilityRevision: 15 }));
  disconnected.emit(fact(2));
  disconnected.setState(state(receipt(2), { connected: false }));
  disconnected.settleStop();
  disconnected.projection.close();
  await assert.rejects(disconnectedPending, /game_operational_gate_evidence_unavailable/);

  const rollback = setup(state(receipt(1), { capabilityRevision: 12 }));
  const rollbackPending = rollback.projection.next();
  rollback.emit(fact(1));
  rollback.setState(state(receipt(2), { capabilityRevision: 15 }));
  rollback.emit(fact(2));
  rollback.setState(state(receipt(2), { capabilityRevision: 14 }));
  rollback.settleStop();
  rollback.projection.close();
  await assert.rejects(rollbackPending, /game_operational_gate_evidence_unavailable/);
});

test("v2 projection is one-waiter, closes both subscriptions exactly once, and can be closed idempotently", async () => {
  const harness = setup(state(receipt(1)));
  const pending = harness.projection.next();
  await assert.rejects(harness.projection.next(), /game_operational_gate_evidence_unavailable/);
  harness.projection.close();
  await assert.rejects(pending, /game_operational_gate_evidence_unavailable/);
  assert.deepEqual(harness.unsubscribeCounts(), { facts: 1, stop: 1 });
  harness.projection.close();
  assert.deepEqual(harness.unsubscribeCounts(), { facts: 1, stop: 1 });
});
