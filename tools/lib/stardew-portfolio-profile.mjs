import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const PORTFOLIO_TOPOLOGY = "single_player_native_companion";
const PORTFOLIO_SAVE_PREFIX = "GameBuddyPortfolio";
const PORTFOLIO_LOCK_DIRECTORY = ".stardew-portfolio-profile.lock";

const PORTFOLIO_BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);
const BUNDLE_FILES = PORTFOLIO_BUNDLE_FILES;
const CONTAMINATION_FILE_NAMES = new Map([
  ["stardew-farmhand-manifest.json", "portfolio_contaminated_farmhand_manifest"],
  ["stardew-session.json", "portfolio_contaminated_farmhand_session"],
  ["stardew-fixture-readiness.json", "portfolio_contaminated_fixture_readiness"],
]);
const DEFAULT_PROCESS_NAMES = Object.freeze(["StardewModdingAPI.exe", "Stardew Valley.exe", "StardewValley.exe"]);
// Default-deny existing-save action universe. Each prepared M8 transaction
// selects one member exactly; enter_mine never implicitly arms ladder.
const PORTFOLIO_EXISTING_SAVE_ACTIONS = Object.freeze([
  "use_mine_ladder",
  "select_mine_elevator_floor",
  "skip_event",
  "enter_mine",
]);
const PORTFOLIO_INNER_CONFIG_KEYS = Object.freeze([
  "Enable",
  "Topology",
  "EnableObserveBridge",
  "PipeName",
  "BridgeToken",
  "SaveId",
  "WorldId",
  "LocalPlayerId",
  "CompanionId",
  "DataRoot",
  "ExpectedGameVersion",
  "ExpectedGameBuildNumber",
  "EnabledActions",
  "Bootstrap",
  "InitialNativeLoad",
  "P0bLifecycleProducer",
  "MineEntryGivenFixture",
  "MineLadderGivenFixture",
  "MineElevatorGivenFixture",
]);
const PORTFOLIO_P0B_PRODUCER_KEYS = Object.freeze([
  "Enable",
  "LogicalSaveName",
  "ObservedSaveSlot",
  "TimeoutSeconds",
  "StartManifestPath",
  "SigningKeyEnvironmentVariableName",
]);

export async function inspectPortfolioProfile(options = {}) {
  const context = resolveContext(options);
  const lock = await inspectLock(context);
  const profile = await inspectProfile(context);
  const dataRoot = await inspectDataRoot(context);
  const processes = await inspectStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  return Object.freeze({
    state: "inspection",
    mutationPerformed: false,
    topology: PORTFOLIO_TOPOLOGY,
    profileRoot: context.profileRoot,
    dataRoot: context.dataRoot,
    transactionLock: lock,
    profile,
    dataRootInspection: dataRoot,
    observedProcesses: processes,
  });
}

/**
 * Checks an isolated Portfolio profile without changing any file. A missing
 * local installation/profile is BLOCKED rather than a false positive PASS.
 */
export async function checkPortfolioPrerequisites(options = {}) {
  const context = resolveContext(options);
  const inspection = await inspectPortfolioProfile({ ...options, ...context });
  const blockers = [];
  if (inspection.observedProcesses.length > 0) blockers.push("portfolio_stardew_process_running");
  if (inspection.transactionLock.state !== "absent" && options.allowTransactionLock !== true)
    blockers.push(
      inspection.transactionLock.state === "valid"
        ? "portfolio_transaction_locked"
        : `portfolio_transaction_${inspection.transactionLock.state}`,
    );
  if (inspection.profile.state !== "ready") blockers.push(...inspection.profile.reasons);
  if (inspection.dataRootInspection.state !== "clean") blockers.push(...inspection.dataRootInspection.reasons);
  const game = await inspectTargetGame(options.gamePath);
  if (game.state !== "ready") blockers.push(...game.reasons);
  // P0b remains an independent diagnostic pipeline. It is not an
  // action-first M8 admission gate.
  if (options.requireP0bAttestation === true) blockers.push("portfolio_p0b_attestation_gate_retired");
  if (blockers.length === 0)
    return Object.freeze({
      state: "PASS",
      topology: PORTFOLIO_TOPOLOGY,
      profileRoot: context.profileRoot,
      dataRoot: context.dataRoot,
      game,
    });
  return Object.freeze({
    state: "BLOCKED",
    topology: PORTFOLIO_TOPOLOGY,
    reasons: Object.freeze([...new Set(blockers)].sort()),
    game,
  });
}

/**
 * Transactionally deploys exactly one Mod bundle into an empty or already
 * clean Portfolio profile. It never configures Farmhand/HostAutomation,
 * mutates a save, writes a receipt, or creates a Portfolio action
 * precondition. Restore replays a manifest with SHA-256 verification, so
 * pre-transaction files are restored byte-for-byte.
 */
export async function preparePortfolioProfile(options) {
  const context = resolveContext(options);
  validatePrepareOptions(options, context);
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  const before = await inspectPortfolioProfile({ ...options, ...context });
  if (before.observedProcesses.length > 0) throw new Error("portfolio_stardew_process_running");
  if (before.transactionLock.state !== "absent")
    throw new Error(
      before.transactionLock.state === "valid"
        ? "portfolio_transaction_locked"
        : `portfolio_transaction_${before.transactionLock.state}`,
    );
  if (before.dataRootInspection.state !== "clean") throw new Error(before.dataRootInspection.reasons[0]);
  if (!isEmptyProfileForBootstrap(before.profile)) {
    if (before.profile.state !== "ready") throw new Error(before.profile.reasons[0]);
  }
  const game = await inspectTargetGame(options.gamePath);
  if (game.state !== "ready") throw new Error(game.reasons[0]);
  await beginTransaction(context, options.backupName);
  const backupDir = join(context.dataRoot, "backups", options.backupName);
  try {
    if (await exists(backupDir)) throw new Error("portfolio_backup_already_exists");
    await mkdir(backupDir, { recursive: true });
    const _manifest = await backupProfile(context, backupDir);
    await deploySingleBundle(context, options.releaseDir);
    const after = await inspectPortfolioProfile({ ...options, ...context });
    if (after.profile.state !== "ready") throw new Error(after.profile.reasons[0]);
    return Object.freeze({
      state: "prepared",
      topology: PORTFOLIO_TOPOLOGY,
      backup: backupDir,
      transactionLock: lockPath(context),
      backupManifest: join(backupDir, "manifest.json"),
    });
  } catch (error) {
    // After the manifest exists, it is the only recovery authority. Never
    // discard it or release the lock when a rollback cannot prove restoration.
    if (await exists(join(backupDir, "manifest.json"))) {
      try {
        await restorePortfolioProfileUnlocked(context, backupDir, false);
      } catch (restoreError) {
        throw new Error(`portfolio_restore_failed_recovery_required:${boundedMessage(restoreError)}`);
      }
    }
    await rm(backupDir, { recursive: true, force: true });
    await endTransaction(context);
    throw error;
  }
}

