import { type Dispatch, type RefObject, type SetStateAction, useEffect, useState } from "react";
import { readChatSnapshotPair, withChatHalf } from "../chat-snapshot-pair";
import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
} from "../composed-reference-game-browser-api";
import { type Locale, messages } from "../i18n";
import {
  type BrowserEventV1,
  type BrowserTurnV1,
  type ReferencePipelineApi,
  TavernProblemError,
  TavernProtocolError,
} from "../reference-pipeline-api";
import { createReferencePipelineSession, ReferencePipelineSessionError } from "../reference-pipeline-session";
import { createSerialDrain, type SerialDrain } from "../serial-drain";
import { previewStillOwed } from "./composed-chat-shell-state";
import type { ViewState } from "./composed-reference-game-view";
import { observeTurnEvent } from "./turn-timings";
import { type ComposedPreviewV1, terminalTurn } from "./use-composed-bootstrap";

/**
 * The shell's live event stream: the cursor, its resync, and the sentence a failed resync leaves.
 *
 * The chat's live channel is a cursor over one conversation: `openEvents` from the position the
 * committed snapshot published, every frame validated against the position the frame before it left,
 * and an authoritative `/state` read whenever that position can no longer be trusted. It writes the
 * shell's streamed reply (`setPreview`), the committed view (`commit`, always replacing the Chat half
 * and keeping the Game slice - `withChatHalf`), and the one sentence it owns (`streamNotice`); it
 * reads the committed view only at effect start, and takes every later fact from `viewRef`.
 *
 * It lives here rather than in the shell because it is a lifecycle, not a block: an epoch or Chat
 * switch tears it down and rebuilds it from the new cursor, and its identity IS the dependency array
 * below (`[view.kind, commit, eventStreamEpoch]`). That array is carried over unchanged - a hook whose
 * dependencies differed from the inline effect's would be a behaviour change wearing a refactor's
 * clothes.
 *
 * `startChatEventStream` is the body as a plain function, so the rules that must not drift - the
 * cursor it opens on, the bounded resync, the retry backoff, the preview handoff - are driven by a
 * test with fake seams instead of only by a mounted journey.
 */

/** The recovery read's first retry delay, and the ceiling its doubling stops at. */
const RETRY_FIRST_MS = 1_000;
const RETRY_CEILING_MS = 5_000;

/**
 * How long a committed frame's preview is held while the read that carries its message lands.
 *
 * The handoff is one round trip, not a state: `message.committed` says the reply is durable, and the
 * transcript row that replaces the streamed preview only exists once `reconcile`'s `/state` answer is
 * committed. Spending the preview at the frame left the conversation with no reply row at all in
 * between - measured at 80 of 101 sampled frames on a 1.5 s read. The budget is what keeps the hold
 * bounded when the read never lands: past it the preview is dropped rather than left standing as a
 * reply the Host may not have kept.
 */
const PREVIEW_HANDOFF_BUDGET_MS = 2_000;

/**
 * True when a failed read says something about the conversation rather than about the link.
 *
 * The same four classes the bootstrap's fallback poll treats as terminal (`use-composed-bootstrap`,
 * the catch inside its poll tick): a reducer rejection, a protocol fault, or a Host refusal the Host
 * itself says is not retryable. Those are what the problem page is for - a state that cannot be
 * reconciled, a build that does not speak this contract, a command that will be refused the same way
 * again. Everything else - an offline read, a 5xx, a retryable refusal - is a link that comes back,
 * and replacing the whole shell for one of those is what ended reconnection for a session.
 *
 * The list is spelled twice because the poll that owns the other copy is in another module; a shared
 * predicate is where this belongs the next time that module is opened.
 */
