import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  checkPortfolioPrerequisites,
  commitPortfolioBootstrapProfile,
  inspectPortfolioModBundle,
  inspectPortfolioProfile,
  PORTFOLIO_TOPOLOGY,
  preparePortfolioBootstrapProfile,
  preparePortfolioExistingSaveProfile,
  preparePortfolioP0bLifecycleProducer,
  preparePortfolioProfile,
  restorePortfolioProfile,
} from "./lib/stardew-portfolio-profile.mjs";

const SAVE_NAME = "GameBuddyPortfolio_1_6_15";

async function createContext(t) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileRoot = join(root, "Portfolio");
  const dataRoot = join(root, "portfolio-data");
  const releaseDir = join(root, "release");
  const gamePath = join(root, "game");
  await writeBundle(releaseDir, "release");
  await writeBundle(join(profileRoot, "Mods", "GameBuddy"), "original");
  const config = cleanConfig(dataRoot);
  config.Portfolio.Enable = true;
  config.Portfolio.EnableObserveBridge = true;
  await writeConfig(join(profileRoot, "Mods", "GameBuddy", "config.json"), config);
  await mkdir(gamePath, { recursive: true });
  for (const file of ["Stardew Valley.dll", "StardewModdingAPI.dll", "StardewModdingAPI.exe"])
    await writeFile(join(gamePath, file), "target-version-placeholder");
  return {
    root,
    profileRoot,
    modsPath: profileRoot,
    dataRoot,
    saveRoot: join(root, "saves"),
    releaseDir,
    gamePath,
    saveName: SAVE_NAME,
    processNames: [],
  };
}

function cleanConfig(dataRoot) {
  return {
    Portfolio: {
      Enable: false,
      Topology: PORTFOLIO_TOPOLOGY,
      EnableObserveBridge: false,
      PipeName: "gamebuddy-stardew-portfolio",
      BridgeToken: "replace_with_an_untracked_16_char_minimum_token",
      SaveId: "Game1_uniqueIDForThisGame_decimal",
      WorldId: "Game1_MasterPlayer_UniqueMultiplayerID_decimal",
      LocalPlayerId: "Game1_player_UniqueMultiplayerID_decimal",
      CompanionId: "opaque_companion_id",
      DataRoot: dataRoot,
      ExpectedGameVersion: "1.6.15",
      ExpectedGameBuildNumber: 24356,
    },
  };
}

async function writeBundle(directory, contents) {
  await mkdir(directory, { recursive: true });
  for (const file of ["GameBuddy.Stardew.dll", "manifest.json", "GameBuddy.Stardew.deps.json"])
    await writeFile(join(directory, file), `${contents}:${file}`);
}
async function writeConfig(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

for (const [name, mutate, expectedReason] of [
  [
    "Farmhand provisioner",
    (config) => {
      config.FarmhandProvisioner = { Enable: true };
    },
    "portfolio_contaminated_farmhand_provisioner",
  ],
  [
    "Host automation",
    (config) => {
      config.HostAutomation = { Enable: true };
    },
    "portfolio_contaminated_host_automation",
  ],
  [
    "legacy fields",
    (config) => {
      config.PlayerId = "farmhand";
    },
    "portfolio_contaminated_legacy_farmhand_fields",
  ],
  [
    "wrong topology",
    (config) => {
      config.Portfolio.Topology = "native_ai_farmhand_multiplayer";
    },
    "portfolio_topology_missing_or_invalid",
  ],
]) {
  test(`Portfolio prerequisite gate blocks ${name} contamination`, async (t) => {
    const context = await createContext(t);
    const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
    const config = cleanConfig(context.dataRoot);
    mutate(config);
    await writeConfig(configPath, config);
    const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
    assert.equal(result.state, "BLOCKED");
    assert.ok(result.reasons.includes(expectedReason));
  });
}

test("Portfolio prerequisite gate detects Farmhand evidence artifacts and duplicate bundles", async (t) => {
  const context = await createContext(t);
  await mkdir(context.dataRoot, { recursive: true });
  await writeFile(join(context.dataRoot, "stardew-farmhand-manifest.json"), "not-a-portfolio-artifact");
  await writeBundle(join(context.profileRoot, "GameBuddy"), "duplicate");
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_contaminated_farmhand_manifest"));
  assert.ok(result.reasons.includes("portfolio_duplicate_mod_bundle"));
});

test("Portfolio accepts either approved single Mod bundle layout", async (t) => {
  const context = await createContext(t);
  await rm(join(context.profileRoot, "Mods", "GameBuddy"), { recursive: true, force: true });
  await writeBundle(join(context.profileRoot, "GameBuddy"), "direct");
  const directConfig = cleanConfig(context.dataRoot);
  directConfig.Portfolio.Enable = true;
  directConfig.Portfolio.EnableObserveBridge = true;
  await writeConfig(join(context.profileRoot, "GameBuddy", "config.json"), directConfig);

  const bundle = await inspectPortfolioModBundle(context.profileRoot);
  assert.equal(bundle.state, "single_bundle");
  assert.equal(bundle.directory, join(context.profileRoot, "GameBuddy"));
  assert.deepEqual(bundle.files, ["GameBuddy.Stardew.dll", "manifest.json", "GameBuddy.Stardew.deps.json"]);

  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "PASS", JSON.stringify(result));
});

