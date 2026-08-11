import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

const SCENARIO = "native_till_soil_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "till_soil"];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "travel", "till_soil"].sort();

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
validateNativeLocalFixtureConfig(config);
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0)) throw new Error("invalid_client_config");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  requireExactCapabilities(client.state.capabilities, "hello");
  let snapshot = await observe();
  const hoeSlot = snapshot.toolSlots?.find((entry) => typeof entry.label === "string" && entry.label.toLowerCase().includes("hoe"))?.slot;
  if (!Number.isInteger(hoeSlot)) throw new Error("hoe_not_found_in_live_tool_slots");
  const equipped = await execute("equip_hoe", "equip_tool", { slot: hoeSlot }, snapshot);
  if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected") throw new Error(`hoe_equip_failed:${equipped.reasonCode}`);
  snapshot = await observe();
  if (!snapshot.currentTool?.toLowerCase().includes("hoe")) throw new Error("hoe_postcondition_missing");
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  // Native fixture setup only creates legal bare Farm ground. This movement is
  // a separate shared action; the subsequent fresh snapshot publishes soil.
  snapshot = await moveToReachableSoil(snapshot);
  snapshot = await waitForActionable(snapshot, 3_000);
  if (snapshot.actionable !== true || snapshot.activeExecution != null) throw new Error(`player_not_actionable_after_navigation:location=${snapshot.location};tile=${snapshot.tile?.x},${snapshot.tile?.y};active=${snapshot.activeExecution?.state ?? "none"}`);
  const target = chooseReachableSoilTile(snapshot);
  if (target === null) throw new Error("no_adjacent_live_soil_tile");
  if (snapshot.location !== "Farm" || !snapshot.soilTiles.some((entry) => entry.x === target.x && entry.y === target.y)) throw new Error("till_before_snapshot_target_not_bound");
  const accepted = await execute("till", "till_soil", target, snapshot);
  const receipt = await waitForTerminalReceipt(accepted, 5_000);
  if (receipt.state !== "succeeded" || receipt.reasonCode !== "soil_tilled") throw new Error(`till_failed:${receipt.reasonCode}`);
  const evidence = parseStrictEvidence(receipt.evidence);
  const after = await waitForTillPostcondition(receipt, snapshot, target, 5_000);
  const evidenceTarget = parseTargetCoordinates(evidence.target);
  const freshTargetGone = Array.isArray(after.soilTiles)
    && !after.soilTiles.some((entry) => entry?.x === target.x && entry?.y === target.y);
  const passed = evidence.location === snapshot.location
    && evidenceTarget.x === target.x && evidenceTarget.y === target.y
    && evidence.before === "none" && evidence.after === "HoeDirt"
    && after.revision === receipt.revision
    && after.actionable === true && after.activeExecution == null
    && after.location === snapshot.location
    && sameTile(after.tile, snapshot.tile)
    && freshTargetGone;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "soil_tilled" : "till_postcondition_mismatch", target, receipt: summarizeReceipt(receipt), evidence, evidenceTarget, freshTargetGone, trace, before: summarize(snapshot), after: summarize(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state.latestReceipt), trace }));
  process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

