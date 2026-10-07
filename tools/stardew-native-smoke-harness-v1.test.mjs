import assert from "node:assert/strict";
import test from "node:test";

import {
  NativeSmokeHarnessError,
  TERMINAL_STATES,
  assertImmediateReceipt,
  deadlineAfter,
  executeFresh,
  executeFreshAfterReobserve,
  observeFresh,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

// A client in the shape the harness expects: a cache the harness can read (`state.snapshot`) and an
// observe/execute pair whose answers the test controls.
function makeClient({ revisions = [1], receipts = [] } = {}) {
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

test("observeFresh returns a snapshot whose revision the client has not passed", async () => {
  const { client } = makeClient({ revisions: [7] });
  const snapshot = await observeFresh(client, { actionable: true });
  assert.equal(snapshot.revision, 7);
});

test("observeFresh refuses a snapshot the client's cache has already passed", async () => {
  // The check exists so a request is never bound to a revision the world has moved past. It is a real
  // contract, so it must be asserted: an edit that deleted it would otherwise pass unnoticed.
  const { client, advance } = makeClient({ revisions: [1] });
  advance(9); // the cache moves on; observe still answers 1
  await assert.rejects(() => observeFresh(client, { actionable: true }), /stale_native_snapshot/);
});

test("executeFresh binds the request to the snapshot it is given", async () => {
  const { client, receipts } = makeClient({ revisions: [4] });
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
  const { client } = makeClient({ revisions: [1] });
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
  const { client } = makeClient({ revisions: [1] });
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
  const { client } = makeClient({ revisions: [1] });
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
