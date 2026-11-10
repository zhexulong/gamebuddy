import { assertNever } from "../assert-never";
import type { GameOperationFailure } from "../composed-problem-view";

/**
 * What the Game surface's attachment is doing, as one value.
 *
 * The surface used to hold each operation as three independent cells - a busy flag, a failure and
 * "the prerequisite is missing" - owned by three `useState`s per operation. Three cells per attempt
 * means three chances to update two and miss the third, and the reachable shapes were the point: Stop
 * and Disconnect are both offered on an attached, connected-idle session, and each control was disabled
 * only by its OWN busy flag, so one click on each sent two commands against the same attachment
 * generation - the Host answers one of them `game_attachment_conflict` and the player sees two spinners
 * and one refusal for presses they made in good faith. A refusal also outlived its attempt: the sentence
 * was cleared only when the SAME operation was pressed again, so a failed Stop stayed on screen after a
 * successful launch had made it describe a session that no longer existed.
 *
 * So the surface's attachment state is one discriminated union, and one function moves it. There is no
 * cell to miss: an operation in flight is the phase itself, its refusal is a field of the phase it
 * produced, and the surface offers one attachment operation at a time because there is one phase to be in.
 *
 * `connecting` is a launch in flight (the Host owns the process; the game is what happens next),
 * `stopping` and `disconnecting` are the two ways an attached session is released, and `failed` /
 * `not_staged` are the two ways an attempt ends without the thing it asked for.
 */
export type GameAttachmentOperation = "launch" | "stop" | "disconnect";

export type GameAttachmentState =
  /** Nothing in flight: a launch, a stop or a disconnect may be admitted. */
  | Readonly<{ phase: "attached" }>
  /** `game.launch` in flight: the Host is bringing the game up. */
  | Readonly<{ phase: "connecting" }>
  /** `game.stop` in flight: the Host is ending the running game. */
  | Readonly<{ phase: "stopping" }>
  /** `game.disconnect` in flight: the Host is releasing the attachment. */
  | Readonly<{ phase: "disconnecting" }>
  /**
   * `game.launch` was refused because the lifecycle is not staged yet. Not a failure: the prerequisite
   * belongs to Setup, and the surface says so instead of reporting a fault the player cannot act on.
   */
  | Readonly<{ phase: "not_staged" }>
  /** An operation was refused, and this is the sentence its own row reports. */
  | Readonly<{ phase: "failed"; operation: GameAttachmentOperation; failure: GameOperationFailure }>;

export type GameAttachmentEvent =
  /** A press was admitted (the caller has already checked the projection). */
  | Readonly<{ type: "started"; operation: GameAttachmentOperation }>
  /** The attempt ended without a sentence: the authoritative reread landed. */
  | Readonly<{ type: "finished" }>
  /** The attempt was refused, in the refusal's own sentence. */
  | Readonly<{ type: "refused"; operation: GameAttachmentOperation; failure: GameOperationFailure }>
  /** The refusal was the prerequisite, not a fault. */
  | Readonly<{ type: "not_staged" }>;

/** Nothing in flight, nothing to report: the state a surface starts in and returns to. */
export const GAME_ATTACHMENT_ATTACHED: GameAttachmentState = Object.freeze({ phase: "attached" });

/**
 * The operation this phase is in flight for, if any.
 *
 * Every phase is listed, and `assertNever` makes a phase added to the union a compile error here rather
 * than a phase that silently reads as "nothing in flight" - which would offer a second command.
 */
export function busyOperationOf(state: GameAttachmentState): GameAttachmentOperation | null {
  switch (state.phase) {
    case "attached":
      return null;
    case "connecting":
      return "launch";
    case "stopping":
      return "stop";
    case "disconnecting":
      return "disconnect";
    case "not_staged":
      return null;
    case "failed":
      return null;
    default:
      return assertNever(state);
  }
}

const OPERATION_PHASE: Readonly<Record<GameAttachmentOperation, "connecting" | "stopping" | "disconnecting">> =
  Object.freeze({ launch: "connecting", stop: "stopping", disconnect: "disconnecting" });

/**
 * The surface's attachment state after one event.
 *
 * An event that is not legal where the state is returns the state ITSELF - the same object, so the
 * caller can tell a refusal from a transition by identity and, more to the point, so a stale message
 * cannot land: a refusal for an operation that is no longer in flight describes an attempt that no
 * longer stands, and painting it would put one operation's sentence on another's row. Starting an
 * operation from `failed` or `not_staged` supersedes that sentence, which is the same rule the old
 * per-operation code applied to its own row; here it also covers the row of an operation that was
 * superseded, because only one attempt can be standing.
 */
export function reduceGameAttachment(state: GameAttachmentState, event: GameAttachmentEvent): GameAttachmentState {
  switch (event.type) {
    case "started": {
      if (busyOperationOf(state) !== null) return state;
      switch (event.operation) {
        case "launch":
          return Object.freeze({ phase: OPERATION_PHASE.launch });
        case "stop":
          return Object.freeze({ phase: OPERATION_PHASE.stop });
        case "disconnect":
          return Object.freeze({ phase: OPERATION_PHASE.disconnect });
        default:
          return assertNever(event.operation);
      }
    }
    case "finished": {
      return busyOperationOf(state) === null ? state : GAME_ATTACHMENT_ATTACHED;
    }
    case "refused": {
      if (busyOperationOf(state) !== event.operation) return state;
      return Object.freeze({ phase: "failed" as const, operation: event.operation, failure: event.failure });
    }
    case "not_staged": {
      if (busyOperationOf(state) !== "launch") return state;
      return Object.freeze({ phase: "not_staged" as const });
    }
    default:
      return assertNever(event);
  }
}

/** What one operation's row renders: its own spinner, its own sentence, and whether the surface is busy. */
export type GameAttachmentRow = Readonly<{
  /** This very operation is in flight. */
  active: boolean;
  /** This operation's refusal, if this is the one that failed. */
  failure: GameOperationFailure | null;
  /** The launch prerequisite was missing (a Setup fact, not a failure). */
  notStaged: boolean;
  /** Another attachment operation is in flight, so this control must not be offered. */
  blocked: boolean;
}>;

/** Every operation's row, all three read from the one state. */
export function gameAttachmentRows(
  state: GameAttachmentState,
): Readonly<Record<GameAttachmentOperation, GameAttachmentRow>> {
  const busy = busyOperationOf(state);
  const row = (operation: GameAttachmentOperation): GameAttachmentRow =>
    Object.freeze({
      active: busy === operation,
      failure: state.phase === "failed" && state.operation === operation ? state.failure : null,
      notStaged: state.phase === "not_staged" && operation === "launch",
      blocked: busy !== null && busy !== operation,
    });
  return Object.freeze({ launch: row("launch"), stop: row("stop"), disconnect: row("disconnect") });
}
