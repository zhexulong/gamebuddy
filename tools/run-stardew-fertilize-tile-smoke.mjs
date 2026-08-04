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
const startedAt = Date.now();
try {
  if (!client.state.capabilities.includes("fertilize_tile")) throw new Error("fertilize_tile_capability_missing");
  const before = await client.observe();
  if (!before.capabilities.includes("fertilize_tile")) throw new Error("snapshot_fertilize_tile_capability_missing");
  const target = chooseTarget(before);
  if (target === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_live_fertilizer_target", snapshot: summarize(before), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `fertilize_tile_${Date.now()}`,
      idempotencyKey: `fertilize_tile_idem_${Date.now()}`,
      action: "fertilize_tile",
      args: { slot: target.slot, x: target.x, y: target.y, expectedQualifiedItemId: target.qualifiedItemId, expectedTargetId: target.targetId },
      expectedRevision: before.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const stillAvailable = after.fertilizerTargets?.some((entry) => entry.targetId === target.targetId) === true;
    const evidence = parseEvidence(receipt.evidence);
    const postconditionEvidence = evidence.fertilizer_before === "none"
      && evidence.fertilizer_after === target.qualifiedItemId
      && Number.isSafeInteger(Number(evidence.inventory_before))
      && Number(evidence.inventory_after) === Number(evidence.inventory_before) - 1;
    const passed = receipt.state === "succeeded" && receipt.reasonCode === "fertilizer_applied" && !stillAvailable && postconditionEvidence;
    console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "fertilizer_applied" : receipt.reasonCode, target, receipt: summarizeReceipt(receipt), before: summarize(before), after: summarize(after), durationMs: Date.now() - startedAt }));
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256) }));
  process.exitCode = 2;
} finally {
  client.close();
}

function chooseTarget(snapshot) {
  if (!Array.isArray(snapshot.fertilizerTargets)) return null;
  return snapshot.fertilizerTargets.find((entry) => Number.isInteger(entry.slot) && Number.isInteger(entry.x) && Number.isInteger(entry.y)
    && typeof entry.targetId === "string" && typeof entry.qualifiedItemId === "string") ?? null;
}
function summarize(snapshot) {
  return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, fertilizerTargets: snapshot.fertilizerTargets?.length ?? 0, inventorySlots: snapshot.inventorySlots ?? null };
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(detail.split(";").map((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null;
  }).filter(Boolean));
}
function summarizeReceipt(receipt) {
  return { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null };
}
