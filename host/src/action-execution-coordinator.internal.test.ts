import assert from "node:assert/strict";
import test from "node:test";
import {
  createActionExecutionCoordinator,
  executionWakeSourceFor,
  normalizeExecutionWake,
  type ActionExecutionAdmission,
  type ActionExecutionCoordinator,
  HostNodeAdmissionService,
} from "./action-execution-coordinator.internal.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import { StardewLogicalActionRecoveryJournal, type NodeAdmissionChallenge } from "./stardew-logical-action-recovery-journal.js";
import { createIntegrationActionCatalog, type GameIntegrationAdapter } from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";
import type { ExecutionReceipt, ExecutionState } from "./protocol.js";

function receipt(overrides: Partial<ExecutionReceipt> = {}): ExecutionReceipt {
  return {
    requestId: "request_01",
    executionId: "execution_01",
    actionId: "move_to_tile",
    state: "accepted" as ExecutionState,
    reasonCode: "accepted",
    revision: 1,
    evidence: null,
    ...overrides,
  };
}

function challenge(overrides: Partial<NodeAdmissionChallenge> = {}): NodeAdmissionChallenge {
  return {
    programId: "program_01", nodeId: "node_source", nodeAttempt: 1, admissionAttempt: 1,
    stopEpoch: 4, scopeIdentity: { scope: "fixture" }, policyIdentity: { identity: "mod-policy_01" },
    catalogRevision: "catalog_01", actionIdentity: "move_to_tile", canonicalBoundArgs: { x: 1, y: 2 },
    derivedResourceClaims: [{ resource: "actor" }], deadlineMs: Date.now() + 10_000, ...overrides,
  };
}

