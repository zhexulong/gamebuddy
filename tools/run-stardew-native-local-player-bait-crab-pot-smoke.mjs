import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");
function option(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[i + 1];
}
const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
if (JSON.stringify(config.EnabledActions) !== JSON.stringify(["bait_crab_pot"])) throw new Error("production_capability_profile_invalid");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
try {
  const before = await client.observe();
  if (!before.capabilities.includes("bait_crab_pot") || !before.actionable || before.activeExecution != null) throw new Error("production_player_not_actionable");
  const target = before.baitCrabPotTargets?.find((entry) => Math.abs(entry.x - before.tile.x) <= 1 && Math.abs(entry.y - before.tile.y) <= 1);
  if (!target || target.baitQualifiedItemId !== "(O)685" || target.qualifiedItemId !== "(O)710" || target.baitStack !== 1) throw new Error("no_adjacent_unbaited_crab_pot_target");
  const requestId = `native_local_bait_crab_pot_${Date.now()}`;
  const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action: "bait_crab_pot", args: { slot: target.slot, x: target.x, y: target.y, expectedQualifiedItemId: "(O)685", expectedTargetId: target.targetId }, expectedRevision: before.revision, deadlineMs: Date.now() + 30_000 });
  const after = await client.observe();
  const evidence = parseEvidence(receipt.evidence?.detail);
  const result = after.baitCrabPotResultTargets?.find((entry) => entry.targetId === target.targetId);
  const passed = receipt.requestId === requestId && receipt.state === "succeeded" && receipt.reasonCode === "crab_pot_baited" && typeof receipt.executionId === "string" && receipt.executionId.length > 0 && receipt.revision === after.revision && after.revision > before.revision && evidence.source === "(O)685" && evidence.pot === "(O)710" && evidence.bait_before === "none" && evidence.bait_after === "(O)685" && Number(evidence.x) === target.x && Number(evidence.y) === target.y && evidence.target === target.targetId && Number(evidence.slot) === target.slot && Number(evidence.inventory_before) === 1 && Number(evidence.inventory_after) === 0 && evidence.owner === target.ownerId && result?.targetId === target.targetId && result.location === target.location && result.x === target.x && result.y === target.y && result.slot === target.slot && result.qualifiedItemId === "(O)710" && result.baitQualifiedItemId === "(O)685" && result.ownerId === target.ownerId && result.baitStack === 1 && !after.baitCrabPotTargets?.some((entry) => entry.targetId === target.targetId) && after.actionable && after.activeExecution == null;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", action: "bait_crab_pot", requestId, target, receipt, evidence, result: result ?? null, before: summarize(before), after: summarize(after) }));
  if (!passed) process.exitCode = 2;
} finally { client.close(); }
function parseEvidence(detail) { if (typeof detail !== "string") throw new Error("missing_bait_crab_pot_evidence"); const out = {}; for (const part of detail.split(";")) { const i = part.indexOf("="); if (i <= 0 || out[part.slice(0, i)] !== undefined) throw new Error("malformed_bait_crab_pot_evidence"); out[part.slice(0, i)] = part.slice(i + 1); } return out; }
function summarize(s) { return { revision: s.revision, location: s.location, tile: s.tile, actionable: s.actionable, baitCrabPotTargets: s.baitCrabPotTargets?.length ?? 0, baitCrabPotResultTargets: s.baitCrabPotResultTargets?.length ?? 0, activeExecution: s.activeExecution ?? null }; }
