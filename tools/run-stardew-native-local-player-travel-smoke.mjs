// Stardew-local travel smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (warp
// discovery, move prerequisite, postcondition) stays in this runner.

import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel"];

/** Execute the travel contract against an already-connected bridge session. */
export async function runTravelSmoke(
  client,
  receipts,
  config,
  { moveTimeoutMs = 55_000, travelTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeTravelActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const warp = chooseSafeWarp(snapshot);
    if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) {
      const move = await execute(
        client,
        trace,
        "move_to_warp_source",
        "move_to_tile",
        { x: warp.sourceX, y: warp.sourceY },
        snapshot,
      );
      if (move.state !== "accepted") throw new Error(`move_to_warp_source_not_accepted:${move.reasonCode}`);
      const moveTerminal = await waitForTerminal(receipts, move, moveTimeoutMs);
      if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached")
        throw new Error(`move_to_warp_source_failed:${moveTerminal.reasonCode}`);
      snapshot = await observeTravelActionable(client);
      if (snapshot.revision < moveTerminal.revision || !adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
        throw new Error("move_to_warp_source_postcondition_missing");
    }

    // Rediscover the source immediately before travel. The Mod accepts only its
    // current-location Warp list, so a prior snapshot never authorizes travel.
    snapshot = await observeTravelActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const freshWarp = findDeclaredWarp(snapshot, warp);
    if (!freshWarp || !adjacent(snapshot.tile, { x: freshWarp.sourceX, y: freshWarp.sourceY }))
      throw new Error("fresh_warp_source_unavailable");
    const accepted = await execute(
      client,
      trace,
      "travel",
      "travel",
      { x: freshWarp.sourceX, y: freshWarp.sourceY },
      snapshot,
    );
    if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(receipts, accepted, travelTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
      throw new Error(`travel_failed:${terminal.reasonCode}`);
    const after = await observeTravelActionable(client);
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      after.revision >= terminal.revision &&
      after.location === freshWarp.targetLocation &&
      after.tile?.x === freshWarp.targetX &&
      after.tile?.y === freshWarp.targetY;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "travel_completed" : "travel_postcondition_mismatch",
      source: warpSummary(snapshot.location, freshWarp),
      receipt: summarizeReceipt(terminal),
      before: travelSummary(snapshot),
      after: travelSummary(after),
      trace,
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
    const result = await runTravelSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_travel_${phase}_${Date.now()}_${trace.length}`;
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

async function observeTravelActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y))
    throw new Error("native_local_travel_snapshot_invalid");
  if (!Array.isArray(snapshot.warps) || snapshot.warps.length === 0)
    throw new Error("native_local_travel_warps_missing");
  return snapshot;
}

function chooseSafeWarp(snapshot) {
  const candidates = snapshot.warps.filter(validWarp);
  const preferred =
    snapshot.location === "FarmHouse" ? candidates.find((warp) => warp.targetLocation === "Farm") : undefined;
  const selected = preferred ?? candidates[0];
  if (!selected) throw new Error("no_safe_live_warp");
  return selected;
}

function findDeclaredWarp(snapshot, selected) {
  return snapshot.warps.find(
    (warp) =>
      validWarp(warp) &&
      warp.sourceX === selected.sourceX &&
      warp.sourceY === selected.sourceY &&
      warp.targetLocation === selected.targetLocation &&
      warp.targetX === selected.targetX &&
      warp.targetY === selected.targetY,
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
    typeof warp?.targetLocation === "string" &&
    warp.targetLocation.length > 0
  );
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

function travelSummary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    warps: Array.isArray(snapshot.warps) ? snapshot.warps.map((warp) => warpSummary(snapshot.location, warp)) : [],
  };
}

function warpSummary(location, warp) {
  return {
    source: `${location}:${warp.sourceX},${warp.sourceY}`,
    target: `${warp.targetLocation}:${warp.targetX},${warp.targetY}`,
  };
}
