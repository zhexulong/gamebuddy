// Stardew-local enter_mine LADDER-descent smoke.
//
// `enter_mine` was widened to absorb descending a mine level's ladder. Inside a
// MineShaft the way down is that level's own Buildings-layer ladder tile (index 173),
// whose native terminal is `MineShaft.checkAction` case 173 ->
// `Game1.enterMine(mineLevel + 1)` (MineShaft.cs:3083-3086). The published `enter_mine`
// gate covers the `Mine` entrance map, so the ladder branch had no live gate at all;
// this runner is that second gate, over its own fixture scenario.
//
// The descent level is NATIVE state: the handler computes `shaft.mineLevel + 1` and
// never reads a client value, so this runner derives its expectation from the level it
// OBSERVES before the request. A hard-coded level would pass on a world where the
// handler had silently picked the wrong floor.
//
// The receipt is not the proof. Three things are asserted:
//   1. the terminal is `succeeded/mine_entered` (not `uncertain`, not the
//      entrance branch's refusal);
//   2. the actor's LOCATION, read from a fresh observation, is the shaft one level
//      DEEPER than the one they were standing in;
//   3. the level the receipt declares equals the level the world actually reached.
//
// An IMMEDIATE terminal is accepted exactly like `accepted`-then-terminal: a request
// whose native work resolves synchronously answers with a terminal directly, and
// demanding `accepted` fails a correct run.

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

const ACTION = "enter_mine";
const SCENARIO = "native_mine_enter_ladder_v1";
/** The one reason code the Mod reports for a native descent that completed. */
const TERMINAL_REASON = "mine_entered";
/** The whole contract is movement plus the descent, so both are required here. */
const REQUIRED_CAPABILITIES = ["cancel_active_execution", ACTION, "inspect_self", "move_to_tile"];

