import assert from "node:assert";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSEMBLY_NAME,
  BUNDLE_FILES,
  BUNDLE_MANIFEST_ENTRY_DLL,
  BUNDLE_MANIFEST_UNIQUE_ID,
  NAVIGATION_SOURCES,
  runTopologyPreflight,
} from "./stardew-navigation-topology-preflight.mjs";
import {
  OBSERVATION_SCOPE,
} from "./stardew-navigation-multisource-characterization-validator.mjs";
import { createHash } from "node:crypto";
import { createTestMultiSourceReceiptLedger } from "./stardew-navigation-multisource-receipt-ledger.mjs";

/**
 * Deterministic topology-preflight regression. Synthetic real-shaped bundle,
 * game install and caller-supplied transition artifact are materialized under a
 * temporary directory; production invocation never reads them as target proof.
 */
const VERSION = "1.6.15.24356";

function passArtifact(overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    terminalStatus: "passed",
    targetBuild: "1.6.15.24356",
    targetBinding: "tb1_7a1c9e0d22b4f6a1c3e5d7098a2b4c6e8d0f1a3c5d7e9f1a3b5c7d9e1f3a5b7c",
    methodAnchors: Object.freeze({
      warpResolver: "GameLocation.warps",
      doorResolver: "GameLocation.getWarpFromDoor",
      approachPlanner: "PathFindController",
      correlation: "IPlayerEvents.Warped",
    }),
    observationScope: "current_source_only",
    opaqueEdgeIds: ["te1_91aF2bC3dE4f5a6b7c8d9e0f1A2B3c4D"],
    permittedFamilyCounts: { ordinaryWarp: 1, ordinaryDoor: 0 },
    excludedFamilyCounts: { action: 0, touchAction: 0, modHook: 0, special: 0, m8: 0, missingIdentity: 0, unsafeApproach: 0 },
    dryPlanSafe: true,
    correlationApiShapeVerified: true,
    mutationCount: 0,
    executionReceiptCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true },
    predicateCode: "successful_characterization",
    ...overrides,
  });
}

