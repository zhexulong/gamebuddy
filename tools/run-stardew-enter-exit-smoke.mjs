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
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});

try {
  if (!client.state.capabilities.includes("enter_exit")) throw new Error("enter_exit_capability_missing");
  let snapshot = await client.observe();
  if (!snapshot.capabilities.includes("enter_exit")) throw new Error("snapshot_enter_exit_capability_missing");
  let door = chooseAdjacentDoor(snapshot);
  if (door === null && process.argv.includes("--prepare-with-move")) {
    door = chooseNearestDoor(snapshot);
    if (door !== null) {
      const move = await client.execute({
        requestId: `enter_exit_prepare_move_${Date.now()}`,
        idempotencyKey: `enter_exit_prepare_move_idem_${Date.now()}`,
        action: "move_to_tile",
        args: { x: door.sourceX, y: door.sourceY },
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 45_000,
      });
      trace.push({ phase: "prepare_move", target: { x: door.sourceX, y: door.sourceY }, receipt: summarizeReceipt(move), door });
      if (move.state !== "accepted") throw new Error(`prepare_move_not_accepted:${move.state}:${move.reasonCode}`);
      const moved = await waitForMoveTerminal(client, move.executionId, door, 45_000);
      trace.push({ phase: "prepare_move_completed", receipt: moved.receipt, snapshot: summarizeSnapshot(moved.snapshot) });
      if (moved.receipt?.state !== "succeeded" || moved.receipt.reasonCode !== "target_reached") throw new Error(`prepare_move_failed:${moved.receipt?.state}:${moved.receipt?.reasonCode}`);
      snapshot = await waitForActionable(client, moved.snapshot, 5_000);
      door = chooseAdjacentDoor(snapshot);
    }
  }
  if (door === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_adjacent_native_door", snapshot: summarizeSnapshot(snapshot), doorCount: snapshot.doorTargets?.length ?? 0, durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    const accepted = await client.execute({
      requestId: `enter_exit_${Date.now()}`,
      idempotencyKey: `enter_exit_idem_${Date.now()}`,
      action: "enter_exit",
      args: { x: door.sourceX, y: door.sourceY },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    trace.push({ phase: "accepted", receipt: summarizeReceipt(accepted), snapshot: summarizeSnapshot(snapshot), door });
    if (accepted.state !== "accepted") throw new Error(`enter_exit_not_accepted:${accepted.state}:${accepted.reasonCode}`);
    const terminal = await waitForTransitionTerminal(client, accepted.executionId, door, 15_000);
    trace.push({ phase: "warped", receipt: terminal.receipt, snapshot: summarizeSnapshot(terminal.snapshot) });
    const passed = terminal.receipt?.state === "succeeded"
      && terminal.receipt.reasonCode === "enter_exit_completed"
      && terminal.snapshot.location === door.targetLocation
      && terminal.snapshot.tile.x === door.targetX
      && terminal.snapshot.tile.y === door.targetY;
    console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "enter_exit_completed" : "enter_exit_postcondition_mismatch", target: door, trace, durationMs: Date.now() - startedAt }));
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  const latest = client.state.latestReceipt;
  const acceptedExecutionId = trace.find((entry) => entry.phase === "accepted")?.receipt?.executionId;
  const recovered = latest?.executionId === acceptedExecutionId
    && latest.state === "succeeded"
    && latest.reasonCode === "enter_exit_completed";
  if (recovered) {
    const recoveredSnapshot = snapshotFromReceipt(latest);
    const target = trace.find((entry) => entry.phase === "accepted")?.door;
    const passed = target !== undefined
      && recoveredSnapshot.location === target.targetLocation
      && recoveredSnapshot.tile.x === target.targetX
      && recoveredSnapshot.tile.y === target.targetY;
    console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "enter_exit_completed" : "enter_exit_postcondition_mismatch", target, trace, recoveredReceipt: summarizeReceipt(latest), durationMs: Date.now() - startedAt }));
    if (!passed) process.exitCode = 2;
  } else {
    console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: client.state.latestReceipt, bridgeReason: client.state.latestReasonCode, trace }));
    process.exitCode = 2;
  }
} finally {
  unsubscribe();
  client.close();
}