function terminalReadFailure(error: unknown): boolean {
  // A fetch that never landed arrives as a protocol error, and it is the most transient failure there
  // is - the client's own `network_error` reason names the link, not the contract.
  if (error instanceof ComposedReferenceGameProtocolError && error.reason === "network_error") return false;
  return (
    error instanceof ReferencePipelineSessionError ||
    error instanceof TavernProtocolError ||
    (error instanceof TavernProblemError && !error.retryable) ||
    error instanceof ComposedReferenceGameProtocolError ||
    (error instanceof ComposedReferenceGameProblemError && !error.retryable)
  );
}

/**
 * The shell's seams, as the stream takes them.
 *
 * `view` is the committed view, and the stream reads exactly three facts off it - the epoch guard,
 * the cursor it starts from and the checkpoint frames validate against - all at effect start, which
 * is why `view.kind` can appear in the dependency array while `view` itself is not a dependency. Every
 * later fact comes from `viewRef`.
 */
export type ChatEventStreamInput = Readonly<{
  view: ViewState;
  viewRef: RefObject<ViewState>;
  tavernApiRef: RefObject<ReferencePipelineApi>;
  localeRef: RefObject<Locale>;
  eventSourceRef: RefObject<{ close(): void } | null>;
  streamLiveRef: RefObject<boolean>;
  streamFailedRef: RefObject<boolean>;
  turnKeyRef: RefObject<string | null>;
  setPreview: Dispatch<SetStateAction<ComposedPreviewV1 | null>>;
  commit: (next: ViewState) => void;
  commitChatProblem: (error: unknown) => void;
  eventStreamEpoch: string | undefined;
}>;

/** The seams plus the sentence the hook itself owns, which the shell only reads. */
export type ChatEventStreamLifecycle = ChatEventStreamInput &
  Readonly<{ setStreamNotice: (notice: string | null) => void }>;

/**
 * The live cursor, armed for one epoch of one mounted conversation.
 *
 * Returns the effect's cleanup: the socket closes, the retry timer and the preview hold are cleared,
 * and every in-flight read sees `disposed` and commits nothing.
 */
