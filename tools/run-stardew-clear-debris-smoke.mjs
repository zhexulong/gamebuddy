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
const startedAt = Date.now();
const trace = [];
try {
  if (!client.state.capabilities.includes("clear_debris")) throw new Error("clear_debris_capability_missing");
  let snapshot = await client.observe();
  if (!snapshot.capabilities.includes("clear_debris")) throw new Error("snapshot_clear_debris_capability_missing");
  let target = chooseTarget(snapshot);
  if (target === null) {
    console.log(
      JSON.stringify({
        state: "blocked",
        reasonCode: "no_live_resource_clump",
        snapshot: summarize(snapshot),
        durationMs: Date.now() - startedAt,
      }),
    );
    process.exitCode = 2;
  } else {
    const maxHits = Math.min(32, Math.max(1, Number.isInteger(target.requiredUpgradeLevel) ? 16 : 8));
    let receipt = null;
    for (let hit = 1; hit <= maxHits; hit++) {
      receipt = await client.execute({
        requestId: `clear_debris_${Date.now()}_${hit}`,
        idempotencyKey: `clear_debris_idem_${Date.now()}_${hit}`,
        action: "clear_debris",
        args: { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 30_000,
      });
      trace.push({ hit, target, receipt: summarizeReceipt(receipt) });
      if (receipt.state === "succeeded" && receipt.reasonCode === "debris_cleared") break;
      if (receipt.state !== "partially_succeeded" || receipt.reasonCode !== "debris_hit") break;
      snapshot = await client.observe();
      target = chooseTarget(snapshot, target.targetId);
      if (target === null) break;
    }
    const after = await client.observe();
    const stillPresent = after.debrisTargets?.some((entry) => entry.targetId === trace[0]?.target.targetId) === true;
    const passed = receipt?.state === "succeeded" && receipt.reasonCode === "debris_cleared" && !stillPresent;
    console.log(
      JSON.stringify({
        state: passed ? "passed" : "blocked",
        reasonCode: passed ? "debris_cleared" : (receipt?.reasonCode ?? "debris_target_unavailable"),
        trace,
        after: summarize(after),
        durationMs: Date.now() - startedAt,
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
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  client.close();
}

function chooseTarget(snapshot, targetId = null) {
  if (!Array.isArray(snapshot.debrisTargets)) return null;
  return (
    snapshot.debrisTargets.find(
      (entry) =>
        (targetId === null || entry.targetId === targetId) &&
        Number.isInteger(entry.slot) &&
        Number.isInteger(entry.x) &&
        Number.isInteger(entry.y) &&
        typeof entry.targetId === "string",
    ) ?? null
  );
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    debrisTargets: snapshot.debrisTargets?.length ?? 0,
    toolSlots: snapshot.toolSlots?.length ?? 0,
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
