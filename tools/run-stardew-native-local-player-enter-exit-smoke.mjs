// Stardew-local enter-exit smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (door and
// warp discovery, move prerequisite, postcondition) stays in this runner.
//
// Two modes, one action, because `enter_exit` has two legal SOURCES: a door tile
// (`location.doors`, mode `door`, the default) and the location's own warp table
// (`location.warps`, mode `warp`). Until 2026-11-01 only the door table was
// consulted, so a snapshot-published edge warp - `Farm(41,65)->Forest` in
// `round19` - was refused `door_not_available` seven times over three minutes
// while the companion stood on the adjacent tile. The door mode below cannot
// catch that: its target comes from `doorTargets`, which is exactly the table
// that already worked.

import { loadHostTestModule } from "./lib/host-test-module.mjs";
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const REQUIRED_CAPABILITIES = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"];

/** The two legal source tables an `enter_exit` target may come from. */
const MODES = new Set(["door", "warp"]);

/**
 * The `--mode` this process was asked for. Scanned over the WHOLE argv and never a fixed position, because this
 * runner is normally invoked after `--client-config <path>`: a positional read would silently ignore the flag and
 * then run the door mode while claiming the warp one, which is a pass proving the wrong thing.
 */
export function enterExitMode(argv = process.argv) {
  const index = argv.findIndex((argument) => argument === "--mode" || argument.startsWith("--mode="));
  if (index < 0) return "door";
  const value = argv[index].startsWith("--mode=") ? argv[index].slice("--mode=".length) : argv[index + 1];
  if (!MODES.has(value)) throw new Error(`native_local_enter_exit_mode_invalid:${value ?? "(missing)"}`);
  return value;
}

/** Execute the enter-exit contract against an already-connected bridge session. */
export async function runEnterExitSmoke(
  client,
  receipts,
  config,
  { mode = "door", moveTimeoutMs = 55_000, enterExitTimeoutMs = 20_000 } = {},
) {
  if (!MODES.has(mode)) throw new Error(`native_local_enter_exit_mode_invalid:${mode}`);
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    if (mode === "warp")
      return await runWarpSourceSlice(client, receipts, trace, startedAt, { moveTimeoutMs, enterExitTimeoutMs });
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
      const effective = declaredMoveTarget(moveTerminal) ?? { x: door.sourceX, y: door.sourceY };
      if (snapshot.revision < moveTerminal.revision || !adjacent(snapshot.tile, effective))
        throw new Error(
          "move_to_door_source_postcondition_missing" +
            ";observedTile=" +
            JSON.stringify(snapshot.tile) +
            ";requestedTile=" +
            door.sourceX +
            "," +
            door.sourceY +
            ";effectiveTarget=" +
            effective.x +
            "," +
            effective.y +
            ";observedRevision=" +
            snapshot.revision +
            ";terminalRevision=" +
            moveTerminal.revision +
            ";location=" +
            (snapshot.location ?? "(none)") +
            ";evidence=" +
            JSON.stringify(moveTerminal.evidence ?? null),
        );
    }

    // Re-discover an opaque, Mod-published door immediately before the request.
    // A coordinate from a previous snapshot never authorizes enter_exit.
    snapshot = await observeEnterExitActionable(client);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const freshDoor = findDeclaredDoor(snapshot, door);
    if (!(freshDoor && adjacent(snapshot.tile, { x: freshDoor.sourceX, y: freshDoor.sourceY })))
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
      reasonCode: passed
        ? gate.state === "passed"
          ? "enter_exit_completed"
          : gate.reasonCode
        : "enter_exit_postcondition_mismatch",
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
  const mode = enterExitMode();
  // The production Host generation is not available in this environment; the test loader is the
  // same precedent the newer gates use.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runEnterExitSmoke(session.client, session.receipts, config, { mode });
    console.log(JSON.stringify(result));
    // `not_exercised` is not a pass: the slice did not prove the contract on this fixture, and the
    // harness reads exit 0 as success. The printed reason says why.
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

/**
 * Prove `enter_exit` resolves a source tile from the location's own WARP table.
 *
 * This is the half the door mode above cannot reach: its target comes from `doorTargets`, which is exactly the
 * table that already worked. Measured 2026-11-01 (`round19`): the snapshot published `Farm(41,65) -> Forest`, the
 * companion stood on `(41,64)` and called `enter_exit(41,65)` - right coordinate, adjacent, exactly as published -
 * and the Mod answered `door_not_available` seven times across three minutes, because `enter_exit` consulted
 * `ResolveDoorWarp` (which reads `location.getWarpFromDoor`) and never the location's `warps` list.
 *
 * The selection is a RULE, not a coordinate: nearest usable warp whose target is another location and whose source
 * tile the door table does not already own. A slice pinned to `Farm(41,65)` would only ever test the fixture.
 */
