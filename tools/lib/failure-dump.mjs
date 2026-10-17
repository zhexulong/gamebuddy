/**
 * The failure dump: what a run must leave behind so a failure can be re-entered later.
 *
 * A failure is only analysable if it can be REPOSITIONED: the harness gets no in-day snapshot from the
 * engine (Stardew writes its save at day end), so the only way back is to restart from that day's morning
 * slot and replay the trace up to the failing step. That means a dump has to carry three things - where
 * the actor was, when it was (game time + date), and how to get there again - and a dump missing any of
 * them is not a smaller dump, it is an unusable one.
 *
 * The producers here are pure: they take facts the run already holds (a bridge snapshot, the action trace,
 * the failing step) and return the objects the bundle contract validates. Deciding whether the dump is
 * usable is `evidence-bundle.mjs`'s job, in one place.
 */

import { expectedReplayWallClockMs } from "./replay-clock.mjs";
import { POSE_SOURCES } from "./evidence-bundle.mjs";

/** Season names in the engine's own index order (`seasonIndex` 0..3). */
export const SEASON_NAMES = Object.freeze(["spring", "summer", "fall", "winter"]);
/** Facing as the wire numbers it (`host/src/protocol.ts:2998-3000`: 0..3). */
export const FACING_NAMES = Object.freeze(["up", "right", "down", "left"]);

/** The single-step replay entry point, relative to the repository root. */
export const SINGLE_STEP_ENTRY = "tools/live-run/game/run-single-step.mjs";

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The failure moment, in the shape the bundle validates.
 *
 * `snapshot` is the bridge's own reading, in EITHER of the two shapes the wire actually carries, because both are
 * real and they disagree about where the actor is (`host/src/protocol.ts:108-111`, `:896-904`):
 *   - a `Snapshot` publishes `location` + `tile: { x, y }` and no facing;
 *   - a `LocalObservation` (which rides an execution receipt) publishes `location` + `tileX` / `tileY` + `facing`.
 * Reading only the second one turned a real failure dump into "no tile, no facing" and the contract refused it
 * (measured 2026-10-16). Anything the bridge did not supply stays null and is reported as missing by the validator
 * rather than invented - a plausible default here is exactly how a replay ends up reproducing the wrong morning.
 */
export function buildFailureSnapshot({
  reasonCode,
  component,
  step,
  snapshot,
  poseSource = null,
  atMs = Date.now(),
  blockingProperties = [],
  collisionLayers = [],
} = {}) {
  const observed = isPlainObject(snapshot) ? snapshot : null;
  const tile = (() => {
    if (observed === null) return null;
    if (isFiniteNumber(observed.tileX) && isFiniteNumber(observed.tileY)) {
      return Object.freeze({ x: observed.tileX, y: observed.tileY });
    }
    if (isPlainObject(observed.tile) && isFiniteNumber(observed.tile.x) && isFiniteNumber(observed.tile.y)) {
      return Object.freeze({ x: observed.tile.x, y: observed.tile.y });
    }
    return null;
  })();
  const facing = isFiniteNumber(observed?.facing)
    ? (FACING_NAMES[observed.facing] ?? String(observed.facing))
    : typeof observed?.facing === "string" && observed.facing.length > 0
      ? observed.facing
      : null;
  return Object.freeze({
    reasonCode: typeof reasonCode === "string" && reasonCode.length > 0 ? reasonCode : null,
    component: typeof component === "string" && component.length > 0 ? component : null,
    step: Number.isInteger(step) && step >= 0 ? step : null,
    playerTile: tile,
    playerFacing: facing,
    // Named, not inferred: a receipt's own observation carries the facing, a bare snapshot does not.
    poseSource: POSE_SOURCES.includes(poseSource)
      ? poseSource
      : facing === null
        ? "snapshot_only"
        : "execution_receipt_observation",
    inGameTime: observed?.timeOfDay === undefined ? null : String(observed.timeOfDay),
    day: isFiniteNumber(observed?.dayOfMonth) ? observed.dayOfMonth : null,
    season: SEASON_NAMES[observed?.seasonIndex] ?? null,
    year: isFiniteNumber(observed?.year) ? observed.year : null,
    location: typeof observed?.location === "string" && observed.location.length > 0 ? observed.location : null,
    // The causal preconditions a replay is judged against: which tiles block the actor, and the collision
    // layers that make them block. NPC micro-drift is deliberately NOT here (see the plan's tolerance rule).
    blockingProperties: Object.freeze([...blockingProperties]),
    collisionLayers: Object.freeze([...collisionLayers]),
    atMs: isFiniteNumber(atMs) ? atMs : null,
  });
}

/**
 * The replay plan for a failure: the command that re-enters it, and the wall-clock budget that command
 * needs, derived from the trace's own game times so a long wait is planned rather than discovered by an
 * unrelated harness timeout.
 */
export function buildReproPlan({ actionTrace, turn, slot, scenario, crossings = 0 } = {}) {
  if (!Array.isArray(actionTrace) || !Number.isInteger(turn) || turn < 0) return null;
  if (typeof slot !== "string" || slot.length === 0) return null;
  const replayed = actionTrace.slice(0, turn);
  const budget = expectedReplayWallClockMs(replayed);
  const command = [
    "node",
    SINGLE_STEP_ENTRY,
    ...(typeof scenario === "string" && scenario.length > 0 ? ["--scenario", scenario] : []),
    "--day-start-slot",
    slot,
    "--day-action-trace",
    "actionTrace.jsonl",
    "--turn",
    String(turn),
  ].join(" ");
  // What this command can and cannot reach, stated rather than implied.
  //
  // The replay model is DAY-LEVEL: it restarts from the morning of one slot and drives the recorded trace. That is
  // enough for a failure inside the first day, and it is NOT enough for a failure on day 2 or later, because
  // crossing a night needs the sleep lifecycle and the world the previous nights produced - neither of which this
  // command reproduces. Measured 2026-10-17: a review found the bundle accepted a multi-day failure's single-slot
  // command as "the way back", which it is not. Naming the gap is the honest half; the caller that owns the
  // crossings decides whether to extend the model.
  const reachable = Number.isInteger(crossings) && crossings > 0 ? "first_day_only" : "the_failing_day";
  return Object.freeze({
    command,
    expectedWallClockMs: budget === null ? null : budget.totalMs,
    replayedSteps: replayed.length,
    // Published so a reader can see the wait is derived, not guessed (the trace is the only source).
    schedule: budget === null ? null : budget.steps,
    crossingsBeforeFailure: Number.isInteger(crossings) ? crossings : 0,
    reach: reachable,
    // A multi-day failure cannot be re-entered by this command, and saying so is part of the plan.
    reachReasonCode:
      reachable === "the_failing_day"
        ? null
        : `day_level_replay_cannot_reach_a_later_day:crossings=${String(crossings)}`,
  });
}

/**
 * The clock gate's trace, step by step: for each step, what `decideReplayDispatch` answers when the game
 * is at the recorded time. Used by the replay engine's dry run and by the gate, so the schedule an
 * operator reads is the same one the engine follows.
 */
export function planReplaySchedule(actionTrace, decide) {
  if (!Array.isArray(actionTrace)) return null;
  const steps = [];
  for (const [index, entry] of actionTrace.entries()) {
    const recorded = entry?.inGameTime ?? null;
    const decision = decide(recorded, recorded);
    steps.push(
      Object.freeze({
        index,
        action: entry?.action ?? null,
        requestId: entry?.requestId ?? null,
        inGameTime: recorded,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
      }),
    );
  }
  return Object.freeze(steps);
}
