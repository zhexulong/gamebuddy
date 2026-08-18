import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  applyFixtureBridgeOverride,
  inspectFixtureTransaction,
  prepareFixtureProfile,
  restoreFixtureProfile,
  verifyFixtureProfile,
} from "./lib/stardew-fixture-profile.mjs";

const hostBase = Object.freeze({
  HostAutomation: { Enable: true, SaveName: "ordinary-save", FixtureScenario: "", TimeoutSeconds: 120 },
  HostFarmhandProvisioning: { Enable: true },
  ActionPolicyVersion: 1,
  DeniedActions: [],
  DeniedActionFamilies: [],
});
const FIXTURE_TEST_SESSION_TOKEN = ["fixture", "profile", "token", "123456"].join("-");

const aiBase = Object.freeze({
  FarmhandProvisioner: { Enable: true },
  ActionPolicyVersion: 1,
  DeniedActions: ["use_item"],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
});

test("fixture profile transaction patches every effective config and restores byte-for-byte", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = join(root, "stardew-profiles");
  const releaseDir = join(root, "release");
  await makeRelease(releaseDir);
  const hostSidecar = join(profiles, "A-host", "GameBuddy", "config.json");
  const aiSidecar = join(profiles, "A-ai-client", "GameBuddy", "config.json");
  const hostMod = join(profiles, "A-host", "Mods", "GameBuddy", "config.json");
  const aiMod = join(profiles, "A-ai-client", "Mods", "GameBuddy", "config.json");
  const hostFormal = {
    Enable: true,
    SessionDirectory: "C:/fixture/session",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
    Endpoint: "127.0.0.1:24642",
  };
  const aiFormal = {
    Enable: true,
    ManifestPath: "C:/fixture/session/stardew-farmhand-manifest.json",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
  };
  await writeJson(hostSidecar, { ...hostBase, HostFarmhandProvisioning: hostFormal });
  await writeJson(aiSidecar, { ...aiBase, FarmhandProvisioner: aiFormal });
  await mkdir(dirname(hostMod), { recursive: true });
  await writeFile(hostMod, '{"legacy":"host-mod-bytes"}\r\n');
  // A custom SMAPI --mods-path scans both sidecar and Mods/GameBuddy paths.
  // Fixture preparation must remove the duplicate bundle only transactionally.
  const hostSidecarDll = join(profiles, "A-host", "GameBuddy", "GameBuddy.Stardew.dll");
  const hostSidecarManifest = join(profiles, "A-host", "GameBuddy", "manifest.json");
  const hostSidecarDeps = join(profiles, "A-host", "GameBuddy", "GameBuddy.Stardew.deps.json");
  await writeFile(hostSidecarDll, "host-sidecar-original-dll");
  await writeFile(hostSidecarManifest, '{"host":"sidecar-manifest"}\n');
  await writeFile(hostSidecarDeps, '{"host":"sidecar-deps"}\n');
  const before = new Map(
    await Promise.all(
      [hostSidecar, aiSidecar, hostMod, hostSidecarDll, hostSidecarManifest, hostSidecarDeps].map(async (file) => [
        file,
        await readFile(file),
      ]),
    ),
  );

  const prepared = await prepareFixtureProfile({
    root,
    profiles,
    releaseDir,
    processNames: [],
    scenario: "native_pickup_item_v1",
    backupName: "example-fixture-backup",
    experimentalActions: ["npc_relationship"],
    requireFixtureLiveLocale: "zh-CN",
  });
  assert.equal(prepared.state, "profile_preflight_passed");
  assert.deepEqual(prepared.aiExperimentalActions, ["npc_relationship"]);
  const host = JSON.parse(await readFile(hostSidecar, "utf8"));
  const hostEffective = JSON.parse(await readFile(hostMod, "utf8"));
  const ai = JSON.parse(await readFile(aiSidecar, "utf8"));
  const aiEffective = JSON.parse(await readFile(aiMod, "utf8"));
  assert.equal(host.HostAutomation.FixtureScenario, "native_pickup_item_v1");
  assert.equal(host.HostAutomation.RequireFixtureLiveLocale, "zh-CN");
  assert.deepEqual(hostEffective, host);
  assert.deepEqual(aiEffective, ai);
  assert.deepEqual(ai.ExperimentalActions, ["npc_relationship"]);
  await assert.rejects(() => readFile(hostSidecarDll), { code: "ENOENT" });
  await assert.rejects(() => readFile(hostSidecarManifest), { code: "ENOENT" });
  await assert.rejects(() => readFile(hostSidecarDeps), { code: "ENOENT" });
  const inspection = await inspectFixtureTransaction({ root, profiles, processNames: [] });
  assert.equal(inspection.state, "inspection");
  assert.equal(inspection.mutationPerformed, false);
  assert.equal(inspection.transactionState, "locked");
  assert.equal(inspection.transactionLock.owner.backupName, "example-fixture-backup");
  assert.equal(inspection.backup.state, "valid");
  assert.deepEqual(inspection.observedProcesses, []);
  await assert.rejects(
    () =>
      prepareFixtureProfile({
        root,
        profiles,
        releaseDir,
        processNames: [],
        scenario: "native_use_item_v1",
        backupName: "example-fixture-backup",
      }),
    /fixture_transaction_locked:example-fixture-backup/,
  );
  await assert.rejects(
    () =>
      prepareFixtureProfile({
        root,
        profiles,
        releaseDir,
        processNames: [],
        scenario: "native_other_v1",
        backupName: "../escape",
      }),
    /invalid_fixture_backup_name/,
  );
  await assert.rejects(
    () =>
      prepareFixtureProfile({
        root,
        profiles,
        releaseDir,
        processNames: [],
        scenario: "native_other_v1",
        backupName: "other-fixture-backup",
      }),
    /fixture_scenario_not_allowlisted/,
  );
  const verified = await verifyFixtureProfile({
    root,
    profiles,
    releaseDir,
    scenario: "native_pickup_item_v1",
    experimentalActions: ["npc_relationship"],
    requireFixtureLiveLocale: "zh-CN",
  });
  assert.equal(verified.state, "profile_preflight_passed");

  const restored = await restoreFixtureProfile({
    root,
    profiles,
    releaseDir,
    processNames: [],
    backupName: "example-fixture-backup",
  });
  assert.equal(restored.state, "restored");
  for (const [file, bytes] of before) assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(() => readFile(aiMod), { code: "ENOENT" });
  await assert.rejects(() => readFile(join(root, ".stardew-fixture-profile.lock", "transaction.json")), {
    code: "ENOENT",
  });
  const idleInspection = await inspectFixtureTransaction({ root, profiles, processNames: [] });
  assert.equal(idleInspection.transactionState, "idle");
  assert.equal(idleInspection.mutationPerformed, false);
});