export async function restorePortfolioProfile(options) {
  const context = resolveContext(options);
  assertBackupName(options.backupName);
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  await assertTransactionOwner(context, options.backupName);
  const backupDir = join(context.dataRoot, "backups", options.backupName);
  const result = await restorePortfolioProfileUnlocked(context, backupDir, options.removeBackup !== false);
  if (options.removeBackup !== false) await endTransaction(context);
  return result;
}

/**
 * Upgrades the bundle within the still-owned native-bootstrap transaction and
 * arms only the default-off P0b lifecycle producer. It never accepts a
 * Farmhand-shaped config, invents scope, prints a secret, or releases the
 * bootstrap recovery lock. The existing backup remains the sole rollback
 * authority until a live result is explicitly committed or restored.
 */
export async function preparePortfolioP0bLifecycleProducer(options) {
  const context = resolveContext(options);
  validatePrepareOptions(options, context);
  const producer = await validateP0bLifecycleProducerOptions(options, context);
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  await assertTransactionOwner(context, options.backupName);
  const backupDir = join(context.dataRoot, "backups", options.backupName);
  if (!(await exists(join(backupDir, "manifest.json")))) throw new Error("portfolio_backup_manifest_missing");
  const current = await readOwnedBootstrapPortfolioConfig(context, producer);
  await deployBundleWithPortfolioConfig(context, options.releaseDir, current);
  const written = await readOwnedBootstrapPortfolioConfig(context, producer);
  if (
    written.P0bLifecycleProducer?.Enable !== true ||
    written.P0bLifecycleProducer.LogicalSaveName !== producer.logicalSaveName ||
    written.P0bLifecycleProducer.ObservedSaveSlot !== producer.observedSaveSlot ||
    written.P0bLifecycleProducer.TimeoutSeconds !== producer.timeoutSeconds ||
    written.P0bLifecycleProducer.StartManifestPath !== producer.startManifestPath ||
    written.P0bLifecycleProducer.SigningKeyEnvironmentVariableName !== producer.signingKeyEnvironmentVariableName
  ) {
    throw new Error("portfolio_p0b_producer_config_not_armed");
  }
  return Object.freeze({
    state: "p0b_lifecycle_producer_prepared",
    topology: PORTFOLIO_TOPOLOGY,
    transactionLock: lockPath(context),
    backup: backupDir,
  });
}

/**
 * Recreates the minimal, disarmed Portfolio bundle for an already observed
 * target-version save. This is for a re-run after a prior transaction was
 * restored; it never creates or mutates a Stardew save. The caller supplies
 * the previously observed native scope and a process-local bridge token.
 */
export async function preparePortfolioExistingSaveProfile(options) {
  const context = resolveContext(options);
  validatePrepareOptions(options, context);
  const existing = validateExistingSaveOptions(options, context);
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  const before = await inspectPortfolioProfile({ ...options, ...context });
  if (before.observedProcesses.length > 0) throw new Error("portfolio_stardew_process_running");
  if (before.transactionLock.state !== "absent")
    throw new Error(
      before.transactionLock.state === "valid"
        ? "portfolio_transaction_locked"
        : `portfolio_transaction_${before.transactionLock.state}`,
    );
  if (before.dataRootInspection.state !== "clean") throw new Error(before.dataRootInspection.reasons[0]);
  if (!isEmptyProfileForBootstrap(before.profile))
    throw new Error(before.profile.reasons[0] ?? "portfolio_profile_not_empty_for_existing_save");
  const game = await inspectTargetGame(options.gamePath);
  if (game.state !== "ready") throw new Error(game.reasons[0]);

  await beginTransaction(context, options.backupName);
  const backupDir = join(context.dataRoot, "backups", options.backupName);
  try {
    if (await exists(backupDir)) throw new Error("portfolio_backup_already_exists");
    await mkdir(backupDir, { recursive: true });
    await backupProfile(context, backupDir);
    await deploySingleBundle(context, options.releaseDir, existing);
    const armed = await inspectPortfolioProfile({ ...options, ...context });
    if (armed.profile.state !== "ready")
      throw new Error(armed.profile.reasons[0] ?? "portfolio_existing_save_profile_not_ready");
    return Object.freeze({
      state: "existing_save_profile_prepared",
      topology: PORTFOLIO_TOPOLOGY,
      backup: backupDir,
      transactionLock: lockPath(context),
      profileRoot: context.profileRoot,
    });
  } catch (error) {
    if (await exists(join(backupDir, "manifest.json"))) {
      try {
        await restorePortfolioProfileUnlocked(context, backupDir, false);
      } catch (restoreError) {
        throw new Error(`portfolio_restore_failed_recovery_required:${boundedMessage(restoreError)}`);
      }
    }
    await rm(backupDir, { recursive: true, force: true });
    await endTransaction(context);
    throw error;
  }
}

/**
 * Deploys a one-shot native new-save request. This is intentionally a
 * transaction state, not a P0a pass: an armed bootstrap is rejected by the
 * normal prerequisite checker until the game writes its own disarmed config.
 */
export async function preparePortfolioBootstrapProfile(options) {
  const context = resolveContext(options);
  validatePrepareOptions(options, context);
  const bootstrap = validateBootstrapOptions(options, context);
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  const before = await inspectPortfolioProfile({ ...options, ...context });
  if (before.observedProcesses.length > 0) throw new Error("portfolio_stardew_process_running");
  if (before.transactionLock.state !== "absent")
    throw new Error(
      before.transactionLock.state === "valid"
        ? "portfolio_transaction_locked"
        : `portfolio_transaction_${before.transactionLock.state}`,
    );
  if (before.dataRootInspection.state !== "clean") throw new Error(before.dataRootInspection.reasons[0]);
  if (!isEmptyProfileForBootstrap(before.profile))
    throw new Error(before.profile.reasons[0] ?? "portfolio_profile_not_empty_for_bootstrap");
  const game = await inspectTargetGame(options.gamePath);
  if (game.state !== "ready") throw new Error(game.reasons[0]);

  await beginTransaction(context, options.backupName);
  const backupDir = join(context.dataRoot, "backups", options.backupName);
  try {
    if (await exists(backupDir)) throw new Error("portfolio_backup_already_exists");
    await mkdir(backupDir, { recursive: true });
    const _manifest = await backupProfile(context, backupDir);
    await deploySingleBundle(context, options.releaseDir, bootstrap);
    const armed = await inspectPortfolioProfile({ ...options, ...context });
    if (
      armed.profile.config.state !== "blocked" ||
      !armed.profile.config.reasons.includes("portfolio_bootstrap_must_be_disarmed_in_p0a")
    ) {
      throw new Error("portfolio_bootstrap_config_not_armed");
    }
    return Object.freeze({
      state: "bootstrap_prepared",
      topology: PORTFOLIO_TOPOLOGY,
      backup: backupDir,
      transactionLock: lockPath(context),
      backupManifest: join(backupDir, "manifest.json"),
      profileRoot: context.profileRoot,
    });
  } catch (error) {
    if (await exists(join(backupDir, "manifest.json"))) {
      try {
        await restorePortfolioProfileUnlocked(context, backupDir, false);
      } catch (restoreError) {
        throw new Error(`portfolio_restore_failed_recovery_required:${boundedMessage(restoreError)}`);
      }
    }
    await rm(backupDir, { recursive: true, force: true });
    await endTransaction(context);
    throw error;
  }
}

