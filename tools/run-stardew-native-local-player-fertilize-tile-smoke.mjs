import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_fertilize_tile_v1";
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "fertilize_tile",
  "inspect_self",
  "move_to_tile",
  "travel",
];

/** Execute the fertilize contract against an already-connected bridge session. */
export async function runFertilizeTileSmoke(
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
  assertNativeLocalFixtureConfig(config, SCENARIO);
  try {
    let snapshot = await observeFresh(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await moveToReachableFertilizerTarget(
      client,
      receipts,
      snapshot,
      trace,
      stabilizeTimeoutMs,
      moveTimeoutMs,
    );
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error(
        `player_not_actionable_after_navigation:location=${snapshot.location};tile=${snapshot.tile?.x},${snapshot.tile?.y};active=${snapshot.activeExecution?.state ?? "none"}`,
      );

    // This target is freshly discovered after every prerequisite receipt. Its
    // slot and qualified item ID are the only inventory authority used here.
    const target = chooseReachableFertilizerTarget(snapshot);
    if (target === null) throw new Error("no_adjacent_live_fertilizer_target");
    const accepted = await execute(
      client,
      trace,
      "fertilize",
      "fertilize_tile",
      {
        slot: target.slot,
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot,
    );
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const evidence = parseEvidence(terminal.evidence);
    const after = await waitForStableRevision(client, {
      revision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (latest) =>
        latest.location === snapshot.location &&
        Array.isArray(latest.fertilizerTargets) &&
        latest.fertilizerTargets.every((entry) => entry.targetId !== target.targetId),
    });
    const targetGone = after.fertilizerTargets.every((entry) => entry.targetId !== target.targetId);
    const inventoryDeltaProven =
      Number.isSafeInteger(Number(evidence.inventory_before)) &&
      Number(evidence.inventory_after) === Number(evidence.inventory_before) - 1;
    const sameExecution =
      typeof terminal.executionId === "string" &&
      terminal.executionId.length > 0 &&
      terminal.requestId === accepted.requestId;
    const freshPostcondition =
      Number.isInteger(after.revision) &&
      after.revision === terminal.revision &&
      after.location === snapshot.location &&
      targetGone;
    const passed =
      terminal.state === "succeeded" &&
      terminal.reasonCode === "fertilizer_applied" &&
      sameExecution &&
      evidence.location === snapshot.location &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.item === target.qualifiedItemId &&
      evidence.fertilizer_before === "none" &&
      evidence.fertilizer_after === target.qualifiedItemId &&
      inventoryDeltaProven &&
      freshPostcondition;
    return {
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "fertilizer_applied" : terminal.reasonCode,
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      targetGone,
      inventoryDeltaProven,
      freshPostcondition,
      trace,
      before: summarizeWithFertilizer(snapshot),
      after: summarizeWithFertilizer(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
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
    const result = await runFertilizeTileSmoke(session.client, session.receipts, config);
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
  const requestId = `native_local_fertilize_tile_${phase}_${nonce}`;
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

async function travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
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
  const accepted = await execute(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  if (!hasNonemptyEvidence(terminal)) throw new Error("navigation_succeeded_evidence_missing");
  trace.push({ phase: "travel_terminal", receipt: summarizeReceipt(terminal) });
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm",
  });
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, fresh);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  if (!hasNonemptyEvidence(terminal)) throw new Error("navigation_succeeded_evidence_missing");
  trace.push({ phase: "prerequisite_terminal", receipt: summarizeReceipt(terminal) });
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
}

async function moveToReachableFertilizerTarget(
  client,
  receipts,
  snapshot,
  trace,
  stabilizeTimeoutMs,
  moveTimeoutMs,
) {
  if (chooseReachableFertilizerTarget(snapshot)) return snapshot;
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
        const moved = await moveToTile(
          client,
          receipts,
          snapshot,
          waypoint,
          "move_to_native_fertilize_tile_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (chooseReachableFertilizerTarget(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path"))
          throw error;
        snapshot = await observeFresh(client);
        if (chooseReachableFertilizerTarget(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_fertilize_tile_fixture_target");
}

function chooseReachableFertilizerTarget(snapshot) {
  if (!Array.isArray(snapshot.fertilizerTargets)) return null;
  const candidates = snapshot.fertilizerTargets.filter(
    (target) =>
      Number.isInteger(target.slot) &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      typeof target.targetId === "string" &&
      target.targetId.length > 0 &&
      typeof target.qualifiedItemId === "string" &&
      target.qualifiedItemId.length > 0 &&
      adjacent(snapshot.tile, target),
  );
  if (candidates.length === 0) return null;
  const target = candidates[0];
  if (candidates.some((candidate, index) => index > 0 && candidate.targetId === target.targetId))
    throw new Error("ambiguous_fertilizer_target_id");
  return target;
}

function resolveFarmWarp(snapshot) {
  const matches = Array.isArray(snapshot.warps)
    ? snapshot.warps.filter(
        (warp) =>
          warp?.targetLocation === "Farm" &&
          Number.isInteger(warp.sourceX) &&
          Number.isInteger(warp.sourceY) &&
          Number.isInteger(warp.targetX) &&
          Number.isInteger(warp.targetY) &&
          warp.sourceX >= 0 &&
          warp.sourceY >= 0 &&
          warp.targetX >= 0 &&
          warp.targetY >= 0,
      )
    : [];
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return matches[0];
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

function hasNonemptyEvidence(receipt) {
  return typeof receipt?.evidence?.detail === "string" && receipt.evidence.detail.length > 0;
}

function assertNativeLocalFixtureConfig(value, scenario) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    (fixture.Bootstrap != null && fixture.Bootstrap.Enable !== false) ||
    fixture.FixtureScenario !== scenario ||
    !validFixtureSlotRelationship(fixture.LogicalSaveName, fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
}

function validFixtureSlotRelationship(logicalName, observedSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSlot)
  );
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_fertilize_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_fertilize_evidence");
    result[key] = value;
  }
  return result;
}

function summarizeWithFertilizer(snapshot) {
  return { ...summarizeSnapshot(snapshot), fertilizerTargets: snapshot.fertilizerTargets?.length ?? 0 };
}