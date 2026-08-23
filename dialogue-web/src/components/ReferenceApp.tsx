import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "../i18n";
import { applyDocumentLocale, messages, resolveLocale } from "../i18n";
import {
  type BrowserDraftV1,
  type BrowserEventV1,
  type BrowserTurnV1,
  createReferencePipelineApi,
  TavernProblemError,
  TavernProtocolError,
  type TavernStateSnapshotV1,
} from "../reference-pipeline-api";
import {
  applyStatus,
  createReferencePipelineSession,
  type PendingSubmission,
  pendingSubmission,
  type ReferencePipelineSession,
  ReferencePipelineSessionError,
} from "../reference-pipeline-session";
import { Composer } from "./Composer";
import { ProblemView } from "./ProblemView";
import { SkipLink } from "./SkipLink";
import { Timeline } from "./Timeline";

/**
 * Reference-pipeline browser entry (design/75 Task 4): renders one exact
 * mounted Chat through the frozen `tavern_browser_api/v1` DTO client and the
 * pure identity-bound session reducer. It mounts no P3 management drawers,
 * no fake STOP/cancel, no optimistic bubble; live events only trigger
 * durable `/state` read-back and never synthesize transcript content.
 *
 * Ordering (frozen):
 *   validated available snapshot -> content-free pending key -> disabled
 *   composer -> POST /messages -> 202 accepted representation (never appended
 *   locally) -> one bounded /state + /status poll -> terminal read-back clears
 *   pending and stops.
 *
 * Reload after bootstrap uses the browser session cookie via GET /state; the
 * one-time bootstrap token is never redeemed twice. Identity mismatch stops
 * polling and submission with a ProblemView.
 */

const POLL_FIRST_MS = 250;
const POLL_INTERVAL_MS = 1_000;
const POLL_BACKOFF_MS = [1_000, 2_000, 4_000, 5_000] as const;
const MAX_POLL_ATTEMPTS = 60;
const TERMINAL_TURN_STATES = new Set(["completed", "cancelled", "failed"]);

type ReadyView = Readonly<{
  kind: "ready";
  session: ReferencePipelineSession;
  draft: BrowserDraftV1;
  locale: Locale;
}>;
type ProblemViewState = Readonly<{ kind: "problem"; title: string; detail: string }>;
type ViewState = Readonly<{ kind: "loading" }> | ReadyView | ProblemViewState;

/** Canonical 22-char unpadded base64url idempotency key from CSPRNG bytes. */
function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function terminalTurn(turn: BrowserTurnV1 | null): boolean {
  return turn !== null && TERMINAL_TURN_STATES.has(turn.state);
}

