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
 * A step that cannot finish is never silent: it is named on its own step in the
 * report - a child that would not stop, a port or pipe still held, or a drain
 * that ran out of budget - so an operator reading a failed exit can act on the
 * name instead of guessing.
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
   * Records the one reflection this runtime root is owed, and runs none of it.
   *
   * It used to run the reflection here, and the reflection is a spawned model call: measured at 8 748 ms against a
   * reachable provider and 4 306 ms against one that rejected the key, on the path where the player is leaving.
   * The step now writes one bounded marker file - the material it reflects on stays complete either way, because
   * the next launch reads the same runtime root - and the reflection runs beside the next launch's shell. It sits
   * here rather than earlier only because it writes to the runtime root both surfaces drained out of.
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
 * The ceiling of every step's own operation as one table: what a caller may supply instead of the
 * declared one, and what `runDesktopHostReclamation` reads per step.
 */
export type DesktopHostReclamationStepBounds = Readonly<Record<DesktopHostReclamationStep, number>>;

/**
 * What one reclamation step is trying to give up, which is what its failure has
 * to name.
 *
 * A step never fails in the abstract: it fails because a child it drives will
 * not stop (`child`), because a resource it holds - the presentation listener's
 * port, the Guardian or Voice pipe - will not be released (`resource`), or for a
 * reason of its own (`other`, which keeps whatever bounded code it reported).
 * The kind is declared once per step and pinned by a focused test, so an exit an
 * operator reads afterwards says which of those happened instead of a bare
 * generic code.
 */
export type DesktopHostReclamationStepKind = "child" | "resource" | "other";

export const DESKTOP_HOST_RECLAMATION_STEP_KIND: Readonly<
  Record<DesktopHostReclamationStep, DesktopHostReclamationStepKind>
> = Object.freeze({
  /** Releases the presentation listener's port. */
  stop_admission: "resource",
  /** Settles in-flight Chat turns. */
  drain_chat_runtime: "child",
  /** Settles in-flight Game work and contains the AI role through its Job Object. */
  drain_game_lifecycle: "child",
  reflect_session: "other",
  release_shared_authority: "other",
  /** Releases the authenticated Guardian pipe. */
  release_guardian_session: "resource",
  /** Releases the optional Voice client's socket to the Voice Gateway. */
  release_voice_client: "resource",
  release_termination_watchers: "other",
});

/**
 * `not_applicable` is a DECLARED absence - this launch never had that resource -
 * and is therefore never reported as a silent skip or as a success.
 */
type DesktopHostReclamationStatus = "completed" | "failed" | "not_applicable";

/**
 * The named ways a reclamation step can fail, each a stable snake_case reason
 * reported together with the step it belongs to.
 *
 * Naming them is the whole point. A step that could not give something up used
 * to read either as a bare generic code or as `completed`, so an operator could
 * not tell a child that refused to stop from a port that was still bound, and a
 * drain that ran out of budget looked like no failure at all. Every one of these
 * is a fact about the STEP it is attached to, never a message, a path or a
 * stack.
 */
export const DESKTOP_HOST_CHILD_WILL_NOT_STOP_FAILURE = "desktop_host_child_will_not_stop";
export const DESKTOP_HOST_RESOURCE_STILL_HELD_FAILURE = "desktop_host_resource_still_held";

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
 * The name a step's failure keeps when nothing more specific can be said about
 * it: a step that did not name itself and owns neither a child nor a resource
 * an operator can act on.
 */
export const DESKTOP_HOST_CLOSE_STEP_FAILED = "desktop_host_close_step_failed";

/**
 * What a step that owns no budgeted operation may spend: twice the largest such close measured on
 * a real exit.
 *
 * The largest of them is the Chat drain's 90 ms (`5ccd00b8`, a real mounted authority with a
 * generating turn: the ledger ends `cancelled` and both texts are kept). Measured beside it, the
 * same way, were the presentation listener's close at 0.4 ms, a real WAL database's close at
 * 1.2 ms, the Guardian socket's destroy at 0.1 ms, the Voice socket's at 0.7 ms and the watcher
 * dispose at 0.03 ms. The multiple is the headroom: a step whose close is that many times slower
 * than the machine it was measured on is no longer a close that is merely slow.
 */
const DESKTOP_HOST_ORDINARY_STEP_BOUND_MS = 90 * 2;

