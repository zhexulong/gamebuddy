import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";

const SCENARIO = "native_npc_relationship_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "npc_relationship"];
const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateNativeLocalConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  let snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  if (snapshot.location !== "FarmHouse") throw new Error("npc_relationship_route_must_start_at_farmhouse");
  // The fixture establishes a bounded native villager target near the live
  // FarmHouse→Farm warp. Typed travel remains production-owned; no Town
  // schedule, NPC positioning, or relationship mutation occurs in the runner.
  snapshot = await travelFreshHop(snapshot, "FarmHouse", "Farm", "farmhouse_to_farm");
  let target = chooseOnlyFreshFixtureTarget(snapshot);
  if (!adjacent(snapshot.tile, target)) {
    snapshot = await moveToLiveTarget(target, "move_to_npc_relationship_fixture");
    target = chooseOnlyFreshFixtureTarget(snapshot);
  }
  if (!adjacent(snapshot.tile, target)) throw new Error("npc_relationship_fixture_target_unreachable");
  const accepted = await execute("inspect_npc_relationship", "npc_relationship", {
    x: target.x, y: target.y, expectedTargetId: target.targetId,
  }, snapshot);
  if (accepted.state !== "accepted" && !(accepted.state === "succeeded" && accepted.reasonCode === "npc_relationship_inspected")) throw new Error(`npc_relationship_not_accepted:${accepted.reasonCode}`);
  const terminal = await terminalForRequest(accepted, 5_000);
  const after = await observeActionable();
  requireExactCapabilities(after);
  if (after.location !== "Farm") throw new Error("npc_relationship_postcondition_location_changed");
  const reread = chooseSameFreshTarget(after, target.targetId);
  const evidence = parseEvidence(terminal.evidence);
  const passed = terminal.executionId === accepted.executionId
    && terminal.requestId === accepted.requestId
    && terminal.state === "succeeded"
    && terminal.reasonCode === "npc_relationship_inspected"
    && after.revision >= terminal.revision
    && evidenceMatchesTarget(evidence, target, "Farm")
    && sameRelationshipFacts(target, reread);
  console.log(JSON.stringify({
    state: passed ? "passed" : "blocked", topology: "native_local_player_fixture",
    reasonCode: passed ? "npc_relationship_inspected" : "npc_relationship_postcondition_mismatch",
    target: targetSummary(target), receipt: receiptSummary(terminal), evidence,
    reread: targetSummary(reread), unchangedRelationshipFacts: sameRelationshipFacts(target, reread),
    trace, after: snapshotSummary(after), durationMs: Date.now() - startedAt,
  }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: receiptSummary(client.state.latestReceipt), trace }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function chooseNearestUniqueLiveWarp(snapshot, warps) {
  if (warps.length === 1) return warps[0];
  const ranked = warps.map((warp) => ({ warp, distance: Math.abs(snapshot.tile.x - warp.sourceX) + Math.abs(snapshot.tile.y - warp.sourceY) })).sort((left, right) => left.distance - right.distance);
  return ranked.length > 1 && ranked[0].distance === ranked[1].distance ? null : ranked[0]?.warp ?? null;
}
function isTownRouteIntermediary(origin, destination) {
  // This target-version map name is a semantic route class, not a coordinate
  // seed. It is accepted only when present in the live native warp snapshot.
  return origin === "Farm" && destination === "BusStop";
}

async function travelFreshHop(snapshot, expectedOrigin, expectedLocation, phase) {
  if (snapshot.location !== expectedOrigin) throw new Error(`${phase}_origin_changed`);
  // Select every action target from the snapshot immediately preceding it;
  // route topology is derived from live warps, never coordinates.
  let routingSnapshot = await observeActionable();
  requireExactCapabilities(routingSnapshot);
  if (routingSnapshot.location !== expectedOrigin) throw new Error(`${phase}_fresh_origin_changed`);
  let warp = chooseNearestLiveWarp(routingSnapshot, expectedLocation, phase);
  if (!adjacent(routingSnapshot.tile, warpSource(warp))) {
    routingSnapshot = await moveToLiveWarp(expectedLocation, `${phase}_move`);
  }
  routingSnapshot = await observeActionable();
  requireExactCapabilities(routingSnapshot);
  if (routingSnapshot.location !== expectedOrigin) throw new Error(`${phase}_fresh_origin_changed`);
  warp = chooseNearestLiveWarp(routingSnapshot, expectedLocation, phase);
  if (!adjacent(routingSnapshot.tile, warpSource(warp))) throw new Error(`${phase}_fresh_warp_unavailable`);
  const accepted = await execute(`${phase}_travel`, "travel", { x: warp.sourceX, y: warp.sourceY }, routingSnapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await terminalForRequest(accepted, 20_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed") throw new Error(`${phase}_travel_failed:${terminal.reasonCode}`);
  // A successful native warp can leave one transient non-actionable tick.
  // This bounded wait is solely a post-terminal stabilization check; no
  // request is accepted until the existing strict actionable guard succeeds.
  const after = await waitForFreshActionablePostcondition(terminal.revision, 5_000);
  requireExactCapabilities(after);
  if (after.location !== expectedLocation || after.tile.x !== warp.targetX || after.tile.y !== warp.targetY) throw new Error(`${phase}_travel_postcondition_missing`);
  return after;
}
async function moveToLiveWarp(expectedLocation, phase) {
  const snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const warp = chooseNearestLiveWarp(snapshot, expectedLocation, phase);
  const accepted = await execute(phase, "move_to_tile", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await terminalForRequest(accepted, 55_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached") throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  requireExactCapabilities(after);
  // PathFindController may finish at an adjacent legal tile rather than the
  // requested blocked/warp source tile. The terminal native evidence is the
  // authority for that semantic arrival; the subsequent fresh snapshot need
  // only remain adjacent to the freshly rediscovered live warp.
  if (after.revision < terminal.revision || !adjacent(after.tile, warpSource(warp))) throw new Error(`${phase}_postcondition_missing`);
  return after;
}
async function moveToLiveTarget(target, phase) {
  const snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const current = validTargets(snapshot).find((entry) => entry.targetId === target.targetId);
  if (!current) throw new Error(`${phase}_target_changed`);
  // An NPC owns its own tile. Request a bounded cardinal standing tile toward
  // the current Player instead of treating an occupied NPC coordinate as a
  // movement destination. The subsequent independent inspection still binds
  // the live NPC coordinate and opaque target ID.
  const approach = nearestCardinalApproach(snapshot.tile, current);
  const accepted = await execute(phase, "move_to_tile", approach, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await terminalForRequest(accepted, 55_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached") throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  requireExactCapabilities(after);
  if (after.revision < terminal.revision || !adjacent(after.tile, current)) throw new Error(`${phase}_postcondition_missing`);
  return after;
}
async function waitForFreshActionablePostcondition(minRevision, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      const snapshot = await observeActionable();
      if (snapshot.revision >= minRevision) return snapshot;
    } catch (error) {
      if (String(error instanceof Error ? error.message : error) !== "native_local_npc_relationship_player_not_actionable") throw error;
      latestError = error;
    }
    await delay(200);
  }
  throw latestError ?? new Error("native_local_npc_relationship_post_terminal_timeout");
}
async function observeActionable() {
  const snapshot = await client.observe();
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("native_local_npc_relationship_player_not_actionable");
  if (!Number.isInteger(snapshot.revision) || typeof snapshot.location !== "string" || !Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y) || !Array.isArray(snapshot.capabilities) || !Array.isArray(snapshot.warps) || (snapshot.npcRelationshipTargets != null && !Array.isArray(snapshot.npcRelationshipTargets))) throw new Error("native_local_npc_relationship_snapshot_invalid");
  if (snapshot.npcRelationshipTargets == null) snapshot.npcRelationshipTargets = [];
  return snapshot;
}
function requireExactCapabilities(snapshot) {
  if (JSON.stringify([...snapshot.capabilities].sort()) !== JSON.stringify([...EXPECTED_CAPABILITIES].sort())) throw new Error(`native_local_npc_relationship_capability_not_isolated:${snapshot.capabilities.join(",")}`);
}
function warpSource(warp) { return { x: warp.sourceX, y: warp.sourceY }; }
function validWarp(warp) { return Number.isInteger(warp?.sourceX) && Number.isInteger(warp?.sourceY) && Number.isInteger(warp?.targetX) && Number.isInteger(warp?.targetY) && warp.sourceX >= 0 && warp.sourceY >= 0 && warp.targetX >= 0 && warp.targetY >= 0 && typeof warp.targetLocation === "string" && warp.targetLocation.length > 0; }
function chooseNearestLiveWarp(snapshot, expectedLocation, phase) {
  const matches = snapshot.warps.filter((warp) => validWarp(warp) && warp.targetLocation === expectedLocation);
  const selected = chooseNearestUniqueLiveWarp(snapshot, matches);
  if (!selected) throw new Error(matches.length === 0 ? `${phase}_live_warp_missing` : `${phase}_live_warp_ambiguous`);
  return selected;
}
function validTargets(snapshot) { return snapshot.npcRelationshipTargets.filter((target) => typeof target?.targetId === "string" && /^npc_relationship_[a-f0-9]{16}$/.test(target.targetId) && Number.isInteger(target.x) && Number.isInteger(target.y) && typeof target.npcName === "string" && target.npcName.length > 0 && Number.isInteger(target.friendshipPoints) && typeof target.friendshipStatus === "string" && target.friendshipStatus.length > 0 && typeof target.talkedToToday === "boolean" && Number.isInteger(target.giftsToday) && Number.isInteger(target.giftsThisWeek) && withinRadius(snapshot.tile, target, 6)); }
function chooseOnlyFreshFixtureTarget(snapshot) { const targets = validTargets(snapshot); if (targets.length !== 1) throw new Error(targets.length === 0 ? "no_fresh_fixture_npc_relationship_target" : "ambiguous_fresh_fixture_npc_relationship_targets"); const target = targets[0]; if (target.npcName !== "Robin" || target.friendshipPoints !== 250 || target.talkedToToday || target.giftsToday !== 0 || target.giftsThisWeek !== 0) throw new Error("npc_relationship_fixture_starting_state_mismatch"); return target; }
function chooseSameFreshTarget(snapshot, targetId) { const target = validTargets(snapshot).find((entry) => entry.targetId === targetId); if (!target) throw new Error("fresh_npc_relationship_target_missing"); return target; }
async function execute(phase, action, args, snapshot) { const requestId = `native_local_npc_relationship_${phase}_${Date.now()}_${trace.length}`; const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 }); trace.push({ phase, action, args, receipt: receiptSummary(receipt) }); return receipt; }
async function terminalForRequest(receipt, timeoutMs) { if (isTerminal(receipt?.state)) return requireReceiptIdentity(receipt, receipt.executionId, receipt.requestId); const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const terminal = receipts.find((item) => item?.executionId === receipt?.executionId && item?.requestId === receipt?.requestId && isTerminal(item.state)); if (terminal) return requireReceiptIdentity(terminal, receipt.executionId, receipt.requestId); await delay(100); } throw new Error(`terminal_timeout:${receipt?.executionId ?? "unknown"}`); }
function requireReceiptIdentity(receipt, executionId, requestId) { if (typeof executionId !== "string" || executionId.length === 0 || typeof requestId !== "string" || requestId.length === 0 || receipt?.executionId !== executionId || receipt?.requestId !== requestId) throw new Error("receipt_identity_mismatch"); return receipt; }
function parseEvidence(evidence) { const detail = typeof evidence?.detail === "string" ? evidence.detail : ""; const result = {}; for (const field of detail.split(";")) { const separator = field.indexOf("="); if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_npc_relationship_evidence"); const key = field.slice(0, separator); const value = field.slice(separator + 1); if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key)) throw new Error("invalid_npc_relationship_evidence"); result[key] = value; } const expected = ["gifts_this_week", "gifts_today", "location", "npc", "points", "status", "talked_to_today", "target", "tile"]; if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected)) throw new Error("invalid_npc_relationship_evidence"); return result; }
function evidenceMatchesTarget(evidence, target, location) { return evidence.location === location && evidence.target === target.targetId && evidence.tile === `${target.x},${target.y}` && evidence.npc === target.npcName && evidence.points === String(target.friendshipPoints) && evidence.status === target.friendshipStatus && evidence.talked_to_today === String(target.talkedToToday) && evidence.gifts_today === String(target.giftsToday) && evidence.gifts_this_week === String(target.giftsThisWeek); }
function sameRelationshipFacts(left, right) { return left.targetId === right.targetId && left.x === right.x && left.y === right.y && left.npcName === right.npcName && left.friendshipPoints === right.friendshipPoints && left.friendshipStatus === right.friendshipStatus && left.talkedToToday === right.talkedToToday && left.giftsToday === right.giftsToday && left.giftsThisWeek === right.giftsThisWeek; }
function validateNativeLocalConfig(value) { const fixture = value.NativeLocalPlayerFixture; if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== SCENARIO || typeof fixture.LogicalSaveName !== "string" || !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(fixture.LogicalSaveName) || typeof fixture.ObservedSaveSlot !== "string" || !new RegExp(`^${fixture.LogicalSaveName}_[0-9]{1,32}$`).test(fixture.ObservedSaveSlot)) throw new Error("native_local_fixture_config_invalid"); if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_fixture_topology_not_isolated"); if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify(["move_to_tile", "travel", "npc_relationship"]) || JSON.stringify(value.ExperimentalActions) !== JSON.stringify(["npc_relationship"])) throw new Error("native_local_npc_relationship_action_policy_invalid"); if (["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some((key) => typeof value[key] !== "string" || value[key].length === 0)) throw new Error("invalid_client_config"); }
function nearestCardinalApproach(player, target) {
  const candidates = [
    { x: target.x - 1, y: target.y }, { x: target.x + 1, y: target.y },
    { x: target.x, y: target.y - 1 }, { x: target.x, y: target.y + 1 },
  ].filter((candidate) => candidate.x >= 0 && candidate.y >= 0)
    .sort((left, right) => (Math.abs(player.x - left.x) + Math.abs(player.y - left.y)) - (Math.abs(player.x - right.x) + Math.abs(player.y - right.y)) || left.y - right.y || left.x - right.x);
  if (candidates.length === 0) throw new Error("npc_relationship_fixture_approach_missing");
  return candidates[0];
}
function adjacent(left, right) { return withinRadius(left, right, 1); }
function withinRadius(left, right, radius) { return Math.abs(left.x - right.x) <= radius && Math.abs(left.y - right.y) <= radius; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function targetSummary(target) { return target ? { targetId: target.targetId, x: target.x, y: target.y, npcName: target.npcName, friendshipPoints: target.friendshipPoints, friendshipStatus: target.friendshipStatus, talkedToToday: target.talkedToToday, giftsToday: target.giftsToday, giftsThisWeek: target.giftsThisWeek } : null; }
function receiptSummary(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
function snapshotSummary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, npcRelationshipTargets: snapshot.npcRelationshipTargets?.map(targetSummary) ?? [], activeExecution: snapshot.activeExecution ?? null }; }
