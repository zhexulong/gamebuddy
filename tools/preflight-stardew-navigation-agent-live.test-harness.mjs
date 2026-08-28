#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  consumeDeferredMultiSourceReceiptClaim,
  runTopologyPreflight,
} from "./stardew-navigation-topology-preflight.mjs";

/**
 * Composed non-mutating agent-live preflight for the Task 7 navigation gate.
 * It composes the replay + topology preflights and statically verifies the
 * existing typed Host surface, the completion predicate strictness, the no-M8
 * navigation path, and the fixture transaction/teardown chain. It never
 * launches Stardew, connects a pipe, writes fixtures, calls execute(), or
 * fabricates a committed target artifact. The report is bounded and redacted;
 * `ready` is true only when every item is checked.
 */
const TOOLS_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_DIR = fileURLToPath(new URL("../", import.meta.url));
const NAVIGATE_TOOL_NAME = "stardew_navigate_to_destination";

const SURFACE_SOURCES = Object.freeze({
  gameTools: "game-tools.js",
  protocol: "protocol.js",
  actionRegistry: "action-registry.js",
  integrationModule: "stardew-integration-module.js",
});
const SURFACE_DIR = fileURLToPath(new URL("../host/dist-test/", import.meta.url));
function item(name, status, detail = "") {
  return Object.freeze({ name, status, detail: String(detail ?? "") });
}
function blockedReport(items) {
  return Object.freeze({
    state: "BLOCKED",
    topology: "single_player_native_companion",
    items: Object.freeze(items),
    mutationCount: 0,
    executionReceiptCount: 0,
    ready: false,
  });
}
function readyReport(items) {
  return Object.freeze({
    state: "PREFLIGHT_READY",
    topology: "single_player_native_companion",
    items: Object.freeze(items),
    mutationCount: 0,
    executionReceiptCount: 0,
    ready: true,
  });
}
const FIXTURE_PATH_REQUIREMENTS = Object.freeze([
  "prepare-stardew-action-fixture.ps1",
  "restore-stardew-native-local-player-fixture.mjs",
  "run-stardew-native-local-player-navigation-read-only-fixture.ps1",
  "lib/stardew-native-local-player-fixture.mjs",
]);
const FIXTURE_LIB_EXPORTS = Object.freeze([
  "export function fixtureActions(",
  "export function fixtureScenario(",
  "export async function restoreNativeLocalPlayerFixture(",
]);
const M8_ANCHORS = Object.freeze(["enter_mine", "use_mine_ladder", "select_mine_elevator_floor", "reach_mine_floor"]);
// The live Navigation execution call path (Mod-owned runtime seam) is scanned
// for the no-M8 boundary together with the existing Navigation sources.
const EXECUTION_PATH_FILES = Object.freeze([
  "ExecutionManager.cs",
  "ExecutionManager.MovementHandlers.cs",
  "BridgeSession.cs",
  "ModEntry.cs",
]);
// Every current Navigation implementation source is required, while the
// directory enumeration also covers later additions. A missing expected source,
// unreadable discovered source, or M8 anchor anywhere in either set blocks.
const REQUIRED_NAVIGATION_SOURCE_FILES = Object.freeze([
  "DerivedDestinationSet.cs",
  "DestinationSearch.cs",
  "Game1NavigationWorldSource.cs",
  "NavigationContracts.cs",
  "NavigationExecutionCoordinator.cs",
  "NavigationLifecycle.cs",
  "NavigationReferenceStore.cs",
  "NavigationRoutePlanner.cs",
  "WorldMapProjection.cs",
  "ExecutionModels.cs",
]);

