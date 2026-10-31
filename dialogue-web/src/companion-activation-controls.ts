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
 * The phases are the whole state machine, and every one of them has at least one valid forward
 * action - `companion-activation-gate.test.mjs` enumerates them from `COMPANION_ACTIVATION_PHASES`
 * (not from a retyped list, so adding a sixth phase forces the gate to have an opinion) and fails
 * by name on the phase that has none. `in_play` has no ACTIVATION control by design: she is
 * already the answer, and the row's own read control (the inspector) is the forward action left
 * there. `unsupported` has no choice control either, and for a different reason: the route is
 * served by no part of this build, so a control could only fail on press.
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
  /**
   * The one step that moves this row forward, named rather than implied. `terminal` is reserved for
   * the phase the player has nothing left to do about - she is already the companion in play - and
   * `AGENTS.md`'s zero-forward-path rule is what keeps that the ONLY one: every other phase carries
   * a step the player can actually take, and the gate fails by name on a phase that does not.
   */
  forwardAction: CompanionForwardAction;
}>;

/**
 * How a row's state is left behind, as the player's own step.
 *
 * Every member is a thing the surface really offers, which is the point: `choose` is a control on
 * the row, `restart` is the tray's own step named in words (the tray serves no browser route),
 * `stop_game_then_choose` keeps the control while naming what blocks it, and `update_or_reload` is
 * the step a build that does not serve the route leaves. `terminal` is the single state with
 * nothing to do - and the gate's job is to keep it the single one.
 */
export type CompanionForwardAction = "choose" | "terminal" | "restart" | "stop_game_then_choose" | "update_or_reload";

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
      forwardAction: "terminal" as const,
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
      forwardAction: "update_or_reload" as const,
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
      forwardAction: "stop_game_then_choose" as const,
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
      forwardAction: "restart" as const,
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
    forwardAction: "choose" as const,
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

/**
 * The phase one row is in, given the facts the surface holds, as a plain projection.
 *
 * Exported so the gate can drive EVERY phase through the real derivation instead of restating
 * what each one means: the inputs below are the five distinguishable situations the product
 * names, and `deriveCompanionActivationControls` decides the phase from them. A phase the gate
 * cannot reach is therefore a phase nothing produces, which is a fact worth failing on.
 */
export const COMPANION_ACTIVATION_INPUTS: Readonly<
  Record<CompanionActivationPhase, Parameters<typeof deriveCompanionActivationControls>[0]>
> = Object.freeze({
  in_play: Object.freeze({
    isCurrent: true,
    chosenHandle: null,
    handle: "row",
    activationServed: true,
    blockedBySession: false,
  }),
  offer: Object.freeze({
    isCurrent: false,
    chosenHandle: null,
    handle: "row",
    activationServed: true,
    blockedBySession: false,
  }),
  chosen: Object.freeze({
    isCurrent: false,
    chosenHandle: "row",
    handle: "row",
    activationServed: true,
    blockedBySession: false,
  }),
  blocked_by_session: Object.freeze({
    isCurrent: false,
    chosenHandle: null,
    handle: "row",
    activationServed: true,
    blockedBySession: true,
  }),
  unsupported: Object.freeze({
    isCurrent: false,
    chosenHandle: null,
    handle: "row",
    activationServed: false,
    blockedBySession: false,
  }),
});
