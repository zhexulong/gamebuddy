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
  const targets = snapshot.debrisTargets.map((target) =>
    targetSummary(target, matchingTool(target, snapshot.toolSlots)),
  );
  if (targets.length === 0) {
    // An empty fresh snapshot is a successful read-only discovery result, not
    // a fixture or bridge failure. Discovery also filters out clumps which
    // lack a matching owned tool, so it cannot establish that the world has no
    // natural clump. This probe must not use its published movement
    // capabilities to look elsewhere; it records only the absence of an
    // executable target in this fresh snapshot without attempting an action.
    console.log(
      JSON.stringify({
        state: "discovered",
        topology: "native_local_player_fixture",
        reasonCode: "no_executable_clear_debris_target_in_fresh_snapshot",
        snapshot: snapshotSummary(snapshot),
        clearDebrisTargets: [],
        matchingTools: [],
        durationMs: Date.now() - startedAt,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        state: "discovered",
        topology: "native_local_player_fixture",
        reasonCode: "clear_debris_targets_observed",
        snapshot: snapshotSummary(snapshot),
        clearDebrisTargets: targets,
        matchingTools: targets.map(({ targetId, tool }) => ({ targetId, tool })),
        durationMs: Date.now() - startedAt,
      }),
    );
  }
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: receiptSummary(client.state.latestReceipt),
      durationMs: Date.now() - startedAt,
    }),
  );
  process.exitCode = 2;
} finally {
  client.close();
}

function validateNativeLocalConfig(value) {
  if (!value || value.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (value.NativeLocalPlayerFixture.Bootstrap?.Enable === true)
    throw new Error("native_local_fixture_bootstrap_enabled");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const requiredConfig = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredConfig.some((key) => typeof value[key] !== "string" || value[key].length === 0))
    throw new Error("invalid_client_config");
}

function requireDiscoverySnapshot(snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null)
    throw new Error("native_local_clear_debris_player_not_actionable");
  if (
    !Number.isInteger(snapshot.revision) ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y)
  )
    throw new Error("native_local_clear_debris_snapshot_invalid");
  if (
    !Array.isArray(snapshot.capabilities) ||
    !Array.isArray(snapshot.debrisTargets) ||
    !Array.isArray(snapshot.toolSlots)
  )
    throw new Error("native_local_clear_debris_snapshot_facts_missing");
  const actual = [...snapshot.capabilities].sort();
  const expected = ["cancel_active_execution", "clear_debris", "inspect_self", "move_to_tile", "travel"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("native_local_clear_debris_capability_not_isolated");
  if (!snapshot.debrisTargets.every(validTarget) || !snapshot.toolSlots.every(validToolSlot))
    throw new Error("native_local_clear_debris_snapshot_facts_invalid");
  for (const target of snapshot.debrisTargets) {
    const tool = matchingTool(target, snapshot.toolSlots);
    if (!tool) throw new Error("native_local_clear_debris_matching_tool_missing");
  }
}

function validTarget(target) {
  return (
    typeof target?.targetId === "string" &&
    target.targetId.length > 0 &&
    Number.isInteger(target.slot) &&
    target.slot >= 0 &&
    Number.isInteger(target.x) &&
    target.x >= 0 &&
    Number.isInteger(target.y) &&
    target.y >= 0 &&
    Number.isInteger(target.parentSheetIndex) &&
    target.parentSheetIndex >= 0 &&
    (target.toolKind === "axe" || target.toolKind === "pickaxe") &&
    Number.isInteger(target.requiredUpgradeLevel) &&
    target.requiredUpgradeLevel >= 0
  );
}
function validToolSlot(tool) {
  return Number.isInteger(tool?.slot) && tool.slot >= 0 && typeof tool.label === "string" && tool.label.length > 0;
}
function matchingTool(target, tools) {
  const tool = tools.find((entry) => entry.slot === target.slot);
  if (!tool || !tool.label.toLowerCase().includes(target.toolKind)) return null;
  return { slot: tool.slot, label: tool.label };
}
function targetSummary(target, tool) {
  return {
    targetId: target.targetId,
    slot: target.slot,
    x: target.x,
    y: target.y,
    parentSheetIndex: target.parentSheetIndex,
    toolKind: target.toolKind,
    requiredUpgradeLevel: target.requiredUpgradeLevel,
    tool,
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
function receiptSummary(receipt) {
  return receipt
    ? {
        executionId: receipt.executionId,
        requestId: receipt.requestId,
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        revision: receipt.revision,
        evidence: receipt.evidence ?? null,
      }
    : null;
}
function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
