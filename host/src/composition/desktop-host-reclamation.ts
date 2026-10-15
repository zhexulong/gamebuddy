/**
 * The Desktop Host process's exit reclamation: the ordered, named steps the
 * composed process runs when it is asked to leave.
 *
 * The step list is declared once, here, because two owners run it - the
 * composition reports the steps its own children and the authenticated
 * Guardian session are, and the fixed bootstrap entry reports the two it owns
 * (the optional Voice client and its own termination watchers). Neither side
 * may invent a step name, and a focused test pins the exact frozen order.
 *
 * The order is the product's own reverse-teardown order. `stop_admission` is
 * first because nothing new may enter once the process has decided to leave
 * (the presentation admission is the one listener the app accepts work on);
 * `release_guardian_session` is next to last because every step before it may
 * still need the authenticated session to drive its own containment; the
 * bootstrap's two steps come last because they own no child work.
 *
 * What a step may and may not do is a product rule, not an implementation
 * detail:
 *
 * - A child may only ever be terminated through the identity it was started
 *   with - the exact authenticated Guardian attempt/role and the Job Object
 *   membership established at create time (`PROC_THREAD_ATTRIBUTE_JOB_LIST`),
 *   never a PID scan and never a name match. That membership IS the answer to
 *   "is this process ours".
 * - An ordinary close stops AI authority only. The Player Host and the player's
 *   world are NOT terminated here: they belong to the player, and only the
 *   explicit authenticated endgame ends them. `drain_game_lifecycle` therefore
 *   drains and contains the AI role and leaves the Player's world alive.
 */
export const DESKTOP_HOST_RECLAMATION_STEPS = Object.freeze([
  /** Stop accepting new work and release the presentation listener's port. */
  "stop_admission",
  /** Let in-flight Chat turns settle. */
  "drain_chat_runtime",
  /** Settle in-flight Game work, contain the AI role through its Job Object, release the bridge/control pipes. */
  "drain_game_lifecycle",
  /**
   * One reflection on the session that just ended, per owner ruling E.
   *
   * It sits after both surfaces have drained - the material it reads is only complete once their turns have
   * settled - and before the shared semantic authority closes, because it writes an ordinary memory row through
   * that authority. It is bounded and fails closed: a reflection that cannot run leaves nothing behind and never
   * delays or fails the exit it belongs to.
   */
  "reflect_session",
  /** Close the durable semantic authority. */
  "release_shared_authority",
  /** Close the authenticated Guardian pipe; the native Guardian then exits on control EOF. */
  "release_guardian_session",
  /** Close the optional Voice client's socket to the Voice Gateway. */
  "release_voice_client",
  /** Dispose this process's own termination watchers so it can exit. */
  "release_termination_watchers",
] as const);

export type DesktopHostReclamationStep = (typeof DESKTOP_HOST_RECLAMATION_STEPS)[number];

/**
 * `not_applicable` is a DECLARED absence - this launch never had that resource -
 * and is therefore never reported as a silent skip or as a success.
 */
export type DesktopHostReclamationStatus = "completed" | "failed" | "not_applicable";

/**
 * The one name a step gets when it did not settle inside its drain budget.
 *
 * A step that never settles is the exit outcome that used to leave nothing
 * behind at all: the reclamation awaited it, so neither the exit report nor the
 * record an operator reads afterwards was ever produced. Naming it makes that
 * wait a findable fact on the step it belongs to, and the reclamation still runs
 * the steps behind it - a step that cannot finish must not keep them from trying.
 */
export const DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE = "desktop_host_drain_timeout";

/**
 * How long one reclamation step may take before it is NAMED as a failed drain.
 *
 * This is a hang detector, not a latency budget. A step is a sequence of
 * operations that are each bounded elsewhere - containing the AI role through its
 * Job Object, joining an in-flight endgame, releasing the presentation port - so
 * a legitimately slow step settles well inside this. It is deliberately far
 * above the per-operation waits those steps use (a minute for a Guardian
 * operation), because naming a step that is still making progress as failed would
 * abandon work the product still owns.
 */
export const DESKTOP_HOST_DRAIN_TIMEOUT_MS = 300_000;

