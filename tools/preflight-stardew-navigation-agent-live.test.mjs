import assert from "node:assert";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { runAgentLivePreflightTestHarness } from "./preflight-stardew-navigation-agent-live.test-harness.mjs";

const PRODUCTION_SOURCE = new URL("./preflight-stardew-navigation-agent-live.mjs", import.meta.url);
const HOST_TEST_MOUNT = new URL("../host/dist-test/stardew-integration-module.js", import.meta.url);
const NAVIGATE_TOOL_NAME = "stardew_navigate_to_destination";

/**
 * Deterministic composition regression for the agent-live preflight. The
 * composed pieces are injected so a single blocked component proves the whole
 * report is fail-closed. The static surface / fixture checks run against the
 * real repository mounted-surface artifacts; this is not a runner. Replay is
 * driven by caller-supplied synthetic real-shaped frames (tests may fabricate,
 * production invocation never does).
 */

function topologyResult(ready) {
  return { state: ready ? "PREFLIGHT_READY" : "BLOCKED", ready };
}
function completedReplay(mode = "direct") {
  return Object.freeze({ ok: true, valid: true, success: true, state: "navigation_replay_completed", mode, blocker: null, validation: { valid: true, mutationCount: 0, executionReceiptCount: 0 }, terminal: { reasonCode: "navigation_completed", state: "succeeded" } });
}
function failedReplay(blockerCode) {
  return Object.freeze({ ok: false, valid: false, success: false, state: "navigation_replay_blocked", blocker: { code: blockerCode }, validation: { valid: false, mutationCount: 0, executionReceiptCount: 0 }, terminal: null });
}
const SYNTHETIC_FRAMES = Object.freeze([{ type: "execution_request", scope: { integrationId: "stardew" }, payload: {} }]);

function readyOptions(overrides = {}) {
  return {
    transitionArtifact: "/tmp/artifact.json",
    runTopologyPreflight: async () => topologyResult(true),
    replayFrames: SYNTHETIC_FRAMES,
    replayOperation: async () => completedReplay(),
    stardewActionAdapters: [{ actionId: "navigate_to_destination", targetKinds: ["destination"] }],
    stardewActionToolNames: { navigate_to_destination: NAVIGATE_TOOL_NAME },
    testHostSurface: {
      gameTools: 'action: "navigate_to_destination"',
      protocol: 'value.kind === "ref"',
      registry: "",
      module: 'reasonCode === "navigation_completed" hasNavigationCompletionEvidence evidence.arrived === "true" evidence.postcondition === "true"',
    },
    // EXECUTION_PATH_FILES (ExecutionManager.cs, BridgeSession.cs, ModEntry.cs)
    // don't exist in the main source tree (they are in .commit-validation/).
    // Inject mocks so the M8 scan does not fail on missing files.
    readNavigationDirectory: async () => [
      "DerivedDestinationSet.cs", "DestinationSearch.cs", "Game1NavigationWorldSource.cs",
      "NavigationContracts.cs", "NavigationExecutionCoordinator.cs", "NavigationLifecycle.cs",
      "NavigationReferenceStore.cs", "NavigationRoutePlanner.cs", "WorldMapProjection.cs",
      "ExecutionModels.cs",
    ],
    readNavigationSource: async () => "// clean source, no M8 anchors",
    ...overrides,
  };
}

test("agent-live: ready only when every input is checked", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions());
  assert.equal(report.state, "PREFLIGHT_READY", JSON.stringify(report.items));
  assert.equal(report.ready, true, JSON.stringify(report.items));
  assert.equal(report.topology, "single_player_native_companion");
  assert.equal(report.mutationCount, 0);
  assert.equal(report.executionReceiptCount, 0);
  for (const it of report.items) assert.equal(it.status, "ready", `${it.name}`);
  assert.equal(report.items.find((i) => i.name === "receipt_lineage_replay").status, "ready");
  assert.equal(report.items.find((i) => i.name === "no_m8_navigation_path").status, "ready");
});

