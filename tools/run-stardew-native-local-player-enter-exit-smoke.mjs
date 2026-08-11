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
  const door = chooseSafeDoor(snapshot);
  if (!adjacent(snapshot.tile, { x: door.sourceX, y: door.sourceY })) {
    const move = await execute("move_to_door_source", "move_to_tile", { x: door.sourceX, y: door.sourceY }, snapshot);
    if (move.state !== "accepted") throw new Error(`move_to_door_source_not_accepted:${move.reasonCode}`);
    const moveTerminal = await waitForTerminal(move.executionId, 55_000);
    if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached") throw new Error(`move_to_door_source_failed:${moveTerminal.reasonCode}`);
    snapshot = await observeActionable();
    if (snapshot.revision < moveTerminal.revision || !adjacent(snapshot.tile, { x: door.sourceX, y: door.sourceY })) throw new Error("move_to_door_source_postcondition_missing");
  }

  // Re-discover an opaque, Mod-published door immediately before the request.
  // A coordinate from a previous snapshot never authorizes enter_exit.
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const freshDoor = findDeclaredDoor(snapshot, door);
  if (!freshDoor || !adjacent(snapshot.tile, { x: freshDoor.sourceX, y: freshDoor.sourceY })) throw new Error("fresh_door_target_unavailable");
  const accepted = await execute("enter_exit", "enter_exit", { x: freshDoor.sourceX, y: freshDoor.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`enter_exit_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, 20_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "enter_exit_completed") throw new Error(`enter_exit_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  const passed = after.revision >= terminal.revision
    && after.location === freshDoor.targetLocation
    && after.tile?.x === freshDoor.targetX
    && after.tile?.y === freshDoor.targetY;
  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked",
    topology: "native_local_player_fixture",
    source: doorSummary(snapshot.location, freshDoor),
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
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("native_local_enter_exit_player_not_actionable");
  if (!Number.isInteger(snapshot.revision) || !Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y)) throw new Error("native_local_enter_exit_snapshot_invalid");
  if (!Array.isArray(snapshot.doorTargets) || snapshot.doorTargets.length === 0) throw new Error("native_local_enter_exit_door_targets_missing");
  return snapshot;
}
function requireExactCapabilities(snapshot) {
  const actual = [...snapshot.capabilities].sort();
  const expected = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("native_local_enter_exit_capability_not_isolated");
}
function chooseSafeDoor(snapshot) {
  const candidates = snapshot.doorTargets.filter(validDoor);
  const preferred = snapshot.location === "FarmHouse" ? candidates.find((door) => door.targetLocation === "Farm") : undefined;
  const selected = preferred ?? candidates[0];
  if (!selected) throw new Error("no_safe_live_door_target");
  return selected;
}
function findDeclaredDoor(snapshot, selected) {
  return snapshot.doorTargets.find((door) => validDoor(door)
    && door.sourceX === selected.sourceX && door.sourceY === selected.sourceY
    && door.targetLocation === selected.targetLocation && door.targetX === selected.targetX && door.targetY === selected.targetY);
}
function validDoor(door) {
  return Number.isInteger(door?.sourceX) && Number.isInteger(door?.sourceY)
    && Number.isInteger(door?.targetX) && Number.isInteger(door?.targetY)
    && door.sourceX >= 0 && door.sourceY >= 0 && door.targetX >= 0 && door.targetY >= 0
    && typeof door?.targetLocation === "string" && door.targetLocation.length > 0;
}
async function execute(phase, action, args, snapshot) {
  const requestId = `native_local_enter_exit_${phase}_${Date.now()}`;
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
  throw new Error(`enter_exit_terminal_timeout:${executionId}`);
}
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function summary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, activeExecution: snapshot.activeExecution ?? null, doorTargets: snapshot.doorTargets?.map((door) => doorSummary(snapshot.location, door)) ?? [] }; }
function doorSummary(location, door) { return { source: `${location}:${door.sourceX},${door.sourceY}`, target: `${door.targetLocation}:${door.targetX},${door.targetY}` }; }
function receiptSummary(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
