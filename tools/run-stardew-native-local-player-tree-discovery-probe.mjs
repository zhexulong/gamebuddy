import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateNativeLocalConfig(config);
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const startedAt = Date.now();

try {
  const snapshot = await client.observe();
  requireDiscoverySnapshot(snapshot);
  const candidates = (snapshot.treeShakeSourceTargets ?? []).map(targetSummary);
  console.log(
    JSON.stringify({
      state: "discovered",
      topology: "native_local_player_fixture",
      reasonCode: candidates.length === 0 ? "no_eligible_tree_target_in_fresh_snapshot" : "candidates_found",
      snapshot: snapshotSummary(snapshot),
      treeShakeSourceTargets: candidates,
      durationMs: Date.now() - startedAt,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      durationMs: Date.now() - startedAt,
    }),
  );
  process.exitCode = 2;
} finally {
  client.close();
}

function validateNativeLocalConfig(value) {
  if (
    !value ||
    value.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture.Bootstrap?.Enable === true
  )
    throw new Error("native_local_fixture_not_enabled");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  // inspect_self is provided intrinsically by BridgeSession, not configured
  // through the fixture action policy.
  if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify([]))
    throw new Error("native_local_tree_discovery_action_policy_invalid");
  if (
    ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    )
  )
    throw new Error("invalid_client_config");
}

function requireDiscoverySnapshot(snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null)
    throw new Error("native_local_tree_discovery_player_not_actionable");
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    snapshot.location.length === 0 ||
    !Number.isInteger(snapshot.tile?.x) ||
    snapshot.tile.x < 0 ||
    snapshot.tile.x > 1000 ||
    !Number.isInteger(snapshot.tile?.y) ||
    snapshot.tile.y < 0 ||
    snapshot.tile.y > 1000 ||
    !Array.isArray(snapshot.capabilities)
  )
    throw new Error("native_local_tree_discovery_snapshot_invalid");
  if (snapshot.treeShakeSourceTargets != null && !Array.isArray(snapshot.treeShakeSourceTargets))
    throw new Error("native_local_tree_discovery_targets_invalid");
  const targets = snapshot.treeShakeSourceTargets ?? [];
  const actual = [...snapshot.capabilities].sort();
  const expected = ["cancel_active_execution", "inspect_self"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("native_local_tree_discovery_capability_not_isolated");
  if (targets.length > 64 || !targets.every((target) => validTarget(target, snapshot.location)))
    throw new Error("native_local_tree_discovery_targets_invalid");
}

function validTarget(target, snapshotLocation) {
  return (
    typeof target?.targetId === "string" &&
    target.targetId.length > 0 &&
    target.targetId.length <= 256 &&
    target.location === snapshotLocation &&
    Number.isInteger(target.x) &&
    target.x >= 0 &&
    target.x <= 1000 &&
    Number.isInteger(target.y) &&
    target.y >= 0 &&
    target.y <= 1000 &&
    Number.isInteger(target.treeType) &&
    Number.isInteger(target.growthStage) &&
    typeof target.health === "number" &&
    Number.isFinite(target.health) &&
    target.health >= 0 &&
    target.moss === false &&
    target.tapped === false
  );
}
function targetSummary(target) {
  return {
    targetId: target.targetId,
    location: target.location,
    x: target.x,
    y: target.y,
    treeType: target.treeType,
    growthStage: target.growthStage,
    health: target.health,
    moss: target.moss,
    tapped: target.tapped,
  };
}
function snapshotSummary(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    capabilities: snapshot.capabilities,
    activeExecution: snapshot.activeExecution ?? null,
  };
}
function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