test("Portfolio prerequisite gate blocks disabled and merely present Farmhand fields", async (t) => {
  const context = await createContext(t);
  const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
  await writeConfig(configPath, { ...cleanConfig(context.dataRoot), FarmhandProvisioner: { Enable: false } });
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_contaminated_farmhand_provisioner"));
});

test("Portfolio prerequisite gate blocks data/profile root overlap", async (t) => {
  const context = await createContext(t);
  const result = await checkPortfolioPrerequisites({
    ...context,
    dataRoot: join(context.profileRoot, "evidence"),
    gamePath: context.gamePath,
  });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_data_root_profile_root_overlap"));
});

test("Portfolio prerequisite gate blocks mixed-case cross-topology artifacts", async (t) => {
  const context = await createContext(t);
  await mkdir(context.dataRoot, { recursive: true });
  await writeFile(join(context.dataRoot, "Preview-Receipt.json"), "cross-topology");
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_contaminated_cross_topology_artifact"));
});

test("Portfolio prerequisite gate accepts a disarmed bootstrap declaration", async (t) => {
  const context = await createContext(t);
  const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
  const config = cleanConfig(context.dataRoot);
  config.Portfolio.Bootstrap = { Enable: false, SaveName: `${SAVE_NAME}_Bootstrap`, PlayerName: "GameBuddy" };
  await writeConfig(configPath, config);
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "PASS", JSON.stringify(result));
});

test("Portfolio prerequisite gate blocks armed bootstrap in a P0a profile", async (t) => {
  const context = await createContext(t);
  const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
  const config = cleanConfig(context.dataRoot);
  config.Portfolio.Bootstrap = { Enable: true, SaveName: `${SAVE_NAME}_Bootstrap`, PlayerName: "GameBuddy" };
  await writeConfig(configPath, config);
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_bootstrap_must_be_disarmed_in_p0a"));
});

test("Portfolio prerequisite gate blocks unknown config fields and a premature bridge", async (t) => {
  const context = await createContext(t);
  const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
  await writeConfig(configPath, {
    ...cleanConfig(context.dataRoot),
    EnableLocalBridge: true,
    SneakyPreviewAlias: true,
  });
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_config_unknown_field"));
  assert.ok(result.reasons.includes("portfolio_bridge_must_remain_disabled_in_p0a"));
});

test("Portfolio prerequisite gate requires the observe bridge to stay topology-scoped", async (t) => {
  const context = await createContext(t);
  const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
  const config = cleanConfig(context.dataRoot);
  config.Portfolio.Enable = true;
  config.Portfolio.EnableObserveBridge = false;
  await writeConfig(configPath, config);
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_runtime_bridge_not_closed_or_scoped"));
});

test("Portfolio prerequisite gate reports missing local environment as BLOCKED", async (t) => {
  const context = await createContext(t);
  await rm(join(context.gamePath, "Stardew Valley.dll"));
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_game_file_missing:Stardew Valley.dll"));
});

test("Portfolio local readiness remains BLOCKED until P0b attestation exists", async (t) => {
  const context = await createContext(t);
  const result = await checkPortfolioPrerequisites({
    ...context,
    gamePath: context.gamePath,
    requireP0bAttestation: true,
  });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_p0b_start_manifest_inspection_required"));
  assert.ok(result.reasons.includes("portfolio_p0b_target_hash_attestation_required"));
});

