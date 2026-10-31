import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { type Locale, type Messages, messages } from "../i18n";
import {
  type BrowserDraftV1,
  type BrowserTurnV1,
  type ReferencePipelineApi,
  TavernProblemError,
  TavernProtocolError,
  createReferencePipelineApi,
} from "../reference-pipeline-api";
import {
  ReferencePipelineSessionError,
  applyStatus,
  createReferencePipelineSession,
} from "../reference-pipeline-session";
import {
  type ComposedReferenceGameBrowserApi,
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
  createComposedReferenceGameBrowserApi,
} from "../composed-reference-game-browser-api";
import { composedProblemView as problemView } from "../composed-problem-view";
import { readChatSnapshotPair } from "../chat-snapshot-pair";
import { PANEL_PARAM } from "../composed-surface-route";
import type { ViewState } from "./composed-reference-game-view";

/**
 * The shell's bootstrap and its fallback poll.
 *
 * The composed root is the only authority used to refresh either projection; the
 * nested Reference pipeline client remains the sole Chat mutation/events client.
 * This hook owns the first read of that root (the mounted conversation, its
 * durable draft and the display language), the view state that read commits, and
 * the fallback poll that settles a turn no event stream is delivering. The shell
 * keeps every other concern - the stream, the mutations, the surfaces and the
 * JSX - and reads what it needs from the returned cell.
 */

/** The companion reply as it streams in, before the authoritative transcript carries it. */
export type ComposedPreviewV1 = Readonly<{ turnHandle: string; text: string }>;

/**
 * The Host admits one provider invocation under a fixed 120 s ceiling
 * (`PROVIDER_INVOCATION_ADMISSION_DEADLINE_MS` in the production coordinator).
 * The fallback poll must outlast that ceiling: a client budget that expires
 * first abandons a turn the Host still believes is running and leaves the
 * content-free pending record set, which locks the composer forever.
 */
const HOST_TURN_ADMISSION_CEILING_MS = 120_000;
const POLL_FIRST_MS = 250;
const POLL_INTERVAL_MS = 1_000;
const POLL_BACKOFF_MS = [1_000, 2_000, 4_000, 5_000] as const;
const MAX_POLL_ATTEMPTS = Math.ceil(HOST_TURN_ADMISSION_CEILING_MS / POLL_INTERVAL_MS) + 10;
export const TERMINAL_TURN_STATES = new Set(["completed", "cancelled", "failed"]);

export function terminalTurn(turn: BrowserTurnV1 | null): boolean {
  return turn !== null && TERMINAL_TURN_STATES.has(turn.state);
}

/**
 * What the shell reads back: the committed view and the state the poll mutates.
 *
 * The event stream the shell owns is what suspends the poll, so the two flags it
 * writes (`streamLiveRef`/`streamFailedRef`) are created here beside the poll
 * that reads them and handed out, rather than the other way round.
 */
export type ComposedBootstrap = Readonly<{
  view: ViewState;
  viewRef: RefObject<ViewState>;
  composedApiRef: RefObject<ComposedReferenceGameBrowserApi>;
  tavernApiRef: RefObject<ReferencePipelineApi>;
  commit: (next: ViewState) => void;
  labels: () => Messages;
  cancelledRef: RefObject<boolean>;
  streamLiveRef: RefObject<boolean>;
  streamFailedRef: RefObject<boolean>;
  pollFailure: boolean;
  setPollFailure: Dispatch<SetStateAction<boolean>>;
  startPolling: () => void;
}>;