export function startChatEventStream(input: ChatEventStreamLifecycle): () => void {
  const {
    view,
    viewRef,
    tavernApiRef,
    localeRef,
    eventSourceRef,
    streamLiveRef,
    streamFailedRef,
    turnKeyRef,
    setPreview,
    setStreamNotice,
    commit,
    commitChatProblem,
  } = input;
  if (view.kind !== "ready" || view.session === null || view.session.snapshot.eventStream === null)
    return () => undefined;
  let disposed = false;
  let recovering = false;
  // The frame queue (`../serial-drain`): one slot, in order, and a link that rejects does not stop the
  // drain. A bare `work = work.then(...)` chain stops at its first rejection while the socket stays open
  // and `streamLiveRef` stays true - a stream that looks live and delivers nothing, with the fallback
  // poll suspended because the stream looks live.
  let drain: SerialDrain | null = null;
  let cursor = view.session.snapshot.eventStream.cursor;
  let pendingResetCursor = false;
  // The recovery read's own retry: one timer and the attempt count that shapes its delay.
  let retryTimer: number | null = null;
  let retries = 0;
  // A new epoch or Chat starts from no stated failure: the sentence below describes a read this
  // cursor could not take, and this is a different cursor.
  setStreamNotice(null);
  // The stream's own position, advanced by every frame this effect validates. A
  // frame is validated against the position the frame before it left, and the
  // reads below no longer commit between frames - so the checkpoint is carried
  // here instead, and a burst that all arrives during one read still catches a
  // gap. An epoch or Chat switch rebuilds this effect, so it cannot go stale.
  let checkpoint = view.session;

  const closeSource = (): void => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    streamLiveRef.current = false;
  };
  const recover = async (resetCursor = false): Promise<void> => {
    if (resetCursor) pendingResetCursor = true;
    if (disposed || recovering) return;
    recovering = true;
    closeSource();
    let retry = false;
    try {
      const doReset = pendingResetCursor;
      pendingResetCursor = false;
      // The root this read composes onto is the one the view holds when the read LEAVES: the Chat half
      // is the route's answer, and the Game slice is the landing view's (`withChatHalf` below).
      const base = viewRef.current;
      if (base.kind !== "ready") return;
      const pair = await readChatSnapshotPair(base.root, tavernApiRef.current);
      const root = pair.root;
      const draft = pair.draft;
      if (disposed) return;
      const current = viewRef.current;
      if (current.kind !== "ready" || current.session === null || root.chat.chat === null) return;
      const epochChanged = root.chat.eventStream?.epoch !== current.session.snapshot.eventStream?.epoch;
      let session: ReturnType<typeof createReferencePipelineSession>;
      let rebuilt = false;
      try {
        session = checkpoint.applySnapshot(root.chat);
      } catch (error) {
        // A committed Chat switch replaces the mounted identity itself: the new
        // snapshot cannot be reconciled with the old session, so the session is
        // rebuilt from it instead of failing the whole surface.
        if (!(error instanceof ReferencePipelineSessionError) || error.code !== "state_reconciliation_required")
          throw error;
        session = createReferencePipelineSession(root.chat);
        rebuilt = true;
      }
      if (doReset || epochChanged || rebuilt) {
        if (root.chat.eventStream === null) throw new ReferencePipelineSessionError("stream_resync_required");
        cursor = root.chat.eventStream.cursor;
        session = session.resetEventCheckpoint();
      }
      // The recovery read is authoritative about the TURN, not about the words: a reconnect that
      // finds the same turn still open has replaced nothing, and the reply on screen is still the
      // only copy of it. This used to spend the preview unconditionally, which made a stream blip
      // erase a half-written reply (`settlePreview` owns the rule now).
      settlePreview(root.chat.chat.turn);
      // The stream handler's own settle rule: an authoritative read that sees a
      // terminal turn spends the pending submission record. A stream that keeps
      // failing reconnects and re-suspends the poll within milliseconds of each
      // failure, so the recovery read - not a poll hop - is what has to unlock
      // the composer in that state.
      // The checkpoint carries the stream position only: the pending record is
      // the committed session's, which a turn-starting mutation publishes outside
      // this effect.
      const settled = terminalTurn(root.chat.chat.turn)
        ? session.withPending(null)
        : session.withPending(current.session.pending);
      checkpoint = settled;
      commit({
        kind: "ready",
        root: withChatHalf(current.root, root),
        session: settled,
        draft,
        locale: current.locale,
        chatProblem: null,
      });
      setStreamNotice(null);
      retries = 0;
    } catch (error) {
      if (disposed) return;
      if (terminalReadFailure(error)) {
        commitChatProblem(error);
        return;
      }
      // The projection stands. A refresh that failed is not a conversation that stopped existing
      // - the rule the arrival read follows - and the shell says which read it could not take
      // instead of unmounting the surface that was about to reconnect.
      setStreamNotice(messages(localeRef.current).chatArrivalNotice);
      retry = true;
    } finally {
      recovering = false;
      if (retry) scheduleRecovery();
      else if (pendingResetCursor && !disposed) void recover(true);
      else if (!disposed && viewRef.current.kind === "ready") connect();
    }
  };
  /**
   * The next attempt after a recovery read the link refused.
   *
   * The backoff is the fallback poll's own shape: one second doubling to a five-second ceiling,
   * because a Host that is down is not made alive by hammering it and a link that dropped does
   * come back. The timer belongs to this effect, so an epoch switch, a Chat switch or an unmount
   * disposes it with the socket, and one attempt is ever outstanding.
   */
  const scheduleRecovery = (): void => {
    if (disposed || retryTimer !== null) return;
    const delay = Math.min(RETRY_FIRST_MS * 2 ** retries, RETRY_CEILING_MS);
    retries += 1;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void recover(true);
    }, delay);
  };
  /**
   * The authoritative half of a committed frame, coalesced to one pass at a time.
   *
   * Confirming a committed message or a turn transition costs `/state` and then
   * the draft read that cross-checks it. Paid once per frame, a burst queued the
   * reads faster than they resolved, so the authoritative state lagged the stream
   * it was meant to confirm. A frame arriving while a pass is reading only marks
   * that pass pending; the in-flight pass then runs exactly one more read, and
   * clears the mark *before* it starts, so a frame that arrives during that read
   * is pending too. The last frame therefore always gets a read issued after it
   * arrived: coalescing can never become a lost update.
   */
  let reconciling = false;
  let pendingReconcile = false;
  /**
   * The preview a committed frame spent, held until the read that carries the message lands.
   *
   * A handoff is not a disappearance. `Timeline` says so at its own note: "the wire clears the
   * preview on `message.committed` and the transcript arrives on the read that follows" - which is
   * exactly the gap the player saw, because the clear happened at the frame and the read is a round
   * trip later. The hold is the frame's `message.committed` and the budget above is its bound; a
   * `turn.state_changed` still spends the preview at once, because a cancelled turn's partial reply
   * is not owed to the transcript.
   */
  let previewHandoffTimer: number | null = null;
  const holdPreviewUntilReconcile = (): void => {
    if (previewHandoffTimer !== null) return;
    previewHandoffTimer = window.setTimeout(() => {
      previewHandoffTimer = null;
      setPreview(null);
    }, PREVIEW_HANDOFF_BUDGET_MS);
  };
  /** The authoritative read landed: the preview it replaces is spent now, and its budget is cancelled. */
  const spendHeldPreview = (): void => {
    if (previewHandoffTimer === null) return;
    window.clearTimeout(previewHandoffTimer);
    previewHandoffTimer = null;
  };
  /**
   * A read or a frame landed: the reply on screen is either replaced by what it carries, or kept.
   *
   * `turn` is the turn that landing reports. A committed frame's own read is the one landing that
   * spends regardless of it: its message is durable and the row showing it is in the answer
   * (`spendHeldPreview`, whose budget that frame armed). Every other landing is the shell's one rule,
   * `previewStillOwed`: the words stay while the turn that wrote them is still open, and go with a turn
   * that is over - a cancelled turn's partial reply is not owed to the transcript.
   */
  const settlePreview = (turn: BrowserTurnV1 | null): void => {
    if (previewHandoffTimer !== null) {
      spendHeldPreview();
      setPreview(null);
      return;
    }
    setPreview((existing) => previewStillOwed(existing, turn));
  };
  const reconcile = async (): Promise<void> => {
    if (reconciling) {
      pendingReconcile = true;
      return;
    }
    reconciling = true;
    try {
      do {
        pendingReconcile = false;
        if (disposed || recovering) return;
        const current = viewRef.current;
        if (current.kind !== "ready") return;
        try {
          const { root, draft } = await readChatSnapshotPair(current.root, tavernApiRef.current);
          const latest = viewRef.current;
          // A recovery that started under these reads is reading the same
          // authority with a cursor of its own; its answer supersedes this one.
          if (disposed || recovering || latest.kind !== "ready" || latest.session === null || root.chat.chat === null)
            return;
          const session = checkpoint.applySnapshot(root.chat);
          settlePreview(root.chat.chat.turn);
          // The authoritative turn is settled, so a pending record for it is spent
          // - the same rule the fallback poll applies to the turns it settles. The
          // stream is the live channel and the poll is suspended underneath it, so
          // without this the record - and with it the composer - would survive the
          // very settle the stream just delivered.
          const settled = terminalTurn(root.chat.chat.turn)
            ? session.withPending(null)
            : session.withPending(latest.session.pending);
          checkpoint = settled;
          commit({
            kind: "ready",
            root: withChatHalf(latest.root, root),
            session: settled,
            draft,
            locale: latest.locale,
            chatProblem: null,
          });
        } catch {
          await recover(true);
          return;
        }
      } while (pendingReconcile && !disposed);
    } finally {
      reconciling = false;
    }
  };
  const handleEvent = (event: BrowserEventV1, lastEventId: string): void => {
    drain?.push(async () => {
      if (disposed || recovering) return;
      try {
        const current = viewRef.current;
        if (current.kind !== "ready") return;
        checkpoint = checkpoint.applyEvent(event);
        cursor = lastEventId;
        if (event.eventType === "companion.delta") {
          setPreview((existing) => {
            /* The first delta of a turn is the moment the player sees words; later deltas are the same paint. */
            observeTurnEvent(event, turnKeyRef.current, existing?.turnHandle ?? null);
            return Object.freeze({
              turnHandle: event.payload.turnHandle,
              text:
                existing?.turnHandle === event.payload.turnHandle
                  ? `${existing.text}${event.payload.delta}`
                  : event.payload.delta,
            });
          });
          return;
        }
        if (event.eventType === "message.committed") {
          // The reply is durable; the row that shows it is in the read below, so the preview is
          // held for that one handoff instead of vanishing here (see `holdPreviewUntilReconcile`).
          holdPreviewUntilReconcile();
        } else if (event.eventType === "turn.state_changed") {
          /* The mark mapping lives in `turn-timings`: it is a fact about the contract's state union. */
          const settled = observeTurnEvent(event, turnKeyRef.current, null).terminal;
          // The same rule a read applies, from the frame's own turn: a state change that leaves this
          // turn open replaces no words, and one that ends it - completed, cancelled, failed - takes
          // the partial reply with it, because a settled turn owes the transcript nothing.
          settlePreview(event.payload);
          if (settled) turnKeyRef.current = null;
        }
        // Not awaited: the pass owns the reads, so a frame that arrives while it
        // runs still validates its own position here and then marks it pending.
        void reconcile();
      } catch {
        await recover(true);
      }
    });
  };
  function connect(): void {
    if (disposed || recovering || eventSourceRef.current !== null) return;
    try {
      eventSourceRef.current = tavernApiRef.current.openEvents({
        cursor,
        onEvent: handleEvent,
        onError: () => {
          streamLiveRef.current = false;
          streamFailedRef.current = true;
          void recover();
        },
      });
      streamLiveRef.current = true;
    } catch (error) {
      streamLiveRef.current = false;
      if (terminalReadFailure(error)) commitChatProblem(error);
      else {
        streamFailedRef.current = true;
        setStreamNotice(messages(localeRef.current).chatArrivalNotice);
        scheduleRecovery();
      }
    }
  }
  // A frame the queue could not process is the same fact a bad frame is: the stream owes an authoritative
  // read, so the recovery pass is what a rejected link runs.
  drain = createSerialDrain(() => void recover(true));
  connect();
  return () => {
    disposed = true;
    closeSource();
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    if (previewHandoffTimer !== null) window.clearTimeout(previewHandoffTimer);
  };
}

/**
 * The live-stream sentence the shell draws, and the subscription that writes it.
 *
 * The dependency array is the inline effect's, unchanged: an epoch switch, a Chat switch (which bumps
 * `eventStreamEpoch`) or a new `commit` tears the cursor down and rebuilds it on the new position.
 */
export function useChatEventStream(input: ChatEventStreamInput): string | null {
  /**
   * The live cursor's reconnect read that could not be taken, in the surface's own sync sentence.
   *
   * A stream that dies and a read that fails in the same breath is one transient outage, and the
   * projection on screen is still the last one the Host confirmed - so the shell keeps it and says
   * which read it could not make, the same rule the arrival read follows (`use-arrival-reread.ts`).
   * Spent by the recovery read that lands; a failure the Host describes as terminal never sets it,
   * because that class replaces the surface with its problem view instead.
   */
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const { view, commit, eventStreamEpoch } = input;
  useEffect(
    () => startChatEventStream({ ...input, setStreamNotice }),
    // `input` itself is recreated every render and is not the effect's identity: the three values
    // below are, exactly as they were inline (`[view.kind, commit, eventStreamEpoch]`).
    [view.kind, commit, eventStreamEpoch],
  );
  return streamNotice;
}
