import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";
function option(name) { const i = process.argv.indexOf(name); if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`); return process.argv[i + 1]; }
const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0)) throw new Error("invalid_client_config");
if (JSON.stringify(config.EnabledActions) !== JSON.stringify(["move_to_tile", "travel", "place_crab_pot"])) throw new Error("production_capability_profile_invalid");
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
try {
  let before = await client.observe();
  for (const action of ["move_to_tile", "travel", "place_crab_pot"]) if (!before.capabilities.includes(action)) throw new Error(`native_local_${action}_capability_missing`);
  if (!before.actionable || before.activeExecution != null) throw new Error("production_player_not_actionable");
  const target = before.crabPotTargets?.find((entry) => Math.abs(entry.x - before.tile.x) <= 1 && Math.abs(entry.y - before.tile.y) <= 1);
  if (!target) throw new Error("no_adjacent_live_crab_pot_target");
  const requestId = `native_local_place_crab_pot_${Date.now()}`;
  const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action: "place_crab_pot", args: { slot: target.slot, x: target.x, y: target.y, expectedQualifiedItemId: target.qualifiedItemId, expectedTargetId: target.targetId }, expectedRevision: before.revision, deadlineMs: Date.now() + 30_000 });
  const after = await client.observe();
  const evidence = parseEvidence(receipt.evidence?.detail);
  const result = after.crabPotResultTargets?.find((entry) => entry.targetId === target.targetId);
  // Native CrabPot.updateOffset and getOverlayTiles can both legitimately
  // produce empty/zero facts for an all-water neighborhood. Require finite
  // offset coordinates and a well-formed (possibly empty) target-bound list.
  const overlayFacts = Array.isArray(result?.overlayTiles) && result.overlayTiles.every((tile) => Number.isInteger(tile.x) && Number.isInteger(tile.y) && Number.isInteger(tile.count) && tile.count > 0);
  const resultMatches = result !== undefined && result.location === target.location && result.x === target.x && result.y === target.y && result.slot === target.slot && result.targetId === target.targetId && result.qualifiedItemId === target.qualifiedItemId && result.ownerId > 0 && Number.isFinite(result.offsetX) && Number.isFinite(result.offsetY) && overlayFacts;
  const evidenceMatches = receipt.requestId === requestId && receipt.state === "succeeded" && receipt.reasonCode === "crab_pot_placed" && typeof receipt.executionId === "string" && receipt.executionId.length > 0 && receipt.revision === after.revision && evidence.source === "(O)710" && evidence.location === target.location && Number(evidence.x) === target.x && Number(evidence.y) === target.y && evidence.target === target.targetId && evidence.item === target.qualifiedItemId && Number(evidence.slot) === target.slot && evidence.is_crab_pot === "true" && Number(evidence.owner) === result?.ownerId && Number(evidence.inventory_before) === 1 && Number(evidence.inventory_after) === 0 && evidence.overlay_tiles !== undefined && evidence.offset_x === String(result?.offsetX) && evidence.offset_y === String(result?.offsetY);
  const passed = evidenceMatches && resultMatches && before.crabPotTargets?.some((entry) => entry.targetId === target.targetId) && !after.crabPotTargets?.some((entry) => entry.targetId === target.targetId) && after.crabPotResultTargets?.some((entry) => entry.targetId === target.targetId) && after.actionable && after.activeExecution == null;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", action: "place_crab_pot", target, receipt, evidence, result: result ?? null, evidenceMatches, resultMatches, before: summarize(before), after: summarize(after) }));
  if (!passed) process.exitCode = 2;
} finally { client.close(); }
function parseEvidence(detail) { if (typeof detail !== "string") throw new Error("missing_crab_pot_evidence"); const out = {}; for (const part of detail.split(";")) { const i = part.indexOf("="); if (i <= 0 || out[part.slice(0, i)] !== undefined) throw new Error("malformed_crab_pot_evidence"); out[part.slice(0, i)] = part.slice(i + 1); } return out; }
function summarize(s) { return { revision: s.revision, location: s.location, tile: s.tile, actionable: s.actionable, crabPotTargets: s.crabPotTargets?.length ?? 0, crabPotResultTargets: s.crabPotResultTargets?.length ?? 0, activeExecution: s.activeExecution ?? null }; }
