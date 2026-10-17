/**
 * The single-step replay engine: re-enter one failing step of a day that already ran.
 *
 * The engine drives the trace's own REQUEST FRAMES (requestId + action + full args), waiting for each
 * native terminal before sending the next, and gated on the game clock so the world is at the same moment
 * it was. Both halves matter: dispatching as fast as receipts settle reaches 6:20 where the original run
 * reached 10:00 and produces failures the run never had; dispatching without waiting for terminals
 * violates the causal order the trace encodes.
 *
 * It never rewrites the source slot's save (the caller starts a copy), never writes `timeOfDay`, and never
 * skips a step. Its outputs are: for each step, the decision, the dispatched request, and the terminal
 * receipt; plus the final verdict, which distinguishes "the failure was reproduced", "the clock could not
 * be reached", and "the run diverged before the failing step".
 */

import { decideReplayDispatch } from "./replay-clock.mjs";
import { expectedReplayWallClockMs } from "./replay-clock.mjs";

/** How long one step's terminal may take before the replay calls the step stuck. */
export const DEFAULT_STEP_TIMEOUT_MS = 120_000;
/**
 * The longest deadline a replayed dispatch may ask for.
 *
 * The Mod bounds a request's deadline by the ACTION's own published watchdog, whose default is 60 s
 * (`BodyProgramModels.cs:153`); only the cross-day lifecycle publishes 600 s and only the Host's tool layer
 * dispatches that. A replay that asks for more than the action's own budget is refused by name
 * (`invalid_deadline`), so the wait is clamped here instead.
 */
export const REPLAY_DISPATCH_DEADLINE_MS = 45_000;
/** How long the clock gate may wait in total before it calls the recorded moment unreachable. */
export const DEFAULT_CLOCK_WAIT_MS = 20 * 60 * 1000;

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The live game clock, read fresh at each gate: the bridge snapshot is the only authority for it. */
function currentInGameTime(connection) {
  const timeOfDay = connection?.state?.snapshot?.timeOfDay;
  return isFiniteNumber(timeOfDay) ? String(timeOfDay) : null;
}

/**
 * Refresh the cached world state when the connection can observe at all.
 *
 * A session client has `observe()`; the offline doubles used by this module's own tests do not, and for them the
 * cached snapshot IS the world. Refreshing is what makes `expectedRevision` the CURRENT revision rather than the
 * one the previous step left behind.
 */
async function refreshWorld(connection) {
  if (typeof connection?.observe !== "function") return;
  try {
    await connection.observe();
  } catch {
    // A refused observation (e.g. the same revision between two dispatches) leaves the cached state in place:
    // the gate then decides on what is known rather than the replay dying on a read.
  }
}

/**
 * Waits until the world's own clock reaches `recordedInGameTime`, then reports the decision that ended the
 * wait. A clock the harness cannot read is `replay_clock_input_invalid`, never "close enough".
 */
async function awaitRecordedGameTime({ connection, recordedInGameTime, maxWaitMs, pollMs, now, wait, onWait }) {
  const startedAt = now();
  for (;;) {
    const current = currentInGameTime(connection);
    const decision = decideReplayDispatch(recordedInGameTime, current, {
      waitedMs: now() - startedAt,
      maxWaitMs,
    });
    if (decision.decision !== "wait") return decision;
    if (onWait !== undefined) onWait({ recordedInGameTime, current, gapGameMinutes: decision.gapGameMinutes });
    await wait(pollMs);
  }
}

/**
 * Replays `actionTrace[0..turn)` against a live connection.
 *
 * `connection.execute(request)` is the same bridge call the original run made, so the dispatch is
 * byte-comparable with the trace entry; `connection.state.snapshot` supplies the clock. Injection of the
 * turn's own failure is the CALLER's job (the scenario layer): this engine's contract ends at "the world
 * is back at the failing step".
 */
