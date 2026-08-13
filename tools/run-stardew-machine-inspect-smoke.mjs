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
try {
  if (!client.state.capabilities.includes("machine_inspect")) throw new Error("machine_inspect_capability_missing");
  const snapshot = await client.observe();
  if (!snapshot.capabilities.includes("machine_inspect"))
    throw new Error("snapshot_machine_inspect_capability_missing");
  const target = Array.isArray(snapshot.machineTargets)
    ? (snapshot.machineTargets.find(
        (entry) => typeof entry.targetId === "string" && Number.isInteger(entry.x) && Number.isInteger(entry.y),
      ) ?? null)
    : null;
  if (target === null) {
    console.log(
      JSON.stringify({ state: "blocked", reasonCode: "no_live_machine_target", snapshot: summarize(snapshot) }),
    );
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `machine_inspect_${Date.now()}`,
      idempotencyKey: `machine_inspect_idem_${Date.now()}`,
      action: "machine_inspect",
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const evidence = detailEvidence(receipt.evidence);
    const reread = Array.isArray(after.machineTargets)
      ? (after.machineTargets.find((entry) => entry?.targetId === target.targetId) ?? null)
      : null;
    const sameLiveState =
      reread !== null &&
      reread.x === target.x &&
      reread.y === target.y &&
      reread.qualifiedItemId === target.qualifiedItemId &&
      reread.readyForHarvest === target.readyForHarvest &&
      reread.minutesUntilReady === target.minutesUntilReady &&
      (reread.heldObjectQualifiedItemId ?? null) === (target.heldObjectQualifiedItemId ?? null) &&
      (reread.lastInputQualifiedItemId ?? null) === (target.lastInputQualifiedItemId ?? null);
    const evidenceMatches =
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.machine === target.qualifiedItemId &&
      evidence.ready_for_harvest === String(target.readyForHarvest) &&
      evidence.minutes_until_ready === String(target.minutesUntilReady) &&
      evidence.held === (target.heldObjectQualifiedItemId ?? "none") &&
      evidence.last_input === (target.lastInputQualifiedItemId ?? "none");
    const passed =
      receipt.state === "succeeded" && receipt.reasonCode === "machine_inspected" && evidenceMatches && sameLiveState;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "machine_inspected" : receipt.reasonCode,
        target: summarizeTarget(target),
        receipt: summarizeReceipt(receipt),
        evidence,
        reread: summarizeTarget(reread),
        sameLiveState,
        after: summarize(after),
      }),
    );
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: client.state.latestReceipt,
    }),
  );
  process.exitCode = 2;
} finally {
  client.close();
}

function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    machineTargets: snapshot.machineTargets?.length ?? 0,
  };
}
function detailEvidence(evidence) {
  const raw = evidence?.detail ?? evidence;
  if (typeof raw !== "string") return {};
  return Object.fromEntries(
    raw.split(";").map((part) => {
      const index = part.indexOf("=");
      return index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
    }),
  );
}
function summarizeTarget(target) {
  if (target === null || target === undefined) return null;
  return {
    targetId: target.targetId,
    x: target.x,
    y: target.y,
    qualifiedItemId: target.qualifiedItemId,
    readyForHarvest: target.readyForHarvest,
    minutesUntilReady: target.minutesUntilReady,
    heldObjectQualifiedItemId: target.heldObjectQualifiedItemId ?? null,
    lastInputQualifiedItemId: target.lastInputQualifiedItemId ?? null,
  };
}
function summarizeReceipt(receipt) {
  return {
    executionId: receipt.executionId,
    requestId: receipt.requestId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence ?? null,
  };
}