/**
 * Completes a native bootstrap transaction only after the running Mod has
 * persisted a normal, disarmed Portfolio config. It never creates evidence.
 */
export async function commitPortfolioBootstrapProfile(options) {
  const context = resolveContext(options);
  assertBackupName(options.backupName);
  await assertNoStardewProcesses(options.processNames ?? DEFAULT_PROCESS_NAMES);
  await assertTransactionOwner(context, options.backupName);
  const inspection = await inspectPortfolioProfile({ ...options, ...context });
  if (inspection.profile.state !== "ready")
    throw new Error(inspection.profile.reasons[0] ?? "portfolio_bootstrap_not_disarmed");
  const backupDir = join(context.dataRoot, "backups", options.backupName);
  await rm(backupDir, { recursive: true, force: true });
  await endTransaction(context);
  return Object.freeze({
    state: "bootstrap_committed",
    topology: PORTFOLIO_TOPOLOGY,
    profileRoot: context.profileRoot,
    dataRoot: context.dataRoot,
  });
}

async function restorePortfolioProfileUnlocked(context, backupDir, removeBackup) {
  const manifest = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.topology !== PORTFOLIO_TOPOLOGY || !Array.isArray(manifest.entries))
    throw new Error("invalid_portfolio_backup_manifest");
  for (const entry of manifest.entries) {
    if (!isBackupEntry(entry)) throw new Error("invalid_portfolio_backup_entry");
    const target = safeProfilePath(context, entry.relativePath);
    if (entry.existed) {
      const bytes = await readFile(join(backupDir, entry.backupFile));
      if (sha256(bytes) !== entry.sha256) throw new Error(`portfolio_backup_hash_mismatch:${entry.relativePath}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    } else {
      await rm(target, { force: true });
    }
  }
  for (const entry of manifest.entries) {
    const target = safeProfilePath(context, entry.relativePath);
    if (entry.existed && sha256(await readFile(target)) !== entry.sha256)
      throw new Error(`portfolio_restore_hash_mismatch:${entry.relativePath}`);
    if (!entry.existed && (await exists(target)))
      throw new Error(`portfolio_restore_absence_mismatch:${entry.relativePath}`);
  }
  if (removeBackup) await rm(backupDir, { recursive: true, force: true });
  return Object.freeze({
    state: "restored",
    topology: PORTFOLIO_TOPOLOGY,
    backup: backupDir,
    backupRemoved: removeBackup,
  });
}

async function inspectProfile(context) {
  const reasons = [];
  if (context.profileRoot !== context.modsPath) reasons.push("portfolio_profile_mods_path_mismatch");
  if (!isAbsolute(context.profileRoot)) reasons.push("portfolio_profile_root_not_absolute");
  const bundle = await inspectBundle(context);
  if (bundle.state !== "single_bundle") reasons.push(...bundle.reasons);
  const config = await inspectPortfolioConfig(context);
  if (config.state !== "clean") reasons.push(...config.reasons);
  const name = basename(context.saveName);
  if (!isValidPortfolioSaveName(context.saveName) || name !== context.saveName)
    reasons.push("portfolio_save_name_invalid");
  if (context.saveName.startsWith("GameBuddyFixture_")) reasons.push("portfolio_fixture_save_forbidden");
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    bundle,
    config,
  });
}

export async function inspectPortfolioModBundle(profileRoot) {
  if (typeof profileRoot !== "string" || !isAbsolute(profileRoot)) {
    return Object.freeze({
      state: "blocked",
      reasons: Object.freeze(["portfolio_profile_root_missing_or_not_absolute"]),
      directory: null,
      files: Object.freeze([]),
      directFiles: Object.freeze([]),
      modFiles: Object.freeze([]),
      directUnexpected: Object.freeze([]),
      modUnexpected: Object.freeze([]),
    });
  }
  return inspectBundle({ profileRoot });
}

async function inspectBundle(context) {
  const directDirectory = join(context.profileRoot, "GameBuddy");
  const modDirectory = join(context.profileRoot, "Mods", "GameBuddy");
  const direct = await existingBundleFiles(directDirectory);
  const mod = await existingBundleFiles(modDirectory);
  const directUnexpected = await unexpectedBundleEntries(directDirectory);
  const modUnexpected = await unexpectedBundleEntries(modDirectory);
  const reasons = [];
  const directComplete = direct.length === BUNDLE_FILES.length;
  const modComplete = mod.length === BUNDLE_FILES.length;
  if (direct.length > 0 && mod.length > 0) reasons.push("portfolio_duplicate_mod_bundle");
  if (!directComplete && !modComplete) reasons.push("portfolio_mod_bundle_missing");
  if ((direct.length > 0 && !directComplete) || (mod.length > 0 && !modComplete))
    reasons.push("portfolio_mod_bundle_incomplete");
  if (directComplete && modComplete) reasons.push("portfolio_duplicate_mod_bundle");
  if (directUnexpected.length > 0 || modUnexpected.length > 0) reasons.push("portfolio_mod_bundle_unmanaged_file");
  const directory = directComplete ? directDirectory : modComplete ? modDirectory : null;
  const files = directComplete ? direct : modComplete ? mod : [];
  return Object.freeze({
    state: reasons.length === 0 ? "single_bundle" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    directory,
    files: Object.freeze(files),
    directFiles: Object.freeze(direct),
    modFiles: Object.freeze(mod),
    directUnexpected: Object.freeze(directUnexpected),
    modUnexpected: Object.freeze(modUnexpected),
  });
}

async function inspectPortfolioConfig(context) {
  const paths = [
    join(context.profileRoot, "GameBuddy", "config.json"),
    join(context.profileRoot, "Mods", "GameBuddy", "config.json"),
  ];
  const existing = [];
  const reasons = [];
  for (const path of paths) {
    if (!(await exists(path))) continue;
    existing.push(path);
    let value;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      reasons.push("portfolio_config_invalid_json");
      continue;
    }
    for (const reason of configContaminationReasons(value, context)) reasons.push(reason);
  }
  if (existing.length !== 1)
    reasons.push(existing.length === 0 ? "portfolio_config_missing" : "portfolio_duplicate_config_sources");
  return Object.freeze({
    state: reasons.length === 0 ? "clean" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
    paths: Object.freeze(existing),
  });
}

function configContaminationReasons(config, context) {
  const reasons = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["portfolio_config_invalid_shape"];
  if ("HostFarmhandProvisioning" in config) reasons.push("portfolio_contaminated_host_farmhand_provisioning");
  if ("FarmhandProvisioner" in config) reasons.push("portfolio_contaminated_farmhand_provisioner");
  if ("HostAutomation" in config) reasons.push("portfolio_contaminated_host_automation");
  if ("FarmhandProvisioningProbe" in config) reasons.push("portfolio_contaminated_farmhand_probe");
  if ("PlayerId" in config || "EnabledActions" in config) reasons.push("portfolio_contaminated_legacy_farmhand_fields");
  if (config.EnableLocalBridge !== undefined && config.EnableLocalBridge !== false)
    reasons.push("portfolio_bridge_must_remain_disabled_in_p0a");
  if (config.Topology !== undefined && config.Topology !== PORTFOLIO_TOPOLOGY)
    reasons.push("portfolio_topology_missing_or_invalid");
  if (
    config.PortfolioDataRoot !== undefined &&
    (typeof config.PortfolioDataRoot !== "string" || !isAbsolute(config.PortfolioDataRoot))
  )
    reasons.push("portfolio_config_data_root_invalid");
  if (
    config.PortfolioDataRoot !== undefined &&
    typeof config.PortfolioDataRoot === "string" &&
    isAbsolute(config.PortfolioDataRoot) &&
    resolve(config.PortfolioDataRoot) !== resolve(context.dataRoot)
  )
    reasons.push("portfolio_config_data_root_mismatch");
  if (
    config.ExpectedGameVersion !== undefined &&
    (config.ExpectedGameVersion !== "1.6.15" || config.ExpectedGameBuildNumber !== 24356)
  )
    reasons.push("portfolio_config_target_version_invalid");
  if ("Preview" in config || "SinglePlayerCompanionPreview" in config)
    reasons.push("portfolio_contaminated_preview_config");
  const legacyKeys = new Set([
    "Topology",
    "EnableLocalBridge",
    "PipeName",
    "BridgeToken",
    "SaveId",
    "WorldId",
    "LocalPlayerId",
    "CompanionId",
    "PortfolioDataRoot",
    "ExpectedGameVersion",
    "ExpectedGameBuildNumber",
    "ActionPolicyVersion",
    "DeniedActions",
    "DeniedActionFamilies",
    "ExperimentalActions",
  ]);
  if (Object.keys(config).some((key) => key !== "Portfolio" && !legacyKeys.has(key)))
    reasons.push("portfolio_config_unknown_field");
  const portfolio = config.Portfolio;
  if (!portfolio || typeof portfolio !== "object" || Array.isArray(portfolio)) {
    if (config.Topology === PORTFOLIO_TOPOLOGY) reasons.push("portfolio_topology_missing_or_invalid");
    return [...new Set([...reasons, "portfolio_config_invalid_shape"])].sort();
  }
  if (Object.keys(portfolio).some((key) => !PORTFOLIO_INNER_CONFIG_KEYS.includes(key)))
    reasons.push("portfolio_config_unknown_field");
  if (portfolio.Topology !== PORTFOLIO_TOPOLOGY) reasons.push("portfolio_topology_missing_or_invalid");
  if (portfolio.Enable === true && portfolio.EnableObserveBridge !== true)
    reasons.push("portfolio_observe_bridge_not_enabled");
  if (typeof portfolio.DataRoot !== "string" || !isAbsolute(portfolio.DataRoot))
    reasons.push("portfolio_config_data_root_invalid");
  else if (resolve(portfolio.DataRoot) !== resolve(context.dataRoot))
    reasons.push("portfolio_config_data_root_mismatch");
  if (portfolio.ExpectedGameVersion !== "1.6.15" || portfolio.ExpectedGameBuildNumber !== 24356)
    reasons.push("portfolio_config_target_version_invalid");
  if (
    portfolio.Enable === true &&
    (!/^[A-Za-z0-9_-]{1,128}$/.test(portfolio.PipeName ?? "") ||
      !String(portfolio.PipeName).startsWith("gamebuddy-stardew-portfolio") ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(portfolio.BridgeToken ?? ""))
  )
    reasons.push("portfolio_config_bridge_invalid");
  if (
    portfolio.Enable === true &&
    (portfolio.EnableObserveBridge !== true || portfolio.Topology !== PORTFOLIO_TOPOLOGY)
  )
    reasons.push("portfolio_runtime_bridge_not_closed_or_scoped");
  if (portfolio.MineEntryGivenFixture !== undefined) {
    const fixture = portfolio.MineEntryGivenFixture;
    if (
      !fixture ||
      typeof fixture !== "object" ||
      Array.isArray(fixture) ||
      Object.keys(fixture).some((key) => key !== "Enable") ||
      typeof fixture.Enable !== "boolean" ||
      (fixture.Enable === true && !isMineEntryActionSequence(portfolio.EnabledActions))
    )
      reasons.push("portfolio_mine_entry_given_fixture_invalid");
  }
  if (portfolio.MineLadderGivenFixture !== undefined) {
    const fixture = portfolio.MineLadderGivenFixture;
    if (
      !fixture ||
      typeof fixture !== "object" ||
      Array.isArray(fixture) ||
      Object.keys(fixture).some((key) => key !== "Enable") ||
      fixture.Enable !== true ||
      !isMineLadderActionSequence(portfolio.EnabledActions)
    )
      reasons.push("portfolio_mine_ladder_given_fixture_invalid");
  }
  if (portfolio.InitialNativeLoad !== undefined) {
    const initialLoad = portfolio.InitialNativeLoad;
    if (
      !initialLoad ||
      typeof initialLoad !== "object" ||
      Array.isArray(initialLoad) ||
      Object.keys(initialLoad).some((key) => !["Enable", "ObservedSaveSlot"].includes(key)) ||
      typeof initialLoad.Enable !== "boolean" ||
      !/^GameBuddyPortfolio[A-Za-z0-9_-]{1,128}_[0-9]{1,32}$/.test(initialLoad.ObservedSaveSlot ?? "")
    )
      reasons.push("portfolio_initial_native_load_invalid");
  }
  if (portfolio.P0bLifecycleProducer !== undefined) {
    const producer = portfolio.P0bLifecycleProducer;
    if (
      !producer ||
      typeof producer !== "object" ||
      Array.isArray(producer) ||
      Object.keys(producer).some((key) => !PORTFOLIO_P0B_PRODUCER_KEYS.includes(key)) ||
      typeof producer.Enable !== "boolean" ||
      !isValidPortfolioP0bLogicalSaveName(producer.LogicalSaveName) ||
      !isObservedSaveSlotForLogicalName(producer.ObservedSaveSlot, producer.LogicalSaveName) ||
      !isAbsolute(producer.StartManifestPath) ||
      !isValidEnvironmentVariableName(producer.SigningKeyEnvironmentVariableName) ||
      !Number.isInteger(producer.TimeoutSeconds) ||
      producer.TimeoutSeconds < 30 ||
      producer.TimeoutSeconds > 900
    ) {
      reasons.push("portfolio_p0b_lifecycle_producer_invalid");
    }
  }
  if (portfolio.Bootstrap !== undefined) {
    if (!portfolio.Bootstrap || typeof portfolio.Bootstrap !== "object" || Array.isArray(portfolio.Bootstrap)) {
      reasons.push("portfolio_bootstrap_config_invalid");
    } else {
      const bootstrapAllowed = new Set(["Enable", "SaveName", "PlayerName"]);
      if (Object.keys(portfolio.Bootstrap).some((key) => !bootstrapAllowed.has(key)))
        reasons.push("portfolio_config_unknown_field");
      if (portfolio.Bootstrap.Enable !== false) reasons.push("portfolio_bootstrap_must_be_disarmed_in_p0a");
      if (portfolio.Bootstrap.SaveName !== undefined && !isValidPortfolioSaveName(portfolio.Bootstrap.SaveName))
        reasons.push("portfolio_bootstrap_save_name_invalid");
      if (
        portfolio.Bootstrap.PlayerName !== undefined &&
        (typeof portfolio.Bootstrap.PlayerName !== "string" ||
          !/^[A-Za-z0-9-]{1,64}$/.test(portfolio.Bootstrap.PlayerName))
      )
        reasons.push("portfolio_bootstrap_player_name_invalid");
    }
  }
  return [...new Set(reasons)].sort();
}

async function inspectDataRoot(context) {
  const reasons = [];
  if (!isAbsolute(context.dataRoot)) reasons.push("portfolio_data_root_not_absolute");
  const resolvedDataRoot = resolve(context.dataRoot);
  const resolvedProfileRoot = resolve(context.profileRoot);
  if (
    resolvedDataRoot === resolvedProfileRoot ||
    relative(resolvedDataRoot, resolvedProfileRoot).startsWith("..") === false ||
    relative(resolvedProfileRoot, resolvedDataRoot).startsWith("..") === false
  ) {
    reasons.push("portfolio_data_root_profile_root_overlap");
  }
  if (await exists(context.dataRoot)) {
    for (const entry of await walk(context.dataRoot)) {
      const name = basename(entry).toLocaleLowerCase("en-US");
      if (CONTAMINATION_FILE_NAMES.has(name)) reasons.push(CONTAMINATION_FILE_NAMES.get(name));
      if (name.startsWith("native_") || name.startsWith("gamebuddyfixture_"))
        reasons.push("portfolio_contaminated_farmhand_fixture_artifact");
      if (name.includes("farmhand") || name.includes("preview"))
        reasons.push("portfolio_contaminated_cross_topology_artifact");
    }
  }
  return Object.freeze({
    state: reasons.length === 0 ? "clean" : "blocked",
    reasons: Object.freeze([...new Set(reasons)].sort()),
  });
}

async function inspectTargetGame(gamePath) {
  const reasons = [];
  if (typeof gamePath !== "string" || gamePath.length === 0)
    return Object.freeze({ state: "blocked", reasons: Object.freeze(["portfolio_game_path_missing"]), gamePath: null });
  if (!isAbsolute(gamePath)) reasons.push("portfolio_game_path_not_absolute");
  for (const required of ["Stardew Valley.dll", "StardewModdingAPI.dll", "StardewModdingAPI.exe"]) {
    if (!(await exists(join(gamePath, required)))) reasons.push(`portfolio_game_file_missing:${required}`);
  }
  return Object.freeze({
    state: reasons.length === 0 ? "ready" : "blocked",
    reasons: Object.freeze(reasons),
    gamePath,
  });
}

async function backupProfile(context, backupDir) {
  const entries = [];
  for (const relativePath of managedRelativePaths()) {
    const target = safeProfilePath(context, relativePath);
    const existed = await exists(target);
    const backupFile = `files/${entries.length}`;
    if (existed) {
      const bytes = await readFile(target);
      await mkdir(dirname(join(backupDir, backupFile)), { recursive: true });
      await writeFile(join(backupDir, backupFile), bytes);
      entries.push({ relativePath, existed: true, backupFile, sha256: sha256(bytes) });
    } else {
      entries.push({ relativePath, existed: false, backupFile, sha256: null });
    }
  }
  const manifest = { version: 1, topology: PORTFOLIO_TOPOLOGY, entries };
  await writeFile(join(backupDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function deploySingleBundle(context, releaseDir, bootstrap = null) {
  const sourceFiles = await existingBundleFiles(releaseDir);
  if (sourceFiles.length !== BUNDLE_FILES.length) throw new Error("portfolio_release_bundle_incomplete");
  const direct = join(context.profileRoot, "GameBuddy");
  const mod = join(context.profileRoot, "Mods", "GameBuddy");
  for (const directory of [direct, mod]) {
    for (const file of [...BUNDLE_FILES, "config.json"]) await rm(join(directory, file), { force: true });
  }
  await mkdir(direct, { recursive: true });
  for (const file of BUNDLE_FILES) await cp(join(releaseDir, file), join(direct, file));
  const config =
    bootstrap && bootstrap.Topology === PORTFOLIO_TOPOLOGY
      ? { Portfolio: bootstrap }
      : portfolioConfig(context, bootstrap);
  await writeFile(join(direct, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function isEmptyProfileForBootstrap(profile) {
  return (
    profile.bundle?.state === "blocked" &&
    profile.bundle.reasons?.length === 1 &&
    profile.bundle.reasons[0] === "portfolio_mod_bundle_missing" &&
    profile.config?.state === "blocked" &&
    profile.config.reasons?.length === 1 &&
    profile.config.reasons[0] === "portfolio_config_missing"
  );
}

function portfolioConfig(context, bootstrap = null) {
  const armed = bootstrap !== null;
  return {
    Portfolio: {
      Enable: armed,
      Topology: PORTFOLIO_TOPOLOGY,
      EnableObserveBridge: armed,
      PipeName: bootstrap?.pipeName ?? "gamebuddy-stardew-portfolio",
      BridgeToken: bootstrap?.bridgeToken ?? "replace_with_an_untracked_16_char_minimum_token",
      SaveId: "Game1_uniqueIDForThisGame_decimal",
      WorldId: "Game1_MasterPlayer_UniqueMultiplayerID_decimal",
      LocalPlayerId: "Game1_player_UniqueMultiplayerID_decimal",
      CompanionId: bootstrap?.companionId ?? "opaque_companion_id",
      DataRoot: context.dataRoot,
      ExpectedGameVersion: "1.6.15",
      ExpectedGameBuildNumber: 24356,
      ...(armed ? { Bootstrap: { Enable: true, SaveName: context.saveName, PlayerName: bootstrap.playerName } } : {}),
    },
  };
}

function resolveContext(options = {}) {
  const profileRoot = options.profileRoot ?? options.modsPath;
  if (typeof profileRoot !== "string" || profileRoot.length === 0) throw new Error("portfolio_profile_root_missing");
  const modsPath = options.modsPath ?? profileRoot;
  const dataRoot = options.dataRoot;
  const saveName = options.saveName;
  if (typeof dataRoot !== "string" || dataRoot.length === 0) throw new Error("portfolio_data_root_missing");
  if (typeof saveName !== "string" || saveName.length === 0) throw new Error("portfolio_save_name_missing");
  return Object.freeze({ profileRoot, modsPath, dataRoot, saveRoot: options.saveRoot, saveName });
}

function validatePrepareOptions(options, context) {
  if (typeof options.releaseDir !== "string" || !isAbsolute(options.releaseDir))
    throw new Error("portfolio_release_dir_invalid");
  if (!isValidPortfolioSaveName(context.saveName)) throw new Error("portfolio_save_name_invalid");
  assertBackupName(options.backupName);
}

function validateBootstrapOptions(options, context) {
  const playerName = options.playerName ?? "GameBuddy";
  const companionId = options.companionId ?? "portfolio_companion";
  const pipeName = options.pipeName ?? "gamebuddy-stardew-portfolio";
  const bridgeToken = options.bridgeToken;
  if (typeof playerName !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(playerName))
    throw new Error("portfolio_bootstrap_player_name_invalid");
  if (typeof companionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(companionId))
    throw new Error("portfolio_bootstrap_companion_id_invalid");
  if (typeof pipeName !== "string" || !/^gamebuddy-stardew-portfolio[A-Za-z0-9_-]{0,96}$/.test(pipeName))
    throw new Error("portfolio_bootstrap_pipe_name_invalid");
  if (typeof bridgeToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(bridgeToken))
    throw new Error("portfolio_bootstrap_bridge_token_invalid");
  return Object.freeze({ playerName, companionId, pipeName, bridgeToken, saveName: context.saveName });
}

function validateExistingSaveOptions(options, context) {
  const pipeName = options.pipeName;
  const bridgeToken = options.bridgeToken;
  const enabledActions = options.enabledActions;
  const observedSaveSlot = options.observedSaveSlot;
  const mineEntryGivenFixture = isMineEntryActionSequence(enabledActions);
  const mineLadderGivenFixture = isMineLadderActionSequence(enabledActions);
  const mineElevatorGivenFixture = isMineElevatorActionSequence(enabledActions);
  if (options.mineEntryGivenFixture !== undefined && options.mineEntryGivenFixture !== mineEntryGivenFixture)
    throw new Error("portfolio_existing_save_mine_entry_fixture_must_match_action");
  if (options.mineLadderGivenFixture !== undefined)
    throw new Error("portfolio_existing_save_mine_ladder_fixture_is_action_derived");
  if (options.mineElevatorGivenFixture !== undefined)
    throw new Error("portfolio_existing_save_mine_elevator_fixture_is_action_derived");
  if (mineEntryGivenFixture) {
    // Only the exact ordered skip/entry sequence or the single entry action
    // exists as an M8 entry Given. Do not generalize arbitrary arrays.
    if (!isMineEntryActionSequence(enabledActions))
      throw new Error("portfolio_existing_save_enabled_actions_invalid");
  } else if (
    !Array.isArray(enabledActions) ||
    enabledActions.length !== 1 ||
    enabledActions[0] !== "enter_mine"
  ) {
    // Non-entry profiles remain single-action within the closed allowlist.
    if (
      !Array.isArray(enabledActions) ||
      enabledActions.length !== 1 ||
      new Set(enabledActions).size !== enabledActions.length ||
      enabledActions.some((action) => typeof action !== "string" || !PORTFOLIO_EXISTING_SAVE_ACTIONS.includes(action))
    )
      throw new Error("portfolio_existing_save_enabled_actions_invalid");
  }
  const scope = Object.fromEntries(
    ["saveId", "worldId", "localPlayerId", "companionId"].map((key) => [key, options[key]]),
  );
  if (typeof pipeName !== "string" || !/^gamebuddy-stardew-portfolio[A-Za-z0-9_-]{0,96}$/.test(pipeName))
    throw new Error("portfolio_existing_save_pipe_name_invalid");
  if (typeof bridgeToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(bridgeToken))
    throw new Error("portfolio_existing_save_bridge_token_invalid");
  if (Object.values(scope).some((value) => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)))
    throw new Error("portfolio_existing_save_scope_invalid");
  if (
    typeof observedSaveSlot !== "string" ||
    !/^GameBuddyPortfolio[A-Za-z0-9_-]{1,128}_[0-9]{1,32}$/.test(observedSaveSlot)
  )
    throw new Error("portfolio_existing_save_observed_slot_invalid");
  if (mineEntryGivenFixture && !isMineEntryActionSequence(enabledActions))
    throw new Error("portfolio_existing_save_mine_entry_fixture_action_invalid");
  return Object.freeze({
    Enable: true,
    Topology: PORTFOLIO_TOPOLOGY,
    EnableObserveBridge: true,
    PipeName: pipeName,
    BridgeToken: bridgeToken,
    SaveId: scope.saveId,
    WorldId: scope.worldId,
    LocalPlayerId: scope.localPlayerId,
    CompanionId: scope.companionId,
    DataRoot: context.dataRoot,
    ExpectedGameVersion: "1.6.15",
    ExpectedGameBuildNumber: 24356,
    EnabledActions: Object.freeze([...enabledActions]),
    // Preserve the disarmed bootstrap provenance required by the P0b upgrade
    // guard; this does not invoke bootstrap or mutate the existing save.
    Bootstrap: { Enable: false, SaveName: context.saveName, PlayerName: "GameBuddy" },
    InitialNativeLoad: { Enable: true, ObservedSaveSlot: observedSaveSlot },
    ...(mineEntryGivenFixture ? { MineEntryGivenFixture: { Enable: true } } : {}),
    ...(mineLadderGivenFixture ? { MineLadderGivenFixture: { Enable: true } } : {}),
    ...(mineElevatorGivenFixture ? { MineElevatorGivenFixture: { Enable: true } } : {}),
  });
}

function isMineEntryActionSequence(enabledActions) {
  return (
    Array.isArray(enabledActions) &&
    (JSON.stringify(enabledActions) === JSON.stringify(["enter_mine"]) ||
      JSON.stringify(enabledActions) === JSON.stringify(["skip_event", "enter_mine"]))
  );
}

function isMineLadderActionSequence(enabledActions) {
  return Array.isArray(enabledActions) && enabledActions.length === 1 && enabledActions[0] === "use_mine_ladder";
}

function isMineElevatorActionSequence(enabledActions) {
  return Array.isArray(enabledActions) && enabledActions.length === 1 && enabledActions[0] === "select_mine_elevator_floor";
}

function isValidPortfolioSaveName(value) {
  return (
    typeof value === "string" &&
    value.startsWith(PORTFOLIO_SAVE_PREFIX) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    !value.endsWith("_")
  );
}

function isValidPortfolioP0bLogicalSaveName(value) {
  return (
    typeof value === "string" &&
    value.startsWith(PORTFOLIO_SAVE_PREFIX) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    !value.endsWith("_")
  );
}

async function validateP0bLifecycleProducerOptions(options, context) {
  const logicalSaveName = options.logicalSaveName;
  const observedSaveSlot = options.observedSaveSlot;
  const startManifestPath = options.startManifestPath;
  const signingKeyEnvironmentVariableName = options.signingKeyEnvironmentVariableName;
  const timeoutSeconds = options.timeoutSeconds ?? 180;
  if (!isValidPortfolioP0bLogicalSaveName(logicalSaveName)) throw new Error("portfolio_p0b_logical_save_name_invalid");
  if (!isObservedSaveSlotForLogicalName(observedSaveSlot, logicalSaveName))
    throw new Error("portfolio_p0b_observed_save_slot_invalid");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 900)
    throw new Error("portfolio_p0b_timeout_invalid");
  if (options.signingKey !== undefined || options.signingKeyValue !== undefined)
    throw new Error("portfolio_p0b_signing_key_forbidden");
  if (typeof context.saveRoot !== "string" || !isAbsolute(context.saveRoot))
    throw new Error("portfolio_p0b_save_root_missing_or_not_absolute");
  if (typeof startManifestPath !== "string" || startManifestPath.length === 0)
    throw new Error("portfolio_p0b_start_manifest_path_missing");
  if (!isAbsolute(startManifestPath)) throw new Error("portfolio_p0b_start_manifest_path_not_absolute");
  if (!isValidEnvironmentVariableName(signingKeyEnvironmentVariableName))
    throw new Error("portfolio_p0b_signing_key_environment_name_invalid");

  const resolvedManifestPath = resolve(startManifestPath);
  if (
    isPathWithin(resolvedManifestPath, context.profileRoot) ||
    isPathWithin(resolvedManifestPath, context.dataRoot) ||
    (typeof context.saveRoot === "string" && isPathWithin(resolvedManifestPath, context.saveRoot))
  )
    throw new Error("portfolio_p0b_start_manifest_path_overlap");
  if (await hasReparsePathComponent(resolvedManifestPath)) throw new Error("portfolio_p0b_start_manifest_path_reparse");
  if (!(await hasExistingNonReparseParent(resolvedManifestPath)))
    throw new Error("portfolio_p0b_start_manifest_path_missing");
  const target = await lstat(resolvedManifestPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw new Error("portfolio_p0b_start_manifest_path_invalid");
  });
  if (target?.isDirectory()) throw new Error("portfolio_p0b_start_manifest_path_invalid");
  return Object.freeze({
    logicalSaveName,
    observedSaveSlot,
    timeoutSeconds,
    startManifestPath: resolvedManifestPath,
    signingKeyEnvironmentVariableName,
  });
}

function isValidEnvironmentVariableName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
}

function isPathWithin(candidate, root) {
  const candidatePath = resolve(candidate);
  const rootPath = resolve(root);
  const suffix = relative(rootPath, candidatePath);
  const separator = process.platform === "win32" ? "\\" : "/";
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${separator}`));
}

