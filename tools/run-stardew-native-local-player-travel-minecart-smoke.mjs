// Stardew-local minecart travel smoke: travel's objective family extension.
//
// The Mod discovers minecart objectives from the map's own `Action
// MinecartTransport <networkId>` property plus the live `Data/Minecarts`, and
// the accepted `travel` request carries one exact published `targetId`. This
// runner drives that whole chain in one native-local session: walk to the
// station tile, ride the advertised objective, then confirm the native Warped
// postcondition landed the actor on the objective's own target tile.
//
// The fixture only creates a station tile and the vanilla `ccBoilerRoom` network
// unlock, so a pass here is evidence about the production ride, not about a
// fixture-authored warp. Shared harness helpers (bounded scope, revision-bound
// requests, exact receipt identity, terminal wait, owned teardown) come from
// `stardew-native-smoke-harness-v1.mjs`.

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

/** Execute the minecart travel contract against an already-connected bridge session. */
export async function runTravelMinecartSmoke(
  client,
  receipts,
  config,
  { moveTimeoutMs = 55_000, travelTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeMinecartActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const ride = chooseSafeRide(snapshot);
    if (!adjacent(snapshot.tile, { x: ride.stationX, y: ride.stationY })) {
      const move = await execute(
        client,
        trace,
        "move_to_station",
        "move_to_tile",
        { x: ride.stationX, y: ride.stationY },
        snapshot,
      );
      if (move.state !== "accepted") throw new Error(`move_to_station_not_accepted:${move.reasonCode}`);
      const moveTerminal = await waitForTerminal(receipts, move, moveTimeoutMs);
      if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached")
        throw new Error(`move_to_station_failed:${moveTerminal.reasonCode}`);
      snapshot = await observeMinecartActionable(client);
      if (snapshot.revision < moveTerminal.revision || !adjacent(snapshot.tile, { x: ride.stationX, y: ride.stationY }))
        throw new Error("move_to_station_postcondition_missing");
    }

    // Rediscover the objective immediately before riding. The Mod re-derives the
    // whole ride from the live station tile and the game's own data, so a prior
    // snapshot never authorizes travel.
    snapshot = await observeMinecartActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const freshRide = findDeclaredRide(snapshot, ride);
    if (!freshRide || !adjacent(snapshot.tile, { x: freshRide.stationX, y: freshRide.stationY }))
      throw new Error("fresh_minecart_station_unavailable");

    const accepted = await execute(
      client,
      trace,
      "travel_minecart",
      "travel",
      { x: freshRide.stationX, y: freshRide.stationY, expectedTargetId: freshRide.targetId },
      snapshot,
    );
    if (accepted.state !== "accepted") throw new Error(`minecart_not_accepted:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(receipts, accepted, travelTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
      throw new Error(`minecart_travel_failed:${terminal.reasonCode}`);

    // The minecart ride reuses the single travel terminal, so the same exact
    // `expected/actual` arrival check applies; the named objective must also be
    // echoed back in the receipt.
    const after = await observeMinecartActionable(client);
    const evidence = terminal.evidence?.detail ?? "";
    const objectiveNamed =
      evidence.includes(`network=${freshRide.networkId}`) &&
      evidence.includes(`destination=${freshRide.destinationId}`);
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      after.revision >= terminal.revision &&
      after.location === freshRide.targetLocation &&
      after.tile?.x === freshRide.targetTileX &&
      after.tile?.y === freshRide.targetTileY &&
      objectiveNamed;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "minecart_travel_completed" : "minecart_travel_postcondition_mismatch",
      source: rideSummary(snapshot.location, freshRide),
      receipt: summarizeReceipt(terminal),
      before: travelSummary(snapshot),
      after: travelSummary(after),
      objectiveNamed,
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
    const result = await runTravelMinecartSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_minecart_${phase}_${Date.now()}_${trace.length}`;
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

async function observeMinecartActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y))
    throw new Error("native_local_minecart_snapshot_invalid");
  if (!Array.isArray(snapshot.minecartTargets))
    throw new Error("native_local_minecart_targets_missing");
  return snapshot;
}

/**
 * Prefer an objective whose target is another location, so the ride is clearly a
 * real transition rather than an in-map hop, but accept any valid advertised
 * objective -- the fixture's own network content decides what exists.
 */
function chooseSafeRide(snapshot) {
  const candidates = snapshot.minecartTargets.filter(validRide);
  const selected = candidates.find((ride) => ride.targetLocation !== snapshot.location) ?? candidates[0];
  if (!selected) throw new Error("no_safe_live_minecart_objective");
  return selected;
}

function findDeclaredRide(snapshot, selected) {
  return snapshot.minecartTargets.find(
    (ride) =>
      validRide(ride) &&
      ride.targetId === selected.targetId &&
      ride.stationX === selected.stationX &&
      ride.stationY === selected.stationY &&
      ride.networkId === selected.networkId &&
      ride.destinationId === selected.destinationId,
  );
}

function validRide(ride) {
  return (
    typeof ride?.targetId === "string" &&
    /^minecart_[a-f0-9]{16}$/u.test(ride.targetId) &&
    typeof ride.networkId === "string" &&
    ride.networkId.length > 0 &&
    typeof ride.destinationId === "string" &&
    ride.destinationId.length > 0 &&
    Number.isInteger(ride.stationX) &&
    Number.isInteger(ride.stationY) &&
    ride.stationX >= 0 &&
    ride.stationY >= 0 &&
    typeof ride.targetLocation === "string" &&
    ride.targetLocation.length > 0 &&
    Number.isInteger(ride.targetTileX) &&
    Number.isInteger(ride.targetTileY) &&
    ride.targetTileX >= 0 &&
    ride.targetTileY >= 0
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
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile ? { x: snapshot.tile.x, y: snapshot.tile.y } : null,
    ...summarizeSnapshot(snapshot),
    minecartTargets: Array.isArray(snapshot.minecartTargets)
      ? snapshot.minecartTargets.map((ride) => rideSummary(snapshot.location, ride))
      : [],
  };
}

function rideSummary(location, ride) {
  return {
    targetId: ride.targetId,
    network: ride.networkId,
    destination: ride.destinationId,
    station: `${location}:${ride.stationX},${ride.stationY}`,
    target: `${ride.targetLocation}:${ride.targetTileX},${ride.targetTileY}`,
  };
}
