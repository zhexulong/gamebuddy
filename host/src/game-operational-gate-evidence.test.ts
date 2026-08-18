import assert from "node:assert/strict";
import test from "node:test";

import {
  createGameOperationalGateEvidenceProjection,
  GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
  validateGameOperationalGateEvidence,
} from "./game-operational-gate-evidence.js";
import type { WorldFact } from "./event-pump.js";
import type { IntegrationEventSource } from "./integration-launcher.js";
import type { GameIntegrationModule, IntegrationStateView } from "./integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";

const nonce = "a".repeat(64);

function terminalFact(): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution_01",
    revision: 7,
    executionId: "execution_01",
    requestId: "request_01",
    payload: Object.freeze({}),
  });
}

function setup(state: IntegrationStateView, hasCompletionEvidence: (actionId: string) => boolean = () => true) {
  let listener: ((fact: WorldFact) => void) | undefined;
  const events: IntegrationEventSource = Object.freeze({
    onFact: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    onLifecycle: () => () => undefined,
  });
  const module = Object.freeze({
    readState: () => state,
    defaultPolicy: Object.freeze({}),
    actionCatalog: Object.freeze({
      visibleActions: () => Object.freeze([{ actionId: "move_to_tile" }, { actionId: "till_soil" }]),
      hasCompletionEvidence: hasCompletionEvidence,
    }),
  }) as unknown as GameIntegrationModule;
  const connection = Object.freeze({}) as IntegrationConnection;
  return {
    projection: createGameOperationalGateEvidenceProjection(module, connection, events),
    emit: (fact: WorldFact) => listener?.(fact),
  };
}

test("operational Game evidence is a strict content-free schema", () => {
  const value = {
    schema: GAME_OPERATIONAL_GATE_EVIDENCE_SCHEMA,
    nonceSha256: nonce,
    piSessionId: "pi_session_01",
    surface: "game",
    snapshotRevision: 8,
    capabilityRevision: 8,
    capabilityCount: 3,
    terminalReceipt: { state: "succeeded", revision: 7, postconditionObserved: true },
  };
  assert.deepEqual(validateGameOperationalGateEvidence(value), value);
  assert.equal(validateGameOperationalGateEvidence({ ...value, rawReceipt: {} }), null);
  assert.equal(validateGameOperationalGateEvidence({ ...value, surface: "chat" }), null);
  assert.equal(
    validateGameOperationalGateEvidence({ ...value, terminalReceipt: { ...value.terminalReceipt, evidence: {} } }),
    null,
  );
});

test("operational Game evidence refuses a correlated receipt without a Mod-originated capability revision", async () => {
  const state: IntegrationStateView = Object.freeze({
    connected: true,
    sessionId: "bridge_session_01",
    capabilities: Object.freeze(["move_to_tile", "inspect_self"]),
    snapshotRevision: 8,
    activeExecution: null,
    latestReceipt: Object.freeze({
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "target_reached",
      revision: 7,
      evidence: Object.freeze({ detail: "opaque_native_postcondition" }),
    }),
    latestReasonCode: null,
  });
  const { projection, emit } = setup(state);
  const pending = projection.next();
  emit(terminalFact());
  projection.close();
  await assert.rejects(pending, /game_operational_gate_evidence_unavailable/);
});

test("operational Game evidence refuses a visible action's postcondition when no receipt-to-action mapping exists", async () => {
  const state: IntegrationStateView = Object.freeze({
    connected: true,
    sessionId: "bridge_session_01",
    capabilities: Object.freeze(["move_to_tile", "till_soil"]),
    snapshotRevision: 8,
    activeExecution: null,
    latestReceipt: Object.freeze({
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "target_reached",
      revision: 7,
      evidence: Object.freeze({ detail: "only_move_to_tile_matches" }),
    }),
    latestReasonCode: null,
  });
  const { projection, emit } = setup(state, (actionId) => actionId === "move_to_tile");
  const pending = projection.next();
  emit(terminalFact());
  projection.close();
  await assert.rejects(pending, /game_operational_gate_evidence_unavailable/);
});

test("operational Game evidence fails closed for missing postcondition or stale snapshot", async () => {
  const state: IntegrationStateView = Object.freeze({
    connected: true,
    sessionId: "bridge_session_01",
    capabilities: Object.freeze(["move_to_tile"]),
    snapshotRevision: 6,
    activeExecution: null,
    latestReceipt: Object.freeze({
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "target_reached",
      revision: 7,
      evidence: null,
    }),
    latestReasonCode: null,
  });
  const { projection, emit } = setup(state);
  const pending = projection.next();
  emit(terminalFact());
  projection.close();
  await assert.rejects(pending, /game_operational_gate_evidence_unavailable/);
});