function coordinatorFixture(
  cancelCalls: string[][],
): Readonly<{ coordinator: ActionExecutionCoordinator; cancelCalls: string[][] }> {
  const base: GameIntegrationAdapter = {
    descriptor: Object.freeze({
      integrationId: "test-arcade",
      version: "fixture-v1",
      toolNamePrefix: "arcade_",
    }),
    actionCatalog: createIntegrationActionCatalog([]),
    defaultPolicy: Object.freeze({ policyVersion: 1, deniedActions: [], deniedFamilies: [] }),
    parsePolicy: (value: unknown) => value as never,
    actorId: () => "fixture_actor",
    assertIdentityBinding: () => undefined,
    worldScope: () => null,
    createToolSet: () => ({ observation: [], actions: [], knowledge: [] }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: () => ({
      connected: true,
      capabilities: [],
      capabilityRevision: null,
      snapshotRevision: null,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    readState: () => ({
      connected: true,
      sessionId: null,
      capabilities: [],
      capabilityRevision: null,
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
  const connection: GameConnection = {
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

test("one exact-node admission state machine grants controller-named source and successor nodes without rewriting them", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const seen: NodeAdmissionChallenge[] = [];
  const service = new HostNodeAdmissionService(journal, (item) => {
    seen.push(item);
    return { result: "granted", attachmentGeneration: "attachment_01", policyRevision: "policy_01", catalogRevision: item.catalogRevision };
  });
  const source = challenge();
  const successor = challenge({ nodeId: "node_successor" });
  const [sourceResult, successorResult] = await Promise.all([service.admit(source), service.admit(successor)]);
  assert.equal(sourceResult.result, "granted");
  assert.equal(successorResult.result, "granted");
  assert.deepEqual(seen, [source, successor]);
  if (sourceResult.result === "granted") {
    assert.deepEqual(sourceResult.grant.challenge.canonicalBoundArgs, source.canonicalBoundArgs);
    assert.deepEqual(sourceResult.grant.policyIdentity, source.policyIdentity);
  }
  assert.equal(journal.admissionRecord(source)?.state, "grant_issued");
});

test("node admission binds grants to opaque Mod policy identity and rejects mismatched replay", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const service = new HostNodeAdmissionService(journal, (item) => ({
    result: "granted",
    attachmentGeneration: "attachment_01",
    policyRevision: "host-policy_01",
    catalogRevision: item.catalogRevision,
  }));
  const issued = await service.admit(challenge());
  assert.equal(issued.result, "granted");
  if (issued.result === "granted") assert.deepEqual(issued.grant.policyIdentity, { identity: "mod-policy_01" });

  // Same node lineage but a substituted Mod identity cannot replay its earlier grant.
  const substituted = challenge({ policyIdentity: { identity: "mod-policy_02" } });
  assert.throws(() => journal.admissionRecord(substituted), /node_admission_challenge_mismatch/);
  assert.deepEqual(await service.admit(substituted), { result: "rejected", code: "policy_identity_mismatch" });
});

test("node admission journals before reply and treats write loss, response loss, and validator loss as unavailable", async () => {
  const item = challenge();
  const lostWrite = new HostNodeAdmissionService(
    new StardewLogicalActionRecoveryJournal({ write: () => { throw new Error("disk"); } }),
    () => ({ result: "granted", attachmentGeneration: "attachment_01", policyRevision: "policy_01", catalogRevision: "catalog_01" }),
  );
  assert.deepEqual(await lostWrite.admit(item), { result: "unavailable" });

  const journal = new StardewLogicalActionRecoveryJournal();
  const service = new HostNodeAdmissionService(journal, () => ({ result: "granted", attachmentGeneration: "attachment_01", policyRevision: "policy_01", catalogRevision: "catalog_01" }));
  const issued = await service.admit(item);
  assert.equal(issued.result, "granted");
  // A lost response is replayed from durable grant correlation, not recomputed.
  assert.deepEqual(await service.admit(item), issued);
  const unavailable = new HostNodeAdmissionService(journal, () => { throw new Error("bridge_lost"); });
  assert.deepEqual(await unavailable.admit(challenge({ admissionAttempt: 2 })), { result: "unavailable" });
});

test("node admission deterministically rejects deadline, STOP, catalog, and policy vetoes without calling execute", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const service = new HostNodeAdmissionService(journal, (item) => {
    if (item.stopEpoch !== 4) return { result: "rejected", code: "stop_epoch_closed" };
    if (item.catalogRevision !== "catalog_01") return { result: "rejected", code: "catalog_revision_mismatch" };
    return { result: "rejected", code: "policy_denied" };
  });
  assert.deepEqual(await service.admit(challenge({ deadlineMs: Date.now() - 1 })), { result: "rejected", code: "deadline_expired" });
  assert.deepEqual(await service.admit(challenge({ admissionAttempt: 2, stopEpoch: 5 })), { result: "rejected", code: "stop_epoch_closed" });
  assert.deepEqual(await service.admit(challenge({ admissionAttempt: 3, catalogRevision: "catalog_02" })), { result: "rejected", code: "catalog_revision_mismatch" });
  assert.deepEqual(await service.admit(challenge({ admissionAttempt: 4 })), { result: "rejected", code: "policy_denied" });
});

test("coordinator mints an admission whose response receipt and fact-route receipt are the same bridge transition", async () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  const dispatch = { ...admission.owner, requestId: "request_01" };
  await admission.observer.beforeWrite(dispatch);
  const first = receipt();
  // The Mod fact route delivers the transition before the execute response
  // resolves. Both carry the identical receipt; the second delivery must be an
  // idempotent no-op rather than a false order violation.
  coordinator.receiveReceipt(first);
  assert.doesNotThrow(() => admission.observer.bindReceipt(first));
});

test("coordinator admission observer forwards the ledger beforeWrite settlement", async () => {
  const beforeWrite = ExecutionCorrelationLedger.prototype.beforeWrite;
  const settled = Promise.resolve();
  let called = false;
  ExecutionCorrelationLedger.prototype.beforeWrite = () => {
    called = true;
    return settled;
  };
  try {
    const { coordinator } = coordinatorFixture([]);
    const admission = coordinator.createAdmission();
    const result = admission.observer.beforeWrite({
      ...admission.owner,
      requestId: "request_01",
    });
    assert.equal(typeof (result as Promise<void>).then, "function");
    await result;
    assert.equal(called, true);
  } finally {
    ExecutionCorrelationLedger.prototype.beforeWrite = beforeWrite;
  }
});

test("coordinator admission observer rejects when interruption occurs during ledger beforeWrite", async () => {
  const beforeWrite = ExecutionCorrelationLedger.prototype.beforeWrite;
  let releaseBeforeWrite!: () => void;
  let beforeWriteCalled = false;
  const blocked = new Promise<void>((resolve) => {
    releaseBeforeWrite = resolve;
  });
  ExecutionCorrelationLedger.prototype.beforeWrite = () => {
    beforeWriteCalled = true;
    return blocked;
  };
  try {
    const { coordinator } = coordinatorFixture([]);
    const admission = coordinator.createAdmission();
    const result = admission.observer.beforeWrite({
      ...admission.owner,
      requestId: "request_01",
    });
    await Promise.resolve();
    assert.equal(beforeWriteCalled, true);

    await coordinator.interrupt("runtime_stopped");
    releaseBeforeWrite();

    await assert.rejects(result as Promise<void>, /stale_interruption_admission/);
  } finally {
    ExecutionCorrelationLedger.prototype.beforeWrite = beforeWrite;
  }
});

test("coordinator admission observer fences synchronous ledger admission when STOP is queued before tool continuation", async () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  const result = admission.observer.beforeWrite({
    ...admission.owner,
    requestId: "request_01",
  });
  const interruption = coordinator.interrupt("runtime_stopped");
  await assert.rejects(
    Promise.resolve(result),
    /stale_interruption_admission/,
  );
  // The interrupted pre-write registration still owns the STOP barrier. A
  // terminal Mod fact concludes that barrier without permitting a native write.
  coordinator.receiveReceipt(
    receipt({ state: "rejected", reasonCode: "runtime_stopped" }),
  );
  await interruption;
});

test("coordinator admission observer binds a fresh response through the single audited path", async () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  await admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  const succeeded = receipt({ state: "succeeded", reasonCode: "done", evidence: { detail: "ok" } });
  assert.doesNotThrow(() => admission.observer.bindReceipt(succeeded));
});

test("coordinator rejects an otherwise-identical duplicate delivery with a different action ID", async () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  await admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
  const factReceipt = receipt();
  coordinator.receiveReceipt(factReceipt);
  assert.throws(
    () =>
      admission.observer.bindReceipt({
        ...factReceipt,
        actionId: "chop_tree",
      }),
    /execution_receipt_replay_rejected:non_monotonic_revision/,
  );
});

test("coordinator rejects a duplicate delivery with a different reason code", async () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  await admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
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

test("coordinator rejects receipt order violations fail-closed on the dispatch path", async () => {
  const { coordinator } = coordinatorFixture([]);
  const admission = coordinator.createAdmission();
  await admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
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

test("coordinator rejects success without evidence and mismatched executions", async () => {
  const { coordinator } = coordinatorFixture([]);
  assert.throws(
    () => coordinator.receiveReceipt(receipt({ state: "succeeded", revision: 1, evidence: null })),
    /execution_receipt_replay_rejected:success_without_evidence/,
  );
  const admission = coordinator.createAdmission();
  await admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
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
  await admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
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
  await admission.observer.beforeWrite({ ...admission.owner, requestId: "request_01" });
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
