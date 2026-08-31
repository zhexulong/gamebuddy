import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runNavigationMutationSmoke } from "./run-stardew-native-local-player-navigation-mutation-smoke.mjs";

const CAPABILITIES = [
  "cancel_active_execution",
  "find_destination",
  "inspect_self",
  "inspect_world_map",
  "navigate_to_destination",
];

function config(overrides = {}) {
  return {
    NativeLocalPlayerFixture: {
      Enable: true,
      FixtureScenario: "navigation_mutation_v1",
      NavigationMutationTargetLabel: "game-derived-target",
    },
    ActionPolicyVersion: 0,
    EnabledActions: ["inspect_world_map", "find_destination", "navigate_to_destination"],
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    ...overrides,
  };
}

function snapshot(location, revision, capabilities = CAPABILITIES) {
  return { revision, location, tile: { x: 1, y: 2 }, actionable: true, activeExecution: null, capabilities };
}

function fake({
  terminalState = "succeeded",
  terminalReason = "navigation_completed",
  evidence,
  decoy = false,
  duplicateTerminal = false,
  omitTerminal = false,
  freshLocation = "game-derived-target",
} = {}) {
  let location = "Farm";
  let revision = 4;
  const calls = [];
  const receipts = [];
  const client = {
    state: { snapshot: snapshot(location, revision), latestReceipt: null },
    observe: async () => {
      const value = snapshot(location, revision);
      client.state.snapshot = value;
      calls.push(["observe", location]);
      return value;
    },
    navigationRead: async ({ operation, args }) => {
      calls.push([operation, args]);
      if (operation === "inspect_world_map")
        return {
          status: "succeeded",
          reason: "world_map_observed",
          entries: [
            { label: location, destination: { kind: "label", label: location, ref: null } },
            { label: "game-derived-target", destination: { kind: "label", label: "game-derived-target", ref: null } },
          ],
        };
      assert.equal(args.query, "game-derived-target");
      return {
        status: "resolved",
        destination: { kind: "label", label: "game-derived-target", ref: null },
      };
    },
    execute: async (request) => {
      calls.push(["execute", request]);
      assert.deepEqual(request.args.destination, { kind: "label", label: "game-derived-target", ref: null });
      const accepted = {
        requestId: request.requestId,
        executionId: "execution-navigation",
        state: "accepted",
        reasonCode: "accepted",
        revision: 5,
      };
      if (decoy)
        receipts.push({ ...accepted, requestId: "decoy-request", state: "succeeded", reasonCode: terminalReason });
      location = freshLocation;
      revision = 5;
      const terminal = {
        ...accepted,
        state: terminalState,
        reasonCode: terminalReason,
        evidence: evidence ?? { detail: "destination=game-derived-target;location=game-derived-target;arrived=true;postcondition=true" },
      };
      if (!omitTerminal) receipts.push(terminal);
      if (duplicateTerminal) receipts.push({ ...terminal });
      client.state.latestReceipt = terminal;
      return accepted;
    },
  };
  return { client, receipts, calls };
}

test("producer facts flow through one typed mutation, exact correlation, and a fresh game-derived verifier", async () => {
  const harness = fake();
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
    terminalTimeoutMs: 50,
    postconditionTimeoutMs: 50,
  });
  assert.equal(result.state, "passed");
  assert.equal(result.mutationCount, 1);
  assert.equal(harness.calls.filter(([kind]) => kind === "execute").length, 1);
  assert.deepEqual(
    harness.calls.map(([kind]) => kind),
    ["observe", "inspect_world_map", "find_destination", "execute", "observe", "find_destination"],
  );
  assert.equal(result.before.hasLocation, true);
  assert.equal(result.after.hasLocation, true);
  assert.equal(result.correlationVerified, true);
  assert.equal(result.evidenceVerified, true);
  assert.equal(result.postconditionVerified, true);
  assert.equal(result.traceCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /Farm|game-derived-target|request-|execution-|arrived=true/);
});

test("localized destination label binds to receipt destination while fresh canonical location binds separately", async () => {
  const harness = fake({
    freshLocation: "CanonicalTargetIdentity",
    evidence: { detail: "destination=game-derived-target;location=CanonicalTargetIdentity;arrived=true;postcondition=true" },
  });
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
    terminalTimeoutMs: 50,
    postconditionTimeoutMs: 50,
  });
  assert.equal(result.state, "passed");
  assert.equal(result.after.hasLocation, true);
  assert.doesNotMatch(JSON.stringify(result), /CanonicalTargetIdentity|game-derived-target/);
});

