/**
 * The single derivation of what the roster row offers for choosing a companion, so the control a
 * player is offered and the meanings the Host publishes cannot drift apart.
 *
 * The facts it reads are the ones the product actually distinguishes:
 *
 *  - `isCurrent` - the roster's own mark, projected from the deployment identity's
 *    `companionId`. It is the ONLY definition of "in play" the surface has, and it is injected
 *    rather than recomputed here for exactly that reason.
 *  - `chosenHandle` - the companion whose choice THIS surface recorded (`companion.activate`
 *    answered `status: "recorded"`), waiting for a restart. It is what the row marks as
 *    "chosen" and what the restart sentence names.
 *  - `activationServed` - whether this build serves the route at all. A profile that does not
 *    declare `companion.activate` answers `profile_operation_unavailable`, and a control that
 *    could only fail is a trap: the row withdraws it instead.
 *  - `blockedBySession` - the Host refused with `companion_switch_requires_no_session`, i.e. a
 *    Game session is bound to the companion it started with. The row keeps its control (stopping
 *    the game and pressing again is a step the player can take) and the sentence that goes with
 *    it names that step.
 *
 * The four phases are the whole state machine, and every one of them has a forward action -
 * `companion-activation-controls.test.mjs` enumerates them from this union and fails by name if a
 * phase is added without one. `in_play` has no ACTIVATION control by design: she is already the
 * answer, and the row's own control (the inspector) is the forward action left there.
 *
 * What the Host does NOT offer is a switch, and this module never implies one: `activate` answers
 * `recorded` and nothing else, and `restartRequired` is the sentence that says a restart is what
 * applies the choice.
 */
export type CompanionActivationPhase =
  /** She is not in play and nothing is recorded for her: the row offers the choice. */
  | "offer"
  /** She is the companion in play: the row marks her and offers no choice. */
  | "in_play"
  /** Her choice was recorded and waits for the next start: the row marks her as chosen. */
  | "chosen"
  /** A Game session owns the companion it started with: the row says to stop the game first. */
  | "blocked_by_session"
  /** This build serves no way to choose at all: the row withdraws the control. */
  | "unsupported";

export type CompanionActivationControls = Readonly<{
  phase: CompanionActivationPhase;
  /** Whether the row draws the choice control. */
  chooseOffered: boolean;
  /** Whether the row is visibly marked as the companion in play. */
  markedInPlay: boolean;
  /** Whether the row is marked as chosen for the next start. */
  markedChosen: boolean;
  /** Whether the row must say that a restart is what applies the choice. */
  restartRequired: boolean;
  /** Whether the row must tell the player to stop the game first. */
  stopGameFirst: boolean;
}>;

export function deriveCompanionActivationControls(
  input: Readonly<{
    isCurrent: boolean;
    chosenHandle: string | null;
    handle: string;
    activationServed: boolean;
    blockedBySession: boolean;
  }>,
): CompanionActivationControls {
  // The in-play fact outranks everything: a recorded choice for the companion already in play is
  // the Host's `companion_switch_already_in_play` refusal, which is not a switch and is not a
  // state this surface renders as pending. She is marked, and the row offers no choice.
  if (input.isCurrent) {
    return Object.freeze({
      phase: "in_play" as const,
      chooseOffered: false,
      markedInPlay: true,
      markedChosen: false,
      restartRequired: false,
      stopGameFirst: false,
    });
  }
  if (!input.activationServed) {
    return Object.freeze({
      phase: "unsupported" as const,
      chooseOffered: false,
      markedInPlay: false,
      markedChosen: false,
      restartRequired: false,
      stopGameFirst: false,
    });
  }
  // A refused press leaves the control in place: stopping the game and pressing again is the step
  // the refusal names, so removing the only control that can carry it out would be a dead end.
  if (input.blockedBySession) {
    return Object.freeze({
      phase: "blocked_by_session" as const,
      chooseOffered: true,
      markedInPlay: false,
      markedChosen: false,
      restartRequired: false,
      stopGameFirst: true,
    });
  }
  if (input.chosenHandle === input.handle) {
    return Object.freeze({
      phase: "chosen" as const,
      // Her choice is recorded, so a second press would only rewrite the same request.
      chooseOffered: false,
      markedInPlay: false,
      markedChosen: true,
      restartRequired: true,
      stopGameFirst: false,
    });
  }
  return Object.freeze({
    phase: "offer" as const,
    chooseOffered: true,
    markedInPlay: false,
    markedChosen: false,
    restartRequired: false,
    stopGameFirst: false,
  });
}

/** Every phase this derivation can produce, for the totality gate to enumerate. */
export const COMPANION_ACTIVATION_PHASES: readonly CompanionActivationPhase[] = Object.freeze([
  "offer",
  "in_play",
  "chosen",
  "blocked_by_session",
  "unsupported",
]);
