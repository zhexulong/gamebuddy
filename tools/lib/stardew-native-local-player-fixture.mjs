import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);
const LOCK_DIRECTORY = ".stardew-native-local-player-fixture.lock";
const PUBLIC_ERROR_CODES = new Set([
  "invalid_fixture_backup_entry",
  "invalid_fixture_backup_manifest",
  "invalid_fixture_backup_name",
  "invalid_fixture_logical_save_name",
  "invalid_fixture_observed_save_slot",
  "invalid_native_local_fixture_action",
  "invalid_native_local_fixture_timeout",
  "native_local_fixture_absolute_paths_required",
  "native_local_fixture_action_policy_invalid",
  "native_local_fixture_backup_already_exists",
  "native_local_fixture_binding_invalid",
  "native_local_fixture_bridge_config_invalid",
  "native_local_fixture_config_invalid",
  "native_local_fixture_path_missing",
  "native_local_fixture_preparation_failed",
  "native_local_fixture_recovery_required",
  "native_local_fixture_restore_failed",
  "native_local_fixture_save_root_required",
  "native_local_fixture_template_invalid",
  "native_local_fixture_topology_not_isolated",
  "native_local_fixture_transaction_locked",
  "native_local_fixture_transaction_owner_mismatch",
  "native_local_fixture_unsafe_path",
  "native_local_fixture_validation_failed",
  "native_local_fixture_working_save_exists",
]);

function redactPublicFailure(error, fallbackCode) {
  const code = error instanceof Error && PUBLIC_ERROR_CODES.has(error.message) ? error.message : fallbackCode;
  return new Error(code);
}

export async function validateNativeLocalPlayerFixturePreparation(options) {
  try {
    return await validateNativeLocalPlayerFixturePreparationInternal(options);
  } catch (error) {
    throw redactPublicFailure(error, "native_local_fixture_validation_failed");
  }
}

async function validateNativeLocalPlayerFixturePreparationInternal(options) {
  const context = resolveContext(options);
  assertBackupName(options.backupName);
  assertObservedSaveSlot(options.saveName);
  const actions = fixtureActions(options.action);
  await assertSafeContext(context);
  if (await exists(join(context.root, options.backupName))) throw new Error("native_local_fixture_backup_already_exists");
  if (await exists(lockPath(context))) throw new Error("native_local_fixture_transaction_locked");
  const original = await readJson(context.configPath);
  assertBridgeConfig(original);
  assertSourceTopologyIsolated(original);
  assertNativeLocalBinding(options.binding, options.saveName);
  const timeoutSeconds = options.timeoutSeconds ?? 90;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300)
    throw new Error("invalid_native_local_fixture_timeout");
  if (!options.stardewSaveRoot || !isAbsolute(options.stardewSaveRoot))
    throw new Error("native_local_fixture_save_root_required");
  const template = join(context.root, "templates", options.saveName);
  await assertDirectoryNotLink(template);
  for (const name of [options.saveName, "SaveGameInfo"]) {
    const source = join(template, name);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("native_local_fixture_template_invalid");
  }
  if (await exists(join(options.stardewSaveRoot, options.saveName)))
    throw new Error("native_local_fixture_working_save_exists");
  return Object.freeze({
    state: "ready",
    saveName: options.saveName,
    actions: Object.freeze([...actions]),
    timeoutSeconds,
    workingSaveAbsent: true,
  });
}

export async function prepareNativeLocalPlayerFixture(options) {
  try {
    return await prepareNativeLocalPlayerFixtureInternal(options);
  } catch (error) {
    throw redactPublicFailure(error, "native_local_fixture_preparation_failed");
  }
}

