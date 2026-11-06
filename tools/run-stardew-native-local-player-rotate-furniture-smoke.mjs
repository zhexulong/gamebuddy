// Stardew-local `rotate_furniture` smoke.
//
// One piece of the game's own furniture turned in place, end to end, through its own
// `Furniture.rotate`. The action owns the whole native lifecycle (resolve the piece from the
// location's furniture collection, re-derive its id, read the reach, turn it, probe the new
// footprint, re-read the result); this runner's job is to prove the four facts a receipt
// cannot supply on its own:
//
//   1. the terminal is the action's own `succeeded/furniture_rotated`;
//   2. the WORLD agrees afterwards, read from a FRESH snapshot and never from the receipt's
//      claim: the piece's `currentRotation` changed and equals the value the native call
//      produced, and its `rotations` (the size of its own cycle) did not change - a piece
//      re-created by the turn would show a different cycle;
//   3. the piece is still standing on the same tile under the same identity: a rotation moves
//      nothing;
//   4. a piece the engine will not turn (`rotations < 2`, where `rotate()`'s first line is a
//      no-op) is REFUSED BY NAME (`furniture_rotation_unsupported`) and its `currentRotation`
//      is unchanged in a fresh snapshot. Silently accepting that request would report a turn
//      that never happened.
//
// The runner never recomputes `Furniture.rotate`'s arithmetic: the expected rotation is the
// Mod's own post-call read (`rotation_expected`), so this file cannot become a second authority
// for the cycle (0 -> 2 for a two-rotation piece, 0 -> 1 -> 2 -> 3 -> 0 for a four-rotation one).

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "rotate_furniture";
/** The action's own success word: `ExecuteRotateFurniture` mints it only when turned && standing && holdsTheTurn. */
const SUCCESS_CODE = "furniture_rotated";
/** The engine's own guard, named instead of turned into a silent no-op. */
const UNSUPPORTED_CODE = "furniture_rotation_unsupported";

/** The Given this slice arms: one turnable piece and one the engine will not turn, beside the actor. */
const FIXTURE_SCENARIO = "native_rotate_furniture_v1";

/**
 * The closed set the surface must carry.
 *
 * `inspect_self`/`cancel_active_execution` are the two fixed protocol controls
 * (`FarmhandCapabilitySet.ProtocolControls`) and `rotate_furniture` is the registration under
 * test. No movement action is required: the fixture stands the actor beside both pieces, and
 * the reach is the piece's own footprint predicate on the game thread.
 */
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** The Mod's own `worldObjectTargets` kind for a piece standing in `location.furniture`. */
const FURNITURE_KIND = "placed_furniture";

