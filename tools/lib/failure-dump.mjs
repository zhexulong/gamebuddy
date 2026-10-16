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

/** Season names in the engine's own index order (`seasonIndex` 0..3). */
export const SEASON_NAMES = Object.freeze(["spring", "summer", "fall", "winter"]);

/** The single-step replay entry point, relative to the repository root. */
export const SINGLE_STEP_ENTRY = "tools/live-run/game/run-single-step.mjs";

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The failure moment, in the shape the bundle validates.
 *
 * `snapshot` is the bridge's own snapshot (`timeOfDay`, `dayOfMonth`, `seasonIndex`, `year`, `location`,
 * `tileX`, `tileY`, `facing`): the same fields the native code reads, published without interpretation.
 * Anything the snapshot cannot supply stays null and is reported as missing by the validator rather than
 * invented - a plausible default here is exactly how a replay ends up reproducing the wrong morning.
 */
export function buildFailureSnapshot({
  reasonCode,
  component,
  step,
  snapshot,
  atMs = Date.now(),
  blockingProperties = [],
  collisionLayers = [],
} = {}) {
  const observed = isPlainObject(snapshot) ? snapshot : null;
  return Object.freeze({
    reasonCode: typeof reasonCode === "string" && reasonCode.length > 0 ? reasonCode : null,
    component: typeof component === "string" && component.length > 0 ? component : null,
    step: Number.isInteger(step) && step >= 0 ? step : null,
    playerTile:
      observed !== null && isFiniteNumber(observed.tileX) && isFiniteNumber(observed.tileY)
        ? Object.freeze({ x: observed.tileX, y: observed.tileY })
        : null,
    playerFacing: typeof observed?.facing === "string" && observed.facing.length > 0 ? observed.facing : null,
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
export function buildReproPlan({ actionTrace, turn, slot, scenario } = {}) {
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
  return Object.freeze({
    command,
    expectedWallClockMs: budget === null ? null : budget.totalMs,
    replayedSteps: replayed.length,
    // Published so a reader can see the wait is derived, not guessed (the trace is the only source).
    schedule: budget === null ? null : budget.steps,
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