async function defaultExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}
async function defaultReadNavigationDirectory(directory) {
  return await readdir(directory, { withFileTypes: true });
}
async function defaultReadNavigationSource(directory, name) {
  return await readFile(directory + "/" + name, "utf8");
}
export async function runAgentLivePreflightTestHarness(options = {}) {
  const runTopology = options.runTopologyPreflight ?? runTopologyPreflight;
  const consumeDeferredReceipt = options.consumeDeferredMultiSourceReceiptClaim ?? consumeDeferredMultiSourceReceiptClaim;
  const replayOperation = options.replayOperation ?? (async () => null);
  const testHostSurface = options.testHostSurface;
  const exists = options.exists ?? defaultExists;
  const readNavigationDirectory = options.readNavigationDirectory ?? defaultReadNavigationDirectory;
  const readNavigationSource = options.readNavigationSource ?? defaultReadNavigationSource;
  const items = [];
  const artifactPath = options.transitionArtifact;
  const multiSourceArtifactPath = options.multiSourceTransitionArtifact;
  const navSrcDir = options.navigationSrcDir ?? PROJECT_DIR + "integrations/stardew/Navigation";
  const integrationSrcDir = options.integrationSrcDir ?? PROJECT_DIR + "integrations/stardew";
  const requestedNavigationScope = options.requestedNavigationScope;

  if (!artifactPath) {
    items.push(item("transition_artifact", "blocked", "missing transition-artifact input"));
    return blockedReport(items);
  }
  let topology = null;
  try {
    topology = await runTopology({
      gamePath: options.gamePath,
      releaseDir: options.releaseDir,
      transitionArtifact: artifactPath,
      multiSourceTransitionArtifact: multiSourceArtifactPath,
      navigationSrcDir: navSrcDir,
      readVersion: options.readVersion,
      requestedNavigationScope,
      deferMultiSourceReceiptConsume: requestedNavigationScope === "multi_hop_ordinary_warp",
    });
  } catch {
    topology = { state: "BLOCKED", ready: false };
  }
  const topoOk = topology && topology.ready === true && topology.state === "PREFLIGHT_READY";
  items.push(item("topology", topoOk ? "ready" : "blocked", topoOk ? "install+bundle+artifact+source ok" : "topology not ready"));
async function readText(filePath) {
  return await readFile(filePath, "utf8");
}

  let surface = testHostSurface ?? null;
  if (!surface) {
    try {
      surface = {
        gameTools: await readText(SURFACE_DIR + SURFACE_SOURCES.gameTools),
        protocol: await readText(SURFACE_DIR + SURFACE_SOURCES.protocol),
        registry: await readText(SURFACE_DIR + SURFACE_SOURCES.actionRegistry),
        module: await readText(SURFACE_DIR + SURFACE_SOURCES.integrationModule),
      };
    } catch { surface = null; }
  }
  const navigateAdapter = options.stardewActionAdapters?.find((a) => a.actionId === "navigate_to_destination");
  const toolNameOk = options.stardewActionToolNames?.navigate_to_destination === NAVIGATE_TOOL_NAME;
  const argsOk = !!navigateAdapter && JSON.stringify(navigateAdapter.targetKinds) === JSON.stringify(["destination"]);
  const noDestinationRef = !!surface &&
    !surface.gameTools.includes("destinationRef") &&
    !surface.protocol.includes("destinationRef") &&
    !surface.registry.includes("destinationRef");
  const selectorRefOk = !!surface && surface.protocol.includes('value.kind === "ref"');
  const navToolBlock = !!surface && surface.gameTools.includes('action: "navigate_to_destination"');
  let surfaceDetail = "host surface ok";
  const surfaceFails = [];
  if (!toolNameOk) surfaceFails.push("tool_name");
  if (!argsOk) surfaceFails.push("args_not_destination_only");
  if (!noDestinationRef) surfaceFails.push("destinationRef_compat");
  if (!selectorRefOk) surfaceFails.push("selector_ref");
  if (!navToolBlock) surfaceFails.push("navigate_tool_missing");
  if (surfaceFails.length > 0) surfaceDetail = "blocked: " + surfaceFails.join(",");
  items.push(item("host_tool_surface", surfaceFails.length === 0 ? "ready" : "blocked", surfaceDetail));
  // Completion predicate strictness (mounted Mod-owned navigation predicate).
  const completionStrict = !!surface && surface.module.includes("reasonCode === \"navigation_completed\"") &&
    surface.module.includes("hasNavigationCompletionEvidence") &&
    surface.module.includes("evidence.arrived === \"true\"") &&
    surface.module.includes("evidence.postcondition === \"true\"");
  items.push(item("completion_predicate", completionStrict ? "ready" : "blocked", completionStrict ? "completion predicate strict" : "completion predicate not strict"));

  // Caller-supplied real-shaped replay frames (never internally fabricated).
  let replayFrames = options.replayFrames;
  if (Array.isArray(replayFrames)) {
    items.push(item("replay_frames", "ready", "caller-supplied replay frames"));
  } else if (options.replayFramesPath) {
    try {
      const parsed = JSON.parse(await readFile(options.replayFramesPath, "utf8"));
      replayFrames = Array.isArray(parsed) ? parsed : [parsed];
      items.push(item("replay_frames", "ready", "replay-frames file ok"));
    } catch {
      replayFrames = null;
      items.push(item("replay_frames", "blocked", "replay-frames file missing/unreadable/invalid"));
    }
  } else {
    replayFrames = null;
    items.push(item("replay_frames", "blocked", "caller-supplied replay frames required"));
  }
  // Receipt lineage replay: execute caller-supplied frames through the real
  // Host boundary validator and the Mod-owned completion predicate. Only the
  // exact completed terminal is ready; terminal failure/blocked is fail-closed.
  let replayReport = null;
  let replayDetail = "replay frames required";
  if (Array.isArray(replayFrames)) {
    const replayOpts = { ...(options.replayOptions ?? {}) };
    // When requestedNavigationScope is multi_hop_ordinary_warp, enforce
    // matching multi-hop replay mode. The resulting replay must attest to
    // the multi-hop constraints, not merely a generic green replay.
    if (requestedNavigationScope === "multi_hop_ordinary_warp") {
      replayOpts.mode = "multi_hop_ordinary_warp";
    }
    try {
      replayReport = await replayOperation(replayFrames, replayOpts);
    } catch {
      replayReport = null;
      replayDetail = "replayOperation threw";
    }
  }
  const expectedReplayMode = requestedNavigationScope === "multi_hop_ordinary_warp"
    ? "multi_hop_ordinary_warp"
    : undefined;
  const replayReady =
    !!replayReport &&
    replayReport.ok === true &&
    replayReport.valid === true &&
    replayReport.success === true &&
    replayReport.state === "navigation_replay_completed" &&
    (expectedReplayMode === undefined || replayReport.mode === expectedReplayMode);
  if (!replayReady && replayReport && replayReport.blocker) {
    replayDetail = `replay blocked: ${replayReport.blocker.code ?? "unknown"}`;
  } else if (!replayReady && expectedReplayMode && replayReport) {
    replayDetail = `replay mode mismatch: expected ${expectedReplayMode}, got ${replayReport.mode ?? "none"}`;
  }
  items.push(item("receipt_lineage_replay", replayReady ? "ready" : "blocked", replayReady ? "navigation_replay_completed" : replayDetail));
  const fixtureMissing = [];
  for (const rel of FIXTURE_PATH_REQUIREMENTS) {
    if (!(await exists(TOOLS_DIR + rel))) fixtureMissing.push(rel);
  }
  let fixtureLibOk = true;
  if (await exists(TOOLS_DIR + "lib/stardew-native-local-player-fixture.mjs")) {
    const libText = await readText(TOOLS_DIR + "lib/stardew-native-local-player-fixture.mjs");
    fixtureLibOk = FIXTURE_LIB_EXPORTS.every((exp) => libText.includes(exp));
  } else {
    fixtureLibOk = false;
  }
  const fixtureOk = fixtureMissing.length === 0 && fixtureLibOk;
  items.push(item("fixture_teardown_path", fixtureOk ? "ready" : "blocked", fixtureOk ? "fixture runner/teardown present" : "missing: " + fixtureMissing.join(",")));

  // No M8 action in the navigation path (static source scan over the live
  // Navigation execution call path plus the existing Navigation sources).
  let m8Present = false;
  let navSourcesReadable = true;
  let navigationSourceNames = [];
  try {
    const entries = await readNavigationDirectory(navSrcDir);
    if (!Array.isArray(entries)) throw new Error("navigation directory listing invalid");
    navigationSourceNames = entries
      .filter((entry) => typeof entry === "string"
        ? entry.endsWith(".cs")
        : entry?.isFile?.() && entry.name?.endsWith(".cs"))
      .map((entry) => typeof entry === "string" ? entry : entry.name)
      .sort();
    if (navigationSourceNames.length === 0 || REQUIRED_NAVIGATION_SOURCE_FILES.some((name) => !navigationSourceNames.includes(name)))
      throw new Error("required navigation source missing");
  } catch { navSourcesReadable = false; }
  for (const name of [...EXECUTION_PATH_FILES, ...navigationSourceNames]) {
    const dir = EXECUTION_PATH_FILES.includes(name) ? integrationSrcDir : navSrcDir;
    try {
      const text = await readNavigationSource(dir, name);
      if (M8_ANCHORS.some((a) => text.includes(a))) m8Present = true;
    } catch { navSourcesReadable = false; }
  }
  const noM8Ok = navSourcesReadable && !m8Present;
  items.push(item("no_m8_navigation_path", noM8Ok ? "ready" : "blocked", noM8Ok ? "no M8 anchors in execution path + every Navigation source" : "m8 anchor present, required source missing, or sources unreadable"));

  const allReady = items.every((i) => i.status === "ready");
  if (!allReady) return blockedReport(items);
  if (requestedNavigationScope === "multi_hop_ordinary_warp") {
    // The deferred marker is the final composition readiness linearization
    // point. It is a controlled local receipt-consumption side effect only.
    const consumed = await consumeDeferredReceipt(topology);
    items.push(item("multi_source_receipt", consumed ? "ready" : "blocked", consumed ? "registry-pinned receipt consumed" : "receipt consumption failed"));
    if (!consumed) return blockedReport(items);
  }
  return readyReport(items);
}
