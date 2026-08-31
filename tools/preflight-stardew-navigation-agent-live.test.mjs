import assert from "node:assert";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runAgentLivePreflightTestHarness } from "./preflight-stardew-navigation-agent-live.test-harness.mjs";

const PRODUCTION_SOURCE = new URL("./preflight-stardew-navigation-agent-live.mjs", import.meta.url);
const FIXTURE_EXPORTS = [
  "export function fixtureActions(",
  "export function fixtureScenario(",
  "export async function restoreNativeLocalPlayerFixture(",
].join("\n");

function readyOptions(overrides = {}) {
  return {
    gamePath: "game",
    releaseDir: "release",
    isDirectory: async () => true,
    exists: async () => true,
    readFile: async () => FIXTURE_EXPORTS,
    ...overrides,
  };
}

function item(report, name) {
  return report.items.find((entry) => entry.name === name);
}

test("agent-live: environment and fixture admission is ready without receipt evidence", async () => {
  const result = await runAgentLivePreflightTestHarness(readyOptions());
  assert.equal(result.state, "PREFLIGHT_READY", JSON.stringify(result.items));
  assert.equal(result.ready, true);
  assert.equal(result.mutationCount, 0);
  assert.equal(result.executionReceiptCount, 0);
  assert.deepEqual(result.items.map((entry) => entry.name), ["runtime_paths", "fixture_transaction"]);
  for (const entry of result.items) assert.equal(entry.status, "ready", entry.name);
});

test("agent-live: inaccessible game or release path blocks without consuming any receipt", async () => {
  const result = await runAgentLivePreflightTestHarness(readyOptions({
    isDirectory: async (path) => path === "game",
  }));
  assert.equal(result.state, "BLOCKED");
  assert.equal(item(result, "runtime_paths").status, "blocked");
  assert.equal(result.executionReceiptCount, 0);
});

test("agent-live: a missing fixture owner blocks", async () => {
  const result = await runAgentLivePreflightTestHarness(readyOptions({
    exists: async (path) => !path.endsWith("restore-stardew-native-local-player-fixture.mjs"),
  }));
  assert.equal(result.state, "BLOCKED");
  assert.equal(item(result, "fixture_transaction").status, "blocked");
});

test("agent-live: unreadable fixture contract blocks", async () => {
  const result = await runAgentLivePreflightTestHarness(readyOptions({
    readFile: async () => "export function fixtureActions() {}",
  }));
  assert.equal(result.state, "BLOCKED");
  assert.equal(item(result, "fixture_transaction").status, "blocked");
});

test("agent-live production: imports only environment and fixture admission dependencies", async () => {
  const source = await readFile(PRODUCTION_SOURCE, "utf8");
  assert.equal(source.includes(".test-harness."), false);
  assert.equal(source.includes("dist-test"), false);
  assert.equal(source.includes("verification-artifact-manifest"), false);
  assert.equal(source.includes("stardew-navigation-verification-surface"), false);
  assert.equal(source.includes("replay-stardew-navigation-operation"), false);
  assert.equal(source.includes("stardew-navigation-topology-preflight"), false);
  for (const forbidden of [
    "transitionArtifact",
    "multiSourceTransitionArtifact",
    "requestedNavigationScope",
    "replayFrames",
    "receipt_lineage_replay",
    "consumeDeferredMultiSourceReceiptClaim",
    "ledger",
    "registry",
    "marker",
    "claim",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.match(source, /export\s+async\s+function\s+runAgentLivePreflight/);
});

test("agent-live production: rejects former authority/replay/topology option shapes", async () => {
  const { runAgentLivePreflight } = await import("./preflight-stardew-navigation-agent-live.mjs");
  const result = await runAgentLivePreflight({
    gamePath: "game",
    releaseDir: "release",
    replayFrames: [],
  });
  assert.equal(result.state, "BLOCKED");
  assert.equal(item(result, "input").status, "blocked");
  assert.equal(result.executionReceiptCount, 0);
});