async function hasExistingNonReparseParent(path) {
  const parent = dirname(path);
  try {
    const info = await lstat(parent);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new Error("portfolio_p0b_start_manifest_path_invalid");
  }
}

async function hasReparsePathComponent(path) {
  const components = [];
  let current = resolve(path);
  while (true) {
    components.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of components.reverse()) {
    try {
      const info = await lstat(component);
      if (info.isSymbolicLink()) return true;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error("portfolio_p0b_start_manifest_path_invalid");
    }
  }
  return false;
}

function isObservedSaveSlotForLogicalName(slot, logicalName) {
  const filteredName = filterTargetSaveName(logicalName);
  return typeof slot === "string" && new RegExp(`^${escapeRegExp(filteredName)}_[1-9][0-9]*$`).test(slot);
}

function filterTargetSaveName(value) {
  return value.replace(/[^A-Za-z0-9]/g, "");
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readOwnedBootstrapPortfolioConfig(context, producer) {
  const path = join(context.profileRoot, "GameBuddy", "config.json");
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("portfolio_bootstrap_config_invalid_json");
  }
  if (!config || typeof config !== "object" || Array.isArray(config) || !hasOnlyInertBootstrapLegacyFields(config)) {
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  }
  const portfolio = config.Portfolio;
  if (
    !portfolio ||
    typeof portfolio !== "object" ||
    Array.isArray(portfolio) ||
    portfolio.Enable !== true ||
    portfolio.Topology !== PORTFOLIO_TOPOLOGY ||
    portfolio.EnableObserveBridge !== true ||
    !isValidPortfolioP0bLogicalSaveName(producer.logicalSaveName) ||
    !isPortfolioRuntimeScope(portfolio)
  ) {
    throw new Error("portfolio_bootstrap_config_not_native_ready");
  }
  if (Object.keys(portfolio).some((key) => !PORTFOLIO_INNER_CONFIG_KEYS.includes(key)))
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  const initialLoad = portfolio.InitialNativeLoad;
  if (
    initialLoad !== undefined &&
    (!initialLoad ||
      typeof initialLoad !== "object" ||
      Array.isArray(initialLoad) ||
      Object.keys(initialLoad).some((key) => !["Enable", "ObservedSaveSlot"].includes(key)))
  )
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  const mineEntryGivenFixture = portfolio.MineEntryGivenFixture;
  if (
    mineEntryGivenFixture !== undefined &&
    (!mineEntryGivenFixture ||
      typeof mineEntryGivenFixture !== "object" ||
      Array.isArray(mineEntryGivenFixture) ||
      Object.keys(mineEntryGivenFixture).some((key) => key !== "Enable") ||
      mineEntryGivenFixture.Enable !== true ||
      !isMineEntryActionSequence(portfolio.EnabledActions))
  )
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  const mineLadderGivenFixture = portfolio.MineLadderGivenFixture;
  if (
    mineLadderGivenFixture !== undefined &&
    (!mineLadderGivenFixture ||
      typeof mineLadderGivenFixture !== "object" ||
      Array.isArray(mineLadderGivenFixture) ||
      Object.keys(mineLadderGivenFixture).some((key) => key !== "Enable") ||
      mineLadderGivenFixture.Enable !== true ||
      !isMineLadderActionSequence(portfolio.EnabledActions))
  )
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  const mineElevatorGivenFixture = portfolio.MineElevatorGivenFixture;
  if (
    mineElevatorGivenFixture !== undefined &&
    (!mineElevatorGivenFixture ||
      typeof mineElevatorGivenFixture !== "object" ||
      Array.isArray(mineElevatorGivenFixture) ||
      Object.keys(mineElevatorGivenFixture).some((key) => key !== "Enable") ||
      mineElevatorGivenFixture.Enable !== true ||
      !isMineElevatorActionSequence(portfolio.EnabledActions))
  )
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  const bootstrap = portfolio.Bootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap) || bootstrap.Enable !== false) {
    throw new Error("portfolio_bootstrap_must_be_disarmed_in_p0a");
  }
  if (Object.keys(bootstrap).some((key) => !["Enable", "SaveName", "PlayerName"].includes(key)))
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  const existingProducer = portfolio.P0bLifecycleProducer;
  if (
    existingProducer !== undefined &&
    (!existingProducer ||
      typeof existingProducer !== "object" ||
      Array.isArray(existingProducer) ||
      Object.keys(existingProducer).some((key) => !PORTFOLIO_P0B_PRODUCER_KEYS.includes(key)))
  )
    throw new Error("portfolio_bootstrap_config_cross_topology_contamination");
  // Target 1.6.15's loader derives Game1.GetSaveGameName from the physical
  // slot prefix (FilterFileName), not the bootstrap request spelling. These
  // must therefore match after the target's documented ASCII filtering.
  if (filterTargetSaveName(bootstrap.SaveName) !== producer.logicalSaveName) {
    throw new Error("portfolio_p0b_logical_save_name_does_not_match_bootstrap");
  }
  return {
    ...portfolio,
    Bootstrap: { ...bootstrap, Enable: false },
    P0bLifecycleProducer: {
      Enable: true,
      LogicalSaveName: producer.logicalSaveName,
      ObservedSaveSlot: producer.observedSaveSlot,
      TimeoutSeconds: producer.timeoutSeconds,
      StartManifestPath: producer.startManifestPath,
      SigningKeyEnvironmentVariableName: producer.signingKeyEnvironmentVariableName,
    },
  };
}

