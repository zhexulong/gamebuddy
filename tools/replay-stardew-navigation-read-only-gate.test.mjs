import assert from "node:assert/strict";

import { runNavigationReadOnlyDirectGate } from "./stardew-navigation-read-only-direct-gate.mjs";

const config = {
  ActionPolicyVersion: 0,
  EnabledActions: ["inspect_world_map", "find_destination"],
  NativeLocalPlayerFixture: {
    Enable: true,
    Bootstrap: { Enable: false },
    FixtureScenario: "navigation_read_only_v1",
  },
};
const capabilities = ["cancel_active_execution", "find_destination", "inspect_self", "inspect_world_map"];

class FakeClient {
  constructor() {
    this.receipts = [];
    this.readRequests = [];
    this.withdrawn = false;
    this.state = {
      latestReceipt: null,
      capabilities: [...capabilities],
      snapshot: this.snapshot(),
    };
  }

  snapshot() {
    return {
      revision: 7,
      actionable: true,
      activeExecution: null,
      capabilities: this.withdrawn ? ["cancel_active_execution", "inspect_self"] : [...capabilities],
    };
  }

  withdraw() {
    this.withdrawn = true;
    this.state = { ...this.state, capabilities: ["cancel_active_execution", "inspect_self"], snapshot: this.snapshot() };
  }

  async observe() {
    const snapshot = this.snapshot();
    this.state = { ...this.state, snapshot };
    return snapshot;
  }

  async navigationRead(request) {
    this.readRequests.push(request);
    if (this.withdrawn) throw new Error("bridge_capability_not_ready");
    if (request.operation === "find_destination") {
      if (request.args.query === "") throw new Error("bridge_rejected:invalid_navigation_read_request");
      return { status: "resolved", reason: "exact_current_locale", destination: { kind: "label", label: "Farm" } };
    }
    if (request.args.nodeRef !== undefined)
      return { status: "blocked", reason: "world_map_node_invalid" };
    return {
      status: "succeeded",
      reason: "world_map_observed",
      entries: [{ label: "Farm", destination: { kind: "label", label: "Farm" } }],
    };
  }
}

await assert.rejects(
  () => runNavigationReadOnlyDirectGate(new FakeClient(), [], config),
  /navigation_read_only_gate_dependencies_unavailable/,
);

const initial = new FakeClient();
let closed = false;
let foreignScopeAttempted = false;
let withdrawalCalls = 0;
let reconnected = null;
const result = await runNavigationReadOnlyDirectGate(initial, initial.receipts, config, {
  closeActiveConnection: () => { closed = true; },
  connectForeignScope: async () => {
    foreignScopeAttempted = true;
    throw new Error("bridge_rejected:authentication_failed");
  },
  reconnectTargetScope: async () => {
    reconnected = new FakeClient();
    if (withdrawalCalls > 0) reconnected.withdraw();
    return { client: reconnected, receipts: reconnected.receipts, close: () => {} };
  },
  withdrawReadOnlyCapabilities: () => {
    withdrawalCalls += 1;
    reconnected.withdraw();
  },
  waitForPolicyReload: () => {},
});

assert.equal(result.state, "navigation_read_only_direct_gate_completed");
assert.equal(result.invalidQuery, "invalid_navigation_read_request");
assert.equal(result.malformedReference, "world_map_node_invalid");
assert.equal(result.foreignScope, "authentication_failed");
assert.equal(result.withdrawnOperation, "bridge_capability_not_ready");
assert.equal(result.withdrawnFindOperation, "bridge_capability_not_ready");
assert.equal(result.mutationCount, 0);
assert.equal(result.executionReceiptCount, 0);
assert.equal(closed, true);
assert.equal(foreignScopeAttempted, true);
assert.equal(withdrawalCalls, 1);
assert.equal(initial.readRequests.every((request) => request.operation !== "execute"), true);
assert.equal(reconnected.readRequests.length, 1);

console.log(JSON.stringify({ state: "navigation_read_only_gate_replay_completed", valid: true }));
