import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
if (config.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
if (
  config.Portfolio?.Enable === true ||
  config.HostAutomation?.Enable === true ||
  config.HostFarmhandProvisioning?.Enable === true ||
  config.FarmhandProvisioner?.Enable === true
)
  throw new Error("native_local_fixture_topology_not_isolated");
const requiredConfig = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (requiredConfig.some((key) => typeof config[key] !== "string" || config[key].length === 0))
  throw new Error("invalid_client_config");
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});

try {
  let snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  assertNoGoldenScytheOverride(snapshot);
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  assertNoGoldenScytheOverride(snapshot);
  snapshot = await moveToFreshHarvestTarget(snapshot);

  // The production snapshot intentionally publishes only in-range, ready Grab
  // crops. Re-read it after every prerequisite and bind the request to the
  // fresh opaque target ID and revision; fixture coordinates never authorize a
  // harvest request.
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  assertNoGoldenScytheOverride(snapshot);
  const target = chooseOnlyFreshHarvestTarget(snapshot);
  const request = await execute(
    "harvest",
    "harvest_crop",
    {
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: target.qualifiedHarvestItemId,
      expectedTargetId: target.targetId,
    },
    snapshot,
  );
  const terminal = await terminalForRequest(request, 5_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "crop_harvested")
    throw new Error(`harvest_failed:${terminal.reasonCode}`);

  // Native harvest can publish its terminal receipt one tick before the player
  // becomes actionable again. Pre-request checks remain immediate and strict;
  // only the fresh postcondition gets this bounded stabilization wait.
  const after = await waitForFreshActionablePostcondition(5_000);
  const evidence = parseEvidence(terminal.evidence);
  const targetGone = after.harvestTargets.every((entry) => entry.targetId !== target.targetId);
  const inventoryBefore = parseSafeInteger(evidence.inventory_before);
  const inventoryAfter = parseSafeInteger(evidence.inventory_after);
  const inventoryGained = inventoryBefore !== null && inventoryAfter !== null && inventoryAfter > inventoryBefore;
  // harvestTargets contains only ready-to-grab crops. A non-regrowing crop is
  // therefore fresh only when its bound target disappears; a regrowing crop
  // remains in the world but must no longer be ready, in addition to the
  // receipt's native regrowth evidence.
  const freshPostcondition = target.regrowsAfterHarvest
    ? evidence.crop_present_after === "true" && evidence.regrow_advanced === "true" && targetGone
    : evidence.crop_present_after === "false" && targetGone;
  const passed =
    terminal.executionId === request.executionId &&
    terminal.requestId === request.requestId &&
    after.revision >= terminal.revision &&
    evidence.target === target.targetId &&
    evidence.item === target.qualifiedHarvestItemId &&
    evidence.regrows === String(target.regrowsAfterHarvest) &&
    evidence.native_accepted === "true" &&
    evidence.inventory_gained === "true" &&
    inventoryGained &&
    freshPostcondition;
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "crop_harvested" : "harvest_postcondition_mismatch",
      target: targetSummary(target),
      receipt: receiptSummary(terminal),
      evidence,
      targetGone,
      inventoryGained,
      trace,
      before: snapshotSummary(snapshot),
      after: snapshotSummary(after),
      durationMs: Date.now() - startedAt,
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: receiptSummary(client.state.latestReceipt),
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function travelToFarm(snapshot) {
  const warp = snapshot.warps.find((entry) => validWarp(entry) && entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const freshWarp = snapshot.warps.find(
    (entry) =>
      validWarp(entry) &&
      entry.sourceX === warp.sourceX &&
      entry.sourceY === warp.sourceY &&
      entry.targetLocation === "Farm" &&
      entry.targetX === warp.targetX &&
      entry.targetY === warp.targetY,
  );
  if (!freshWarp || !adjacent(snapshot.tile, { x: freshWarp.sourceX, y: freshWarp.sourceY }))
    throw new Error("fresh_farm_warp_unavailable");
  const accepted = await execute("travel_to_farm", "travel", { x: freshWarp.sourceX, y: freshWarp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, accepted.requestId, 20_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  if (
    after.revision < terminal.revision ||
    after.location !== "Farm" ||
    after.tile?.x !== freshWarp.targetX ||
    after.tile?.y !== freshWarp.targetY
  )
    throw new Error("travel_postcondition_missing");
  return after;
}

async function moveToFreshHarvestTarget(snapshot) {
  if (hasOneFreshHarvestTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius)
          candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    for (const waypoint of candidates) {
      try {
        snapshot = await move(snapshot, waypoint, "move_to_native_harvest_crop_fixture");
        if (hasOneFreshHarvestTarget(snapshot)) return snapshot;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("move_failed:no_native_path"))
          throw error;
        snapshot = await observeActionable();
        if (hasOneFreshHarvestTarget(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_harvest_crop_fixture_target");
}

async function move(snapshot, target, phase) {
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, accepted.requestId, 55_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`move_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  if (after.revision < terminal.revision || !adjacent(after.tile, target))
    throw new Error(`${phase}_postcondition_missing`);
  return after;
}

async function observeActionable() {
  const snapshot = await client.observe();
  return requireActionableSnapshot(snapshot);
}
async function waitForFreshActionablePostcondition(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await client.observe();
    try {
      return requireActionableSnapshot(snapshot);
    } catch (error) {
      if (String(error instanceof Error ? error.message : error) !== "native_local_harvest_player_not_actionable")
        throw error;
      await delay(100);
    }
  }
  throw new Error("native_local_harvest_postcondition_not_actionable");
}
function requireActionableSnapshot(snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null)
    throw new Error("native_local_harvest_player_not_actionable");
  if (
    !Number.isInteger(snapshot.revision) ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y)
  )
    throw new Error("native_local_harvest_snapshot_invalid");
  if (
    !Array.isArray(snapshot.capabilities) ||
    !Array.isArray(snapshot.warps) ||
    !Array.isArray(snapshot.harvestTargets)
  )
    throw new Error("native_local_harvest_snapshot_facts_missing");
  return snapshot;
}

function requireExactCapabilities(snapshot) {
  const actual = [...snapshot.capabilities].sort();
  const expected = ["cancel_active_execution", "harvest_crop", "inspect_self", "move_to_tile", "travel"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("native_local_harvest_capability_not_isolated");
}
function assertNoGoldenScytheOverride(snapshot) {
  if (
    typeof snapshot.currentTool === "string" &&
    snapshot.currentTool
      .replaceAll(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .includes("goldenscythe")
  )
    throw new Error("golden_scythe_grab_override_risk");
}
function hasOneFreshHarvestTarget(snapshot) {
  return validHarvestTargets(snapshot).length === 1;
}
function chooseOnlyFreshHarvestTarget(snapshot) {
  const targets = validHarvestTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_live_harvest_target" : "ambiguous_live_harvest_targets");
  return targets[0];
}
function validHarvestTargets(snapshot) {
  if (!Array.isArray(snapshot.harvestTargets)) return [];
  return snapshot.harvestTargets.filter(
    (target) =>
      Number.isInteger(target?.x) &&
      Number.isInteger(target?.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.targetId === "string" &&
      target.targetId.length > 0 &&
      typeof target.qualifiedHarvestItemId === "string" &&
      target.qualifiedHarvestItemId.length > 0 &&
      typeof target.regrowsAfterHarvest === "boolean" &&
      adjacent(snapshot.tile, target),
  );
}
function validWarp(warp) {
  return (
    Number.isInteger(warp?.sourceX) &&
    Number.isInteger(warp?.sourceY) &&
    Number.isInteger(warp?.targetX) &&
    Number.isInteger(warp?.targetY) &&
    warp.sourceX >= 0 &&
    warp.sourceY >= 0 &&
    warp.targetX >= 0 &&
    warp.targetY >= 0 &&
    typeof warp.targetLocation === "string" &&
    warp.targetLocation.length > 0
  );
}
async function execute(phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_harvest_crop_${phase}_${Date.now()}`;
  const receipt = await client.execute({
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase, action, args, receipt: receiptSummary(receipt) });
  return receipt;
}
async function terminalForRequest(receipt, timeoutMs) {
  if (isTerminal(receipt?.state)) return receipt;
  return waitForTerminal(receipt?.executionId, receipt?.requestId, timeoutMs);
}
async function waitForTerminal(executionId, requestId, timeoutMs) {
  if (
    typeof executionId !== "string" ||
    executionId.length === 0 ||
    typeof requestId !== "string" ||
    requestId.length === 0
  )
    throw new Error("execution_identity_missing");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = receipts.find(
      (item) => item.executionId === executionId && item.requestId === requestId && isTerminal(item.state),
    );
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`terminal_timeout:${executionId}`);
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function isTerminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_harvest_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_harvest_evidence");
    result[key] = value;
  }
  return result;
}
function parseSafeInteger(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function targetSummary(target) {
  return {
    targetId: target.targetId,
    x: target.x,
    y: target.y,
    cropId: target.cropId,
    qualifiedHarvestItemId: target.qualifiedHarvestItemId,
    regrowsAfterHarvest: target.regrowsAfterHarvest,
  };
}
function snapshotSummary(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    currentTool: snapshot.currentTool ?? null,
    harvestTargets: snapshot.harvestTargets?.map(targetSummary) ?? [],
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