test("fixture bridge override accepts only lease-free minted-shaped scope and remains reversible", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-bridge-override-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = join(root, "stardew-profiles");
  const releaseDir = join(root, "release");
  await makeRelease(releaseDir);
  const hostSidecar = join(profiles, "A-host", "GameBuddy", "config.json");
  const aiSidecar = join(profiles, "A-ai-client", "GameBuddy", "config.json");
  const hostFormal = {
    Enable: true,
    SessionDirectory: "C:/fixture/session",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
    Endpoint: "127.0.0.1:24642",
  };
  const aiFormal = {
    Enable: true,
    ManifestPath: "C:/fixture/session/stardew-farmhand-manifest.json",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
  };
  await writeJson(hostSidecar, { ...hostBase, HostFarmhandProvisioning: hostFormal });
  await writeJson(aiSidecar, { ...aiBase, FarmhandProvisioner: aiFormal });
  const original = await readFile(aiSidecar);
  await prepareFixtureProfile({
    root,
    profiles,
    releaseDir,
    processNames: [],
    scenario: "native_pickup_item_v1",
    backupName: "bridge-override-fixture-backup",
  });
  const bridgeOverride = {
    pipeName: "gamebuddy_preview_01",
    bridgeToken: "a".repeat(32),
    saveId: "save_01",
    worldId: "world_01",
    playerId: "123456",
    companionId: "companion_01",
  };
  await applyFixtureBridgeOverride({ root, profiles, backupName: "bridge-override-fixture-backup", bridgeOverride });
  const applied = JSON.parse(await readFile(aiSidecar, "utf8"));
  assert.equal(applied.BridgeToken, bridgeOverride.bridgeToken);
  assert.equal("BridgeLeaseExpiresAtUnixMs" in applied, false);
  assert.equal(applied.PlayerId, bridgeOverride.playerId);
  await assert.rejects(
    () =>
      applyFixtureBridgeOverride({
        root,
        profiles,
        backupName: "bridge-override-fixture-backup",
        bridgeOverride: { ...bridgeOverride, BridgeLeaseExpiresAtUnixMs: Date.now() + 60_000 },
      }),
    /invalid_fixture_bridge_override/,
  );
  await restoreFixtureProfile({
    root,
    profiles,
    releaseDir,
    processNames: [],
    backupName: "bridge-override-fixture-backup",
  });
  assert.deepEqual(await readFile(aiSidecar), original);
});