async function prepareNativeLocalPlayerFixtureInternal(options) {
  const context = resolveContext(options);
  assertBackupName(options.backupName);
  assertObservedSaveSlot(options.saveName);
  const actions = fixtureActions(options.action);
  await assertSafeContext(context);
  if (await exists(join(context.root, options.backupName)))
    throw new Error("native_local_fixture_backup_already_exists");
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
    await backupBodyProgramJournal(options, backup);
    const configured = configureNativeLocalPlayer(
      original,
      options.saveName,
      options.timeoutSeconds ?? 90,
      actions,
      options.binding,
    );
    await writeJson(context.configPath, configured);
    await deployBundle(context);
    await verifyNativeLocalPlayerFixture({ ...options, ...context });
    return Object.freeze({
      state: "prepared",
      backup,
      saveName: options.saveName,
      configPath: context.configPath,
      modsPath: context.modsPath,
    });
  } catch {
    await rollbackFailedPreparation(
      context,
      backup,
      options.backupName,
      backupCreated,
      new Error("native_local_fixture_preparation_failed"),
    );
  }
}

export async function bootstrapNativeLocalPlayerFixture(options) {
  try {
    return await bootstrapNativeLocalPlayerFixtureInternal(options);
  } catch (error) {
    throw redactPublicFailure(error, "native_local_fixture_preparation_failed");
  }
}

async function bootstrapNativeLocalPlayerFixtureInternal(options) {
  const context = resolveContext(options);
  await assertSafeContext(context);
  assertFixtureLogicalName(options.logicalSaveName);
  const actions = fixtureActions(options.action);
  if (await exists(join(context.root, options.backupName)))
    throw new Error("native_local_fixture_backup_already_exists");
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
    await backupBodyProgramJournal(options, backup);
    await writeJson(
      context.configPath,
      configureNativeLocalPlayerBootstrap(original, options.logicalSaveName, options.timeoutSeconds ?? 90, actions),
    );
    await deployBundle(context);
    return Object.freeze({
      state: "bootstrap_prepared",
      backup,
      logicalSaveName: options.logicalSaveName,
      configPath: context.configPath,
      modsPath: context.modsPath,
    });
  } catch {
    await rollbackFailedPreparation(
      context,
      backup,
      options.backupName,
      backupCreated,
      new Error("native_local_fixture_preparation_failed"),
    );
  }
}

export async function verifyNativeLocalPlayerFixture(options) {
  const context = resolveContext(options);
  await assertSafeContext(context);
  assertObservedSaveSlot(options.saveName);
  const actions = fixtureActions(options.action);
  const config = await readJson(context.configPath);
  const fixture = config.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.LogicalSaveName !== logicalNameForObservedSlot(options.saveName) ||
    fixture.ObservedSaveSlot !== options.saveName ||
    !Number.isInteger(fixture.TimeoutSeconds) ||
    fixture.FixtureScenario !== fixtureScenario(actions)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (config.ActionPolicyVersion !== 0 || JSON.stringify(config.EnabledActions) !== JSON.stringify(actions))
    throw new Error("native_local_fixture_action_policy_invalid");
  assertBridgeConfig(config);
  for (const name of BUNDLE_FILES)
    if (!(await exists(join(context.modRoot, name)))) throw new Error(`native_local_fixture_bundle_missing:${name}`);
  return Object.freeze({
    state: "verified",
    saveName: options.saveName,
    actions,
    topology: "native_local_player_fixture",
  });
}

export async function restoreNativeLocalPlayerFixture(options) {
  try {
    return await restoreNativeLocalPlayerFixtureInternal(options);
  } catch (error) {
    throw redactPublicFailure(error, "native_local_fixture_restore_failed");
  }
}

async function restoreNativeLocalPlayerFixtureInternal(options) {
  const context = resolveContext(options);
  await assertSafeContext(context);
  assertBackupName(options.backupName);
  await assertTransaction(context, options.backupName);
  const backup = join(context.root, options.backupName);
  // The Mod-owned Body Program journal is a second durable authority the run
  // mutates, so it is restored in the same step. Without this the next run of
  // the same fixture can start from a stale RecoveryRequired journal and fail
  // closed for reasons the prompt and the world cannot explain.
  await restoreBodyProgramJournal(backup);
  const result = await restoreManagedFiles(context, backup, true);
  await endTransaction(context, options.backupName);
  return result;
}