test("agent-live: a missing transition-artifact input is a named fail-closed blocker", async () => {
  const report = await runAgentLivePreflightTestHarness({
    runTopologyPreflight: async () => topologyResult(true),
    replayFrames: SYNTHETIC_FRAMES,
    replayOperation: async () => completedReplay(),
  });
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.items.find((i) => i.name === "transition_artifact").status, "blocked");
});

test("agent-live: missing caller-supplied replay frames is a named fail-closed blocker", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions({ replayFrames: undefined, replayFramesPath: undefined }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.ready, false);
  assert.equal(report.items.find((i) => i.name === "replay_frames").status, "blocked");
  assert.equal(report.items.find((i) => i.name === "receipt_lineage_replay").status, "blocked");
});

test("agent-live: an unreadable replay-frames file is a named fail-closed blocker", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions({ replayFrames: undefined, replayFramesPath: "/definitely/missing/frames.json" }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.items.find((i) => i.name === "replay_frames").status, "blocked");
  assert.equal(report.items.find((i) => i.name === "receipt_lineage_replay").status, "blocked");
});

test("agent-live: a terminal-failed injected replay forces blocked", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions({ replayOperation: async () => failedReplay("single_terminal_violation") }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.ready, false);
  const replayItem = report.items.find((i) => i.name === "receipt_lineage_replay");
  assert.equal(replayItem.status, "blocked");
  assert.match(replayItem.detail, /single_terminal_violation/);
});

test("agent-live: a single blocked component makes the whole report blocked", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions({ runTopologyPreflight: async () => topologyResult(false) }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.ready, false);
  assert.equal(report.items.find((i) => i.name === "topology").status, "blocked");
});

test("agent-live: a missing fixture teardown path forces blocked", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions({ exists: async (p) => !p.endsWith("prepare-stardew-action-fixture.ps1") }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.items.find((i) => i.name === "fixture_teardown_path").status, "blocked");
});

test("agent-live: a missing required Navigation source blocks the all-source M8 scan", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions({
    readNavigationDirectory: async () => ["NavigationLifecycle.cs"],
    readNavigationSource: async () => "",
  }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.items.find((i) => i.name === "no_m8_navigation_path").status, "blocked");
});

