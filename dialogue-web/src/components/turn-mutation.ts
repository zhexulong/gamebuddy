import { TavernProblemError } from "../reference-pipeline-api";
import { type PendingSubmission, pendingSubmission } from "../reference-pipeline-session";
import type { ReadyView, ViewState } from "./composed-reference-game-view";

/**
 * The shell's own seams, handed over once instead of being re-read by both turn-starting mutations.
 *
 * Every one of them is a fact this module must not own: the view and the turn key are the shell's
 * synchronous state (`ref` because a mutation resolves after an await and can never act on a stale
 * render), and the setters, the commitment and the poll belong to the shell and to its bootstrap.
 */
export type TurnMutationInput = Readonly<{
  viewRef: { readonly current: ViewState };
  turnKeyRef: { current: string | null };
  commit: (next: ViewState) => void;
  commitChatProblem: (error: unknown) => void;
  setSendFailure: (sentence: string | null) => void;
  setPollFailure: (submission: PendingSubmission | null) => void;
  startPolling: () => void;
}>;

/**
 * The two facts a turn-starting mutation needs from this module.
 *
 * `begin` publishes the durable half of a press and says whether it may proceed; `settleFailure` is
 * what that press calls when its wire call failed, and it decides the record's fate. Send and
 * regenerate publish the same record through `begin`, so they resolve it through `settleFailure`,
 * and that is also where the poll that resolves it starts.
 */
export type TurnMutation = Readonly<{
  begin: (idempotencyKey: string, current: ReadyView) => PendingSubmission | null;
  settleFailure: (error: unknown) => void;
}>;

/**
 * The one envelope every turn-starting mutation of the composed shell is written through.
 *
 * Send and regenerate are the two, and both are the same sequence around one wire call: they may
 * only start while the profile offers `chat.submit` as `available` (the store admits exactly one
 * turn at a time, so that availability *is* "no turn is in flight"), the mutation's own pending
 * record - correlated by the idempotency key it sends - must be published before its wire call, and
 * a failure resolves that record by whether the Host answered at all.
 *
 * It is one module for the same reason `message-mutation` is: written inside the shell's render body,
 * the three rules sit three hundred lines from the per-verb handlers they belong to, and a caller
 * that starts a turn can forget half of it - `handleRegenerate` did, and `turn-timings-gate` exists
 * because it started a turn nothing on the page could name. Here the rules are read once, beside the
 * failure model they implement.
 */
export function createTurnMutation(input: TurnMutationInput): TurnMutation {
  /**
   * Begin the durable half of a turn-starting Chat mutation.
   *
   * The record is not bookkeeping. `startPolling`'s first tick returns for a session with nothing
   * pending, which is what keeps every idle session from polling, and that fallback poll is the only
   * thing that settles a turn when no event stream is delivering it. Publishing in this one place is
   * what keeps the next turn-starting mutation from starting a poll that is dead on its first tick;
   * a mutation that starts no turn (swipe) publishes nothing and polls nothing.
   *
   * The poll is started here, at the publication, and not by the callers after their wire call
   * returns. A mutation's answer is one of the things that can simply never arrive - a request left
   * open, a proxy that never closes - and the poll is the only reader that can resolve the record
   * beside `chat.submission_status`. Started after the answer, it never ran for exactly the
   * submission that needed it: the record stayed set, so the field stayed locked and the action slot
   * stayed a spinner, with no Send, no Stop and no sentence, for as long as the tab lived.
   *
   * Returns null - having committed the rejected projection, or having found no available
   * `chat.submit` - and the caller must then send nothing.
   */
  const begin = (idempotencyKey: string, current: ReadyView): PendingSubmission | null => {
    if (current.session === null) return null;
    const operation = current.session.snapshot.operations.find((op) => op.operationId === "chat.submit");
    if (operation?.availability !== "available") return null;
    try {
      const pending = pendingSubmission(idempotencyKey, current.session.snapshot);
      input.commit({ ...current, session: current.session.withPending(pending) });
      // The last refusal described the last attempt, and this attempt is the answer to it. Cleared here
      // rather than in the handler because this is the seam both turn-starting mutations share - send and
      // regenerate - so neither can leave a sentence about an attempt it already superseded on screen.
      input.setSendFailure(null);
      // The last poll failure described the last attempt too, and this attempt is the answer to it.
      input.setPollFailure(null);
      input.startPolling();
      return pending;
    } catch (error) {
      input.commitChatProblem(error);
      return null;
    }
  };

  /**
   * Whether the Host itself answered a failed turn-starting mutation.
   *
   * `TavernProblemError` is the Host's own validated problem document: it answered, and the answer
   * is that the command was not carried out. Everything else is the absence of an answer - a dropped
   * connection, a timeout, a body this client could not read - and the absence of an answer is not a
   * refusal: it says nothing about whether the Host admitted the submission.
   */
  const hostAnswered = (error: unknown): boolean => error instanceof TavernProblemError;

  /**
   * What a failed turn-starting mutation does with the record it published.
   *
   * Two facts, not one, and the difference decides whether the player may send again:
   *
   *   - **refused** - the Host answered. Nothing ran, so the record is spent and the composer is
   *     handed back. `rereadChat`'s settle rule cannot do this: it spends a record for a *terminal
   *     turn*, and a refusal leaves no turn at all, so the spinner of a submission no turn backs
   *     would outlive the refusal until the player switched chats or reloaded.
   *   - **unanswered** - no answer arrived. The record survives, because it is exactly the fact that
   *     a submission may be held: it keeps the fallback poll live and keeps the send gate closed.
   *     Handing it back invites a resend of a message the Host may already be answering, which is a
   *     second player row and a second provider turn for one press. The poll is the one authority
   *     that can say what happened, and it spends the record when the turn settles.
   *
   * Read from the view ref rather than from the caller's own view: this runs after the mutation's
   * await (and, for regenerate, after its reread), so the view the caller captured is no longer the
   * view the record lives in.
   */
  const settleFailure = (error: unknown): void => {
    if (!hostAnswered(error)) return;
    // An answered refusal means nothing ran, so no turn will ever settle the attempt this key names:
    // it is not "waiting for a turn" any more, it is a name with no turn behind it. Forgotten here,
    // at the one seam every turn-starting mutation settles through.
    input.turnKeyRef.current = null;
    const latest = input.viewRef.current;
    if (latest.kind === "ready" && latest.session !== null && latest.session.pending !== null)
      input.commit({ ...latest, session: latest.session.withPending(null) });
  };

  return Object.freeze({ begin, settleFailure });
}
