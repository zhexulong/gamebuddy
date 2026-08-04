import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const PROFILE_NAMES = Object.freeze(["A-host", "A-ai-client", "A-ai-probe"]);
const ALLOWED_FIXTURE_SCENARIOS = Object.freeze([
  "native_animal_product_v2", "native_feed_animal_v1", "native_water_crop_v1",
  "native_fertilize_tile_v1", "native_plant_seed_v1", "native_till_soil_v1",
  "native_machine_inspect_v1", "native_npc_relationship_v1", "native_pickup_forage_v1",
  "native_pickup_item_v1", "native_use_item_v1", "native_harvest_crop_v1",
]);
const DEFAULT_PROCESS_NAMES = Object.freeze(["StardewModdingAPI.exe", "Stardew Valley.exe", "StardewValley.exe"]);
const CONFIG_TARGETS = Object.freeze([
  { name: "host-sidecar", profile: "A-host", relativePath: ["GameBuddy", "config.json"] },
  { name: "ai-sidecar", profile: "A-ai-client", relativePath: ["GameBuddy", "config.json"] },
  { name: "host-mod", profile: "A-host", relativePath: ["Mods", "GameBuddy", "config.json"] },
  { name: "ai-mod", profile: "A-ai-client", relativePath: ["Mods", "GameBuddy", "config.json"] },
]);
// SMAPI scans the complete custom --mods-path tree. A profile sidecar may be
// useful configuration input, but it must never retain a second manifest/DLL
// beside the deployed Mods/GameBuddy bundle during a fixture run.
const BUNDLE_FILE_NAMES = Object.freeze(["GameBuddy.Stardew.dll", "manifest.json", "GameBuddy.Stardew.deps.json"]);
const SIDECAR_BUNDLE_TARGETS = Object.freeze(
  PROFILE_NAMES.flatMap((profile) => BUNDLE_FILE_NAMES.map((fileName) => ({
    name: `${profile}-sidecar-${fileName === "GameBuddy.Stardew.dll" ? "dll" : fileName === "manifest.json" ? "manifest" : "deps"}`,
    profile,
    relativePath: ["GameBuddy", fileName],
  }))),
);
const MOD_BUNDLE_TARGETS = Object.freeze(
  PROFILE_NAMES.flatMap((profile) => BUNDLE_FILE_NAMES.map((fileName) => ({
    name: `${profile}-mod-${fileName === "GameBuddy.Stardew.dll" ? "dll" : fileName === "manifest.json" ? "manifest" : "deps"}`,
    profile,
    relativePath: ["Mods", "GameBuddy", fileName],
  }))),
);
const MANAGED_PROFILE_TARGETS = Object.freeze([...CONFIG_TARGETS, ...SIDECAR_BUNDLE_TARGETS, ...MOD_BUNDLE_TARGETS]);
const TRANSACTION_LOCK_DIRECTORY = ".stardew-fixture-profile.lock";
const TRANSACTION_LOCK_FILE = "transaction.json";
const TRANSACTION_LOCK_VERSION = 1;

export const DEFAULT_FIXTURE_SAVE = "GameBuddyFixture_AnimalProductNative_1_6_15";
export const FIXTURE_SCENARIOS = ALLOWED_FIXTURE_SCENARIOS;

/**
 * Atomically prepares only local Stardew test profiles for a formal fixture
 * run. It records every real config source SMAPI may consume, including files
 * which did not exist before the run, so restore is byte-for-byte reversible.
 */
