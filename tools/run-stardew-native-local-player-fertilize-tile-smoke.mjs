import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
assertNativeLocalFixtureConfig(config, "native_fertilize_tile_v1");
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
  requireExactCapabilities(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  snapshot = await moveToReachableFertilizerTarget(snapshot);
  snapshot = await waitForActionable(snapshot, 3_000);
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("player_not_actionable_before_fertilize");

  // This target is freshly discovered after every prerequisite receipt. Its
  // slot and qualified item ID are the only inventory authority used here.
  const target = chooseReachableFertilizerTarget(snapshot);
  if (target === null) throw new Error("no_adjacent_live_fertilizer_target");
  const requestId = `native_local_fertilize_tile_fertilize_${Date.now()}`;
  const receipt = await execute("fertilize", "fertilize_tile", {
    slot: target.slot,
    x: target.x,
    y: target.y,
    expectedQualifiedItemId: target.qualifiedItemId,
    expectedTargetId: target.targetId,
  }, snapshot, requestId);
  const after = await client.observe();
  const evidence = parseEvidence(receipt.evidence);
  const targetGone = after.fertilizerTargets?.every((entry) => entry.targetId !== target.targetId) === true;
  const inventoryDeltaProven = Number.isSafeInteger(Number(evidence.inventory_before))
    && Number(evidence.inventory_after) === Number(evidence.inventory_before) - 1;
  const sameExecution = typeof receipt.executionId === "string" && receipt.executionId.length > 0
    && receipt.requestId === requestId;
  const freshPostcondition = Number.isInteger(after.revision) && after.revision === receipt.revision
    && after.location === snapshot.location
    && targetGone;
  const passed = receipt.state === "succeeded" && receipt.reasonCode === "fertilizer_applied"
    && sameExecution
    && evidence.location === snapshot.location
    && evidence.target === target.targetId
    && evidence.tile === `${target.x},${target.y}`
    && evidence.item === target.qualifiedItemId
    && evidence.fertilizer_before === "none"
    && evidence.fertilizer_after === target.qualifiedItemId
    && inventoryDeltaProven
    && freshPostcondition;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "fertilizer_applied" : receipt.reasonCode, target, receipt: summarizeReceipt(receipt), evidence, targetGone, inventoryDeltaProven, freshPostcondition, trace, before: summarize(snapshot), after: summarize(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state.latestReceipt), trace }));
  process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

async function execute(phase, action, args, snapshot, requestId = `native_local_fertilize_tile_${phase}_${Date.now()}`) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const receipt = await client.execute({ requestId, idempotencyKey: `native_local_fertilize_tile_${phase}_idem_${Date.now()}`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  trace.push({ phase, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}

async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(accepted.executionId, accepted.requestId, (latest) => latest.location === "Farm" && latest.activeExecution == null, 15_000);
}

async function move(snapshot, target, phase) {
  snapshot = await waitForActionable(snapshot, 10_000);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(accepted.executionId, accepted.requestId, (latest) => latest.activeExecution == null && adjacent(latest.tile, target), 55_000);
}

async function moveToReachableFertilizerTarget(snapshot) {
  if (chooseReachableFertilizerTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
    for (const waypoint of candidates) {
      try {
        const moved = await move(snapshot, waypoint, "move_to_native_fertilize_tile_fixture");
        if (chooseReachableFertilizerTarget(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path")) throw error;
        snapshot = await client.observe();
        if (chooseReachableFertilizerTarget(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_fertilize_tile_fixture_target");
}

function chooseReachableFertilizerTarget(snapshot) {
  if (!Array.isArray(snapshot.fertilizerTargets)) return null;
  const candidates = snapshot.fertilizerTargets.filter((target) => Number.isInteger(target.slot) && Number.isInteger(target.x) && Number.isInteger(target.y)
    && typeof target.targetId === "string" && target.targetId.length > 0
    && typeof target.qualifiedItemId === "string" && target.qualifiedItemId.length > 0
    && adjacent(snapshot.tile, target));
  if (candidates.length === 0) return null;
  const target = candidates[0];
  if (candidates.some((candidate, index) => index > 0 && candidate.targetId === target.targetId)) throw new Error("ambiguous_fertilizer_target_id");
  return target;
}

async function waitForActionable(snapshot, timeoutMs) { const deadline = Date.now() + timeoutMs; let latest = snapshot; while (Date.now() < deadline) { if (latest.actionable && latest.activeExecution == null) return latest; await delay(250); latest = await client.observe(); } return latest; }
async function waitForReceiptAndSnapshot(executionId, requestId, predicate, timeoutMs) { const deadline = Date.now() + timeoutMs; let latest = await client.observe(); let recordedTerminal = false; while (Date.now() < deadline) { const terminal = receipts.find((receipt) => receipt.executionId === executionId && receipt.requestId === requestId && receipt.state !== "accepted" && isTerminal(receipt.state)); if (terminal && !recordedTerminal) { trace.push({ phase: "prerequisite_terminal", receipt: summarizeReceipt(terminal) }); recordedTerminal = true; } if (terminal && terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`); if (terminal?.state === "succeeded" && !hasNonemptyEvidence(terminal)) throw new Error("navigation_succeeded_evidence_missing"); if (terminal?.state === "succeeded" && predicate(latest)) return latest; await delay(200); latest = await client.observe(); } throw new Error(`navigation_timeout:${executionId}`); }
function assertNativeLocalFixtureConfig(value, scenario) {
  const fixture = value.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || (fixture.Bootstrap != null && fixture.Bootstrap.Enable !== false)
    || fixture.FixtureScenario !== scenario || !validFixtureSlotRelationship(fixture.LogicalSaveName, fixture.ObservedSaveSlot)) throw new Error("native_local_fixture_config_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated");
}
function validFixtureSlotRelationship(logicalName, observedSlot) { return typeof logicalName === "string" && /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) && typeof observedSlot === "string" && new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSlot); }
function requireExactCapabilities(snapshot) { const actual = [...snapshot.capabilities].sort(); const expected = ["cancel_active_execution", "fertilize_tile", "inspect_self", "move_to_tile", "travel"].sort(); if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("native_local_fertilize_capability_not_isolated"); }
function hasNonemptyEvidence(receipt) { return typeof receipt?.evidence?.detail === "string" && receipt.evidence.detail.length > 0; }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_fertilize_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key)) throw new Error("invalid_fertilize_evidence");
    result[key] = value;
  }
  return result;
}
function summarize(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, fertilizerTargets: snapshot.fertilizerTargets?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function summarizeReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
