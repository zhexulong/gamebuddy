import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0))
  throw new Error("invalid_client_config");

const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const trace = [];
const receiptFacts = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receiptFacts.push(fact.payload);
});

try {
  if (!client.state.capabilities.includes("travel")) throw new Error("travel_capability_missing");
  const initial = await client.observe();
  if (!initial.capabilities.includes("travel")) throw new Error("snapshot_travel_capability_missing");
  let prepared = initial;
  let warp = chooseAdjacentWarp(prepared);
  if (warp === null && process.argv.includes("--prepare-with-move")) {
    const candidate = chooseNearestWarp(prepared);
    if (candidate !== null) {
      const moveReceipt = await client.execute({
        requestId: `travel_prepare_move_${Date.now()}`,
        idempotencyKey: `travel_prepare_move_idem_${Date.now()}`,
        action: "move_to_tile",
        args: { x: candidate.sourceX, y: candidate.sourceY },
        expectedRevision: prepared.revision,
        deadlineMs: Date.now() + 45_000,
      });
      trace.push({
        phase: "prepare_move",
        receipt: summarizeReceipt(moveReceipt),
        target: { x: candidate.sourceX, y: candidate.sourceY },
        warp: candidate,
      });
      if (moveReceipt.state !== "accepted")
        throw new Error(`prepare_move_not_accepted:${moveReceipt.state}:${moveReceipt.reasonCode}`);
      prepared = await waitForMoveTerminal(client, receiptFacts, moveReceipt.executionId, candidate, 45_000);
      trace.push({
        phase: "prepare_move_completed",
        receipt: prepared.receipt,
        snapshot: summarizeSnapshot(prepared.snapshot),
      });
      if (prepared.receipt?.state !== "succeeded" || prepared.receipt.reasonCode !== "target_reached")
        throw new Error(`prepare_move_failed:${prepared.receipt?.state}:${prepared.receipt?.reasonCode}`);
      prepared = await waitForActionable(client, prepared.snapshot, 5_000);
      warp = chooseAdjacentWarp(prepared);
    }
  }
  if (warp === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_adjacent_native_warp",
        initial: summarizeSnapshot(initial),
        final: summarizeSnapshot(prepared),
        availableWarpCount: prepared.warps?.length ?? 0,
        durationMs: Date.now() - startedAt,
      }),
    );
    unsubscribe();
    client.close();
    process.exit(2);
  }

  const requestId = `travel_${Date.now()}`;
  const idempotencyKey = `travel_idem_${Date.now()}`;
  const accepted = await client.execute({
    requestId,
    idempotencyKey,
    action: "travel",
    args: { x: warp.sourceX, y: warp.sourceY },
    expectedRevision: prepared.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase: "accepted", receipt: summarizeReceipt(accepted), initial: summarizeSnapshot(prepared), warp });
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.state}:${accepted.reasonCode}`);

  const terminal = await waitForTravelTerminal(client, receiptFacts, accepted.executionId, warp, 15_000);
  trace.push({ phase: "warped", receipt: terminal.receipt, snapshot: summarizeSnapshot(terminal.snapshot) });
  const passed =
    terminal.receipt?.state === "succeeded" &&
    terminal.receipt.reasonCode === "travel_completed" &&
    terminal.snapshot.location === warp.targetLocation &&
    terminal.snapshot.tile.x === warp.targetX &&
    terminal.snapshot.tile.y === warp.targetY;
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "travel_completed" : "travel_postcondition_mismatch",
      durationMs: Date.now() - startedAt,
      initial: summarizeSnapshot(initial),
      target: warp,
      trace,
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: client.state.latestReceipt,
      bridgeReason: client.state.latestReasonCode,
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function chooseAdjacentWarp(snapshot) {
  if (!Array.isArray(snapshot.warps)) return null;
  return (
    snapshot.warps.find(
      (warp) =>
        Number.isInteger(warp.sourceX) &&
        Number.isInteger(warp.sourceY) &&
        Math.abs(warp.sourceX - snapshot.tile.x) <= 1 &&
        Math.abs(warp.sourceY - snapshot.tile.y) <= 1 &&
        warp.targetLocation.length > 0,
    ) ?? null
  );
}

function chooseNearestWarp(snapshot) {
  if (!Array.isArray(snapshot.warps) || snapshot.warps.length === 0) return null;
  return (
    [...snapshot.warps].sort(
      (left, right) =>
        Math.abs(left.sourceX - snapshot.tile.x) +
        Math.abs(left.sourceY - snapshot.tile.y) -
        Math.abs(right.sourceX - snapshot.tile.x) -
        Math.abs(right.sourceY - snapshot.tile.y),
    )[0] ?? null
  );
}

async function waitForActionable(client, snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = snapshot;
  while (Date.now() < deadline) {
    if (latest.actionable && latest.activeExecution == null) return latest;
    await new Promise((resolve) => setTimeout(resolve, 150));
    latest = await client.observe();
  }
  return latest;
}

async function waitForMoveTerminal(client, receipts, executionId, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const receipt = receipts.find(
      (candidate) => candidate.executionId === executionId && isTerminalState(candidate.state),
    );
    if (receipt !== undefined) {
      if (receipt.state !== "succeeded") return { receipt: summarizeReceipt(receipt), snapshot: latest };
      if (isWarpArrival(latest, target) && latest.activeExecution == null)
        return { receipt: summarizeReceipt(receipt), snapshot: latest };
    }
    if (isWarpArrival(latest, target) && latest.activeExecution == null) {
      const matching = receipts.find((candidate) => candidate.executionId === executionId);
      if (matching !== undefined && matching.state === "succeeded")
        return { receipt: summarizeReceipt(matching), snapshot: latest };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await client.observe();
  }
  throw new Error("prepare_move_terminal_timeout");
}

async function isWarpArrival(snapshot, warp) {
  return Math.abs(snapshot.tile.x - warp.sourceX) <= 1 && Math.abs(snapshot.tile.y - warp.sourceY) <= 1;
}

async function waitForTravelTerminal(client, receipts, executionId, warp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const receipt = receipts.find(
      (candidate) => candidate.executionId === executionId && isTerminalState(candidate.state),
    );
    if (receipt !== undefined) return { receipt: summarizeReceipt(receipt), snapshot: latest };
    if (latest.location === warp.targetLocation && latest.tile.x === warp.targetX && latest.tile.y === warp.targetY) {
      const matching = receipts.find((candidate) => candidate.executionId === executionId);
      if (matching !== undefined && matching.state === "succeeded")
        return { receipt: summarizeReceipt(matching), snapshot: latest };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await client.observe();
  }
  throw new Error("travel_terminal_timeout");
}

function isTerminalState(state) {
  return [
    "blocked",
    "invalidated",
    "succeeded",
    "partially_succeeded",
    "failed",
    "cancelled",
    "expired",
    "rejected",
    "uncertain",
  ].includes(state);
}

function summarizeSnapshot(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    capabilities: snapshot.capabilities,
    warps: snapshot.warps?.length ?? null,
    activeExecution:
      snapshot.activeExecution == null
        ? null
        : {
            executionId: snapshot.activeExecution.executionId,
            requestId: snapshot.activeExecution.requestId,
            state: snapshot.activeExecution.state,
            reasonCode: snapshot.activeExecution.reasonCode,
          },
  };
}

function summarizeReceipt(receipt) {
  return receipt == null
    ? null
    : {
        executionId: receipt.executionId,
        requestId: receipt.requestId,
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        revision: receipt.revision,
        evidence: receipt.evidence,
      };
}
