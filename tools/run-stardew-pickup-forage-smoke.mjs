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
  if (!client.state.capabilities.includes("pickup_forage")) throw new Error("pickup_forage_capability_missing");
  const before = await client.observe();
  if (!before.capabilities.includes("pickup_forage")) throw new Error("snapshot_pickup_forage_capability_missing");
  const target = chooseTarget(before);
  if (target === null) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: "no_live_forage_target", snapshot: summarize(before), durationMs: Date.now() - startedAt }));
    process.exitCode = 2;
  } else {
    const receipt = await client.execute({
      requestId: `pickup_forage_${Date.now()}`,
      idempotencyKey: `pickup_forage_idem_${Date.now()}`,
      action: "pickup_forage",
      args: { x: target.x, y: target.y, expectedQualifiedItemId: target.qualifiedItemId, expectedTargetId: target.targetId },
      expectedRevision: before.revision,
      deadlineMs: Date.now() + 30_000,
    });
    const after = await client.observe();
    const stillPresent = after.forageTargets?.some((entry) => entry.targetId === target.targetId) === true;
    const passed = receipt.state === "succeeded" && receipt.reasonCode === "forage_picked_up" && !stillPresent;
    console.log(JSON.stringify({ state: passed ? "passed" : "blocked", reasonCode: passed ? "forage_picked_up" : receipt.reasonCode, target, receipt: summarizeReceipt(receipt), before: summarize(before), after: summarize(after), durationMs: Date.now() - startedAt }));
    if (!passed) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256) }));
  process.exitCode = 2;
} finally {
  client.close();
}

function chooseTarget(snapshot) {
  if (!Array.isArray(snapshot.forageTargets)) return null;
  return snapshot.forageTargets.find((entry) => typeof entry.targetId === "string" && Number.isInteger(entry.x) && Number.isInteger(entry.y) && typeof entry.qualifiedItemId === "string") ?? null;
}
function summarize(snapshot) {
  return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, forageTargets: snapshot.forageTargets?.length ?? 0, inventorySlots: snapshot.inventorySlots ?? null };
}
function summarizeReceipt(receipt) {
  return { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null };
}
