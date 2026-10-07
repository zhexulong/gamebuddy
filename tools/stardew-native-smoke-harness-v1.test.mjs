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
  assertRequiredCapabilities,
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
  executeFreshAfterReobserve,
  TERMINAL_STATES,
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
  // Expressed against the CEILING rather than a literal: the previous form pinned 60_001 while the
  // accepted bound later rose, so the case stopped testing anything and failed. A value far above any
  // accepted timeout keeps the assertion true for every value of the bound.
  assert.throws(() => deadlineAfter(Number.MAX_SAFE_INTEGER, 1000), hasErrorCode("invalid_native_request_timeout"));
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

test("required capabilities accept a larger shared-world surface and fail closed on anything less", () => {
  // A shared world runs the version-1 default consent policy, so its advertised
  // surface is every published action plus the experimental actions that profile
  // opted into. The action under test is present; the extra entries are not the
  // runner's to remove.
  const sharedWorldSurface = {
    revision: 12,
    capabilities: [
      "move_to_tile",
      "inspect_world_map",
      "find_destination",
      "navigate_to_destination",
      "equip_tool",
      "travel",
      "enter_exit",
      "till_soil",
      "pickup_forage",
      "pickup_item",
      "water_crop",
      "plant_seed",
      "fertilize_tile",
      "machine_inspect",
      "machine_load",
      "machine_collect_output",
      "collect_animal_product",
      "feed_animal",
      "use_item",
      "harvest_crop",
      "place_wood_fence",
      "place_crab_pot",
      "bait_crab_pot",
      "chop_tree_source",
      "break_rock_source",
      "clear_hoedirt",
      "dig_artifact_spot",
      "refill_watering_can",
      "observe_scene",
      "inspect_self",
      "cancel_active_execution",
      "pet_animal",
    ],
  };
  assertRequiredCapabilities(sharedWorldSurface, ["pet_animal"]);
  assertRequiredCapabilities(sharedWorldSurface, ["pet_animal", "inspect_self", "pet_animal"]);
  assertRequiredCapabilities(sharedWorldSurface, ["move_to_tile", "travel", "pet_animal"]);

  // The equals-assertion is unchanged: it still rejects this same surface,
  // which is what keeps the 43 single-player runners on their isolated contract.
  assert.throws(
    () => assertExactCapabilities(sharedWorldSurface, ["pet_animal"]),
    hasErrorCode("native_capability_surface_mismatch"),
  );

  assert.throws(
    () => assertRequiredCapabilities(sharedWorldSurface, ["pet_animal", "chest_retrieve"]),
    hasErrorCode("native_required_capability_missing:chest_retrieve"),
  );
  assert.throws(
    () => assertRequiredCapabilities(sharedWorldSurface, ["ship_item", "chest_retrieve"]),
    hasErrorCode("native_required_capability_missing:chest_retrieve,ship_item"),
  );
  assert.throws(
    () => assertRequiredCapabilities({ revision: 12, capabilities: "pet_animal" }, ["pet_animal"]),
    hasErrorCode("invalid_native_capability_surface"),
  );
  assert.throws(
    () => assertRequiredCapabilities(sharedWorldSurface, []),
    hasErrorCode("invalid_native_required_capabilities"),
  );
  assert.throws(
    () => assertRequiredCapabilities(sharedWorldSurface, ["pet_animal", ""]),
    hasErrorCode("invalid_native_required_capabilities"),
  );
  assert.throws(
    () => assertRequiredCapabilities(sharedWorldSurface, ["pet_animal", 7]),
    hasErrorCode("invalid_native_required_capabilities"),
  );
  assert.throws(
    () => assertRequiredCapabilities({ capabilities: ["pet_animal"] }, ["pet_animal"]),
    hasErrorCode("invalid_native_snapshot"),
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

// Helpers for the re-observe tests below.

// A client in the shape the harness expects: a cache the harness can read (`state.snapshot`) and an
// observe/execute pair whose answers the test controls.
function makeRetryClient({ revisions = [1], receipts = [] } = {}) {
  let i = 0;
  const client = {
    state: { snapshot: { revision: revisions[0], actionable: true, activeExecution: null, capabilities: [] } },
    observe: async () => ({ revision: revisions[Math.min(i, revisions.length - 1)], actionable: true, activeExecution: null, capabilities: [] }),
    execute: async (request) => {
      receipts.push({ requestId: request.requestId, executionId: "exec-1", state: "succeeded", reasonCode: "done" });
      return { requestId: request.requestId, executionId: "exec-1", state: "accepted", reasonCode: "accepted", evidence: { detail: "a=1" } };
    },
  };
  return {
    client,
    receipts,
    advance: (revision) => {
      i++;
      client.state.snapshot = { ...client.state.snapshot, revision };
    },
  };
}

// The four tests below were added with the re-observe helper. They cover the two stale windows
// explicitly, because the helper's first version had `observeFresh` outside its try and therefore never
// retried - a defect a test like this is what catches.

test("observeFresh returns a snapshot whose revision the client has not passed", async () => {
  const { client } = makeRetryClient({ revisions: [7] });
  const snapshot = await observeFresh(client, { actionable: true });
  assert.equal(snapshot.revision, 7);
});
test("observeFresh refuses a snapshot the client's cache has already passed", async () => {
  // The check exists so a request is never bound to a revision the world has moved past. It is a real
  // contract, so it must be asserted: an edit that deleted it would otherwise pass unnoticed.
  const { client, advance } = makeRetryClient({ revisions: [1] });
  advance(9); // the cache moves on; observe still answers 1
  await assert.rejects(() => observeFresh(client, { actionable: true }), /stale_native_snapshot/);
});
test("executeFresh binds the request to the snapshot it is given", async () => {
  const { client, receipts } = makeRetryClient({ revisions: [4] });
  const snapshot = await observeFresh(client, { actionable: true });
  const seen = [];
  const original = client.execute;
  client.execute = async (request) => {
    seen.push(request.expectedRevision);
    return original(request);
  };
  const accepted = await executeFresh(client, {
    action: "x",
    args: {},
    snapshot,
    requestId: "req-1",
    idempotencyKey: "idem-1",
    timeoutMs: 1_000,
  });
  assert.deepEqual(seen, [4], "the request must carry the observed revision");
  assert.equal(accepted.executionId, "exec-1");
  assert.equal(receipts.length, 1);
});
test("executeFreshAfterReobserve re-observes and re-sends when the world moved in between", async () => {
  // This is the helper added for the two runners that lost a run to the transient: the FIRST attempt must
  // fail the binding (the cache advanced), and the helper must then observe again and succeed - not give up.
  const { client } = makeRetryClient({ revisions: [1] });
  let attempts = 0;
  let observes = 0;
  let moved = false;
  const original = client.execute;
  client.observe = async () => {
    observes++;
    if (!moved) {
      // The world moves during the first observation: the cache ends up ahead of the revision that
      // observation returned, which is exactly what makes the bound request stale.
      moved = true;
      client.state.snapshot = { ...client.state.snapshot, revision: 99 };
      return { revision: 1, actionable: true, activeExecution: null, capabilities: [] };
    }
    return { revision: client.state.snapshot.revision, actionable: true, activeExecution: null, capabilities: [] };
  };
  client.execute = async (request) => {
    attempts++;
    return original(request);
  };
  const accepted = await executeFreshAfterReobserve(client, {
    action: "x",
    args: {},
    requestId: "req-2",
    idempotencyKey: "idem-2",
    timeoutMs: 1_000,
  });
  assert.equal(attempts, 1, "the request itself is sent once: the OBSERVE was the stale window");
  assert.equal(observes, 2, "the helper must observe again rather than fail the run");
  assert.equal(accepted.executionId, "exec-1");
});
test("executeFreshAfterReobserve is bounded and surfaces the last refusal", async () => {
  const { client } = makeRetryClient({ revisions: [1] });
  let attempts = 0;
  client.execute = async () => {
    attempts++;
    throw new NativeSmokeHarnessError("stale_native_snapshot");
  };
  await assert.rejects(
    () =>
      executeFreshAfterReobserve(
        client,
        { action: "x", args: {}, requestId: "req-3", idempotencyKey: "idem-3", timeoutMs: 1_000 },
        { attempts: 2 },
      ),
    /stale_native_snapshot/,
  );
  assert.equal(attempts, 2, "a world that never settles must stop, not loop");
});
test("executeFreshAfterReobserve does not swallow a refusal that is not the transient", async () => {
  // Only `stale_native_snapshot` is retried. Any other rejection is the caller's business.
  const { client } = makeRetryClient({ revisions: [1] });
  let attempts = 0;
  client.execute = async () => {
    attempts++;
    throw new NativeSmokeHarnessError("invalid_native_action");
  };
  await assert.rejects(
    () => executeFreshAfterReobserve(client, { action: "x", args: {}, requestId: "req-4", idempotencyKey: "idem-4", timeoutMs: 1_000 }),
    /invalid_native_action/,
  );
  assert.equal(attempts, 1, "a non-transient refusal must not be retried");
});
test("deadlineAfter returns a bounded absolute deadline and refuses an unusable timeout", () => {
  const now = 1_000_000;
  assert.equal(deadlineAfter(1_000, now), now + 1_000);
  assert.throws(() => deadlineAfter(0, now), /invalid_native_request_timeout/);
  assert.throws(() => deadlineAfter(-1, now), /invalid_native_request_timeout/);
  assert.throws(() => deadlineAfter(Number.MAX_SAFE_INTEGER, now), /invalid_native_request_timeout/);
  // An absolute deadline that would leave the safe-integer range is refused rather than silently wrapped.
  assert.throws(() => deadlineAfter(1_000, Number.MAX_SAFE_INTEGER - 10), /invalid_native_deadline_clock/);
});
test("assertImmediateReceipt requires the request/execution pair and returns the receipt unchanged", () => {
  const receipt = { requestId: "req-9", executionId: "exec-9", state: "accepted", evidence: { detail: "k=v" } };
  const returned = assertImmediateReceipt(receipt, { requestId: "req-9" });
  assert.equal(returned, receipt, "the receipt must not be rebuilt: dispatch evidence has to survive");
  assert.equal(returned.evidence.detail, "k=v");
  assert.throws(() => assertImmediateReceipt(receipt, { requestId: "other" }), /native_receipt_request_id_mismatch/);
  assert.throws(() => assertImmediateReceipt({ requestId: "req-9" }, { requestId: "req-9" }), /invalid_native_receipt_execution_id/);
});
test("waitForTerminal stops on a terminal state and ignores progress", async () => {
  const accepted = { requestId: "req-10", executionId: "exec-10" };
  const receipts = [
    { requestId: "req-10", executionId: "exec-10", state: "running", reasonCode: "progress" },
    { requestId: "req-10", executionId: "exec-10", state: "succeeded", reasonCode: "done" },
  ];
  const terminal = await waitForTerminal(receipts, accepted, 500);
  assert.equal(terminal.reasonCode, "done");
  assert.ok(TERMINAL_STATES.has("succeeded") && TERMINAL_STATES.has("invalidated"), "terminal states are the closed set");
  assert.ok(!TERMINAL_STATES.has("running"), "running is progress, never a terminal");
});
