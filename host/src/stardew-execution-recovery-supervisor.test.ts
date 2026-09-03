import assert from "node:assert/strict";
import test from "node:test";
import {
  createActionExecutionCoordinator,
  type ActionExecutionCoordinatorOptions,
} from "./action-execution-coordinator.internal.js";
import { StardewLogicalActionRecoveryJournal } from "./stardew-logical-action-recovery-journal.js";
import type { GameConnection } from "./game-connection.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import type { ExecutionReceipt } from "./protocol.js";
import {
  isExactReceiptRecoveryPort,
  StardewExecutionRecoverySupervisor,
} from "./stardew-execution-recovery-supervisor.js";

function receipt(state: ExecutionReceipt["state"]): ExecutionReceipt {
  return {
    requestId: "request_recovery_01",
    executionId: "execution_recovery_01",
    actionId: "till_soil",
    state,
    reasonCode: state === "succeeded" ? "soil_tilled" : "accepted",
    revision: state === "succeeded" ? 2 : 1,
    evidence: state === "succeeded" ? { targetId: "soil_01" } : null,
  };
}

function coordinatorFixture(options: ActionExecutionCoordinatorOptions = {}) {
  const connection: GameConnection = Object.freeze({
    scope: Object.freeze({ integrationId: "stardew" }),
    module: Object.freeze({
      ...STARDEW_GAME_INTEGRATION_ADAPTER,
      cancelExecution: async () => receipt("cancelled"),
    }),
    state: Object.freeze({}),
  });
  return createActionExecutionCoordinator(connection, options);
}

function recoveryRecord(id = "logical_recovery_01") {
  const deadlineMs = Date.now() + 10_000;
  return {
    logicalActionId: id,
    dispatchOrdinal: 1,
    ownerId: "old_owner",
    epoch: 3,
    requestId: "request_recovery_01",
    idempotencyKey: "idempotency_recovery_01",
    actionId: "till_soil",
    canonicalRequest: {
      requestId: "request_recovery_01",
      idempotencyKey: "idempotency_recovery_01",
      action: "till_soil",
      args: { x: 1, y: 2 },
      expectedRevision: 1,
      deadlineMs,
    },
    canonicalArgs: { x: 1, y: 2 },
    expectedRevision: 1,
    deadlineMs,
    scope: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    bindingIdentity: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
  } as const;
}

test("fresh coordinator rehydrates recoverable records with a new lifecycle owner", async () => {
  const journal = new StardewLogicalActionRecoveryJournal({ initialRecords: [{ ...recoveryRecord(), state: "recovery_pending" }] });
  const coordinator = coordinatorFixture({ recoveryJournal: journal });
  const [dispatch] = coordinator.uncertainDispatches();
  assert.equal(dispatch?.requestId, "request_recovery_01");
  assert.equal(dispatch?.ownerId, "old_owner");
  const admission = coordinator.createAdmission();
  assert.notEqual(admission.owner.ownerId, "old_owner");
  assert.equal(admission.owner.epoch, 0);
});

test("recovery supervisor queries each uncertain immutable tuple once and admits only through coordinator receipt admission", async () => {
  const journal = new StardewLogicalActionRecoveryJournal({ initialRecords: [{ ...recoveryRecord(), state: "recovery_pending" }] });
  const coordinator = coordinatorFixture({ recoveryJournal: journal });

  const calls: unknown[] = [];
  const supervisor = new StardewExecutionRecoverySupervisor(coordinator);
  const result = await supervisor.recoverFromFreshBinding({
    scope: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    bindingIdentity: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    queryExecutionReceipt: async (query) => {
      calls.push(query);
      return receipt("succeeded");
    },
  });

  assert.deepEqual(calls, [{ requestId: "request_recovery_01", idempotencyKey: "idempotency_recovery_01" }]);
  assert.deepEqual(result, [{ requestId: "request_recovery_01", result: "admitted", state: "succeeded" }]);
  assert.deepEqual(coordinator.uncertainDispatches(), []);
  assert.equal(journal.record("logical_recovery_01")?.state, "terminal_settled");
});

test("isExactReceiptRecoveryPort accepts only a frozen exact stable port", () => {
  const identity = Object.freeze({
    product: "stardew" as const,
    continuityId: "continuity_01",
    integrationId: "stardew" as const,
    saveId: "save_01",
    worldId: "world_01",
  });
  assert.equal(
    isExactReceiptRecoveryPort(Object.freeze({ scope: identity, bindingIdentity: identity, queryExecutionReceipt: async () => receipt("succeeded") })),
    true,
  );
  assert.equal(isExactReceiptRecoveryPort({}), false);
  assert.equal(isExactReceiptRecoveryPort(Object.freeze({ scope: identity, bindingIdentity: identity, queryExecutionReceipt: 1 })), false);
  assert.equal(isExactReceiptRecoveryPort(Object.freeze({ scope: {}, bindingIdentity: {}, queryExecutionReceipt: async () => ({}) })), false);
  assert.equal(isExactReceiptRecoveryPort(null), false);
  assert.equal(isExactReceiptRecoveryPort(undefined), false);
});