function hasOnlyInertBootstrapLegacyFields(config) {
  const allowed = new Set([
    "Portfolio",
    "EnableLocalBridge",
    "PipeName",
    "BridgeToken",
    "SaveId",
    "WorldId",
    "PlayerId",
    "CompanionId",
    "ActionPolicyVersion",
    "DeniedActions",
    "DeniedActionFamilies",
    "ExperimentalActions",
    "EnabledActions",
    "FarmhandProvisioningProbe",
    "HostFarmhandProvisioning",
    "HostAutomation",
    "FarmhandProvisioner",
  ]);
  if (Object.keys(config).some((key) => !allowed.has(key))) return false;
  return (
    (config.EnableLocalBridge === false || config.EnableLocalBridge === undefined) &&
    // Legacy root values are never read by the Portfolio branch and are
    // removed by this transaction. They may be stale bootstrap serialization,
    // so their presence alone is not cross-topology activation.
    (config.ActionPolicyVersion === 0 || config.ActionPolicyVersion === undefined) &&
    ["DeniedActions", "DeniedActionFamilies", "ExperimentalActions", "EnabledActions"].every(
      (key) =>
        config[key] === undefined || config[key] === null || (Array.isArray(config[key]) && config[key].length === 0),
    ) &&
    ["FarmhandProvisioningProbe", "HostFarmhandProvisioning", "HostAutomation", "FarmhandProvisioner"].every(
      (key) =>
        config[key] === undefined ||
        config[key] === null ||
        (typeof config[key] === "object" && config[key]?.Enable === false),
    )
  );
}

