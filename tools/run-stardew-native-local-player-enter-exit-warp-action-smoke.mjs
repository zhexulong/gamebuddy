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

const ACTION = "enter_exit";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "enter_exit", "inspect_self", "move_to_tile"];

/** Terminal states that would mean the door entry WARPED the actor. */
const SUCCESS_STATES = new Set(["succeeded", "partially_succeeded"]);

/** The one reason code the Mod reports for a native gate that refused. */
const GATE_REFUSED_REASON = "door_gate_refused";

/**
 * enter_exit door-gate WIDENING live contract.
 *
 * `DispatchNativeDoor` now admits a Buildings-layer tile whose Action contains "Warp"
 * instead of requiring membership of `location.doors`. The tile the fixture writes —
 * a single-token `WarpCommunityCenter` — is the case the old door-table admission
 * missed, and it is deliberately ABSENT from the door table at run time, so production
 * cannot publish a door target for it. The target is therefore derived from the actor:
 * the fixture stands them on the tile directly north of it.
 *
 * The receipt is not the proof. Three things are observed directly:
 *   1. the terminal is `rejected/door_gate_refused`, which is the Mod's branch for a
 *      native entry that neither warped nor fell back — NOT `door_transition_not_started`
 *      ("the entry ran and did nothing") and NOT `door_not_available` ("no door here",
 *      the code the pre-widening fallback produced for this tile);
 *   2. the actor is still in their ORIGINAL location. This is the load-bearing negative:
 *      `getWarpFromDoor` resolves this tile to CommunityCenter (32,23), so an admission
 *      that fell through to the resolver would have warped them there;
 *   3. the actor is `actionable` afterwards, i.e. the game's own refusal dialogue was
 *      closed rather than left mounted (`observeFresh({actionable:true})` fails closed
 *      on a mounted modal).
 */
export async function runEnterExitWarpActionSmoke(
  client,
  receipts,
  config,
  { moveTimeoutMs = 55_000, enterExitTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  // A config that is not the isolated native-local topology is a harness error, not a run
  // result: it throws rather than reporting `blocked` (same contract as the sibling
  // enter-exit runner).
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const origin = requireFarmTile(snapshot);

    // The fixture declares the relationship, not a coordinate: the target is the tile
    // the actor is standing on, one south. Re-derive it from every fresh observation
    // rather than remembering it across revisions.
    const standing = { x: origin.x, y: origin.y };
    let target = southOf(standing);
    if (!adjacent(standing, target)) throw new Error("enter_exit_warp_action_target_not_adjacent");

    // (a) The actor must be settled ON the standing tile before the door request. The
    //     Mod answers an already-satisfied arrival with `succeeded/target_reached`, so
    //     this is a real receipt for the declared position rather than an assumption.
    const move = await execute(client, trace, "stand_on_north_tile", "move_to_tile", standing, snapshot);
    // An immediate terminal is a legal shape: the Mod does not start an execution it does
    // not need, so a move to the tile the actor ALREADY stands on answers
    // `succeeded/target_reached` directly. Live showed exactly that, and demanding
    // `accepted` failed the phase for a correct run.
    const moveTerminal =
      move.state === "accepted" ? await waitForTerminal(receipts, move, moveTimeoutMs) : move;
    if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached")
      throw new Error(`enter_exit_warp_action_move_failed:${moveTerminal.state}/${moveTerminal.reasonCode}`);

    snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const settled = requireFarmTile(snapshot);
    if (settled.x !== standing.x || settled.y !== standing.y)
      throw new Error(`enter_exit_warp_action_standing_tile_drifted:${standing.x},${standing.y}:${settled.x},${settled.y}`);
    target = southOf(settled);
    if (!Number.isInteger(target.x) || !Number.isInteger(target.y) || target.y < 0)
      throw new Error("enter_exit_warp_action_target_tile_missing");

    // (b) The door request on the gated warp tile.
    const accepted = await execute(client, trace, "enter_exit_warp_action", ACTION, target, snapshot);
    // `enter_exit` on this tile resolves natively, so the Mod may answer with an IMMEDIATE
    // terminal instead of `accepted`; live produced `rejected/door_gate_refused` directly.
    const terminal =
      accepted.state === "accepted"
        ? await waitForTerminal(receipts, accepted, enterExitTimeoutMs)
        : accepted;

    // (c) Postconditions.
    if (SUCCESS_STATES.has(terminal.state))
      throw new Error(`enter_exit_warp_action_warped_through_the_gate:${terminal.state}/${terminal.reasonCode}`);
    if (terminal.state !== "rejected" || terminal.reasonCode !== GATE_REFUSED_REASON)
      throw new Error(`enter_exit_warp_action_not_gate_refused:${terminal.state}/${terminal.reasonCode}`);

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "gate", "refused");
    assertEvidence(evidence, "entry", "perform_action");
    if (typeof evidence.dialogue !== "string" || evidence.dialogue.length === 0)
      throw new Error("enter_exit_warp_action_evidence_dialogue_missing");

    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    if (after.location !== snapshot.location)
      throw new Error(`enter_exit_warp_action_moved_location:${snapshot.location}:${after.location}`);
    if (after.tile?.x !== snapshot.tile.x || after.tile?.y !== snapshot.tile.y)
      throw new Error(`enter_exit_warp_action_moved_tile:${snapshot.tile.x},${snapshot.tile.y}:${after.tile?.x},${after.tile?.y}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: GATE_REFUSED_REASON,
      location: after.location,
      standing: `${standing.x},${standing.y}`,
      target: `${target.x},${target.y}`,
      doorTableHoldsTarget: false,
      // The receipt summary carries no identity by design; the exact pair this run
      // proves is exposed here.
      executionId: terminal.executionId,
      requestId: terminal.requestId,
      receipt: summarizeReceipt(terminal),
      evidence,
      before: snapshotSummary(snapshot),
      after: snapshotSummary(after),
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
    const result = await runEnterExitWarpActionSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_enter_exit_warp_action_${phase}_${Date.now()}_${trace.length}`;
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

/** The target tile: one south of the tile the actor stands on. */
function southOf(tile) {
  return { x: tile.x, y: tile.y + 1 };
}

/** The actor's tile, with the fixture's own location premise asserted. */
function requireFarmTile(snapshot) {
  if (snapshot.location !== "Farm") throw new Error(`enter_exit_warp_action_not_on_farm:${snapshot.location ?? "(none)"}`);
  if (!Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y))
    throw new Error("enter_exit_warp_action_actor_tile_missing");
  return snapshot.tile;
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

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`enter_exit_warp_action_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

/**
 * The Mod's refusal evidence is `source=x,y;gate=refused;entry=...;dialogue=...`. The
 * dialogue half is the game's own refusal text and may itself contain ';', so only the
 * FIRST '=' of each segment is a separator and the value keeps everything after it.
 */
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

function snapshotSummary(snapshot) {
  return { ...summarizeSnapshot(snapshot), location: snapshot.location, tile: snapshot.tile };
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
