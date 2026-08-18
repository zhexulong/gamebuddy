// Stardew-local feed-animal smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (barn door
// navigation, trough target selection, native evidence, postcondition) stays
// in this runner.

import {
  assertExactCapabilities,
  connectNativeLocalClient,
  delay,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal as waitForTerminalShared,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_feed_animal_v1";
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
  "move_to_tile",
  "travel",
  "enter_exit",
  "feed_animal",
];

// Last fresh observation, kept for bounded diagnostic door facts only.
let lastSnapshot = null;

/** Execute the feed-animal contract against an already-connected bridge session. */
export async function runFeedAnimalSmoke(client, receipts, config) {
  const trace = [];
  const startedAt = Date.now();
  let enterTerminal = null;
  validateConfig(config);
  try {
    let snapshot = await observeActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    // The fixture may pre-position this otherwise unreachably distant spatial
    // precondition inside the selected AnimalHouse before bridge attachment. In
    // that narrow case do not leave and re-enter: doing so would discard exactly
    // the native, verified standing position. All opaque target facts still come
    // exclusively from this fresh production snapshot.
    if (!isSetupBigFarmFirstDeluxeBarnLocation(snapshot.location)) {
      if (snapshot.location !== "Farm") snapshot = await travelToFarm(client, receipts, trace, snapshot);
      snapshot = await awaitSetupBigFarmFirstDeluxeBarnDoor(client);
      const animalHouseDoor = chooseAnimalHouseDoor(snapshot);
      if (!adjacent(snapshot.tile, animalHouseDoor))
        snapshot = await moveAdjacentToDoor(client, receipts, trace, snapshot, animalHouseDoor);
      snapshot = await observeActionable(client);
      const freshDoor = findDoor(snapshot, animalHouseDoor);
      if (!freshDoor || !adjacent(snapshot.tile, freshDoor)) throw new Error("fresh_animal_house_entry_unavailable");
      const enterAccepted = await execute(
        client,
        trace,
        "enter_animal_house",
        "enter_exit",
        { x: freshDoor.sourceX, y: freshDoor.sourceY },
        snapshot,
      );
      if (enterAccepted.state !== "accepted")
        throw new Error(`enter_animal_house_not_accepted:${enterAccepted.reasonCode}`);
      enterTerminal = await waitForTerminal(receipts, enterAccepted, 20_000);
      trace.push({
        phase: "enter_animal_house_terminal",
        action: "enter_exit",
        receipt: summarizeReceipt(enterTerminal),
      });
      if (enterTerminal.state !== "succeeded" || enterTerminal.reasonCode !== "enter_exit_completed")
        throw new Error(`enter_animal_house_failed:${enterTerminal.reasonCode}`);
      snapshot = await awaitActionableSnapshotAfterEnter(client);
    }
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const target = chooseSingleFeedTarget(snapshot);
    const feedAccepted = await execute(
      client,
      trace,
      "feed",
      "feed_animal",
      { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
    );
    if (feedAccepted.state !== "succeeded" || feedAccepted.reasonCode !== "hay_placed_in_trough")
      throw new Error(`feed_animal_failed:${feedAccepted.state}:${feedAccepted.reasonCode}`);
    const after = await observeActionable(client);
    const evidence = parseEvidence(feedAccepted.evidence);
    const targetGone = (after.feedTroughTargets ?? []).every((entry) => entry.targetId !== target.targetId);
    const passed =
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.slot === String(target.slot) &&
      evidence.native_handled === "true" &&
      evidence.trough_filled === "true" &&
      evidence.hay_consumed === "true" &&
      Number(evidence.hay_before) === target.hayStack &&
      Number(evidence.hay_after) === target.hayStack - 1 &&
      targetGone &&
      after.actionable &&
      after.activeExecution == null;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "hay_placed_in_trough" : "feed_animal_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(feedAccepted),
      enterReceipt: summarizeReceipt(enterTerminal),
      evidence,
      before: summary(snapshot),
      after: summary(after),
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // When a pre-action discovery guard fails, record only the fresh bounded
    // door facts already published by the bridge. This is diagnostic evidence,
    // never an authorization to substitute a different door.
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      doorTargets: lastSnapshot?.doorTargets ?? [],
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runFeedAnimalSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({ state: "blocked", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256) }),
    );
    process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateConfig(value) {
  if (
    value?.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture.Bootstrap?.Enable === true ||
    value.NativeLocalPlayerFixture.FixtureScenario !== SCENARIO ||
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, ["move_to_tile", "travel", "enter_exit", "feed_animal"])
  )
    throw new Error("native_local_feed_animal_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_feed_animal_topology_invalid");
}
async function observeActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!validTile(snapshot.tile?.x) || !validTile(snapshot.tile?.y))
    throw new Error("native_local_feed_animal_snapshot_not_actionable");
  lastSnapshot = snapshot;
  return snapshot;
}
async function travelToFarm(client, receipts, trace, snapshot) {
  const warps = (snapshot.warps ?? []).filter((entry) => validDoor(entry) && entry.targetLocation === "Farm");
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!adjacent(snapshot.tile, warp)) snapshot = await move(client, receipts, trace, snapshot, warp, "move_to_farm_warp");
  snapshot = await observeActionable(client);
  const fresh = (snapshot.warps ?? []).find((entry) => sameDoor(entry, warp));
  if (!fresh || !adjacent(snapshot.tile, fresh)) throw new Error("fresh_farm_warp_unavailable");
  const accepted = await execute(client, trace, "travel_to_farm", "travel", { x: fresh.sourceX, y: fresh.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_to_farm_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, 20_000);
  trace.push({ phase: "travel_to_farm_terminal", action: "travel", receipt: summarizeReceipt(terminal) });
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_to_farm_failed:${terminal.reasonCode}`);
  const after = await observeActionable(client);
  if (after.location !== "Farm" || after.revision < terminal.revision)
    throw new Error("travel_to_farm_postcondition_missing");
  return after;
}
async function awaitActionableSnapshotAfterEnter(client) {
  const deadline = Date.now() + 5_000;
  do {
    try {
      return await observeActionable(client);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (message !== "native_local_feed_animal_snapshot_not_actionable" && message !== "native_snapshot_not_actionable")
        throw error;
      await delay(100);
    }
  } while (Date.now() < deadline);
  throw new Error("native_local_feed_animal_post_enter_not_actionable");
}
async function awaitSetupBigFarmFirstDeluxeBarnDoor(client) {
  // The travel terminal proves the player entered Farm, but its immediately
  // following snapshot is allowed to precede Farm door discovery. Poll only
  // fresh actionable snapshots and retain the exact source-derived selector;
  // never substitute an arbitrary Farm door or a guessed interior name.
  const deadline = Date.now() + 5_000;
  let snapshot;
  do {
    snapshot = await observeActionable(client);
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
  return (
    typeof location === "string" && /^Barn3[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(location)
  );
}
function isSetupBigFarmFirstDeluxeBarnDoor(entry) {
  return (
    validDoor(entry) &&
    entry.sourceX === 17 &&
    entry.sourceY === 12 &&
    isSetupBigFarmFirstDeluxeBarnLocation(entry.targetLocation)
  );
}
function findDoor(snapshot, selected) {
  return (snapshot.doorTargets ?? []).find((entry) => sameDoor(entry, selected));
}
async function move(client, receipts, trace, snapshot, target, phase) {
  const accepted = await execute(
    client,
    trace,
    phase,
    "move_to_tile",
    { x: target.sourceX ?? target.x, y: target.sourceY ?? target.y },
    snapshot,
  );
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, 55_000);
  trace.push({ phase: `${phase}_terminal`, action: "move_to_tile", receipt: summarizeReceipt(terminal) });
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  const after = await observeActionable(client);
  const point = { x: target.sourceX ?? target.x, y: target.sourceY ?? target.y };
  if (after.revision < terminal.revision || !adjacent(after.tile, point))
    throw new Error(`${phase}_postcondition_missing`);
  return after;
}
async function moveAdjacentToDoor(client, receipts, trace, snapshot, door) {
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
    const accepted = await execute(client, trace, phase, "move_to_tile", candidate, snapshot);
    if (accepted.state === "rejected" && accepted.reasonCode === "no_native_path") {
      trace.push({ phase: `${phase}_rejected`, action: "move_to_tile", receipt: summarizeReceipt(accepted) });
      snapshot = await observeActionable(client);
      continue;
    }
    if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(receipts, accepted, 55_000);
    trace.push({ phase: `${phase}_terminal`, action: "move_to_tile", receipt: summarizeReceipt(terminal) });
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
      throw new Error(`${phase}_failed:${terminal.reasonCode}`);
    const after = await observeActionable(client);
    if (after.revision < terminal.revision || !adjacent(after.tile, door))
      throw new Error(`${phase}_postcondition_missing`);
    return after;
  }
  throw new Error("no_native_path_to_animal_house_entry");
}
async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_feed_animal_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}
/**
 * Terminal wait bound to the exact request/execution identity pair. The bounded
 * wait and nonmatching-fact rejection are delegated to the shared harness; the
 * identity pair is re-asserted on the returned entry so a stale fact can never
 * satisfy this call.
 */
async function waitForTerminal(receipts, accepted, timeoutMs) {
  const entry = await waitForTerminalShared(receipts, accepted, timeoutMs);
  if (!sameIdentity(entry, accepted)) throw new Error("feed_animal_terminal_identity_invalid");
  return entry;
}
function chooseSingleFeedTarget(snapshot) {
  const targets = (snapshot.feedTroughTargets ?? []).filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      entry.targetId.length > 0 &&
      Number.isInteger(entry.slot) &&
      validTile(entry.x) &&
      validTile(entry.y) &&
      Number.isInteger(entry.hayStack) &&
      entry.hayStack > 0,
  );
  if (targets.length === 0) throw new Error("no_live_empty_feed_trough_target");
  // An AnimalHouse can expose several independently native, empty trough
  // segments around the player. Select one deterministically and keep its
  // opaque ID; the production receipt and reread must prove that *this* target
  // was filled and removed.
  targets.sort((left, right) => left.y - right.y || left.x - right.x || left.targetId.localeCompare(right.targetId));
  return targets[0];
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
    }),
  );
}
function sameIdentity(left, right) {
  return (
    typeof left?.executionId === "string" &&
    left.executionId.length > 0 &&
    left.executionId === right?.executionId &&
    typeof left?.requestId === "string" &&
    left.requestId.length > 0 &&
    left.requestId === right?.requestId
  );
}
function validDoor(entry) {
  return (
    validTile(entry?.sourceX) &&
    validTile(entry?.sourceY) &&
    validTile(entry?.targetX) &&
    validTile(entry?.targetY) &&
    typeof entry?.targetLocation === "string" &&
    entry.targetLocation.length > 0
  );
}
function sameDoor(left, right) {
  return (
    left?.sourceX === right?.sourceX &&
    left?.sourceY === right?.sourceY &&
    left?.targetLocation === right?.targetLocation &&
    left?.targetX === right?.targetX &&
    left?.targetY === right?.targetY
  );
}
function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function adjacent(left, right) {
  return Math.abs(left.x - (right.sourceX ?? right.x)) <= 1 && Math.abs(left.y - (right.sourceY ?? right.y)) <= 1;
}
function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function summary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    feedTroughTargets: snapshot.feedTroughTargets?.length ?? 0,
  };
}