test("Portfolio prerequisite gate blocks a profile config whose data root differs from the checked root", async (t) => {
  const context = await createContext(t);
  const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
  await writeConfig(configPath, { ...cleanConfig(join(context.root, "other-data-root")) });
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_config_data_root_mismatch"));
});

test("Portfolio profile transaction deploys one bundle and restores exact prior bytes", async (t) => {
  const context = await createContext(t);
  const configPath = join(context.profileRoot, "Mods", "GameBuddy", "config.json");
  const dllPath = join(context.profileRoot, "Mods", "GameBuddy", "GameBuddy.Stardew.dll");
  const beforeConfig = await readFile(configPath);
  const beforeDll = await readFile(dllPath);

  const prepared = await preparePortfolioProfile({ ...context, backupName: "p0a-isolation" });
  assert.equal(prepared.state, "prepared");
  const preparedInspection = await inspectPortfolioProfile(context);
  assert.equal(preparedInspection.transactionLock.state, "valid");
  assert.equal(preparedInspection.profile.state, "ready");
  const genericConfig = JSON.parse(await readFile(join(context.profileRoot, "GameBuddy", "config.json"), "utf8"));
  assert.equal(Object.hasOwn(genericConfig.Portfolio, "EnabledActions"), false);
  await assert.rejects(
    () => preparePortfolioProfile({ ...context, backupName: "second" }),
    /portfolio_transaction_locked/,
  );

  const restored = await restorePortfolioProfile({ ...context, backupName: "p0a-isolation" });
  assert.equal(restored.state, "restored");
  assert.deepEqual(await readFile(configPath), beforeConfig);
  assert.deepEqual(await readFile(dllPath), beforeDll);
  assert.equal((await inspectPortfolioProfile(context)).transactionLock.state, "absent");
});

test("Portfolio bundle preflight blocks unmanaged files rather than deleting them", async (t) => {
  const context = await createContext(t);
  await writeFile(join(context.profileRoot, "Mods", "GameBuddy", "future-content.json"), "preserve-me");
  const result = await checkPortfolioPrerequisites({ ...context, gamePath: context.gamePath });
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_mod_bundle_unmanaged_file"));
});

test("Portfolio transaction never steals an existing or invalid lock", async (t) => {
  const context = await createContext(t);
  const lock = join(context.dataRoot, ".stardew-portfolio-profile.lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "transaction.json"), "not-json");
  const result = await checkPortfolioPrerequisites(context);
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasons.includes("portfolio_transaction_invalid"));
  await assert.rejects(
    () => preparePortfolioProfile({ ...context, backupName: "takeover" }),
    /portfolio_transaction_invalid/,
  );
});

