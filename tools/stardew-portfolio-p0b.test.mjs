import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  computePortfolioBindingHash,
  inspectPortfolioP0b,
  PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
  PORTFOLIO_TARGET_GAME_SHA256,
  PORTFOLIO_TARGET_SMAPI_VERSION,
  PORTFOLIO_TARGET_VERSION,
  signPortfolioStartManifest,
  validatePortfolioInstallationAttestation,
  validatePortfolioStartManifest,
} from "./lib/stardew-portfolio-p0b.mjs";
import { PORTFOLIO_TOPOLOGY } from "./lib/stardew-portfolio-profile.mjs";

const KEY = "untracked-test-key-portfolio-p0b";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const SAVE_NAME = "GameBuddyPortfolioNative02";
const OBSERVED_SAVE_SLOT = "GameBuddyPortfolioNative02_445880081";

function terminalFacts(overrides = {}) {
  return {
    state: "none",
    checkedMilestones: ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"],
    terminalRewards: 0,
    finalStepState: "absent",
    receiptsWritten: 0,
    postconditionsWritten: 0,
    ...overrides,
  };
}
const NATIVE_SCOPE = {
  saveId: SAVE_NAME,
  worldId: "world_01",
  localPlayerId: "player_01",
  companionId: "companion_01",
  bindingGeneration: 1,
  bindingHash: computePortfolioBindingHash({
    saveId: SAVE_NAME,
    worldId: "world_01",
    localPlayerId: "player_01",
    companionId: "companion_01",
    bindingGeneration: 1,
  }),
  singlePlayer: true,
  masterGame: true,
};
function startManifest(overrides = {}) {
  const unsigned = {
    schemaVersion: 1,
    artifactKind: "portfolio_start_manifest",
    topology: PORTFOLIO_TOPOLOGY,
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    saveFileSha256: HASH_A,
    saveGameInfoSha256: HASH_B,
    nativeLifecycle: {
      loadApi: "SaveGame.Load",
      saveEvents: ["Saving", "Saved"],
      reopenVerified: true,
      nativePlayerScopeObserved: true,
      nativePlayerScope: NATIVE_SCOPE,
      observedAtUnixMs: 1_800_000_000_000,
    },
    evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
    terminalFacts: terminalFacts(),
    fixtureSafety: {
      sourceKind: "native_clean_save",
      debugSetup: false,
      saveMutation: false,
      preloadedFinalResult: false,
      fixtureNamespace: null,
      manualTargetSelection: false,
    },
    producer: {
      kind: "target_version_native_mod",
      modUniqueId: "zhexulong.GameBuddy",
      modVersion: "0.1.0",
      sha256: HASH_C,
    },
    ...overrides,
  };
  return signPortfolioStartManifest(unsigned, KEY);
}

function installationAttestation(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "portfolio_installation_attestation",
    topology: PORTFOLIO_TOPOLOGY,
    target: {
      gameVersion: PORTFOLIO_TARGET_VERSION,
      gameSha256: PORTFOLIO_TARGET_GAME_SHA256,
      smapiVersion: PORTFOLIO_TARGET_SMAPI_VERSION,
      smapiSha256: HASH_A,
      smapiExeVersion: PORTFOLIO_TARGET_SMAPI_VERSION,
      smapiExeSha256: HASH_B,
    },
    mod: { version: "0.1.0", dllSha256: HASH_C, manifestSha256: HASH_A, depsSha256: HASH_B },
    host: { sha256: HASH_A, buildId: "test-host-build" },
    ...overrides,
  };
}

