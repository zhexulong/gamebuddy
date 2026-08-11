import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist/local-stardew-bridge.js";

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
let lastSnapshot = null;
let enterTerminal = null;
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  let snapshot = await observeActionable();
  requireCapabilities(snapshot);
  // The fixture may pre-position this otherwise unreachably distant spatial
  // precondition inside the selected AnimalHouse before bridge attachment. In
  // that narrow case do not leave and re-enter: doing so would discard exactly
  // the native, verified standing position. All opaque target facts still come
  // exclusively from this fresh production snapshot.
  if (!isSetupBigFarmFirstDeluxeBarnLocation(snapshot.location)) {
    if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
    snapshot = await awaitSetupBigFarmFirstDeluxeBarnDoor();
    const animalHouseDoor = chooseAnimalHouseDoor(snapshot);
    if (!adjacent(snapshot.tile, animalHouseDoor)) snapshot = await moveAdjacentToDoor(snapshot, animalHouseDoor);
    snapshot = await observeActionable();
    const freshDoor = findDoor(snapshot, animalHouseDoor);
    if (!freshDoor || !adjacent(snapshot.tile, freshDoor)) throw new Error("fresh_animal_house_entry_unavailable");
    const enterAccepted = await execute("enter_animal_house", "enter_exit", { x: freshDoor.sourceX, y: freshDoor.sourceY }, snapshot);
    if (enterAccepted.state !== "accepted") throw new Error(`enter_animal_house_not_accepted:${enterAccepted.reasonCode}`);
    enterTerminal = await waitForTerminal(enterAccepted, 20_000);
    trace.push({ phase: "enter_animal_house_terminal", action: "enter_exit", receipt: receiptSummary(enterTerminal) });
    if (enterTerminal.state !== "succeeded" || enterTerminal.reasonCode !== "enter_exit_completed") throw new Error(`enter_animal_house_failed:${enterTerminal.reasonCode}`);
    snapshot = await awaitActionableSnapshotAfterEnter();
  }
  requireCapabilities(snapshot);
  const target = chooseSingleFeedTarget(snapshot);
  const feedAccepted = await execute("feed", "feed_animal", { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId }, snapshot);
  if (feedAccepted.state !== "succeeded" || feedAccepted.reasonCode !== "hay_placed_in_trough") throw new Error(`feed_animal_failed:${feedAccepted.state}:${feedAccepted.reasonCode}`);
  if (!sameIdentity(feedAccepted, feedAccepted)) throw new Error("feed_animal_identity_invalid");
  const after = await observeActionable();
  const evidence = parseEvidence(feedAccepted.evidence);
  const targetGone = (after.feedTroughTargets ?? []).every((entry) => entry.targetId !== target.targetId);
  const passed = evidence.target === target.targetId
    && evidence.tile === `${target.x},${target.y}`
    && evidence.slot === String(target.slot)
    && evidence.native_handled === "true"
    && evidence.trough_filled === "true"
    && evidence.hay_consumed === "true"
    && Number(evidence.hay_before) === target.hayStack
    && Number(evidence.hay_after) === target.hayStack - 1
    && targetGone
    && after.actionable && after.activeExecution == null;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? "hay_placed_in_trough" : "feed_animal_postcondition_mismatch", target, receipt: receiptSummary(feedAccepted), enterReceipt: receiptSummary(enterTerminal), before: summary(snapshot), after: summary(after), trace }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  // When a pre-action discovery guard fails, record only the fresh bounded
  // door facts already published by the bridge. This is diagnostic evidence,
  // never an authorization to substitute a different door.
  console.error(JSON.stringify({ state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: receiptSummary(client.state.latestReceipt), doorTargets: lastSnapshot?.doorTargets ?? [], trace }));
  process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

