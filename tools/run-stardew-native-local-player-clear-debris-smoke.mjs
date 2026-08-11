import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await connectWithRetry(scope, config.PipeName, config.BridgeToken, 15_000);
const receipts = [];
const trace = [];
const startedAt = Date.now();
let lastSnapshot;
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});

try {
  let snapshot = await actionableSnapshot();
  requireCapabilities(snapshot);
  if (snapshot.location !== "FarmHouse") throw new Error("clear_debris_route_must_start_at_farmhouse");

  snapshot = await travelToFarm(snapshot);
  snapshot = await moveToFixtureApproach(snapshot);
  const initialTarget = chooseFixtureTarget(snapshot);
  if (initialTarget.health !== 8) throw new Error("clear_debris_fixture_health_not_intact");
  const pickaxe = choosePickaxe(snapshot);
  const equipped = await execute("equip_pickaxe", "equip_tool", { slot: pickaxe.slot }, snapshot);
  if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected") throw new Error(`pickaxe_equip_failed:${equipped.reasonCode}`);

  let expectedHealth = 8;
  let target = initialTarget;
  let terminal = null;
  for (let hit = 1; hit <= 8; hit += 1) {
    snapshot = await actionableSnapshot();
    target = findSameFixtureTarget(snapshot, initialTarget);
    if (!target || target.parentSheetIndex !== 752 || target.toolKind !== "pickaxe" || target.requiredUpgradeLevel !== 0 || target.health !== expectedHealth) {
      throw new Error("debris_target_changed_before_hit");
    }
    const receipt = await execute(`clear_debris_hit_${hit}`, "clear_debris", {
      slot: pickaxe.slot,
      x: target.x,
      y: target.y,
      expectedTargetId: target.targetId,
    }, snapshot);
    const evidence = parseEvidence(receipt.evidence);
    const expectedTerminal = hit === 8;
    const validReceipt = receipt.requestId === trace.at(-1)?.receipt?.requestId
      && typeof receipt.executionId === "string" && receipt.executionId.length > 0
      && evidence.location === snapshot.location
      && evidence.target === target.targetId
      && evidence.tile === `${target.x},${target.y}`
      && evidence.parent === "752"
      && evidence.tool === "pickaxe"
      && evidence.required_upgrade === "0"
      && evidence.health_before === String(expectedHealth)
      && evidence.health_after === String(expectedTerminal ? 0 : expectedHealth - 1)
      && evidence.clump_removed === String(expectedTerminal)
      && ((expectedTerminal && receipt.state === "succeeded" && receipt.reasonCode === "debris_cleared")
        || (!expectedTerminal && receipt.state === "partially_succeeded" && receipt.reasonCode === "debris_hit"));
    if (!validReceipt) throw new Error(`debris_hit_receipt_invalid:${hit}:${receipt.reasonCode}`);
    terminal = receipt;
    if (expectedTerminal) break;
    expectedHealth -= 1;
  }

  const after = await actionableSnapshot();
  const targetGone = !Array.isArray(after.debrisTargets) || !after.debrisTargets.some((entry) => entry?.targetId === initialTarget.targetId);
  const passed = terminal?.state === "succeeded" && terminal.reasonCode === "debris_cleared" && targetGone;
  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked",
    topology: "native_local_player_fixture",
    reasonCode: passed ? "debris_cleared" : "clear_debris_postcondition_mismatch",
    target: initialTarget,
    receipt: summarizeReceipt(terminal),
    trace,
    after: summarize(after),
    freshPostcondition: { targetGone },
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
    lastSnapshot: lastSnapshot ? {
      revision: lastSnapshot.revision,
      location: lastSnapshot.location,
      tile: lastSnapshot.tile,
      capabilities: lastSnapshot.capabilities,
      debrisTargets: lastSnapshot.debrisTargets,
      toolSlots: lastSnapshot.toolSlots,
    } : null,
    durationMs: Date.now() - startedAt,
  }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function connectWithRetry(scope, pipeName, bridgeToken, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await LocalStardewBridgeClient.connect(scope, pipeName, bridgeToken); }
    catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error("native_local_bridge_connect_timeout");
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== "native_clear_debris_resource_clump_v1") {
    throw new Error("native_local_clear_debris_fixture_config_invalid");
  }
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true
    || value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, ["move_to_tile", "travel", "equip_tool", "clear_debris"])) {
    throw new Error("native_local_clear_debris_action_policy_invalid");
  }
}

function requireCapabilities(snapshot) {
  const expected = ["cancel_active_execution", "clear_debris", "equip_tool", "inspect_self", "move_to_tile", "travel"];
  if (!same([...(snapshot.capabilities ?? [])].sort(), expected.sort())) throw new Error("native_local_clear_debris_capability_not_isolated");
}