function makeFixture(options = {}) {
  const {
    artifact = passArtifact(),
    bundle = true,
    manifestUnique = BUNDLE_MANIFEST_UNIQUE_ID,
    entryDll = BUNDLE_MANIFEST_ENTRY_DLL,
    sources = true,
    version = VERSION,
  } = options;
  const dir = mkdtempSync(join(tmpdir(), "nav-topo-"));
  const game = join(dir, "game");
  const release = join(game, "release");
  const navSrc = join(game, "Nav");
  mkdirSync(release, { recursive: true });
  mkdirSync(navSrc, { recursive: true });
  writeFileSync(join(game, ASSEMBLY_NAME), "fake");
  if (bundle) {
    for (const name of BUNDLE_FILES) {
      writeFileSync(join(release, name), name === "manifest.json"
        ? JSON.stringify({ UniqueID: manifestUnique, EntryDll: entryDll })
        : "bundle-bytes");
    }
  }
  for (const name of NAVIGATION_SOURCES) {
    writeFileSync(join(navSrc, name), sources ? "// GameLocation.warps warps" : "// empty");
  }
  const artifactPath = join(dir, "artifact.json");
  writeFileSync(artifactPath, JSON.stringify(artifact));
  const readVersion = async () => version;
  return {
    dir, game, release, navSrc, artifactPath,
    readVersion,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function opts(t) {
  return { gamePath: t.game, releaseDir: t.release, transitionArtifact: t.artifactPath, navigationSrcDir: t.navSrc, readVersion: t.readVersion };
}

function multiSourcePassArtifact(overrides = {}) {
  return {
    schemaVersion: 1,
    terminalStatus: "passed",
    targetBuild: "1.6.15.24356",
    observationScope: "multi_hop_ordinary_warp",
    productionExtractorInvoked: true,
    productionExtractorInvocationCount: 1,
    gameThreadObserved: true,
    worldReadyObserved: true,
    multiSourceObserved: true,
    ordinaryWarpFamilyObserved: true,
    correlationApiShapeVerified: true,
    gameplayMutationCount: 0,
    playerWarpEventCount: 0,
    executionReceiptCount: 0,
    bridgeOrCatalogPublicationCount: 0,
    fixtureCleanup: { restored: true, noStardewProcess: true, noSmapiProcess: true, temporaryProfileRemoved: true },
    predicateCode: "successful_multisource_characterization",
    ...overrides,
  };
}

function makeMultiFixture(options = {}) {
  const {
    artifact = multiSourcePassArtifact(),
    bundle = true,
    manifestUnique = BUNDLE_MANIFEST_UNIQUE_ID,
    entryDll = BUNDLE_MANIFEST_ENTRY_DLL,
    sources = true,
    version = VERSION,
  } = options;
  const dir = mkdtempSync(join(tmpdir(), "nav-multi-"));
  const game = join(dir, "game");
  const release = join(game, "release");
  const navSrc = join(game, "Nav");
  mkdirSync(release, { recursive: true });
  mkdirSync(navSrc, { recursive: true });
  writeFileSync(join(game, ASSEMBLY_NAME), "fake");
  if (bundle) {
    for (const name of BUNDLE_FILES) {
      writeFileSync(join(release, name), name === "manifest.json"
        ? JSON.stringify({ UniqueID: manifestUnique, EntryDll: entryDll })
        : "bundle-bytes");
    }
  }
  for (const name of NAVIGATION_SOURCES) {
    writeFileSync(join(navSrc, name), sources ? "// GameLocation.warps warps" : "// empty");
  }
  const artifactPath = join(dir, "artifact.json");
  writeFileSync(artifactPath, JSON.stringify(artifact));
  const readVersion = async () => version;
  return {
    dir, game, release, navSrc, artifactPath,
    readVersion,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function multiOpts(t, extra = {}) {
  return { gamePath: t.game, releaseDir: t.release, multiSourceTransitionArtifact: t.artifactPath, navigationSrcDir: t.navSrc, readVersion: t.readVersion, requestedNavigationScope: "multi_hop_ordinary_warp", transitionArtifact: undefined, ...extra };
}

function receiptLedgerFor(t) {
  const root = join(t.dir, "ledger");
  const raw = readFileSync(t.artifactPath);
  return {
    root,
    ledger: createTestMultiSourceReceiptLedger({
      root,
      registry: [{ receiptId: "topology_test_receipt", artifactSha256: createHash("sha256").update(raw).digest("hex"), targetBuild: VERSION, observationScope: "multi_hop_ordinary_warp" }],
    }),
  };
}

test("topology: a fully validated install, bundle, artifact and source set is PREFLIGHT_READY", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "PREFLIGHT_READY");
    assert.equal(report.mutationCount, 0);
    assert.equal(report.executionReceiptCount, 0);
    assert.equal(report.checks.artifact.allowed, true);
  } finally { t.cleanup(); }
});

test("topology: a missing transition artifact is a named fail-closed blocker", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight({ ...opts(t), transitionArtifact: undefined });
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "artifact_required"), true);
  } finally { t.cleanup(); }
});

test("topology: a blocked (non-pass) artifact is never ready", async () => {
  const blocked = passArtifact({ terminalStatus: "blocked", predicateCode: "approach_not_safe", dryPlanSafe: false, correlationApiShapeVerified: false });
  const t = makeFixture({ artifact: blocked });
  try {
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.checks.artifact.allowed, false);
  } finally { t.cleanup(); }
});

test("topology: a mutationCount>0 artifact is rejected", async () => {
  const t = makeFixture({ artifact: passArtifact({ mutationCount: 1 }) });
  try {
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "artifact_invalid"), true);
  } finally { t.cleanup(); }
});