test("P0b accepts only a signed clean start manifest with exact native lifecycle", () => {
  const result = validatePortfolioStartManifest(startManifest(), {
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    saveFileSha256: HASH_A,
    saveGameInfoSha256: HASH_B,
    producerSha256: HASH_C,
    producerVersion: "0.1.0",
    evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
    nativeScope: NATIVE_SCOPE,
    signingKey: KEY,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("P0b binds a manifest logical save identity to its observed native slot", () => {
  const result = validatePortfolioStartManifest(startManifest(), {
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    signingKey: KEY,
  });
  assert.equal(result.valid, true);
  const mismatch = validatePortfolioStartManifest(
    startManifest({ observedSaveSlot: "GameBuddyPortfolioNative02_445880082" }),
    { saveName: SAVE_NAME, observedSaveSlot: OBSERVED_SAVE_SLOT, signingKey: KEY },
  );
  assert.ok(mismatch.errors.includes("portfolio_start_manifest_observed_save_slot_mismatch"));
  const malformed = validatePortfolioStartManifest(startManifest({ observedSaveSlot: SAVE_NAME }), {
    saveName: SAVE_NAME,
    observedSaveSlot: SAVE_NAME,
    signingKey: KEY,
  });
  assert.ok(malformed.errors.includes("portfolio_start_manifest_observed_save_slot_invalid"));
});

test("P0b rejects scope binding mutation and evidence schema drift", () => {
  const invalidScope = validatePortfolioStartManifest(
    startManifest({
      nativeLifecycle: {
        ...startManifest().nativeLifecycle,
        nativePlayerScope: { ...NATIVE_SCOPE, bindingHash: "b".repeat(64) },
      },
    }),
    { signingKey: KEY, nativeScope: NATIVE_SCOPE, evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION },
  );
  assert.equal(invalidScope.valid, false);
  assert.ok(invalidScope.errors.includes("portfolio_start_manifest_native_player_scope_binding_hash_mismatch"));
  const drift = validatePortfolioStartManifest(startManifest({ evidenceSchemaRevision: 2 }), {
    signingKey: KEY,
    evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
  });
  assert.ok(drift.errors.includes("portfolio_start_manifest_evidence_schema_revision_mismatch"));
});

test("P0b rejects start-manifest signature mutation and cross-topology fields", () => {
  const signed = startManifest();
  const tampered = { ...signed, terminalFacts: terminalFacts({ terminalRewards: 1 }) };
  const result = validatePortfolioStartManifest(tampered, { signingKey: KEY });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("portfolio_start_manifest_signature_mismatch"));
  const crossTopology = validatePortfolioStartManifest(startManifest({ topology: "native_ai_farmhand_multiplayer" }), {
    signingKey: KEY,
  });
  assert.ok(crossTopology.errors.includes("portfolio_start_manifest_topology_invalid"));
});

test("P0b rejects preloaded results, incomplete scan and fixture provenance", () => {
  const result = validatePortfolioStartManifest(
    startManifest({
      terminalFacts: terminalFacts({ checkedMilestones: ["M1"], terminalRewards: 1 }),
      fixtureSafety: {
        sourceKind: "GameBuddyFixture_native",
        debugSetup: true,
        saveMutation: false,
        preloadedFinalResult: true,
        fixtureNamespace: "GameBuddyFixture_x",
        manualTargetSelection: true,
      },
    }),
    { signingKey: KEY },
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("portfolio_start_manifest_preloaded_result"));
  assert.ok(result.errors.includes("portfolio_start_manifest_milestone_scan_incomplete"));
  assert.ok(result.errors.includes("portfolio_start_manifest_fixture_safety_violation"));
  assert.ok(result.errors.includes("portfolio_start_manifest_fixture_namespace_present"));
});

test("P0b installation attestation requires exact target and SMAPI executable identity", () => {
  const valid = validatePortfolioInstallationAttestation(installationAttestation());
  assert.equal(valid.valid, true);
  const wrong = installationAttestation({ target: { ...installationAttestation().target, gameVersion: "1.6.14" } });
  const result = validatePortfolioInstallationAttestation(wrong);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("portfolio_installation_attestation_target_version_mismatch"));
});

test("P0b fails closed before observed-slot access when save root is a symlink or reparse directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-p0b-root-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "real-saves");
  const saveRoot = join(root, "saves-link");
  await mkdir(target);
  try {
    await symlink(target, saveRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = await inspectPortfolioP0b({
    gamePath: join(root, "missing-game"),
    profileRoot: join(root, "profile"),
    dataRoot: join(root, "data"),
    saveRoot,
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    installationAttestationPath: join(root, "attestation.json"),
    startManifestPath: join(root, "start-manifest.json"),
    hostArtifactPath: join(root, "host.js"),
    signingKey: KEY,
  });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_save_root_symlink_or_reparse_forbidden"));
  assert.equal(result.save.savePath, null);
});

test("P0b rejects a symlinked installation attestation and start manifest before parsing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-p0b-artifact-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, "real.json");
  const link = join(root, "linked.json");
  await writeFile(real, JSON.stringify(installationAttestation()));
  try {
    await symlink(real, link);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const result = await inspectPortfolioP0b({
    gamePath: join(root, "missing-game"),
    profileRoot: join(root, "profile"),
    dataRoot: root,
    saveRoot: join(root, "saves"),
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    installationAttestationPath: link,
    startManifestPath: link,
    hostArtifactPath: join(root, "host.js"),
    signingKey: KEY,
  });
  assert.ok(result.reasons.includes("portfolio_installation_attestation_symlink_or_reparse_forbidden"));
  assert.ok(result.reasons.includes("portfolio_start_manifest_symlink_or_reparse_forbidden"));
});

test("P0b requires an existing real data root disjoint from runtime roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-p0b-data-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await inspectPortfolioP0b({
    gamePath: root,
    profileRoot: join(root, "profile"),
    dataRoot: join(root, "missing-data"),
    saveRoot: join(root, "saves"),
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    installationAttestationPath: join(root, "attestation.json"),
    startManifestPath: join(root, "start.json"),
    hostArtifactPath: join(root, "host.js"),
    signingKey: KEY,
  });
  assert.ok(result.reasons.includes("portfolio_data_root_missing"));

  const dataRoot = join(root, "data");
  await mkdir(dataRoot);
  const overlap = await inspectPortfolioP0b({
    gamePath: join(dataRoot, "game"),
    profileRoot: join(root, "profile"),
    dataRoot,
    saveRoot: join(root, "saves"),
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    installationAttestationPath: join(root, "attestation.json"),
    startManifestPath: join(root, "start.json"),
    hostArtifactPath: join(root, "host.js"),
    signingKey: KEY,
  });
  assert.ok(overlap.reasons.includes("portfolio_data_root_game_root_overlap"));

  const linkedDataRoot = join(root, "data-link");
  try {
    await symlink(dataRoot, linkedDataRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const linked = await inspectPortfolioP0b({
    gamePath: join(root, "game"),
    profileRoot: join(root, "profile"),
    dataRoot: linkedDataRoot,
    saveRoot: join(root, "saves"),
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    installationAttestationPath: join(root, "attestation.json"),
    startManifestPath: join(root, "start.json"),
    hostArtifactPath: join(root, "host.js"),
    signingKey: KEY,
  });
  assert.ok(linked.reasons.includes("portfolio_data_root_symlink_or_reparse_forbidden"));
});

test("P0b inspection rejects a start manifest path inside saveRoot before parsing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-p0b-manifest-save-overlap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "data"), { recursive: true });
  const result = await inspectPortfolioP0b({
    gamePath: join(root, "missing-game"),
    profileRoot: join(root, "profile"),
    dataRoot: join(root, "data"),
    saveRoot: join(root, "saves"),
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    installationAttestationPath: join(root, "attestation.json"),
    startManifestPath: join(root, "saves", "start-manifest.json"),
    hostArtifactPath: join(root, "host.js"),
    signingKey: KEY,
  });
  assert.ok(result.reasons.includes("portfolio_start_manifest_path_overlap"));
  assert.equal(result.startManifest.manifest, null);
});

test("P0b real inspection stays BLOCKED without attestation, native save and signed producer output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-p0b-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "profile"), { recursive: true });
  const result = await inspectPortfolioP0b({
    gamePath: join(root, "missing-game"),
    profileRoot: join(root, "profile"),
    dataRoot: join(root, "data"),
    saveRoot: join(root, "saves"),
    saveName: SAVE_NAME,
    observedSaveSlot: OBSERVED_SAVE_SLOT,
    installationAttestationPath: join(root, "attestation.json"),
    startManifestPath: join(root, "start-manifest.json"),
    hostArtifactPath: join(root, "host.js"),
    signingKey: KEY,
  });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_installation_attestation_missing_or_invalid_json"));
  assert.ok(result.reasons.includes("portfolio_save_root_missing"));
  assert.ok(result.reasons.includes("portfolio_start_manifest_missing_or_invalid_json"));
});