/**
 * What `drain_game_lifecycle` may spend: the LONGEST single operation its close can still be waiting on.
 *
 * It used to be 600 s because an ordinary close awaited an in-flight `game.create`/`game.resume` to the end of its
 * join, and that join's deadline is `min(session expiry, now + Farmhand join budget)`, capped at ten minutes by the
 * browser admission lease. The exit now ASKS both attempts to stop before it joins them - the create's own cancel
 * epoch and the resume's - so each one ends at its next safe point and the join is left waiting on one operation, not
 * on the join:
 *
 * - the create's cabin handoff admission, `min(60_000, expiresAt - now)`: the one await no cancel epoch can reach
 *   (`stardew-private-bootstrap-composer.core.internal.ts`, `confirmAndAdmit`);
 * - one authenticated bridge connect attempt, `STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS` (45 s), which used to be
 *   handed the whole join;
 * - one runtime operation of the composition, `DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS` (60 s), and the contained
 *   Player Host role launch, `STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS` (60 s).
 *
 * The largest of them is 60 s, and a bound below any of them would name a step that is legitimately inside its own
 * bounded work as failed - which is the false failure this table exists to prevent.
 */
const DESKTOP_HOST_GAME_STEP_BOUND_MS = 60_000;

/**
 * What each reclamation step may spend before the exit NAMES it as a failed drain.
 *
 * A bound is the ceiling of the operation its step can be waiting on, never a latency
 * target: a bound below that operation names a step that is legitimately inside its own
 * bounded work as failed, which abandons work the product still owns - a false failure on
 * the path where the player is leaving. The whole-exit deadline is the SUM of these, so
 * no step can believe it has more time than the launcher will wait for all of them
 * together, and no step's ceiling is spent eight times over.
 *
 * `desktop-host-reclamation-budget.test.ts` holds the invariant per step: every operation
 * a step can be waiting on is named there with the number its owner publishes, so a step
 * that grows a five-minute call - or a new step that waits on anything - reddens a gate
 * instead of quietly spending the exit's whole deadline.
 */
export const DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS: DesktopHostReclamationStepBounds = Object.freeze({
  /** Releases the presentation listener's port: measured 0.4 ms for the close of a served listener. */
  stop_admission: DESKTOP_HOST_ORDINARY_STEP_BOUND_MS,
  /** Ends the turn it was generating and releases the mounted lane: measured 90 ms on a real exit. */
  drain_chat_runtime: DESKTOP_HOST_ORDINARY_STEP_BOUND_MS,
  /**
   * The one step that waits on budgeted operations: the Guardian arm/contain/close acknowledgement
   * (`DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS`, 60 s) and, because an ordinary close still joins the attempt it has
   * asked to stop, the ONE operation that attempt can still be inside (60 s at most).
   */
  drain_game_lifecycle: DESKTOP_HOST_GAME_STEP_BOUND_MS,
  /** Writes the one marker this runtime root is owed: measured 3 ms. */
  reflect_session: DESKTOP_HOST_ORDINARY_STEP_BOUND_MS,
  /** Closes the durable semantic authority: measured 1.2 ms for a real WAL database's close. */
  release_shared_authority: DESKTOP_HOST_ORDINARY_STEP_BOUND_MS,
  /** Destroys the authenticated Guardian socket: measured 0.1 ms, and it never waits for the native Guardian. */
  release_guardian_session: DESKTOP_HOST_ORDINARY_STEP_BOUND_MS,
  /** Destroys the optional Voice client's socket: measured 0.7 ms. */
  release_voice_client: DESKTOP_HOST_ORDINARY_STEP_BOUND_MS,
  /** Disposes this process's own watchers: measured 0.03 ms, and it is synchronous. */
  release_termination_watchers: DESKTOP_HOST_ORDINARY_STEP_BOUND_MS,
});

/**
 * How long the WHOLE reclamation may take: what the Desktop launcher waits for this process to
 * leave before it treats the process as hung and terminates it.
 *
 * It is the sum of the declared per-step bounds - a step's ceiling counted once, which is what
 * the sequence can actually cost: every step runs once, and a step that outlives its own bound is
 * abandoned and named there, so the steps behind it start inside their own bound.
 *
 * The launcher does not keep its own copy - the entry publishes this value in the bootstrap
 * acknowledgement it already writes (`drainDeadlineMs`,
 * `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`) and the Desktop reads it there
 * (`desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`, `CloseAsync`: the one place that waits, and
 * the watch whose expiry names `host_teardown_timeout`).
 */
export const DESKTOP_HOST_DRAIN_DEADLINE_MS = DESKTOP_HOST_RECLAMATION_STEPS.reduce(
  (total, step) => total + DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS[step],
  0,
);