export async function replayActionTrace({
  connection,
  actionTrace,
  turn,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  maxClockWaitMs = DEFAULT_CLOCK_WAIT_MS,
  pollMs = 1_000,
  now = () => Date.now(),
  // The connection's own wait drives the pause when it has one (a session that already polls the world has
  // its own cadence); a plain sleep is the fallback.
  wait = null,
  onStep = () => {},
  onClockWait = () => {},
} = {}) {
  const pause = wait ?? (typeof connection?.wait === "function" ? connection.wait.bind(connection) : sleep);
  if (!Array.isArray(actionTrace))
    return Object.freeze({ state: "blocked", reasonCode: "replay_trace_invalid", steps: [] });
  if (!Number.isInteger(turn) || turn < 0 || turn > actionTrace.length) {
    return Object.freeze({ state: "blocked", reasonCode: "replay_turn_out_of_range", steps: [] });
  }
  const replayed = actionTrace.slice(0, turn);
  const budget = expectedReplayWallClockMs(replayed);
  const steps = [];
  for (const [index, entry] of replayed.entries()) {
    if (typeof entry?.action !== "string" || entry.action.length === 0) {
      return Object.freeze({ state: "blocked", reasonCode: "replay_step_action_missing", steps });
    }
    // Read the world before the gate and before the dispatch, the way an action dispatch must.
    //
    // `expectedRevision` is what makes a request admissible: the Mod refuses a stale snapshot, and the Host
    // validates the field too. Without this the replay could not re-enter a real world at all - the published
    // "way back" was a command that would be refused (`stale_snapshot`), which is exactly the gap a live run
    // exposed (2026-10-17). One observation serves both the clock gate and the revision.
    await refreshWorld(connection);
    const clock = await awaitRecordedGameTime({
      connection,
      recordedInGameTime: entry.inGameTime,
      maxWaitMs: maxClockWaitMs,
      pollMs,
      now,
      wait: pause,
      onWait: onClockWait,
    });
    if (clock.decision !== "dispatch") {
      // The gate's own answer is part of the replay record: a blocked replay must show WHICH step could not be
      // repositioned and why, not just a reason code at the end.
      const step = Object.freeze({
        index,
        phase: "clock",
        state: "blocked",
        reasonCode: clock.reasonCode,
        requestId: entry.requestId,
        action: entry.action,
        inGameTime: entry.inGameTime,
      });
      steps.push(step);
      onStep(step);
      return Object.freeze({ state: "blocked", reasonCode: clock.reasonCode, step: index, steps });
    }
    const revision = connection?.state?.snapshot?.revision;
    const request = Object.freeze({
      requestId: entry.requestId,
      action: entry.action,
      args: entry.args,
      // The world's own revision, and a deadline inside the action's own budget: both are what the Mod's
      // `IsFreshExecutionRequest` checks, so a replayed request is admissible for the same reasons a live one is.
      ...(Number.isSafeInteger(revision) ? { expectedRevision: revision } : {}),
      deadlineMs: now() + Math.min(stepTimeoutMs, REPLAY_DISPATCH_DEADLINE_MS),
    });
    const startedAt = now();
    let terminal;
    try {
      // Bounded from the outside as well as the inside: a bridge call that never settles must not hold the
      // replay forever, and "no terminal" is its own named outcome rather than an exception.
      terminal = await Promise.race([
        connection.execute(request),
        pause(stepTimeoutMs).then(() => Promise.reject(new Error("replay_step_timeout"))),
      ]);
    } catch (error) {
      const reasonCode =
        String(error?.message ?? error) === "replay_step_timeout" ? "replay_step_timeout" : "replay_step_failed";
      const step = Object.freeze({
        index,
        phase: "execute",
        state: "blocked",
        reasonCode,
        requestId: entry.requestId,
        action: entry.action,
        detail: String(error?.message ?? error).slice(0, 400),
        elapsedMs: now() - startedAt,
      });
      steps.push(step);
      onStep(step);
      return Object.freeze({ state: "blocked", reasonCode, step: index, steps });
    }
    const step = Object.freeze({
      index,
      phase: "settled",
      state: terminal?.state ?? "unknown",
      reasonCode: terminal?.reasonCode ?? null,
      requestId: entry.requestId,
      action: entry.action,
      // The receipt's own record of what the ORIGINAL run saw at this step: a divergence here is how a
      // replay proves it reached a different world, instead of silently continuing to the injected failure.
      originalState: entry.state ?? null,
      originalReasonCode: entry.reasonCode ?? null,
      elapsedMs: now() - startedAt,
    });
    steps.push(step);
    onStep(step);
    if (step.state !== step.originalState) {
      return Object.freeze({
        state: "diverged",
        reasonCode: `replay_step_diverged:${String(index)}:${String(step.originalState)}:${String(step.state)}`,
        step: index,
        steps,
      });
    }
  }
  return Object.freeze({
    state: "reached",
    reasonCode: null,
    step: turn,
    steps,
    replayedSteps: replayed.length,
    plannedWallClockMs: budget === null ? null : budget.totalMs,
  });
}