test("topology: an ordinaryDoor permitted family (not the implemented slice) is blocked", async () => {
  const t = makeFixture({
    artifact: passArtifact({
      permittedFamilyCounts: { ordinaryWarp: 1, ordinaryDoor: 1 },
      opaqueEdgeIds: ["te1_91aF2bC3dE4f5a6b7c8d9e0f1A2B3c4D", "te1_02b4C6d8E0f2a3b4c5d6e7f8a9b0A1B2C"],
    }),
  });
  try {
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "ordinary_warp_only_violated"), true);
  } finally { t.cleanup(); }
});

test("topology: a wrong target build version is a blocker", async () => {
  const t = makeFixture({ version: "1.6.14.9999" });
  try {
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "version_mismatch"), true);
  } finally { t.cleanup(); }
});test("topology: a missing bundle file is a blocker", async () => {
  const t = makeFixture();
  try {
    const { rmSync: rm } = t;
    rmSync(join(t.release, "GameBuddy.Stardew.dll"), { force: true });
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "bundle_missing"), true);
  } finally { t.cleanup(); }
});

test("topology: a wrong manifest UniqueID is a blocker", async () => {
  const t = makeFixture({ manifestUnique: "other.Mod" });
  try {
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "unique_id_mismatch"), true);
  } finally { t.cleanup(); }
});

test("topology: multi_hop_ordinary_warp scope with current_source_only artifact is blocked", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight({ ...opts(t), requestedNavigationScope: "multi_hop_ordinary_warp" });
    assert.equal(report.state, "BLOCKED");
    const scopeBlocker = report.blockers.find((b) => b.check === "transition_scope");
    assert.ok(scopeBlocker, "expected transition_scope blocker");
    assert.equal(scopeBlocker.reason, "current_source_only_cannot_authorize_multi_hop");
  } finally { t.cleanup(); }
});

test("topology: unknown requestedNavigationScope fails closed", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight({ ...opts(t), requestedNavigationScope: "multi_hop_doors_and_special" });
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "unknown_requested_scope"), true);
  } finally { t.cleanup(); }
});

test("topology: omitted requestedNavigationScope preserves backward compatibility", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight(opts(t));
    assert.equal(report.state, "PREFLIGHT_READY");
  } finally { t.cleanup(); }
});

// ====== Multi-source artifact tests ======

test("topology: valid multi-source artifact with no production registry entry is blocked", async () => {
  const t = makeMultiFixture();
  try {
    const report = await runTopologyPreflight(multiOpts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "multi_source_receipt_required_or_invalid"), true);
  } finally { t.cleanup(); }
});

test("topology: a caller-supplied ledger is ignored and cannot authorize or mark a structurally valid passed artifact", async () => {
  const t = makeMultiFixture();
  try {
    const receipt = receiptLedgerFor(t);
    const report = await runTopologyPreflight(multiOpts(t, { testMultiSourceReceiptLedger: receipt.ledger }));
    assert.equal(report.state, "BLOCKED", JSON.stringify(report.blockers));
    assert.equal(report.blockers.some((b) => b.reason === "multi_source_receipt_required_or_invalid"), true);
    assert.equal(existsSync(join(receipt.root, "topology_test_receipt.json")), false);
  } finally { t.cleanup(); }
});

test("topology: multi_hop_ordinary_warp with missing multi-source artifact is blocked", async () => {
  const t = makeMultiFixture();
  try {
    const report = await runTopologyPreflight({ ...multiOpts(t), multiSourceTransitionArtifact: undefined });
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "multi_source_artifact_required_or_invalid"), true);
  } finally { t.cleanup(); }
});

test("topology: multi_hop_ordinary_warp with unreadable multi-source artifact is blocked", async () => {
  const t = makeMultiFixture();
  try {
    const report = await runTopologyPreflight({ ...multiOpts(t), multiSourceTransitionArtifact: "/nonexistent/path.json" });
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "multi_source_artifact_required_or_invalid"), true);
  } finally { t.cleanup(); }
});