test("orphaned backup is never overwritten or restored by a failed new prepare", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-orphan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = join(root, "stardew-profiles");
  const releaseDir = join(root, "release");
  await makeRelease(releaseDir);
  const hostFormal = {
    Enable: true,
    SessionDirectory: "C:/fixture/session",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
    Endpoint: "127.0.0.1:24642",
  };
  const aiFormal = {
    Enable: true,
    ManifestPath: "C:/fixture/session/stardew-farmhand-manifest.json",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
  };
  const hostSidecar = join(profiles, "A-host", "GameBuddy", "config.json");
  const aiSidecar = join(profiles, "A-ai-client", "GameBuddy", "config.json");
  await writeJson(hostSidecar, { ...hostBase, HostFarmhandProvisioning: hostFormal });
  await writeJson(aiSidecar, { ...aiBase, FarmhandProvisioner: aiFormal });
  const backup = join(root, "orphan-fixture-backup");
  await mkdir(backup, { recursive: true });
  const sentinel = join(backup, "sentinel.json");
  await writeFile(sentinel, "preserve-me");
  const originalHost = await readFile(hostSidecar);

  await assert.rejects(
    () =>
      prepareFixtureProfile({
        root,
        profiles,
        releaseDir,
        processNames: [],
        scenario: "native_use_item_v1",
        backupName: "orphan-fixture-backup",
      }),
    /fixture_backup_already_exists/,
  );
  assert.deepEqual(await readFile(sentinel), Buffer.from("preserve-me"));
  assert.deepEqual(await readFile(hostSidecar), originalHost);
  const inspection = await inspectFixtureTransaction({
    root,
    profiles,
    processNames: [],
    backupName: "orphan-fixture-backup",
  });
  assert.equal(inspection.transactionState, "orphaned_backup");
  assert.equal(inspection.backup.state, "invalid");
  assert.equal(inspection.mutationPerformed, false);
  await assert.rejects(() => readFile(join(root, ".stardew-fixture-profile.lock", "transaction.json")), {
    code: "ENOENT",
  });
});

