import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateConfig(config);
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
  let snapshot = await waitForActionable(await client.observe(), 5_000);
  requireCapabilities(snapshot);
  if (snapshot.location !== "FarmHouse") throw new Error("break_rock_source_route_must_start_at_farmhouse");

  snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  snapshot = await moveToReachableRock(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);

  const target = chooseRock(snapshot);
  const pickaxe = choosePickaxe(snapshot);
  const equipped = await execute("equip_pickaxe", "equip_tool", { slot: pickaxe.slot }, snapshot);
  if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected") {
    throw new Error(`pickaxe_equip_failed:${equipped.reasonCode}`);
  }

  snapshot = await waitForActionable(await client.observe(), 5_000);
  const freshTarget = findSameRock(snapshot, target);
  if (!freshTarget || freshTarget.health !== 1) throw new Error("rock_target_changed_after_equip");
  const accepted = await execute("break_rock_source", "break_rock_source", {
    slot: pickaxe.slot,
    x: freshTarget.x,
    y: freshTarget.y,
    expectedTargetId: freshTarget.targetId,
  }, snapshot);
  if (accepted.state !== "succeeded" || accepted.reasonCode !== "rock_source_broken") {
    throw new Error(`break_rock_source_failed:${accepted.reasonCode}`);
  }

  const evidence = parseEvidence(accepted.evidence);
  const after = await waitForActionable(await client.observe(), 5_000);
  const reread = findSameRock(after, freshTarget);
  const passed = evidence.target === freshTarget.targetId
    && evidence.tool === "pickaxe"
    && evidence.slot === String(pickaxe.slot)
    && evidence.qualified_item_id === "(O)2"
    && evidence.durability_before === "1"
    && evidence.durability_after === "removed"
    && evidence.removed === "true"
    && reread === undefined;

  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked",
    topology: "native_local_player_fixture",
    reasonCode: passed ? "break_rock_source" : "break_rock_source_postcondition_mismatch",
    target: freshTarget,
    receipt: summarizeReceipt(accepted),
    evidence,
    trace,
    before: summarize(snapshot),
    after: summarize(after),
    durationMs: Date.now() - startedAt,
  }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({
    state: "blocked",
    topology: "native_local_player_fixture",
    reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
    latestReceipt: summarizeReceipt(client.state.latestReceipt),
    trace,
    durationMs: Date.now() - startedAt,
  }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture?.Bootstrap?.Enable === true || fixture?.FixtureScenario !== "native_break_rock_source_v1") {
    throw new Error("native_local_break_rock_source_fixture_config_invalid");
  }
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true
    || value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, ["move_to_tile", "travel", "equip_tool", "break_rock_source"])) {
    throw new Error("native_local_break_rock_source_action_policy_invalid");
  }
}

function requireCapabilities(snapshot) {
  const expected = ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "travel", "break_rock_source"];
  if (!same([...(snapshot.capabilities ?? [])].sort(), expected.sort())) {
    throw new Error("native_local_break_rock_source_capability_not_isolated");
  }
}

async function execute(phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const receipt = await client.execute({
    requestId: `native_local_break_rock_source_${phase}_${nonce}`,
    idempotencyKey: `native_local_break_rock_source_${phase}_idem_${nonce}`,
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}

async function travelToFarm(snapshot) {
  const warps = (snapshot.warps ?? []).filter((entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY));
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForReceiptAndSnapshot(accepted.executionId, (latest) => latest.location === "Farm" && latest.activeExecution == null, 15_000);
  recordTerminalReceipt("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, completion.receipt);
  return completion.snapshot;
}

async function moveToReachableRock(snapshot) {
  if (rockCandidates(snapshot).length === 1) return snapshot;
  for (let radius = 1; radius <= 12; radius++) {
    const waypoints = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius) waypoints.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    }
    for (const waypoint of waypoints) {
      if (!validTile(waypoint.x) || !validTile(waypoint.y)) continue;
      try {
        const moved = await move(snapshot, waypoint, "move_to_rock_fixture");
        if (rockCandidates(moved).length === 1) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path")) throw error;
        snapshot = await waitForActionable(await client.observe(), 5_000);
        if (rockCandidates(snapshot).length === 1) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_unique_native_rock_target");
}

async function move(snapshot, target, phase) {
  snapshot = await waitForActionable(snapshot, 10_000);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForReceiptAndSnapshot(accepted.executionId, (latest) => latest.activeExecution == null && adjacent(latest.tile, target), 55_000);
  recordTerminalReceipt(phase, "move_to_tile", target, completion.receipt);
  return completion.snapshot;
}

async function waitForActionable(snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = snapshot;
  while (Date.now() < deadline) {
    if (latest.actionable && latest.activeExecution == null) return latest;
    await delay(250);
    latest = await client.observe();
  }
  return latest;
}

async function waitForReceiptAndSnapshot(executionId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const terminal = receipts.find((receipt) => receipt.executionId === executionId && isTerminal(receipt.state));
    if (terminal && terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
    if (terminal?.state === "succeeded" && predicate(latest)) return { receipt: terminal, snapshot: latest };
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`navigation_timeout:${executionId}`);
}

function recordTerminalReceipt(phase, action, args, receipt) {
  trace.push({ phase: `${phase}_terminal`, action, args, receipt: summarizeReceipt(receipt) });
}

function rockCandidates(snapshot) {
  return (snapshot.rockSourceTargets ?? []).filter(validRock);
}

function chooseRock(snapshot) {
  const targets = rockCandidates(snapshot);
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_live_one_hit_rock_target" : "no_live_one_hit_rock_target");
  return targets[0];
}

function findSameRock(snapshot, target) {
  return (snapshot.rockSourceTargets ?? []).find((entry) => entry?.targetId === target.targetId && entry.x === target.x && entry.y === target.y && validRock(entry));
}

function choosePickaxe(snapshot) {
  const pickaxes = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Pickaxe");
  if (pickaxes.length !== 1) throw new Error(pickaxes.length ? "ambiguous_live_pickaxe_slot" : "no_live_pickaxe_slot");
  return pickaxes[0];
}

function validRock(entry) {
  return typeof entry?.targetId === "string" && entry.targetId.length > 0
    && validTile(entry.x) && validTile(entry.y)
    && typeof entry.location === "string" && entry.location.length > 0
    && Number.isFinite(entry.health) && entry.qualifiedItemId === "(O)2" && entry.health === 1;
}

function validTile(value) { return Number.isInteger(value) && value >= 0 && value <= 1000; }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function same(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(detail.split(";").map((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null;
  }).filter(Boolean));
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    rockSourceTargets: snapshot.rockSourceTargets?.length ?? 0,
    activeExecution: snapshot.activeExecution ?? null,
  };
}
function summarizeReceipt(receipt) {
  return receipt ? {
    executionId: receipt.executionId,
    requestId: receipt.requestId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence ?? null,
  } : null;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
