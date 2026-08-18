// Stardew-local pickup-forage smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (forage
// target selection, farm travel, movement search, evidence interpretation,
// postcondition) stays in this runner.

import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "pickup_forage", "inspect_self", "move_to_tile", "travel"];

/** Execute the pickup-forage contract against an already-connected bridge session. */
export async function runPickupForageSmoke(
  client,
  receipts,
  config,
  { moveTimeoutMs = 55_000, travelTimeoutMs = 20_000, forageTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeForageActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    assertNoGoldenScytheOverride(snapshot);
    if (snapshot.location !== "Farm") snapshot = await travelToFarm(client, receipts, trace, snapshot, moveTimeoutMs, travelTimeoutMs);
    snapshot = await observeForageActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    assertNoGoldenScytheOverride(snapshot);
    snapshot = await moveToFreshForageTarget(client, receipts, trace, snapshot, moveTimeoutMs);

    // The production snapshot intentionally publishes only in-range, ready Grab
    // crops. Re-read it after every prerequisite and bind the request to the
    // fresh opaque target ID and revision; fixture coordinates never authorize a
    // forage request.
    snapshot = await observeForageActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    assertNoGoldenScytheOverride(snapshot);
    const target = chooseOnlyFreshForageTarget(snapshot);
    const request = await execute(
      client,
      trace,
      "forage",
      "pickup_forage",
      {
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot,
    );
    const terminal = await waitForTerminal(receipts, request, forageTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "forage_picked_up")
      throw new Error(`forage_failed:${terminal.reasonCode}`);

    // Native forage can publish its terminal receipt one tick before the player
    // becomes actionable again. Pre-request checks remain immediate and strict;
    // only the fresh postcondition gets this bounded stabilization wait.
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: validateForageSnapshot,
    });
    const evidence = parseEvidence(terminal.evidence);
    const targetGone = after.forageTargets.every((entry) => entry.targetId !== target.targetId);
    const inventoryBefore = parseSafeInteger(evidence.inventory_before);
    const inventoryAfter = parseSafeInteger(evidence.inventory_after);
    const inventoryDeltaProven =
      inventoryBefore !== null && inventoryAfter !== null && inventoryAfter === inventoryBefore + target.stack;
    const passed =
      terminal.executionId === request.executionId &&
      terminal.requestId === request.requestId &&
      after.revision >= terminal.revision &&
      evidence.location === snapshot.location &&
      evidence.target === `${target.x},${target.y}` &&
      evidence.item === target.qualifiedItemId &&
      evidence.removed === "True" &&
      inventoryDeltaProven &&
      targetGone;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "forage_picked_up" : "forage_postcondition_mismatch",
      target: targetSummary(target),
      receipt: summarizeReceipt(terminal),
      evidence,
      targetGone,
      inventoryDeltaProven,
      trace,
      before: summary(snapshot),
      after: summary(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runPickupForageSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function travelToFarm(client, receipts, trace, snapshot, moveTimeoutMs, travelTimeoutMs) {
  const warp = snapshot.warps.find((entry) => validWarp(entry) && entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(client, receipts, trace, snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp", moveTimeoutMs);
  snapshot = await observeForageActionable(client);
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  const freshWarp = snapshot.warps.find(
    (entry) =>
      validWarp(entry) &&
      entry.sourceX === warp.sourceX &&
      entry.sourceY === warp.sourceY &&
      entry.targetLocation === "Farm" &&
      entry.targetX === warp.targetX &&
      entry.targetY === warp.targetY,
  );
  if (!freshWarp || !adjacent(snapshot.tile, { x: freshWarp.sourceX, y: freshWarp.sourceY }))
    throw new Error("fresh_farm_warp_unavailable");
  const accepted = await execute(client, trace, "travel_to_farm", "travel", { x: freshWarp.sourceX, y: freshWarp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, travelTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  const after = await observeForageActionable(client);
  if (
    after.revision < terminal.revision ||
    after.location !== "Farm" ||
    after.tile?.x !== freshWarp.targetX ||
    after.tile?.y !== freshWarp.targetY
  )
    throw new Error("travel_postcondition_missing");
  return after;
}

async function moveToFreshForageTarget(client, receipts, trace, snapshot, moveTimeoutMs) {
  if (hasOneFreshForageTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius)
          candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    for (const waypoint of candidates) {
      try {
        snapshot = await move(
          client,
          receipts,
          trace,
          snapshot,
          waypoint,
          "move_to_native_pickup_forage_fixture",
          moveTimeoutMs,
        );
        if (hasOneFreshForageTarget(snapshot)) return snapshot;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("move_failed:no_native_path"))
          throw error;
        snapshot = await observeForageActionable(client);
        if (hasOneFreshForageTarget(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_pickup_forage_fixture_target");
}

async function move(client, receipts, trace, snapshot, target, phase, timeoutMs) {
  snapshot = await observeForageActionable(client);
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, timeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`move_failed:${terminal.reasonCode}`);
  const after = await observeForageActionable(client);
  if (after.revision < terminal.revision || !adjacent(after.tile, target))
    throw new Error(`${phase}_postcondition_missing`);
  return after;
}

async function observeForageActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  validateForageSnapshot(snapshot);
  return snapshot;
}

function validateForageSnapshot(snapshot) {
  if (!Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y))
    throw new Error("native_local_forage_snapshot_invalid");
  if (!Array.isArray(snapshot.capabilities) || !Array.isArray(snapshot.warps) || !Array.isArray(snapshot.forageTargets))
    throw new Error("native_local_forage_snapshot_facts_missing");
  return true;
}

function assertNoGoldenScytheOverride(snapshot) {
  if (
    typeof snapshot.currentTool === "string" &&
    snapshot.currentTool
      .replaceAll(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .includes("goldenscythe")
  )
    throw new Error("golden_scythe_grab_override_risk");
}
function hasOneFreshForageTarget(snapshot) {
  return validForageTargets(snapshot).length === 1;
}
function chooseOnlyFreshForageTarget(snapshot) {
  const targets = validForageTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_live_forage_target" : "ambiguous_live_forage_targets");
  return targets[0];
}
function validForageTargets(snapshot) {
  if (!Array.isArray(snapshot.forageTargets)) return [];
  return snapshot.forageTargets.filter(
    (target) =>
      Number.isInteger(target?.x) &&
      Number.isInteger(target?.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.targetId === "string" &&
      target.targetId.length > 0 &&
      typeof target.qualifiedItemId === "string" &&
      target.qualifiedItemId.length > 0 &&
      Number.isInteger(target.stack) &&
      target.stack > 0 &&
      adjacent(snapshot.tile, target),
  );
}
function validWarp(warp) {
  return (
    Number.isInteger(warp?.sourceX) &&
    Number.isInteger(warp?.sourceY) &&
    Number.isInteger(warp?.targetX) &&
    Number.isInteger(warp?.targetY) &&
    warp.sourceX >= 0 &&
    warp.sourceY >= 0 &&
    warp.targetX >= 0 &&
    warp.targetY >= 0 &&
    typeof warp.targetLocation === "string" &&
    warp.targetLocation.length > 0
  );
}
async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_pickup_forage_${phase}_${Date.now()}_${trace.length}`;
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
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_forage_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_forage_evidence");
    result[key] = value;
  }
  return result;
}
function parseSafeInteger(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function validateNativeLocalFixtureConfig(value) {
  if (value?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
}
function targetSummary(target) {
  return {
    targetId: target.targetId,
    x: target.x,
    y: target.y,
    qualifiedItemId: target.qualifiedItemId,
    stack: target.stack,
  };
}
function summary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    currentTool: snapshot.currentTool ?? null,
    forageTargets: Array.isArray(snapshot.forageTargets) ? snapshot.forageTargets.map(targetSummary) : [],
  };
}