test("receipt_not_found and mismatched receipts become durable recovery_required", async () => {
  const journal = new StardewLogicalActionRecoveryJournal({ initialRecords: [{ ...recoveryRecord(), state: "recovery_pending" }] });
  const coordinator = coordinatorFixture({ recoveryJournal: journal });
  const supervisor = new StardewExecutionRecoverySupervisor(coordinator);

  const missing = await supervisor.recoverFromFreshBinding({
    scope: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    bindingIdentity: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    queryExecutionReceipt: async () => {
      throw new Error("bridge_rejected:receipt_not_found");
    },
  });
  assert.deepEqual(missing, [
    { requestId: "request_recovery_01", result: "recovery_required", reasonCode: "receipt_not_found" },
  ]);
  assert.equal(coordinator.uncertainDispatches().length, 0);
  assert.equal(journal.record("logical_recovery_01")?.state, "recovery_required");

  const mismatchJournal = new StardewLogicalActionRecoveryJournal({ initialRecords: [{ ...recoveryRecord(), state: "recovery_pending" }] });
  const mismatchCoordinator = coordinatorFixture({ recoveryJournal: mismatchJournal });
  const mismatch = await new StardewExecutionRecoverySupervisor(mismatchCoordinator).recoverFromFreshBinding({
    scope: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    bindingIdentity: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    queryExecutionReceipt: async () => ({ ...receipt("succeeded"), requestId: "other_request" }),
  });
  assert.deepEqual(mismatch, [
    { requestId: "request_recovery_01", result: "recovery_required", reasonCode: "receipt_request_mismatch" },
  ]);
  assert.equal(mismatchJournal.record("logical_recovery_01")?.state, "recovery_required");
});

test("nonterminal exact receipt remains recoverable and query failure becomes durable recovery_required", async () => {
  const journal = new StardewLogicalActionRecoveryJournal({ initialRecords: [{ ...recoveryRecord(), state: "recovery_pending" }] });
  const coordinator = coordinatorFixture({ recoveryJournal: journal });
  const nonterminal = await new StardewExecutionRecoverySupervisor(coordinator).recoverFromFreshBinding({
    scope: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    bindingIdentity: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    queryExecutionReceipt: async () => receipt("running"),
  });
  assert.deepEqual(nonterminal, [{ requestId: "request_recovery_01", result: "admitted", state: "running" }]);
  assert.equal(journal.record("logical_recovery_01")?.state, "recovery_pending");
  assert.equal(coordinator.uncertainDispatches().length, 0);

  const failedJournal = new StardewLogicalActionRecoveryJournal({ initialRecords: [{ ...recoveryRecord(), state: "recovery_pending" }] });
  const failedCoordinator = coordinatorFixture({ recoveryJournal: failedJournal });
  const failed = await new StardewExecutionRecoverySupervisor(failedCoordinator).recoverFromFreshBinding({
    scope: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    bindingIdentity: { product: "stardew", continuityId: "continuity_01", integrationId: "stardew", saveId: "save_01", worldId: "world_01" },
    queryExecutionReceipt: async () => { throw new Error("bridge_rejected:bridge_timeout"); },
  });
  assert.deepEqual(failed, [
    { requestId: "request_recovery_01", result: "recovery_required", reasonCode: "bridge_timeout" },
  ]);
  assert.equal(failedJournal.record("logical_recovery_01")?.state, "recovery_required");
});


test("scope or binding mismatch does not query or admit and durably requires recovery", async () => {
  const stableIdentity = {
    product: "stardew",
    continuityId: "continuity_01",
    integrationId: "stardew",
    saveId: "save_01",
    worldId: "world_01",
  } as const;
  for (const [field, port] of [
    ["scope", { scope: { ...stableIdentity, saveId: "other" }, bindingIdentity: stableIdentity }],
    ["binding", { scope: stableIdentity, bindingIdentity: { ...stableIdentity, worldId: "other" } }],
  ] as const) {
    const journal = new StardewLogicalActionRecoveryJournal({ initialRecords: [{ ...recoveryRecord(), state: "recovery_pending" }] });
    let queried = false;
    const outcome = await new StardewExecutionRecoverySupervisor(coordinatorFixture({ recoveryJournal: journal })).recoverFromFreshBinding({
      ...port,
      queryExecutionReceipt: async () => { queried = true; return receipt("succeeded"); },
    });
    assert.equal(queried, false, `${field} mismatch must not query`);
    assert.deepEqual(outcome, [{ requestId: "request_recovery_01", result: "recovery_required", reasonCode: `receipt_${field}_mismatch` }]);
    assert.equal(journal.record("logical_recovery_01")?.state, "recovery_required");
  }
});