test("agent-live: an M8 anchor in a discovered non-required Navigation source blocks", async () => {
  const required = [
    "DerivedDestinationSet.cs", "DestinationSearch.cs", "Game1NavigationWorldSource.cs", "NavigationContracts.cs",
    "NavigationExecutionCoordinator.cs", "NavigationLifecycle.cs", "NavigationReferenceStore.cs", "NavigationRoutePlanner.cs",
    "WorldMapProjection.cs", "ExecutionModels.cs",
  ];
  const report = await runAgentLivePreflightTestHarness(readyOptions({
    readNavigationDirectory: async () => [...required, "FutureNavigationSource.cs"],
    readNavigationSource: async (_dir, name) => name === "FutureNavigationSource.cs" ? "enter_mine" : "",
  }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.items.find((i) => i.name === "no_m8_navigation_path").status, "blocked");
});

// --- requestNavigationScope tests ---

test("agent-live: requestNavigationScope is forwarded but caller ledger injection is not", async () => {
  let capturedTopologyOptions = null;
  const callerLedger = Object.freeze({ preparePassedClaim: () => ({ ok: true }), consume: async () => true });
  const captureTopology = async (opts) => {
    capturedTopologyOptions = opts;
    return topologyResult(true);
  };
  const report = await runAgentLivePreflightTestHarness(readyOptions({
    runTopologyPreflight: captureTopology,
    requestedNavigationScope: "multi_hop_ordinary_warp",
    testMultiSourceReceiptLedger: callerLedger,
  }));
  assert.equal(capturedTopologyOptions.requestedNavigationScope, "multi_hop_ordinary_warp");
  assert.equal(Object.hasOwn(capturedTopologyOptions, "testMultiSourceReceiptLedger"), false);
  // Topology still returns ready, so the report may still be ready if other
  // checks pass (replay must also support multi-hop mode).
  assert.equal(report.items.find((i) => i.name === "topology").status, "ready");
});

test("agent-live: multi_hop_ordinary_warp scope forces multi-hop replay mode and rejects generic attestation", async () => {
  let capturedMode = null;
  const captureReplay = async (frames, opts) => {
    capturedMode = opts.mode;
    return completedReplay();
  };
  const report = await runAgentLivePreflightTestHarness(readyOptions({
    replayOperation: captureReplay,
    requestedNavigationScope: "multi_hop_ordinary_warp",
  }));
  assert.equal(capturedMode, "multi_hop_ordinary_warp");
  assert.equal(report.items.find((i) => i.name === "receipt_lineage_replay").status, "blocked");
  assert.match(report.items.find((i) => i.name === "receipt_lineage_replay").detail, /mode mismatch/);
});

test("agent-live: multi-hop scope passes and consumes the deferred receipt only after all checks", async () => {
  let capturedMode = null;
  let consumeCount = 0;
  const captureReplay = async (frames, opts) => {
    capturedMode = opts.mode;
    return completedReplay(opts.mode);
  };
  const frames = [
    { type: "execution_request", scope: { integrationId: "stardew" }, payload: { action: "navigate_to_destination" } },
    { type: "execution_receipt", scope: { integrationId: "stardew" }, payload: { state: "accepted" } },
    { type: "execution_receipt", scope: { integrationId: "stardew" }, payload: { state: "succeeded" } },
  ];
  const report = await runAgentLivePreflightTestHarness(readyOptions({
    replayOperation: captureReplay,
    replayFrames: frames,
    requestedNavigationScope: "multi_hop_ordinary_warp",
    consumeDeferredMultiSourceReceiptClaim: async () => { consumeCount += 1; return true; },
  }));
  assert.equal(capturedMode, "multi_hop_ordinary_warp");
  assert.equal(report.items.find((i) => i.name === "receipt_lineage_replay").status, "ready");
  assert.equal(report.items.find((i) => i.name === "multi_source_receipt").status, "ready");
  assert.equal(consumeCount, 1);
});

test("agent-live: later host, replay, or source failure never consumes the deferred receipt", async () => {
  let consumed = 0;
  const noConsume = async () => { consumed += 1; return true; };
  const hostBlocked = await runAgentLivePreflightTestHarness(readyOptions({
    requestedNavigationScope: "multi_hop_ordinary_warp",
    testHostSurface: { gameTools: "", protocol: "", registry: "", module: "" },
    consumeDeferredMultiSourceReceiptClaim: noConsume,
  }));
  assert.equal(hostBlocked.state, "BLOCKED");
  assert.equal(consumed, 0);
  const replayBlocked = await runAgentLivePreflightTestHarness(readyOptions({
    requestedNavigationScope: "multi_hop_ordinary_warp",
    replayOperation: async () => failedReplay("later_failure"),
    consumeDeferredMultiSourceReceiptClaim: noConsume,
  }));
  assert.equal(replayBlocked.state, "BLOCKED");
  assert.equal(consumed, 0);
  const sourceBlocked = await runAgentLivePreflightTestHarness(readyOptions({
    requestedNavigationScope: "multi_hop_ordinary_warp",
    readNavigationSource: async () => "enter_mine",
    consumeDeferredMultiSourceReceiptClaim: noConsume,
  }));
  assert.equal(sourceBlocked.state, "BLOCKED");
  assert.equal(consumed, 0);
});

test("agent-live: full composed success consumes once and a second invocation blocks", async () => {
  let consumed = false;
  const consumeOnce = async () => {
    if (consumed) return false;
    consumed = true;
    return true;
  };
  const options = readyOptions({
    requestedNavigationScope: "multi_hop_ordinary_warp",
    replayOperation: async (_frames, opts) => completedReplay(opts.mode),
    consumeDeferredMultiSourceReceiptClaim: consumeOnce,
  });
  const first = await runAgentLivePreflightTestHarness(options);
  assert.equal(first.state, "PREFLIGHT_READY");
  const second = await runAgentLivePreflightTestHarness(options);
  assert.equal(second.state, "BLOCKED");
  assert.equal(second.items.find((i) => i.name === "multi_source_receipt").status, "blocked");
});

test("agent-live: deferred receipt consumption failure blocks the complete composition", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions({
    requestedNavigationScope: "multi_hop_ordinary_warp",
    replayOperation: async (_frames, opts) => completedReplay(opts.mode),
    consumeDeferredMultiSourceReceiptClaim: async () => false,
  }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.items.find((i) => i.name === "multi_source_receipt").status, "blocked");
});