export async function prepareFixtureProfile(options) {
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  const context = resolveContext(options);
  const backupName = assertBackupName(options.backupName);
  const targetSave = options.targetSave ?? DEFAULT_FIXTURE_SAVE;
  assertFixtureInputs(options.scenario, targetSave);
  const experimentalActions = normalizeActionIds(options.experimentalActions ?? []);
  const backupDir = join(context.root, backupName);
  let backupCreated = false;
  await beginFixtureTransaction(context, backupName);
  try {
    if (await exists(backupDir)) throw new Error(`fixture_backup_already_exists:${backupDir}`);
    const sidecar = await readProfileConfigs(context);
    assertFormalAttachmentShape(sidecar.host, sidecar.ai);
    const host = configureHost(sidecar.host, options.scenario, targetSave);
    const ai = configureAi(sidecar.ai, experimentalActions);

    await mkdir(backupDir, { recursive: true });
    backupCreated = true;
    await backupConfigs(context, backupDir);
    await writeJson(context.hostSidecar, host);
    await writeJson(context.aiSidecar, ai);
    await deployModBundle(context, host, ai);
    const preflight = await verifyFixtureProfileUnlocked({
      ...context,
      scenario: options.scenario,
      targetSave,
      experimentalActions,
      backupDir,
    });
    return Object.freeze({
      state: "prepared",
      backup: backupDir,
      backupManifest: join(backupDir, "manifest.json"),
      transactionLock: transactionLockPath(context),
      targetSave,
      fixtureScenario: options.scenario,
      aiExperimentalActions: experimentalActions,
      deployedProfiles: PROFILE_NAMES,
      ...preflight,
    });
  } catch (error) {
    if (backupCreated && await exists(join(backupDir, "manifest.json"))) {
      await restoreFixtureProfileUnlocked(context, backupDir, { removeBackup: false }).catch(() => {});
    }
    if (backupCreated) await rm(backupDir, { recursive: true, force: true });
    await endFixtureTransaction(context, backupName).catch(() => {});
    throw error;
  }
}

/** Reads real sidecar and SMAPI Mod config sources and checks their contract. */
export async function verifyFixtureProfile(options) {
  return verifyFixtureProfileUnlocked({ ...resolveContext(options), ...options });
}

async function verifyFixtureProfileUnlocked(options) {
  const context = resolveContext(options);
  const expectedScenario = options.scenario;
  const expectedSave = options.targetSave ?? DEFAULT_FIXTURE_SAVE;
  const expectedExperimentalActions = normalizeActionIds(options.experimentalActions ?? []);
  const hostSidecar = await readJson(context.hostSidecar);
  const aiSidecar = await readJson(context.aiSidecar);
  const hostMod = await readJson(context.hostMod);
  const aiMod = await readJson(context.aiMod);

  assertHostFixtureConfig(hostSidecar, expectedScenario, expectedSave);
  assertHostFixtureConfig(hostMod, expectedScenario, expectedSave);
  assertAiFixtureConfig(aiSidecar, expectedExperimentalActions);
  assertAiFixtureConfig(aiMod, expectedExperimentalActions);
  await assertSidecarBundlesAbsent(context);

  const releaseDll = join(context.releaseDir, "GameBuddy.Stardew.dll");
  const deployedDlls = [
    releaseDll,
    ...PROFILE_NAMES.map((profile) => join(context.profiles, profile, "Mods", "GameBuddy", "GameBuddy.Stardew.dll")),
  ];
  const hashes = await Promise.all(deployedDlls.map(hashFile));
  if (new Set(hashes).size !== 1) throw new Error("deployed_dll_hash_mismatch");
  return Object.freeze({
    state: "profile_preflight_passed",
    fixtureScenario: expectedScenario,
    targetSave: expectedSave,
    effectiveConfigSources: Object.freeze([context.hostMod, context.aiMod]),
    dllSha256: hashes[0],
  });
}

/**
 * Reads the local fixture transaction state without changing profiles, backups,
 * locks, saves, processes, or session files. Its output is recovery advice,
 * never an authorization to delete a lock or restore a profile automatically.
 */
export async function inspectFixtureTransaction(options = {}) {
  const context = resolveContext(options);
  const requestedBackupName = options.backupName === undefined ? null : assertBackupName(options.backupName);
  const lock = await inspectTransactionLock(context);
  const discoveredBackups = await findFixtureBackups(context);
  const backupName = requestedBackupName ?? lock.owner?.backupName ?? (discoveredBackups.length === 1 ? discoveredBackups[0] : null);
  const backup = await inspectFixtureBackup(context, backupName);
  const configs = await Promise.all(CONFIG_TARGETS.map((target) => inspectConfigTarget(context, target)));
  const profileState = summarizeProfileState(configs);
  const processes = await inspectStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  const hasSelectedBackup = backup.state !== "absent" && backup.state !== "not_selected";
  const transactionState = lock.state === "valid"
    ? "locked"
    : lock.state === "invalid"
      ? "lock_invalid"
      : hasSelectedBackup
        ? "orphaned_backup"
        : discoveredBackups.length > 1
          ? "ambiguous_backups"
          : "idle";
  const recommendation = transactionState === "idle"
    ? "A new fixture prepare may proceed only after its normal process/profile preflight."
    : transactionState === "orphaned_backup"
      ? `Inspect the orphaned backup '${backupName}' and explicitly restore it only when it is known to own the modified profiles.`
      : transactionState === "ambiguous_backups"
        ? "Multiple fixture backups exist without a transaction lock. Do not prepare or delete files; inspect each named backup and explicitly restore only the confirmed owner."
        : `Do not start another fixture prepare or delete the lock. Stop only known fixture processes, inspect backup '${backupName ?? "unknown"}', then use the matching restore command if its ownership is confirmed.`;
  return Object.freeze({
    state: "inspection",
    mutationPerformed: false,
    root: context.root,
    transactionState,
    transactionLock: lock,
    backup,
    discoveredBackups: Object.freeze(discoveredBackups),
    effectiveConfigSources: configs,
    profileState,
    observedProcesses: processes,
    recommendation,
  });
}