export async function runRotateFurnitureSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 30_000, postconditionTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateConfig(config);
    // The fixture places the actor with `warpFarmer`, and that warp is ASYNC: the bridge opens
    // while the fade is still in flight, so an immediate observation can read `can_move=False`
    // and the run dies with `native_snapshot_not_actionable`. A warp in flight is not a world
    // that cannot act, so wait for the ability to act - bounded, and still fail-closed with the
    // same named code when the world never settles.
    const before = await waitForActionable(client, await observeFresh(client), 30_000);
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    trace.push({
      phase: "observed",
      revision: before.revision,
      location: before.location,
      tile: before.tile ?? null,
      actionable: before.actionable,
      furniture: describeFurniture(before),
    });

    const turnable = choosePiece(before, (row) => row.rotations >= 2, "turnable");
    const unsupported = choosePiece(before, (row) => row.rotations < 2, "unsupported");
    if (turnable.targetId === unsupported.targetId) throw new Error("rotate_furniture_piece_identity_collision");
    trace.push({ phase: "chosen", turnable, unsupported });

    const turn = await rotate(client, receipts, trace, turnable, "turn", { terminalTimeoutMs });
    const turnEvidence = turn.evidence;
    if (turn.terminal.state !== "succeeded" || turn.terminal.reasonCode !== SUCCESS_CODE) {
      throw new Error(
        `rotate_furniture_terminal_mismatch:state=${turn.terminal.state};reason=${turn.terminal.reasonCode}` +
          `;evidence=${turn.terminal.evidence?.detail ?? "(none)"}`,
      );
    }
    assertEvidence(turnEvidence, "target", turnable.targetId);
    assertEvidence(turnEvidence, "tile", `${turnable.x},${turnable.y}`);
    assertEvidence(turnEvidence, "item", turnable.qualifiedItemId);
    assertEvidence(turnEvidence, "turned", "true");
    assertEvidence(turnEvidence, "standing", "true");
    assertEvidence(turnEvidence, "placeable", "true");
    const rotationBefore = integerEvidence(turnEvidence, "rotation_before");
    const rotationAttempted = integerEvidence(turnEvidence, "rotation_expected");
    if (rotationBefore !== turnable.rotation)
      throw new Error(
        `rotate_furniture_rotation_before_disagrees_with_observation:` +
          `${rotationBefore}:${turnable.rotation};target=${turnable.targetId}`,
      );
    if (rotationAttempted === rotationBefore)
      throw new Error(
        `rotate_furniture_native_call_did_not_turn:${rotationBefore};target=${turnable.targetId};` +
          `rotations=${turnable.rotations}`,
      );
    const rotationsAfterCall = integerEvidence(turnEvidence, "rotations");
    if (rotationsAfterCall !== turnable.rotations)
      throw new Error(
        `rotate_furniture_rotation_cycle_changed:${turnable.rotations}:${rotationsAfterCall};target=${turnable.targetId}`,
      );

    // Fact 2 and fact 3, from a FRESH snapshot: the world's own answer, never the receipt's.
    const after = await waitForFreshSnapshot(client, {
      minRevision: turn.terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    if (after.location !== before.location)
      throw new Error(`rotate_furniture_location_changed:${before.location}->${after.location}`);
    const turned = publishedPiece(after, turnable.x, turnable.y);
    if (turned === null)
      throw new Error(
        `rotate_furniture_piece_missing_after_turn:target=${turnable.targetId};tile=${turnable.x},${turnable.y}`,
      );
    // THE WITNESS, published verbatim. `evidence` is the Mod describing what it did to itself; this row is
    // the world's own answer to the same question, read from a snapshot taken AFTER the terminal. Everything
    // below is asserted against THIS object, so the result cannot be a restatement of the receipt.
    const freshRow = Object.freeze({
      targetId: turned.targetId,
      x: turned.x,
      y: turned.y,
      qualifiedItemId: turned.qualifiedItemId,
      rotation: turned.rotation,
      rotations: turned.rotations,
    });
    if (freshRow.targetId !== turnable.targetId)
      throw new Error(
        `rotate_furniture_piece_identity_changed:${turnable.targetId}->${freshRow.targetId};tile=${turnable.x},${turnable.y}`,
      );
    if (freshRow.x !== turnable.x || freshRow.y !== turnable.y)
      throw new Error(
        `rotate_furniture_piece_moved:${turnable.x},${turnable.y}->${freshRow.x},${freshRow.y};target=${turnable.targetId}`,
      );
    if (freshRow.rotation !== rotationAttempted)
      throw new Error(
        `rotate_furniture_fresh_rotation_disagrees_with_native_call:${freshRow.rotation}:${rotationAttempted};` +
          `target=${turnable.targetId};tile=${turnable.x},${turnable.y}`,
      );
    if (freshRow.rotation === rotationBefore)
      throw new Error(`rotate_furniture_fresh_rotation_unchanged:${rotationBefore};target=${turnable.targetId}`);
    if (freshRow.rotations !== turnable.rotations)
      throw new Error(
        `rotate_furniture_fresh_cycle_changed:${turnable.rotations}->${freshRow.rotations};target=${turnable.targetId}`,
      );
    trace.push({
      phase: "fresh_postcondition",
      revision: after.revision,
      freshRow,
      rotationBefore,
      rotationAfter: freshRow.rotation,
    });

    // Fact 4: a piece the engine will not turn is refused BY NAME, and nothing in the world moves.
    const refusal = await rotate(client, receipts, trace, unsupported, "refuse", { terminalTimeoutMs });
    if (refusal.terminal.state === "succeeded" || refusal.terminal.reasonCode === SUCCESS_CODE)
      throw new Error(
        `rotate_furniture_unsupported_piece_was_accepted:state=${refusal.terminal.state}` +
          `;reason=${refusal.terminal.reasonCode};target=${unsupported.targetId};rotations=${unsupported.rotations}`,
      );
    if (refusal.terminal.reasonCode !== UNSUPPORTED_CODE)
      throw new Error(
        `rotate_furniture_unsupported_refusal_not_by_name:state=${refusal.terminal.state}` +
          `;reason=${refusal.terminal.reasonCode};target=${unsupported.targetId};rotations=${unsupported.rotations}` +
          `;evidence=${refusal.terminal.evidence?.detail ?? "(none)"}`,
      );
    const refusalRotations = integerEvidence(refusal.evidence, "rotations");
    if (refusalRotations >= 2)
      throw new Error(
        `rotate_furniture_unsupported_refusal_disagrees_with_piece:rotations=${refusalRotations};target=${unsupported.targetId}`,
      );
    assertEvidence(refusal.evidence, "target", unsupported.targetId);
    const afterRefusal = await waitForFreshSnapshot(client, {
      minRevision: refusal.terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    const untouched = publishedPiece(afterRefusal, unsupported.x, unsupported.y);
    if (untouched === null)
      throw new Error(
        `rotate_furniture_unsupported_piece_missing:target=${unsupported.targetId};tile=${unsupported.x},${unsupported.y}`,
      );
    const freshRefusalRow = Object.freeze({
      targetId: untouched.targetId,
      x: untouched.x,
      y: untouched.y,
      qualifiedItemId: untouched.qualifiedItemId,
      rotation: untouched.rotation,
      rotations: untouched.rotations,
    });
    if (freshRefusalRow.rotation !== unsupported.rotation)
      throw new Error(
        `rotate_furniture_refused_turn_changed_the_world:${unsupported.rotation}->${freshRefusalRow.rotation};target=${unsupported.targetId}`,
      );
    trace.push({
      phase: "refusal",
      state: refusal.terminal.state,
      reasonCode: refusal.terminal.reasonCode,
      target: unsupported.targetId,
      rotations: refusalRotations,
      freshRefusalRow,
    });

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: SUCCESS_CODE,
      target: publicPiece(turnable),
      // The world's own row after the terminal, verbatim, and the same for the piece the refusal named.
      // `freshRowAbsent` is published explicitly rather than left to be inferred from an empty summary.
      freshRow: freshRow,
      freshRowAbsent: false,
      freshRefusalRow: freshRefusalRow,
      freshRefusalRowAbsent: false,
      rotation: {
        before: rotationBefore,
        after: freshRow.rotation,
        expected: rotationAttempted,
        rotations: freshRow.rotations,
      },
      refusal: {
        target: unsupported.targetId,
        rotations: unsupported.rotations,
        state: refusal.terminal.state,
        reasonCode: refusal.terminal.reasonCode,
        freshRotation: freshRefusalRow.rotation,
      },
      evidence: turnEvidence,
      receipt: summarizeReceipt(turn.terminal),
      observations: {
        before: { revision: before.revision, location: before.location, tile: before.tile ?? null },
        after: { revision: after.revision, location: after.location, tile: after.tile ?? null },
        afterRefusal: {
          revision: afterRefusal.revision,
          location: afterRefusal.location,
          tile: afterRefusal.tile ?? null,
        },
      },
      trace,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 512),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * One rotation request, its terminal, and its evidence.
 *
 * The rotation is synchronous - the Mod answers with the terminal receipt in the same response -
 * but the terminal is still read through `waitForTerminal`, because the receipt is the authority
 * for `state`/`reasonCode`/`evidence` and reading it out of the response body would be a second
 * spelling of the same fact.
 */
async function rotate(client, receipts, trace, piece, phase, { terminalTimeoutMs }) {
  const requestId = `native_local_rotate_furniture_${phase}_${Date.now()}_${trace.length}`;
  const snapshot = await waitForActionable(client, await observeFresh(client), 30_000);
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { x: piece.x, y: piece.y, expectedTargetId: piece.targetId },
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({
    phase,
    action: ACTION,
    args: { x: piece.x, y: piece.y, expectedTargetId: piece.targetId },
    receipt: summarizeReceipt(accepted),
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
    throw new Error(`rotate_furniture_terminal_identity_mismatch:${phase}`);
  const evidence = parseEvidence(terminal.evidence);
  trace.push({ phase: `${phase}_terminal`, state: terminal.state, reasonCode: terminal.reasonCode, evidence });
  return { requestId, accepted, terminal, evidence };
}

/** The one published piece matching `accepts`, named as missing or ambiguous otherwise. */
function choosePiece(snapshot, accepts, expectation) {
  const pieces = publishedPieces(snapshot);
  const candidates = pieces.filter((row) => accepts(row));
  if (candidates.length !== 1)
    throw new Error(
      `rotate_furniture_${expectation}_piece_count_expected_1_got_${candidates.length}:` +
        (describeFurniture(snapshot) || "none"),
    );
  return candidates[0];
}

/**
 * The projection's own furniture rows.
 *
 * A row without `rotation`/`rotations` is a transport fault, not a piece this runner can judge:
 * the Mod writes both on every `placed_furniture` row (null on every other kind), so a missing
 * one means the frame and the code disagree and the run must not guess.
 */
function publishedPieces(snapshot) {
  const entries = snapshot?.worldObjectTargets;
  if (!Array.isArray(entries))
    throw new Error(`rotate_furniture_no_world_object_projection:location=${snapshot?.location ?? "unknown"}`);
  return entries
    .filter(
      (entry) =>
        entry != null &&
        entry.kind === FURNITURE_KIND &&
        typeof entry.targetId === "string" &&
        entry.targetId.length > 0 &&
        Number.isSafeInteger(entry.x) &&
        Number.isSafeInteger(entry.y) &&
        typeof entry.qualifiedItemId === "string",
    )
    .map((entry) => {
      if (!Number.isSafeInteger(entry.rotation) || !Number.isSafeInteger(entry.rotations))
        throw new Error(
          `rotate_furniture_piece_without_rotation_fact:target=${entry.targetId};` +
            `rotation=${String(entry.rotation)};rotations=${String(entry.rotations)}`,
        );
      return {
        targetId: entry.targetId,
        x: entry.x,
        y: entry.y,
        qualifiedItemId: entry.qualifiedItemId,
        displayName: entry.displayName ?? entry.qualifiedItemId,
        rotation: entry.rotation,
        rotations: entry.rotations,
      };
    });
}

function publishedPiece(snapshot, x, y) {
  return publishedPieces(snapshot).find((row) => row.x === x && row.y === y) ?? null;
}

function describeFurniture(snapshot) {
  const entries = snapshot?.worldObjectTargets;
  if (!Array.isArray(entries)) return "";
  return entries
    .filter((entry) => entry?.kind === FURNITURE_KIND)
    .map(
      (entry) =>
        `${entry.targetId}@${entry.x},${entry.y}=${entry.qualifiedItemId}#${entry.rotation}/${entry.rotations}`,
    )
    .join("|");
}

function publicPiece(piece) {
  return {
    targetId: piece.targetId,
    kind: FURNITURE_KIND,
    location: piece.location,
    x: piece.x,
    y: piece.y,
    qualifiedItemId: piece.qualifiedItemId,
    displayName: piece.displayName,
  };
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`rotate_furniture_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function integerEvidence(evidence, key) {
  const raw = evidence[key];
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isSafeInteger(value))
    throw new Error(`rotate_furniture_evidence_${key}_not_an_integer:${raw ?? "missing"}`);
  return value;
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== FIXTURE_SCENARIO)
    throw new Error("native_local_rotate_furniture_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_rotate_furniture_action_policy_invalid");
  // `rotate_furniture` is an Experimental registration, so the fixture's derived policy
  // legitimately opts it in - and nothing else.
  validateNativeLocalFixturePolicy(value, {
    requiredActions: [ACTION],
    experimentalActions: [ACTION],
  });
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runRotateFurnitureSmoke(session.client, session.receipts, config);
    if (result.state === "passed") console.log(JSON.stringify(result));
    else console.error(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
