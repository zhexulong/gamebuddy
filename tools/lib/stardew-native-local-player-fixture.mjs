import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

const BUNDLE_FILES = Object.freeze(["GameBuddy.Stardew.dll", "manifest.json", "GameBuddy.Stardew.deps.json"]);
const LOCK_DIRECTORY = ".stardew-native-local-player-fixture.lock";

export async function prepareNativeLocalPlayerFixture(options) {
  const context = resolveContext(options);
  assertBackupName(options.backupName);
  assertObservedSaveSlot(options.saveName);
  const actions = fixtureActions(options.action);
  await assertSafeContext(context);
  if (await exists(join(context.root, options.backupName))) throw new Error(`fixture_backup_already_exists:${join(context.root, options.backupName)}`);
  await beginTransaction(context, options.backupName);
  const backup = join(context.root, options.backupName);
  let backupCreated = false;
  try {
    const original = await readJson(context.configPath);
    assertBridgeConfig(original);
    assertSourceTopologyIsolated(original);
    await mkdir(backup, { recursive: true });
    backupCreated = true;
    await backupManagedFiles(context, backup);
    const configured = configureNativeLocalPlayer(original, options.saveName, options.timeoutSeconds ?? 90, actions, options.binding);
    await writeJson(context.configPath, configured);
    await deployBundle(context);
    await verifyNativeLocalPlayerFixture({ ...options, ...context });
    return Object.freeze({ state: "prepared", backup, saveName: options.saveName, configPath: context.configPath, modsPath: context.modsPath });
  } catch (error) {
    await rollbackFailedPreparation(context, backup, options.backupName, backupCreated, error);
  }
}

export async function bootstrapNativeLocalPlayerFixture(options) {
  const context = resolveContext(options);
  await assertSafeContext(context);
  assertFixtureLogicalName(options.logicalSaveName);
  const actions = fixtureActions(options.action);
  if (await exists(join(context.root, options.backupName))) throw new Error(`fixture_backup_already_exists:${join(context.root, options.backupName)}`);
  await beginTransaction(context, options.backupName);
  const backup = join(context.root, options.backupName);
  let backupCreated = false;
  try {
    const original = await readJson(context.configPath);
    assertBridgeConfig(original);
    assertSourceTopologyIsolated(original);
    await mkdir(backup, { recursive: true });
    backupCreated = true;
    await backupManagedFiles(context, backup);
    await writeJson(context.configPath, configureNativeLocalPlayerBootstrap(original, options.logicalSaveName, options.timeoutSeconds ?? 90, actions));
    await deployBundle(context);
    return Object.freeze({ state: "bootstrap_prepared", backup, logicalSaveName: options.logicalSaveName, configPath: context.configPath, modsPath: context.modsPath });
  } catch (error) {
    await rollbackFailedPreparation(context, backup, options.backupName, backupCreated, error);
  }
}

export async function verifyNativeLocalPlayerFixture(options) {
  const context = resolveContext(options);
  await assertSafeContext(context);
  assertObservedSaveSlot(options.saveName);
  const actions = fixtureActions(options.action);
  const config = await readJson(context.configPath);
  const fixture = config.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.LogicalSaveName !== logicalNameForObservedSlot(options.saveName) || fixture.ObservedSaveSlot !== options.saveName || !Number.isInteger(fixture.TimeoutSeconds) || fixture.FixtureScenario !== fixtureScenario(actions)) throw new Error("native_local_fixture_config_invalid");
  if (config.Portfolio?.Enable === true || config.HostAutomation?.Enable === true || config.HostFarmhandProvisioning?.Enable === true || config.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated");
  if (config.ActionPolicyVersion !== 0 || JSON.stringify(config.EnabledActions) !== JSON.stringify(actions)) throw new Error("native_local_fixture_action_policy_invalid");
  assertBridgeConfig(config);
  for (const name of BUNDLE_FILES) if (!await exists(join(context.modRoot, name))) throw new Error(`native_local_fixture_bundle_missing:${name}`);
  return Object.freeze({ state: "verified", saveName: options.saveName, actions, topology: "native_local_player_fixture" });
}