/** Restores every config exactly as it existed before prepare. */
export async function restoreFixtureProfile(options) {
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  const context = resolveContext(options);
  const backupName = assertBackupName(options.backupName);
  await assertFixtureTransaction(context, backupName);
  const backupDir = join(context.root, backupName);
  try {
    const restored = await restoreFixtureProfileUnlocked(context, backupDir, { removeBackup: options.removeBackup });
    if (options.removeBackup !== false) await endFixtureTransaction(context, backupName);
    return restored;
  } catch (error) {
    // Preserve the transaction lock after a failed restore: another prepare
    // must not overwrite the still-recoverable backup/profile state.
    throw error;
  }
}

async function restoreFixtureProfileUnlocked(context, backupDir, { removeBackup = true } = {}) {
  const manifestPath = join(backupDir, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("invalid_fixture_backup_manifest");

  for (const entry of manifest.entries) {
    if (!isBackupEntry(entry)) throw new Error("invalid_fixture_backup_entry");
    const target = configPath(context, entry.profile, entry.relativePath);
    if (entry.existed) {
      const source = join(backupDir, entry.backupFile);
      const bytes = await readFile(source);
      if (sha256(bytes) !== entry.sha256) throw new Error(`fixture_backup_hash_mismatch:${entry.name}`);
      await mkdir(join(context.profiles, entry.profile, ...entry.relativePath.slice(0, -1)), { recursive: true });
      await writeFile(target, bytes);
    } else {
      await rm(target, { force: true });
    }
  }

  for (const entry of manifest.entries) {
    const target = configPath(context, entry.profile, entry.relativePath);
    if (entry.existed) {
      const bytes = await readFile(target);
      if (sha256(bytes) !== entry.sha256) throw new Error(`fixture_restore_hash_mismatch:${entry.name}`);
    } else if (await exists(target)) {
      throw new Error(`fixture_restore_absence_mismatch:${entry.name}`);
    }
  }
  if (removeBackup) await rm(backupDir, { recursive: true, force: true });
  return Object.freeze({ state: "restored", backup: backupDir, backupRemoved: removeBackup });
}

function resolveContext(options = {}) {
  const local = options.root ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "GameBuddy") : null);
  if (!local) throw new Error("LOCALAPPDATA_missing");
  const profiles = options.profiles ?? join(local, "stardew-profiles");
  const releaseDir = options.releaseDir ?? "E:/projects/ai-game-companion/integrations/stardew/bin/Release/net6.0";
  return Object.freeze({
    root: local,
    profiles,
    releaseDir,
    hostSidecar: configPath({ profiles }, "A-host", ["GameBuddy", "config.json"]),
    aiSidecar: configPath({ profiles }, "A-ai-client", ["GameBuddy", "config.json"]),
    hostMod: configPath({ profiles }, "A-host", ["Mods", "GameBuddy", "config.json"]),
    aiMod: configPath({ profiles }, "A-ai-client", ["Mods", "GameBuddy", "config.json"]),
  });
}

function transactionLockPath(context) {
  return join(context.root, TRANSACTION_LOCK_DIRECTORY);
}

/**
 * Atomically claims exclusive ownership of the shared fixture profiles. There
 * is intentionally no automatic stale-lock deletion: an interrupted run may
 * still have a recoverable backup whose config must not be overwritten. An
 * operator must inspect/restore that backup before manually resolving it.
 */