test("Portfolio P0b producer upgrade preserves a disarmed native-bootstrap scope and rejects active Farmhand fields", async (t) => {
  const context = await createContext(t);
  await rm(join(context.profileRoot, "Mods"), { recursive: true, force: true });
  const config = cleanConfig(context.dataRoot);
  config.Portfolio.Enable = true;
  config.Portfolio.EnableObserveBridge = true;
  config.Portfolio.SaveId = "445880081";
  config.Portfolio.WorldId = "8474196460473483841";
  config.Portfolio.LocalPlayerId = "8474196460473483841";
  // Target loader normalizes this bootstrap spelling to
  // GameBuddyPortfolioNative02 before comparing its physical slot prefix.
  config.Portfolio.Bootstrap = { Enable: false, SaveName: "GameBuddyPortfolio_Native02", PlayerName: "GameBuddy" };
  await writeBundle(join(context.profileRoot, "GameBuddy"), "native-bootstrap");
  await writeConfig(join(context.profileRoot, "GameBuddy", "config.json"), config);
  await mkdir(join(context.dataRoot, ".stardew-portfolio-profile.lock"), { recursive: true });
  await writeFile(
    join(context.dataRoot, ".stardew-portfolio-profile.lock", "transaction.json"),
    JSON.stringify({
      version: 1,
      topology: PORTFOLIO_TOPOLOGY,
      backupName: "native-bootstrap",
      ownerId: "owner",
      startedAtUnixMs: 1,
    }),
  );
  await mkdir(join(context.dataRoot, "backups", "native-bootstrap"), { recursive: true });
  await writeFile(
    join(context.dataRoot, "backups", "native-bootstrap", "manifest.json"),
    JSON.stringify({ version: 1, topology: PORTFOLIO_TOPOLOGY, entries: [] }),
  );

  const prepared = await preparePortfolioP0bLifecycleProducer({
    ...context,
    backupName: "native-bootstrap",
    logicalSaveName: "GameBuddyPortfolioNative02",
    observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
    timeoutSeconds: 180,
    startManifestPath: join(context.root, "start-manifest.json"),
    signingKeyEnvironmentVariableName: "GAMEBUDDY_P0B_KEY",
  });
  assert.equal(prepared.state, "p0b_lifecycle_producer_prepared");
  const written = JSON.parse(await readFile(join(context.profileRoot, "GameBuddy", "config.json"), "utf8"));
  assert.deepEqual(written.Portfolio.P0bLifecycleProducer, {
    Enable: true,
    LogicalSaveName: "GameBuddyPortfolioNative02",
    ObservedSaveSlot: "GameBuddyPortfolioNative02_445880081",
    TimeoutSeconds: 180,
    StartManifestPath: join(context.root, "start-manifest.json"),
    SigningKeyEnvironmentVariableName: "GAMEBUDDY_P0B_KEY",
  });
  assert.equal(written.Portfolio.BridgeToken, config.Portfolio.BridgeToken);
  assert.equal((await inspectPortfolioProfile(context)).transactionLock.state, "valid");

  written.HostAutomation = { Enable: true };
  await writeConfig(join(context.profileRoot, "GameBuddy", "config.json"), written);
  await assert.rejects(
    () =>
      preparePortfolioP0bLifecycleProducer({
        ...context,
        backupName: "native-bootstrap",
        logicalSaveName: "GameBuddyPortfolioNative02",
        observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
        startManifestPath: join(context.root, "start-manifest.json"),
        signingKeyEnvironmentVariableName: "GAMEBUDDY_P0B_KEY",
      }),
    /portfolio_bootstrap_config_cross_topology_contamination/,
  );

  delete written.HostAutomation;
  written.EnableLocalBridge = true;
  await writeConfig(join(context.profileRoot, "GameBuddy", "config.json"), written);
  await assert.rejects(
    () =>
      preparePortfolioP0bLifecycleProducer({
        ...context,
        backupName: "native-bootstrap",
        logicalSaveName: "GameBuddyPortfolioNative02",
        observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
        startManifestPath: join(context.root, "start-manifest.json"),
        signingKeyEnvironmentVariableName: "GAMEBUDDY_P0B_KEY",
      }),
    /portfolio_bootstrap_config_cross_topology_contamination/,
  );

  delete written.EnableLocalBridge;
  for (const key of ["SigningKey", "SigningKeyValue"]) {
    written.Portfolio[key] = "injected-secret";
    await writeConfig(join(context.profileRoot, "GameBuddy", "config.json"), written);
    await assert.rejects(
      () => preparePortfolioP0bLifecycleProducer({
        ...context,
        backupName: "native-bootstrap",
        logicalSaveName: "GameBuddyPortfolioNative02",
        observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
        startManifestPath: join(context.root, "start-manifest.json"),
        signingKeyEnvironmentVariableName: "GAMEBUDDY_P0B_KEY",
      }),
      /portfolio_bootstrap_config_cross_topology_contamination/,
    );
    delete written.Portfolio[key];
  }
});

