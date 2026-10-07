import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { readExperimentalStardewActionIds } from "./stardew-published-action-registry.mjs";

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
  "release_bundle_missing",
  "release_bundle_mismatch",
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
  if (!(error instanceof Error)) return new Error(fallbackCode);
  // Some public codes carry a detail suffix (release_bundle_missing:<path>), so the
  // whitelist is matched on the code prefix. Without this, exactly the failures a
  // gate reader needs (a missing bundle file, a mismatched bundle entry) collapsed
  // into the blanket preparation_failed and were undiagnosable.
  const code = error.message.split(":", 1)[0];
  return new Error(PUBLIC_ERROR_CODES.has(code) ? error.message : fallbackCode);
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
      options.action,
      await readExperimentalActionIds(options),
    );
    // Opt-in evidence-only probe block. It is written only when the caller
    // supplies it, so ordinary action runs keep an unchanged config shape.
    if (options.sleepModalProbe !== undefined)
      configured.SleepModalProbe = options.sleepModalProbe;
    if (options.sleepLifecycle !== undefined)
      configured.SleepLifecycle = options.sleepLifecycle;
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
  } catch (error) {
    // Keep the underlying failure. The public entry point still redacts anything
    // outside PUBLIC_ERROR_CODES, but a whitelisted code (or a diagnostic caller)
    // can now see WHY preparation failed instead of a blanket code.
    await rollbackFailedPreparation(
      context,
      backup,
      options.backupName,
      backupCreated,
      error instanceof Error ? error : new Error("native_local_fixture_preparation_failed"),
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
      configureNativeLocalPlayerBootstrap(original, options.logicalSaveName, options.timeoutSeconds ?? 90, actions, options.action, await readExperimentalActionIds(options)),
    );
    await deployBundle(context);
    return Object.freeze({
      state: "bootstrap_prepared",
      backup,
      logicalSaveName: options.logicalSaveName,
      configPath: context.configPath,
      modsPath: context.modsPath,
    });
  } catch (error) {
    await rollbackFailedPreparation(
      context,
      backup,
      options.backupName,
      backupCreated,
      error instanceof Error ? error : new Error("native_local_fixture_preparation_failed"),
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
    fixture.FixtureScenario !== fixtureScenario(actions, options.action)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (
    !Array.isArray(config.DeniedActions) ||
    !Array.isArray(config.DeniedActionFamilies) ||
    !Array.isArray(config.ExperimentalActions)
  )
    throw new Error("native_local_fixture_action_policy_invalid");
  if (options.sleepModalProbe !== undefined) {
    const probe = config.SleepModalProbe;
    if (
      probe?.Enable !== true ||
      probe.Mode !== options.sleepModalProbe.Mode ||
      probe.EvidencePath !== options.sleepModalProbe.EvidencePath
    )
      throw new Error("native_local_fixture_config_invalid");
  }
  if (options.sleepLifecycle !== undefined) {
    const lifecycle = config.SleepLifecycle;
    if (lifecycle?.Enable !== true || lifecycle.EvidencePath !== options.sleepLifecycle.EvidencePath)
      throw new Error("native_local_fixture_config_invalid");
  }
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
  // The move-stall probe (design 5.3 observation) drives the published
  // move_to_tile action over a fixture that stands a native blocker on the
  // route. `pet_animal` is listed ONLY so the Pet projection is published and
  // the blocker's position is observable; the runner never invokes it. That is
  // why the npc scenario omits it: a parked Horse has no projection anyway.
  if (action === "move_stall_probe_pet") return ["move_to_tile", "pet_animal"];
  if (action === "move_stall_probe_npc") return ["move_to_tile"];
  // The M2 sleep-modal probe owns the actor's route itself (native pathfind to
  // the bed) and reads the game-owned modal; it needs no Host action surface.
  if (action === "sleep_modal_probe") return ["move_to_tile"];
  // The M2 cross-day lifecycle is now a real execution action: the Mod owns the
  // route, the native answer and the Saving/Saved/DayStarted observation, and the
  // Host dispatches advance_day exactly like any other action.
  if (action === "sleep_lifecycle") return ["move_to_tile", "advance_day"];
  // The pass-out variant establishes only a low-stamina live precondition and
  // lets the native gate (Game1.cs:6452) start the pass-out by itself.
  if (action === "sleep_pass_out_lifecycle") return ["move_to_tile"];
  if (action === "navigation_mutation")
    return ["inspect_world_map", "find_destination", "navigate_to_destination"];
  if (action === "equip_tool") return ["equip_tool"];
  if (action === "travel") return ["move_to_tile", "travel"];
  // ride_minecart is its own action, not a `travel` objective family: the wire
  // carries the station tile AND the published ride selector, which the exact-shape
  // argument admission cannot express as an optional key on `travel`. The fixture
  // only creates a station tile and the vanilla network unlock flag; production
  // alone discovers the objective, resolves it and performs the native ride.
  if (action === "ride_minecart") return ["move_to_tile", "ride_minecart"];
  // ride_bus needs no movement: the fixture already stands the actor beside the
  // ticket machine, so the whole contract is the ride itself.
  if (action === "ride_bus") return ["ride_bus"];
  // The fixture already puts the actor beside the shop owner inside trading hours, so
  // the whole contract is the purchase itself.
  if (action === "shop_purchase") return ["shop_purchase"];
  // The elevator fixture already leaves the actor on a mine floor that carries the
  // elevator tile, so the whole contract is the floor selection.
  if (action === "select_mine_elevator_floor") return ["select_mine_elevator_floor"];
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
  // Lane G resource-depletion recovery chain: the empty-can water_crop fixture
  // drives breakpoint rejected/watering_can_empty -> refill recovery -> retry
  // succeeded on the SAME crop target within one native-local session.
  if (action === "water_crop_resource_recovery_chain")
    return ["move_to_tile", "travel", "equip_tool", "water_crop", "refill_watering_can"];
  // Lane G container-full recovery chain: the full-backpack harvest fixture drives
  // breakpoint rejected/inventory_full -> chest_store recovery -> harvest retry
  // succeeded on the SAME crop target within one native-local session.
  if (action === "harvest_inventory_full_recovery_chain")
    return ["move_to_tile", "travel", "harvest_crop", "chest_store"];
  // Lane G low-stamina recovery chain: the fixture sets stamina low (above the native
  // pass-out floor) and the chain reads the drop from the first receipt, eats, then
  // tills a second tile. Low stamina is NOT a reasonCode, so this chain is
  // fact-triggered rather than rejection-triggered.
  if (action === "stamina_recovery_chain")
    return ["move_to_tile", "travel", "equip_tool", "till_soil", "use_item"];
  // Lane G partial-completion recovery chain: the Bait recipe turns one Bug Meat
  // into five Bait while the backpack already holds 998 Bait, so the native
  // transaction can only take one and must drop four. The chain reads the honest
  // `partially_succeeded/crafted_item_created` receipt, stores the retained stack so
  // the native debris homing can deliver the dropped remainder, then re-crafts the
  // SAME recipe to a full success. Not a new action; it grants no capability.
  if (action === "craft_partial_recovery_chain") return ["move_to_tile", "travel", "craft_item", "chest_store"];
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
  // express_emote / face_direction are pure embodied-actor actions: Farmer.doEmote
  // and Farmer.faceDirection need no world precondition, no inventory and no
  // other action first. They are exercised together because both are the
  // companion's body-language channel and neither mutates world state.
  if (action === "express_emote") return ["express_emote", "face_direction"];
  // Fertilizing uses its published inventory slot directly; navigation is its
  // only separately receipted prerequisite in this native-local slice.
  if (action === "fertilize_tile") return ["move_to_tile", "travel", "fertilize_tile"];
  // Harvest likewise has no tool-selection prerequisite: ordinary Grab crops
  // are harvested by the typed production action after navigation.
  if (action === "harvest_crop") return ["move_to_tile", "travel", "harvest_crop"];
  // Ladder 5: embodied-memory covenant probe (design §10.5 class 1). The
  // fixture supplies one mature strawberry crop on the Farm plus the native
  // Shipping Bin; the Agent harvests the real crop. It must HONOR the covenant
  // (no shipped strawberry), so ship_item is published and the runner's gate
  // watches for its misuse — the fixture never ships anything itself.
  if (action === "strawberry_covenant")
    return ["move_to_tile", "travel", "harvest_crop", "ship_item", "observe_scene"];
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
  // The approach harness (design 5.2) drives the SAME published action and the
  // same fixture tree; only the runner's geometry differs, so it reuses the
  // scenario rather than adding a fixture of its own.
  if (action === "chop_tree_approach") return ["move_to_tile", "travel", "equip_tool", "chop_tree_source"];
  if (action === "break_rock_source") return ["move_to_tile", "travel", "equip_tool", "break_rock_source"];
  if (action === "clear_hoedirt") return ["move_to_tile", "travel", "equip_tool", "clear_hoedirt"];
  if (action === "dig_artifact_spot") return ["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"];
  if (action === "refill_watering_can") return ["move_to_tile", "equip_tool", "refill_watering_can"];
  // The fixture supplies one charged Watering Can and a completed native Pet Bowl;
  // equipping and walking stay independently receipted production actions, matching
  // the water_crop lane.
  if (action === "water_pet_bowl") return ["move_to_tile", "travel", "equip_tool", "water_pet_bowl"];
  // Same shape as water_pet_bowl, but the trough only exists inside a Slime Hutch
  // interior, so the fixture first builds the hutch and then enters it; equipping
  // and walking stay independently receipted production actions.
  if (action === "water_slime_hutch_trough") return ["move_to_tile", "travel", "equip_tool", "water_slime_hutch_trough"];
  // Native AnimalHouse entry uses separately receipted typed travel,
  // movement, and enter_exit routes. The product fixture instead completes
  // its pre-attachment native warp so the fresh production snapshot can
  // discover the ready animal and compatible supplied tool in range.
  if (action === "feed_animal") return ["move_to_tile", "travel", "enter_exit", "feed_animal"];
  if (action === "collect_animal_product") return ["collect_animal_product"];
  if (action === "chest_store") return ["chest_store"];
  if (action === "chest_retrieve") return ["chest_retrieve"];
  // The built-in kitchen fridge is the same Chest store/take intent as a placed
  // chest; the fixture only upgrades the house to a kitchen, supplies the item,
  // and places the actor beside the fridge's map tile.
  if (action === "fridge_store") return ["chest_store"];
  if (action === "fridge_retrieve") return ["chest_retrieve"];
  // The island shipping bin is the same ship_item capability over IslandWest's
  // own bin position; the fixture only enables the island house upgrade and
  // places the actor beside the bin.
  if (action === "ship_item_island") return ["ship_item"];
  if (action === "chop_stump") return ["equip_tool", "chop_stump"];
  if (action === "plant_sapling") return ["plant_sapling"];
  if (action === "cut_weeds") return ["equip_tool", "cut_weeds"];
  if (action === "play_session") return ["move_to_tile", "travel", "enter_exit", "observe_scene", "cut_weeds", "cut_grass", "break_rock_source", "harvest_crop", "plant_seed", "water_crop", "ship_item"];
  if (action === "cut_grass") return ["equip_tool", "cut_grass"];
  // Loop-closure wave (2026-10-04): the 14 lane actions are Experimental until
  // each earns its live gate. Fixture shapes follow the same discipline as
  // their family peers: the fixture supplies only the native precondition and
  // production alone runs the typed action.
  // clear_cask needs an Axe/Pickaxe/Hoe: the runner equips the axe itself, so
  // the fixture publishes equip_tool alongside the target cask.
  if (action === "clear_cask") return ["equip_tool", "clear_cask"];
  // dress_mannequin / set_sign_display / deposit_silo_hay place the actor
  // beside the target object; slot and item come from the fixture, no equip.
  if (action === "dress_mannequin") return ["dress_mannequin"];
  if (action === "set_sign_display") return ["set_sign_display"];
  if (action === "deposit_silo_hay") return ["deposit_silo_hay"];
  if (action === "withdraw_silo_hay") return ["withdraw_silo_hay"];
  if (action === "toggle_animal_door") return ["toggle_animal_door"];
  if (action === "use_obelisk") return ["use_obelisk"];
  // toggle_tool_light runs the Lantern tool itself; the fixture supplies the
  // Lantern in the selected slot and the actor is already standing.
  if (action === "toggle_tool_light") return ["toggle_tool_light"];
  // Plants family: the runner discovers the adjacent target and performs the
  // native interaction; no tool or movement prerequisite.
  if (action === "harvest_bush") return ["harvest_bush"];
  if (action === "harvest_fruit_tree") return ["harvest_fruit_tree"];
  if (action === "shake_tree") return ["shake_tree"];
  if (action === "take_pedestal_item") return ["take_pedestal_item"];
  if (action === "toggle_fence_gate") return ["toggle_fence_gate"];
  // Movement family: the fixture warps the actor beside the water / horse /
  // mine entrance and production alone launches / mounts / enters.
  if (action === "use_raft") return ["use_raft"];
  if (action === "mount_transport") return ["mount_transport"];
  if (action === "enter_mine") return ["enter_mine"];
  // WIA world-interruption proofs (world-interruption-arbitration.md §4.1 ② /
  // §4.3): the SAME published move_to_tile action runs over fixtures that stage
  // a pass-out or a modal mid-move; travel is needed only if the actor starts
  // inside the FarmHouse.
  if (action === "wia_pass_out") return ["move_to_tile", "travel"];
  if (action === "wia_modal_interrupt") return ["move_to_tile", "travel"];
  if (action === "wia_modal_dismiss_chain") return ["move_to_tile", "dismiss_modal", "travel"];
  if (action === "wia_eat_interrupt") return ["use_item", "dismiss_modal"];
  if (action === "wia_answer_question") return ["move_to_tile", "answer_dialogue"];
  // The three non-movement/non-navigation WIA slots each own a body-holding
  // execution whose interruption must be measured while the slot is live.
  if (action === "wia_tool_approach_interrupt") return ["equip_tool", "chop_tree_source", "dismiss_modal"];
  if (action === "wia_animal_product_interrupt") return ["collect_animal_product", "dismiss_modal"];
  if (action === "wia_item_pickup_interrupt") return ["pickup_item", "dismiss_modal"];
  // WIA world-interruption proofs (world-interruption-arbitration.md §4.1 ② /
  // §4.3): the SAME published move_to_tile action runs over fixtures that stage
  // a pass-out or a modal mid-move; travel is needed only if the actor starts
  // inside the FarmHouse.
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
  // The cross-day lifecycle is a real wire action now: the fixture publishes
  // advance_day and production dispatches it. Its own route, native sleep answer
  // and Saving/Saved/DayStarted observation are the action's business, so no
  // other capability is a prerequisite here.
  if (action === "advance_day") return ["advance_day"];
  throw new Error("invalid_native_local_fixture_action");
}
export function fixtureScenario(actions, action) {
  // The requested harness action can select a distinct scenario for the SAME
  // action set: the built-in kitchen fridge is the chest store/take intent over a
  // different container, so both publish chest_store/chest_retrieve yet must
  // provision a kitchen instead of a placed chest.
  // The move-stall probe also runs the SAME action set (move_to_tile, plus
  // pet_animal only to publish the Pet projection), so its scenario MUST be
  // selected here, before the `pet_animal` action branch below would hijack it
  // into native_pet_animal_v1.
  if (action === "move_stall_probe_pet") return "native_move_stall_probe_pet_v1";
  if (action === "move_stall_probe_npc") return "native_move_stall_probe_npc_v1";
  if (action === "fridge_store") return "native_fridge_store_v1";
  if (action === "fridge_retrieve") return "native_fridge_retrieve_v1";
  if (action === "ride_minecart") return "native_ride_minecart_v1";
  if (action === "ride_bus") return "native_ride_bus_v1";
  if (action === "shop_purchase") return "native_shop_purchase_v1";
  if (action === "select_mine_elevator_floor") return "native_mine_elevator_v1";
  if (action === "ship_item_island") return "native_ship_item_island_v1";
  // Ladder 6 (self-directed play session). This MUST be an action-keyed branch in
  // this block: the play-session action set publishes harvest_crop AND ship_item,
  // so the later `actions.includes(...)` fallbacks (the strawberry covenant is
  // exactly that pair) would hijack it and arm the WRONG world — a live run proved
  // it by arming the strawberry fixture for a play session.
  if (action === "play_session") return "native_play_session_v1";
  // Lane G resource-depletion recovery chain: the same water_crop action set plus
  // refill_watering_can, but the fixture must supply an EMPTY can. Without this
  // override the `water_crop` check below would select the charged-can scenario
  // and the chain would have no breakpoint.
  if (action === "water_crop_resource_recovery_chain") return "native_water_crop_empty_can_recovery_v1";
  // Lane G container-full recovery chain: the same harvest_crop action set plus
  // chest_store, but the fixture must supply a FULL backpack. Without this override
  // the `harvest_crop` check below would select the ordinary ready-crop scenario and
  // the chain would have no breakpoint.
  if (action === "harvest_inventory_full_recovery_chain") return "native_harvest_crop_inventory_full_recovery_v1";
  // Lane G low-stamina recovery chain: the same till_soil action set plus use_item,
  // but the fixture must set LOW stamina. Without this override the `till_soil` check
  // below would select the ordinary till-soil scenario and the chain would have no
  // low-stamina breakpoint.
  if (action === "stamina_recovery_chain") return "native_stamina_recovery_v1";
  // Lane G partial-completion recovery chain: the same craft_item action set plus
  // chest_store/pickup_item, but the fixture must supply a backpack that is nearly
  // FULL of the product. Without this override the `craft_item` check below would
  // select the ordinary craft scenario whose product fits, and the chain would have
  // no partial disposition to recover from.
  if (action === "craft_partial_recovery_chain") return "native_craft_item_partial_v1";
  // The lifecycle action owns its own route and preconditions; it needs no
  // fixture scenario beyond the ordinary move-only world.
  if (actions.includes("advance_day")) return "";
  // The pass-out lifecycle supplies only a low-stamina precondition; the native
  // gate starts the pass-out itself. This is keyed off the action name rather
  // than a synthetic action so the fixture never has to widen the action set to
  // express a scenario.
  if (action === "sleep_pass_out_lifecycle") return "native_pass_out_v1";
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
  // Ladder 5 covenant probe: harvest + the shipping temptation. Both the mature
  // crop and the native bin must be pre-arranged; the plain harvest fixture has
  // neither a covenant shape nor an empty-bin invariant.
  if (actions.includes("harvest_crop") && actions.includes("ship_item"))
    return "native_strawberry_covenant_v1";
  if (action === "wia_pass_out") return "native_wia_pass_out_v1";
  if (action === "wia_modal_interrupt") return "native_wia_modal_interrupt_v1";
  if (action === "wia_modal_dismiss_chain") return "native_wia_modal_dismiss_chain_v1";
  if (action === "wia_eat_interrupt") return "native_wia_eat_interrupt_v1";
  if (action === "wia_answer_question") return "native_wia_answer_question_v1";
  if (action === "wia_tool_approach_interrupt") return "native_wia_tool_approach_interrupt_v1";
  if (action === "wia_animal_product_interrupt") return "native_wia_animal_product_interrupt_v1";
  if (action === "wia_item_pickup_interrupt") return "native_wia_item_pickup_interrupt_v1";
  // Action-specific ids take precedence over the includes() fallbacks below:
  // a WIA chain whose action set contains use_item (wia_eat_interrupt) must
  // not be captured by the generic use_item scenario (#regression 2026-10-04,
  // live gate wrote native_use_item_v1 for it).
  if (actions.includes("till_soil")) return "native_till_soil_v1";
  // The expression actions need no scenario: both are pure embodied-actor
  // mutations that run on an ordinary target-version world with no
  // fixture-created player or world fact. They still get a named scenario so
  // the run records which fixture intent produced the evidence.
  if (actions.includes("express_emote")) return "native_express_emote_v1";
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
  if (actions.includes("water_pet_bowl")) return "native_water_pet_bowl_v1";
  if (actions.includes("water_slime_hutch_trough")) return "native_water_slime_hutch_trough_v1";
  if (actions.includes("feed_animal")) return "native_feed_animal_v1";
  if (actions.includes("collect_animal_product")) return "native_collect_animal_product_v1";
  if (actions.includes("chest_store")) return "native_chest_store_v1";
  if (actions.includes("chest_retrieve")) return "native_chest_retrieve_v1";
  if (actions.includes("chop_stump")) return "native_chop_stump_v1";
  if (actions.includes("plant_sapling")) return "native_plant_sapling_v1";
  if (actions.includes("cut_weeds")) return "native_cut_weeds_v1";
  if (actions.includes("cut_grass")) return "native_cut_grass_v1";
  // Loop-closure wave (2026-10-04): one scenario per lane action, mirroring
  // the fixture branch names in ModEntry.Fixtures.cs.
  if (actions.includes("clear_cask")) return "native_clear_cask_v1";
  if (actions.includes("dress_mannequin")) return "native_dress_mannequin_v1";
  if (actions.includes("set_sign_display")) return "native_set_sign_display_v1";
  if (actions.includes("deposit_silo_hay")) return "native_deposit_silo_hay_v1";
  if (actions.includes("withdraw_silo_hay")) return "native_withdraw_silo_hay_v1";
  if (actions.includes("toggle_animal_door")) return "native_toggle_animal_door_v1";
  if (actions.includes("use_obelisk")) return "native_use_obelisk_v1";
  if (actions.includes("toggle_tool_light")) return "native_toggle_tool_light_v1";
  if (actions.includes("harvest_bush")) return "native_harvest_bush_v1";
  if (actions.includes("harvest_fruit_tree")) return "native_harvest_fruit_tree_v1";
  if (actions.includes("shake_tree")) return "native_shake_tree_v1";
  if (actions.includes("take_pedestal_item")) return "native_take_pedestal_item_v1";
  if (actions.includes("toggle_fence_gate")) return "native_toggle_fence_gate_v1";
  if (actions.includes("use_raft")) return "native_use_raft_v1";
  if (actions.includes("mount_transport")) return "native_mount_transport_v1";
  if (actions.includes("enter_mine")) return "native_enter_mine_v1";
  if (actions.includes("scythe_crop")) return "native_scythe_crop_v1";
  if (actions.includes("ship_item")) return "native_ship_item_v1";
  if (actions.includes("craft_item")) return "native_craft_item_v1";
  if (actions.includes("cook_recipe")) return "native_cook_recipe_v1";
  if (actions.includes("collect_crab_pot_output")) return "native_crab_pot_collect_v1";
  return "";
}
// The Mod catalog is the authority for which registrations are still
// experimental. Reading it here keeps the fixture's opt-in list from going
// stale: a promoted action left in ExperimentalActions makes
// ActionPolicyEngine.ValidateActionPolicy reject the whole config, so a stale
// list silently blocks every run of that action. That is exactly what happened
// when 17 actions were promoted at once.
async function readExperimentalActionIds(options) {
  if (options.experimentalActionIds !== undefined) return options.experimentalActionIds;
  return readExperimentalStardewActionIds();
}

/**
 * Write the deny-by-exception policy block a fixture run uses.
 *
 * Denying nothing and opting nothing in is the honest default: the Agent's
 * surface is whatever the Mod catalog derives, and ExperimentalActions stays
 * empty unless the action under test is itself still experimental (in which
 * case naming it is what lets the run exercise it at all).
 */
function applyDerivedPolicy(result, actions, experimentalActionIds) {
  const experimentalSet = new Set(experimentalActionIds);
  result.DeniedActions = [];
  result.DeniedActionFamilies = [];
  result.ExperimentalActions = actions.filter((action) => experimentalSet.has(action));
  return result;
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
function configureNativeLocalPlayerBootstrap(config, logicalSaveName, timeoutSeconds, actions, action, experimentalActionIds) {
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
    FixtureScenario: fixtureScenario(actions, action),
    Bootstrap: { Enable: true, SaveName: logicalSaveName, PlayerName: "GameBuddy" },
  };
  result.Portfolio = { ...(result.Portfolio ?? {}), Enable: false };
  result.HostAutomation = { ...(result.HostAutomation ?? {}), Enable: false };
  result.HostFarmhandProvisioning = { ...(result.HostFarmhandProvisioning ?? {}), Enable: false };
  result.FarmhandProvisioner = { ...(result.FarmhandProvisioner ?? {}), Enable: false };
  applyDerivedPolicy(result, actions, experimentalActionIds);
  // Same single language configuration point as the live runner: the
  // frontend-set language preference flows into the Mod config, so the
  // Mod-side companion presentation locale stays aligned with the Agent
  // session locale.
  const companionLocale = process.env.GAMEBUDDY_COMPANION_LOCALE === "en-US" ? "en-US" : "zh-CN";
  result.PresentationLocale = companionLocale;
  return result;
}
function configureNativeLocalPlayer(config, observedSaveSlot, timeoutSeconds, actions, binding, action, experimentalActionIds) {
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
    FixtureScenario: fixtureScenario(actions, action),
  };
  result.Portfolio = { ...(result.Portfolio ?? {}), Enable: false };
  result.HostAutomation = { ...(result.HostAutomation ?? {}), Enable: false };
  result.HostFarmhandProvisioning = { ...(result.HostFarmhandProvisioning ?? {}), Enable: false };
  result.FarmhandProvisioner = { ...(result.FarmhandProvisioner ?? {}), Enable: false };
  applyDerivedPolicy(result, actions, experimentalActionIds);
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
