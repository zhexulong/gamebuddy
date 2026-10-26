/**
 * When does a submitted plan stop being news?
 *
 * `stardew_action_program_status` used to answer that only by being polled, and `plan_work` returns immediately, so
 * a model that wanted to know had one option: ask again. Measured on the 2026-10-26 run, 48 calls at a p50 gap of
 * 6,365 ms and a max of 34,918 ms - each gap a whole model turn spent learning nothing.
 *
 * The facts a wait needs are already published, so this module adds no state and no authority: it reads the same
 * `program_status` payload the tool already reads, and it never invents a finished state. On expiry the caller gets
 * the last real snapshot plus `reachedTerminal: false`, which is the honest answer to "did it finish while I waited".
 */

/** The only non-terminal program state (`BodyProgramState`, `BodyProgramModels.cs:144`). */
const ACTIVE_PROGRAM_STATE = "active";

/**
 * How often a waiting call re-reads. The bridge round-trip this rides on is cheap; the cost being avoided is a model
 * turn between polls, not a network hop.
 */
export const PROGRAM_STATUS_POLL_INTERVAL_MS = 250;

/**
 * The largest wait a caller may ask for.
 *
 * Bounded on purpose: a tool call that can block for as long as a caller names is a hang waiting to happen, and the
 * plan this waits on has its own action-scoped watchdogs. Thirty seconds covers a multi-node farm batch comfortably
 * and stays inside a single tool turn.
 */
export const MAX_PROGRAM_STATUS_WAIT_MS = 30_000;

export interface ProgramStatusWaitOutcome<TResult> {
  readonly result: TResult;
  readonly waited: Readonly<{ reachedTerminal: boolean }>;
}

/**
 * Is this `program_status` payload finished?
 *
 * `active` is the only state that is still going. Everything else - `succeeded`, `failed`, `cancelled`,
 * `recovery_required`, `quarantined` - has stopped for good. `recovery_required` and `quarantined` especially: a plan
 * that will never run again is exactly what a waiting caller needs told, and treating it as "still running" is how a
 * poller waits for news that cannot come.
 *
 * `not_found` counts as finished for the same reason: there is no longer anything to wait for, and the answer does
 * not change by asking again. `invalid_input` does not - that is a caller error, not a plan state, and the read that
 * produced it will keep producing it, so the loop must not spin on it.
 */
export function isTerminalProgramStatus(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  if (record.code === "not_found") return true;
  if (record.code !== "found") return false;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  return (snapshot as Record<string, unknown>).state !== ACTIVE_PROGRAM_STATE;
}

/**
 * Poll until the plan stops or the wait expires, then return the LAST read either way.
 *
 * The first read is the caller's own, so a plan that already finished costs exactly one round-trip - the same cost
 * as before this existed.
 */
export async function waitForTerminalProgramStatus<TResult>(
  read: () => Promise<TResult>,
  waitMs: number,
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): Promise<ProgramStatusWaitOutcome<TResult>> {
  const bounded = Math.max(0, Math.min(MAX_PROGRAM_STATUS_WAIT_MS, Math.trunc(waitMs)));
  const deadline = now() + bounded;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0)
      return Object.freeze({ result: await read(), waited: Object.freeze({ reachedTerminal: false }) });
    await sleep(Math.min(remaining, PROGRAM_STATUS_POLL_INTERVAL_MS));
    const result = await read();
    if (isTerminalProgramStatus(result))
      return Object.freeze({ result, waited: Object.freeze({ reachedTerminal: true }) });
    if (now() >= deadline) return Object.freeze({ result, waited: Object.freeze({ reachedTerminal: false }) });
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
