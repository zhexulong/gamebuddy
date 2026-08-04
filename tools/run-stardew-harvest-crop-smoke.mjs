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
  if (!client.state.capabilities.includes("harvest_crop")) throw new Error("harvest_crop_capability_missing");
  let snapshot = await client.observe();
  const readyDeadline = Date.now() + 10_000;
  while (!snapshot.actionable && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    snapshot = await client.observe();
  }
  if (!snapshot.capabilities.includes("harvest_crop")) throw new Error("snapshot_harvest_crop_capability_missing");
  const target = Array.isArray(snapshot.harvestTargets)
    ? snapshot.harvestTargets.find((entry) => Number.isInteger(entry.x)
      && Number.isInteger(entry.y)
      && typeof entry.targetId === "string"
      && typeof entry.qualifiedHarvestItemId === "string"
      && entry.qualifiedHarvestItemId.length > 0) ?? null
    : null;
  if (target === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_live_ready_crop_target", snapshot: summarize(snapshot), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `harvest_crop_${Date.now()}`,
      idempotencyKey: `harvest_crop_idem_${Date.now()}`,
      action: "harvest_crop",
      args: { x: target.x, y: target.y, expectedQualifiedItemId: target.qualifiedHarvestItemId, expectedTargetId: target.targetId },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const evidence = typeof receipt.evidence?.detail === "string" ? parseEvidence(receipt.evidence.detail) : {};
    const nativeAccepted = evidence.native_accepted === "true";
    const inventoryGained = evidence.inventory_gained === "true";
    const cropPresentAfter = evidence.crop_present_after === "true";
    const targetStillReady = after.harvestTargets?.some((entry) => entry.targetId === target.targetId) === true;
    const postcondition = target.regrowsAfterHarvest
      ? cropPresentAfter && !targetStillReady
      : !cropPresentAfter && !targetStillReady;
    const passed = receipt.state === "succeeded"
      && receipt.reasonCode === "crop_harvested"
      && nativeAccepted
      && inventoryGained
      && postcondition;
    console.log(JSON.stringify({
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "crop_harvested" : receipt.reasonCode,
      target: summarizeTarget(target),
      receipt: summarizeReceipt(receipt),
      before: summarize(snapshot),
      after: summarize(after),
      durationMs: Date.now() - startedAt,
    }));
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: client.state.latestReceipt }));
  process.exitCode = 2;
} finally {
  client.close();
}

function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    harvestTargets: snapshot.harvestTargets?.length ?? 0,
    cropTargets: snapshot.cropTargets?.length ?? 0,
  };
}
function summarizeTarget(target) {
  return {
    targetId: target.targetId,
    x: target.x,
    y: target.y,
    cropId: target.cropId,
    qualifiedHarvestItemId: target.qualifiedHarvestItemId,
    regrowsAfterHarvest: target.regrowsAfterHarvest,
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
function parseEvidence(detail) {
  return Object.fromEntries(detail.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator < 1 ? [] : [[part.slice(0, separator), part.slice(separator + 1)]];
  }));
}
