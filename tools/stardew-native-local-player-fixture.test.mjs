import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  prepareNativeLocalPlayerFixture,
  restoreNativeLocalPlayerFixture,
} from "./lib/stardew-native-local-player-fixture.mjs";

const BUNDLE_FILES = ["GameBuddy.Stardew.dll", "manifest.json", "GameBuddy.Stardew.deps.json"];
const saveName = "GameBuddyFixture_445094166";
const binding = Object.freeze({
  version: 1,
  observedSaveSlot: saveName,
  logicalSaveName: "GameBuddyFixture",
  saveId: "fixture-save",
  worldId: "fixture-world",
  playerId: "fixture-player",
  companionId: "fixture-companion",
});

async function createFixture(t, suffix) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-native-local-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modsPath = join(root, "mods");
  const releaseDir = join(root, "release");
  const modRoot = join(modsPath, "GameBuddy");
  await mkdir(modRoot, { recursive: true });
  await mkdir(releaseDir, { recursive: true });

  const originalConfig = {
    EnableLocalBridge: true,
    PipeName: "gamebuddy-fixture-pipe",
    BridgeToken: "gamebuddy-fixture-token-1234",
    SaveId: "original-save",
    WorldId: "original-world",
    PlayerId: "original-player",
    CompanionId: "original-companion",
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    EnabledActions: ["move_to_tile"],
  };
  const originalConfigBytes = `${JSON.stringify(originalConfig, null, 2)}\n`;
  await writeFile(join(modRoot, "config.json"), originalConfigBytes);
  for (const name of BUNDLE_FILES) {
    await writeFile(join(releaseDir, name), `release-${name}`);
    await writeFile(join(modRoot, name), `original-${name}`);
  }

  return {
    root,
    modsPath,
    releaseDir,
    modRoot,
    originalConfigBytes,
    saveName,
    binding,
    backupName: `native-local-${suffix}-fixture-backup`,
  };
}

