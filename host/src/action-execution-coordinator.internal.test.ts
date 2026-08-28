import assert from "node:assert/strict";
import test from "node:test";
import fc from "./test-support/fast-check.js";
import {
  createActionExecutionCoordinator,
  executionWakeSourceFor,
  normalizeExecutionWake,
  type ActionExecutionAdmission,
  type ActionExecutionCoordinator,
} from "./action-execution-coordinator.internal.js";
import { createIntegrationActionCatalog, type GameIntegrationModule } from "./integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";
import type { ExecutionReceipt, ExecutionState } from "./protocol.js";

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    requestId: "request_01",
    executionId: "execution_01",
    state: "accepted" as ExecutionState,
    reasonCode: "accepted",
    revision: 1,
    evidence: null,
    ...overrides,
  };
}

function coordinatorFixture(
  cancelCalls: string[][],
): Readonly<{ coordinator: ActionExecutionCoordinator; cancelCalls: string[][] }> {
  const base: GameIntegrationModule = {
    descriptor: Object.freeze({
      integrationId: "test-arcade",
      version: "fixture-v1",
      toolNamePrefix: "arcade_",
    }),
    actionCatalog: createIntegrationActionCatalog([]),
    defaultPolicy: Object.freeze({ policyVersion: 1, deniedActions: [], deniedFamilies: [] }),
    parsePolicy: (value: unknown) => value as never,
    assertIdentityBinding: () => undefined,
    worldScope: () => null,
    createToolSet: () => ({ observation: [], actions: [], knowledge: [] }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: () => ({
      connected: true,
      capabilities: [],
      snapshotRevision: null,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    readState: () => ({
      connected: true,
      sessionId: null,
      capabilities: [],
      snapshotRevision: null,
      activeExecution: null,
      latestReceipt: null,
      latestReasonCode: null,
    }),
    cancelExecution: () => "cancelled",
    parseReceipt: () => null,
    actionIdForToolName: () => null,
    isCancellationTool: () => false,
  };
  const connection: IntegrationConnection = {
    scope: { integrationId: "test-arcade" },
    module: {
      ...base,
      cancelExecution: (_connection_, requestId, executionId, reasonCode) => {
        cancelCalls.push([requestId, executionId, reasonCode]);
        return "cancelled";
      },
    },
    state: { connected: true },
  };
  return { coordinator: createActionExecutionCoordinator(connection), cancelCalls };
}

test("coordinator mints an admission whose response receipt and fact-route receipt are the same bridge transition", () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  const dispatch = { ...admission.owner, requestId: "request_01" };
  admission.observer.beforeWrite(dispatch);
  const first = receipt();
  // The Mod fact route delivers the transition before the execute response
  // resolves. Both carry the identical receipt; the second delivery must be an
  // idempotent no-op rather than a false order violation.
  coordinator.receiveReceipt(first);
  assert.doesNotThrow(() => admission.observer.bindReceipt(first));
});

test("coordinator admission observer binds a fresh response through the single audited path", () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  const succeeded = receipt({ state: "succeeded", reasonCode: "done", evidence: { detail: "ok" } });
  assert.doesNotThrow(() => admission.observer.bindReceipt(succeeded));
});

test("coordinator rejects a duplicate delivery with a different reason code", () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  const factReceipt = receipt({ state: "accepted", reasonCode: "accepted_from_fact" });
  coordinator.receiveReceipt(factReceipt);
  assert.throws(
    () =>
      admission.observer.bindReceipt({
        ...factReceipt,
        reasonCode: "different_response_reason",
      }),
    /execution_receipt_replay_rejected:non_monotonic_revision/,
  );
});

test("coordinator rejects receipt order violations fail-closed on the dispatch path", () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  assert.doesNotThrow(() => coordinator.receiveReceipt(receipt({ state: "accepted", revision: 1 })));
  const succeeded = receipt({ state: "succeeded", revision: 2, evidence: { detail: "ok" } });
  assert.doesNotThrow(() => coordinator.receiveReceipt(succeeded));
  // A genuine transition regression can never be admitted through the response
  // or fact route: it must fail closed before it can reach the correlation ledger.
  assert.throws(
    () => coordinator.receiveReceipt(receipt({ state: "running", revision: 3 })),
    /execution_receipt_replay_rejected:terminal_state_rewritten/,
  );
  // A regression to a lower revision is rejected before any state question.
  assert.throws(
    () => coordinator.receiveReceipt(receipt({ state: "failed", revision: 2 })),
    /execution_receipt_replay_rejected:non_monotonic_revision/,
  );
});

