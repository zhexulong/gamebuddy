import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExactCapabilities,
  assertImmediateReceipt,
  assertPostTerminalRevision,
  assertReceiptIdentity,
  createNativeScope,
  deadlineAfter,
  executeFresh,
  NativeSmokeHarnessError,
  observeFresh,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const accepted = {
  requestId: "request-1",
  executionId: "execution-1",
  state: "accepted",
  reasonCode: "accepted",
  revision: 7,
  evidence: "secret-native-detail",
};

function hasErrorCode(expected) {
  return (error) => {
    assert.ok(error instanceof NativeSmokeHarnessError);
    return error.code === expected;
  };
}

test("deadlineAfter creates a safe bounded absolute deadline", () => {
  assert.equal(deadlineAfter(15_000, 1000), 16_000);
  assert.throws(() => deadlineAfter(0, 1000), hasErrorCode("invalid_native_request_timeout"));
  assert.throws(() => deadlineAfter(60_001, 1000), hasErrorCode("invalid_native_request_timeout"));
  assert.throws(() => deadlineAfter(1, Number.MAX_SAFE_INTEGER), hasErrorCode("invalid_native_deadline_clock"));
});

test("createNativeScope is Stardew-local and excludes credentials", () => {
  const scope = createNativeScope({
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "secret-token",
  });
  assert.deepEqual(scope, {
    integrationId: "stardew",
    saveId: "save",
    worldId: "world",
    playerId: "player",
    companionId: "companion",
  });
  assert.equal(Object.isFrozen(scope), true);
  assert.doesNotMatch(JSON.stringify(scope), /secret-token|PipeName|BridgeToken/);
});

test("executeFresh binds the current revision and bounded deadline", async () => {
  const calls = [];
  const client = {
    state: { snapshot: { revision: 7 } },
    execute: async (request) => {
      calls.push(request);
      return accepted;
    },
  };
  const snapshot = { revision: 7, actionable: true };
  const receipt = await executeFresh(client, {
    action: "move_to_tile",
    args: { x: 2, y: 3 },
    snapshot,
    requestId: accepted.requestId,
    idempotencyKey: "idem-1",
    timeoutMs: 15_000,
  });
  assert.equal(receipt, accepted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedRevision, 7);
  assert.equal(calls[0].deadlineMs > Date.now(), true);
  assert.equal(calls[0].deadlineMs <= Date.now() + 15_000, true);
});

test("executeFresh independently requires a returned execution identity", async () => {
  const client = {
    execute: async () => ({ requestId: "request-1", state: "accepted" }),
  };
  await assert.rejects(
    executeFresh(client, {
      action: "move_to_tile",
      args: { x: 2, y: 3 },
      snapshot: { revision: 7, actionable: true },
      requestId: "request-1",
      idempotencyKey: "idem-1",
      timeoutMs: 15_000,
    }),
    hasErrorCode("invalid_native_receipt_execution_id"),
  );
  assert.throws(
    () => assertImmediateReceipt({ executionId: "execution-1", requestId: "other" }, { requestId: "request-1" }),
    hasErrorCode("native_receipt_request_id_mismatch"),
  );
});

test("exact capabilities and post-terminal revision binding fail closed", () => {
  const snapshot = { revision: 9, capabilities: ["move_to_tile", "cancel_active_execution", "inspect_self"] };
  assertExactCapabilities(snapshot, ["inspect_self", "cancel_active_execution", "move_to_tile"]);
  assert.throws(
    () => assertExactCapabilities(snapshot, ["inspect_self", "move_to_tile"]),
    hasErrorCode("native_capability_surface_mismatch"),
  );
  assertPostTerminalRevision(snapshot, { requestId: "request-1", executionId: "execution-1", revision: 9 });
  assert.throws(
    () => assertPostTerminalRevision({ revision: 10 }, { requestId: "request-1", executionId: "execution-1", revision: 9 }),
    hasErrorCode("native_post_terminal_revision_mismatch"),
  );
});

test("executeFresh fails closed for a stale snapshot", async () => {
  const client = {
    state: { snapshot: { revision: 8 } },
    execute: async () => accepted,
  };
  await assert.rejects(
    executeFresh(client, {
      action: "move_to_tile",
      args: { x: 2, y: 3 },
      snapshot: { revision: 7 },
      requestId: accepted.requestId,
      idempotencyKey: "idem-1",
      timeoutMs: 15_000,
    }),
    hasErrorCode("stale_native_snapshot"),
  );
});

test("observeFresh rejects stale and non-actionable state", async () => {
  const staleClient = {
    state: { snapshot: { revision: 9 } },
    observe: async () => ({ revision: 8, actionable: true }),
  };
  await assert.rejects(observeFresh(staleClient), hasErrorCode("stale_native_snapshot"));

  const blockedClient = {
    state: { snapshot: { revision: 8 } },
    observe: async () => ({ revision: 8, actionable: false, activeExecution: { executionId: "e" } }),
  };
  await assert.rejects(
    observeFresh(blockedClient, { actionable: true }),
    hasErrorCode("native_snapshot_not_actionable"),
  );
});

test("terminal wait ignores stale, mismatched, and nonterminal receipts", async () => {
  const receipts = [
    { ...accepted, requestId: "old-request", state: "succeeded" },
    { ...accepted, executionId: "old-execution", state: "succeeded" },
    { ...accepted, state: "running" },
  ];
  const pending = waitForTerminal(receipts, accepted, 100);
  setTimeout(() => receipts.push({ ...accepted, state: "succeeded", reasonCode: "target_reached" }), 1);
  const terminal = await pending;
  assert.equal(terminal.reasonCode, "target_reached");
});

test("terminal wait fails for missing or stale terminal receipt", async () => {
  await assert.rejects(
    waitForTerminal([{ ...accepted, requestId: "other", state: "succeeded" }], accepted, 1),
    hasErrorCode("native_terminal_receipt_missing_or_stale"),
  );
});

test("receipt identity and summaries remain exact and redacted", () => {
  assert.equal(assertReceiptIdentity(accepted, accepted), accepted);
  assert.throws(
    () => assertReceiptIdentity({ ...accepted, executionId: "other" }, accepted),
    hasErrorCode("native_receipt_execution_id_mismatch"),
  );
  assert.throws(
    () => assertReceiptIdentity({ ...accepted, requestId: "other" }, accepted),
    hasErrorCode("native_receipt_request_id_mismatch"),
  );

  const snapshotSummary = summarizeSnapshot({
    revision: 7,
    location: "Farm",
    tile: { x: 1, y: 2 },
    actionable: true,
    capabilities: ["move_to_tile"],
    activeExecution: null,
    secret: "must-not-appear",
  });
  const receiptSummary = summarizeReceipt(accepted);
  assert.equal(snapshotSummary.capabilityCount, 1);
  assert.equal(receiptSummary.hasEvidence, true);
  assert.doesNotMatch(JSON.stringify(snapshotSummary), /move_to_tile|must-not-appear/);
  assert.doesNotMatch(JSON.stringify(receiptSummary), /secret-native-detail/);
});
