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
  if (!client.state.capabilities.includes("npc_relationship")) throw new Error("npc_relationship_capability_missing");
  const snapshot = await client.observe();
  if (!snapshot.capabilities.includes("npc_relationship")) throw new Error("snapshot_npc_relationship_capability_missing");
  const target = Array.isArray(snapshot.npcRelationshipTargets)
    ? snapshot.npcRelationshipTargets.find((entry) => typeof entry.targetId === "string" && Number.isInteger(entry.x) && Number.isInteger(entry.y)) ?? null
    : null;
  if (target === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_live_npc_relationship_target", snapshot: summarize(snapshot), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `npc_relationship_${Date.now()}`,
      idempotencyKey: `npc_relationship_idem_${Date.now()}`,
      action: "npc_relationship",
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      expectedRevision: snapshot.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const afterTarget = after.npcRelationshipTargets?.find((entry) => entry.targetId === target.targetId) ?? null;
    const passed = receipt.state === "succeeded"
      && receipt.reasonCode === "npc_relationship_inspected"
      && afterTarget !== null
      && afterTarget.npcName === target.npcName;
    console.log(JSON.stringify({
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "npc_relationship_inspected" : receipt.reasonCode,
      target: summarizeTarget(target),
      receipt: summarizeReceipt(receipt),
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
  return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, npcRelationshipTargets: snapshot.npcRelationshipTargets?.length ?? 0 };
}
function summarizeTarget(target) {
  return { targetId: target.targetId, x: target.x, y: target.y, npcName: target.npcName, friendshipPoints: target.friendshipPoints, friendshipStatus: target.friendshipStatus, talkedToToday: target.talkedToToday, giftsToday: target.giftsToday, giftsThisWeek: target.giftsThisWeek };
}
function summarizeReceipt(receipt) {
  return { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null };
}