function isPortfolioRuntimeScope(portfolio) {
  return (
    typeof portfolio.PipeName === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(portfolio.PipeName) &&
    portfolio.PipeName.startsWith("gamebuddy-stardew-portfolio") &&
    typeof portfolio.BridgeToken === "string" &&
    /^[A-Za-z0-9_-]{16,256}$/.test(portfolio.BridgeToken) &&
    ["SaveId", "WorldId", "LocalPlayerId", "CompanionId"].every(
      (key) => typeof portfolio[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(portfolio[key]),
    ) &&
    typeof portfolio.DataRoot === "string" &&
    isAbsolute(portfolio.DataRoot) &&
    portfolio.ExpectedGameVersion === "1.6.15" &&
    portfolio.ExpectedGameBuildNumber === 24356
  );
}

async function deployBundleWithPortfolioConfig(context, releaseDir, portfolio) {
  const sourceFiles = await existingBundleFiles(releaseDir);
  if (sourceFiles.length !== BUNDLE_FILES.length) throw new Error("portfolio_release_bundle_incomplete");
  const direct = join(context.profileRoot, "GameBuddy");
  if ((await unexpectedBundleEntries(direct)).length > 0) throw new Error("portfolio_mod_bundle_unmanaged_file");
  for (const file of BUNDLE_FILES) await cp(join(releaseDir, file), join(direct, file));
  const config = `${JSON.stringify({ Portfolio: portfolio }, null, 2)}\n`;
  const temporary = join(direct, "config.json.p0b-tmp");
  if (await exists(temporary)) throw new Error("portfolio_p0b_config_temporary_exists");
  await writeFile(temporary, config);
  await rename(temporary, join(direct, "config.json"));
}

function assertBackupName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("portfolio_backup_name_invalid");
}

