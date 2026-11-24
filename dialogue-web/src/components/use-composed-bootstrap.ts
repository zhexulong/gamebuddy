import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatSnapshotPair,
  chatSnapshotPairFromRoot,
  readChatSnapshotPair,
  withChatHalf,
} from "../chat-snapshot-pair";
import { type ChatTurnTerminalState, TERMINAL_TURN_STATES } from "../chat-turn-terminal-states.generated";
import {
  chatHalfProblemView,
  composedBootstrapProblemView as bootstrapProblemView,
  composedProblemView as problemView,
} from "../composed-problem-view";
import {
  type ComposedReferenceGameBrowserApi,
  type ComposedReferenceGameBrowserRootV1,
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
  createComposedReferenceGameBrowserApi,
} from "../composed-reference-game-browser-api";
import { PANEL_PARAM } from "../composed-surface-route";
import { applyDocumentLocale, type Locale, type Messages, messages, persistLocale } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import {
  type BrowserTurnV1,
  createReferencePipelineApi,
  type ReferencePipelineApi,
  TavernProblemError,
  TavernProtocolError,
} from "../reference-pipeline-api";
import {
  applyStatus,
  createReferencePipelineSession,
  type PendingSubmission,
  ReferencePipelineSessionError,
} from "../reference-pipeline-session";
import type { ViewState } from "./composed-reference-game-view";

/**
 * The shell's bootstrap and its fallback poll.
 *
 * The composed root is the authority the MOUNT commits - the boot token, the session it adopts and the
 * Game slice it carries. Every later Chat refresh is the Chat half's own route, and the nested Reference
 * pipeline client remains the sole Chat mutation/events client.
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

/**
 * Whether a turn state has settled. The three come from
 * `contracts/chat-turn-terminal-states.v1.json`, so this client and the live-run
 * audits cannot disagree about which states end a turn.
 */
export function isTerminalTurnState(state: BrowserTurnV1["state"]): state is ChatTurnTerminalState {
  return TERMINAL_TURN_STATES.some((terminal) => terminal === state);
}

export function terminalTurn(turn: BrowserTurnV1 | null): boolean {
  return turn !== null && isTerminalTurnState(turn.state);
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
  pollFailure: PendingSubmission | null;
  setPollFailure: Dispatch<SetStateAction<PendingSubmission | null>>;
  startPolling: () => void;
}>;

/**
 * The shell's whole-root read, for the one path that has no Chat half to read instead.
 *
 * `/bootstrap` and its sibling `/state` are the aggregate: the Host composes a Game projection into the
 * document and refuses the document when that half cannot be produced, and a refused `/bootstrap`
 * retires the session it minted (`game-projection-failure-is-not-the-chats.spec.ts` measures
 * `chatHalfReads=0` on that page) - so this read cannot be moved to the Chat half's own route. It is
 * therefore the MOUNT's read, and a card whose problem IS the mount re-takes it, carrying nothing over
 * because there is nothing here to carry. It lives in this module because the aggregate read belongs to
 * the module that mints the session (`gates/product/check-chat-reads-the-chat-route.mjs`); every other
 * Chat read goes through `chat-snapshot-pair.ts`.
 */
export function readShellRoot(
  composedApi: ComposedReferenceGameBrowserApi,
): Promise<ComposedReferenceGameBrowserRootV1> {
  return composedApi.readState();
}

