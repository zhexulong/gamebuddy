import assert from "node:assert/strict";
import test from "node:test";

import fc from "./test-support/fast-check.js";
import {
  type ActionBatch,
  type ActionExecutionAdmission,
  type ActionExecutionCoordinator,
  createActionExecutionCoordinator,
  executionWakeSourceFor,
  normalizeExecutionWake,
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

test("coordinator executes ActionBatch sequentially when all actions succeed", async () => {
  const { coordinator } = coordinatorFixture([]);
  const executedActions: string[] = [];

  const batch: ActionBatch = {
    batchId: "batch_01",
    actions: [
      {
        actionId: "move_1",
        requestId: "req_1",
        execute: async () => {
          executedActions.push("move_1");
          return receipt({
            requestId: "req_1",
            executionId: "exec_1",
            state: "succeeded",
            reasonCode: "arrived",
            evidence: { x: 1 },
          });
        },
      },
      {
        actionId: "till_2",
        requestId: "req_2",
        execute: async () => {
          executedActions.push("till_2");
          return receipt({
            requestId: "req_2",
            executionId: "exec_2",
            state: "succeeded",
            revision: 2,
            reasonCode: "tilled",
            evidence: { tile: "1,1" },
          });
        },
      },
    ],
  };

  const result = await coordinator.executeBatch(batch);
  assert.equal(result.batchId, "batch_01");
  assert.equal(result.completedCount, 2);
  assert.equal(result.failedFast, false);
  assert.equal(result.interrupted, false);
  assert.deepEqual(executedActions, ["move_1", "till_2"]);
  assert.equal(result.receipts.length, 2);
});

test("coordinator executes ActionBatch with Fail-Fast semantics on action failure", async () => {
  const { coordinator } = coordinatorFixture([]);
  const executedActions: string[] = [];

  const batch: ActionBatch = {
    batchId: "batch_fail_fast",
    actions: [
      {
        actionId: "action_1",
        requestId: "req_1",
        execute: async () => {
          executedActions.push("action_1");
          return receipt({
            requestId: "req_1",
            executionId: "exec_1",
            state: "succeeded",
            reasonCode: "done",
            evidence: { ok: true },
          });
        },
      },
      {
        actionId: "action_2_fail",
        requestId: "req_2",
        execute: async () => {
          executedActions.push("action_2_fail");
          return receipt({
            requestId: "req_2",
            executionId: "exec_2",
            state: "failed",
            revision: 2,
            reasonCode: "no_energy",
            evidence: null,
          });
        },
      },
      {
        actionId: "action_3_unreached",
        requestId: "req_3",
        execute: async () => {
          executedActions.push("action_3_unreached");
          return receipt({
            requestId: "req_3",
            executionId: "exec_3",
            state: "succeeded",
            revision: 3,
            reasonCode: "done",
            evidence: {},
          });
        },
      },
    ],
  };

  const result = await coordinator.executeBatch(batch);
  assert.equal(result.completedCount, 1);
  assert.equal(result.failedFast, true);
  assert.equal(result.interrupted, false);
  assert.deepEqual(executedActions, ["action_1", "action_2_fail"]);
  assert.equal(result.receipts.length, 3);
  assert.equal(result.receipts[2]?.state, "cancelled");
  assert.equal(result.receipts[2]?.reasonCode, "batch_fail_fast_aborted");
});

test("coordinator intercepts ActionBatch upon Epoch interruption", async () => {
  const { coordinator } = coordinatorFixture([]);
  const executedActions: string[] = [];

  const admission = coordinator.createAdmission();
  const batch: ActionBatch = {
    batchId: "batch_epoch_interrupt",
    epoch: admission.owner.epoch,
    actions: [
      {
        actionId: "action_1",
        requestId: "req_1",
        execute: async () => {
          executedActions.push("action_1");
          // Trigger global interruption during first action
          await coordinator.interrupt("voice_stopped_and_halted");
          return receipt({
            requestId: "req_1",
            executionId: "exec_1",
            state: "succeeded",
            reasonCode: "done",
            evidence: { ok: true },
          });
        },
      },
      {
        actionId: "action_2",
        requestId: "req_2",
        execute: async () => {
          executedActions.push("action_2");
          return receipt({
            requestId: "req_2",
            executionId: "exec_2",
            state: "succeeded",
            reasonCode: "done",
            evidence: { ok: true },
          });
        },
      },
    ],
  };

  const result = await coordinator.executeBatch(batch, admission);
  assert.equal(result.interrupted, true);
  assert.deepEqual(executedActions, ["action_1"]);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.receipts[1]?.state, "cancelled");
  assert.equal(result.receipts[1]?.reasonCode, "epoch_interrupted");
});

test("coordinator: PBT - ActionBatch causal invariant under random batch sizes and failure points", async () => {
  await fc.assertAsync(
    fc.property(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 0, max: 12 }), async (batchSize, failIndex) => {
      const { coordinator } = coordinatorFixture([]);
      const executedActions: number[] = [];

      const actions = Array.from({ length: batchSize }, (_, i) => ({
        actionId: `action_${i}`,
        requestId: `req_${i}`,
        execute: async () => {
          executedActions.push(i);
          if (i === failIndex) {
            return receipt({
              requestId: `req_${i}`,
              executionId: `exec_${i}`,
              state: "failed",
              revision: i + 1,
              reasonCode: "simulated_action_failure",
              evidence: null,
            });
          }
          return receipt({
            requestId: `req_${i}`,
            executionId: `exec_${i}`,
            state: "succeeded",
            revision: i + 1,
            reasonCode: "ok",
            evidence: { step: i },
          });
        },
      }));

      const batch: ActionBatch = {
        batchId: `batch_pbt_${batchSize}_${failIndex}`,
        actions,
      };

      const result = await coordinator.executeBatch(batch);

      // Invariant 1: Total receipts matches batch size
      assert.equal(result.receipts.length, batchSize);

      if (failIndex < batchSize) {
        // Failure occurred
        assert.equal(result.failedFast, true);
        // Actions up to and including failIndex were executed
        assert.equal(executedActions.length, failIndex + 1);
        // Subsequent actions were never executed and are marked batch_fail_fast_aborted
        for (let j = failIndex + 1; j < batchSize; j++) {
          assert.equal(result.receipts[j]?.state, "cancelled");
          assert.equal(result.receipts[j]?.reasonCode, "batch_fail_fast_aborted");
        }
      } else {
        // All succeeded
        assert.equal(result.failedFast, false);
        assert.equal(executedActions.length, batchSize);
        assert.equal(result.completedCount, batchSize);
      }
    }),
    { numRuns: 50 },
  );
});