test("Portfolio P0b producer seam rejects unsafe output paths, invalid environment names, and secret values", async (t) => {
  const context = await createContext(t);
  await rm(join(context.profileRoot, "Mods"), { recursive: true, force: true });
  const config = cleanConfig(context.dataRoot);
  config.Portfolio.Enable = true;
  config.Portfolio.EnableObserveBridge = true;
  config.Portfolio.SaveId = "445880081";
  config.Portfolio.WorldId = "8474196460473483841";
  config.Portfolio.LocalPlayerId = "8474196460473483841";
  config.Portfolio.Bootstrap = { Enable: false, SaveName: "GameBuddyPortfolio_Native02", PlayerName: "GameBuddy" };
  await writeBundle(join(context.profileRoot, "GameBuddy"), "native-bootstrap");
  await writeConfig(join(context.profileRoot, "GameBuddy", "config.json"), config);
  await mkdir(join(context.dataRoot, ".stardew-portfolio-profile.lock"), { recursive: true });
  await writeFile(
    join(context.dataRoot, ".stardew-portfolio-profile.lock", "transaction.json"),
    JSON.stringify({ version: 1, topology: PORTFOLIO_TOPOLOGY, backupName: "native-bootstrap", ownerId: "owner", startedAtUnixMs: 1 }),
  );
  await mkdir(join(context.dataRoot, "backups", "native-bootstrap"), { recursive: true });
  await writeFile(
    join(context.dataRoot, "backups", "native-bootstrap", "manifest.json"),
    JSON.stringify({ version: 1, topology: PORTFOLIO_TOPOLOGY, entries: [] }),
  );
  const base = {
    ...context,
    backupName: "native-bootstrap",
    logicalSaveName: "GameBuddyPortfolioNative02",
    observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
    timeoutSeconds: 180,
    startManifestPath: join(context.root, "start-manifest.json"),
    signingKeyEnvironmentVariableName: "GAMEBUDDY_P0B_KEY",
    saveRoot: join(context.root, "saves"),
  };
  await assert.rejects(
    () => preparePortfolioP0bLifecycleProducer({ ...base, startManifestPath: "relative-start-manifest.json" }),
    /portfolio_p0b_start_manifest_path_not_absolute/,
  );
  await assert.rejects(
    () => preparePortfolioP0bLifecycleProducer({ ...base, startManifestPath: join(context.profileRoot, "start.json") }),
    /portfolio_p0b_start_manifest_path_overlap/,
  );
  await assert.rejects(
    () => preparePortfolioP0bLifecycleProducer({ ...base, startManifestPath: join(base.saveRoot, "start.json") }),
    /portfolio_p0b_start_manifest_path_overlap/,
  );
  await assert.rejects(
    () => preparePortfolioP0bLifecycleProducer({ ...base, startManifestPath: join(context.root, "missing", "start.json") }),
    /portfolio_p0b_start_manifest_path_missing/,
  );
  await assert.rejects(
    () => preparePortfolioP0bLifecycleProducer({ ...base, signingKeyEnvironmentVariableName: "1NOT_VALID" }),
    /portfolio_p0b_signing_key_environment_name_invalid/,
  );
  await assert.rejects(
    () => preparePortfolioP0bLifecycleProducer({ ...base, signingKey: "super-secret-key-value" }),
    /portfolio_p0b_signing_key_forbidden/,
  );
  const configBytes = await readFile(join(context.profileRoot, "GameBuddy", "config.json"), "utf8");
  assert.doesNotMatch(configBytes, /super-secret-key-value/);
  assert.doesNotMatch(configBytes, /SigningKey(?:Value)?/);

  const reparseRoot = join(context.root, "reparse");
  await mkdir(reparseRoot, { recursive: true });
  try {
    await (await import("node:fs/promises")).symlink(context.root, join(reparseRoot, "link"), "junction");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return;
    throw error;
  }
  await assert.rejects(
    () =>
      preparePortfolioP0bLifecycleProducer({
        ...base,
        startManifestPath: join(reparseRoot, "link", "start.json"),
      }),
    /portfolio_p0b_start_manifest_path_reparse/,
  );
});

test("Portfolio existing-save transaction only arms an explicitly observed native scope", async (t) => {
  const context = await createContext(t);
  await rm(context.profileRoot, { recursive: true, force: true });
  const options = {
    ...context,
    backupName: "existing-save",
    pipeName: "gamebuddy-stardew-portfolio-existing-save",
    bridgeToken: "portfolio_existing_save_token_1234",
    saveId: "445880081",
    worldId: "8474196460473483841",
    localPlayerId: "8474196460473483841",
    companionId: "portfolio_companion",
    observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
    enabledActions: ["select_mine_elevator_floor"],
  };
  const prepared = await preparePortfolioExistingSaveProfile(options);
  assert.equal(prepared.state, "existing_save_profile_prepared");
  const written = JSON.parse(await readFile(join(context.profileRoot, "GameBuddy", "config.json"), "utf8"));
  assert.deepEqual(written.Portfolio, {
    Enable: true,
    Topology: PORTFOLIO_TOPOLOGY,
    EnableObserveBridge: true,
    PipeName: options.pipeName,
    BridgeToken: options.bridgeToken,
    SaveId: options.saveId,
    WorldId: options.worldId,
    LocalPlayerId: options.localPlayerId,
    CompanionId: options.companionId,
    DataRoot: context.dataRoot,
    ExpectedGameVersion: "1.6.15",
    ExpectedGameBuildNumber: 24356,
    EnabledActions: ["select_mine_elevator_floor"],
    Bootstrap: { Enable: false, SaveName: context.saveName, PlayerName: "GameBuddy" },
    InitialNativeLoad: { Enable: true, ObservedSaveSlot: options.observedSaveSlot },
  });
  await assert.rejects(
    () => preparePortfolioExistingSaveProfile({ ...options, backupName: "other" }),
    /portfolio_transaction_locked/,
  );
  const restored = await restorePortfolioProfile(options);
  assert.equal(restored.state, "restored");
  assert.equal((await inspectPortfolioProfile(context)).transactionLock.state, "absent");
});