async function beginFixtureTransaction(context, backupName) {
  await mkdir(context.root, { recursive: true });
  const lockDir = transactionLockPath(context);
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = await readFixtureTransaction(lockDir);
    const suffix = owner?.backupName ? `:${owner.backupName}` : "";
    throw new Error(`fixture_transaction_locked${suffix}`);
  }
  const owner = Object.freeze({
    version: TRANSACTION_LOCK_VERSION,
    backupName,
    ownerId: randomUUID(),
    startedAtUnixMs: Date.now(),
  });
  try {
    await writeJson(join(lockDir, TRANSACTION_LOCK_FILE), owner);
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true });
    throw error;
  }
  return owner;
}

async function assertFixtureTransaction(context, backupName) {
  const lockDir = transactionLockPath(context);
  const owner = await readFixtureTransaction(lockDir);
  if (owner === null) throw new Error("fixture_transaction_lock_missing");
  if (owner.version !== TRANSACTION_LOCK_VERSION || typeof owner.ownerId !== "string" || !Number.isSafeInteger(owner.startedAtUnixMs)) {
    throw new Error("fixture_transaction_lock_invalid");
  }
  if (owner.backupName !== backupName) throw new Error(`fixture_transaction_lock_owner_mismatch:${owner.backupName}`);
  return owner;
}

async function endFixtureTransaction(context, backupName) {
  await assertFixtureTransaction(context, backupName);
  await rm(transactionLockPath(context), { recursive: true, force: false });
}

async function readFixtureTransaction(lockDir) {
  try {
    return await readJson(join(lockDir, TRANSACTION_LOCK_FILE));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectTransactionLock(context) {
  const lockDir = transactionLockPath(context);
  if (!await exists(lockDir)) return Object.freeze({ state: "absent", path: lockDir });
  try {
    const owner = await readFixtureTransaction(lockDir);
    if (owner === null || owner.version !== TRANSACTION_LOCK_VERSION || typeof owner.backupName !== "string" || typeof owner.ownerId !== "string" || !Number.isSafeInteger(owner.startedAtUnixMs)) {
      return Object.freeze({ state: "invalid", path: lockDir });
    }
    return Object.freeze({
      state: "valid",
      path: lockDir,
      owner: Object.freeze({ backupName: owner.backupName, startedAtUnixMs: owner.startedAtUnixMs }),
    });
  } catch {
    return Object.freeze({ state: "invalid", path: lockDir });
  }
}

async function findFixtureBackups(context) {
  try {
    const entries = await readdir(context.root, { withFileTypes: true });
    return Object.freeze(entries
      .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9-]{0,95}-fixture-backup$/.test(entry.name))
      .map((entry) => entry.name)
      .sort());
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
}

async function inspectFixtureBackup(context, backupName) {
  if (backupName === null) return Object.freeze({ state: "not_selected", backupName: null, entries: [] });
  const backupDir = join(context.root, backupName);
  if (!await exists(backupDir)) return Object.freeze({ state: "absent", backupName, path: backupDir, entries: [] });
  const manifestPath = join(backupDir, "manifest.json");
  let manifest;
  try {
    manifest = await readJson(manifestPath);
  } catch {
    return Object.freeze({ state: "invalid", backupName, path: backupDir, reasonCode: "fixture_backup_manifest_unreadable", entries: [] });
  }
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || !manifest.entries.every(isBackupEntry)) {
    return Object.freeze({ state: "invalid", backupName, path: backupDir, reasonCode: "fixture_backup_manifest_invalid", entries: [] });
  }
  const entries = [];
  for (const entry of manifest.entries) {
    let integrity = entry.existed ? "valid" : "not_applicable";
    if (entry.existed) {
      try {
        integrity = sha256(await readFile(join(backupDir, entry.backupFile))) === entry.sha256 ? "valid" : "hash_mismatch";
      } catch {
        integrity = "missing";
      }
    }
    entries.push(Object.freeze({ name: entry.name, profile: entry.profile, existed: entry.existed, integrity }));
  }
  const invalid = entries.some((entry) => entry.integrity === "hash_mismatch" || entry.integrity === "missing");
  return Object.freeze({
    state: invalid ? "invalid" : "valid",
    backupName,
    path: backupDir,
    reasonCode: invalid ? "fixture_backup_file_invalid" : null,
    entries: Object.freeze(entries),
  });
}

function summarizeProfileState(configs) {
  const byName = new Map(configs.map((entry) => [entry.name, entry]));
  const pairs = [
    ["host", byName.get("host-sidecar"), byName.get("host-mod")],
    ["ai", byName.get("ai-sidecar"), byName.get("ai-mod")],
  ];
  return Object.freeze(pairs.map(([profile, sidecar, mod]) => Object.freeze({
    profile,
    state: sidecar?.exists === null || mod?.exists === null
      ? "unreadable"
      : sidecar?.exists !== mod?.exists
        ? "diverged"
        : sidecar.exists && sidecar.sha256 !== mod.sha256
          ? "diverged"
          : "consistent",
  })));
}