export async function restoreNativeLocalPlayerFixture(options) {
  const context = resolveContext(options);
  await assertSafeContext(context);
  assertBackupName(options.backupName);
  await assertTransaction(context, options.backupName);
  const backup = join(context.root, options.backupName);
  const result = await restoreManagedFiles(context, backup, true);
  await endTransaction(context, options.backupName);
  return result;
}

function resolveContext(options) {
  if (!options.root || !isAbsolute(options.root) || !options.modsPath || !isAbsolute(options.modsPath) || !options.releaseDir || !isAbsolute(options.releaseDir)) throw new Error("native_local_fixture_absolute_paths_required");
  const modRoot = join(options.modsPath, "GameBuddy");
  return Object.freeze({ root: options.root, modsPath: options.modsPath, releaseDir: options.releaseDir, modRoot, configPath: join(modRoot, "config.json") });
}
async function assertSafeContext(context) {
  for (const path of [context.root, context.modsPath, context.releaseDir, context.modRoot]) await assertDirectoryNotLink(path);
  for (const name of ["config.json", ...BUNDLE_FILES]) {
    const path = join(context.modRoot, name);
    if (await exists(path)) await assertNotLink(path);
  }
}
async function assertDirectoryNotLink(path) {
  let metadata;
  try { metadata = await lstat(path); } catch (error) { if (error?.code === "ENOENT") throw new Error(`native_local_fixture_path_missing:${path}`); throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`native_local_fixture_unsafe_path:${path}`);
}
async function assertNotLink(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`native_local_fixture_unsafe_path:${path}`);
}
function fixtureObservedSlotMatch(value) { return typeof value === "string" ? /^(GameBuddyFixture[A-Za-z0-9]{0,64})_([0-9]{1,32})$/.exec(value) : null; }
function assertObservedSaveSlot(value) { if (!fixtureObservedSlotMatch(value)) throw new Error("invalid_fixture_observed_save_slot"); }
function assertFixtureLogicalName(value) { if (typeof value !== "string" || !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(value)) throw new Error("invalid_fixture_logical_save_name"); }
function logicalNameForObservedSlot(value) { const match = fixtureObservedSlotMatch(value); if (!match) throw new Error("invalid_fixture_observed_save_slot"); return match[1]; }
function assertBackupName(value) { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}-fixture-backup$/.test(value)) throw new Error("invalid_fixture_backup_name"); }
export function fixtureActions(action) {
  if (action === undefined || action === "move_to_tile") return ["move_to_tile"];
  if (action === "equip_tool") return ["equip_tool"];
  // Tree discovery is a read-only snapshot probe. inspect_self is intrinsic to
  // BridgeSession and must not be configured as an enabled fixture action.
  if (action === "tree_discovery") return [];
  if (action === "travel") return ["move_to_tile", "travel"];
  // The fixture supplies one intact target-version ResourceClump and a basic
  // Pickaxe before attachment. Travel/movement/equipment and each hit remain
  // independently typed production actions.
  if (action === "clear_debris") return ["move_to_tile", "travel", "equip_tool", "clear_debris"];
  if (action === "enter_exit") return ["move_to_tile", "enter_exit"];
  if (action === "till_soil") return ["move_to_tile", "travel", "equip_tool", "till_soil"];
  if (action === "water_crop") return ["move_to_tile", "travel", "equip_tool", "water_crop"];
  // plant_seed selects its published seed slot inside the typed production
  // action; equip_tool cannot equip an Object seed, so it is not a prerequisite.
  if (action === "plant_seed") return ["move_to_tile", "travel", "plant_seed"];
  // Fertilizing uses its published inventory slot directly; navigation is its
  // only separately receipted prerequisite in this native-local slice.
  if (action === "fertilize_tile") return ["move_to_tile", "travel", "fertilize_tile"];
  // Harvest likewise has no tool-selection prerequisite: ordinary Grab crops
  // are harvested by the typed production action after navigation.
  if (action === "harvest_crop") return ["move_to_tile", "travel", "harvest_crop"];
  if (action === "pickup_forage") return ["move_to_tile", "travel", "pickup_forage"];
  if (action === "pickup_item") return ["move_to_tile", "travel", "pickup_item"];
  if (action === "machine_inspect") return ["move_to_tile", "machine_inspect"];
  // Fixture establishes an idle native Keg and exactly five owned Coffee
  // Beans. The production bridge alone enters GameLocation.checkAction,
  // consuming the item and starting the native machine lifecycle.
  if (action === "machine_load") return ["machine_load"];
  // The fixture prepares the exact pre-processed Coffee lifecycle only. The
  // production bridge waits for genuine native time passage then performs the
  // normal collection interaction; no timer or held-output mutation occurs.
  if (action === "machine_collect_output") return ["machine_load", "machine_collect_output"];
  // The fixture establishes one preserved-story NPC plus a persisted
  // relationship fact as pre-attachment starting state. Movement/travel and
  // the typed read-only inspection remain production-owned.
  if (action === "npc_relationship") return ["move_to_tile", "travel", "npc_relationship"];
  // The fixture establishes one unpetted Pet as a starting state. Production
  // alone invokes Pet.checkAction, records today's interaction, applies
  // friendship, and emits its terminal receipt.
  if (action === "pet_animal") return ["pet_animal"];
  if (action === "use_item") return ["use_item"];
  if (action === "place_wood_fence") return ["move_to_tile", "travel", "place_wood_fence"];
  // The fixture supplies one untouched Crab Pot and warps only to a freshly
  // validated water target's unique cardinal standing tile. Placement remains
  // exclusively a future typed production action.
  if (action === "place_crab_pot") return ["move_to_tile", "travel", "place_crab_pot"];
  if (action === "tree_first_hit") return ["move_to_tile", "travel", "equip_tool", "tree_first_hit"];
  if (action === "chop_tree_source") return ["move_to_tile", "travel", "equip_tool", "chop_tree_source"];
  if (action === "break_rock_source") return ["move_to_tile", "travel", "equip_tool", "break_rock_source"];
  if (action === "clear_hoedirt") return ["move_to_tile", "travel", "equip_tool", "clear_hoedirt"];
  if (action === "dig_artifact_spot") return ["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"];
  if (action === "refill_watering_can") return ["move_to_tile", "equip_tool", "refill_watering_can"];
  // Native AnimalHouse entry uses separately receipted typed travel,
  // movement, and enter_exit routes. The product fixture instead completes
  // its pre-attachment native warp so the fresh production snapshot can
  // discover the ready animal and compatible supplied tool in range.
  if (action === "feed_animal") return ["move_to_tile", "travel", "enter_exit", "feed_animal"];
  if (action === "collect_animal_product") return ["collect_animal_product"];
  throw new Error("invalid_native_local_fixture_action");
}
export function fixtureScenario(actions) {
  if (actions.includes("till_soil")) return "native_till_soil_v1";
  if (actions.includes("water_crop")) return "native_water_crop_v1";
  if (actions.includes("plant_seed")) return "native_plant_seed_v1";
  if (actions.includes("fertilize_tile")) return "native_fertilize_tile_v1";
  if (actions.includes("harvest_crop")) return "native_harvest_crop_v1";
  if (actions.includes("pickup_forage")) return "native_pickup_forage_v1";
  if (actions.includes("pickup_item")) return "native_pickup_item_v1";
  if (actions.includes("machine_inspect")) return "native_machine_inspect_v1";
  // A collect proof must begin with production-owned native loading, then
  // wait for actual target-game clock processing before collection.
  if (actions.includes("machine_collect_output")) return "native_machine_coffee_load_v1";
  if (actions.includes("machine_load")) return "native_machine_coffee_load_v1";
  if (actions.includes("npc_relationship")) return "native_npc_relationship_v1";
  if (actions.includes("pet_animal")) return "native_pet_animal_v1";
  if (actions.includes("use_item")) return "native_use_item_v1";
  if (actions.includes("place_wood_fence")) return "native_place_wood_fence_v1";
  if (actions.includes("place_crab_pot")) return "native_place_crab_pot_v1";
  if (actions.includes("tree_first_hit")) return "native_tree_first_hit_v1";
  if (actions.includes("chop_tree_source")) return "native_chop_tree_source_v1";
  if (actions.includes("break_rock_source")) return "native_break_rock_source_v1";
  if (actions.includes("clear_hoedirt")) return "native_clear_hoedirt_v1";
  if (actions.includes("dig_artifact_spot")) return "native_dig_artifact_spot_v1";
  if (actions.includes("clear_debris")) return "native_clear_debris_resource_clump_v1";
  if (actions.includes("refill_watering_can")) return "native_refill_watering_can_v1";
  if (actions.includes("feed_animal")) return "native_feed_animal_v1";
  if (actions.includes("collect_animal_product")) return "native_collect_animal_product_v1";
  return "";
}
function assertNativeLocalBinding(binding, observedSaveSlot) {
  if (!binding || typeof binding !== "object" || binding.version !== 1 || binding.observedSaveSlot !== observedSaveSlot || binding.logicalSaveName !== logicalNameForObservedSlot(observedSaveSlot)) throw new Error("native_local_fixture_binding_invalid");
  const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (![binding.saveId, binding.worldId, binding.playerId, binding.companionId].every(opaque)) throw new Error("native_local_fixture_binding_invalid");
}
function assertBridgeConfig(config) {
  const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (config?.EnableLocalBridge !== true
    || !opaque(config.PipeName)
    || typeof config.BridgeToken !== "string" || config.BridgeToken.length < 16 || config.BridgeToken.length > 256
    || ![config.SaveId, config.WorldId, config.PlayerId, config.CompanionId].every(opaque)) throw new Error("native_local_fixture_bridge_config_invalid");
}
function assertSourceTopologyIsolated(config) {
  if (config.Portfolio?.Enable === true || config.HostAutomation?.Enable === true || config.HostFarmhandProvisioning?.Enable === true || config.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated");
}
function configureNativeLocalPlayerBootstrap(config, logicalSaveName, timeoutSeconds, actions) {
  assertFixtureLogicalName(logicalSaveName);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300) throw new Error("invalid_native_local_fixture_timeout");
  const result = structuredClone(config);
  result.NativeLocalPlayerFixture = {
    Enable: true,
    LogicalSaveName: logicalSaveName,
    // Bootstrap validates only the logical name at title screen. This inert
    // syntactic placeholder is replaced with the observed native slot after
    // SaveLoaded; no bridge is opened while Bootstrap.Enable is true.
    ObservedSaveSlot: `${logicalSaveName}_0`,
    TimeoutSeconds: timeoutSeconds,
    FixtureScenario: fixtureScenario(actions),
    Bootstrap: { Enable: true, SaveName: logicalSaveName, PlayerName: "GameBuddy" }
  };
  result.Portfolio = { ...(result.Portfolio ?? {}), Enable: false };
  result.HostAutomation = { ...(result.HostAutomation ?? {}), Enable: false };
  result.HostFarmhandProvisioning = { ...(result.HostFarmhandProvisioning ?? {}), Enable: false };
  result.FarmhandProvisioner = { ...(result.FarmhandProvisioner ?? {}), Enable: false };
  result.ActionPolicyVersion = 0;
  result.DeniedActions = [];
  result.DeniedActionFamilies = [];
  result.ExperimentalActions = actions.filter((action) => ["clear_debris", "npc_relationship", "pet_animal"].includes(action));
  result.EnabledActions = actions;
  return result;
}
function configureNativeLocalPlayer(config, observedSaveSlot, timeoutSeconds, actions, binding) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300) throw new Error("invalid_native_local_fixture_timeout");
  assertNativeLocalBinding(binding, observedSaveSlot);
  const result = structuredClone(config);
  result.SaveId = binding.saveId;
  result.WorldId = binding.worldId;
  result.PlayerId = binding.playerId;
  result.CompanionId = binding.companionId;
  result.NativeLocalPlayerFixture = {
    Enable: true,
    LogicalSaveName: logicalNameForObservedSlot(observedSaveSlot),
    ObservedSaveSlot: observedSaveSlot,
    TimeoutSeconds: timeoutSeconds,
    FixtureScenario: fixtureScenario(actions)
  };
  result.Portfolio = { ...(result.Portfolio ?? {}), Enable: false };
  result.HostAutomation = { ...(result.HostAutomation ?? {}), Enable: false };
  result.HostFarmhandProvisioning = { ...(result.HostFarmhandProvisioning ?? {}), Enable: false };
  result.FarmhandProvisioner = { ...(result.FarmhandProvisioner ?? {}), Enable: false };
  result.ActionPolicyVersion = 0;
  result.DeniedActions = [];
  result.DeniedActionFamilies = [];
  result.ExperimentalActions = actions.filter((action) => ["clear_debris", "npc_relationship", "pet_animal"].includes(action));
  result.EnabledActions = actions;
  return result;
}
async function rollbackFailedPreparation(context, backup, backupName, backupCreated, originalError) {
  const manifestPath = join(backup, "manifest.json");
  // A manifest means every managed source byte was registered before mutation.
  // If its restoration fails, preserve both the backup and owning lock for
  // explicit recovery rather than deleting the only recovery material.
  if (backupCreated && await exists(manifestPath)) {
    try {
      await restoreManagedFiles(context, backup, false);
    } catch (restoreError) {
      throw new Error("native_local_fixture_recovery_required", { cause: restoreError });
    }
    await rm(backup, { recursive: true, force: false });
    await endTransaction(context, backupName);
    throw originalError;
  }

  // Before a manifest exists no configuration or managed bundle mutation has
  // occurred. Remove only this invocation's incomplete backup and lock.
  if (backupCreated) await rm(backup, { recursive: true, force: false });
  await endTransaction(context, backupName);
  throw originalError;
}

