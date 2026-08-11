import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
if (config.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
if (config.Portfolio?.Enable === true || config.HostAutomation?.Enable === true || config.HostFarmhandProvisioning?.Enable === true || config.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  let snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const warp = chooseSafeWarp(snapshot);
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) {
    const move = await execute("move_to_warp_source", "move_to_tile", { x: warp.sourceX, y: warp.sourceY }, snapshot);
    if (move.state !== "accepted") throw new Error(`move_to_warp_source_not_accepted:${move.reasonCode}`);
    const moveTerminal = await waitForTerminal(move.executionId, 55_000);
    if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached") throw new Error(`move_to_warp_source_failed:${moveTerminal.reasonCode}`);
    snapshot = await observeActionable();
    if (snapshot.revision < moveTerminal.revision || !adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) throw new Error("move_to_warp_source_postcondition_missing");
  }

  // Rediscover the source immediately before travel. The Mod accepts only its
  // current-location Warp list, so a prior snapshot never authorizes travel.
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const freshWarp = findDeclaredWarp(snapshot, warp);
  if (!freshWarp || !adjacent(snapshot.tile, { x: freshWarp.sourceX, y: freshWarp.sourceY })) throw new Error("fresh_warp_source_unavailable");
  const accepted = await execute("travel", "travel", { x: freshWarp.sourceX, y: freshWarp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, 20_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed") throw new Error(`travel_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  const passed = after.revision >= terminal.revision
    && after.location === freshWarp.targetLocation
    && after.tile?.x === freshWarp.targetX
    && after.tile?.y === freshWarp.targetY;
  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked",
    topology: "native_local_player_fixture",
    source: warpSummary(snapshot.location, freshWarp),
    receipt: receiptSummary(terminal),
    before: summary(snapshot),
    after: summary(after),
    trace,
  }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: receiptSummary(client.state.latestReceipt), trace }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function observeActionable() {
  const snapshot = await client.observe();
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("native_local_travel_player_not_actionable");
  if (!Number.isInteger(snapshot.revision) || !Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y)) throw new Error("native_local_travel_snapshot_invalid");
  if (!Array.isArray(snapshot.warps) || snapshot.warps.length === 0) throw new Error("native_local_travel_warps_missing");
  return snapshot;
}
function requireExactCapabilities(snapshot) {
  const actual = [...snapshot.capabilities].sort();
  const expected = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("native_local_travel_capability_not_isolated");
}
function chooseSafeWarp(snapshot) {
  const candidates = snapshot.warps.filter(validWarp);
  const preferred = snapshot.location === "FarmHouse" ? candidates.find((warp) => warp.targetLocation === "Farm") : undefined;
  const selected = preferred ?? candidates[0];
  if (!selected) throw new Error("no_safe_live_warp");
  return selected;
}
function findDeclaredWarp(snapshot, selected) {
  return snapshot.warps.find((warp) => validWarp(warp)
    && warp.sourceX === selected.sourceX && warp.sourceY === selected.sourceY
    && warp.targetLocation === selected.targetLocation && warp.targetX === selected.targetX && warp.targetY === selected.targetY);
}
function validWarp(warp) {
  return Number.isInteger(warp?.sourceX) && Number.isInteger(warp?.sourceY)
    && Number.isInteger(warp?.targetX) && Number.isInteger(warp?.targetY)
    && warp.sourceX >= 0 && warp.sourceY >= 0 && warp.targetX >= 0 && warp.targetY >= 0
    && typeof warp?.targetLocation === "string" && warp.targetLocation.length > 0;
}
async function execute(phase, action, args, snapshot) {
  const requestId = `native_local_travel_${phase}_${Date.now()}`;
  const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  trace.push({ phase, action, args, receipt: receiptSummary(receipt) });
  return receipt;
}
async function waitForTerminal(executionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = receipts.find((item) => item.executionId === executionId && isTerminal(item.state));
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`travel_terminal_timeout:${executionId}`);
}
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function summary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, activeExecution: snapshot.activeExecution ?? null, warps: snapshot.warps?.map((warp) => warpSummary(snapshot.location, warp)) ?? [] }; }
function warpSummary(location, warp) { return { source: `${location}:${warp.sourceX},${warp.sourceY}`, target: `${warp.targetLocation}:${warp.targetX},${warp.targetY}` }; }
function receiptSummary(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