test("native-local bootstrap launcher does not restore an external action template", async () => {
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  const bootstrapStart = launcher.indexOf("if ($BootstrapNativeSave) {");
  const nonBootstrapStart = launcher.indexOf("} else {", bootstrapStart);
  const launchStart = launcher.indexOf("$process = Start-Process", nonBootstrapStart);
  assert.notEqual(bootstrapStart, -1);
  assert.notEqual(nonBootstrapStart, -1);
  assert.notEqual(launchStart, -1);
  assert.doesNotMatch(launcher.slice(bootstrapStart, nonBootstrapStart), /fixtureSaveHarness/);
  assert.match(launcher.slice(nonBootstrapStart, launchStart), /prepare-stardew-native-local-player-fixture\.mjs/);
  assert.match(launcher, /if \(-not \$BootstrapNativeSave\) \{[\s\S]*?\$fixtureSaveHarness/);
  assert.match(launcher, /if \(\$workingSavePrepared\) \{[\s\S]*?\$fixtureSaveHarness/);
});

test("native-local machine-load fixture supplies only an idle Keg and exact Coffee Bean stack", async (t) => {
  const options = { ...(await createFixture(t, "machine-load")), action: "machine_load" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["machine_load"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_machine_coffee_load_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf(
    'if (fixture.FixtureScenario is "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1")',
  );
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_dig_artifact_spot_v1")', setupStart),
  );
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\("\(O\)433", 5\)/);
  assert.match(setup, /fixture_native_local_machine_coffee_input_missing/);
  assert.doesNotMatch(
    setup,
    /\.checkAction\(|PlaceInMachine|performObjectDropInAction|RequestLocalLoadCoffeeIntoKeg|PublishReceipt/,
  );
  const manager = await readFile(new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url), "utf8");
  const actionStart = manager.indexOf("public LocalExecutionReceipt RequestLocalLoadCoffeeIntoKeg");
  const action = manager.slice(
    actionStart,
    manager.indexOf("public LocalExecutionReceipt RequestLocalInspectMachine", actionStart),
  );
  assert.match(action, /location\.checkAction\(/);
  assert.doesNotMatch(action, /PlaceInMachine|performObjectDropInAction/);
  assert.match(action, /machine_coffee_loaded/);
  assert.match(action, /machine\.MinutesUntilReady == 120/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-machine-load-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /native_machine_coffee_load_v1/);
  assert.match(runner, /machine_coffee_loaded/);
  assert.match(runner, /input_stack_after === "removed"/);
  assert.match(runner, /minutes_until_ready === "120"/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local machine-collect fixture starts from loading only; production owns ready-time and collection", async (t) => {
  const options = { ...(await createFixture(t, "machine-collect")), action: "machine_collect_output" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["machine_load", "machine_collect_output"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_machine_coffee_load_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf(
    'if (fixture.FixtureScenario is "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1")',
  );
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_dig_artifact_spot_v1")', setupStart),
  );
  assert.doesNotMatch(setup, /readyForHarvest\s*=|MinutesUntilReady\s*=|heldObject\.Value\s*=/);
  const manager = await readFile(new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url), "utf8");
  const actionStart = manager.indexOf("public LocalExecutionReceipt RequestLocalCollectCoffeeFromKeg");
  const action = manager.slice(
    actionStart,
    manager.indexOf("public LocalExecutionReceipt RequestLocalInspectMachine", actionStart),
  );
  assert.match(action, /location\.checkAction\(/);
  assert.match(action, /machine_coffee_collected/);
  assert.doesNotMatch(action, /PlaceInMachine|performObjectDropInAction/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-machine-collect-output-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /waitForReadyTarget/);
  assert.match(runner, /machine_ready_timeout_without_time_skip/);
  assert.match(runner, /machine_coffee_collected/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local dig-artifact-spot fixture selects an intact artifact spot and Basic Hoe without consuming sources", async (t) => {
  const options = { ...(await createFixture(t, "dig-artifact-spot")), action: "dig_artifact_spot" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_dig_artifact_spot_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_dig_artifact_spot_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_clear_hoedirt_v1")', setupStart),
  );
  assert.match(setup, /new Hoe\(\)/);
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\("\(O\)590", 1\)/);
  assert.match(setup, /OrderBy\(pair => pair\.Key\.X\)/);
  assert.match(setup, /ThenBy\(pair => pair\.Key\.Y\)/);
  assert.match(setup, /existingArtifactSpots\.Length == 0/);
  assert.match(setup, /existing_sources_unapproachable/);
  assert.match(setup, /artifactSourceCount < 1/);
  assert.match(setup, /farm\.dropObject\(artifact, artifactTile \* 64f, Game1\.viewport, initialPlacement: false\)/);
  assert.doesNotMatch(
    setup,
    /farm\.dropObject\(artifact, artifactTile \* 64f, Game1\.viewport, initialPlacement: true\)/,
  );
  assert.match(setup, /farm\.objects\.Pairs\.Count\(pair => pair\.Value\.QualifiedItemId == "\(O\)590"\)/);
  assert.match(setup, /artifactSourceCount < 1/);
  assert.doesNotMatch(
    setup,
    /DoFunction|digUpArtifactSpot|checkAction|RequestLocalDigArtifactSpot|PublishReceipt|\b(?:request|receipt|reward|debris|pickup|outcome)\b|Items\[/i,
  );
  assert.doesNotMatch(setup, /objects\.Remove/);
  assert.match(entry, /farm\.objects\.Pairs\.Count\(pair => pair\.Value\.QualifiedItemId == "\(O\)590"\) >= 1/);
  assert.match(
    entry,
    /!farm\.IsTileOccupiedBy\(artifactPending\.StandingTile, ~CollisionMask\.Farmers, CollisionMask\.None, useFarmerTile: false\)/,
  );
  const failureMarker = "error=fixture_native_local_artifact_spot_approach_unreachable";
  const failureBranchStart = entry.indexOf(
    "this.nativeLocalDigArtifactSpotFixturePending = null;",
    entry.indexOf("if (this.nativeLocalDigArtifactSpotFixturePending"),
  );
  const failureBranch = entry.slice(
    failureBranchStart,
    entry.indexOf("if (this.nativeLocalClearHoeDirtFixturePending", failureBranchStart),
  );
  const debugLogIndex = failureBranch.indexOf("[DEBUG-artifact-fixture]");
  const genericFailureIndex = failureBranch.indexOf(failureMarker);
  assert.ok(debugLogIndex >= 0 && debugLogIndex < genericFailureIndex);
  for (const fact of [
    "player_is_game1_player",
    "new_location_is_farm",
    "farm_name_equal",
    "source_count",
    "source_present_at_expected_tile",
    "source_qid_is_590",
    "source_on_map",
    "source_terrain_absent",
    "source_hoedirt_absent",
    "source_indoor_pot",
    "standing_on_map",
    "standing_passable",
    "standing_occupied_use_farmer_tile_false",
    "hoe_count",
    "basic_hoe",
    "player_tile",
    "expected_standing_tile",
  ])
    assert.match(failureBranch, new RegExp(`${fact}=`));

  const helperStart = entry.indexOf("private static Vector2? FindNativeLocalArtifactSpotStandingTile");
  const helper = entry.slice(
    helperStart,
    entry.indexOf("private static Vector2? FindNativeLocalFarmFixtureTile", helperStart),
  );
  assert.doesNotMatch(helper, /isTilePassable\(artifactTile\)/);
  assert.match(helper, /candidate => farm\.isTileOnMap\(candidate\) && farm\.isTilePassable\(candidate\)/);
  assert.match(
    helper,
    /!farm\.IsTileOccupiedBy\(candidate, ~CollisionMask\.Farmers, CollisionMask\.None, useFarmerTile: false\)/,
  );

  const artifactWarpStart = entry.indexOf("if (this.nativeLocalDigArtifactSpotFixturePending");
  const artifactWarp = entry.slice(
    artifactWarpStart,
    entry.indexOf("if (this.nativeLocalClearHoeDirtFixturePending", artifactWarpStart),
  );
  assert.doesNotMatch(artifactWarp, /isTilePassable\(artifactPending\.ArtifactTile\)/);
  assert.match(artifactWarp, /farm\.isTileOnMap\(artifactPending\.StandingTile\)/);
  assert.match(artifactWarp, /farm\.isTilePassable\(artifactPending\.StandingTile\)/);
  assert.match(
    artifactWarp,
    /!farm\.IsTileOccupiedBy\(artifactPending\.StandingTile, ~CollisionMask\.Farmers, CollisionMask\.None, useFarmerTile: false\)/,
  );
  assert.doesNotMatch(artifactWarp, /\|\| e\.Player\.Tile == artifactPending\.StandingTile/);
  assert.doesNotMatch(artifactWarp, /CollisionMask\.All, CollisionMask\.None, useFarmerTile: false/);

  assert.doesNotMatch(setup, /isTilePassable\(artifactTile\)/);
  assert.match(setup, /farm\.isTileOnMap\(artifactTile\)/);
  assert.match(setup, /farm\.terrainFeatures\.ContainsKey\(artifactTile\)/);
  assert.match(setup, /farm\.GetHoeDirtAtTile\(artifactTile\) is not null/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-dig-artifact-spot-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    runner,
    /same\(value\.EnabledActions, \["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"\]\)/,
  );
  assert.match(
    runner,
    /\["cancel_active_execution", "dig_artifact_spot", "equip_tool", "inspect_self", "move_to_tile", "travel"\]/,
  );
  assert.match(runner, /equip_tool/);
  assert.match(runner, /target_changed_after_equip/);
  assert.match(runner, /Object\.prototype\.hasOwnProperty\.call\(result, key\)/);
  assert.match(runner, /artifactSpotResultTargets/);
  assert.match(runner, /initialSourceCount/);
  assert.match(runner, /const preCount = fresh\.artifactSpotFarmSourceCount/);
  assert.match(runner, /preCount < 1/);
  assert.match(runner, /preCount - 1/);
  assert.match(runner, /Number\.isInteger\(initialSourceCount\).*initialSourceCount < 1/);
  assert.doesNotMatch(runner, /artifactSpotFarmSourceCount === 0/);
  assert.match(runner, /artifact_spot_dug/);
  assert.match(runner, /stamina_before/);
  assert.match(runner, /stamina_after/);
  assert.match(runner, /stamina_delta/);
  assert.match(runner, /expected_stamina_cost/);
  assert.match(runner, /parseFiniteDecimal/);
  assert.match(runner, /DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON = 0\.011/);
  assert.match(
    runner,
    /Math\.abs\(\(-parseFiniteDecimal\(evidence\.stamina_delta\)\) - parseFiniteDecimal\(evidence\.expected_stamina_cost\)\) <= DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON/,
  );
  assert.match(runner, /stamina_delta\) <= 0/);
  const protocol = await readFile(new URL("../integrations/stardew/BridgeProtocol.cs", import.meta.url), "utf8");
  assert.match(protocol, /ArtifactSpotFarmSourceCount/);
  const executionManager = await readFile(
    new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url),
    "utf8",
  );
  assert.match(executionManager, /CountArtifactSpotFarmSources/);
  assert.match(executionManager, /farm\.objects\.Pairs\.Count\(pair => pair\.Value\.QualifiedItemId == "\(O\)590"\)/);
  assert.match(executionManager, /OrderBy\(pair => pair\.Key\.X\)/);
  assert.match(executionManager, /ThenBy\(pair => pair\.Key\.Y\)/);
  assert.match(executionManager, /\.Take\(8\)/);
  const artifactDiscoveryStart = executionManager.indexOf(
    "private static IReadOnlyList<BridgeArtifactSpotTarget> DiscoverArtifactSpotTargets",
  );
  const artifactDiscovery = executionManager.slice(
    artifactDiscoveryStart,
    executionManager.indexOf("private IReadOnlyList<BridgeArtifactSpotResultTarget>", artifactDiscoveryStart),
  );
  assert.doesNotMatch(artifactDiscovery, /location\.isTilePassable\(pair\.Key\)/);
  assert.match(artifactDiscovery, /location\.isTilePassable\(standing\)/);
  assert.match(artifactDiscovery, /\|\| player\.Tile == standing/);
  const execution = await readFile(new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url), "utf8");
  assert.match(execution, /hoe\.UpgradeLevel != 0/);
  assert.match(execution, /basic_hoe_not_equipped_in_requested_slot/);
  assert.match(
    execution,
    /if \(hoeDirtPresentBefore\)\s+return this\.RememberTerminal\(requestId, executionId, ExecutionState\.Rejected, "artifact_spot_hoedirt_present_before"/,
  );
  assert.match(
    execution,
    /float staminaBefore = Game1\.player\.Stamina;[\s\S]*hoe\.DoFunction\(location, targetX \* 64 \+ 32, targetY \* 64 \+ 32, 1, Game1\.player\);[\s\S]*Game1\.player\.lastClick = Vector2\.Zero;[\s\S]*Game1\.player\.checkForExhaustion\(staminaBefore\);[\s\S]*float staminaAfter = Game1\.player\.Stamina;/,
  );
  assert.doesNotMatch(execution, /Stamina\s*[<>]=?\s*2|stamina_insufficient|insufficient_stamina/);
  assert.match(execution, /stamina_before=.*stamina_after=.*stamina_delta=.*expected_stamina_cost=/);
  assert.match(execution, /bool succeeded = !hoeDirtPresentBefore && !sourcePresentAfter && hoeDirtPresentAfter/);
  assert.match(execution, /artifactSpotResultExecutionId/);
  assert.match(execution, /artifactSpotResultRequestId/);
  assert.match(execution, /InvalidateArtifactSpotResult\(\)/);
  assert.match(execution, /receipt\.ReasonCode != "artifact_spot_dug"/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local bait-crab-pot fixture is pre-attachment only and preserves the native mutation boundary", async (t) => {
  const options = { ...(await createFixture(t, "bait-crab-pot")), action: "bait_crab_pot" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["bait_crab_pot"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_bait_crab_pot_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const start = entry.indexOf('if (fixture.FixtureScenario == "native_bait_crab_pot_v1")');
  const setup = entry.slice(start, entry.indexOf('if (fixture.FixtureScenario == "native_place_crab_pot_v1")', start));
  assert.match(setup, /const string baitId = "\(O\)685"/);
  assert.match(setup, /StardewValley\.Objects\.CrabPot pot = new\(\)/);
  assert.match(setup, /pot\.owner\.Value = player\.UniqueMultiplayerID/);
  assert.match(setup, /pot\.bait\.Value is not null/);
  assert.match(setup, /player\.warpFarmer/);
  assert.doesNotMatch(setup, /performObjectDropInAction|reduceActiveItemByOne|PublishReceipt/i);
  const runner = await readFile(new URL("./run-stardew-native-local-player-bait-crab-pot-smoke.mjs", import.meta.url), "utf8");
  assert.match(runner, /receipt\.requestId === requestId/);
  assert.match(runner, /receipt\.executionId/);
  assert.match(runner, /receipt\.revision === after\.revision/);
  assert.match(runner, /inventory_before\) === 1|Number\(evidence\.inventory_before\) === 1/);
  assert.match(runner, /after\.actionable && after\.activeExecution == null/);
  assert.match(runner, /baitCrabPotResultTargets/);
  const execution = await readFile(new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url), "utf8");
  assert.match(execution, /RequestLocalBaitCrabPot/);
  assert.match(execution, /location\.checkAction\(new xTile\.Dimensions\.Location\(targetX, targetY\)/);
  assert.match(execution, /BuildBaitCrabPotTargetId/);
  assert.match(execution, /bait_crab_pot_[\s\S]*SHA256/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local place-crab-pot fixture discovers one exact native target and never performs placement", async (t) => {
  const options = { ...(await createFixture(t, "place-crab-pot")), action: "place_crab_pot" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "place_crab_pot"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_place_crab_pot_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_place_crab_pot_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_plant_seed_v1")', setupStart),
  );
  assert.match(setup, /const string crabPotId = "\(O\)710"/);
  assert.match(setup, /CrabPot\.IsValidCrabPotLocationTile/);
  assert.match(setup, /IsExcludedCrabPotLocation\(farm\)/);
  assert.match(setup, /player\.warpFarmer/);
  assert.match(setup, /inventoryBefore/);
  assert.match(setup, /inventoryAfter/);
  assert.match(setup, /ReferenceEquals\(existingCrabPots\[0\], crabPotsAfter\[0\]\)/);
  assert.match(setup, /fixture_native_local_crab_pot_inventory_multiple_stacks/);
  assert.match(setup, /fixture_native_local_crab_pot_inventory_stack_must_be_exactly_one/);
  assert.match(setup, /crabPotStack/);
  assert.match(setup, /Native inventory insertion may normalize unrelated item object/);
  assert.match(setup, /inventoryStacksBefore|inventoryIdsBefore|fixture_native_local_crab_pot_inventory_changed/);
  assert.doesNotMatch(setup, /ReferenceEquals\(inventoryBefore\[slot\], inventoryAfter\[slot\]\)/);
  assert.doesNotMatch(
    setup,
    /player\.Items\.Remove|new CrabPot\(|placementAction|reduceActiveItemByOne|dropObject|createItemDebris|PublishReceipt|receipt/i,
  );
  const helperStart = entry.indexOf(
    "private static (Vector2 TargetTile, Vector2 StandingTile)? FindNativeLocalCrabPotFixtureTarget",
  );
  const helper = entry.slice(
    helperStart,
    entry.indexOf("private static Vector2? FindNativeLocalFarmFixtureTile", helperStart),
  );
  assert.match(helper, /CrabPot\.IsValidCrabPotLocationTile/);
  assert.match(helper, /validStanding\.Length == 1/);
  assert.match(helper, /farm\.isTileOnMap\(standing\)/);
  assert.match(helper, /farm\.isTilePassable\(standing\)/);
  assert.match(helper, /IsTileOccupiedBy\(standing, ~CollisionMask\.Farmers/);
  const warpStart = entry.indexOf("if (this.nativeLocalPlaceCrabPotFixturePending");
  const warp = entry.slice(warpStart, entry.indexOf("if (this.nativeLocalDigArtifactSpotFixturePending", warpStart));
  assert.match(warp, /CrabPot\.IsValidCrabPotLocationTile/);
  assert.match(warp, /ReferenceEquals\(item, crabPotPending\.CrabPot\)/);
  assert.match(warp, /crabPotPending\.CrabPot\.Stack == crabPotPending\.CrabPotStack/);
  assert.doesNotMatch(
    warp,
    /new CrabPot\(|placementAction|reduceActiveItemByOne|PublishReceipt|dropObject|createItemDebris/i,
  );
  const resetStart = entry.indexOf("private void OnReturnedToTitle");
  const reset = entry.slice(resetStart, entry.indexOf("private void StatusCommand", resetStart));
  assert.match(reset, /nativeLocalPlaceCrabPotFixturePending = null/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-place-crab-pot-fixture-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /state: "fixture_prepared"/);
  assert.match(runner, /productionRequestSent: false/);
  assert.match(runner, /snapshot\.capabilities\.includes\(action\)/);
  assert.match(runner, /productionRequestSent: false/);
  assert.match(runner, /productionRequestSent: false/);
  assert.match(runner, /latestReceipt/);
  assert.match(runner, /latestReceipt/);
  assert.match(runner, /productionRequestSent: false/);
  assert.doesNotMatch(runner, /client\.execute\(/);
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  assert.match(launcher, /"place_crab_pot"/);
  const config = await readFile(new URL("../integrations/stardew/ModConfig.cs", import.meta.url), "utf8");
  const bootstrapStart = config.indexOf("internal bool IsBootstrapValid");
  const bootstrap = config.slice(
    bootstrapStart,
    config.indexOf("private static bool IsObservedFixtureSlot", bootstrapStart),
  );
  assert.match(bootstrap, /native_place_crab_pot_v1/);
  assert.doesNotMatch(bootstrap, /place_crab_pot.*PublishedActions|PublishedActions.*place_crab_pot/s);
  const publishedStart = config.indexOf("private static readonly IReadOnlySet<string> PublishedActions");
  const published = config.slice(
    publishedStart,
    config.indexOf("private static readonly IReadOnlySet<string> PublishedFamilies", publishedStart),
  );
  assert.match(published, /place_crab_pot/);
  const productionRunner = await readFile(
    new URL("./run-stardew-native-local-player-place-crab-pot-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(productionRunner, /client\.execute\(/);
  assert.match(productionRunner, /source.*target disappearance|crabPotTargets/);
  assert.match(productionRunner, /overlayTiles/);
  const execution = await readFile(new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url), "utf8");
  assert.match(execution, /RequestLocalPlaceCrabPot/);
  assert.match(execution, /BuildCrabPotOverlayFacts/);
  assert.match(execution, /OverlayTiles/);
  const protocol = await readFile(new URL("../integrations/stardew/BridgeProtocol.cs", import.meta.url), "utf8");
  assert.match(protocol, /BridgeCrabPotOverlayTile/);
  assert.match(protocol, /BridgeCrabPotResultTarget/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local break-rock-source fixture is isolated and cannot perform the hit", async (t) => {
  const options = { ...(await createFixture(t, "break-rock-source")), action: "break_rock_source" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "break_rock_source"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_break_rock_source_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setup = entry.slice(
    entry.indexOf('fixture.FixtureScenario == "native_break_rock_source_v1"'),
    entry.indexOf('fixture.FixtureScenario is "native_tree_first_hit_v1" or "native_chop_tree_source_v1"'),
  );
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\("\(O\)2", 1\)/);
  assert.match(setup, /rock.MinutesUntilReady = 1/);
  assert.doesNotMatch(setup, /DoFunction|RequestLocalBreakRockSource|PublishReceipt/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-break-rock-source-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /durability_before === "1"/);
  assert.match(runner, /durability_after === "removed"/);
  assert.match(runner, /removed === "true"/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local clear-hoedirt fixture establishes only the intact empty ground precondition", async (t) => {
  const options = { ...(await createFixture(t, "clear-hoedirt")), action: "clear_hoedirt" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "clear_hoedirt"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_clear_hoedirt_v1");

  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_clear_hoedirt_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('fixture.FixtureScenario is "native_tree_first_hit_v1" or "native_chop_tree_source_v1"', setupStart),
  );
  assert.match(setup, /new Pickaxe\(\)/);
  assert.match(setup, /Vector2 fixtureArrival = new\(64f, 15f\)/);
  assert.match(setup, /FindNativeLocalFarmFixtureTile\(farm, fixtureArrival, 12/);
  assert.match(setup, /NativeLocalClearHoeDirtFixturePending/);
  assert.match(setup, /player\.warpFarmer\(new StardewValley\.Warp/);
  assert.match(setup, /StardewValley\.TerrainFeatures\.HoeDirt dirt = new\(\)/);
  assert.match(setup, /dirt\.crop is not null/);
  assert.match(setup, /IndoorPot/);
  assert.doesNotMatch(setup, /Utility\.tileWithinRadiusOfPlayer/);
  assert.match(entry, /fixture_native_local_clear_hoedirt_approach_unreachable/);
  assert.doesNotMatch(setup, /^\s*pickaxe\.DoFunction\(/m);
  assert.doesNotMatch(setup, /RequestLocalClearHoeDirt|PublishReceipt|terrainFeatures\.Remove/);

  const protocol = await readFile(new URL("../integrations/stardew/BridgeProtocol.cs", import.meta.url), "utf8");
  assert.match(
    protocol,
    /BridgeClearHoeDirtTarget\(string TargetId, string Location, int X, int Y, bool Crop, bool Ground\)/,
  );
  const session = await readFile(new URL("../integrations/stardew/BridgeSession.cs", import.meta.url), "utf8");
  const validationStart = session.indexOf('else if (request.Action is "clear_hoedirt" or "dig_artifact_spot")');
  const validation = session.slice(
    validationStart,
    session.indexOf('else if (request.Action == "equip_tool")', validationStart),
  );
  assert.match(validation, /request\.Args\.AdditionalProperties is \{ Count: > 0 \}/);
  assert.match(validation, /request\.Args\.ExpectedQualifiedItemId is not null/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-clear-hoedirt-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "equip_tool", "clear_hoedirt"\]/);
  assert.match(runner, /evidence\.crop_before === "false"/);
  assert.match(runner, /evidence\.hoedirt_present_before === "true"/);
  assert.match(runner, /evidence\.hoedirt_present_after === "false"/);
  assert.match(runner, /evidence\.removed === "true"/);
  assert.match(runner, /reread === undefined/);
  assert.match(runner, /if \(snapshot\.location === "FarmHouse"\) snapshot = await travelToFarm\(snapshot\);/);
  assert.match(
    runner,
    /else if \(snapshot\.location !== "Farm"\) throw new Error\("clear_hoedirt_route_must_start_at_farmhouse_or_fixture_farm"\);/,
  );
  assert.match(runner, /const target = chooseHoeDirt\(snapshot\);/);
  assert.doesNotMatch(runner, /moveToReachableHoeDirt/);
  assert.doesNotMatch(runner, /move_to_clear_hoedirt_fixture/);
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  assert.match(launcher, /function Assert-LaunchedSmapiIdentity\(/);
  assert.match(launcher, /Assert-LaunchedSmapiIdentity -ExpectedSmapi \$smapi -ExpectedModsPath \$ModsPath/);
  assert.match(launcher, /actual\.ExecutablePath/);
  assert.match(launcher, /\$modsPathMatches = \[regex\]::Matches\(/);
  assert.match(launcher, /--mods-path\\s\+/);
  assert.match(launcher, /\$modsPathMatches\.Count -ne 1/);
  assert.match(launcher, /Get-NormalizedWindowsPath \$actualModsPath/);
  assert.doesNotMatch(launcher, /actual\.CommandLine\.IndexOf\(\$expectedModsPath/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local clear-debris fixture establishes one intact native resource clump only", async (t) => {
  const options = { ...(await createFixture(t, "clear-debris")), action: "clear_debris" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "clear_debris"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_clear_debris_resource_clump_v1");

  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_clear_debris_resource_clump_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('fixture.FixtureScenario is "native_tree_first_hit_v1" or "native_chop_tree_source_v1"', setupStart),
  );
  assert.match(setup, /const int debrisParentSheetIndex = 752/);
  assert.match(setup, /const int debrisWidth = 2/);
  assert.match(setup, /const int debrisHeight = 2/);
  assert.match(setup, /const int debrisDefaultHealth = 8/);
  assert.match(setup, /Vector2 debrisTile = new\(62f, 17f\)/);
  assert.match(setup, /fixture_native_local_debris_fixed_placement_unavailable/);
  assert.match(setup, /fixture_native_local_debris_parent_already_present/);
  assert.doesNotMatch(setup, /FindNativeLocalFarmResourceClumpFixtureTile\(/);
  assert.doesNotMatch(setup, /player\.Position =/);
  assert.match(entry, /farm\.CanItemBePlacedHere\(footprint/);
  assert.match(
    setup,
    /farm\.addResourceClumpAndRemoveUnderlyingTerrain\(debrisParentSheetIndex, debrisWidth, debrisHeight, debrisTile\)/,
  );
  assert.match(setup, /new Pickaxe\(\)/);
  assert.doesNotMatch(
    setup,
    /resourceClumps\.Add|DoFunction|RequestLocalClearDebris|performToolAction|health\.Value\s*=|PublishReceipt/,
  );

  const executionManager = await readFile(
    new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url),
    "utf8",
  );
  const protocol = await readFile(new URL("../integrations/stardew/BridgeProtocol.cs", import.meta.url), "utf8");
  assert.match(
    protocol,
    /BridgeDebrisTarget\(string TargetId, int Slot, int X, int Y, int ParentSheetIndex, string ToolKind, int RequiredUpgradeLevel, int Health\)/,
  );

  const requestStart = executionManager.indexOf("public LocalExecutionReceipt RequestLocalClearDebris");
  const request = executionManager.slice(
    requestStart,
    executionManager.indexOf(
      "private static StardewValley.TerrainFeatures.ResourceClump? FindDebrisTarget",
      requestStart,
    ),
  );
  assert.match(request, /IsDebrisTargetWithinPlayerRadius\(clump, Game1\.player\)/);
  assert.match(executionManager, /private static bool IsDebrisTargetWithinPlayerRadius/);
  const findTarget = executionManager.slice(
    executionManager.indexOf("private static StardewValley.TerrainFeatures.ResourceClump? FindDebrisTarget"),
    executionManager.indexOf("private static string BuildDebrisTargetId"),
  );
  assert.match(findTarget, /string\.Equals\(targetId, expectedTargetId, StringComparison\.Ordinal\)/);
  assert.doesNotMatch(findTarget, /Utility\.tileWithinRadiusOfPlayer/);
  assert.match(request, /float healthBefore = clump\.health\.Value/);
  assert.match(request, /health_before=\{healthBefore:0\.##\}/);
  assert.match(request, /health_after=\{healthAfter:0\.##\}/);
  assert.match(executionManager, /new BridgeDebrisTarget\([^\n]+, \(int\)clump\.health\.Value\)/);

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-clear-debris-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "equip_tool", "clear_debris"\]/);
  assert.match(runner, /initialTarget\.health !== 8/);
  assert.match(runner, /target\.health !== expectedHealth/);
  assert.match(runner, /for \(let hit = 1; hit <= 8; hit \+= 1\)/);
  assert.match(runner, /receipt\.state === "partially_succeeded" && receipt\.reasonCode === "debris_hit"/);
  assert.match(runner, /receipt\.state === "succeeded" && receipt\.reasonCode === "debris_cleared"/);
  assert.match(runner, /evidence\.health_before === String\(expectedHealth\)/);
  assert.match(runner, /connectWithRetry\(scope, config\.PipeName, config\.BridgeToken, 15_000\)/);
  assert.match(runner, /error\.code === "ENOENT"/);
  assert.match(runner, /const fixtureApproaches = \[\{ x: 61, y: 17 \}, \{ x: 64, y: 17 \}, \{ x: 62, y: 19 \}\]/);
  assert.match(runner, /entry\.x === 62 && entry\.y === 17/);
  assert.match(runner, /move_to_clear_debris_fixture_anchor/);
  assert.match(runner, /clear_debris_fixture_target_not_at_bounded_anchor/);
  assert.doesNotMatch(runner, /for \(let radius = 1; radius <= 12/);
  const helper = await readFile(new URL("./lib/stardew-native-local-player-fixture.mjs", import.meta.url), "utf8");
  assert.match(helper, /native_local_fixture_bundle_deploy_hash_mismatch/);
  assert.doesNotMatch(runner, /for \(let radius = 1; radius <= 12/);
  assert.match(runner, /freshPostcondition: \{ targetGone \}/);
  assert.match(runner, /entry\?\.executionId === accepted\.executionId && entry\?\.requestId === accepted\.requestId/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local pet-animal fixture establishes only an unpetted native Pet precondition", async (t) => {
  const options = { ...(await createFixture(t, "pet-animal")), action: "pet_animal" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["pet_animal"]);
  assert.deepEqual(configured.ExperimentalActions, ["pet_animal"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_pet_animal_v1");

  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf("private void InitializeNativeLocalPetFixture");
  const setup = entry.slice(
    setupStart,
    entry.indexOf("private static Vector2? FindNativeLocalFarmFixtureTile", setupStart),
  );
  assert.match(setup, /player\.Items\[player\.CurrentToolIndex\] = null/);
  assert.match(setup, /fixture_native_local_pet_hands_not_empty/);
  assert.match(setup, /new\(\(int\)targetTile\.Value\.X, \(int\)targetTile\.Value\.Y, "0", "Dog"\)/);
  assert.match(setup, /pet\.grantedFriendshipForPet\.Value = false/);
  assert.match(setup, /pet\.friendshipTowardFarmer\.Value = 0/);
  assert.match(setup, /location\.addCharacter\(pet\)/);
  assert.doesNotMatch(setup, /RequestLocalPetAnimal|PublishReceipt/);

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-pet-animal-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["cancel_active_execution", "inspect_self", "pet_animal"\]/);
  assert.match(runner, /target\.friendship !== 0 \|\| target\.pettedToday !== false/);
  assert.match(runner, /evidence\.friendship_before === "0"/);
  assert.match(runner, /evidence\.friendship_after === "12"/);
  assert.match(runner, /evidence\.day_recorded === "true"/);
  assert.match(runner, /evidence\.friendship_callback === "true"/);
  assert.match(runner, /targetGone/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local npc-relationship fixture establishes an unchanged persisted fact and native villager target", async (t) => {
  const options = { ...(await createFixture(t, "npc-relationship")), action: "npc_relationship" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "npc_relationship"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_npc_relationship_v1");

  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf("private void InitializeNativeLocalNpcRelationshipFixture");
  const setup = entry.slice(setupStart, entry.indexOf("private void InitializeNativeLocalPetFixture", setupStart));
  assert.match(setup, /const string npcName = "Robin"/);
  assert.match(setup, /FindNativeLocalFarmFixtureTile\(farm, new Vector2\(farmWarp\.TargetX, farmWarp\.TargetY\), 6/);
  assert.match(setup, /relationship = new Friendship\(\)/);
  assert.match(setup, /relationship\.Clear\(\)/);
  assert.match(setup, /relationship\.Points = 250/);
  assert.match(setup, /Game1\.warpCharacter\(npc, farm, targetTile\.Value\)/);
  assert.match(
    setup,
    /actual\.Points != 250 \|\| actual\.TalkedToToday \|\| actual\.GiftsToday != 0 \|\| actual\.GiftsThisWeek != 0/,
  );
  assert.doesNotMatch(setup, /RequestLocalInspectNpcRelationship|PublishReceipt|friendshipData\.Remove/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-npc-relationship-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /travelFreshHop\(snapshot, "FarmHouse", "Farm", "farmhouse_to_farm"\)/);
  assert.match(runner, /chooseOnlyFreshFixtureTarget/);
  assert.match(runner, /target\.npcName !== "Robin" \|\| target\.friendshipPoints !== 250/);
  assert.match(runner, /moveToLiveTarget\(target, "move_to_npc_relationship_fixture"\)/);
  assert.match(
    runner,
    /accepted\.state !== "accepted" && !\(accepted\.state === "succeeded" && accepted\.reasonCode === "npc_relationship_inspected"\)/,
  );
  assert.match(runner, /nearestCardinalApproach\(snapshot\.tile, current\)/);
  assert.match(runner, /withinRadius\(snapshot\.tile, target, 6\)/);
  assert.doesNotMatch(runner, /travelToTown/);
  const executions = await readFile(new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url), "utf8");
  assert.match(executions, /IsTileWithinChebyshevRadius\(player, \(int\)npc\.Tile\.X, \(int\)npc\.Tile\.Y, 6\)/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local tree-first-hit fixture configures its isolated profile and restores managed files", async (t) => {
  const options = { ...(await createFixture(t, "tree-first-hit")), action: "tree_first_hit" };

  const prepared = await prepareNativeLocalPlayerFixture(options);
  assert.equal(prepared.state, "prepared");
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "tree_first_hit"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_tree_first_hit_v1");
  assert.equal(configured.NativeLocalPlayerFixture.ObservedSaveSlot, saveName);
  assert.equal(configured.NativeLocalPlayerFixture.Bootstrap, undefined);
  for (const name of BUNDLE_FILES) assert.equal(await readFile(join(options.modRoot, name), "utf8"), `release-${name}`);

  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setup = entry.slice(
    entry.indexOf('fixture.FixtureScenario is "native_tree_first_hit_v1" or "native_chop_tree_source_v1"'),
    entry.indexOf('fixture.FixtureScenario == "native_use_item_v1"'),
  );
  assert.match(setup, /float fixtureHealth = fixture\.FixtureScenario == "native_chop_tree_source_v1" \? 1f : 10f/);
  assert.match(setup, /tree\.health\.Value = fixtureHealth/);
  assert.doesNotMatch(setup, /DoFunction|RequestLocalTreeFirstHit|PublishReceipt/);
  assert.match(setup, /production alone invokes exactly one Axe hit and emits receipt/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-tree-first-hit-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "equip_tool", "tree_first_hit"\]/);
  assert.match(runner, /evidence\.before === "10"/);
  assert.match(runner, /evidence\.after === "9"/);
  assert.match(runner, /evidence\.delta === "-1"/);
  assert.match(runner, /reread\?\.health === 9/);

  const restored = await restoreNativeLocalPlayerFixture(options);
  assert.deepEqual(restored, { state: "restored", backup: prepared.backup, backupRemoved: true });
  assert.equal(await readFile(join(options.modRoot, "config.json"), "utf8"), options.originalConfigBytes);
  for (const name of BUNDLE_FILES)
    assert.equal(await readFile(join(options.modRoot, name), "utf8"), `original-${name}`);
  await assert.rejects(readFile(prepared.backup), { code: "ENOENT" });
  await assert.rejects(readFile(join(options.root, ".stardew-native-local-player-fixture.lock", "transaction.json")), {
    code: "ENOENT",
  });
});

test("native-local chop-tree-source fixture establishes only the terminal-tree precondition", async (t) => {
  const options = { ...(await createFixture(t, "chop-tree-source")), action: "chop_tree_source" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "chop_tree_source"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_chop_tree_source_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setup = entry.slice(
    entry.indexOf('fixture.FixtureScenario is "native_tree_first_hit_v1" or "native_chop_tree_source_v1"'),
    entry.indexOf('fixture.FixtureScenario == "native_use_item_v1"'),
  );
  assert.match(setup, /float fixtureHealth = fixture\.FixtureScenario == "native_chop_tree_source_v1" \? 1f : 10f/);
  assert.match(setup, /tree\.health\.Value = fixtureHealth/);
  assert.doesNotMatch(setup, /DoFunction|RequestLocalChopTreeSource|performTreeFall|PublishReceipt/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-chop-tree-source-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "equip_tool", "chop_tree_source"\]/);
  assert.match(runner, /treeChopSourceTargets/);
  assert.match(runner, /treeChopResultTargets/);
  assert.match(runner, /evidence\.health_before === "1"/);
  assert.match(runner, /evidence\.health_after === "5"/);
  assert.match(runner, /evidence\.stump_after === "true"/);
  assert.match(runner, /evidence\.source_transformed === "true"/);
  assert.match(runner, /reread\?\.health === 5/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local refill-watering-can fixture remains isolated and pre-action only", async (t) => {
  const options = { ...(await createFixture(t, "refill-watering-can")), action: "refill_watering_can" };
  const prepared = await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "equip_tool", "refill_watering_can"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_refill_watering_can_v1");
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setup = entry.slice(
    entry.indexOf('fixture.FixtureScenario == "native_refill_watering_can_v1"'),
    entry.indexOf('fixture.FixtureScenario != "native_water_crop_v1"'),
  );
  assert.ok(setup.includes("suppliedCan.WaterLeft = Math.Max(1, suppliedCan.waterCanMax - 1)"));
  assert.match(setup, /farmHouse\.map\.GetLayer\("Back"\)/);
  assert.match(setup, /Properties\["WaterSource"\] = "GameBuddyNativeLocalFixture"/);
  assert.match(setup, /farmHouse\.doesTileHaveProperty\(sourceTile\.X, sourceTile\.Y, "WaterSource", "Back"\)/);
  assert.match(setup, /farmHouse\.CanRefillWateringCanOnTile\(sourceTile\.X, sourceTile\.Y\)/);
  assert.doesNotMatch(
    setup,
    /DoFunction|RequestLocalRefillWateringCan|PublishReceipt|WaterLeft = suppliedCan.waterCanMax/,
  );
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-refill-watering-can-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /["move_to_tile", "equip_tool", "refill_watering_can"]/);
  assert.ok(runner.includes("evidence.water_after === String(freshCan.max)"));
  assert.ok(runner.includes("reread?.water === freshCan.max"));
  assert.match(runner, /receipt\.executionId === accepted\.executionId/);
  assert.match(runner, /receipt\.requestId === accepted\.requestId/);
  assert.match(runner, /terminal\.state !== "succeeded" \|\| terminal\.reasonCode !== "target_reached"/);
  assert.match(runner, /evidence\.target === `\$\{target\.x\},\$\{target\.y\}`/);
  assert.match(runner, /evidence\.arrival === "exact"/);
  assert.match(runner, /phase: "move_terminal"/);
  const executionManager = await readFile(
    new URL("../integrations/stardew/ExecutionManager.cs", import.meta.url),
    "utf8",
  );
  const discoveryStart = executionManager.indexOf(
    "private static IReadOnlyList<BridgeRefillWateringCanTarget> DiscoverRefillWateringCanTargets",
  );
  const discovery = executionManager.slice(
    discoveryStart,
    executionManager.indexOf("BuildRefillWateringCanTargetId", discoveryStart),
  );
  assert.match(discovery, /Math\.Min\(1000, player\.TilePoint\.X \+ 1\)/);
  assert.match(discovery, /Math\.Min\(1000, player\.TilePoint\.Y \+ 1\)/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local collect-animal-product fixture establishes only the approved pre-attachment state", async (t) => {
  const options = { ...(await createFixture(t, "collect-animal-product")), action: "collect_animal_product" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["collect_animal_product"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_collect_animal_product_v1");

  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_collect_animal_product_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_refill_watering_can_v1")', setupStart),
  );
  assert.match(setup, /parseDebugInput\("SetupBigFarm", null\)/);
  assert.match(setup, /candidate\.Animal\.isAdult\(\) && candidate\.Animal\.currentProduce\.Value is not null/);
  assert.match(setup, /CanGetProduceWithTool\(new MilkPail\(\)\)/);
  assert.match(setup, /CanGetProduceWithTool\(new Shears\(\)\)/);
  assert.match(setup, /player\.addItemToInventory\(compatible\.Value\.Tool\)/);
  assert.match(setup, /player\.warpFarmer\(/);
  assert.match(setup, /NativeLocalCollectAnimalProductFixturePending/);
  assert.doesNotMatch(
    setup,
    /BeginUsingTool|DoFunction|RequestLocalCollectAnimalProduct|PublishReceipt|currentProduce\.Value =|addItemToInventory\(produce/,
  );
  const warpedStart = entry.indexOf("private void OnWarped");
  const warped = entry.slice(
    entry.indexOf("if (this.nativeLocalCollectAnimalProductFixturePending", warpedStart),
    entry.indexOf("if (this.nativeLocalFeedFixturePending", warpedStart),
  );
  assert.match(warped, /animal\.isAdult\(\) && animal\.currentProduce\.Value == productPending\.ProduceId/);
  assert.doesNotMatch(
    warped,
    /BeginUsingTool|DoFunction|RequestLocalCollectAnimalProduct|PublishReceipt|currentProduce\.Value\s*=(?!=)|addItemToInventory/,
  );

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-collect-animal-product-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["collect_animal_product"\]/);
  assert.match(runner, /entry\.executionId === accepted\.executionId && entry\.requestId === accepted\.requestId/);
  assert.match(
    runner,
    /targets\.sort\(\(left, right\) => left\.y - right\.y \|\| left\.x - right\.x \|\| left\.targetId\.localeCompare\(right\.targetId\)\)/,
  );
  assert.match(runner, /evidence\.produce_cleared === "true"/);
  assert.match(runner, /evidence\.inventory_gained === "true"/);
  assert.match(runner, /evidence\.animation_complete === "true"/);
  assert.match(runner, /countQualifiedInventory\(before, target\.qualifiedProduceItemId\)/);
  assert.match(runner, /countQualifiedInventory\(after, target\.qualifiedProduceItemId\)/);
  assert.match(runner, /inventoryGainedFresh/);
  assert.match(runner, /inventoryItemFacts/);
  assert.match(runner, /targetGone/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local feed-animal fixture is isolated, pre-bridge only, and requires typed navigation evidence", async (t) => {
  const options = { ...(await createFixture(t, "feed-animal")), action: "feed_animal" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "enter_exit", "feed_animal"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_feed_animal_v1");

  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const setupStart = entry.lastIndexOf('if (fixture.FixtureScenario == "native_feed_animal_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('fixture.FixtureScenario == "native_refill_watering_can_v1"', setupStart),
  );
  assert.match(setup, /parseDebugInput\("SetupBigFarm", null\)/);
  assert.match(setup, /GetIndoors\(\) is StardewValley\.AnimalHouse/);
  assert.match(setup, /configuredBarns/);
  assert.match(setup, /building\.buildingType\.Value, "Deluxe Barn"/);
  assert.match(setup, /building\.tileX\.Value == 16/);
  assert.match(setup, /building\.tileY\.Value == 9/);
  assert.doesNotMatch(setup, /NameOrUniqueName, "Barn"/);
  assert.match(setup, /getPointForHumanDoor\(\)/);
  assert.match(setup, /getWarpFromDoor/);
  assert.match(setup, /emptyTroughs/);
  assert.match(setup, /standingCandidates/);
  assert.match(setup, /player\.warpFarmer\(/);
  assert.match(setup, /NativeLocalFeedFixturePending/);
  assert.match(entry, /fixture_native_feed_animal_trough_approach_unreachable/);
  assert.match(entry, /addItemToInventory\(ItemRegistry\.Create<StardewValley\.Object>\("\(O\)178", 2\)\)/);
  assert.doesNotMatch(setup, /RequestLocalFeedAnimal|PublishReceipt|hay_before|hay_after|objects\.Add|objects\[/);

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-feed-animal-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "enter_exit", "feed_animal"\]/);
  assert.match(runner, /travel_to_farm/);
  assert.match(runner, /enter_animal_house/);
  assert.match(runner, /awaitSetupBigFarmFirstDeluxeBarnDoor/);
  assert.match(runner, /awaitActionableSnapshotAfterEnter/);
  assert.match(runner, /native_local_feed_animal_post_enter_not_actionable/);
  assert.match(runner, /const deadline = Date\.now\(\) \+ 5_000/);
  assert.match(runner, /await delay\(100\)/);
  assert.match(runner, /isSetupBigFarmFirstDeluxeBarnDoor/);
  assert.match(runner, /entry\.sourceX === 17/);
  assert.match(runner, /entry\.sourceY === 12/);
  assert.match(runner, /\^Barn3\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/);
  assert.doesNotMatch(runner, /entry\.targetLocation === "Barn"/);
  assert.match(runner, /moveAdjacentToDoor/);
  assert.match(runner, /move_to_animal_house_entry_\$\{candidate\.x\}_\$\{candidate\.y\}/);
  assert.match(runner, /accepted\.state === "rejected" && accepted\.reasonCode === "no_native_path"/);
  assert.match(runner, /no_native_path_to_animal_house_entry/);
  assert.match(runner, /chooseSingleFeedTarget/);
  assert.match(runner, /targets\.sort\(\(left, right\) => left\.y - right\.y \|\| left\.x - right\.x/);
  assert.match(runner, /no_live_empty_feed_trough_target/);
  assert.match(runner, /sameIdentity\(entry, accepted\)/);
  assert.match(runner, /evidence\.hay_after\) === target\.hayStack - 1/);
  assert.match(runner, /evidence\.trough_filled === "true"/);
  assert.match(runner, /targetGone/);
  assert.match(runner, /native_local_feed_animal_topology_invalid/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local fixture topology refusal returns before scenario setup while valid topology remains allowed", async () => {
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const methodStart = entry.indexOf("private void TryInitializeNativeLocalPlayerFixture()");
  const methodEnd = entry.indexOf("private void TryBootstrapNativeLocalPlayerFixture", methodStart);
  const method = entry.slice(methodStart, methodEnd);

  assert.notEqual(methodStart, -1);
  assert.notEqual(methodEnd, -1);
  assert.match(
    method,
    /if \(Context\.IsMultiplayer[\s\S]*?this\.nativeLocalPlayerFixtureTerminal = true;[\s\S]*?LogLevel\.Error\);\s*return;\s*}\s*this\.TryInitializeNativeLocalPlayerFixtureScenario\(fixture\);/,
  );
  assert.match(
    method,
    /}\s*this\.TryInitializeNativeLocalPlayerFixtureScenario\(fixture\);[\s\S]*?\/\/ The shared embodiment initializes only after the native load/,
  );
});

test("native-local fixture setup fails closed while any warp continuation is pending", async () => {
  const entry = await readFile(new URL("../integrations/stardew/ModEntry.cs", import.meta.url), "utf8");
  const methodStart = entry.indexOf("private void TryInitializeNativeLocalPlayerFixtureScenario");
  const method = entry.slice(methodStart);
  const guardStart = method.indexOf("if (this.nativeLocalFeedFixturePending is not null");
  const scenarioSetupStart = method.indexOf('if (fixture.FixtureScenario == "native_npc_relationship_v1")');

  assert.notEqual(methodStart, -1);
  assert.notEqual(guardStart, -1);
  assert.notEqual(scenarioSetupStart, -1);
  assert.ok(guardStart < scenarioSetupStart, "pending continuation guard must precede scenario setup");
  for (const pendingField of [
    "nativeLocalFeedFixturePending",
    "nativeLocalCollectAnimalProductFixturePending",
    "nativeLocalClearHoeDirtFixturePending",
    "nativeLocalDigArtifactSpotFixturePending",
  ]) {
    assert.match(method.slice(guardStart, scenarioSetupStart), new RegExp(`${pendingField} is not null`));
  }
});

test("native-local fixture restore fails closed when a registered backup is tampered", async (t) => {
  const options = { ...(await createFixture(t, "tampered-restore")), action: "tree_first_hit" };
  const prepared = await prepareNativeLocalPlayerFixture(options);
  const preparedConfig = await readFile(join(options.modRoot, "config.json"), "utf8");
  await writeFile(join(prepared.backup, "config.json.backup"), "tampered backup");

  await assert.rejects(restoreNativeLocalPlayerFixture(options), /fixture_backup_hash_mismatch:config\.json/);
  assert.equal(await readFile(join(options.modRoot, "config.json"), "utf8"), preparedConfig);
  assert.equal(await readFile(join(prepared.backup, "config.json.backup"), "utf8"), "tampered backup");
  assert.ok(
    await readFile(join(options.root, ".stardew-native-local-player-fixture.lock", "transaction.json"), "utf8"),
  );
});
