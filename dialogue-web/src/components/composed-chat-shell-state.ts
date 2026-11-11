import type { ChatModelRoute } from "../chat-model-route";
import type { Messages } from "../i18n";
import type { BrowserTurnV1 } from "../reference-pipeline-api";
import type { AppBarProps } from "./AppBar";
import type { ViewState } from "./composed-reference-game-view";
import { turnFailureText } from "./turn-failure-text";
import { TERMINAL_TURN_STATES } from "./use-composed-bootstrap";

/**
 * The facts the composed shell reads out of its committed view, as functions.
 *
 * Every one of these used to be a `const` in the shell's render body, three of them feeds for
 * `deriveChatUIState` (`chat-ui-state`) and the rest read straight into the JSX. They are pure
 * questions about the view - "would the Host take a submission", "is this turn still stoppable",
 * "what does the bar say" - and none of them needs a hook, a closure or the shell's other state,
 * so they live where their reasoning can be read and exercised without mounting a browser.
 */

/** The optimistic player line the shell holds while the submission that produced it is pending. */
export type OptimisticSend = Readonly<{
  idempotencyKey: string;
  text: string;
  submittedAfterRows: number;
}>;

/** True only while the Host would accept a submission now (`chat.submit` is projected available). */
export function submitAvailable(view: ViewState): boolean {
  return (
    view.kind === "ready" &&
    view.session.pending === null &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.submit" && op.availability === "available")
  );
}

/** True only while the Host says this exact mounted turn can be cancelled now. */
export function stopAvailable(view: ViewState): boolean {
  return (
    view.kind === "ready" &&
    view.session.snapshot.chat?.turn?.canCancel === true &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.cancel" && op.availability === "available")
  );
}

/**
 * The optimistic entry, while it is still the submission the shell holds.
 *
 * The entry is visible only while the pending record carries its exact key and the authoritative
 * transcript has not yet grown past the point the send was accepted at. It is NOT keyed on text: a
 * player who answers "好的" a second time sends a phrase the transcript already carries, and
 * matching on it suppressed the pending line for the whole turn. A settled/failed turn clears the
 * pending record, so the pair collapses to one message and no ghost survives a re-read or a reload.
 */
export function pendingOptimisticMessage(view: ViewState, optimistic: OptimisticSend | null): OptimisticSend | null {
  return view.kind === "ready" &&
    optimistic !== null &&
    view.session.pending?.idempotencyKey === optimistic.idempotencyKey &&
    (view.session.snapshot.chat?.transcript.length ?? 0) <= optimistic.submittedAfterRows
    ? optimistic
    : null;
}

/**
 * The one line a terminal turn earns, in the failure's own words.
 *
 * A cancelled turn says it stopped; a failed one says why, through `turnFailureText`, which owns
 * which cause earns which sentence. A turn that is still running says nothing - the streaming
 * preview and the Stop control are that fact already.
 */
export function terminalTurnNotice(view: ViewState, labels: Messages): string | null {
  if (view.kind !== "ready") return null;
  const turn = view.session.snapshot.chat?.turn;
  if (turn?.state === "cancelled") return labels.chatStopped;
  if (turn?.state === "failed") return turnFailureText(turn.problemCode, labels, turn.providerFailure);
  return null;
}

/**
 * The app bar's status: one derivation, read twice - the word the badge carries and the tone of
 * the dot beside it.
 *
 * A turn in flight is the one state that was ever honest on its own. Beyond it, the bar used to
 * say `online` for everything that was not generating - so a conversation with no model behind it,
 * the fresh install, claimed to be online - and the shell cannot do better by looking at the
 * operation list: `chat.submit` is projected `available` exactly when no turn exists
 * (`host/src/tavern/reference-pipeline-state.ts`, `projectOperations`), which is a fact about the
 * turn, not about the configuration. The one fact about whether a reply can reach a model is
 * `chatModelRoute`, read from the two settings projections by `chat-model-route.ts`, and it is
 * what these words say.
 *
 * `online` therefore means what this shell can know - a saved connection is active, so the next
 * turn is sent through it - and not "the Host is reachable": there is no health fact here at all,
 * and a mount that is `ready` got that snapshot from the Host moments ago. `unknown` is the route
 * read that did not answer, and an answer that did not arrive is not evidence that one would; the
 * badge cannot be omitted (`AppBar.statusLabel` is required and its accessible name is read from
 * it), so it says so instead of guessing.
 *
 * The dot is the same fact in the other channel, so it is decided beside the word: a bar at 400 px
 * hides `.app-bar-status-label` and the dot is all that is left, and an always-success dot meant a
 * cold start with no connection still glowed green. The two are one object so they cannot disagree
 * (`AppBar.statusTone`).
 */
export function appBarStatus(
  turnInFlight: boolean,
  route: ChatModelRoute,
  labels: Messages,
): Readonly<{ label: string; tone: NonNullable<AppBarProps["statusTone"]> }> {
  if (turnInFlight) return { label: labels.generating, tone: "progress" };
  if (route.kind === "connection") return { label: labels.online, tone: "idle" };
  if (route.kind === "none") return { label: labels.statusNotReady, tone: "cannot-send" };
  return { label: labels.statusUnknown, tone: "unknown" };
}

/**
 * The mounted turn, while it has not reached a terminal state.
 *
 * A settled turn is not something the player can stop, and `chat.submit` is projected available
 * again the moment the ledger is terminal, so the phase and the send gate move together from this
 * one answer.
 */
export function liveTurn(view: ViewState): BrowserTurnV1 | null {
  if (view.kind !== "ready") return null;
  const turn = view.session.snapshot.chat?.turn ?? null;
  return turn !== null && !TERMINAL_TURN_STATES.has(turn.state) ? turn : null;
}