test("decoy request/execution correlation fails closed", async () => {
  const harness = fake({ decoy: true });
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), {
    terminalTimeoutMs: 50,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.stage, "execute");
  assert.equal(result.reasonCode, "navigation_mutation_decoy_receipt_observed");
});

test("blocked result identifies the last content-free smoke stage", async () => {
  const harness = fake();
  harness.client.observe = async () => {
    throw new Error("bridge_response_timeout");
  };
  const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config());
  assert.equal(result.state, "blocked");
  assert.equal(result.stage, "observe_before");
  assert.equal(result.reasonCode, "bridge_response_timeout");
  assert.equal(harness.calls.some(([kind]) => kind === "execute"), false);
});

test("failed, empty-evidence, and stale completion outcomes fail closed", async (t) => {
  await t.test("failed terminal", async () => {
    const harness = fake({ terminalState: "failed", terminalReason: "navigation_failed" });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), { terminalTimeoutMs: 50 });
    assert.match(result.reasonCode, /^navigation_mutation_terminal_failed:failed:/);
  });
  await t.test("empty evidence", async () => {
    const harness = fake({ evidence: null });
    harness.client.execute = async (request) => {
      const accepted = { requestId: request.requestId, executionId: "execution-navigation", state: "accepted", reasonCode: "accepted", revision: 5 };
      harness.receipts.push({ ...accepted, state: "succeeded", reasonCode: "navigation_completed", evidence: null });
      return accepted;
    };
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), { terminalTimeoutMs: 50 });
    assert.equal(result.reasonCode, "navigation_mutation_evidence_empty");
  });
  await t.test("missing terminal outcome", async () => {
    const harness = fake({ omitTerminal: true });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), { terminalTimeoutMs: 5 });
    assert.equal(result.reasonCode, "native_terminal_receipt_missing_or_stale");
  });
  await t.test("multiple correlated terminal outcomes", async () => {
    const harness = fake({ duplicateTerminal: true });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), { terminalTimeoutMs: 50 });
    assert.equal(result.reasonCode, "navigation_mutation_terminal_receipt_count_invalid");
  });
  await t.test("stale or mismatched fresh postcondition", async () => {
    const harness = fake({ freshLocation: "Farm" });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), { terminalTimeoutMs: 50 });
    assert.equal(result.reasonCode, "navigation_mutation_fresh_location_mismatch");
  });
  await t.test("receipt destination does not match the selected label", async () => {
    const harness = fake({ evidence: { detail: "destination=other-label;location=game-derived-target;arrived=true;postcondition=true" } });
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config(), { terminalTimeoutMs: 50 });
    assert.equal(result.reasonCode, "navigation_mutation_evidence_destination_mismatch");
  });
  await t.test("non-isolated capability", async () => {
    const harness = fake();
    harness.client.observe = async () => snapshot("Farm", 4, CAPABILITIES.slice(1));
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config());
    assert.equal(result.reasonCode, "native_capability_surface_mismatch");
  });
  await t.test("non-isolated topology", async () => {
    const harness = fake();
    const result = await runNavigationMutationSmoke(harness.client, harness.receipts, config({ Portfolio: { Enable: true } }));
    assert.equal(result.reasonCode, "native_local_fixture_topology_not_isolated");
  });
});

