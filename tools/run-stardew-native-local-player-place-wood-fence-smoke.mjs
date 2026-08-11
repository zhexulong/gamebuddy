import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0)) throw new Error("invalid_client_config");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  let snapshot = await client.observe();
  for (const action of ["place_wood_fence", "move_to_tile", "travel"]) {
    if (!snapshot.capabilities.includes(action)) throw new Error(`native_local_${action}_capability_missing`);
  }
  snapshot = await waitForActionable(snapshot, 5_000);
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  snapshot = await moveToReachableSeedTarget(snapshot);
  snapshot = await waitForActionable(snapshot, 3_000);
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("player_not_actionable_before_place");
  const target = chooseReachableWoodFenceTarget(snapshot);
  if (!target) throw new Error("no_adjacent_live_wood_fence_target");
  const receipt = await execute("place", "place_wood_fence", {
    slot: target.slot, x: target.x, y: target.y,
    expectedQualifiedItemId: target.qualifiedItemId, expectedTargetId: target.targetId,
  }, snapshot);
  const after = await waitForActionable(await client.observe(), 5_000);
  const evidence = parseStrictEvidence(receipt.evidence);
  const resultFence = after.woodFenceResultTargets?.find((entry) => entry.targetId === target.targetId);
  const resultMatches = resultFence !== undefined && resultFence.location === target.location && resultFence.x === target.x && resultFence.y === target.y
    && resultFence.slot === target.slot && resultFence.targetId === target.targetId && resultFence.qualifiedItemId === target.qualifiedItemId
    && resultFence.isFence === true && resultFence.isGate === false
    && Number.isFinite(resultFence.health) && resultFence.health === Number(evidence.health)
    && Number.isFinite(resultFence.maxHealth) && resultFence.maxHealth === Number(evidence.max_health) && resultFence.maxHealth >= resultFence.health;
  const evidenceMatches = evidence.source === "(O)322" && evidence.location === target.location && Number(evidence.x) === target.x && Number(evidence.y) === target.y
    && evidence.target === target.targetId && evidence.item === target.qualifiedItemId && Number(evidence.slot) === target.slot
    && evidence.source_empty_before === "true" && evidence.is_fence === "true" && evidence.is_gate === "false"
    && Number.isFinite(Number(evidence.health)) && Number(evidence.health) > 0 && Number.isFinite(Number(evidence.max_health))
    && Number(evidence.max_health) >= Number(evidence.health);
  const stackDeltaProven = Number(evidence.inventory_before) === 1 && Number(evidence.inventory_after) === 0;
  const passed = receipt.state === "succeeded" && receipt.reasonCode === "wood_fence_placed"
    && typeof receipt.executionId === "string" && receipt.executionId.length > 0
    && evidenceMatches && stackDeltaProven && resultMatches && after.revision === receipt.revision
    && after.actionable && after.activeExecution == null;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "wood_fence_placed" : receipt.reasonCode, target, receipt: summarizeReceipt(receipt), evidence, resultFence, evidenceMatches, resultMatches, stackDeltaProven, trace, before: summarize(snapshot), after: summarize(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state.latestReceipt), trace }));
  process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

async function execute(phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_place_wood_fence_${phase}_${Date.now()}`;
  const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  if (receipt.requestId !== requestId || receipt.revision < snapshot.revision || typeof receipt.executionId !== "string" || receipt.executionId.length === 0) throw new Error(`${phase}_receipt_identity_mismatch`);
  trace.push({ phase, requestId, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}
async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(accepted.executionId, (latest) => latest.location === "Farm" && latest.activeExecution == null, 15_000);
}
async function move(snapshot, target, phase) {
  snapshot = await waitForActionable(snapshot, 10_000);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(accepted.executionId, (latest) => latest.activeExecution == null && adjacent(latest.tile, target), 55_000);
}
async function moveToReachableSeedTarget(snapshot) {
  if (chooseReachableWoodFenceTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
    for (const waypoint of candidates) {
      try {
        const moved = await move(snapshot, waypoint, "move_to_native_place_wood_fence_fixture");
        if (chooseReachableWoodFenceTarget(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path")) throw error;
        snapshot = await client.observe();
        if (chooseReachableWoodFenceTarget(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_place_wood_fence_fixture_target");
}
function chooseReachableWoodFenceTarget(snapshot) { return snapshot.woodFenceTargets?.find((target) => Number.isInteger(target.slot) && Number.isInteger(target.x) && Number.isInteger(target.y) && typeof target.targetId === "string" && typeof target.qualifiedItemId === "string" && adjacent(snapshot.tile, target)) ?? null; }
async function waitForActionable(snapshot, timeoutMs) { const deadline = Date.now() + timeoutMs; let latest = snapshot; while (Date.now() < deadline) { if (latest.actionable && latest.activeExecution == null) return latest; await delay(250); latest = await client.observe(); } return latest; }
async function waitForReceiptAndSnapshot(executionId, predicate, timeoutMs) { const deadline = Date.now() + timeoutMs; let latest = await client.observe(); while (Date.now() < deadline) { const terminal = receipts.find((receipt) => receipt.executionId === executionId && receipt.state !== "accepted" && isTerminal(receipt.state)); if (terminal && terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`); if (terminal?.state === "succeeded" && predicate(latest)) return latest; await delay(200); latest = await client.observe(); } throw new Error(`navigation_timeout:${executionId}`); }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const index = field.indexOf("=");
    const key = index > 0 ? field.slice(0, index) : "";
    if (index <= 0 || index === field.length - 1 || !/^[a-z][a-z0-9_]{0,63}$/.test(key) || result[key] !== undefined) throw new Error("malformed_or_duplicate_fence_evidence");
    result[key] = field.slice(index + 1);
  }
  const expectedKeys = ["source", "location", "x", "y", "target", "item", "slot", "source_empty_before", "is_fence", "is_gate", "health", "max_health", "inventory_before", "inventory_after"];
  if (Object.keys(result).length !== expectedKeys.length || !expectedKeys.every((key) => result[key] !== undefined)) throw new Error("unknown_or_incomplete_fence_evidence");
  return result;
}
function summarize(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, woodFenceTargets: snapshot.woodFenceTargets?.length ?? 0, woodFenceResultTargets: snapshot.woodFenceResultTargets?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function summarizeReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
