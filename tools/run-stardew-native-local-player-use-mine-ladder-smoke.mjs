// Stardew-local use_mine_ladder smoke: the way OUT of a mine level.
//
// Measured 2026-11-03 (round30): a companion that had taken `enter_mine` into a freshly generated
// level was published no ladder of either kind, so every way out was unnamable and it stayed in the
// mine until it passed out at 02:00 and lost the next day. `use_mine_ladder` is the exit half:
// `MineShaft.checkAction` case 115 opens the game's own `ExitMine` question (MineShaft.cs:3073-3081)
// and the Leave response warps the actor out inside the game (GameLocation.cs:12388-12401).
//
// The receipt is not the proof. Three things are asserted:
//   1. the terminal is `succeeded/mine_left` (not `uncertain`, not the descent ladder's refusal);
//   2. the actor's LOCATION, read from a fresh observation bound to the terminal's revision, is no
//      longer a MineShaft - that is what "left" means;
//   3. the receipt names the decision it took (`question=ExitMine`, `response=Leave`), so the proof
//      shows an answered question rather than only the aftermath.
//
// An IMMEDIATE terminal is accepted exactly like `accepted`-then-terminal: the answer sometimes warps
// synchronously and sometimes through the native Warped edge, and demanding one shape fails a correct run.

import { loadHostTestModule } from "./lib/host-test-module.mjs";
import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  TERMINAL_STATES,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "use_mine_ladder";
const SCENARIO = "native_mine_use_ladder_exit_v1";
/** The one reason code the Mod reports for a native exit that completed. */
const TERMINAL_REASON = "mine_left";
/** Movement plus the exit, and nothing else: the fixture starts the actor beside the ladder. */
const REQUIRED_CAPABILITIES = ["cancel_active_execution", ACTION, "inspect_self", "move_to_tile"];