/**
 * The point at which the Host has already named a step as stuck if the step it is inside is an
 * ordinary one: the smallest bound in the table.
 *
 * It is published beside the whole-exit deadline (`stepHangDeadlineMs`) because it is the only
 * number that says "this quit is no longer normal": the Desktop shell shows its second closing
 * copy - the one that says the app is still finishing - from this point, and it reads the number
 * from the Host rather than keeping a second one.
 */
export const DESKTOP_HOST_STEP_HANG_DEADLINE_MS = Math.min(
  ...DESKTOP_HOST_RECLAMATION_STEPS.map((step) => DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS[step]),
);

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
  return boundedToken.test(message) ? message : DESKTOP_HOST_CLOSE_STEP_FAILED;
}

/**
 * How one reclamation step settled: the one way it can succeed and the three
 * ways it can fail. This is the FACT the naming decision below reads, kept
 * separate from it so the decision stays pure and testable without a game.
 */
export type DesktopHostReclamationStepSettlement =
  | Readonly<{ outcome: "completed" }>
  | Readonly<{ outcome: "rejected"; error: unknown }>
  | Readonly<{ outcome: "timed_out" }>;

/**
 * Names one step's failure from the facts of how it settled, or null when it
 * completed. Pure: nothing here touches a child, a port or a clock.
 *
 * The order is the product's. A step that never settled is a drain timeout no
 * matter what it owned. A step that settled by refusing keeps its own bounded
 * code when it has one, because an operator matches on those codes; otherwise
 * it is named by what it owned - a child that would not stop, or a port/pipe
 * that is still held - and only a step with neither falls back to the generic
 * code.
 */
export function nameDesktopHostReclamationFailure(
  step: DesktopHostReclamationStep,
  settlement: DesktopHostReclamationStepSettlement,
): string | null {
  if (settlement.outcome === "completed") return null;
  if (settlement.outcome === "timed_out") return DESKTOP_HOST_DRAIN_TIMEOUT_FAILURE;
  const code = boundedReclamationCode(settlement.error);
  if (code !== DESKTOP_HOST_CLOSE_STEP_FAILED) return code;
  const kind = DESKTOP_HOST_RECLAMATION_STEP_KIND[step];
  if (kind === "child") return DESKTOP_HOST_CHILD_WILL_NOT_STOP_FAILURE;
  if (kind === "resource") return DESKTOP_HOST_RESOURCE_STILL_HELD_FAILURE;
  return code;
}

/**
 * Runs every step in the given order, attempting all of them under each step's own bound, and
 * reports each outcome.
 *
 * The bounds are a parameter rather than read straight from the table so a focused test can drive
 * a table short enough that a step which never settles is named instead of hanging the suite;
 * every production caller keeps the declared table.
 */
export async function runDesktopHostReclamation(
  operations: readonly DesktopHostReclamationOperation[],
  bounds: DesktopHostReclamationStepBounds = DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS,
): Promise<readonly DesktopHostReclamationStepOutcome[]> {
  const outcomes: DesktopHostReclamationStepOutcome[] = [];
  for (const operation of operations) {
    const close = operation.close;
    if (close === undefined) {
      outcomes.push(Object.freeze({ step: operation.step, status: "not_applicable", failure: null }));
      continue;
    }
    const failure = await runDesktopHostReclamationStep(operation.step, close, bounds[operation.step]);
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
 * The value the drain budget rejects with: a private symbol rather than an
 * `Error`, so a step that closes by rejecting with the timeout's own code keeps
 * its own code and only the budget this module set can mean the drain expired.
 */
const DESKTOP_HOST_DRAIN_EXPIRED = Symbol("desktop_host_drain_expired");

/**
 * One step under its drain budget: the named failure, or null when the step
 * completed.
 *
 * A step that has not settled inside its budget is abandoned and named, so the
 * timeouts of the steps behind it start instead of waiting behind a step nothing
 * else will end. The abandoned close is left running with its rejection observed:
 * it has already outlived its step, and an unobserved rejection out of it would
 * become an unhandled rejection that kills this process before the exit record
 * the timeout exists to complete has been written.
 */
async function runDesktopHostReclamationStep(
  step: DesktopHostReclamationStep,
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
          reject(DESKTOP_HOST_DRAIN_EXPIRED);
        }, drainTimeoutMs);
      }),
    ]);
    return nameDesktopHostReclamationFailure(step, { outcome: "completed" });
  } catch (error) {
    return nameDesktopHostReclamationFailure(
      step,
      error === DESKTOP_HOST_DRAIN_EXPIRED ? { outcome: "timed_out" } : { outcome: "rejected", error },
    );
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