test("agent-live: current_source_only topology blocker is respected with multi-hop scope", async () => {
  // Run topology that returns BLOCKED with current_source_only blocker.
  const blockingTopology = async () => topologyResult(false);
  const report = await runAgentLivePreflightTestHarness(readyOptions({
    runTopologyPreflight: blockingTopology,
    requestedNavigationScope: "multi_hop_ordinary_warp",
  }));
  assert.equal(report.state, "BLOCKED");
  assert.equal(report.items.find((i) => i.name === "topology").status, "blocked");
});

test("agent-live harness: no requestedNavigationScope preserves backward compatibility", async () => {
  const report = await runAgentLivePreflightTestHarness(readyOptions());
  assert.equal(report.state, "PREFLIGHT_READY", JSON.stringify(report.items));
  assert.equal(report.ready, true);
});

test("agent-live production: static imports and data-only options cannot select test authority", async () => {
  const source = await readFile(PRODUCTION_SOURCE, "utf8");
  assert.match(source, /import\s+\{\s*consumeDeferredMultiSourceReceiptClaim,\s*runTopologyPreflight,?\s*\}\s+from\s+"\.\/stardew-navigation-topology-preflight\.mjs"/s);
  assert.match(source, /import\s+\{\s*replayNavigationOperation\s*\}\s+from\s+"\.\/replay-stardew-navigation-operation\.mjs"/);
  assert.equal(source.includes(".test-harness."), false);
  assert.equal(source.includes("runAgentLivePreflightTestHarness"), false);
  for (const forbidden of [
    "options.runTopologyPreflight", "options.consumeDeferredMultiSourceReceiptClaim",
    "options.replayOperation", "options.testHostSurface", "options.exists",
    "options.readNavigationDirectory", "options.readNavigationSource", "options.readVersion",
    "options.testMultiSourceReceiptLedger", "options.replayOptions",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /export\s+async\s+function\s+runAgentLivePreflight/);
  assert.equal((source.match(/^export\s+(?:async\s+)?(?:function|const|class)\s+/gm) ?? []).length, 1);
});

test("agent-live production: listed authority overrides fail closed and cannot consume", { skip: !existsSync(HOST_TEST_MOUNT) }, async () => {
  const { runAgentLivePreflight } = await import("./preflight-stardew-navigation-agent-live.mjs");
  let topologyCalls = 0;
  let consumeCalls = 0;
  let replayCalls = 0;
  const report = await runAgentLivePreflight({
    transitionArtifact: "missing-transition.json",
    multiSourceTransitionArtifact: "missing-multi-source.json",
    requestedNavigationScope: "multi_hop_ordinary_warp",
    replayFrames: SYNTHETIC_FRAMES,
    runTopologyPreflight: async () => { topologyCalls += 1; return topologyResult(true); },
    consumeDeferredMultiSourceReceiptClaim: async () => { consumeCalls += 1; return true; },
    replayOperation: async () => { replayCalls += 1; return completedReplay("multi_hop_ordinary_warp"); },
    testHostSurface: {},
    exists: async () => true,
    readNavigationDirectory: async () => [],
    readNavigationSource: async () => "",
    readVersion: async () => "1.6.15.24356",
    testMultiSourceReceiptLedger: { preparePassedClaim: () => ({ ok: true }), consume: async () => true },
  });
  assert.equal(report.ready, false);
  assert.equal(topologyCalls, 0);
  assert.equal(consumeCalls, 0);
  assert.equal(replayCalls, 0);
  assert.equal(JSON.stringify(report).match(/raw|digest|ledger|registry|root|marker|claim|inject/i), null);
});