export function useComposedBootstrap(
  localeRef: RefObject<Locale>,
  setPreview: Dispatch<SetStateAction<ComposedPreviewV1 | null>>,
  managementApi: ManagementPipelineApi,
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
  // The pending record the fallback poll spent without an authoritative settlement, or null. The
  // poll publishes WHICH submission went unanswered, not that something did: the shell hands that
  // press's paragraph back to the field, and a flag could not tell it which words those were.
  const [pollFailure, setPollFailure] = useState<PendingSubmission | null>(null);

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
          bootToken === null
            ? await composedApiRef.current.readState()
            : await composedApiRef.current.bootstrap(bootToken);
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
        // The conversation this mount can draw, or the fact that this root carries none. The read it is built
        // from is the one the mount already took (`chatSnapshotPairFromRoot`).
        let pair: ChatSnapshotPair | null;
        try {
          pair = chatSnapshotPairFromRoot(root);
        } catch (error) {
          // A root with no readable Chat half is still a page when it carries the other surface: the Game
          // surface, its own session and the game it runs are not the Chat producer's subject. Which absence
          // this is decides the card the Chat region draws.
          if (root.game == null) throw error;
          pair = null;
        }
        if (!active) return;
        // The interface language the player CHOSE, from the one record that outlives the launch.
        //
        // It is read here, after the session exists and before the first commit, because that is the
        // only moment it can still be a first paint: this browser's own storage is discarded with the
        // ephemeral loopback origin the Desktop serves the shell from, so `resolveLocale` at mount can
        // carry the last confirmed language across a start but can never establish it. The Host's
        // answer wins over that cache, and the cache is rewritten from it so the next launch's first
        // frame is right too. A profile that does not publish the route (or a Host that cannot answer)
        // leaves the cache in force - the same one frame, never a failed surface.
        try {
          const stored = await managementApi.readUiLanguagePreference();
          if (stored.locale !== null) {
            localeRef.current = stored.locale;
            applyDocumentLocale(stored.locale);
            persistLocale(stored.locale);
          }
        } catch {
          // The first-paint cache stands in; nothing about the conversation depends on this read.
        }
        setPreview(null);
        commit(
          pair === null
            ? {
                kind: "ready",
                root,
                // No conversation, and the shell says so where the conversation is drawn: the Game region
                // keeps the surface, the session and the running game it owns.
                session: null,
                draft: null,
                locale: localeRef.current,
                chatProblem: chatHalfProblemView(
                  root.chat == null ? "chat_half_unreadable" : "no_conversation",
                  messages(localeRef.current),
                ),
              }
            : {
                kind: "ready",
                root: pair.root,
                session: createReferencePipelineSession(pair.root.chat),
                draft: pair.draft,
                locale: localeRef.current,
                // The mount's own read succeeded, so the conversation it publishes has no problem.
                chatProblem: null,
              },
        );
      } catch (error) {
        // Nothing was committed yet: there is no session, and no region to draw a card in. The card is
        // then the whole window, so it is worded from the mount's own causes (`composedBootstrapProblemView`)
        // rather than from a panel's: what is unavailable here is the chats, and a read taken again cannot
        // change the causes this path can be handed.
        if (active) commit(bootstrapProblemView(error, messages(localeRef.current)));
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
    };
  }, [commit, managementApi]);

  /**
   * The pair a poll hop projects: the Chat half's own route, which carries the draft's revision *and* its
   * body, so a hop costs one request and every hop learns the draft as it stands.
   */
  const resolvePollDraft = (current: ComposedReferenceGameBrowserRootV1) =>
    readChatSnapshotPair(current, tavernApiRef.current);

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
      if (current.kind !== "ready" || current.session === null || current.session.pending === null) {
        pollActiveRef.current = false;
        return;
      }
      const pending = current.session.pending;
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
        // snapshot still marks cancellable - work again, and hand the record to the
        // shell: it is the one fact that says which submission's outcome is unknown.
        commit({ ...current, session: current.session.withPending(null) });
        setPollFailure(pending);
        return;
      }
      try {
        const { root, draft } = await resolvePollDraft(current.root);
        let session = current.session.applySnapshot(root.chat);
        if (session.pending !== null) {
          const status = await tavernApiRef.current.readSubmissionStatus({
            apiVersion: 1,
            idempotencyKey: pending.idempotencyKey,
            selectionGeneration: pending.selectionGeneration,
          });
          session = session.withPending(applyStatus(session.pending, status).pending);
        }
        // Three awaits just happened (`readState`, `resolvePollDraft`, `readSubmissionStatus`) and the surface can
        // unmount or switch away inside any of them. The catch below answers that for the failure path; this answers
        // it for the success path, so a poll that lands after teardown does not commit state to a component that is
        // gone. It sits before the first `commit` rather than inside each branch so both exits are covered.
        if (cancelledRef.current) {
          pollActiveRef.current = false;
          return;
        }
        // The hop answers the Chat half and nothing else, so the Game slice is the landing view's own: a Game fact
        // that reached the panel while this hop was in flight is newer than the view the hop left on, and committing
        // an older projection would leave the panel on it with nothing left to put it forward again
        // (`withChatHalf`).
        const landing = viewRef.current;
        const next = {
          kind: "ready" as const,
          root: landing.kind === "ready" ? withChatHalf(landing.root, root) : root,
          session,
          draft,
          locale: current.locale,
          chatProblem: null,
        };
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
          // A read about the conversation, refused for good. The shell keeps standing - the Game
          // projection and the Game surface are not this failure's subject - so the card is
          // committed into the Chat region rather than over the window.
          commit({ ...current, chatProblem: problemView(error, messages(current.locale)) });
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
