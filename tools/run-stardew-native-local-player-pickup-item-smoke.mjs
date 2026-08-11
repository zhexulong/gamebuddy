import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateNativeLocalConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  let snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);

  // Debris chunks are live native entities. The fixture establishes only the
  // event-free save precondition; target identity, tile, stack, and revision
  // are discovered from the fresh production snapshot after travel.
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  // Debris.updateChunks owns magnetic delivery while the production
  // pickup_item execution owns the native approach. A separate prerequisite
  // move could collect this target before pickup_item is submitted, so use the
  // fresh opaque target directly and let the action's body controller drive it.
  const target = chooseOnlyFreshItemTarget(snapshot);
  const accepted = await execute("pickup_item", "pickup_item", {
    x: target.x,
    y: target.y,
    expectedQualifiedItemId: target.qualifiedItemId,
    expectedTargetId: target.targetId,
  }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`pickup_item_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, accepted.requestId, 40_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "item_picked_up") throw new Error(`pickup_item_failed:${terminal.reasonCode}`);

  // The native Debris update can emit its terminal receipt just before the
  // player is actionable again, so only the postcondition has a bounded reread.
  const after = await waitForFreshActionablePostcondition(5_000);
  const evidence = parseEvidence(terminal.evidence);
  const inventoryBefore = parseSafeInteger(evidence.inventory_before);
  const inventoryAfter = parseSafeInteger(evidence.inventory_after);
  const inventoryDelta = inventoryBefore !== null && inventoryAfter !== null ? inventoryAfter - inventoryBefore : null;
  const targetGone = after.itemTargets.every((entry) => entry?.targetId !== target.targetId);
  const passed = terminal.executionId === accepted.executionId
    && terminal.requestId === accepted.requestId
    && after.revision >= terminal.revision
    && evidence.location === snapshot.location
    && evidence.target === target.targetId
    && evidence.tile === `${target.x},${target.y}`
    && evidence.item === target.qualifiedItemId
    && parseSafeInteger(evidence.stack) === target.stack
    && evidence.native_auto_collect === "true"
    && evidence.chunk_removed === "true"
    && inventoryDelta === target.stack
    && targetGone;
  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked",
    topology: "native_local_player_fixture",
    reasonCode: passed ? "item_picked_up" : "pickup_item_postcondition_mismatch",
    target: targetSummary(target),
    receipt: receiptSummary(terminal),
    evidence,
    inventoryDelta,
    targetGone,
    trace,
    before: snapshotSummary(snapshot),
    after: snapshotSummary(after),
    durationMs: Date.now() - startedAt,
  }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({
    state: "blocked",
    reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
    latestReceipt: receiptSummary(client.state.latestReceipt),
    trace,
  }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function validateNativeLocalConfig(value) {
  if (!value || value.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  const fixture = value.NativeLocalPlayerFixture;
  if (fixture.Bootstrap?.Enable === true) throw new Error("native_local_fixture_bootstrap_enabled");
  if (fixture.FixtureScenario !== "native_pickup_item_v1") throw new Error("native_local_fixture_scenario_invalid");
  if (!validFixtureBinding(fixture.LogicalSaveName, fixture.ObservedSaveSlot)) throw new Error("native_local_fixture_save_binding_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated");
  const requiredConfig = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredConfig.some((key) => typeof value[key] !== "string" || value[key].length === 0)) throw new Error("invalid_client_config");
}
function validFixtureBinding(logicalName, observedSlot) {
  if (typeof logicalName !== "string" || !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName)) return false;
  return observedSlot === null || observedSlot === undefined
    ? false
    : new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSlot);
}
async function travelToFarm(snapshot) {
  const warp = snapshot.warps.find((entry) => validWarp(entry) && entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const freshWarp = snapshot.warps.find((entry) => validWarp(entry) && entry.sourceX === warp.sourceX && entry.sourceY === warp.sourceY && entry.targetLocation === "Farm" && entry.targetX === warp.targetX && entry.targetY === warp.targetY);
  if (!freshWarp || !adjacent(snapshot.tile, { x: freshWarp.sourceX, y: freshWarp.sourceY })) throw new Error("fresh_farm_warp_unavailable");
  const accepted = await execute("travel_to_farm", "travel", { x: freshWarp.sourceX, y: freshWarp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, accepted.requestId, 20_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed") throw new Error(`travel_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  if (after.revision < terminal.revision || after.location !== "Farm" || after.tile?.x !== freshWarp.targetX || after.tile?.y !== freshWarp.targetY) throw new Error("travel_postcondition_missing");
  return after;
}
async function move(snapshot, target, phase) {
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, accepted.requestId, 55_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached") throw new Error(`move_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  if (after.revision < terminal.revision || !adjacent(after.tile, target)) throw new Error(`${phase}_postcondition_missing`);
  return after;
}
async function observeActionable() { return requireActionableSnapshot(await client.observe()); }
async function waitForFreshActionablePostcondition(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await client.observe();
    try { return requireActionableSnapshot(snapshot); } catch (error) {
      if (String(error instanceof Error ? error.message : error) !== "native_local_pickup_item_player_not_actionable") throw error;
      await delay(100);
    }
  }
  throw new Error("native_local_pickup_item_postcondition_not_actionable");
}
function requireActionableSnapshot(snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("native_local_pickup_item_player_not_actionable");
  if (!Number.isInteger(snapshot.revision) || !Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y)) throw new Error("native_local_pickup_item_snapshot_invalid");
  if (!Array.isArray(snapshot.capabilities) || !Array.isArray(snapshot.warps) || !Array.isArray(snapshot.itemTargets)) throw new Error("native_local_pickup_item_snapshot_facts_missing");
  return snapshot;
}
function requireExactCapabilities(snapshot) {
  const actual = [...snapshot.capabilities].sort();
  const expected = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "pickup_item"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("native_local_pickup_item_capability_not_isolated");
}
function chooseOnlyFreshItemTarget(snapshot) {
  const targets = snapshot.itemTargets.filter((target) => validItemTarget(target));
  if (targets.length !== 1) throw new Error(targets.length === 0 ? "no_fresh_live_item_target" : "ambiguous_live_item_targets");
  return targets[0];
}
function validItemTarget(target) {
  return Number.isInteger(target?.x) && Number.isInteger(target?.y) && target.x >= 0 && target.y >= 0
    && typeof target.targetId === "string" && target.targetId.length > 0
    && typeof target.qualifiedItemId === "string" && target.qualifiedItemId.length > 0
    && Number.isSafeInteger(target.stack) && target.stack > 0;
}
function validWarp(warp) { return Number.isInteger(warp?.sourceX) && Number.isInteger(warp?.sourceY) && Number.isInteger(warp?.targetX) && Number.isInteger(warp?.targetY) && warp.sourceX >= 0 && warp.sourceY >= 0 && warp.targetX >= 0 && warp.targetY >= 0 && typeof warp.targetLocation === "string" && warp.targetLocation.length > 0; }
async function execute(phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_pickup_item_${phase}_${Date.now()}`;
  const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  trace.push({ phase, action, args, receipt: receiptSummary(receipt) });
  return receipt;
}
async function waitForTerminal(executionId, requestId, timeoutMs) {
  if (typeof executionId !== "string" || executionId.length === 0 || typeof requestId !== "string" || requestId.length === 0) throw new Error("execution_identity_missing");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = receipts.find((entry) => entry.executionId === executionId && entry.requestId === requestId && isTerminal(entry.state));
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`terminal_timeout:${executionId}`);
}
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = Object.create(null);
  const expectedKeys = new Set(["location", "target", "tile", "item", "stack", "native_auto_collect", "chunk_removed", "inventory_before", "inventory_after"]);
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_pickup_item_evidence");
    const key = field.slice(0, separator);
    const fieldValue = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || fieldValue.length > 512 || Object.hasOwn(result, key) || !expectedKeys.has(key)) throw new Error("invalid_pickup_item_evidence");
    result[key] = fieldValue;
  }
  if (Object.keys(result).length !== expectedKeys.size || [...expectedKeys].some((key) => !Object.hasOwn(result, key))) throw new Error("invalid_pickup_item_evidence");
  return result;
}
function parseSafeInteger(value) { if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null; const parsed = Number(value); return Number.isSafeInteger(parsed) ? parsed : null; }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function targetSummary(target) { return { targetId: target.targetId, x: target.x, y: target.y, qualifiedItemId: target.qualifiedItemId, stack: target.stack }; }
function snapshotSummary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, itemTargets: snapshot.itemTargets?.map(targetSummary) ?? [], activeExecution: snapshot.activeExecution ?? null }; }
function receiptSummary(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
