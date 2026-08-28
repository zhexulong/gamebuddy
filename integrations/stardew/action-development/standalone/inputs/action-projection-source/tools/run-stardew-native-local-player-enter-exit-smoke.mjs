// Stardew-local enter-exit smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (door
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

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"];

/** Execute the enter-exit contract against an already-connected bridge session. */
export async function runEnterExitSmoke(
  client,
  receipts,
  config,
  { moveTimeoutMs = 55_000, enterExitTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeEnterExitActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const door = chooseSafeDoor(snapshot);
    if (!adjacent(snapshot.tile, { x: door.sourceX, y: door.sourceY })) {
      const move = await execute(
        client,
        trace,
        "move_to_door_source",
        "move_to_tile",
        { x: door.sourceX, y: door.sourceY },
        snapshot,
      );
      if (move.state !== "accepted") throw new Error(`move_to_door_source_not_accepted:${move.reasonCode}`);
      const moveTerminal = await waitForTerminal(receipts, move, moveTimeoutMs);
      if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached")
        throw new Error(`move_to_door_source_failed:${moveTerminal.reasonCode}`);
      snapshot = await observeEnterExitActionable(client);
      if (snapshot.revision < moveTerminal.revision || !adjacent(snapshot.tile, { x: door.sourceX, y: door.sourceY }))
        throw new Error("move_to_door_source_postcondition_missing");
    }

    // Re-discover an opaque, Mod-published door immediately before the request.
    // A coordinate from a previous snapshot never authorizes enter_exit.
    snapshot = await observeEnterExitActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const freshDoor = findDeclaredDoor(snapshot, door);
    if (!freshDoor || !adjacent(snapshot.tile, { x: freshDoor.sourceX, y: freshDoor.sourceY }))
      throw new Error("fresh_door_target_unavailable");
    const accepted = await execute(
      client,
      trace,
      "enter_exit",
      "enter_exit",
      { x: freshDoor.sourceX, y: freshDoor.sourceY },
      snapshot,
    );
    if (accepted.state !== "accepted") throw new Error(`enter_exit_not_accepted:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(receipts, accepted, enterExitTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "enter_exit_completed")
      throw new Error(`enter_exit_failed:${terminal.reasonCode}`);
    const after = await observeEnterExitActionable(client);
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      after.revision >= terminal.revision &&
      after.location === freshDoor.targetLocation &&
      after.tile?.x === freshDoor.targetX &&
      after.tile?.y === freshDoor.targetY;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "enter_exit_completed" : "enter_exit_postcondition_mismatch",
      source: doorSummary(snapshot.location, freshDoor),
      receipt: summarizeReceipt(terminal),
      before: enterExitSummary(snapshot),
      after: enterExitSummary(after),
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
    const result = await runEnterExitSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_enter_exit_${phase}_${Date.now()}_${trace.length}`;
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

async function observeEnterExitActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y))
    throw new Error("native_local_enter_exit_snapshot_invalid");
  if (!Array.isArray(snapshot.doorTargets) || snapshot.doorTargets.length === 0)
    throw new Error("native_local_enter_exit_door_targets_missing");
  return snapshot;
}

function chooseSafeDoor(snapshot) {
  const candidates = snapshot.doorTargets.filter(validDoor);
  const preferred =
    snapshot.location === "FarmHouse" ? candidates.find((door) => door.targetLocation === "Farm") : undefined;
  const selected = preferred ?? candidates[0];
  if (!selected) throw new Error("no_safe_live_door_target");
  return selected;
}

function findDeclaredDoor(snapshot, selected) {
  return snapshot.doorTargets.find(
    (door) =>
      validDoor(door) &&
      door.sourceX === selected.sourceX &&
      door.sourceY === selected.sourceY &&
      door.targetLocation === selected.targetLocation &&
      door.targetX === selected.targetX &&
      door.targetY === selected.targetY,
  );
}

function validDoor(door) {
  return (
    Number.isInteger(door?.sourceX) &&
    Number.isInteger(door?.sourceY) &&
    Number.isInteger(door?.targetX) &&
    Number.isInteger(door?.targetY) &&
    door.sourceX >= 0 &&
    door.sourceY >= 0 &&
    door.targetX >= 0 &&
    door.targetY >= 0 &&
    typeof door?.targetLocation === "string" &&
    door.targetLocation.length > 0
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

function enterExitSummary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    doorTargets: Array.isArray(snapshot.doorTargets)
      ? snapshot.doorTargets.map((door) => doorSummary(snapshot.location, door))
      : [],
  };
}

function doorSummary(location, door) {
  return {
    source: `${location}:${door.sourceX},${door.sourceY}`,
    target: `${door.targetLocation}:${door.targetX},${door.targetY}`,
  };
}
