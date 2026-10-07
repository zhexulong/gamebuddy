// Stardew-local enter-exit smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (door
// discovery, move prerequisite, postcondition) stays in this runner.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const REQUIRED_CAPABILITIES = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"];

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
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
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
      // The requested tile is usually not walkable, so the Mod substitutes the nearest
      // standable neighbour and the receipt names it in `target=`. Measure the arrival against
      // that declared destination, not against the tile we asked to walk to.
      const effective = (() => {
        const m = /(?:^|;)target=(\d+),(\d+)(?:;|$)/.exec(moveTerminal.evidence?.detail ?? "");
        return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: door.sourceX, y: door.sourceY };
      })();
      if (snapshot.revision < moveTerminal.revision || !adjacent(snapshot.tile, effective))
        throw new Error(
          "move_to_door_source_postcondition_missing" +
            ";observedTile=" + JSON.stringify(snapshot.tile) +
            ";requestedTile=" + door.sourceX + "," + door.sourceY +
            ";effectiveTarget=" + effective.x + "," + effective.y +
            ";observedRevision=" + snapshot.revision +
            ";terminalRevision=" + moveTerminal.revision +
            ";location=" + (snapshot.location ?? "(none)") +
            ";evidence=" + JSON.stringify(moveTerminal.evidence ?? null),
        );
    }

    // Re-discover an opaque, Mod-published door immediately before the request.
    // A coordinate from a previous snapshot never authorizes enter_exit.
    snapshot = await observeEnterExitActionable(client);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
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

    // Second phase: prove the native door GATE runs. The fixture Farm has a
    // Greenhouse human door whose OnUseHumanDoor refuses while ccPantry is
    // absent, so the same enter_exit action must come back rejected with
    // door_gate_refused instead of walking through. This is the branch the
    // plain FarmHouse exit cannot exercise: that exit is a Warp record, not a
    // gated door.
    const gate = passed ? await runDoorGatePhase(client, receipts, trace, { moveTimeoutMs, enterExitTimeoutMs }) : null;

    return {
      state: passed && gate?.state === "passed" ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: !passed
        ? "enter_exit_postcondition_mismatch"
        : gate.state === "passed"
          ? "enter_exit_completed"
          : gate.reasonCode,
      source: doorSummary(snapshot.location, freshDoor),
      receipt: summarizeReceipt(terminal),
    // The receipt summary carries no identity by design (4a52188), so the
    // exact request/execution pair this runner proves is exposed here.
    executionId: terminal.executionId,
    requestId: terminal.requestId,
      before: enterExitSummary(snapshot),
      after: enterExitSummary(after),
      doorGate: gate,
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
  // The production Host generation is not available in this environment; the test loader is the
  // same precedent the newer gates use.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
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

/**
 * Prove the native door gate actually runs. The fixture Farm advertises a
 * Greenhouse human door whose `OnUseHumanDoor` refuses while `ccPantry` is
 * absent (`GreenhouseBuilding.OnUseHumanDoor` draws
 * `Strings\\Locations:Farm_GreenhouseRuins` and returns false). The action must
 * therefore end `rejected/door_gate_refused`, the actor must NOT have moved
 * into the Greenhouse, and no modal may be left mounted (the actor stays
 * actionable, which is what `observeFresh({actionable:true})` re-asserts).
 */
async function runDoorGatePhase(client, receipts, trace, { moveTimeoutMs, enterExitTimeoutMs }) {
  let snapshot = await observeFresh(client, { actionable: true });
  const gated = chooseGatedDoor(snapshot);
  if (!gated) return { state: "blocked", reasonCode: "no_gated_door_target_advertised" };

  if (!adjacent(snapshot.tile, { x: gated.sourceX, y: gated.sourceY })) {
    // A door tile is the doorway itself, not a standing tile, so move to an
    // adjacent tile instead. A rejected `move_to_tile` has no side effect, so
    // trying a bounded candidate list is safe; each attempt is its own receipt.
    const approached = await approachGatedDoor(client, receipts, trace, gated, moveTimeoutMs);
    if (approached.state !== "passed") return approached;
    snapshot = approached.snapshot;
  }

  const fresh = findDeclaredDoor(snapshot, gated);
  if (!fresh || !adjacent(snapshot.tile, { x: fresh.sourceX, y: fresh.sourceY }))
    return { state: "blocked", reasonCode: "fresh_gated_door_target_unavailable" };

  const accepted = await execute(client, trace, "enter_exit_gated", "enter_exit", { x: fresh.sourceX, y: fresh.sourceY }, snapshot);
  const terminal = await waitForTerminal(receipts, accepted, enterExitTimeoutMs);
  const after = await observeFresh(client, { actionable: true });

  // The refusal is only honest if BOTH the terminal state and the reason code
  // say refused, the receipt binds to this exact request/execution pair, and the
  // actor really stayed on the near side. `observeFresh` already fails closed
  // when the actor is not actionable (a mounted modal makes it non-actionable),
  // so reaching this line is itself the settle proof.
  const stayed =
    after.location === snapshot.location && after.tile?.x === snapshot.tile.x && after.tile?.y === snapshot.tile.y;
  const reasons = [];
  if (terminal.executionId !== accepted.executionId) reasons.push("execution_id");
  if (terminal.requestId !== accepted.requestId) reasons.push("request_id");
  if (terminal.state !== "rejected") reasons.push(`state=${terminal.state}`);
  if (terminal.reasonCode !== "door_gate_refused") reasons.push(`reason=${terminal.reasonCode}`);
  if (!stayed) reasons.push("moved");
  const ok = reasons.length === 0;
  return {
    state: ok ? "passed" : "blocked",
    reasonCode: ok ? "door_gate_refused" : `door_gate_unexpected:${reasons.join("+")}`,
    target: doorSummary(snapshot.location, fresh),
    receipt: summarizeReceipt(terminal),
    after: enterExitSummary(after),
    actorActionableAfterRefusal: true,
  };
}

function chooseGatedDoor(snapshot) {
  // The Farm's Greenhouse human door is the gated target this fixture can
  // reach: `GreenhouseBuilding.OnUseHumanDoor` refuses without ccPantry, which
  // the fixture does not grant.
  return (
    snapshot.doorTargets?.find(
      (door) => validDoor(door) && typeof door.targetLocation === "string" && door.targetLocation.startsWith("Greenhouse"),
    ) ?? null
  );
}

/**
 * Walk to a tile from which the gated door can be used. The door tile itself is
 * the doorway, not a standing tile, so the four cardinal neighbours are tried in
 * order and the first accepted-and-reached one wins. Every attempt is a real
 * revision-bound receipt; a rejected move has no side effect.
 */
async function approachGatedDoor(client, receipts, trace, gated, moveTimeoutMs) {
  const attempts = [];
  for (const candidate of [
    { x: gated.sourceX, y: gated.sourceY + 1 },
    { x: gated.sourceX, y: gated.sourceY - 1 },
    { x: gated.sourceX - 1, y: gated.sourceY },
    { x: gated.sourceX + 1, y: gated.sourceY },
  ]) {
    const snapshot = await observeFresh(client, { actionable: true });
    if (adjacent(snapshot.tile, { x: gated.sourceX, y: gated.sourceY })) {
      return { state: "passed", snapshot, attempts };
    }
    const move = await execute(client, trace, `move_to_gated_door_${candidate.x}_${candidate.y}`, "move_to_tile", candidate, snapshot);
    if (move.state !== "accepted") {
      attempts.push({ candidate, outcome: `not_accepted:${move.reasonCode}` });
      continue;
    }
    const terminal = await waitForTerminal(receipts, move, moveTimeoutMs);
    attempts.push({ candidate, outcome: `${terminal.state}/${terminal.reasonCode}` });
    if (terminal.state === "succeeded" && terminal.reasonCode === "target_reached") {
      const settled = await observeFresh(client, { actionable: true });
      if (adjacent(settled.tile, { x: gated.sourceX, y: gated.sourceY }))
        return { state: "passed", snapshot: settled, attempts };
    }
  }
  return { state: "blocked", reasonCode: `no_gated_door_approach_tile:${JSON.stringify(attempts)}`, attempts };
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
  // `summarizeSnapshot` stopped carrying location/tile in 4a52188, so the
  // location this runner asserts is exposed here explicitly.
  return {
    ...summarizeSnapshot(snapshot),
    location: snapshot.location,
    tile: snapshot.tile,
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