test("Portfolio existing-save transaction rejects an observed slot without a decimal native ID suffix", async (t) => {
  const context = await createContext(t);
  await rm(context.profileRoot, { recursive: true, force: true });
  const base = {
    ...context,
    backupName: "existing-save-invalid-slot",
    pipeName: "gamebuddy-stardew-portfolio-existing-save",
    bridgeToken: "portfolio_existing_save_token_1234",
    saveId: "445880081",
    worldId: "8474196460473483841",
    localPlayerId: "8474196460473483841",
    companionId: "portfolio_companion",
    enabledActions: ["select_mine_elevator_floor"],
  };
  await assert.rejects(
    () => preparePortfolioExistingSaveProfile({ ...base, observedSaveSlot: "GameBuddyPortfolioNative02_not-a-number" }),
    /portfolio_existing_save_observed_slot_invalid/,
  );
});

test("Portfolio existing-save profile requires the closed non-sleep action allowlist", async (t) => {
  const context = await createContext(t);
  await rm(context.profileRoot, { recursive: true, force: true });
  const base = {
    ...context,
    backupName: "existing-save",
    pipeName: "gamebuddy-stardew-portfolio-existing-save",
    bridgeToken: "portfolio_existing_save_token_1234",
    saveId: "445880081",
    worldId: "8474196460473483841",
    localPlayerId: "8474196460473483841",
    companionId: "portfolio_companion",
    observedSaveSlot: "GameBuddyPortfolioNative02_445880081",
  };
  for (const enabledActions of [undefined, [], ["select_mine_elevator_floor", "select_mine_elevator_floor"], ["unknown"], ["sleep"], ["select_mine_elevator_floor", "sleep"], [42]]) {
    const options = { ...base, ...(enabledActions === undefined ? {} : { enabledActions }) };
    await assert.rejects(
      () => preparePortfolioExistingSaveProfile(options),
      /portfolio_existing_save_enabled_actions_invalid/,
    );
  }
  const generic = await inspectPortfolioProfile(context);
  assert.equal(generic.profile.config.state, "blocked");
  assert.ok(generic.profile.config.reasons.includes("portfolio_config_missing"));
});

test("Portfolio bootstrap transaction deploys only into an empty profile and commits only after native disarm", async (t) => {
  const context = await createContext(t);
  await rm(context.profileRoot, { recursive: true, force: true });
  const options = {
    ...context,
    backupName: "native-bootstrap",
    bridgeToken: "portfolio_bootstrap_token_1234",
    companionId: "portfolio_companion",
    playerName: "GameBuddy",
  };
  const prepared = await preparePortfolioBootstrapProfile(options);
  assert.equal(prepared.state, "bootstrap_prepared");
  const configPath = join(context.profileRoot, "GameBuddy", "config.json");
  const armed = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(armed.Portfolio.Bootstrap.Enable, true);
  assert.equal(armed.Portfolio.Enable, true);
  await assert.rejects(() => commitPortfolioBootstrapProfile(options), /portfolio_bootstrap_must_be_disarmed_in_p0a/);

  armed.Portfolio.Bootstrap.Enable = false;
  armed.Portfolio.SaveId = "123456";
  armed.Portfolio.WorldId = "123456";
  armed.Portfolio.LocalPlayerId = "123456";
  await writeConfig(configPath, armed);
  const committed = await commitPortfolioBootstrapProfile(options);
  assert.equal(committed.state, "bootstrap_committed");
  assert.equal((await inspectPortfolioProfile(context)).transactionLock.state, "absent");
});