/** Execute the enter_mine ladder-descent contract against a connected session. */
export async function runEnterMineLadderSmoke(
  client,
  receipts,
  config,
  { settleTimeoutMs = 15_000, moveTimeoutMs = 55_000, ladderTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  // A config that is not the isolated native-local topology for THIS scenario is a
  // harness error, not a run result: it throws rather than reporting `blocked`.
  validateNativeLocalFixtureConfig(config);
  try {
    // The fixture enters the shaft with the game's own `Game1.enterMine`, and that warp
    // completes through the native lifecycle rather than synchronously, so the opening
    // observation waits for the world to be settled before the fixture's Given is read.
    const before = await waitForSettledWorld(client, settleTimeoutMs);
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const beforeLevel = requireMineLevel(before.location);
    const ladder = requireLadderTarget(before);
    const actor = requireActorTile(before);

    // (a) The actor must be settled inside the native interaction radius the handler
    //     re-checks (`Utility.tileWithinRadiusOfPlayer(..., 1, ...)`). The fixture places
    //     the ladder beside the tile the native lifecycle lands the actor on, so this is
    //     normally an already-satisfied arrival; the Mod answers that with
    //     `succeeded/target_reached` directly, which is a real receipt for the declared
    //     position rather than an assumption about it.
    const standing = chooseStandingTile(actor, ladder);
    const move = await execute(client, trace, "reach_ladder", "move_to_tile", standing, before);
    const moveTerminal = TERMINAL_STATES.has(move.state) ? move : await waitForTerminal(receipts, move, moveTimeoutMs);
    if (moveTerminal.state !== "succeeded" || moveTerminal.reasonCode !== "target_reached")
      throw new Error(`enter_mine_ladder_move_failed:${moveTerminal.state}/${moveTerminal.reasonCode}`);

    const settled = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(settled, REQUIRED_CAPABILITIES);
    const settledActor = requireActorTile(settled);
    if (!withinInteractionRadius(settledActor, ladder))
      throw new Error(
        `enter_mine_ladder_actor_out_of_range:${settledActor.x},${settledActor.y}:${ladder.x},${ladder.y}`,
      );
    // The target must still be the SAME live ladder: a rebuilt level (or a second
    // ladder) between the two observations would make the request name a tile the
    // handler no longer reads, and the run would prove nothing about the one it did.
    const settledLadder = requireLadderTarget(settled);
    if (settledLadder.targetId !== ladder.targetId || settledLadder.x !== ladder.x || settledLadder.y !== ladder.y)
      throw new Error(`enter_mine_ladder_target_drifted:${ladder.targetId}:${settledLadder.targetId}`);
    if (requireMineLevel(settled.location) !== beforeLevel)
      throw new Error(`enter_mine_ladder_level_drifted:${settled.location}`);

    // (b) The descent request on the ladder tile. x/y and the opaque id are the exact
    //     published target: production re-reads the ladder from the live Buildings layer
    //     and refuses any request the layer does not agree with, so a stale coordinate
    //     cannot descend here.
    const dispatched = await execute(
      client,
      trace,
      "enter_mine_ladder",
      ACTION,
      { x: ladder.x, y: ladder.y, expectedTargetId: ladder.targetId },
      settled,
    );
    const terminal = TERMINAL_STATES.has(dispatched.state)
      ? dispatched
      : await waitForTerminal(receipts, dispatched, ladderTimeoutMs);

    trace.push({
      phase: "terminal",
      state: terminal.state,
      reasonCode: terminal.reasonCode,
      revision: terminal.revision,
      evidence: evidenceText(terminal)?.slice(0, 240) ?? null,
    });

    if (terminal.state !== "succeeded" || terminal.reasonCode !== TERMINAL_REASON)
      throw new Error(`enter_mine_ladder_terminal_mismatch:${terminal.state}/${terminal.reasonCode}`);

    const evidence = parseEvidence(evidenceText(terminal));
    const terminalLevel = requireDeclaredLevel(evidence.level);

    // (c) The world, not the receipt, decides whether the descent happened.
    const after = await waitForFreshSnapshot(client, { minRevision: terminal.revision, timeoutMs: 10_000 });

    const detail = {
      reasonCode: terminal.reasonCode,
      ladder: { targetId: ladder.targetId, x: ladder.x, y: ladder.y },
      standing: `${settledActor.x},${settledActor.y}`,
      beforeLocation: settled.location,
      beforeLevel,
      expectedLevel: beforeLevel + 1,
      afterLocation: after.location,
      afterLevel: mineLevelFromLocation(after.location),
      terminalLevel,
      terminalActual: evidence.actual ?? null,
      trace,
    };
    assertEnterMineLadderPostconditions(detail);

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
 * The pass contract, factored out so a negative test can prove each clause instead of
 * trusting the happy path. Every clause is a fact about the world or about the pair of
 * numbers the receipt and the world must agree on.
 */
export function assertEnterMineLadderPostconditions(detail) {
  if (detail.reasonCode !== TERMINAL_REASON) throw new Error(`enter_mine_ladder_reason:${detail.reasonCode}`);
  if (!Number.isSafeInteger(detail.beforeLevel)) throw new Error("enter_mine_ladder_origin_level_missing");
  // The expected level is DERIVED from the observed one: the handler computes
  // `shaft.mineLevel + 1`, so a hard-coded expectation is not a contract.
  if (detail.expectedLevel !== detail.beforeLevel + 1)
    throw new Error(`enter_mine_ladder_expected_level_not_derived:${detail.expectedLevel}`);
  // The world really moved: the fresh observation is a generated mine level.
  if (!Number.isSafeInteger(detail.afterLevel))
    throw new Error(`enter_mine_ladder_arrival_not_observed:${detail.afterLocation}`);
  if (detail.afterLevel !== detail.expectedLevel)
    throw new Error(`enter_mine_ladder_descent_level_mismatch:${detail.afterLevel}!=${detail.expectedLevel}`);
  // The receipt's declared level is the observed one, not merely a success code.
  if (detail.terminalLevel !== detail.afterLevel)
    throw new Error(`enter_mine_ladder_terminal_level_mismatch:${detail.terminalLevel}!=${detail.afterLevel}`);
  if (!detail.ladder?.targetId) throw new Error("enter_mine_ladder_target_missing_from_detail");
  if (!detail.trace?.some((entry) => entry.action === ACTION)) throw new Error("enter_mine_ladder_trace");
  return detail;
}

/**
 * The stored fixture config must be this scenario. `Portfolio` is deliberately NOT
 * required to be false: it is not a ModConfig property, so the game drops it when it
 * rewrites the profile config, and only an explicit true is a topology violation.
 */
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

/**
 * The opening observation: the world settled, with no execution in flight. The fixture's
 * native `Game1.enterMine` warp lands after the save-load tick, so this bounds the wait
 * for the world rather than racing it; that the world is a MINE is asserted after, as a
 * property of the fixture, not as a timeout.
 */
async function waitForSettledWorld(client, timeoutMs) {
  try {
    return await waitForFreshSnapshot(client, { timeoutMs, requireActionable: true });
  } catch (error) {
    throw new Error(`enter_mine_ladder_world_not_settled:${String(error?.message ?? error)}`);
  }
}

/**
 * The one advertised ladder. A mine level advertises its own ladder through the
 * published `mineEntranceTargets` channel, and a shaft contributes exactly that one
 * target, so anything else means the fixture's ladder is not the one production reads.
 */
function requireLadderTarget(snapshot) {
  const targets = snapshot?.mineEntranceTargets;
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("enter_mine_ladder_target_missing");
  if (targets.length !== 1) throw new Error(`enter_mine_ladder_target_ambiguous:${targets.length}`);
  const [target] = targets;
  if (
    typeof target?.targetId !== "string" ||
    target.targetId.length === 0 ||
    !Number.isInteger(target.x) ||
    !Number.isInteger(target.y)
  )
    throw new Error("enter_mine_ladder_target_malformed");
  return { targetId: target.targetId, x: target.x, y: target.y };
}

function requireActorTile(snapshot) {
  if (!(Number.isInteger(snapshot?.tile?.x) && Number.isInteger(snapshot.tile.y)))
    throw new Error(`enter_mine_ladder_actor_tile_missing:${snapshot?.location}`);
  return { x: snapshot.tile.x, y: snapshot.tile.y };
}

/** The live mine level of a generated level's location name, or null. */
function mineLevelFromLocation(location) {
  if (typeof location !== "string") return null;
  const match = /^UndergroundMine(\d+)$/.exec(location);
  return match === null ? null : Number.parseInt(match[1], 10);
}

function requireMineLevel(location) {
  const level = mineLevelFromLocation(location);
  if (level === null) throw new Error(`enter_mine_ladder_not_in_mine_shaft:${location ?? "(none)"}`);
  return level;
}

/**
 * The tile to stand on: where the actor already is, or the ladder's nearest cardinal
 * neighbour. Cardinal only, because the ladder sits in a floor corridor and a diagonal
 * step is not a tile the actor can be relied on to path to; the order is total
 * (distance, then x, then y) so the same world always names the same tile.
 */
function chooseStandingTile(actor, ladder) {
  if (withinInteractionRadius(actor, ladder)) return { x: actor.x, y: actor.y };
  const neighbours = [
    { x: ladder.x, y: ladder.y + 1 },
    { x: ladder.x, y: ladder.y - 1 },
    { x: ladder.x + 1, y: ladder.y },
    { x: ladder.x - 1, y: ladder.y },
  ].filter((tile) => tile.x >= 0 && tile.y >= 0);
  if (neighbours.length === 0) throw new Error("enter_mine_ladder_standing_tile_missing");
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
  if (typeof text !== "string" || text.length === 0) throw new Error("enter_mine_ladder_evidence_missing");
  const fields = {};
  for (const segment of text.split(";")) {
    const index = segment.indexOf("=");
    if (index <= 0) throw new Error(`enter_mine_ladder_evidence_malformed:${segment}`);
    fields[segment.slice(0, index).trim()] = segment.slice(index + 1).trim();
  }
  return fields;
}

/** The level the receipt declares. Absent or non-numeric is a missing postcondition. */
function requireDeclaredLevel(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new Error(`enter_mine_ladder_terminal_level_missing:${value ?? "(none)"}`);
  return Number.parseInt(value, 10);
}

// `snapshot` is required: executeFresh binds the request to the observation it was
// computed against, which is what stops a stale plan from being replayed.
async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_enter_mine_ladder_${phase}_${Date.now()}_${trace.length}`;
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
  // is the same precedent the newer gates use.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runEnterMineLadderSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