function managedRelativePaths() {
  return Object.freeze([
    ["GameBuddy", "config.json"],
    ["Mods", "GameBuddy", "config.json"],
    ...BUNDLE_FILES.map((file) => ["GameBuddy", file]),
    ...BUNDLE_FILES.map((file) => ["Mods", "GameBuddy", file]),
  ]);
}

function safeProfilePath(context, segments) {
  if (!managedRelativePaths().some((allowed) => JSON.stringify(allowed) === JSON.stringify(segments)))
    throw new Error("portfolio_path_not_managed");
  const result = resolve(context.profileRoot, ...segments);
  const pathToResult = relative(resolve(context.profileRoot), result);
  if (
    isAbsolute(pathToResult) ||
    pathToResult === ".." ||
    pathToResult.startsWith("../") ||
    pathToResult.startsWith("..\\")
  )
    throw new Error("portfolio_path_escape");
  return result;
}

function lockPath(context) {
  return join(context.dataRoot, PORTFOLIO_LOCK_DIRECTORY);
}

async function beginTransaction(context, backupName) {
  await mkdir(context.dataRoot, { recursive: true });
  try {
    await mkdir(lockPath(context));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    throw new Error("portfolio_transaction_locked");
  }
  await writeFile(
    join(lockPath(context), "transaction.json"),
    `${JSON.stringify({ version: 1, topology: PORTFOLIO_TOPOLOGY, backupName, ownerId: randomUUID(), startedAtUnixMs: Date.now() })}\n`,
  );
}
async function endTransaction(context) {
  await rm(lockPath(context), { recursive: true, force: true });
}
async function assertTransactionOwner(context, backupName) {
  const lock = await inspectLock(context);
  if (lock.state !== "valid" || lock.owner.backupName !== backupName)
    throw new Error("portfolio_transaction_owner_mismatch");
}
async function inspectLock(context) {
  const file = join(lockPath(context), "transaction.json");
  if (!(await exists(lockPath(context)))) return Object.freeze({ state: "absent", owner: null });
  try {
    const owner = JSON.parse(await readFile(file, "utf8"));
    if (owner?.version !== 1 || owner?.topology !== PORTFOLIO_TOPOLOGY || typeof owner.backupName !== "string")
      return Object.freeze({ state: "invalid", owner: null });
    return Object.freeze({ state: "valid", owner: Object.freeze(owner) });
  } catch {
    return Object.freeze({ state: "invalid", owner: null });
  }
}