export type DesktopHostReclamationStepOutcome = Readonly<{
  step: DesktopHostReclamationStep;
  status: DesktopHostReclamationStatus;
  /** The bounded code from the step's own error, or null. Never a message, path or stack. */
  failure: string | null;
}>;

export type DesktopHostExitReason = Readonly<{
  schema: "gamebuddy-desktop-host-exit/v1";
  outcome: "clean" | "incomplete";
  /** `clean_exit`, or the first failed step's bounded failure code. */
  reason: string;
  steps: readonly DesktopHostReclamationStepOutcome[];
}>;

export type DesktopHostReclamationOperation = Readonly<{
  step: DesktopHostReclamationStep;
  /** Absent means this launch never had the resource: the step reports `not_applicable`. */
  close?: () => Promise<void>;
}>;

/** The one shape a reason or failure may have: a bounded lowercase code. */
const boundedToken = /^[a-z][a-z0-9_.:-]{1,159}$/;

/**
 * Reduces one step's error to a bounded code.
 *
 * The error is the only place a path, a bridge credential or player text could
 * reach the exit report, so only a message that already has the shape of one of
 * the project's lowercase codes is kept; everything else becomes the step's own
 * generic code. A stack is never read.
 */
export function boundedReclamationCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return boundedToken.test(message) ? message : "desktop_host_close_step_failed";
}

/**
 * Runs every step in the given order, attempting all of them under the drain
 * budget, and reports each outcome. The budget is a parameter rather than a
 * module constant so a focused test can drive a step that outlives it; every
 * production caller passes `DESKTOP_HOST_DRAIN_TIMEOUT_MS`.
 */
export async function runDesktopHostReclamation(
  operations: readonly DesktopHostReclamationOperation[],
  drainTimeoutMs: number,
): Promise<readonly DesktopHostReclamationStepOutcome[]> {
  const outcomes: DesktopHostReclamationStepOutcome[] = [];
  for (const operation of operations) {
    const close = operation.close;
    if (close === undefined) {
      outcomes.push(Object.freeze({ step: operation.step, status: "not_applicable", failure: null }));
      continue;
    }
    const failure = await runDesktopHostReclamationStep(close, drainTimeoutMs);
    outcomes.push(
      Object.freeze({
        step: operation.step,
        status: failure === null ? "completed" : "failed",
        failure,
      }),
    );
  }
  return Object.freeze(outcomes);
}

/**
 * One step under its drain budget: the bounded failure code, or null when the
 * step completed.
 *
 * A step that has not settled inside its budget is abandoned and named, so the
 * timeouts of the steps behind it start instead of waiting behind a step nothing
 * else will end. The abandoned close is left running with its rejection observed:
 * it has already outlived its step, and an unobserved rejection out of it would
 * become an unhandled rejection that kills this process before the exit record
 * the timeout exists to complete has been written.
 */
async function runDesktopHostReclamationStep(
  close: () => Promise<void>,
  drainTimeoutMs: number,
): Promise<string | null> {
  // A close that throws synchronously is one failure of this step like any other,
  // so it is a rejected promise here rather than a throw that would skip the
  // steps behind it.
  const closeAttempt = (async (): Promise<void> => {
    await close();
  })();
  closeAttempt.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closeAttempt,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE));
        }, drainTimeoutMs);
      }),
    ]);
    return null;
  } catch (error) {
    return boundedReclamationCode(error);
  } finally {
    // The budget timer is the one handle this module must never leak: a live
    // 300s timer would keep the process up for the rest of its budget after the
    // step it belonged to already settled.
    clearTimeout(timer);
  }
}

/** Projects step outcomes to the one report shape. Pure; the caller owns the step order. */
export function buildDesktopHostExitReason(
  outcomes: readonly DesktopHostReclamationStepOutcome[],
): DesktopHostExitReason {
  const failed = outcomes.find((outcome) => outcome.status === "failed");
  return Object.freeze({
    schema: "gamebuddy-desktop-host-exit/v1",
    outcome: failed === undefined ? "clean" : "incomplete",
    reason: failed?.failure ?? "clean_exit",
    steps: Object.freeze([...outcomes]),
  });
}
