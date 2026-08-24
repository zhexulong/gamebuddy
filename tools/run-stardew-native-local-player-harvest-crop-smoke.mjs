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

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "harvest_crop", "inspect_self", "move_to_tile", "travel"];

/** Execute the harvest contract against an already-connected bridge session. */
export async function runHarvestCropSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeHarvestActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    assertNoGoldenScytheOverride(snapshot);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await observeHarvestActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    assertNoGoldenScytheOverride(snapshot);
    snapshot = await moveToFreshHarvestTarget(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);

    // The production snapshot intentionally publishes only in-range, ready Grab
    // crops. Re-read it after every prerequisite and bind the request to the
    // fresh opaque target ID and revision; fixture coordinates never authorize a
    // harvest request.
    snapshot = await observeHarvestActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    assertNoGoldenScytheOverride(snapshot);
    const target = chooseOnlyFreshHarvestTarget(snapshot);
    const accepted = await execute(
      client,
      trace,
      "harvest",
      "harvest_crop",
      {
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedHarvestItemId,
        expectedTargetId: target.targetId,
      },
      snapshot,
    );
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "crop_harvested")
      throw new Error(`harvest_failed:${terminal.reasonCode}`);

    // Native harvest can publish its terminal receipt one tick before the player
    // becomes actionable again. Pre-request checks remain immediate and strict;
    // only the fresh postcondition gets this bounded stabilization wait.
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        Number.isInteger(latest.tile?.x) &&
        Number.isInteger(latest.tile?.y) &&
        Array.isArray(latest.capabilities) &&
        Array.isArray(latest.warps) &&
        Array.isArray(latest.harvestTargets),
    });
    const evidence = parseEvidence(terminal.evidence);
    const targetGone = after.harvestTargets.every((entry) => entry.targetId !== target.targetId);
    const inventoryBefore = parseSafeInteger(evidence.inventory_before);
    const inventoryAfter = parseSafeInteger(evidence.inventory_after);
    const inventoryGained = inventoryBefore !== null && inventoryAfter !== null && inventoryAfter > inventoryBefore;
    // harvestTargets contains only ready-to-grab crops. A non-regrowing crop is
    // therefore fresh only when its bound target disappears; a regrowing crop
    // remains in the world but must no longer be ready, in addition to the
    // receipt's native regrowth evidence.
    const freshPostcondition = target.regrowsAfterHarvest
      ? evidence.crop_present_after === "true" && evidence.regrow_advanced === "true" && targetGone
      : evidence.crop_present_after === "false" && targetGone;
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      after.revision >= terminal.revision &&
      evidence.target === target.targetId &&
      evidence.item === target.qualifiedHarvestItemId &&
      evidence.regrows === String(target.regrowsAfterHarvest) &&
      evidence.native_accepted === "true" &&
      evidence.inventory_gained === "true" &&
      inventoryGained &&
      freshPostcondition;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "crop_harvested" : "harvest_postcondition_mismatch",
      target: targetSummary(target),
      receipt: summarizeReceipt(terminal),
      evidence,
      targetGone,
      inventoryGained,
      freshPostcondition,
      trace,
      before: snapshotSummary(snapshot),
      after: snapshotSummary(after),
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
    const result = await runHarvestCropSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_harvest_crop_${phase}_${nonce}`;
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

async function travelToFarm(client, receipts, _snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await observeHarvestActionable(client);
  const warp = resolveFarmWarp(fresh);
  if (!adjacent(fresh.tile, { x: warp.sourceX, y: warp.sourceY }))
    fresh = await moveToTile(
      client,
      receipts,
      fresh,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      trace,
      stabilizeTimeoutMs,
      terminalTimeoutMs,
    );
  fresh = await observeHarvestActionable(client);
  const freshWarp = fresh.warps.find(
    (entry) =>
      validWarp(entry) &&
      entry.sourceX === warp.sourceX &&
      entry.sourceY === warp.sourceY &&
      entry.targetLocation === "Farm" &&
      entry.targetX === warp.targetX &&
      entry.targetY === warp.targetY,
  );
  if (!freshWarp || !adjacent(fresh.tile, { x: freshWarp.sourceX, y: freshWarp.sourceY }))
    throw new Error("fresh_farm_warp_unavailable");
  const accepted = await execute(
    client,
    trace,
    "travel_to_farm",
    "travel",
    { x: freshWarp.sourceX, y: freshWarp.sourceY },
    fresh,
  );
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) =>
      latest.location === "Farm" && latest.tile?.x === freshWarp.targetX && latest.tile?.y === freshWarp.targetY,
  });
}

async function moveToFreshHarvestTarget(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (hasOneFreshHarvestTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    }
    for (const waypoint of candidates) {
      try {
        snapshot = await moveToTile(
          client,
          receipts,
          snapshot,
          waypoint,
          "move_to_native_harvest_crop_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (hasOneFreshHarvestTarget(snapshot)) return snapshot;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("move_failed:no_native_path"))
          throw error;
        snapshot = await observeHarvestActionable(client);
        if (hasOneFreshHarvestTarget(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_harvest_crop_fixture_target");
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  snapshot = await observeHarvestActionable(client);
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`move_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
}

async function observeHarvestActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  requireActionableHarvestSnapshot(snapshot);
  return snapshot;
}

function requireActionableHarvestSnapshot(snapshot) {
  if (
    !Number.isInteger(snapshot.revision) ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.capabilities) ||
    !Array.isArray(snapshot.warps) ||
    !Array.isArray(snapshot.harvestTargets)
  )
    throw new Error("native_local_harvest_snapshot_facts_missing");
  return snapshot;
}

function hasOneFreshHarvestTarget(snapshot) {
  return validHarvestTargets(snapshot).length === 1;
}

function chooseOnlyFreshHarvestTarget(snapshot) {
  const targets = validHarvestTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_live_harvest_target" : "ambiguous_live_harvest_targets");
  return targets[0];
}

function validHarvestTargets(snapshot) {
  if (!Array.isArray(snapshot.harvestTargets)) return [];
  return snapshot.harvestTargets.filter(
    (target) =>
      Number.isInteger(target?.x) &&
      Number.isInteger(target?.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.targetId === "string" &&
      target.targetId.length > 0 &&
      typeof target.qualifiedHarvestItemId === "string" &&
      target.qualifiedHarvestItemId.length > 0 &&
      typeof target.regrowsAfterHarvest === "boolean" &&
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

function resolveFarmWarp(snapshot) {
  const matches = Array.isArray(snapshot.warps)
    ? snapshot.warps.filter((warp) => validWarp(warp) && warp.targetLocation === "Farm")
    : [];
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return matches[0];
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

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_harvest_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_harvest_evidence");
    result[key] = value;
  }
  return result;
}

function parseSafeInteger(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function adjacent(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1
  );
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
    cropId: target.cropId,
    qualifiedHarvestItemId: target.qualifiedHarvestItemId,
    regrowsAfterHarvest: target.regrowsAfterHarvest,
  };
}

function snapshotSummary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    currentTool: snapshot.currentTool ?? null,
    harvestTargets: Array.isArray(snapshot.harvestTargets) ? snapshot.harvestTargets.map(targetSummary) : [],
  };
}
