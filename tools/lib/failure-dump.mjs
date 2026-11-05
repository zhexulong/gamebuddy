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

/**
 * The error classes that mean THIS CODE is wrong rather than that the run went wrong.
 *
 * They are separated because their messages are prose written by the runtime for a developer (`path is not defined`),
 * and prose in a `reasonCode` slot breaks every consumer that switches on the code. The class is a closed fact; the
 * message is not.
 */
export const PROGRAMMING_ERROR_CLASSES = Object.freeze(["RangeError", "ReferenceError", "SyntaxError", "TypeError"]);

/** What a programming error - or an unrecognisable throw - is published under. */
export const RUNNER_INTERNAL_ERROR_CODE = "runner_internal_error";

/** What a thrown non-Error (a rejected string, a number) is published under. */
export const RUNNER_ERROR_CODE = "runner_error";

/**
 * How many stack frames a failure record keeps.
 *
 * V8's own default `Error.stackTraceLimit` is 10 (measured on this tree's Node: a 40-deep recursion published 10
 * frames), so 20 is a ceiling that never truncates what the runtime produced - and it still bounds the record when a
 * caller has raised that limit.
 */
export const FAILURE_STACK_FRAMES = 20;

/** A whole code, including the qualifiers this tree's own codes carry (`menu_not_dismissed:ShippingMenu`). */
const REASON_CODE_SEQUENCE = /^[a-z][a-z0-9_]*(?::[a-z0-9_./-]+)*$/;
const STACK_FRAME = /^at\s/;
/**
 * A V8 stack frame's `file:line:column`, with a `file:///` scheme stripped so the value is a path a reader can open.
 * The optional `(` is the "(location)" form; the optional `)` closes it.
 */
const STACK_LOCATION = /(?:file:\/\/\/)?\(?([^()\s]+?):(\d+):(\d+)\)?$/;

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function stackFrames(stack) {
  if (typeof stack !== "string") return Object.freeze([]);
  return Object.freeze(
    stack
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => STACK_FRAME.test(line))
      .slice(0, FAILURE_STACK_FRAMES),
  );
}

/** The first frame that names a file and a line, as `file:line`: the site a reader has to be able to open. */
function firstFrameLocation(frames) {
  for (const frame of frames) {
    const match = STACK_LOCATION.exec(frame);
    if (match !== null) return `${match[1]}:${match[2]}`;
  }
  return null;
}

/**
 * A thrown value, classified: what a failure record publishes instead of the exception's own text.
 *
 * `reasonCode` has exactly three arms, and every one of them is closed:
 *
 *   1. a programming error (`PROGRAMMING_ERROR_CLASSES`) -> `runner_internal_error`, because a defect in this code is
 *      not a run outcome and its message is developer prose;
 *   2. any other `Error` whose message is ENTIRELY a code - the repository's own throw-with-a-code style
 *      (`throw new Error("unknown_run_scenario:...")`, `throw new Error("dialogue_exited_before_ready:1")`) -> that
 *      message, so a run that named its own refusal keeps its name;
 *   3. everything else - a thrown string or number (`runner_error`), or a message that is not a code
 *      (`runner_internal_error`).
 *
 * The test is "is this message NOTHING BUT a code", not "does its first word look like one": a message with a space, a
 * capital, or a quote in it is prose, and prose belongs in `errorMessage`.
 *
 * Measured 2026-11-05 (`2026-11-05T11-37-35-764Z-multiday_routine`): a `ReferenceError` in the runner's own exit path
 * published `reasonCode: "path is not defined"` with no class, no stack and no site - an exception message in a code
 * slot, and an unsolvable artifact. The message still travels, in `errorMessage`; what it may no longer be is the code.
 */
export function classifyFailure(thrown) {
  const error = thrown instanceof Error ? thrown : null;
  const errorClass = error === null ? typeof thrown : error.name || "Error";
  const errorMessage = String(error === null ? thrown : error.message).slice(0, 1000);
  const errorStack = stackFrames(error?.stack);
  return Object.freeze({
    reasonCode: reasonCodeFor(error, errorClass, errorMessage),
    errorClass,
    errorMessage,
    errorStack,
    errorFrame: firstFrameLocation(errorStack),
  });
}

function reasonCodeFor(error, errorClass, errorMessage) {
  if (error === null) return RUNNER_ERROR_CODE;
  if (PROGRAMMING_ERROR_CLASSES.includes(errorClass)) return RUNNER_INTERNAL_ERROR_CODE;
  return REASON_CODE_SEQUENCE.test(errorMessage) ? errorMessage : RUNNER_INTERNAL_ERROR_CODE;
}

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
 *
 * `thrown` is the classified error (`classifyFailure`) for a run that CRASHED; a refused run passes none, and the four
 * error fields then say `null` rather than posing as a crash nobody saw.
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
  // The classified thrown error, when the run ended on one (`classifyFailure`). Its `reasonCode` IS the failure's code,
  // and the class/message/stack beside it are what make the site nameable from the artifact alone.
  thrown = null,
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
    // A classified throw OWNS the code: it was derived from the error that ended the run, so a caller cannot state a
    // code beside it and have the two disagree.
    reasonCode: thrown?.reasonCode ?? (typeof reasonCode === "string" && reasonCode.length > 0 ? reasonCode : null),
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
    // Flat, so a reader needs no second lookup: what threw, what it said, and where the first frame is. `null` means
    // the run was refused rather than crashed, which is a different failure and is not dressed up as one.
    errorClass: thrown?.errorClass ?? null,
    errorMessage: thrown?.errorMessage ?? null,
    errorStack: thrown?.errorStack ?? null,
    errorFrame: thrown?.errorFrame ?? null,
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