test("interrupted transaction lock is never stolen automatically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-stale-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = join(root, "stardew-profiles");
  const releaseDir = join(root, "release");
  await makeRelease(releaseDir);
  const hostFormal = {
    Enable: true,
    SessionDirectory: "C:/fixture/session",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
    Endpoint: "127.0.0.1:24642",
  };
  const aiFormal = {
    Enable: true,
    ManifestPath: "C:/fixture/session/stardew-farmhand-manifest.json",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
  };
  const hostSidecar = join(profiles, "A-host", "GameBuddy", "config.json");
  const aiSidecar = join(profiles, "A-ai-client", "GameBuddy", "config.json");
  await writeJson(hostSidecar, { ...hostBase, HostFarmhandProvisioning: hostFormal });
  await writeJson(aiSidecar, { ...aiBase, FarmhandProvisioner: aiFormal });
  const lockDir = join(root, ".stardew-fixture-profile.lock");
  await mkdir(lockDir, { recursive: true });
  await writeJson(join(lockDir, "transaction.json"), {
    version: 1,
    backupName: "interrupted-fixture-backup",
    ownerId: "interrupted-owner",
    startedAtUnixMs: 1,
  });
  const originalHost = await readFile(hostSidecar);

  await assert.rejects(
    () =>
      prepareFixtureProfile({
        root,
        profiles,
        releaseDir,
        processNames: [],
        scenario: "native_use_item_v1",
        backupName: "new-fixture-backup",
      }),
    /fixture_transaction_locked:interrupted-fixture-backup/,
  );
  assert.deepEqual(await readFile(hostSidecar), originalHost);
  assert.deepEqual(
    JSON.parse(await readFile(join(lockDir, "transaction.json"), "utf8")).backupName,
    "interrupted-fixture-backup",
  );
});

test("fixture transaction serializes concurrent prepare and requires its matching restore", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-fixture-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = join(root, "stardew-profiles");
  const releaseDir = join(root, "release");
  await makeRelease(releaseDir);
  const hostFormal = {
    Enable: true,
    SessionDirectory: "C:/fixture/session",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
    Endpoint: "127.0.0.1:24642",
  };
  const aiFormal = {
    Enable: true,
    ManifestPath: "C:/fixture/session/stardew-farmhand-manifest.json",
    SessionToken: FIXTURE_TEST_SESSION_TOKEN,
  };
  await writeJson(join(profiles, "A-host", "GameBuddy", "config.json"), {
    ...hostBase,
    HostFarmhandProvisioning: hostFormal,
  });
  await writeJson(join(profiles, "A-ai-client", "GameBuddy", "config.json"), {
    ...aiBase,
    FarmhandProvisioner: aiFormal,
  });

  await prepareFixtureProfile({
    root,
    profiles,
    releaseDir,
    processNames: [],
    scenario: "native_use_item_v1",
    backupName: "first-fixture-backup",
  });
  await assert.rejects(
    () =>
      prepareFixtureProfile({
        root,
        profiles,
        releaseDir,
        processNames: [],
        scenario: "native_pickup_item_v1",
        backupName: "second-fixture-backup",
      }),
    /fixture_transaction_locked:first-fixture-backup/,
  );
  await assert.rejects(
    () => restoreFixtureProfile({ root, profiles, releaseDir, processNames: [], backupName: "second-fixture-backup" }),
    /fixture_transaction_lock_owner_mismatch:first-fixture-backup/,
  );
  await restoreFixtureProfile({ root, profiles, releaseDir, processNames: [], backupName: "first-fixture-backup" });
  const preparedSecond = await prepareFixtureProfile({
    root,
    profiles,
    releaseDir,
    processNames: [],
    scenario: "native_pickup_item_v1",
    backupName: "second-fixture-backup",
  });
  assert.equal(preparedSecond.fixtureScenario, "native_pickup_item_v1");
  await restoreFixtureProfile({ root, profiles, releaseDir, processNames: [], backupName: "second-fixture-backup" });
});

async function makeRelease(releaseDir) {
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, "GameBuddy.Stardew.dll"), "fixture-dll");
  await writeFile(join(releaseDir, "manifest.json"), "{}");
  await writeFile(join(releaseDir, "GameBuddy.Stardew.deps.json"), "{}");
}
async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