test("source constraints forbid hardcoded destination, direct warp, and fixture world mutation", async () => {
  const runner = await readFile(new URL("./run-stardew-native-local-player-navigation-mutation-smoke.mjs", import.meta.url), "utf8");
  assert.match(runner, /inspect_world_map[\s\S]*NavigationMutationTargetLabel[\s\S]*find_destination[\s\S]*executeFresh[\s\S]*waitForTerminal[\s\S]*waitForFreshSnapshot/);
  assert.doesNotMatch(runner, /warpFarmer|client\.travel|move_to_tile|destination:\s*\{\s*kind:\s*"label",\s*label:\s*"/);
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const start = entry.indexOf('if (fixture.FixtureScenario == "navigation_mutation_v1")');
  const branch = entry.slice(start, entry.indexOf("if (fixture.FixtureScenario is not", start));
  assert.ok(start >= 0);
  assert.match(branch, /DerivedDestinationSet\.TryCreateCurrent/);
  assert.match(branch, /Game1NavigationWorldSource/);
  assert.match(branch, /NavigationRoutePlanner/);
  assert.match(branch, /NavigationMutationTargetLabel = selected\.CanonicalLabel/);
  assert.match(branch, /Helper\.WriteConfig/);
  assert.doesNotMatch(branch, /warpFarmer|Game1\.warp|terrainFeatures|objects\.|player\.Items|Position\s*=/);
});

test("observe diagnosis uses fixed content-free phase codes", async () => {
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const codes = [
    "navigation_observe_dequeued",
    "navigation_observe_response_created",
    "navigation_observe_response_queued",
    "navigation_observe_response_enqueue_failed",
    "navigation_observe_response_missing",
    "navigation_observe_response_flushed",
    "navigation_observe_response_write_failed",
    "navigation_observe_response_flush_unconfirmed",
    "navigation_observe_response_delivery_untracked",
  ];
  for (const code of codes) {
    assert.equal(entry.match(new RegExp(`MonitorNativeChatIngress\\(\\"${code}\\"\\)`, "g"))?.length, 1);
  }
  const start = entry.indexOf("private string? HandleObserve");
  const end = entry.indexOf("private string? HandleNavigationRead", start);
  const observe = entry.slice(start, end);
  const deliveryStart = entry.indexOf("private void ObserveNavigationPipeDeliveries");
  const deliveryEnd = entry.indexOf("private void PublishPendingStopObservation", deliveryStart);
  const delivery = entry.slice(deliveryStart, deliveryEnd);
  assert.ok(deliveryStart >= 0 && deliveryEnd > deliveryStart);
  assert.match(
    entry,
    /if \(this\.config\.NativeLocalPlayerFixture\?\.Enable == true\)[\s\S]*this\.ObserveBridgeGeneration\(nativeLocalState\);\s*this\.ObserveNativeChatPipeDeliveries\(nativeLocalState\);\s*this\.ObserveNavigationPipeDeliveries\(nativeLocalState\);\s*this\.ObserveExecutionResponsePipeDeliveries\(nativeLocalState\);\s*this\.ObserveTerminalReceiptDeliveries\(nativeLocalState\);\s*this\.DrainLocalPipeBridge\(nativeLocalState\);/,
    "Native-local fixture ticks must poll every generation-bound delivery completion before draining new bridge requests",
  );
  assert.doesNotMatch(observe, /MonitorNativeChatIngress\((?!\")[^)]/);
  assert.doesNotMatch(delivery, /MonitorNativeChatIngress\((?!\")[^)]/);
  assert.doesNotMatch(observe, /MonitorNativeChatIngress\(\$|MonitorNativeChatIngress\([^\"]|Monitor\.Log/);
  assert.doesNotMatch(delivery, /MonitorNativeChatIngress\(\$|MonitorNativeChatIngress\([^\"]|Monitor\.Log/);
});

test("execution boundary diagnosis uses fixed content-free phase codes", async () => {
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const codes = [
    "navigation_execution_dequeued",
    "navigation_execution_parse_rejected",
    "navigation_execution_response_created",
    "navigation_execution_response_missing",
    "navigation_execution_response_queued",
    "navigation_execution_response_enqueue_failed",
    "navigation_execution_response_flushed",
    "navigation_execution_response_write_failed",
    "navigation_execution_response_flush_unconfirmed",
    "navigation_execution_response_delivery_untracked",
  ];
  for (const code of codes) {
    assert.equal(entry.match(new RegExp(`MonitorNativeChatIngress\\(\\"${code}\\"\\)`, "g"))?.length, 1);
  }
  const executeStart = entry.indexOf("private string? HandleExecute");
  const executeEnd = entry.indexOf("private string? HandleCancel", executeStart);
  const execute = entry.slice(executeStart, executeEnd);
  const deliveryStart = entry.indexOf("private void ObserveExecutionResponsePipeDeliveries");
  const deliveryEnd = entry.indexOf("private void PublishPendingStopObservation", deliveryStart);
  const delivery = entry.slice(deliveryStart, deliveryEnd);
  assert.ok(executeStart >= 0 && executeEnd > executeStart);
  assert.ok(deliveryStart >= 0 && deliveryEnd > deliveryStart);
  assert.doesNotMatch(execute, /MonitorNativeChatIngress\((?!")[^)]/);
  assert.doesNotMatch(delivery, /MonitorNativeChatIngress\((?!")[^)]/);
  assert.doesNotMatch(execute, /MonitorNativeChatIngress\(\$|Monitor\.Log/);
  assert.doesNotMatch(delivery, /MonitorNativeChatIngress\(\$|Monitor\.Log/);
});