async function inspectConfigTarget(context, target) {
  const path = configPath(context, target.profile, target.relativePath);
  try {
    return Object.freeze({ name: target.name, profile: target.profile, exists: true, sha256: sha256(await readFile(path)) });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ name: target.name, profile: target.profile, exists: false, sha256: null });
    return Object.freeze({ name: target.name, profile: target.profile, exists: null, sha256: null, reasonCode: "fixture_config_unreadable" });
  }
}

async function readProfileConfigs(context) {
  return Object.freeze({ host: await readJson(context.hostSidecar), ai: await readJson(context.aiSidecar) });
}

function assertFormalAttachmentShape(host, ai) {
  if (host?.HostAutomation?.Enable !== true || host?.HostFarmhandProvisioning?.Enable !== true || ai?.FarmhandProvisioner?.Enable !== true) {
    throw new Error("profiles_not_in_expected_formal_attachment_shape");
  }
  // The sidecar is only the transaction input. SMAPI loads the Mod-local copy,
  // which may be absent or stale before preparation; do not silently regard it
  // as a valid live attachment profile. `deployModBundle` writes the controlled
  // effective copy and `verifyFixtureProfile` proves equality before launch.
  if (!host.HostFarmhandProvisioning.SessionDirectory || !host.HostFarmhandProvisioning.SessionToken || !ai.FarmhandProvisioner.ManifestPath || !ai.FarmhandProvisioner.SessionToken) {
    throw new Error("profiles_missing_formal_attachment_binding");
  }
}

function assertFixtureInputs(scenario, targetSave) {
  if (!ALLOWED_FIXTURE_SCENARIOS.includes(scenario)) throw new Error("fixture_scenario_not_allowlisted");
  if (typeof targetSave !== "string" || !/^GameBuddyFixture_[A-Za-z0-9_-]{1,96}$/.test(targetSave)) throw new Error("invalid_fixture_save");
}

function configureHost(value, scenario, targetSave) {
  assertFixtureInputs(scenario, targetSave);
  const host = structuredClone(value);
  host.HostAutomation.SaveName = targetSave;
  host.HostAutomation.FixtureScenario = scenario;
  host.HostAutomation.TimeoutSeconds = 300;
  host.ActionPolicyVersion = 0;
  host.ExperimentalActions = [];
  host.EnabledActions = null;
  return host;
}

function configureAi(value, experimentalActions) {
  const ai = structuredClone(value);
  ai.ActionPolicyVersion = 1;
  ai.DeniedActions = [];
  ai.DeniedActionFamilies = [];
  ai.ExperimentalActions = experimentalActions;
  delete ai.EnabledActions;
  return ai;
}

async function backupConfigs(context, backupDir) {
  const entries = [];
  for (const target of MANAGED_PROFILE_TARGETS) {
    const source = configPath(context, target.profile, target.relativePath);
    const backupFile = `${target.name}.json`;
    const existed = await exists(source);
    let digest = null;
    if (existed) {
      const bytes = await readFile(source);
      digest = sha256(bytes);
      await writeFile(join(backupDir, backupFile), bytes);
    }
    entries.push({ name: target.name, profile: target.profile, relativePath: target.relativePath, backupFile, existed, sha256: digest });
  }
  const manifest = Object.freeze({ version: 1, entries });
  await writeJson(join(backupDir, "manifest.json"), manifest);
  return manifest;
}

async function assertSidecarBundlesAbsent(context) {
  for (const target of SIDECAR_BUNDLE_TARGETS) {
    if (await exists(configPath(context, target.profile, target.relativePath))) {
      throw new Error(`fixture_duplicate_mod_bundle:${target.profile}`);
    }
  }
}