test("topology: multi_hop_ordinary_warp with blocked multi-source artifact is blocked", async () => {
  const blocked = multiSourcePassArtifact({
    terminalStatus: "blocked",
    predicateCode: "world_not_ready",
    productionExtractorInvoked: false,
    productionExtractorInvocationCount: 0,
    worldReadyObserved: false,
  });
  const t = makeMultiFixture({ artifact: blocked });
  try {
    const report = await runTopologyPreflight(multiOpts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "multi_source_artifact_required_or_invalid"), true);
  } finally { t.cleanup(); }
});

test("topology: multi_hop_ordinary_warp with invalid multi-source artifact (wrong schema) is blocked", async () => {
  const bad = multiSourcePassArtifact({ extraField: "unknown" });
  const t = makeMultiFixture({ artifact: bad });
  try {
    const report = await runTopologyPreflight(multiOpts(t));
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "multi_source_artifact_required_or_invalid"), true);
  } finally { t.cleanup(); }
});

test("topology: multi_hop_ordinary_warp with valid source-only artifact but no multi-source artifact is blocked", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight({ ...opts(t), multiSourceTransitionArtifact: undefined, requestedNavigationScope: "multi_hop_ordinary_warp" });
    assert.equal(report.state, "BLOCKED");
    assert.equal(report.blockers.some((b) => b.reason === "multi_source_artifact_required_or_invalid"), true);
    // The old transition artifact is not required for multi-hop scope, so no artifact_required blocker
    assert.equal(report.blockers.some((b) => b.reason === "artifact_required"), false);
  } finally { t.cleanup(); }
});

test("topology: multi_hop_ordinary_warp with both source-only (passed) and valid multi-source is blocked because source-only scope is current_source_only", async () => {
  // Create a fixture with both passed source-only and valid multi-source artifacts
  // The source-only artifact with current_source_only scope should produce the
  // current_source_only_cannot_authorize_multi_hop scope blocker, making the
  // overall report BLOCKED even though the multi-source artifact is valid.
  const t = makeFixture();
  const multiSrc = makeMultiFixture();
  try {
    const receipt = receiptLedgerFor(multiSrc);
    const report = await runTopologyPreflight({ ...opts(t), multiSourceTransitionArtifact: multiSrc.artifactPath, requestedNavigationScope: "multi_hop_ordinary_warp", testMultiSourceReceiptLedger: receipt.ledger });
    assert.equal(report.state, "BLOCKED", JSON.stringify(report.blockers));
    assert.equal(report.checks.multiSourceArtifact.status, "blocked");
    assert.equal(existsSync(join(receipt.root, "topology_test_receipt.json")), false);
    assert.ok(report.blockers.some((b) => b.check === "transition_scope" && b.reason === "current_source_only_cannot_authorize_multi_hop"),
      "expected current_source_only_cannot_authorize_multi_hop scope blocker");
  } finally { t.cleanup(); multiSrc.cleanup(); }
});

test("topology: omitted requestedNavigationScope does not require multi-source artifact", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight({ ...opts(t), multiSourceTransitionArtifact: undefined });
    assert.equal(report.state, "PREFLIGHT_READY");
    assert.equal(report.checks.multiSourceArtifact, undefined);
  } finally { t.cleanup(); }
});

test("topology: current_source_only scope does not require multi-source artifact", async () => {
  const t = makeFixture();
  try {
    const report = await runTopologyPreflight({ ...opts(t), multiSourceTransitionArtifact: undefined, requestedNavigationScope: "current_source_only" });
    assert.equal(report.state, "PREFLIGHT_READY");
  } finally { t.cleanup(); }
});

test("topology: public options expose no ledger override", async () => {
  const source = readFileSync(new URL("./stardew-navigation-topology-preflight.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("options.testMultiSourceReceiptLedger"), false);
  assert.equal(source.includes("--ledger-root"), false);
  assert.equal(source.includes("--receipt-registry"), false);
});