/** Execute the use_mine_ladder exit contract against a connected session. */
export async function runUseMineLadderSmoke(
  client,
  receipts,
  config,
  { settleTimeoutMs = 15_000, moveTimeoutMs = 55_000, exitTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    const before = await waitForSettledWorld(client, settleTimeoutMs);
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const beforeLevel = requireMineLevel(before.location);
    // The fixture asserts the level carries NO descent ladder, so the family carries exactly one row and it is
    // the exit ladder. If a second row appears the Given was not established, and the run would prove nothing.
    const ladder = requireSoleLadderTarget(before);
    const actor = requireActorTile(before);

    const standing = chooseStandingTile(actor, ladder);
    const move = await execute(client, trace, "reach_exit_ladder", "move_to_tile", standing, before);
    const moveTerminal = TERMINAL_STATES.has(move.state) ? move : await waitForTerminal(receipts, move, moveTimeoutMs);
    if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached")
      throw new Error(`use_mine_ladder_move_failed:${moveTerminal.state}/${moveTerminal.reasonCode}`);

    const settled = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(settled, REQUIRED_CAPABILITIES);
    const settledActor = requireActorTile(settled);
    if (!withinInteractionRadius(settledActor, ladder))
      throw new Error(`use_mine_ladder_actor_out_of_range:${settledActor.x},${settledActor.y}:${ladder.x},${ladder.y}`);
    // The target must still be the SAME live row and the same level: a reloaded level between the two
    // observations would make the request name a tile production no longer reads.
    const settledLadder = requireSoleLadderTarget(settled);
    if (settledLadder.targetId !== ladder.targetId || settledLadder.x !== ladder.x || settledLadder.y !== ladder.y)
      throw new Error(`use_mine_ladder_target_drifted:${ladder.targetId}:${settledLadder.targetId}`);
    if (requireMineLevel(settled.location) !== beforeLevel)
      throw new Error(`use_mine_ladder_level_drifted:${settled.location}`);

    const dispatched = await execute(
      client,
      trace,
      "use_mine_ladder",
      ACTION,
      { x: ladder.x, y: ladder.y, expectedTargetId: ladder.targetId },
      settled,
    );
    const terminal = TERMINAL_STATES.has(dispatched.state)
      ? dispatched
      : await waitForTerminal(receipts, dispatched, exitTimeoutMs);

    const evidence = parseEvidence(evidenceText(terminal));
    trace.push({
      phase: "terminal",
      state: terminal.state,
      reasonCode: terminal.reasonCode,
      revision: terminal.revision,
      evidence: evidenceText(terminal)?.slice(0, 240) ?? null,
    });

    // The world, not the receipt, decides whether the actor left.
    const after = await waitForFreshSnapshot(client, { minRevision: terminal.revision, timeoutMs: 10_000 });
    const detail = {
      reasonCode: terminal.reasonCode,
      ladder: { targetId: ladder.targetId, x: ladder.x, y: ladder.y },
      standing: `${settledActor.x},${settledActor.y}`,
      beforeLocation: settled.location,
      beforeLevel,
      afterLocation: after.location,
      afterLevel: mineLevelFromLocation(after.location),
      question: evidence.question ?? null,
      response: evidence.response ?? null,
      terminalFrom: evidence.from ?? null,
      trace,
    };
    assertUseMineLadderPostconditions(detail);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      executionId: terminal.executionId,
      requestId: terminal.requestId,
      receipt: summarizeReceipt(terminal),
      ...detail,
      before: summarizeSnapshot(settled),
      after: summarizeSnapshot(after),
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

/**
 * The pass contract, factored out so a negative test can prove each clause instead of trusting the
 * happy path. Every clause is a fact about the world, or about the decision the receipt names.
 */
export function assertUseMineLadderPostconditions(detail) {
  if (detail.reasonCode !== TERMINAL_REASON) throw new Error(`use_mine_ladder_reason:${detail.reasonCode}`);
  if (!Number.isSafeInteger(detail.beforeLevel)) throw new Error("use_mine_ladder_origin_level_missing");
  // The world moved OUT: a level name is no longer a MineShaft.
  if (detail.afterLevel !== null) throw new Error(`use_mine_ladder_still_in_mine:${detail.afterLocation}`);
  if (detail.afterLocation === detail.beforeLocation)
    throw new Error(`use_mine_ladder_location_unchanged:${detail.afterLocation}`);
  // The receipt names the decision: the game's own question, and the one response that leaves.
  if (detail.question !== "ExitMine")
    throw new Error(`use_mine_ladder_question_missing:${detail.question ?? "(none)"}`);
  if (detail.response !== "Leave") throw new Error(`use_mine_ladder_response_missing:${detail.response ?? "(none)"}`);
  if (!detail.ladder?.targetId) throw new Error("use_mine_ladder_target_missing_from_detail");
  if (!detail.trace?.some((entry) => entry.action === ACTION)) throw new Error("use_mine_ladder_trace");
  return detail;
}

/** The stored fixture config must be this scenario, in the isolated native-local topology. */
export function validateNativeLocalFixtureConfig(config) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const scenario = config.NativeLocalPlayerFixture.FixtureScenario;
  if (scenario !== SCENARIO) throw new Error(`native_local_fixture_scenario_mismatch:${scenario ?? "missing"}`);
}

async function waitForSettledWorld(client, timeoutMs) {
  try {
    return await waitForFreshSnapshot(client, { timeoutMs, requireActionable: true });
  } catch (error) {
    throw new Error(`use_mine_ladder_world_not_settled:${String(error?.message ?? error)}`);
  }
}

/**
 * The one advertised ladder row. The fixture asserts the level carries no descent ladder, so a mine
 * level publishes exactly its exit row; a second row means the Given was not established.
 */
function requireSoleLadderTarget(snapshot) {
  const targets = snapshot?.mineEntranceTargets;
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("use_mine_ladder_target_missing");
  if (targets.length !== 1) throw new Error(`use_mine_ladder_target_ambiguous:${targets.length}`);
  const [target] = targets;
  if (
    typeof target?.targetId !== "string" ||
    target.targetId.length === 0 ||
    !Number.isInteger(target.x) ||
    !Number.isInteger(target.y)
  )
    throw new Error("use_mine_ladder_target_malformed");
  return { targetId: target.targetId, x: target.x, y: target.y };
}

function requireActorTile(snapshot) {
  if (!(Number.isInteger(snapshot?.tile?.x) && Number.isInteger(snapshot.tile.y)))
    throw new Error(`use_mine_ladder_actor_tile_missing:${snapshot?.location}`);
  return { x: snapshot.tile.x, y: snapshot.tile.y };
}

/** The live mine level of a generated level's location name, or null when the actor is not in one. */
function mineLevelFromLocation(location) {
  if (typeof location !== "string") return null;
  const match = /^UndergroundMine(\d+)$/.exec(location);
  return match === null ? null : Number.parseInt(match[1], 10);
}

function requireMineLevel(location) {
  const level = mineLevelFromLocation(location);
  if (level === null) throw new Error(`use_mine_ladder_not_in_mine_shaft:${location ?? "(none)"}`);
  return level;
}

/** The tile to stand on: where the actor already is, or the ladder's nearest cardinal neighbour. */
function chooseStandingTile(actor, ladder) {
  if (withinInteractionRadius(actor, ladder)) return { x: actor.x, y: actor.y };
  const neighbours = [
    { x: ladder.x, y: ladder.y + 1 },
    { x: ladder.x, y: ladder.y - 1 },
    { x: ladder.x + 1, y: ladder.y },
    { x: ladder.x - 1, y: ladder.y },
  ].filter((tile) => tile.x >= 0 && tile.y >= 0);
  if (neighbours.length === 0) throw new Error("use_mine_ladder_standing_tile_missing");
  neighbours.sort(
    (left, right) => chebyshev(left, actor) - chebyshev(right, actor) || left.x - right.x || left.y - right.y,
  );
  return neighbours[0];
}

/** The native interaction radius `Utility.tileWithinRadiusOfPlayer(..., 1, ...)`. */
function withinInteractionRadius(left, right) {
  return Number.isInteger(left?.x) && Number.isInteger(left?.y) && chebyshev(left, right) <= 1;
}

function chebyshev(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

/** The wire carries evidence as an object; the Mod's string form arrives as `{ detail }`. */
function evidenceText(receipt) {
  const evidence = receipt?.evidence;
  if (typeof evidence === "string") return evidence;
  return typeof evidence?.detail === "string" ? evidence.detail : null;
}

/** Parse `key=value;...`. Only the FIRST '=' of a segment separates, so values keep theirs. */
function parseEvidence(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("use_mine_ladder_evidence_missing");
  const fields = {};
  for (const segment of text.split(";")) {
    const index = segment.indexOf("=");
    if (index <= 0) throw new Error(`use_mine_ladder_evidence_malformed:${segment}`);
    fields[segment.slice(0, index).trim()] = segment.slice(index + 1).trim();
  }
  return fields;
}

// `snapshot` is required: executeFresh binds the request to the observation it was computed against.
async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_use_mine_ladder_${phase}_${Date.now()}_${trace.length}`;
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

if (import.meta.main) {
  const config = await readNativeClientConfig();
  // The production Host generation is not available in this environment; the test loader
  // is the same precedent the other native-local gates use.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runUseMineLadderSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