function chooseAdjacentDoor(snapshot) {
  if (!Array.isArray(snapshot.doorTargets)) return null;
  return snapshot.doorTargets.find((door) => Math.abs(door.sourceX - snapshot.tile.x) <= 1 && Math.abs(door.sourceY - snapshot.tile.y) <= 1) ?? null;
}
function chooseNearestDoor(snapshot) {
  if (!Array.isArray(snapshot.doorTargets) || snapshot.doorTargets.length === 0) return null;
  return [...snapshot.doorTargets].sort((a, b) =>
    Math.abs(a.sourceX - snapshot.tile.x) + Math.abs(a.sourceY - snapshot.tile.y)
    - Math.abs(b.sourceX - snapshot.tile.x) - Math.abs(b.sourceY - snapshot.tile.y))[0] ?? null;
}
async function waitForActionable(client, snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = snapshot;
  while (Date.now() < deadline) {
    if (latest.actionable && latest.activeExecution == null) return latest;
    await delay(150);
    latest = await client.observe();
  }
  return latest;
}
async function waitForMoveTerminal(client, executionId, door, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    // Prefer the bridge's durable latest receipt over a possibly delayed event.
    // A native-path completion may arrive between observe calls.
    const receipt = client.state.latestReceipt?.executionId === executionId
      ? client.state.latestReceipt
      : findReceipt(executionId);
    if (receipt !== null && isTerminalState(receipt.state)) return { receipt: summarizeReceipt(receipt), snapshot: latest };
    await delay(250);
    latest = await client.observe();
  }
  const finalReceipt = client.state.latestReceipt?.executionId === executionId
    ? client.state.latestReceipt
    : findReceipt(executionId);
  if (finalReceipt !== null && isTerminalState(finalReceipt.state)) return { receipt: summarizeReceipt(finalReceipt), snapshot: latest };
  throw new Error("prepare_move_terminal_timeout");
}
async function waitForTransitionTerminal(client, executionId, door, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const receipt = findReceipt(executionId);
    if (receipt !== null && isTerminalState(receipt.state)) {
      if (receipt.state !== "succeeded" || latest === null) {
        try { latest = await client.observe(); } catch { }
      }
      return { receipt: summarizeReceipt(receipt), snapshot: latest ?? snapshotFromReceipt(receipt) };
    }
    try { latest = await client.observe(); } catch { }
    const refreshedReceipt = findReceipt(executionId);
    if (refreshedReceipt !== null && isTerminalState(refreshedReceipt.state)) {
      return { receipt: summarizeReceipt(refreshedReceipt), snapshot: latest ?? snapshotFromReceipt(refreshedReceipt) };
    }
    if (latest?.location === door.targetLocation && latest.tile.x === door.targetX && latest.tile.y === door.targetY) {
      if (refreshedReceipt?.state === "succeeded") return { receipt: summarizeReceipt(refreshedReceipt), snapshot: latest };
    }
    await delay(250);
  }
  const finalReceipt = findReceipt(executionId);
  if (finalReceipt !== null && isTerminalState(finalReceipt.state)) {
    return { receipt: summarizeReceipt(finalReceipt), snapshot: latest ?? snapshotFromReceipt(finalReceipt) };
  }
  throw new Error("enter_exit_terminal_timeout");
}
function snapshotFromReceipt(receipt) {
  const actual = receipt.evidence?.detail?.match(/actual=([^:]+):(-?\d+),(-?\d+)$/)?.slice(1);
  return actual ? { location: actual[0], tile: { x: Number(actual[1]), y: Number(actual[2]) }, actionable: true, activeExecution: null, doorTargets: null } : { location: "unknown", tile: { x: -1, y: -1 } };
}
function findReceipt(executionId) {
  return receipts.find((receipt) => receipt.executionId === executionId)
    ?? (client.state.latestReceipt?.executionId === executionId ? client.state.latestReceipt : null);
}
function isDoorArrival(snapshot, door) { return Math.abs(snapshot.tile.x - door.sourceX) <= 1 && Math.abs(snapshot.tile.y - door.sourceY) <= 1; }
function isTerminalState(state) { return ["blocked", "invalidated", "succeeded", "partially_succeeded", "failed", "cancelled", "expired", "rejected", "uncertain"].includes(state); }
function summarizeSnapshot(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, doorTargets: snapshot.doorTargets?.length ?? null, activeExecution: snapshot.activeExecution?.executionId ?? null }; }
function summarizeReceipt(receipt) { return receipt == null ? null : { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null }; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