async function backupManagedFiles(context, backup) {
  const entries = [];
  for (const name of ["config.json", ...BUNDLE_FILES]) {
    const source = join(context.modRoot, name);
    const existed = await exists(source);
    const backupFile = `${name}.backup`;
    const bytes = existed ? await readFile(source) : null;
    if (bytes) await writeFile(join(backup, backupFile), bytes);
    entries.push({ name, existed, backupFile, sha256: bytes ? digest(bytes) : null });
  }
  await writeJson(join(backup, "manifest.json"), { version: 1, entries });
}
async function restoreManagedFiles(context, backup, removeBackup) {
  const manifest = await readJson(join(backup, "manifest.json"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length !== 4) throw new Error("invalid_fixture_backup_manifest");
  const expectedNames = ["config.json", ...BUNDLE_FILES];
  if (new Set(manifest.entries.map((entry) => entry?.name)).size !== expectedNames.length) throw new Error("invalid_fixture_backup_manifest");
  for (const entry of manifest.entries) {
    if (!expectedNames.includes(entry.name) || typeof entry.existed !== "boolean" || entry.backupFile !== `${entry.name}.backup`) throw new Error("invalid_fixture_backup_entry");
    const target = join(context.modRoot, entry.name);
    if (!entry.existed) { await rm(target, { force: true }); continue; }
    const bytes = await readFile(join(backup, entry.backupFile));
    if (digest(bytes) !== entry.sha256) throw new Error(`fixture_backup_hash_mismatch:${entry.name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  if (removeBackup) await rm(backup, { recursive: true, force: true });
  return Object.freeze({ state: "restored", backup, backupRemoved: removeBackup });
}
async function deployBundle(context) {
  await mkdir(context.modRoot, { recursive: true });
  for (const name of BUNDLE_FILES) {
    const source = join(context.releaseDir, name);
    if (!await exists(source)) throw new Error(`release_bundle_missing:${source}`);
    const sourceBytes = await readFile(source);
    await cp(source, join(context.modRoot, name));
    const deployedBytes = await readFile(join(context.modRoot, name));
    if (digest(sourceBytes) !== digest(deployedBytes)) throw new Error(`native_local_fixture_bundle_deploy_hash_mismatch:${name}`);
  }
}
function lockPath(context) { return join(context.root, LOCK_DIRECTORY); }
async function beginTransaction(context, backupName) {
  const path = lockPath(context);
  await mkdir(context.root, { recursive: true });
  try { await mkdir(path); } catch (error) { if (error?.code === "EEXIST") throw new Error("native_local_fixture_transaction_locked"); throw error; }
  await writeJson(join(path, "transaction.json"), { version: 1, backupName, ownerId: randomUUID(), startedAtUnixMs: Date.now() });
}
async function assertTransaction(context, backupName) {
  const owner = await readJson(join(lockPath(context), "transaction.json"));
  if (owner?.version !== 1 || owner.backupName !== backupName || typeof owner.ownerId !== "string") throw new Error("native_local_fixture_transaction_owner_mismatch");
}
async function endTransaction(context, backupName) { await assertTransaction(context, backupName); await rm(lockPath(context), { recursive: true, force: false }); }
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
