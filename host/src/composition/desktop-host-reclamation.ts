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

/** Runs every step in the given order, attempting all of them, and reports each outcome. */
export async function runDesktopHostReclamation(
  operations: readonly DesktopHostReclamationOperation[],
): Promise<readonly DesktopHostReclamationStepOutcome[]> {
  const outcomes: DesktopHostReclamationStepOutcome[] = [];
  for (const operation of operations) {
    const close = operation.close;
    if (close === undefined) {
      outcomes.push(Object.freeze({ step: operation.step, status: "not_applicable", failure: null }));
      continue;
    }
    try {
      await close();
      outcomes.push(Object.freeze({ step: operation.step, status: "completed", failure: null }));
    } catch (error) {
      outcomes.push(Object.freeze({ step: operation.step, status: "failed", failure: boundedReclamationCode(error) }));
    }
  }
  return Object.freeze(outcomes);
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