async function execute(phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_till_${phase}_${nonce}`;
  const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  if (!receiptMatchesRequest(receipt, requestId)) throw new Error(`${phase}_receipt_correlation_mismatch`);
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}
async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return (await waitForReceiptAndSnapshot(accepted, (latest) => latest.location === "Farm" && latest.activeExecution == null, 15_000)).snapshot;
}
async function move(snapshot, target, phase) {
  snapshot = await waitForActionable(snapshot, 10_000);
  if (!snapshot.actionable) throw new Error(`${phase}_player_not_actionable:location=${snapshot.location};tile=${snapshot.tile?.x},${snapshot.tile?.y};active=${snapshot.activeExecution?.state ?? "none"}`);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  return (await waitForReceiptAndSnapshot(accepted, (latest) => latest.activeExecution == null && adjacent(latest.tile, target), 55_000)).snapshot;
}
async function moveToReachableSoil(snapshot) {
  if (chooseReachableSoilTile(snapshot)) return snapshot;
  // The production snapshot intentionally publishes only the nine actionable
  // tiles around the Player. Search bounded nearby native movement waypoints
  // and rediscover after every movement; fixture setup never selects/tills the
  // final target, and the fresh snapshot remains authoritative.
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    }
    for (const waypoint of candidates) {
      try {
        const moved = await move(snapshot, waypoint, "move_to_native_till_fixture_ground");
        if (chooseReachableSoilTile(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path")) throw error;
        // A rejected request advances the bridge observation revision. Refresh
        // before considering another native waypoint; reuse of the rejected
        // snapshot would correctly fail closed as stale_snapshot.
        snapshot = await observe();
        if (chooseReachableSoilTile(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_till_fixture_ground");
}
function chooseReachableSoilTile(snapshot) { return snapshot.soilTiles?.find((tile) => Number.isInteger(tile.x) && Number.isInteger(tile.y) && adjacent(snapshot.tile, tile)) ?? null; }
async function observe() { const snapshot = await client.observe(); requireExactCapabilities(snapshot.capabilities, "observe"); return snapshot; }
async function waitForActionable(snapshot, timeoutMs) { const deadline = Date.now() + timeoutMs; let latest = snapshot; while (Date.now() < deadline) { if (latest.actionable && latest.activeExecution == null) return latest; await delay(250); latest = await observe(); } return latest; }
async function waitForReceiptAndSnapshot(accepted, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await observe();
  while (Date.now() < deadline) {
    const terminal = findTerminalReceipt(accepted);
    if (terminal && terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
    if (terminal?.state === "succeeded" && latest.actionable === true && latest.activeExecution == null && predicate(latest)) return { receipt: terminal, snapshot: latest };
    await delay(200);
    latest = await observe();
  }
  throw new Error(`navigation_timeout:${accepted.executionId}`);
}
async function waitForTerminalReceipt(accepted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = findTerminalReceipt(accepted);
    if (terminal) return terminal;
    await delay(100);
  }
  throw new Error(`terminal_receipt_timeout:${accepted.executionId}`);
}
async function waitForTillPostcondition(receipt, before, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await observe();
    if (latest.revision > receipt.revision) throw new Error(`till_postcondition_revision_mismatch:${latest.revision}:${receipt.revision}`);
    if (latest.revision === receipt.revision) {
      if (latest.actionable !== true || latest.activeExecution != null) throw new Error("till_postcondition_player_not_stable");
      if (latest.location !== before.location || !sameTile(latest.tile, before.tile)) throw new Error("till_postcondition_player_moved");
      if (!Array.isArray(latest.soilTiles)) throw new Error("till_postcondition_soil_targets_missing");
      return latest;
    }
    await delay(100);
  }
  throw new Error(`till_postcondition_timeout:${receipt.executionId}`);
}
function findTerminalReceipt(accepted) {
  if (isTerminal(accepted.state)) return accepted;
  return receipts.find((receipt) => receiptMatchesRequest(receipt, accepted.requestId, accepted.executionId) && isTerminal(receipt.state)) ?? null;
}
function receiptMatchesRequest(receipt, requestId, executionId = receipt?.executionId) {
  return typeof requestId === "string" && requestId.length > 0
    && typeof executionId === "string" && executionId.length > 0
    && receipt?.requestId === requestId && receipt?.executionId === executionId;
}
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function sameTile(left, right) { return Number.isInteger(left?.x) && Number.isInteger(left?.y) && left.x === right?.x && left.y === right?.y; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function validateNativeLocalFixtureConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== SCENARIO
    || !validFixtureSlotRelationship(fixture.LogicalSaveName, fixture.ObservedSaveSlot)) throw new Error("native_local_fixture_config_invalid");
  if (value.Portfolio?.Enable !== false || value.HostAutomation?.Enable !== false
    || value.HostFarmhandProvisioning?.Enable !== false || value.FarmhandProvisioner?.Enable !== false) throw new Error("native_local_fixture_topology_not_isolated");
  if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS)
    || JSON.stringify(value.ExperimentalActions ?? []) !== JSON.stringify([])) throw new Error("native_local_till_soil_action_policy_invalid");
}
function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return typeof logicalName === "string" && /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName)
    && typeof observedSaveSlot === "string" && new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot);
}
function requireExactCapabilities(actual, source) {
  if (!Array.isArray(actual) || JSON.stringify([...actual].sort()) !== JSON.stringify(EXPECTED_CAPABILITIES)) throw new Error(`native_local_till_soil_${source}_capability_not_isolated`);
}
function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const expected = ["location", "target", "before", "after"];
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) return {};
    const key = part.slice(0, index);
    if (Object.prototype.hasOwnProperty.call(result, key)) return {};
    result[key] = part.slice(index + 1);
  }
  return Object.keys(result).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(result, key)) ? result : {};
}
function parseTargetCoordinates(value) {
  const match = typeof value === "string" ? value.match(/^(\d+),(\d+)$/) : null;
  if (!match) return { x: null, y: null };
  return { x: Number(match[1]), y: Number(match[2]) };
}
function summarize(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, soilTiles: snapshot.soilTiles?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function summarizeReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