test("coordinator rejects success without evidence and mismatched executions", () => {
  const { coordinator } = coordinatorFixture([]);
  assert.throws(
    () => coordinator.receiveReceipt(receipt({ state: "succeeded", revision: 1, evidence: null })),
    /execution_receipt_replay_rejected:success_without_evidence/,
  );
  const admission = coordinator.createAdmission();
  admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  coordinator.receiveReceipt(receipt({ state: "accepted", revision: 1 }));
  assert.throws(
    () => coordinator.receiveReceipt({ ...receipt({ state: "accepted", revision: 2 }), requestId: "request_02" }),
    /execution_receipt_replay_rejected:execution_request_mismatch/,
  );
});

test("coordinator exact cancel is owner-bound and epoch cancellation reaches only module.cancelExecution", async () => {
  const cancelCalls: string[][] = [];
  const { coordinator } = coordinatorFixture(cancelCalls);
  const admission = coordinator.createAdmission() as ActionExecutionAdmission;
  const epoch = admission.owner.epoch;
  admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  coordinator.receiveReceipt(receipt({ state: "accepted", revision: 1 }));
  // The admission's owner is fixed at minting time; a wrong tuple or a foreign
  // admission's owner can never target this pre-write registration.
  const otherAdmission = coordinator.createAdmission();
  assert.throws(
    () => otherAdmission.cancelExact("request_01", "execution_01", "forged"),
    /unknown_execution_correlation/,
  );
  assert.throws(
    () => admission.cancelExact("request_01", "other-execution", "forged"),
    /unknown_execution_correlation/,
  );
  await coordinator.cancelEpoch(epoch, "stop_all");
  assert.deepEqual(cancelCalls, [["request_01", "execution_01", "stop_all"]]);
});

test("coordinator interrupt seals admission and settles owned cancellation once", async () => {
  const cancelCalls: string[][] = [];
  const { coordinator } = coordinatorFixture(cancelCalls);
  const admission = coordinator.createAdmission();
  admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  coordinator.receiveReceipt(receipt({ state: "accepted", revision: 1 }));
  await coordinator.interrupt("runtime_stopped");
  assert.deepEqual(cancelCalls, [["request_01", "execution_01", "runtime_stopped"]]);
  // A sealed epoch must refuse every subsequent pre-write on any admission,
  // including ones minted after the interruption boundary.
  const stale = coordinator.createAdmission();
  assert.throws(
    () => stale.observer.beforeWrite({ ...stale.owner, requestId: "request_02" }),
    /stale_interruption_admission/,
  );
});

test("coordinator receiveWake shares one fail-closed wake normalization", () => {
  const { coordinator } = coordinatorFixture([]);
  assert.deepEqual(
    coordinator.receiveWake({
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "done",
    }),
    {
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "done",
    },
  );
  assert.deepEqual(coordinator.receiveWake({ kind: "invalidated", reasonCode: "fenced" }), {
    kind: "invalidated",
    reasonCode: "fenced",
  });
  assert.equal(
    coordinator.receiveWake({ kind: "terminal", requestId: "", executionId: "x", state: "s", reasonCode: "r" }),
    null,
  );
  assert.equal(coordinator.receiveWake({ kind: "disconnected", reasonCode: "" }), null);
  assert.equal(coordinator.receiveWake(null), null);
});

test("coordinator wake helper lookup and normalization remain launcher-compatible", () => {
  const source = { onExecutionWake: () => () => undefined };
  assert.equal(executionWakeSourceFor({ executionWakeSource: source }), source);
  assert.equal(executionWakeSourceFor({}), undefined);
  assert.equal(executionWakeSourceFor(null), undefined);
  assert.deepEqual(normalizeExecutionWake({ kind: "disconnected", reasonCode: "pipe_closed" }), {
    kind: "disconnected",
    reasonCode: "pipe_closed",
  });
  assert.deepEqual(normalizeExecutionWake({ kind: "invalidated", reasonCode: "pipe_closed" }), {
    kind: "invalidated",
    reasonCode: "pipe_closed",
  });
});