function resolveContext(options) {
  if (
    !options.root ||
    !isAbsolute(options.root) ||
    !options.modsPath ||
    !isAbsolute(options.modsPath) ||
    !options.releaseDir ||
    !isAbsolute(options.releaseDir)
  )
    throw new Error("native_local_fixture_absolute_paths_required");
  const modRoot = join(options.modsPath, "GameBuddy.Stardew");
  return Object.freeze({
    root: options.root,
    modsPath: options.modsPath,
    releaseDir: options.releaseDir,
    modRoot,
    configPath: join(modRoot, "config.json"),
  });
}
async function assertSafeContext(context) {
  for (const path of [context.root, context.modsPath, context.releaseDir, context.modRoot])
    await assertDirectoryNotLink(path);
  for (const name of ["config.json", ...BUNDLE_FILES]) {
    const path = join(context.modRoot, name);
    if (await exists(path)) await assertNotLink(path);
  }
}
async function assertDirectoryNotLink(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("native_local_fixture_path_missing");
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("native_local_fixture_unsafe_path");
}
async function assertNotLink(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error("native_local_fixture_unsafe_path");
}
function fixtureObservedSlotMatch(value) {
  return typeof value === "string" ? /^(GameBuddyFixture[A-Za-z0-9]{0,64})_([0-9]{1,32})$/.exec(value) : null;
}
function assertObservedSaveSlot(value) {
  if (!fixtureObservedSlotMatch(value)) throw new Error("invalid_fixture_observed_save_slot");
}
function assertFixtureLogicalName(value) {
  if (typeof value !== "string" || !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(value))
    throw new Error("invalid_fixture_logical_save_name");
}
function logicalNameForObservedSlot(value) {
  const match = fixtureObservedSlotMatch(value);
  if (!match) throw new Error("invalid_fixture_observed_save_slot");
  return match[1];
}
function assertBackupName(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}-fixture-backup$/.test(value))
    throw new Error("invalid_fixture_backup_name");
}
export function fixtureActions(action) {
  if (action === undefined || action === "move_to_tile") return ["move_to_tile"];
  if (action === "navigation_mutation")
    return ["inspect_world_map", "find_destination", "navigate_to_destination"];
  if (action === "equip_tool") return ["equip_tool"];
  if (action === "travel") return ["move_to_tile", "travel"];
  // The fixture supplies one intact target-version ResourceClump and a basic
  // Pickaxe before attachment. Travel/movement/equipment and each hit remain
  // independently typed production actions.
  if (action === "clear_debris") return ["move_to_tile", "travel", "equip_tool", "clear_debris"];
  if (action === "enter_exit") return ["move_to_tile", "enter_exit"];
  if (action === "till_soil") return ["move_to_tile", "travel", "equip_tool", "till_soil"];
  // Lane G tool-recovery chain: the same till_soil fixture (Hoe in inventory,
  // default non-Hoe current tool) drives breakpoint rejected -> equip recovery
  // -> retry succeeded within one native-local session.
  if (action === "tool_recovery_chain")
    return ["move_to_tile", "travel", "equip_tool", "till_soil"];
  // Ladder 3: Jodi's Request — a real Spring-19 mail quest asking for a fresh
  // cauliflower. The fixture only supplies the player with a Hoe, a filled
  // Watering Can and cauliflower seeds; the Agent plans the whole farming
  // chain (till -> plant -> water) through the production actions.
  if (action === "crop_research")
    return ["move_to_tile", "travel", "equip_tool", "till_soil", "plant_seed", "water_crop", "observe_scene", "refill_watering_can"];
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
  // Ladder 4: Jodi's Request close-out. The fixture supplies one mature ordinary
  // cauliflower on the Farm plus a reachable Jodi; the Agent harvests the real
  // crop, walks to her and offers the harvested item. No tool prerequisite: an
  // ordinary Grab crop is harvested by the typed production action.
  if (action === "jodi_harvest_deliver")
    return ["move_to_tile", "travel", "harvest_crop", "interact_npc_with_item", "observe_scene"];
  // The pickup_forage smoke observes the scene to derive the exact forage
  // target (observe → sceneTarget → pickup), so the read-only observe_scene
  // capability must be published alongside the gathering action.
  if (action === "pickup_forage") return ["move_to_tile", "travel", "pickup_forage", "observe_scene"];
  if (action === "pickup_item") return ["move_to_tile", "travel", "pickup_item"];
  if (action === "machine_inspect") return ["move_to_tile", "machine_inspect"];
  // A→B Body Program: the fixture prepares one idle native Keg plus exactly
  // five owned Coffee Beans, and both the read-only machine_inspect node and
  // the machine_load node are enabled in one profile so the program verify /
  // submit path can run the whole RFC 6901-bound dependency in one world.
  if (action === "machine_a_to_b") return ["move_to_tile", "machine_inspect", "machine_load"];
  // Ladder 1: walk → look → do. The player starts inside FarmHouse; the
  // fixture places one idle Keg adjacent to the native FarmHouse→Farm door
  // landing so a real navigate_to_destination("Farm") walk leaves the actor
  // within one tile of the machine. find_destination/observe_scene stay
  // read-only for the agent's retrieval/observation; navigate, inspect and
  // load are the three actual mutation nodes.
  if (action === "machine_navigate_ab")
    return ["find_destination", "navigate_to_destination", "machine_inspect", "machine_load", "observe_scene"];
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
  // The fixture establishes one active native delivery quest plus one carried
  // target item as starting state. Production alone offers the item to the
  // villager through the native interaction and emits the receipt.
  if (action === "interact_npc_with_item") return ["move_to_tile", "travel", "interact_npc_with_item"];
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
  // A bait fixture creates a current-player-owned unbaited pot and exactly one
  // Bait pre-attachment; production alone performs the native interaction.
  if (action === "bait_crab_pot") return ["bait_crab_pot"];
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
  if (action === "chest_store") return ["chest_store"];
  if (action === "chest_retrieve") return ["chest_retrieve"];
  if (action === "chop_stump") return ["equip_tool", "chop_stump"];
  if (action === "plant_sapling") return ["plant_sapling"];
  if (action === "cut_weeds") return ["equip_tool", "cut_weeds"];
  if (action === "scythe_crop") return ["equip_tool", "scythe_crop"];
  // The fixture keeps the Farm's own native Shipping Bin building and adds one
  // shippable Object to the backpack; production alone calls Farm.shipItem.
  if (action === "ship_item") return ["ship_item"];
  // craft_item cooks nothing: the fixture grants a learned recipe and its
  // ingredients in the backpack; production alone runs the native transaction.
  if (action === "craft_item") return ["craft_item"];
  // cook_recipe stands the actor beside a native cooking station and grants a
  // learned cooking recipe with its ingredients; production alone cooks.
  if (action === "cook_recipe") return ["cook_recipe"];
  // The fixture grows crab pots, baits them and advances to a mature output;
  // production alone collects. The existing place/bait actions stay separate.
  if (action === "collect_crab_pot_output") return ["collect_crab_pot_output"];
  throw new Error("invalid_native_local_fixture_action");
}
export function fixtureScenario(actions) {
  // Ladder 1 walk→look→do must win over the plain navigation scenario: the
  // action set is exactly the three-node DAG plus read-only retrieval.
  if (actions.includes("navigate_to_destination") && actions.includes("machine_inspect") && actions.includes("machine_load"))
    return "native_machine_navigate_ab_v1";
  if (actions.includes("navigate_to_destination")) return "navigation_mutation_v1";
  if (actions.includes("till_soil") && actions.includes("plant_seed") && actions.includes("water_crop") && actions.includes("refill_watering_can"))
    return "native_crop_research_v1";
  // Ladder 4 wins over the plain harvest/interact scenarios: the action set is
  // exactly harvest→offer plus read-only retrieval, and the fixture must supply
  // both the mature crop and the reachable villager.
  if (actions.includes("harvest_crop") && actions.includes("interact_npc_with_item"))
    return "native_jodi_harvest_deliver_v1";
  if (actions.includes("till_soil")) return "native_till_soil_v1";
  if (actions.includes("water_crop")) return "native_water_crop_v1";
  if (actions.includes("plant_seed")) return "native_plant_seed_v1";
  if (actions.includes("fertilize_tile")) return "native_fertilize_tile_v1";
  if (actions.includes("harvest_crop")) return "native_harvest_crop_v1";
  if (actions.includes("pickup_forage")) return "native_pickup_forage_v1";
  if (actions.includes("pickup_item")) return "native_pickup_item_v1";
  if (actions.includes("machine_load")) return "native_machine_coffee_load_v1";
  if (actions.includes("machine_collect_output")) return "native_machine_coffee_load_v1";
  if (actions.includes("machine_inspect")) return "native_machine_inspect_v1";
  if (actions.includes("npc_relationship")) return "native_npc_relationship_v1";
  if (actions.includes("interact_npc_with_item")) return "native_interact_npc_with_item_v1";
  if (actions.includes("pet_animal")) return "native_pet_animal_v1";
  if (actions.includes("use_item")) return "native_use_item_v1";
  if (actions.includes("place_wood_fence")) return "native_place_wood_fence_v1";
  if (actions.includes("bait_crab_pot")) return "native_bait_crab_pot_v1";
  if (actions.includes("place_crab_pot")) return "native_place_crab_pot_v1";
  if (actions.includes("chop_tree_source")) return "native_chop_tree_source_v1";
  if (actions.includes("break_rock_source")) return "native_break_rock_source_v1";
  if (actions.includes("clear_hoedirt")) return "native_clear_hoedirt_v1";
  if (actions.includes("dig_artifact_spot")) return "native_dig_artifact_spot_v1";
  if (actions.includes("clear_debris")) return "native_clear_debris_resource_clump_v1";
  if (actions.includes("refill_watering_can")) return "native_refill_watering_can_v1";
  if (actions.includes("feed_animal")) return "native_feed_animal_v1";
  if (actions.includes("collect_animal_product")) return "native_collect_animal_product_v1";
  if (actions.includes("chest_store")) return "native_chest_store_v1";
  if (actions.includes("chest_retrieve")) return "native_chest_retrieve_v1";
  if (actions.includes("chop_stump")) return "native_chop_stump_v1";
  if (actions.includes("plant_sapling")) return "native_plant_sapling_v1";
  if (actions.includes("cut_weeds")) return "native_cut_weeds_v1";
  if (actions.includes("scythe_crop")) return "native_scythe_crop_v1";
  if (actions.includes("ship_item")) return "native_ship_item_v1";
  if (actions.includes("craft_item")) return "native_craft_item_v1";
  if (actions.includes("cook_recipe")) return "native_cook_recipe_v1";
  if (actions.includes("collect_crab_pot_output")) return "native_crab_pot_collect_v1";
  return "";
}
function assertNativeLocalBinding(binding, observedSaveSlot) {
  if (
    !binding ||
    typeof binding !== "object" ||
    binding.version !== 1 ||
    binding.observedSaveSlot !== observedSaveSlot ||
    binding.logicalSaveName !== logicalNameForObservedSlot(observedSaveSlot)
  )
    throw new Error("native_local_fixture_binding_invalid");
  const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (![binding.saveId, binding.worldId, binding.playerId, binding.companionId].every(opaque))
    throw new Error("native_local_fixture_binding_invalid");
}
function assertBridgeConfig(config) {
  const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (
    !opaque(config?.PipeName) ||
    typeof config.BridgeToken !== "string" ||
    config.BridgeToken.length < 16 ||
    config.BridgeToken.length > 256 ||
    ![config.SaveId, config.WorldId, config.PlayerId, config.CompanionId].every(opaque)
  )
    throw new Error("native_local_fixture_bridge_config_invalid");
}
function assertSourceTopologyIsolated(config) {
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
}
function configureNativeLocalPlayerBootstrap(config, logicalSaveName, timeoutSeconds, actions) {
  assertFixtureLogicalName(logicalSaveName);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300)
    throw new Error("invalid_native_local_fixture_timeout");
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
    Bootstrap: { Enable: true, SaveName: logicalSaveName, PlayerName: "GameBuddy" },
  };
  result.Portfolio = { ...(result.Portfolio ?? {}), Enable: false };
  result.HostAutomation = { ...(result.HostAutomation ?? {}), Enable: false };
  result.HostFarmhandProvisioning = { ...(result.HostFarmhandProvisioning ?? {}), Enable: false };
  result.FarmhandProvisioner = { ...(result.FarmhandProvisioner ?? {}), Enable: false };
  result.ActionPolicyVersion = 0;
  result.DeniedActions = [];
  result.DeniedActionFamilies = [];
  result.ExperimentalActions = actions.filter((action) =>
    ["clear_debris", "npc_relationship", "interact_npc_with_item", "pet_animal", "chest_store", "chest_retrieve", "chop_stump", "plant_sapling", "cut_weeds", "scythe_crop", "ship_item", "craft_item", "cook_recipe", "collect_crab_pot_output"].includes(action),
  );
  result.EnabledActions = actions;
  // Same single language configuration point as the live runner: the
  // frontend-set language preference flows into the Mod config, so the
  // Mod-side companion presentation locale stays aligned with the Agent
  // session locale.
  const companionLocale = process.env.GAMEBUDDY_COMPANION_LOCALE === "en-US" ? "en-US" : "zh-CN";
  result.PresentationLocale = companionLocale;
  return result;
}
function configureNativeLocalPlayer(config, observedSaveSlot, timeoutSeconds, actions, binding) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 300)
    throw new Error("invalid_native_local_fixture_timeout");
  assertNativeLocalBinding(binding, observedSaveSlot);
  const result = structuredClone(config);
  result.EnableLocalBridge = true;
  result.SaveId = binding.saveId;
  result.WorldId = binding.worldId;
  result.PlayerId = binding.playerId;
  result.CompanionId = binding.companionId;
  result.NativeLocalPlayerFixture = {
    Enable: true,
    LogicalSaveName: logicalNameForObservedSlot(observedSaveSlot),
    ObservedSaveSlot: observedSaveSlot,
    TimeoutSeconds: timeoutSeconds,
    FixtureScenario: fixtureScenario(actions),
  };
  result.Portfolio = { ...(result.Portfolio ?? {}), Enable: false };
  result.HostAutomation = { ...(result.HostAutomation ?? {}), Enable: false };
  result.HostFarmhandProvisioning = { ...(result.HostFarmhandProvisioning ?? {}), Enable: false };
  result.FarmhandProvisioner = { ...(result.FarmhandProvisioner ?? {}), Enable: false };
  result.ActionPolicyVersion = 0;
  result.DeniedActions = [];
  result.DeniedActionFamilies = [];
  result.ExperimentalActions = actions.filter((action) =>
    ["clear_debris", "npc_relationship", "interact_npc_with_item", "pet_animal", "chest_store", "chest_retrieve", "chop_stump", "plant_sapling", "cut_weeds", "scythe_crop", "ship_item", "craft_item", "cook_recipe", "collect_crab_pot_output"].includes(action),
  );
  result.EnabledActions = actions;
  // Same single language configuration point as the live runner: the
  // frontend-set language preference flows into the Mod config, so the
  // Mod-side companion presentation locale stays aligned with the Agent
  // session locale.
  const companionLocale = process.env.GAMEBUDDY_COMPANION_LOCALE === "en-US" ? "en-US" : "zh-CN";
  result.PresentationLocale = companionLocale;
  return result;
}
async function rollbackFailedPreparation(context, backup, backupName, backupCreated, publicError) {
  const manifestPath = join(backup, "manifest.json");
  // A manifest means every managed source byte was registered before mutation.
  // If its restoration fails, preserve both the backup and owning lock for
  // explicit recovery rather than deleting the only recovery material.
  if (backupCreated && (await exists(manifestPath))) {
    try {
      await restoreManagedFiles(context, backup, false);
    } catch {
      throw new Error("native_local_fixture_recovery_required");
    }
    await rm(backup, { recursive: true, force: false });
    await endTransaction(context, backupName);
    throw publicError;
  }

  // Before a manifest exists no configuration or managed bundle mutation has
  // occurred. Remove only this invocation's incomplete backup and lock.
  if (backupCreated) await rm(backup, { recursive: true, force: false });
  await endTransaction(context, backupName);
  throw publicError;
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

/**
 * The Mod-owned Body Program journal lives outside everything the Mod-file
 * backup covers: `<StardewSaveRoot>/BodyProgramJournal-v1/<integration>/<saveId>/
 * <worldId>/<playerId>/<companionId>/journal.json` (see
 * integrations/stardew/WindowsBodyProgramJournalStore.cs). It is a durable
 * authority keyed by the fixture binding's four opaque ids, so its scope is
 * byte-identical across runs of the same fixture.
 *
 * That makes it a reset gap rather than a durability feature: a run that leaves
 * a non-terminal or RecoveryRequired program behind makes the next run's
 * OpenStatus RecoveryRequired, the Mod then declines to compose the controller,
 * and the same submit_action_program call that succeeded before now fails closed
 * with body_program_journal_unavailable. Observed live: a 3033-byte journal from
 * 2026-09-22 still held state 5 (RecoveryRequired) while the working save had
 * already been restored to the template three days later.
 *
 * So the fixture transaction owns this subtree the same way it owns the Mod
 * files: backed up before preparation and restored on restore. When the caller
 * declares no save root or no binding - the offline source-assertion tests do
 * both - the journal is out of scope, and that is recorded explicitly rather
 * than silently skipped, so the distinction stays visible in the backup marker.
 */
function bodyProgramJournalScopeDirectory(options) {
  // A caller that declares no Stardew save root has no journal in scope: the
  // offline source-assertion tests prepare a fixture without one, and the live
  // runner always supplies it. Returning null means "not managed by this
  // transaction" rather than guessing a path.
  if (!options.stardewSaveRoot) return null;
  if (!isAbsolute(options.stardewSaveRoot)) throw new Error("native_local_fixture_save_root_required");
  const binding = options.binding;
  if (!binding || typeof binding !== "object") return null;
  const segments = [binding.saveId, binding.worldId, binding.playerId, binding.companionId];
  for (const segment of segments)
    if (typeof segment !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(segment))
      throw new Error("invalid_native_local_binding");
  return join(options.stardewSaveRoot, "BodyProgramJournal-v1", "stardew", ...segments);
}

async function backupBodyProgramJournal(options, backup) {
  // The bootstrap-phase prepare has no binding yet (the game has not created the
  // save whose ids scope the journal), and offline callers declare no save root.
  // Record that explicitly rather than guessing: `existed: null` with a null path
  // means "not scoped, not managed by this transaction", and restore leaves it
  // alone for that path.
  const scopeDirectory = bodyProgramJournalScopeDirectory(options);
  if (scopeDirectory === null) {
    await writeJson(join(backup, "body-program-journal.json"), { version: 1, path: null, existed: null });
    return { path: null, existed: null };
  }
  const scopeBackup = join(backup, "body-program-journal");
  const existed = await exists(scopeDirectory);
  if (existed) {
    await mkdir(dirname(scopeBackup), { recursive: true });
    await cp(scopeDirectory, scopeBackup, { recursive: true });
  }
  await writeJson(join(backup, "body-program-journal.json"), { version: 1, path: scopeDirectory, existed });
  return { path: scopeDirectory, existed };
}

async function restoreBodyProgramJournal(backup) {
  const scopeBackup = join(backup, "body-program-journal");
  const marker = await readJson(join(backup, "body-program-journal.json"));
  if (marker?.version !== 1) throw new Error("invalid_fixture_backup_manifest");
  const { path, existed } = marker;
  if (existed === null) {
    if (path !== null) throw new Error("invalid_fixture_backup_manifest");
    return marker;
  }
  if (typeof path !== "string" || typeof existed !== "boolean")
    throw new Error("invalid_fixture_backup_manifest");
  // Always clear the live scope first: a run that wrote a journal must not keep
  // it merely because the pre-run state had none.
  await rm(path, { recursive: true, force: true });
  if (existed) {
    if (!(await exists(scopeBackup))) throw new Error("invalid_fixture_backup_manifest");
    await mkdir(dirname(path), { recursive: true });
    await cp(scopeBackup, path, { recursive: true, force: true });
  }
  return marker;
}
async function restoreManagedFiles(context, backup, removeBackup) {
  const manifest = await readJson(join(backup, "manifest.json"));
  if (manifest?.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("invalid_fixture_backup_manifest");
  const expectedNames = ["config.json", ...BUNDLE_FILES];
  if (manifest.entries.length !== expectedNames.length) throw new Error("invalid_fixture_backup_manifest");
  if (new Set(manifest.entries.map((entry) => entry?.name)).size !== expectedNames.length)
    throw new Error("invalid_fixture_backup_manifest");
  for (const entry of manifest.entries) {
    if (
      !expectedNames.includes(entry.name) ||
      typeof entry.existed !== "boolean" ||
      entry.backupFile !== `${entry.name}.backup`
    )
      throw new Error("invalid_fixture_backup_entry");
    const target = join(context.modRoot, entry.name);
    if (!entry.existed) {
      await rm(target, { force: true });
      continue;
    }
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
    if (!(await exists(source))) throw new Error(`release_bundle_missing:${source}`);
    const sourceBytes = await readFile(source);
    await cp(source, join(context.modRoot, name));
    const deployedBytes = await readFile(join(context.modRoot, name));
    if (digest(sourceBytes) !== digest(deployedBytes))
      throw new Error(`native_local_fixture_bundle_deploy_hash_mismatch:${name}`);
  }
}
function lockPath(context) {
  return join(context.root, LOCK_DIRECTORY);
}
async function beginTransaction(context, backupName) {
  const path = lockPath(context);
  await mkdir(context.root, { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("native_local_fixture_transaction_locked");
    throw error;
  }
  await writeJson(join(path, "transaction.json"), {
    version: 1,
    backupName,
    ownerId: randomUUID(),
    startedAtUnixMs: Date.now(),
  });
}
async function assertTransaction(context, backupName) {
  const owner = await readJson(join(lockPath(context), "transaction.json"));
  if (owner?.version !== 1 || owner.backupName !== backupName || typeof owner.ownerId !== "string")
    throw new Error("native_local_fixture_transaction_owner_mismatch");
}
async function endTransaction(context, backupName) {
  await assertTransaction(context, backupName);
  await rm(lockPath(context), { recursive: true, force: false });
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