export function ReferenceApp() {
  const apiRef = useRef(createReferencePipelineApi());
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const viewRef = useRef<ViewState>({ kind: "loading" });
  const [inputText, setInputText] = useState("");
  const [preview, setPreview] = useState<Readonly<{ turnHandle: string; text: string }> | null>(null);
  const localeRef = useRef<Locale>(resolveLocale());
  const cancelledRef = useRef(false);
  const pollActiveRef = useRef(false);
  const eventSourceRef = useRef<{ close(): void } | null>(null);

  const commit = useCallback((next: ViewState): void => {
    viewRef.current = next;
    setView(next);
  }, []);

  const labels = () => {
    const locale = view.kind === "ready" ? view.locale : localeRef.current;
    return messages(locale);
  };

  useEffect(() => {
    applyDocumentLocale(localeRef.current);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    let active = true;
    void (async () => {
      const api = apiRef.current;
      try {
        const params = new URLSearchParams(location.hash.slice(1));
        const bootToken = params.get("boot");
        let snapshot: TavernStateSnapshotV1;
        if (bootToken !== null) {
          snapshot = await api.bootstrap(bootToken);
          // Strip the one-time boot but keep the immutable profile marker in
          // the fragment: the static shell serves only path "/" (no query),
          // and a reload must keep selecting the reference surface while
          // re-reading state through the session cookie.
          const url = new URL(window.location.href);
          url.hash = "profile=reference";
          window.history.replaceState(null, "", url.toString());
        } else {
          // Reload path: existing HttpOnly Strict session cookie, never a
          // second bootstrap redemption.
          snapshot = await api.readState();
        }
        const draft = await api.readDraft();
        if (
          snapshot.chat === null ||
          draft.revision !== snapshot.chat.draft.revision ||
          (draft.text !== null) !== snapshot.chat.draft.present
        ) {
          throw new ReferencePipelineSessionError("state_reconciliation_required");
        }
        const session = createReferencePipelineSession(snapshot);
        if (!active) return;
        setPreview(null);
        commit({ kind: "ready", session, draft, locale: localeRef.current });
      } catch (error) {
        if (!active) return;
        commit(problemView(error, messages(localeRef.current)));
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
    };
  }, [commit]);

  const eventStreamEpoch = view.kind === "ready" ? view.session.snapshot.eventStream?.epoch : undefined;

  useEffect(() => {
    if (view.kind !== "ready" || view.session.snapshot.eventStream === null) return;
    let disposed = false;
    let recovering = false;
    let work = Promise.resolve();
    let cursor = view.session.snapshot.eventStream.cursor;

    const closeSource = (): void => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };

    let pendingResetCursor = false;
    const recover = async (resetCursor = false): Promise<void> => {
      if (resetCursor) pendingResetCursor = true;
      if (disposed || recovering) return;
      recovering = true;
      closeSource();
      try {
        const doReset = pendingResetCursor;
        pendingResetCursor = false;
        const snapshot = await apiRef.current.readState();
        const draft = await apiRef.current.readDraft();
        if (disposed) return;
        const current = viewRef.current;
        if (current.kind !== "ready") return;
        const epochChanged = snapshot.eventStream?.epoch !== current.session.snapshot.eventStream?.epoch;
        let next = current.session.applySnapshot(snapshot);
        if (
          snapshot.chat === null ||
          draft.revision !== snapshot.chat.draft.revision ||
          (draft.text !== null) !== snapshot.chat.draft.present
        ) {
          throw new ReferencePipelineSessionError("state_reconciliation_required");
        }
        // Ordinary transport loss preserves the last received cursor so that
        // events published between disconnect and reconnect replay. A resync
        // control event (or changed stream epoch) proves that cursor is no
        // longer admissible: /state then becomes authoritative for both the
        // reconnect cursor and the volatile sequence checkpoint.
        if (doReset || epochChanged) {
          if (snapshot.eventStream === null) throw new ReferencePipelineSessionError("stream_resync_required");
          cursor = snapshot.eventStream.cursor;
          next = next.resetEventCheckpoint();
        }
        setPreview(null);
        commit({ kind: "ready", session: next, draft, locale: current.locale });
      } catch (error) {
        if (!disposed) commit(problemView(error, messages(localeRef.current)));
      } finally {
        recovering = false;
        if (pendingResetCursor && !disposed) {
          void recover(true);
        } else if (!disposed && viewRef.current.kind === "ready") {
          connect();
        }
      }
    };

    const handleEvent = (event: BrowserEventV1, lastEventId: string): void => {
      work = work.then(async () => {
        if (disposed || recovering) return;
        try {
          const current = viewRef.current;
          if (current.kind !== "ready") return;
          const checkpointed = current.session.applyEvent(event);
          cursor = lastEventId;
          if (event.eventType === "companion.delta") {
            setPreview((existing) =>
              Object.freeze({
                turnHandle: event.payload.turnHandle,
                // A changed opaque turn boundary replaces any stale ephemeral
                // preview; matching events extend its stream-only text.
                text:
                  existing?.turnHandle === event.payload.turnHandle
                    ? `${existing.text}${event.payload.delta}`
                    : event.payload.delta,
              }),
            );
            // The delta is intentionally non-durable. Its ordered SSE
            // checkpoint is enough to retain replay/resync safety, while a
            // `/state` reread would erase the only provisional view before
            // React can paint it. Durable events reread below.
            return;
          }
          if (event.eventType === "message.committed" || event.eventType === "turn.state_changed") {
            setPreview(null);
          }
          const snapshot = await apiRef.current.readState();
          const draft = await apiRef.current.readDraft();
          if (disposed) return;
          if (
            snapshot.chat === null ||
            draft.revision !== snapshot.chat.draft.revision ||
            (draft.text !== null) !== snapshot.chat.draft.present
          ) {
            throw new ReferencePipelineSessionError("state_reconciliation_required");
          }
          const next = checkpointed.applySnapshot(snapshot);
          // Any authoritative reread replaces the transient content view;
          // only the durable transcript in `/state` can restore it.
          setPreview(null);
          commit({ kind: "ready", session: next, draft, locale: current.locale });
        } catch {
          // Any invalid, non-contiguous, stale-generation, or explicit
          // resync event invalidates the prior cursor. Recover only from the
          // authoritative snapshot; never retry that cursor in a loop.
          await recover(true);
        }
      });
    };

    function connect(): void {
      if (disposed || recovering || eventSourceRef.current !== null) return;
      try {
        eventSourceRef.current = apiRef.current.openEvents({
          cursor,
          onEvent: handleEvent,
          onError: () => {
            void recover();
          },
        });
      } catch (error) {
        commit(problemView(error, messages(localeRef.current)));
      }
    }

    connect();
    return () => {
      disposed = true;
      closeSource();
    };
  }, [view.kind, commit, eventStreamEpoch]);

  const startPolling = (): void => {
    if (pollActiveRef.current) return;
    pollActiveRef.current = true;
    let attempts = 0;
    const schedule = (delayMs: number): void => {
      if (cancelledRef.current) {
        pollActiveRef.current = false;
        return;
      }
      window.setTimeout(() => {
        void tick();
      }, delayMs);
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
      attempts += 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        // Bounded poll exhausted; the pending key stays for a reload/status
        // read-back and never auto-submits again.
        pollActiveRef.current = false;
        return;
      }
      const pending = current.session.pending;
      const api = apiRef.current;
      try {
        const snapshot = await api.readState();
        let next = current.session.applySnapshot(snapshot);
        if (next.pending !== null) {
          const status = await api.readSubmissionStatus({
            apiVersion: 1,
            idempotencyKey: pending.idempotencyKey,
            selectionGeneration: pending.selectionGeneration,
          });
          next = next.withPending(applyStatus(next.pending, status).pending);
        }
        if (terminalTurn(snapshot.chat?.turn ?? null) || next.pending === null) {
          commit({ kind: "ready", session: next, draft: current.draft, locale: current.locale });
          pollActiveRef.current = false;
          return;
        }
        commit({ kind: "ready", session: next, draft: current.draft, locale: current.locale });
        if (next.pending === null) {
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
          (error instanceof TavernProblemError && !error.retryable)
        ) {
          commit(problemView(error, messages(current.locale)));
          pollActiveRef.current = false;
          return;
        }
        // Retryable transport/problem: exponential-ish backoff 1/2/4/5s.
        const backoff =
          POLL_BACKOFF_MS[Math.min(attempts, POLL_BACKOFF_MS.length) - 1] ??
          POLL_BACKOFF_MS[POLL_BACKOFF_MS.length - 1];
        schedule(backoff);
      }
    };
    schedule(POLL_FIRST_MS);
  };

  const handleSend = async (): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready" || current.session.pending !== null) return;
    const operation = current.session.snapshot.operations.find((op) => op.operationId === "chat.submit");
    if (operation?.availability !== "available") return;
    const text = inputText.trim();
    if (text.length === 0) return;

    const idempotencyKey = newIdempotencyKey();
    let pending: PendingSubmission;
    try {
      pending = pendingSubmission(idempotencyKey, current.session.snapshot);
    } catch (error) {
      commit(problemView(error, messages(current.locale)));
      return;
    }
    setInputText("");
    setPreview(null);
    commit({ ...current, session: current.session.withPending(pending) });
    try {
      await apiRef.current.submit(
        {
          apiVersion: 1,
          selectionGeneration: pending.selectionGeneration,
          text,
          locale: current.locale,
          expectedDraftRevision: pending.expectedDraftRevision,
        },
        { csrfToken: current.session.snapshot.csrfToken, idempotencyKey },
      );
      // The 202 accepted representation is never appended locally; the
      // bounded /state + /status poll owns all subsequent read-back.
    } catch (error) {
      if (error instanceof TavernProblemError && !error.retryable) {
        // Durable rejection (draft/idempotency/selection conflict): the
        // attempt is not in flight; clear the pending key and surface the
        // problem. Never retry with the same key automatically.
        commit({ ...current, session: current.session.withPending(null) });
        commit(problemView(error, messages(current.locale)));
        return;
      }
      // Retryable problem or network failure: keep the pending key; the poll
      // reconciles through readSubmissionStatus and never re-sends.
    }
    startPolling();
  };

  const reread = async (): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const snapshot = await apiRef.current.readState();
    const draft = await apiRef.current.readDraft();
    if (snapshot.chat === null || draft.revision !== snapshot.chat.draft.revision)
      throw new ReferencePipelineSessionError("state_reconciliation_required");
    setPreview(null);
    commit({ ...current, session: current.session.applySnapshot(snapshot), draft });
  };

  const handleStop = async (): Promise<void> => {
    const current = viewRef.current;
    const turn = current.kind === "ready" ? current.session.snapshot.chat?.turn : null;
    const operation = current.kind === "ready"
      ? current.session.snapshot.operations.find((op) => op.operationId === "chat.cancel")
      : undefined;
    if (current.kind !== "ready" || turn == null || operation?.availability !== "available" || !turn.canCancel) return;
    const selection = current.session.snapshot.selection;
    if (selection === null) return;
    try {
      await apiRef.current.cancel(
        turn.handle,
        { apiVersion: 1, selectionGeneration: selection.generation },
        current.session.snapshot.csrfToken,
      );
      await reread();
    } catch (error) {
      try {
        await reread();
      } catch {
        commit(problemView(error, messages(current.locale)));
      }
    }
  };

  const submitAvailable =
    view.kind === "ready" &&
    view.session.pending === null &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.submit" && op.availability === "available");
  const stopAvailable =
    view.kind === "ready" &&
    view.session.snapshot.chat?.turn?.canCancel === true &&
    view.session.snapshot.operations.some((op) => op.operationId === "chat.cancel" && op.availability === "available");
  const terminalTurnNotice =
    view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "cancelled"
      ? labels().chatStopped
      : view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "failed"
        ? labels().chatFailed
        : null;

  return (
    <div className="tavern-app-shell" data-profile="reference-pipeline">
      <SkipLink label={labels().skipToChat} />

      {view.kind === "loading" && (
        <main id="main-content" className="app-main-content">
          <div className="state-placeholder">
            <p className="loading-text">{labels().openingChat}</p>
          </div>
        </main>
      )}

      {view.kind === "problem" && <ProblemView title={view.title} detail={view.detail} />}

      {view.kind === "ready" && view.session.snapshot.chat !== null && (
        <>
          <header className="app-bar">
            <div className="app-bar-title">{view.session.snapshot.chat.companion.name}</div>
          </header>
          <main id="main-content" className="app-main-content">
            <Timeline
              transcript={view.session.snapshot.chat.transcript}
              preview={preview}
              companionName={view.session.snapshot.chat.companion.name}
              chatTitle={view.session.snapshot.chat.title}
              labels={labels()}
            />
            {terminalTurnNotice !== null && (
              <p className="reference-turn-notice" role="status">{terminalTurnNotice}</p>
            )}
            <section className="reference-draft-section" aria-label={labels().savedDraft}>
              {view.session.snapshot.chat.draft.present && view.draft.text !== null ? (
                <p>{view.draft.text}</p>
              ) : (
                <p>{labels().noSavedDraft}</p>
              )}
            </section>
            <Composer
              value={inputText}
              onChange={setInputText}
              onSend={() => {
                void handleSend();
              }}
              onStop={() => {
                void handleStop();
              }}
              isGenerating={stopAvailable}
              disabled={!submitAvailable}
              labels={labels()}
            />
          </main>
        </>
      )}
    </div>
  );
}

function problemView(error: unknown, labels: ReturnType<typeof messages>): ProblemViewState {
  if (error instanceof TavernProblemError && error.retryable) {
    return {
      kind: "problem",
      title: labels.problemTemporarilyUnavailableTitle,
      detail: labels.problemTemporarilyUnavailableDetail,
    };
  }
  return {
    kind: "problem",
    title: labels.problemReconciliationFailedTitle,
    detail: labels.problemReconciliationFailedDetail,
  };
}
