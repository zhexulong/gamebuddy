/**
 * The one wait a launch makes before it may touch the fixture root: no game process, no transaction held.
 *
 * A run only starts on a free root. A run that starts while another lane holds the lock has its own transaction
 * overwritten mid-flight and loses its restore, so this waits instead of racing.
 *
 * Three bounds, and a LINE on every heartbeat, because the failure this replaces was not the waiting - it was the
 * silence. Measured 2026-11-21 (`round87b`): a launch sat at 0% CPU with no phase file, no child process and no
 * output, was read as hung for seven minutes, and the operator went looking for a file to delete rather than for the
 * lock the run was waiting on. A process that says nothing about what it is waiting for is indistinguishable from a
 * stuck one, so every iteration of this wait prints the lock's path, its holder, its age and what happens next:
 *
 *   - `heartbeatMs` is how often that line is printed. It is not a timeout: the wait continues after it.
 *   - `orphanIdleMs` is how long a held transaction may sit with NO game process alive before it is renamed aside.
 *     The holder must be dead for that to happen at all - a live game keeps its lock, because clearing a live lock is
 *     `Clean` on another lane's work in file form, not recovery.
 *   - `deadlineMs` is how long the wait is allowed to be a wait, and it is the same 45 minutes the inline version this
 *     module replaced honoured. The goal is a wait that says why, never a shorter one that turns a hang into a
 *     failure with a smaller number on it.
 *
 * The holder is read, not guessed: the transaction's own record names it (`transaction.json.ownerId`), and a lock
 * whose record cannot be read is reported as unreadable rather than as nobody. Live game processes are named by pid.
 */
import { existsSync, renameSync, statSync } from "node:fs";

export const FIXTURE_WAIT = Object.freeze({
  heartbeatMs: 30_000,
  orphanIdleMs: 3 * 60_000,
  deadlineMs: 45 * 60_000,
});

const seconds = (ms) => `${String(Math.max(0, Math.round(ms / 1000)))}s`;

/**
 * Who holds the lock, as far as it can be read: the transaction's own record, and the game processes alive now.
 *
 * Both are printed when both are known - the record names the run that wrote the transaction, and a game may be the
 * process actually keeping the files under it open. Neither is guessed from the other, and neither is inferred from the
 * FILE: a lock whose record cannot be read names nobody, which is a fact to print rather than to paper over.
 */
function holderOf({ gamePids, ownerId }) {
  const parts = [];
  if (ownerId !== null && ownerId !== undefined) parts.push(`transaction:${String(ownerId)}`);
  if (gamePids.length > 0) parts.push(`game_pid:${gamePids.join(",")}`);
  return parts.length === 0 ? "unreadable_transaction_record" : parts.join("+");
}

/**
 * What the wait intends to do next, in the vocabulary of this module.
 *
 * A live game is never reclaimed from under: that is the whole reason the idle branch requires `gamePids` to be empty.
 */
function nextStepOf({ gamePids, idleMs, orphanIdleMs }) {
  if (gamePids.length > 0) return "wait_for_the_game_process_that_holds_it_to_exit";
  if (idleMs > orphanIdleMs) return "rename_the_held_transaction_aside";
  return `rename_the_held_transaction_aside_after_${seconds(orphanIdleMs - idleMs)}_more_idle`;
}

/** The heartbeat: every fact an operator needs to stop looking for a file to delete. */
export function fixtureWaitLine({ lockPath, gamePids, ownerId, ageMs, nextStep, deadlineInMs }) {
  return [
    "[wait] fixture busy",
    `waiting_for=${lockPath}`,
    `held_by=${holderOf({ gamePids, ownerId })}`,
    `age=${seconds(ageMs)}`,
    `next_step=${nextStep}`,
    `deadline_in=${seconds(deadlineInMs)}`,
  ].join(" \u00b7 ");
}

/**
 * Waits until the fixture root holds no game process and no transaction, or reclaims a provably dead one.
 *
 * `state: "free"` - nothing is held; `state: "reclaimed"` - a held transaction with no game process alive was idle
 * past `orphanIdleMs` and was RENAMED ASIDE (never deleted: it is a killed run's only fork point), and `aside` is
 * where. Expiry is a named refusal, not a silent return: the message carries the path, the holder and the age, so the
 * operator reads the condition instead of a bare `timeout`.
 */
export async function waitForFixtureRootFree({
  lockPath,
  gameProcessIds,
  ownerId = () => null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (line) => console.log(line),
  now = Date.now,
  bounds = FIXTURE_WAIT,
}) {
  const startedAtMs = now();
  const deadlineAtMs = startedAtMs + bounds.deadlineMs;
  for (;;) {
    const gamePids = gameProcessIds();
    const locked = existsSync(lockPath);
    const ageMs = locked ? now() - statSync(lockPath).mtimeMs : 0;
    if (gamePids.length === 0 && !locked) return Object.freeze({ state: "free", lockPath, aside: null });
    if (gamePids.length === 0 && locked && ageMs > bounds.orphanIdleMs) {
      const aside = `${lockPath}.orphaned-${now()}`;
      const owner = ownerId();
      renameSync(lockPath, aside);
      log(
        `[recover] orphaned fixture transaction renamed aside: ${aside} \u00b7 ` +
          `held_by=${holderOf({ gamePids, ownerId: owner })} \u00b7 ` +
          `age=${seconds(ageMs)} \u00b7 no_game_process_alive`,
      );
      return Object.freeze({ state: "reclaimed", lockPath, aside });
    }
    if (now() >= deadlineAtMs)
      throw new Error(
        `fixture_never_became_free:${lockPath}:held_by=${holderOf({ gamePids, ownerId: locked ? ownerId() : null })}:` +
          `age=${seconds(ageMs)}:waited=${seconds(now() - startedAtMs)}`,
      );
    log(
      fixtureWaitLine({
        lockPath,
        gamePids,
        ownerId: locked ? ownerId() : null,
        ageMs,
        nextStep: nextStepOf({ gamePids, idleMs: ageMs, orphanIdleMs: bounds.orphanIdleMs }),
        deadlineInMs: deadlineAtMs - now(),
      }),
    );
    await sleep(bounds.heartbeatMs);
  }
}
