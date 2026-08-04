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
const trace = [];
try {
  if (!client.state.capabilities.includes("collect_resource")) throw new Error("collect_resource_capability_missing");
  let snapshot = await client.observe();
  if (!snapshot.capabilities.includes("collect_resource")) throw new Error("snapshot_collect_resource_capability_missing");
  let target = chooseTarget(snapshot);
  if (target === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_live_tree_stump", snapshot: summarize(snapshot), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    let receipt = null;
    for (let hit = 1; hit <= 2; hit++) {
      receipt = await client.execute({
        requestId: `collect_resource_${Date.now()}_${hit}`,
        idempotencyKey: `collect_resource_idem_${Date.now()}_${hit}`,
        action: "collect_resource",
        args: { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 30_000,
      });
      trace.push({ hit, target: summarizeTarget(target), receipt: summarizeReceipt(receipt) });
      if (receipt.state !== "partially_succeeded" && receipt.state !== "uncertain") break;
      if (receipt.reasonCode === "resource_drop_pending") break;
      if (receipt.reasonCode !== "resource_hit") break;
      snapshot = await client.observe();
      target = chooseTarget(snapshot, target.targetId);
      if (target === null) break;
    }
    const after = await client.observe();
    const reasonCode = receipt?.reasonCode === "resource_drop_pending"
      ? "resource_collection_identity_unavailable"
      : receipt?.reasonCode ?? "resource_target_unavailable";
    console.log(JSON.stringify({ state: "blocked", reasonCode, trace, after: summarize(after), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: client.state.latestReceipt, trace }));
  process.exitCode = 2;
} finally {
  client.close();
}

function chooseTarget(snapshot, targetId = null) {
  if (!Array.isArray(snapshot.resourceTargets)) return null;
  return snapshot.resourceTargets.find((entry) => (targetId === null || entry.targetId === targetId)
    && entry.stump === true && entry.toolKind === "axe"
    && Number.isInteger(entry.slot) && Number.isInteger(entry.x) && Number.isInteger(entry.y)
    && typeof entry.targetId === "string") ?? null;
}
function summarizeTarget(target) {
  return { targetId: target.targetId, slot: target.slot, x: target.x, y: target.y, treeType: target.treeType, growthStage: target.growthStage, stump: target.stump, health: target.health };
}
function summarize(snapshot) {
  return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, resourceTargets: snapshot.resourceTargets?.length ?? 0, toolSlots: snapshot.toolSlots?.length ?? 0 };
}
function summarizeReceipt(receipt) {
  return { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null };
}