async function deployModBundle(context, host, ai) {
  const releaseDll = join(context.releaseDir, "GameBuddy.Stardew.dll");
  const releaseManifest = join(context.releaseDir, "manifest.json");
  const releaseDeps = join(context.releaseDir, "GameBuddy.Stardew.deps.json");
  for (const file of [releaseDll, releaseManifest, releaseDeps]) if (!await exists(file)) throw new Error(`release_bundle_missing:${file}`);
  for (const profile of PROFILE_NAMES) {
    const sidecarRoot = join(context.profiles, profile, "GameBuddy");
    const modRoot = join(context.profiles, profile, "Mods", "GameBuddy");
    await mkdir(sidecarRoot, { recursive: true });
    await mkdir(modRoot, { recursive: true });
    // The custom SMAPI mods root contains both paths. Remove only the three
    // managed bundle files from the sidecar for this transaction; config.json
    // remains available as the transaction input and is restored separately.
    await Promise.all(BUNDLE_FILE_NAMES.map((fileName) => rm(join(sidecarRoot, fileName), { force: true })));
    await cp(releaseDll, join(modRoot, "GameBuddy.Stardew.dll"));
    await cp(releaseManifest, join(modRoot, "manifest.json"));
    await cp(releaseDeps, join(modRoot, "GameBuddy.Stardew.deps.json"));
  }
  await writeJson(context.hostMod, host);
  await writeJson(context.aiMod, ai);
}

function assertHostFixtureConfig(value, scenario, targetSave) {
  if (value?.HostAutomation?.Enable !== true || value.HostAutomation.SaveName !== targetSave || value.HostAutomation.FixtureScenario !== scenario || value.HostAutomation.TimeoutSeconds !== 300 || value.ActionPolicyVersion !== 0 || !Array.isArray(value.ExperimentalActions) || value.ExperimentalActions.length !== 0 || value.EnabledActions !== null) {
    throw new Error("host_fixture_config_mismatch");
  }
}

function assertAiFixtureConfig(value, experimentalActions) {
  if (value?.FarmhandProvisioner?.Enable !== true || value.ActionPolicyVersion !== 1 || !sameStrings(value.DeniedActions, []) || !sameStrings(value.DeniedActionFamilies, []) || !sameStrings(value.ExperimentalActions, experimentalActions) || Object.hasOwn(value, "EnabledActions")) {
    throw new Error("ai_fixture_config_mismatch");
  }
}

async function assertNoStardewProcesses(processNames) {
  const matches = await inspectStardewProcesses(processNames);
  if (matches.length > 0) throw new Error(`fixture_game_processes_running:${matches.join(",")}`);
}

async function inspectStardewProcesses(processNames) {
  if (!Array.isArray(processNames) || processNames.some((name) => typeof name !== "string" || name.length === 0)) throw new Error("invalid_fixture_process_names");
  if (process.platform !== "win32") return Object.freeze([]);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const tasklist = promisify(execFile);
  const matches = [];
  for (const imageName of processNames) {
    try {
      const { stdout } = await tasklist("tasklist.exe", ["/FI", `IMAGENAME eq ${imageName}`, "/NH", "/FO", "CSV"], { windowsHide: true });
      if (stdout.split(/\r?\n/).some((line) => line.includes(`\"${imageName}\"`))) matches.push(imageName);
    } catch (error) {
      // tasklist uses exit code 1 when a filter has no matching process.
      if (error?.code !== 1) throw new Error(`fixture_process_guard_failed:${imageName}:${error?.code ?? "unknown"}`);
    }
  }
  return Object.freeze(matches);
}

function assertBackupName(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(value) || !value.endsWith("-fixture-backup")) throw new Error("invalid_fixture_backup_name");
  return value;
}

function normalizeActionIds(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^[a-z0-9_]{1,128}$/.test(item))) throw new Error("invalid_experimental_actions");
  return [...new Set(value)].sort();
}

function sameStrings(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function configPath(context, profile, relativePath) {
  return join(context.profiles, profile, ...relativePath);
}

function isBackupEntry(entry) {
  if (!entry || typeof entry.name !== "string" || typeof entry.profile !== "string" || !Array.isArray(entry.relativePath) || !entry.relativePath.every((part) => typeof part === "string" && /^[A-Za-z0-9_.-]+$/.test(part)) || typeof entry.backupFile !== "string" || !/^[A-Za-z0-9_.-]+\.json$/.test(entry.backupFile) || typeof entry.existed !== "boolean" || !(entry.sha256 === null || /^[a-f0-9]{64}$/.test(entry.sha256))) return false;
  return MANAGED_PROFILE_TARGETS.some((target) => target.name === entry.name && target.profile === entry.profile && target.relativePath.length === entry.relativePath.length && target.relativePath.every((part, index) => part === entry.relativePath[index]));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function hashFile(path) { return sha256(await readFile(path)); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