async function runWarpSourceSlice(client, receipts, trace, startedAt, { moveTimeoutMs, enterExitTimeoutMs }) {
  let snapshot = await observeEnterExitActionable(client, { requireDoorTargets: false });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const candidates = warpSourceCandidates(snapshot);
  const warp = chooseWarpSource(snapshot, candidates.warpOnly);
  if (warp === null)
    return {
      // Not a pass and not a failure: this fixture's location publishes no edge warp the door table does not
      // already own, so the widening has nothing to act on here. Saying so is the point - a silent pass would
      // claim a proof that never happened.
      state: "not_exercised",
      topology: "native_local_player_fixture",
      reasonCode:
        `no_warp_only_source:location=${snapshot.location ?? "(none)"}` +
        `;warps=${candidates.warps.length};valid=${candidates.valid.length}` +
        `;otherLocation=${candidates.elsewhere.length};accessible=${candidates.usable.length}` +
        `;notDoorOwned=${candidates.warpOnly.length}`,
      before: enterExitSummary(snapshot),
      trace,
      durationMs: Date.now() - startedAt,
    };

  snapshot = await approachWarpSource(client, receipts, trace, warp, snapshot, moveTimeoutMs);

  // Re-discover the warp immediately before the request, by exact identity: a coordinate from a previous
  // snapshot never authorizes enter_exit.
  snapshot = await observeEnterExitActionable(client, { requireDoorTargets: false });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const fresh = findDeclaredWarp(snapshot, warp);
  if (!fresh) throw new Error("fresh_warp_source_unavailable");
  if (!adjacent(snapshot.tile, { x: fresh.sourceX, y: fresh.sourceY }))
    throw new Error(
      `warp_source_out_of_range_after_move:${fresh.sourceX},${fresh.sourceY}:${snapshot.tile.x},${snapshot.tile.y}`,
    );

  const accepted = await execute(
    client,
    trace,
    "enter_exit_warp",
    "enter_exit",
    { x: fresh.sourceX, y: fresh.sourceY },
    snapshot,
  );
  if (accepted.state !== "accepted") throw new Error(`enter_exit_warp_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, enterExitTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "enter_exit_completed")
    throw new Error(`enter_exit_warp_failed:${terminal.state}/${terminal.reasonCode}`);
  // The terminal receipt and the body's settle are not the same instant: measured 2026-11-02, the receipt was
  // `succeeded/enter_exit_completed` at revision 35 while the very next observation still reported a non-actionable
  // actor mid-transition. A single observation would report that race as a product failure, so the postcondition is
  // read through the harness's bounded poll, which waits for BOTH the terminal's revision and a settled body.
  const after = await waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    requireActionable: true,
    timeoutMs: enterExitTimeoutMs,
  });
  if (!(Number.isInteger(after.tile?.x) && Number.isInteger(after.tile?.y)))
    throw new Error("enter_exit_warp_settled_snapshot_invalid");

  const reasons = warpPostconditionReasons({ accepted, terminal, after, fresh });
  const passed = reasons.length === 0;

  return {
    state: passed ? "passed" : "blocked",
    topology: "native_local_player_fixture",
    reasonCode: passed ? "enter_exit_completed" : `enter_exit_warp_postcondition_mismatch:${reasons.join("+")}`,
    source: warpSummary(snapshot.location, fresh),
    // Derived, not asserted: if the door table owned this tile, the door mode above would already reach it and this
    // slice would prove nothing about the widening.
    doorTableHoldsSource: doorOwnsTile(snapshot, fresh),
    receipt: summarizeReceipt(terminal),
    executionId: terminal.executionId,
    requestId: terminal.requestId,
    before: enterExitSummary(snapshot),
    after: enterExitSummary(after),
    trace,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Stand within the Mod's radius-1 admission gate of a warp source.
 *
 * A warp source is the transition tile itself, and an edge exit may sit OFF the map (`X = -1` is how a map declares
 * a west-edge exit), so the actor cannot stand on it. The nearest in-map neighbour is the right place to stand and
 * the source coordinate is never rewritten.
 */
async function approachWarpSource(client, receipts, trace, warp, snapshot, moveTimeoutMs) {
  if (adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) return snapshot;
  const standing = standingTileFor(warp);
  const move = await execute(client, trace, "move_to_warp_source", "move_to_tile", standing, snapshot);
  if (move.state !== "accepted") throw new Error(`move_to_warp_source_not_accepted:${move.reasonCode}`);
  const moveTerminal = await waitForTerminal(receipts, move, moveTimeoutMs);
  if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached")
    throw new Error(`move_to_warp_source_failed:${moveTerminal.state}/${moveTerminal.reasonCode}`);
  const settled = await observeEnterExitActionable(client, { requireDoorTargets: false });
  if (settled.revision < moveTerminal.revision || !adjacent(settled.tile, { x: warp.sourceX, y: warp.sourceY })) {
    const effective = declaredMoveTarget(moveTerminal) ?? standing;
    throw new Error(
      "move_to_warp_source_postcondition_missing" +
        `;observedTile=${JSON.stringify(settled.tile)}` +
        `;requestedTile=${standing.x},${standing.y}` +
        `;effectiveTarget=${effective.x},${effective.y}` +
        `;warpSource=${warp.sourceX},${warp.sourceY}` +
        `;observedRevision=${settled.revision}` +
        `;terminalRevision=${moveTerminal.revision}` +
        `;location=${settled.location ?? "(none)"}`,
    );
  }
  return settled;
}

/**
 * Why this warp transition is NOT proven. Empty means proven.
 *
 * The receipt is not the proof. Both halves are asserted independently: the receipt names the transition the SNAPSHOT
 * declared (so the Mod resolved that same warp and not some other one on the tile), and the settled observation shows
 * the actor actually arriving there - a receipt that reports a move while the body stands still is a shape this
 * repository has paid for before.
 */
function warpPostconditionReasons({ accepted, terminal, after, fresh }) {
  const detail = terminal.evidence?.detail ?? "";
  const declaredTransition = `${fresh.targetLocation}:${fresh.targetX},${fresh.targetY}`;
  const observedTransition = `${after.location}:${after.tile?.x},${after.tile?.y}`;
  const expected = evidenceField(detail, "expected");
  const actual = evidenceField(detail, "actual");
  const reasons = [];
  if (terminal.executionId !== accepted.executionId) reasons.push("execution_id");
  if (terminal.requestId !== accepted.requestId) reasons.push("request_id");
  if (after.revision < terminal.revision) reasons.push(`revision=${after.revision}<${terminal.revision}`);
  if (expected !== declaredTransition)
    reasons.push(`receipt_expected=${expected ?? "(missing)"}:${declaredTransition}`);
  if (actual !== observedTransition) reasons.push(`receipt_actual=${actual ?? "(missing)"}:${observedTransition}`);
  if (after.location !== fresh.targetLocation) reasons.push(`location=${after.location}:${fresh.targetLocation}`);
  if (after.tile?.x !== fresh.targetX || after.tile?.y !== fresh.targetY)
    reasons.push(`tile=${after.tile?.x},${after.tile?.y}:${fresh.targetX},${fresh.targetY}`);
  return reasons;
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

async function observeEnterExitActionable(client, { requireDoorTargets = true } = {}) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!(Number.isInteger(snapshot.tile?.x) && Number.isInteger(snapshot.tile?.y)))
    throw new Error("native_local_enter_exit_snapshot_invalid");
  // Only the door mode needs the door table. A location legitimately publishes no door target at all - an
  // interior that has one edge warp is the ordinary case - and demanding one would fail the warp slice for a
  // reason the action cannot fix.
  if (requireDoorTargets && (!Array.isArray(snapshot.doorTargets) || snapshot.doorTargets.length === 0))
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
  if (!(fresh && adjacent(snapshot.tile, { x: fresh.sourceX, y: fresh.sourceY })))
    return { state: "blocked", reasonCode: "fresh_gated_door_target_unavailable" };

  const accepted = await execute(
    client,
    trace,
    "enter_exit_gated",
    "enter_exit",
    { x: fresh.sourceX, y: fresh.sourceY },
    snapshot,
  );
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
      (door) =>
        validDoor(door) && typeof door.targetLocation === "string" && door.targetLocation.startsWith("Greenhouse"),
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
    const move = await execute(
      client,
      trace,
      `move_to_gated_door_${candidate.x}_${candidate.y}`,
      "move_to_tile",
      candidate,
      snapshot,
    );
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

/**
 * The published warp table, filtered down to the sources this slice may use, keeping each filter's population so a
 * `not_exercised` report can say WHICH condition eliminated every candidate instead of just "none found".
 *
 * `Accessible` is optional and the Mod omits it when the leg was not measured, so it is only ever read as a
 * refusal when it is literally `false` - absent must never be treated as unusable.
 */
function warpSourceCandidates(snapshot) {
  const warps = Array.isArray(snapshot.warps) ? snapshot.warps : [];
  const valid = warps.filter(validWarp);
  const elsewhere = valid.filter((warp) => warp.targetLocation !== snapshot.location);
  const usable = elsewhere.filter((warp) => warp.accessible !== false);
  const warpOnly = usable.filter((warp) => !doorOwnsTile(snapshot, warp));
  return { warps, valid, elsewhere, usable, warpOnly };
}

/**
 * The warp this slice exercises, by RULE and not by coordinate: nearest usable warp whose target is another
 * location and whose source the door table does not already own. Ties break on the source tile so two runs over
 * the same map pick the same one.
 *
 * A slice pinned to `Farm(41,65)` - the coordinate `round19` happened to name - would only ever test the fixture.
 */
function chooseWarpSource(snapshot, warpOnly) {
  if (warpOnly.length === 0) return null;
  const distance = (warp) =>
    Math.max(Math.abs(warp.sourceX - snapshot.tile.x), Math.abs(warp.sourceY - snapshot.tile.y));
  return [...warpOnly].sort(
    (left, right) => distance(left) - distance(right) || left.sourceX - right.sourceX || left.sourceY - right.sourceY,
  )[0];
}

/** Whether the door table already owns a tile, i.e. whether the door mode above would reach it too. */
function doorOwnsTile(snapshot, warp) {
  return (snapshot.doorTargets ?? []).some((door) => door?.sourceX === warp.sourceX && door?.sourceY === warp.sourceY);
}

/**
 * The tile the actor stands on to use a warp source. An edge exit may be declared OFF the map - `X = -1` is how a
 * map says "walking off the west edge warps here" - so the source itself is not always a standable tile. The Mod
 * admits a request within one tile of the actor, so the in-map neighbour is the right place to stand and the source
 * coordinate is never rewritten.
 */
function standingTileFor(warp) {
  return { x: Math.max(warp.sourceX, 0), y: Math.max(warp.sourceY, 0) };
}

function validWarp(warp) {
  return (
    Number.isInteger(warp?.sourceX) &&
    Number.isInteger(warp?.sourceY) &&
    Number.isInteger(warp?.targetX) &&
    Number.isInteger(warp?.targetY) &&
    // The SOURCE may be -1 on one axis (an edge exit); the target may not.
    warp.sourceX >= -1 &&
    warp.sourceY >= -1 &&
    warp.targetX >= 0 &&
    warp.targetY >= 0 &&
    typeof warp?.targetLocation === "string" &&
    warp.targetLocation.length > 0
  );
}

function findDeclaredWarp(snapshot, selected) {
  return (snapshot.warps ?? []).find(
    (warp) =>
      validWarp(warp) &&
      warp.sourceX === selected.sourceX &&
      warp.sourceY === selected.sourceY &&
      warp.targetLocation === selected.targetLocation &&
      warp.targetX === selected.targetX &&
      warp.targetY === selected.targetY,
  );
}

/**
 * One `key=value` field of the Mod's evidence detail. The detail is `;`-separated and a value never contains one;
 * only the FIRST '=' of a segment separates, so a value may contain '=' of its own.
 */
function evidenceField(detail, key) {
  if (typeof detail !== "string") return null;
  for (const pair of detail.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index) === key) return pair.slice(index + 1);
  }
  return null;
}

/** The destination a `move_to_tile` receipt declared, from its `target=x,y` evidence. */
function declaredMoveTarget(terminal) {
  const match = /(?:^|;)target=(\d+),(\d+)(?:;|$)/.exec(terminal?.evidence?.detail ?? "");
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
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
    warps: Array.isArray(snapshot.warps) ? snapshot.warps.map((warp) => warpSummary(snapshot.location, warp)) : [],
  };
}

function doorSummary(location, door) {
  return {
    source: `${location}:${door.sourceX},${door.sourceY}`,
    target: `${door.targetLocation}:${door.targetX},${door.targetY}`,
  };
}

function warpSummary(location, warp) {
  return {
    source: `${location}:${warp.sourceX},${warp.sourceY}`,
    target: `${warp.targetLocation}:${warp.targetX},${warp.targetY}`,
  };
}