async function existingBundleFiles(directory) {
  const names = [];
  for (const file of BUNDLE_FILES) if (await exists(join(directory, file))) names.push(file);
  return names;
}
async function unexpectedBundleEntries(directory) {
  if (!(await exists(directory))) return [];
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !entry.isFile() || ![...BUNDLE_FILES, "config.json"].includes(entry.name))
    .map((entry) => entry.name)
    .sort();
}
async function walk(root) {
  const result = [];
  if (!(await exists(root))) return result;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else result.push(path);
  }
  return result;
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function inspectStardewProcesses(names) {
  if (process.platform !== "win32" || names.length === 0) return [];
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("tasklist", ["/FO", "CSV", "/NH"]);
    return names.filter((name) => stdout.toLowerCase().includes(`"${name.toLowerCase()}"`));
  } catch {
    return [];
  }
}
async function assertNoStardewProcesses(names) {
  const running = await inspectStardewProcesses(names);
  if (running.length > 0) throw new Error(`portfolio_stardew_process_running:${running.join(",")}`);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function boundedMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 160);
}
function isBackupEntry(value) {
  return (
    value &&
    managedRelativePaths().some(
      (allowed, index) =>
        JSON.stringify(allowed) === JSON.stringify(value.relativePath) && value.backupFile === `files/${index}`,
    ) &&
    typeof value.existed === "boolean" &&
    (value.sha256 === null || /^[a-f0-9]{64}$/.test(value.sha256))
  );
}