function validateConfig(value) {
  if (value?.NativeLocalPlayerFixture?.Enable !== true || value.NativeLocalPlayerFixture.Bootstrap?.Enable === true || value.NativeLocalPlayerFixture.FixtureScenario !== "native_feed_animal_v1" || value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, ["move_to_tile", "travel", "enter_exit", "feed_animal"])) throw new Error("native_local_feed_animal_fixture_config_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_feed_animal_topology_invalid");
}
function requireCapabilities(snapshot) { if (!same([...(snapshot.capabilities ?? [])].sort(), ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "enter_exit", "feed_animal"].sort())) throw new Error("native_local_feed_animal_capability_not_isolated"); }
async function observeActionable() { const snapshot = await client.observe(); if (!snapshot.actionable || snapshot.activeExecution != null || !Number.isInteger(snapshot.revision) || !validTile(snapshot.tile?.x) || !validTile(snapshot.tile?.y)) throw new Error("native_local_feed_animal_snapshot_not_actionable"); lastSnapshot = snapshot; return snapshot; }
async function travelToFarm(snapshot) {
  const warps = (snapshot.warps ?? []).filter((entry) => validDoor(entry) && entry.targetLocation === "Farm");
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!adjacent(snapshot.tile, warp)) snapshot = await move(snapshot, warp, "move_to_farm_warp");
  snapshot = await observeActionable();
  const fresh = (snapshot.warps ?? []).find((entry) => sameDoor(entry, warp));
  if (!fresh || !adjacent(snapshot.tile, fresh)) throw new Error("fresh_farm_warp_unavailable");
  const accepted = await execute("travel_to_farm", "travel", { x: fresh.sourceX, y: fresh.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_to_farm_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted, 20_000);
  trace.push({ phase: "travel_to_farm_terminal", action: "travel", receipt: receiptSummary(terminal) });
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed") throw new Error(`travel_to_farm_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  if (after.location !== "Farm" || after.revision < terminal.revision) throw new Error("travel_to_farm_postcondition_missing");
  return after;
}
async function awaitActionableSnapshotAfterEnter() {
  const deadline = Date.now() + 5_000;
  do {
    try { return await observeActionable(); }
    catch (error) {
      if (String(error instanceof Error ? error.message : error) !== "native_local_feed_animal_snapshot_not_actionable") throw error;
      await delay(100);
    }
  } while (Date.now() < deadline);
  throw new Error("native_local_feed_animal_post_enter_not_actionable");
}
async function awaitSetupBigFarmFirstDeluxeBarnDoor() {
  // The travel terminal proves the player entered Farm, but its immediately
  // following snapshot is allowed to precede Farm door discovery. Poll only
  // fresh actionable snapshots and retain the exact source-derived selector;
  // never substitute an arbitrary Farm door or a guessed interior name.
  const deadline = Date.now() + 5_000;
  let snapshot;
  do {
    snapshot = await observeActionable();
    const doors = (snapshot.doorTargets ?? []).filter(isSetupBigFarmFirstDeluxeBarnDoor);
    if (doors.length === 1) return snapshot;
    if (doors.length > 1) throw new Error("ambiguous_animal_house_entry");
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error("animal_house_entry_missing");
}
function chooseAnimalHouseDoor(snapshot) {
  // Target-version SetupBigFarm builds its first Deluxe Barn at (16,9), whose
  // target-version HumanDoor is (1,3), so its Farm door is (17,12).
  // Building.createIndoors publishes its AnimalHouse as the target-version
  // Deluxe Barn indoor-map name "Barn3" plus a GuidHelper.NewGuid() "D"
  // suffix; getWarpFromDoor exposes that NameOrUniqueName, rather than the
  // literal common name "Barn".
  const doors = (snapshot.doorTargets ?? []).filter(isSetupBigFarmFirstDeluxeBarnDoor);
  if (doors.length !== 1) throw new Error(doors.length ? "ambiguous_animal_house_entry" : "animal_house_entry_missing");
  return doors[0];
}
function isSetupBigFarmFirstDeluxeBarnLocation(location) {
  return typeof location === "string"
    && /^Barn3[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(location);
}
function isSetupBigFarmFirstDeluxeBarnDoor(entry) {
  return validDoor(entry)
    && entry.sourceX === 17
    && entry.sourceY === 12
    && isSetupBigFarmFirstDeluxeBarnLocation(entry.targetLocation);
}
function findDoor(snapshot, selected) { return (snapshot.doorTargets ?? []).find((entry) => sameDoor(entry, selected)); }
async function move(snapshot, target, phase) {
  const accepted = await execute(phase, "move_to_tile", { x: target.sourceX ?? target.x, y: target.sourceY ?? target.y }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted, 55_000);
  trace.push({ phase: `${phase}_terminal`, action: "move_to_tile", receipt: receiptSummary(terminal) });
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached") throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  const point = { x: target.sourceX ?? target.x, y: target.sourceY ?? target.y };
  if (after.revision < terminal.revision || !adjacent(after.tile, point)) throw new Error(`${phase}_postcondition_missing`);
  return after;
}
async function moveAdjacentToDoor(snapshot, door) {
  // A building's human-door tile can be non-pathable. Derive only its four
  // immediate approach tiles from the fresh, source-bound door; try each once
  // and accept no substitute door or target. A no_native_path receipt is a
  // normal bounded rejection, not evidence that the door itself changed.
  const candidates = [
    { x: door.sourceX, y: door.sourceY + 1 },
    { x: door.sourceX - 1, y: door.sourceY },
    { x: door.sourceX + 1, y: door.sourceY },
    { x: door.sourceX, y: door.sourceY - 1 },
  ].filter((candidate) => validTile(candidate.x) && validTile(candidate.y));
  for (const candidate of candidates) {
    const phase = `move_to_animal_house_entry_${candidate.x}_${candidate.y}`;
    const accepted = await execute(phase, "move_to_tile", candidate, snapshot);
    if (accepted.state === "rejected" && accepted.reasonCode === "no_native_path") {
      trace.push({ phase: `${phase}_rejected`, action: "move_to_tile", receipt: receiptSummary(accepted) });
      snapshot = await observeActionable();
      continue;
    }
    if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(accepted, 55_000);
    trace.push({ phase: `${phase}_terminal`, action: "move_to_tile", receipt: receiptSummary(terminal) });
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached") throw new Error(`${phase}_failed:${terminal.reasonCode}`);
    const after = await observeActionable();
    if (after.revision < terminal.revision || !adjacent(after.tile, door)) throw new Error(`${phase}_postcondition_missing`);
    return after;
  }
  throw new Error("no_native_path_to_animal_house_entry");
}
async function execute(phase, action, args, snapshot) {
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_feed_animal_${phase}_${nonce}`;
  const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 });
  // A synchronous terminal receipt is still authoritative only when it binds
  // to the exact request ID generated for this call. Async prerequisites are
  // additionally correlated by this same ID and execution ID in waitForTerminal.
  if (receipt.requestId !== requestId || typeof receipt.executionId !== "string" || receipt.executionId.length === 0) {
    throw new Error(`${phase}_receipt_identity_mismatch`);
  }
  trace.push({ phase, action, args, receipt: receiptSummary(receipt) });
  return receipt;
}
async function waitForTerminal(accepted, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const receipt = receipts.find((entry) => sameIdentity(entry, accepted) && isTerminal(entry.state)); if (receipt) return receipt; await delay(100); } throw new Error(`terminal_timeout:${accepted.executionId}`); }
function chooseSingleFeedTarget(snapshot) {
  const targets = (snapshot.feedTroughTargets ?? []).filter((entry) => typeof entry?.targetId === "string" && entry.targetId.length > 0 && Number.isInteger(entry.slot) && validTile(entry.x) && validTile(entry.y) && Number.isInteger(entry.hayStack) && entry.hayStack > 0);
  if (targets.length === 0) throw new Error("no_live_empty_feed_trough_target");
  // An AnimalHouse can expose several independently native, empty trough
  // segments around the player. Select one deterministically and keep its
  // opaque ID; the production receipt and reread must prove that *this* target
  // was filled and removed.
  targets.sort((left, right) => left.y - right.y || left.x - right.x || left.targetId.localeCompare(right.targetId));
  return targets[0];
}
function parseEvidence(evidence) { const detail = typeof evidence?.detail === "string" ? evidence.detail : ""; return Object.fromEntries(detail.split(";").flatMap((part) => { const index = part.indexOf("="); return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : []; })); }
function sameIdentity(left, right) { return typeof left?.executionId === "string" && left.executionId.length > 0 && left.executionId === right?.executionId && typeof left?.requestId === "string" && left.requestId.length > 0 && left.requestId === right?.requestId; }
function validDoor(entry) { return validTile(entry?.sourceX) && validTile(entry?.sourceY) && validTile(entry?.targetX) && validTile(entry?.targetY) && typeof entry?.targetLocation === "string" && entry.targetLocation.length > 0; }
function sameDoor(left, right) { return left?.sourceX === right?.sourceX && left?.sourceY === right?.sourceY && left?.targetLocation === right?.targetLocation && left?.targetX === right?.targetX && left?.targetY === right?.targetY; }
function validTile(value) { return Number.isInteger(value) && value >= 0 && value <= 1000; }
function adjacent(left, right) { return Math.abs(left.x - (right.sourceX ?? right.x)) <= 1 && Math.abs(left.y - (right.sourceY ?? right.y)) <= 1; }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function same(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function summary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, activeExecution: snapshot.activeExecution ?? null, feedTroughTargets: snapshot.feedTroughTargets?.length ?? 0 }; }
function receiptSummary(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
