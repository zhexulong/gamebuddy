import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertExactCapabilities,
  assertImmediateReceipt,
  assertPostTerminalRevision,
  assertReceiptIdentity,
  connectNativeLocalClient,
  createNativeScope,
  deadlineAfter,
  executeFresh,
  NativeSmokeHarnessError,
  observeFresh,
  readNativeClientConfig,
  requiredArg,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
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
    () =>
      assertPostTerminalRevision({ revision: 10 }, { requestId: "request-1", executionId: "execution-1", revision: 9 }),
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
  assert.equal(snapshotSummary.hasLocation, true);
  assert.equal(snapshotSummary.hasTile, true);
  assert.equal(receiptSummary.hasEvidence, true);
  assert.doesNotMatch(JSON.stringify(snapshotSummary), /Farm|"x":1|"y":2|move_to_tile|must-not-appear/);
  assert.doesNotMatch(JSON.stringify(receiptSummary), /execution-|request-|secret-native-detail/);
});

test("readNativeClientConfig parses the bounded runner config and fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-harness-config-"));
  try {
    const configPath = join(directory, "client-config.json");
    await writeFile(configPath, JSON.stringify({ SaveId: "save", PipeName: "pipe" }));
    const config = await readNativeClientConfig(["--client-config", configPath]);
    assert.deepEqual(config, { SaveId: "save", PipeName: "pipe" });
    await assert.rejects(
      readNativeClientConfig(["--client-config", join(directory, "missing.json")]),
      hasErrorCode("invalid_native_client_config"),
    );
    assert.throws(() => requiredArg("--client-config", []), hasErrorCode("missing_client-config"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("connectNativeLocalClient awaits async teardown and propagates close failure", async () => {
  const config = { SaveId: "save", WorldId: "world", PlayerId: "player", CompanionId: "companion", PipeName: "pipe", BridgeToken: "token" };
  const order = [];
  const closeFailure = new Error("async close failed");
  const fakeClient = {
    connect: async () => fakeClient,
    onFact: () => () => order.push("unsubscribe"),
    close: async () => {
      order.push("close-start");
      await Promise.resolve();
      order.push("close-end");
      throw closeFailure;
    },
  };
  const session = await connectNativeLocalClient(config, { loadModule: async () => ({ LocalStardewBridgeClient: fakeClient }) });
  await assert.rejects(session.close(), closeFailure);
  assert.deepEqual(order, ["unsubscribe", "close-start", "close-end"]);
});

test("connectNativeLocalClient builds a bounded session and tears down exactly once", async () => {
  const config = {
    SaveId: "save",
    WorldId: "world",
    PlayerId: "player",
    CompanionId: "companion",
    PipeName: "pipe",
    BridgeToken: "secret-token",
  };
  const listeners = new Set();
  const diagnosticListeners = new Set();
  const fakeClient = {
    connect: async (scope, pipeName, token) => {
      fakeClient.scope = scope;
      fakeClient.pipeName = pipeName;
      fakeClient.token = token;
      return fakeClient;
    },
    onFact: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onDiagnostic: (listener) => {
      diagnosticListeners.add(listener);
      return () => diagnosticListeners.delete(listener);
    },
    close: () => {
      fakeClient.closed += 1;
    },
    closed: 0,
  };
  const session = await connectNativeLocalClient(config, {
    loadModule: async () => ({ LocalStardewBridgeClient: fakeClient }),
  });
  assert.deepEqual(session.scope, {
    integrationId: "stardew",
    saveId: "save",
    worldId: "world",
    playerId: "player",
    companionId: "companion",
  });
  assert.equal(fakeClient.pipeName, "pipe");
  assert.equal(fakeClient.token, "secret-token");
  for (const listener of listeners) {
    listener({ type: "execution_receipt", payload: { executionId: "e1" } });
    listener({ type: "snapshot", payload: { executionId: "not-a-receipt" } });
    listener({ type: "execution_receipt", payload: { executionId: "e2" } });
  }
  assert.deepEqual(session.receipts, [{ executionId: "e1" }, { executionId: "e2" }]);
  for (let index = 0; index < 20; index += 1) {
    for (const listener of diagnosticListeners) listener({ stage: "pipe_frame_dispatched", reasonCode: `fixed_${index}` });
  }
  assert.deepEqual(
    session.diagnostics.map((diagnostic) => diagnostic.reasonCode),
    Array.from({ length: 16 }, (_, index) => `fixed_${index + 4}`),
  );
  await session.close();
  assert.equal(listeners.size, 0);
  assert.equal(diagnosticListeners.size, 0);
  assert.equal(fakeClient.closed, 1);
  assert.doesNotMatch(JSON.stringify({ scope: session.scope, receipts: session.receipts }), /secret-token|secret/);
  await assert.rejects(connectNativeLocalClient({ ...config, PipeName: "" }), hasErrorCode("invalid_native_config"));
  await assert.rejects(connectNativeLocalClient({ ...config, SaveId: "" }), hasErrorCode("invalid_native_scope"));
});

test("waitForActionable returns an actionable snapshot or times out closed", async () => {
  let reads = 0;
  const client = {
    state: { snapshot: { revision: 1 } },
    observe: async () => {
      reads += 1;
      return {
        revision: 1,
        actionable: reads >= 3,
        activeExecution: reads >= 3 ? null : { executionId: "e" },
      };
    },
  };
  const actionable = await waitForActionable(client, { revision: 1 }, 2_000);
  assert.equal(actionable.actionable, true);
  assert.equal(actionable.activeExecution, null);
  assert.equal(reads, 3);
  await assert.rejects(waitForActionable(client, { revision: 1 }, 20), hasErrorCode("native_snapshot_not_actionable"));
});

test("waitForFreshSnapshot enforces revision, actionability, and runner checks", async () => {
  let reads = 0;
  const client = {
    observe: async () => {
      reads += 1;
      return { revision: 5 + reads, actionable: true, tile: { x: 1, y: 1 } };
    },
  };
  const reached = await waitForFreshSnapshot(client, { minRevision: 7, timeoutMs: 2_000, requireActionable: true });
  assert.equal(reached.revision, 7);
  assert.equal(reads, 2);
  const stuck = {
    observe: async () => ({ revision: 5, actionable: false }),
  };
  await assert.rejects(
    waitForFreshSnapshot(stuck, { minRevision: 7, timeoutMs: 20 }),
    hasErrorCode("native_fresh_snapshot_timeout"),
  );
  await assert.rejects(
    waitForFreshSnapshot(stuck, { minRevision: 5, timeoutMs: 20, check: () => false }),
    hasErrorCode("native_fresh_snapshot_timeout"),
  );
});

test("waitForStableRevision waits for the exact terminal revision and fails closed on advance", async () => {
  let reads = 0;
  const client = {
    observe: async () => {
      reads += 1;
      return { revision: reads === 1 ? 9 : 10, actionable: true };
    },
  };
  assert.equal((await waitForStableRevision(client, { revision: 9, timeoutMs: 2_000 })).revision, 9);
  assert.equal(reads, 1);
  await assert.rejects(
    waitForStableRevision(client, { revision: 9, timeoutMs: 2_000 }),
    (error) => error?.code === "native_post_terminal_revision_mismatch:10:9",
  );
  const pinned = {
    observe: async () => ({ revision: 8, actionable: true }),
  };
  await assert.rejects(
    waitForStableRevision(pinned, { revision: 9, timeoutMs: 20 }),
    hasErrorCode("native_stable_revision_timeout"),
  );
  const stuck = {
    observe: async () => ({ revision: 9, actionable: true }),
  };
  await assert.rejects(
    waitForStableRevision(stuck, { revision: 9, timeoutMs: 20, check: () => false }),
    hasErrorCode("native_stable_revision_timeout"),
  );
});