export function useComposedBootstrap(
  localeRef: RefObject<Locale>,
  setPreview: Dispatch<SetStateAction<ComposedPreviewV1 | null>>,
): ComposedBootstrap {
  const composedApiRef = useRef(createComposedReferenceGameBrowserApi());
  const tavernApiRef = useRef(createReferencePipelineApi());
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const viewRef = useRef<ViewState>({ kind: "loading" });
  const cancelledRef = useRef(false);
  const pollActiveRef = useRef(false);
  // True only while a live event-stream connection is open, and true once that
  // stream has failed while the current turn was in flight. The 250 ms/1000 ms
  // fallback poll exists for a turn no stream is delivering, so a healthy stream
  // suspends it instead of running a second channel over the same turn - and a
  // stream that failed for this turn is not trusted for it again, even after it
  // reconnects, so a flapping stream cannot starve the fallback of a window.
  const streamLiveRef = useRef(false);
  const streamFailedRef = useRef(false);
  // Set when the fallback poll spends its whole budget without an authoritative
  // settlement: the pending record is then cleared and this line says the turn
  // failed rather than silently leaving the composer disabled.
  const [pollFailure, setPollFailure] = useState(false);

  const commit = useCallback((next: ViewState): void => {
    viewRef.current = next;
    setView(next);
  }, []);

  const labels = () => messages(view.kind === "ready" ? view.locale : localeRef.current);

  useEffect(() => {
    cancelledRef.current = false;
    let active = true;
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const bootToken = params.get("boot");
        const restoredPanel = params.get(PANEL_PARAM);
        const root =
          bootToken === null ? await composedApiRef.current.readState() : await composedApiRef.current.bootstrap(bootToken);
        if (bootToken !== null) {
          const url = new URL(window.location.href);
          // The one-time boot token is stripped from the fragment; a panel the
          // URL already names survives the rewrite.
          url.hash =
            restoredPanel === null
              ? "profile=composed-reference-game"
              : `profile=composed-reference-game&${PANEL_PARAM}=${encodeURIComponent(restoredPanel)}`;
          window.history.replaceState(null, "", url.toString());
        }
        const pair = await readChatSnapshotPair(composedApiRef.current, tavernApiRef.current, null, root);
        if (!active) return;
        const session = createReferencePipelineSession(pair.root.chat);
        setPreview(null);
        commit({ kind: "ready", root: pair.root, session, draft: pair.draft, locale: localeRef.current });
      } catch (error) {
        if (active) commit(problemView(error, messages(localeRef.current)));
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
    };
  }, [commit]);

  /**
   * The pair a poll hop projects: the loop's own read of both routes, reconciled. `/state` carries
   * the durable draft's revision and presence, so a hop that agrees with the draft this surface
   * already holds costs no `/draft` read at all; `readChatSnapshotPair` owns that rule, so a hop and
   * a mount cannot disagree about what a pair means.
   */
  const resolvePollDraft = (held: BrowserDraftV1) =>
    readChatSnapshotPair(composedApiRef.current, tavernApiRef.current, held);

  const startPolling = (): void => {
    if (pollActiveRef.current) return;
    // A turn trusts the stream afresh: only a failure that happened while this
    // turn was in flight counts against it.
    streamFailedRef.current = false;
    pollActiveRef.current = true;
    let attempts = 0;
    const schedule = (delayMs: number): void => {
      if (cancelledRef.current) {
        pollActiveRef.current = false;
        return;
      }
      window.setTimeout(() => void tick(), delayMs);
    };
    const tick = async (): Promise<void> => {
      if (cancelledRef.current) {
        pollActiveRef.current = false;
        return;
      }
      const current = viewRef.current;
      if (current.kind !== "ready" || current.session.pending === null) {
        pollActiveRef.current = false;
        return;
      }
      // The stream is the live channel and this poll is only its fallback, so a
      // hop costs nothing while the stream is open and has not failed for this
      // turn: the authoritative reread it would perform is the stream's own job.
      // An open stream that never settles burns the same budget an HTTP hop does,
      // so silence past the budget resumes the poll rather than leaving the
      // composer locked behind a dead channel.
      if (streamLiveRef.current && !streamFailedRef.current && attempts < MAX_POLL_ATTEMPTS) {
        attempts += 1;
        schedule(POLL_INTERVAL_MS);
        return;
      }
      attempts += 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        pollActiveRef.current = false;
        // No authoritative settlement arrived inside the budget. Drop the
        // content-free pending record so the composer - and Stop, for a turn the
        // snapshot still marks cancellable - work again, and report the failure.
        commit({ ...current, session: current.session.withPending(null) });
        setPollFailure(true);
        return;
      }
      const pending = current.session.pending;
      try {
        const { root, draft } = await resolvePollDraft(current.draft);
        let session = current.session.applySnapshot(root.chat);
        if (session.pending !== null) {
          const status = await tavernApiRef.current.readSubmissionStatus({
            apiVersion: 1,
            idempotencyKey: pending.idempotencyKey,
            selectionGeneration: pending.selectionGeneration,
          });
          session = session.withPending(applyStatus(session.pending, status).pending);
        }
        const next = { kind: "ready" as const, root, session, draft, locale: current.locale };
        // Three awaits just happened (`readState`, `resolvePollDraft`, `readSubmissionStatus`) and the surface can
        // unmount or switch away inside any of them. The catch below answers that for the failure path; this answers
        // it for the success path, so a poll that lands after teardown does not commit state to a component that is
        // gone. It sits before the first `commit` rather than inside each branch so both exits are covered.
        if (cancelledRef.current) {
          pollActiveRef.current = false;
          return;
        }
        if (terminalTurn(root.chat.chat?.turn ?? null)) {
          // The authoritative turn is settled; a pending record for it is spent
          // whatever an out-of-date submission status still says, and keeping it
          // is what would leave the composer disabled forever.
          commit(session.pending === null ? next : { ...next, session: session.withPending(null) });
          pollActiveRef.current = false;
          return;
        }
        commit(next);
        if (session.pending === null) {
          pollActiveRef.current = false;
          return;
        }
        schedule(POLL_INTERVAL_MS);
      } catch (error) {
        if (cancelledRef.current) {
          pollActiveRef.current = false;
          return;
        }
        if (
          error instanceof ReferencePipelineSessionError ||
          error instanceof TavernProtocolError ||
          (error instanceof TavernProblemError && !error.retryable) ||
          error instanceof ComposedReferenceGameProtocolError ||
          (error instanceof ComposedReferenceGameProblemError && !error.retryable)
        ) {
          commit(problemView(error, messages(current.locale)));
          pollActiveRef.current = false;
          return;
        }
        const backoff =
          POLL_BACKOFF_MS[Math.min(attempts, POLL_BACKOFF_MS.length) - 1] ??
          POLL_BACKOFF_MS[POLL_BACKOFF_MS.length - 1];
        schedule(backoff);
      }
    };
    schedule(POLL_FIRST_MS);
  };

  return {
    view,
    viewRef,
    composedApiRef,
    tavernApiRef,
    commit,
    labels,
    cancelledRef,
    streamLiveRef,
    streamFailedRef,
    pollFailure,
    setPollFailure,
    startPolling,
  };
}
