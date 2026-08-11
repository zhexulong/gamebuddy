import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

const SCENARIO = "native_water_crop_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "water_crop"];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "travel", "water_crop"].sort();
const TERMINAL_STATES = new Set(["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"]);

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
validateNativeLocalConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  requireExactCapabilities(client.state.capabilities, "hello");
  let snapshot = await observeActionable();
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);

  const wateringCan = chooseWateringCan(snapshot);
  const equipped = await execute("equip_watering_can", "equip_tool", { slot: wateringCan.slot }, snapshot);
  const equipTerminal = await terminalForRequest(equipped, 5_000);
  if (equipTerminal.state !== "succeeded" || equipTerminal.reasonCode !== "tool_selected") throw new Error(`watering_can_equip_failed:${equipTerminal.reasonCode}`);
  const equipEvidence = parseEvidence(equipTerminal.evidence, ["after", "before", "expected", "slot"]);
  if (equipEvidence.expected !== wateringCan.label || equipEvidence.after !== wateringCan.label) throw new Error("watering_can_equip_evidence_mismatch");

  snapshot = await observeActionable();
  if (snapshot.currentTool !== wateringCan.label) throw new Error("watering_can_postcondition_missing");
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  snapshot = await moveToReachableCrop(snapshot);
  snapshot = await waitForActionable(snapshot, 3_000);
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("player_not_actionable_before_water_crop");

  // Bind the opaque target from the fresh snapshot immediately preceding the
  // request. The fixture does not provide a coordinate or target ID to this
  // runner, and the Mod revalidates this binding on the game thread.
  const target = chooseOnlyReachableCrop(snapshot);
  const cropTargetCountBefore = snapshot.cropTargets.length;
  if (cropTargetCountBefore !== 1) throw new Error(`native_local_water_crop_fixture_target_count_before:${cropTargetCountBefore}`);
  const requestId = `native_local_water_crop_water_${Date.now()}_${trace.length}`;
  const idempotencyKey = `${requestId}_idem`;
  const accepted = await execute("water", "water_crop", { x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot, requestId, idempotencyKey);
  const terminal = await terminalForRequest(accepted, 5_000);
  const evidence = parseEvidence(terminal.evidence, ["after_watered", "before_watered", "location", "target", "tile", "water_after", "water_before", "water_consumed"]);
  const after = await waitForWaterPostcondition(terminal, snapshot, target, 5_000);
  const cropTargetCountAfter = Array.isArray(after.cropTargets) ? after.cropTargets.length : -1;
  const sourceTargetGone = cropTargetCountAfter === 0
    && after.cropTargets.every((entry) => entry?.targetId !== target.targetId && (entry?.x !== target.x || entry?.y !== target.y));
  const waterBefore = Number(evidence.water_before);
  const waterAfter = Number(evidence.water_after);
  const preciseWaterDelta = Number.isSafeInteger(waterBefore) && Number.isSafeInteger(waterAfter)
    && waterBefore > 0 && waterAfter === waterBefore - 1 && evidence.water_consumed === "true";
  const evidenceBound = evidence.location === snapshot.location
    && evidence.target === target.targetId
    && evidence.tile === `${target.x},${target.y}`
    && evidence.before_watered === "false"
    && evidence.after_watered === "true";
  const freshPostcondition = after.revision === terminal.revision
    && after.actionable === true
    && after.activeExecution == null
    && after.location === snapshot.location
    && sameTile(after.tile, snapshot.tile)
    && sourceTargetGone;
  const passed = terminal.state === "succeeded"
    && terminal.reasonCode === "crop_watered"
    && evidenceBound
    && preciseWaterDelta
    && freshPostcondition;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? "crop_watered" : "water_crop_postcondition_mismatch", target, receipt: summarizeReceipt(terminal), evidence, preciseWaterDelta, cropTargetCountBefore, cropTargetCountAfter, sourceTargetGone, freshPostcondition, trace, before: summarize(snapshot), after: summarize(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state.latestReceipt), trace }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function execute(phase, action, args, snapshot, requestId = `native_local_water_crop_${phase}_${Date.now()}_${trace.length}`, idempotencyKey = `${requestId}_idem`) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const receipt = await client.execute({ requestId, idempotencyKey, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  if (!receiptMatchesRequest(receipt, requestId)) throw new Error(`${phase}_receipt_correlation_mismatch`);
  if (!receipts.some((entry) => receiptMatchesRequest(entry, requestId, receipt.executionId) && entry.state === receipt.state)) receipts.push(receipt);
  trace.push({ phase, action, args, requestId, idempotencyKey, receipt: summarizeReceipt(receipt) });
  return receipt;
}
async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await terminalForRequest(accepted, 15_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed") throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshActionablePostcondition(terminal, (latest) => latest.location === "Farm" && latest.activeExecution == null, 5_000);
}
async function move(snapshot, target, phase) {
  snapshot = await waitForActionable(snapshot, 10_000);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await terminalForRequest(accepted, 55_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached") throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  return waitForFreshActionablePostcondition(terminal, (latest) => latest.activeExecution == null && adjacent(latest.tile, target), 5_000);
}
async function moveToReachableCrop(snapshot) {
  if (chooseOnlyReachableCropOrNull(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
    for (const waypoint of candidates) {
      try {
        const moved = await move(snapshot, waypoint, "move_to_native_water_crop_fixture");
        if (chooseOnlyReachableCropOrNull(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path") && !reason.startsWith("move_to_native_water_crop_fixture_failed:no_native_path")) throw error;
        snapshot = await observeActionable();
        if (chooseOnlyReachableCropOrNull(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_water_crop_fixture_target");
}
function chooseOnlyReachableCrop(snapshot) {
  const targets = validCropTargets(snapshot);
  if (targets.length !== 1) throw new Error(targets.length === 0 ? "no_adjacent_live_crop_target" : "ambiguous_adjacent_live_crop_targets");
  return targets[0];
}
function chooseOnlyReachableCropOrNull(snapshot) {
  const targets = validCropTargets(snapshot);
  return targets.length === 1 ? targets[0] : null;
}
function validCropTargets(snapshot) {
  return (snapshot.cropTargets ?? []).filter((target) => /^crop_[a-f0-9]{16}$/.test(target?.targetId ?? "") && Number.isInteger(target.x) && Number.isInteger(target.y) && target.x >= 0 && target.y >= 0 && typeof target.cropId === "string" && target.cropId.length > 0 && adjacent(snapshot.tile, target));
}
function chooseWateringCan(snapshot) {
  const cans = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && typeof entry.label === "string" && isWateringCanLabel(entry.label));
  if (cans.length !== 1) throw new Error(cans.length === 0 ? "watering_can_not_found_in_live_tool_slots" : "ambiguous_live_watering_can_slots");
  return cans[0];
}
function isWateringCanLabel(label) { return typeof label === "string" && label.replaceAll(/[^a-z0-9]/gi, "").toLowerCase().includes("wateringcan"); }
async function observeActionable() {
  const snapshot = await client.observe();
  requireExactCapabilities(snapshot.capabilities, "snapshot");
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("native_local_water_crop_player_not_actionable");
  if (!Number.isInteger(snapshot.revision) || typeof snapshot.location !== "string" || !Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y) || !Array.isArray(snapshot.cropTargets) || !Array.isArray(snapshot.warps)) throw new Error("native_local_water_crop_snapshot_invalid");
  return snapshot;
}
async function waitForActionable(snapshot, timeoutMs) { const deadline = Date.now() + timeoutMs; let latest = snapshot; while (Date.now() < deadline) { if (latest.actionable && latest.activeExecution == null) return latest; await delay(250); latest = await client.observe(); } return latest; }
async function terminalForRequest(receipt, timeoutMs) {
  if (!receiptMatchesRequest(receipt, receipt?.requestId)) throw new Error("receipt_identity_mismatch");
  if (isTerminal(receipt.state)) return receipt;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = receipts.find((entry) => receiptMatchesRequest(entry, receipt.requestId, receipt.executionId) && isTerminal(entry.state));
    if (terminal) return terminal;
    await delay(100);
  }
  throw new Error(`terminal_receipt_timeout:${receipt.executionId}`);
}
async function waitForFreshActionablePostcondition(receipt, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await observeActionable();
    if (latest.revision >= receipt.revision && predicate(latest)) return latest;
    await delay(100);
  }
  throw new Error(`postcondition_timeout:${receipt.executionId}`);
}
async function waitForWaterPostcondition(receipt, before, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await observeActionable();
    if (latest.revision > receipt.revision) throw new Error(`water_crop_postcondition_revision_mismatch:${latest.revision}:${receipt.revision}`);
    if (latest.revision === receipt.revision && latest.location === before.location && sameTile(latest.tile, before.tile) && latest.cropTargets.every((entry) => entry?.targetId !== target.targetId && (entry?.x !== target.x || entry?.y !== target.y))) return latest;
    await delay(100);
  }
  throw new Error(`water_crop_postcondition_timeout:${receipt.executionId}`);
}
function parseEvidence(evidence, expectedKeys) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) throw new Error("invalid_water_crop_evidence");
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key)) throw new Error("invalid_water_crop_evidence");
    result[key] = value;
  }
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...expectedKeys].sort())) throw new Error("water_crop_evidence_keys_mismatch");
  return result;
}
function validateNativeLocalConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== SCENARIO || typeof fixture.LogicalSaveName !== "string" || !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(fixture.LogicalSaveName) || typeof fixture.ObservedSaveSlot !== "string" || !new RegExp(`^${fixture.LogicalSaveName}_[0-9]{1,32}$`).test(fixture.ObservedSaveSlot)) throw new Error("native_local_fixture_config_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated");
  if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS) || (value.ExperimentalActions?.length ?? 0) !== 0) throw new Error("native_local_water_crop_action_policy_invalid");
  if (["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some((key) => typeof value[key] !== "string" || value[key].length === 0)) throw new Error("invalid_client_config");
}
function requireExactCapabilities(actual, source) { if (!Array.isArray(actual) || JSON.stringify([...actual].sort()) !== JSON.stringify(EXPECTED_CAPABILITIES)) throw new Error(`native_local_water_crop_${source}_capability_not_isolated`); }
function receiptMatchesRequest(receipt, requestId, executionId = receipt?.executionId) { return typeof requestId === "string" && requestId.length > 0 && typeof executionId === "string" && executionId.length > 0 && receipt?.requestId === requestId && receipt?.executionId === executionId; }
function sameTile(left, right) { return Number.isInteger(left?.x) && Number.isInteger(left?.y) && left.x === right?.x && left.y === right?.y; }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function isTerminal(state) { return TERMINAL_STATES.has(state); }
function summarize(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, currentTool: snapshot.currentTool ?? null, cropTargets: snapshot.cropTargets?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function summarizeReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
