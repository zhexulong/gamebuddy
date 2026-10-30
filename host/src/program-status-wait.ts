/**
 * When does a submitted plan stop being news?
 *
 * `stardew_action_program_status` used to answer that only by being polled, and `plan_work` returns immediately, so
 * a model that wanted to know had one option: ask again. Measured on the 2026-10-26 run, 48 calls at a p50 gap of
 * 6,365 ms and a max of 34,918 ms - each gap a whole model turn spent learning nothing.
 *
 * The facts a wait needs are already published, so this module adds no state and no authority: it reads the same
 * `program_status` payload the tool already reads, and it never invents a finished state. On expiry the caller gets
 * the last real snapshot plus `reachedTerminal: false`.
 *
 * "It did not finish" alone is not an answer a caller can act on. The wait re-reads the live journal every interval
 * (`PROGRAM_STATUS_POLL_INTERVAL_MS`), so it already knows whether the journal published anything at all while it
 * held the turn. Measured 2026-10-28 (`round4`): 84 `program_status` calls blocked 459 s, seven of them the full 30 s
 * bound, and in six of those the snapshot handed back was identical to the one the caller already had - four
 * consecutive 30 s waits on `plan_273` all returned `eventHighWater: 288` with `n03` running. Reporting that
 * re-ask-would-tell-you-nothing fact is `snapshotChanged`.
 */

/** The only non-terminal program state (`BodyProgramState`, `BodyProgramModels.cs:144`). */
const ACTIVE_PROGRAM_STATE = "active";

/**
 * How often a waiting call re-reads. The bridge round-trip this rides on is cheap; the cost being avoided is a model
 * turn between polls, not a network hop.
 */
const PROGRAM_STATUS_POLL_INTERVAL_MS = 250;

/**
 * The largest wait a caller may ask for.
 *
 * Bounded on purpose: a tool call that can block for as long as a caller names is a hang waiting to happen, and the
 * plan this waits on has its own action-scoped watchdogs. Thirty seconds covers a multi-node farm batch comfortably
 * and stays inside a single tool turn.
 */
export const MAX_PROGRAM_STATUS_WAIT_MS = 30_000;

/**
 * What the wait itself saw, BESIDE the payload it returned last.
 *
 * `reachedTerminal` is the one the wait was built for. `snapshotChanged` is what makes an expired wait actionable: a
 * caller told only "still running" cannot tell a long node from a plan that published nothing for thirty seconds, and
 * the measured answer to that is to ask again and pay the same bound once more.
 */
export interface ProgramStatusWaitOutcome<TResult> {
  readonly result: TResult;
  readonly waited: Readonly<{ reachedTerminal: boolean; snapshotChanged: boolean }>;
}

/**
 * How many consecutive polls with an unchanged snapshot end a wait early.
 *
 * An expired wait is the expensive outcome, and it is usually the predictable one: measured 2026-10-30, a 32-minute run
 * issued **82 `program_status` calls with `waitMs` set, 2,084 s of requested waiting (34.7 min), and only 21 of them
 * (26%) reached a terminal state**. The model had learned to wait instead of polling and then treated the wait as work.
 *
 * The wait already knows whether anything happened - `snapshotChanged` is that fact - so spending the remaining bound
 * after several polls have seen nothing is spending the model's turn on news that cannot arrive. Two polls at the
 * 250 ms interval is half a second of ``no change`` while the caller's own bound may be thirty seconds.
 *
 * The interval, not the bound, is what makes this safe: the journal publishes a node event per game-thread action, so a
 * plan that is DOING anything differs within a second. A plan still waiting on its first admission can stay identical
 * for longer, which is why the threshold is not one poll - the admitting Mod answers within a frame or not at all.
 */
const UNCHANGED_POLLS_BEFORE_EARLY_RETURN = 8;

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
 * `first` is the caller's own read, which it already made; the wait starts from it rather than repeating it, so a plan
 * that finished before the wait began costs nothing extra and every later comparison is against what the caller was
 * actually told.
 */
export async function waitForTerminalProgramStatus<TResult>(
  read: () => Promise<TResult>,
  first: TResult,
  waitMs: number,
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = defaultSleep,
): Promise<ProgramStatusWaitOutcome<TResult>> {
  const bounded = Math.max(0, Math.min(MAX_PROGRAM_STATUS_WAIT_MS, Math.trunc(waitMs)));
  const deadline = now() + bounded;
  let previous = first;
  let snapshotChanged = false;
  let unchangedPolls = 0;
  const settle = (result: TResult, reachedTerminal: boolean) =>
    Object.freeze({ result, waited: Object.freeze({ reachedTerminal, snapshotChanged }) });
  // Every read passes through here, so the expiry read counts the same as any other: a plan that moved on the last
  // poll before the deadline is a plan that moved, and saying otherwise is the blindness this reports on.
  const readOnce = async (): Promise<TResult> => {
    const result = await read();
    if (programSnapshot(result) !== programSnapshot(previous)) {
      snapshotChanged = true;
      unchangedPolls = 0;
    } else {
      unchangedPolls++;
    }
    previous = result;
    return result;
  };
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) return settle(await readOnce(), false);
    // Nothing has moved for a while: hand back what is known NOW rather than what will still be known at the deadline.
    // `snapshotChanged` tells the caller the same thing it would have told it thirty seconds later, and the run keeps
    // its turn. The read is fresh, so the caller never receives a stale payload for this decision.
    if (unchangedPolls >= UNCHANGED_POLLS_BEFORE_EARLY_RETURN) return settle(await readOnce(), false);
    await sleep(Math.min(remaining, PROGRAM_STATUS_POLL_INTERVAL_MS));
    const result = await readOnce();
    if (isTerminalProgramStatus(result)) return settle(result, true);
    if (now() >= deadline) return settle(result, false);
  }
}

/**
 * The part of a `program_status` payload that is about THIS program.
 *
 * `eventHighWater` is deliberately left out: it is the journal-wide cursor (`BodyProgramJournalState.EventHighWater`),
 * so another program's node would make two reads differ while this one stood still. What a caller waiting on one plan
 * needs is that plan's own state and nodes, compared textually - the Mod's serialization has a fixed field order, so
 * the Mod's value and this string are the same fact.
 */
function programSnapshot(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return `${String(record.code)}|`;
  const program = snapshot as Record<string, unknown>;
  return `${String(record.code)}|${String(program.state)}|${JSON.stringify(program.nodes ?? null)}`;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