async function actionableSnapshot() {
  const snapshot = await client.observe();
  lastSnapshot = snapshot;
  if (!snapshot.actionable || snapshot.activeExecution != null || !Number.isInteger(snapshot.revision)) throw new Error("native_local_clear_debris_snapshot_not_actionable");
  return snapshot;
}

async function execute(phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_clear_debris_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await client.execute({
    requestId,
    idempotencyKey: `${requestId}_idem`,
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
  const completion = await waitForTerminal(accepted, (latest) => latest.location === "Farm", 15_000);
  trace.push({ phase: "travel_terminal", action: "travel", args: { x: warp.sourceX, y: warp.sourceY }, receipt: summarizeReceipt(completion.receipt) });
  return completion.snapshot;
}

async function moveToFixtureApproach(snapshot) {
  // The frozen fixture target is (62,17), with its 2×2 footprint occupying
  // (62..63,17..18). These three source-reviewed outside interaction tiles
  // are the entire movement budget. A rejected native route is not retried or
  // expanded; when no one of them exposes the single target we fail closed.
  const fixtureApproaches = [{ x: 61, y: 17 }, { x: 64, y: 17 }, { x: 62, y: 19 }];
  for (const approach of fixtureApproaches) {
    try {
      if (!sameTile(snapshot.tile, approach)) snapshot = await move(snapshot, approach, "move_to_clear_debris_fixture_anchor");
      else snapshot = await actionableSnapshot();
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      if (!reason.startsWith("move_to_clear_debris_fixture_anchor_not_accepted:no_native_path")
        && !reason.startsWith("navigation_failed:") && !reason.startsWith("navigation_timeout:")) throw error;
      snapshot = await actionableSnapshot();
    }
    if (fixtureTargets(snapshot).length === 1) return snapshot;
  }
  throw new Error("clear_debris_fixture_target_not_at_bounded_anchor");
}

async function move(snapshot, target, phase) {
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForTerminal(accepted, (latest) => adjacent(latest.tile, target), 55_000);
  trace.push({ phase: `${phase}_terminal`, action: "move_to_tile", args: target, receipt: summarizeReceipt(completion.receipt) });
  return completion.snapshot;
}

async function waitForTerminal(accepted, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await client.observe();
    const terminal = receipts.find((entry) => entry?.executionId === accepted.executionId && entry?.requestId === accepted.requestId && isTerminal(entry.state));
    if (terminal && terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
    if (terminal?.state === "succeeded" && snapshot.actionable && snapshot.activeExecution == null && predicate(snapshot)) return { receipt: terminal, snapshot };
    await delay(200);
  }
  throw new Error(`navigation_timeout:${accepted.executionId}`);
}

function fixtureTargets(snapshot) {
  // The fixture's only permitted target is a source-reviewed 2×2 mine rock at
  // this exact origin. Setup rejects pre-existing parent-752 clumps, so an
  // observed target matching this tuple is the transaction-owned precondition,
  // not an arbitrary nearby debris target.
  return (snapshot.debrisTargets ?? []).filter((entry) => validTarget(entry)
    && entry.x === 62 && entry.y === 17
    && entry.parentSheetIndex === 752 && entry.toolKind === "pickaxe" && entry.requiredUpgradeLevel === 0);
}
function chooseFixtureTarget(snapshot) {
  const targets = fixtureTargets(snapshot);
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_live_clear_debris_target" : "no_live_clear_debris_target");
  return targets[0];
}
function findSameFixtureTarget(snapshot, target) {
  return fixtureTargets(snapshot).find((entry) => entry.targetId === target.targetId && entry.x === target.x && entry.y === target.y);
}
function choosePickaxe(snapshot) {
  const tools = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Pickaxe");
  if (tools.length !== 1) throw new Error(tools.length ? "ambiguous_live_pickaxe_slot" : "no_live_pickaxe_slot");
  return tools[0];
}
function validTarget(entry) {
  return typeof entry?.targetId === "string" && entry.targetId.length > 0
    && Number.isInteger(entry.slot) && entry.slot >= 0
    && validTile(entry.x) && validTile(entry.y)
    && Number.isInteger(entry.parentSheetIndex)
    && Number.isFinite(entry.health) && entry.health > 0
    && (entry.toolKind === "axe" || entry.toolKind === "pickaxe")
    && Number.isInteger(entry.requiredUpgradeLevel) && entry.requiredUpgradeLevel >= 0;
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(detail.split(";").flatMap((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
  }));
}
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function validTile(value) { return Number.isInteger(value) && value >= 0 && value <= 1000; }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function sameTile(left, right) { return left.x === right.x && left.y === right.y; }
function same(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function summarize(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, debrisTargets: snapshot.debrisTargets?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function summarizeReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
