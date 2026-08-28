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
} from "../reference-pipeline-api";
import {
  applyStatus,
  createReferencePipelineSession,
  type PendingSubmission,
  pendingSubmission,
  type ReferencePipelineSession,
  ReferencePipelineSessionError,
} from "../reference-pipeline-session";
import {
  createComposedReferenceGameBrowserApi,
  type ComposedReferenceGameBrowserRootV1,
  type GameBrowserStateV1,
  type StardewCabinChoiceV1,
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
} from "../composed-reference-game-browser-api";
import { Composer } from "./Composer";
import { ProblemView } from "./ProblemView";
import { SkipLink } from "./SkipLink";
import { Timeline } from "./Timeline";


const POLL_FIRST_MS = 250;
const POLL_INTERVAL_MS = 1_000;
const POLL_BACKOFF_MS = [1_000, 2_000, 4_000, 5_000] as const;
const MAX_POLL_ATTEMPTS = 60;
const TERMINAL_TURN_STATES = new Set(["completed", "cancelled", "failed"]);

type ReadyView = Readonly<{
  kind: "ready";
  root: ComposedReferenceGameBrowserRootV1;
  session: ReferencePipelineSession;
  draft: BrowserDraftV1;
  locale: Locale;
}>;
type ProblemViewState = Readonly<{ kind: "problem"; title: string; detail: string }>;
type ViewState = Readonly<{ kind: "loading" }> | ReadyView | ProblemViewState;
type CabinViewState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "choices"; choices: readonly StardewCabinChoiceV1[] }>
  | Readonly<{ kind: "confirming"; choices: readonly StardewCabinChoiceV1[]; choiceHandle: string }>
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "uncertain" }>
  | Readonly<{ kind: "unavailable" }>;

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

/**
 * Same-origin composed reference-game shell. The composed root is the only
 * authority used to refresh either projection; the nested Reference pipeline
 * client remains the sole Chat mutation/events client.
 */
export function ComposedReferenceGameApp() {
  const composedApiRef = useRef(createComposedReferenceGameBrowserApi());
  const tavernApiRef = useRef(createReferencePipelineApi());
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const viewRef = useRef<ViewState>({ kind: "loading" });
  const [inputText, setInputText] = useState("");
  const [preview, setPreview] = useState<Readonly<{ turnHandle: string; text: string }> | null>(null);
  const localeRef = useRef<Locale>(resolveLocale());
  const cancelledRef = useRef(false);
  const pollActiveRef = useRef(false);
  const eventSourceRef = useRef<{ close(): void } | null>(null);
  const [cabinView, setCabinView] = useState<CabinViewState>({ kind: "loading" });
  const cabinConfirmationActiveRef = useRef(false);
  const cabinIdempotencyKeysRef = useRef(new Map<string, string>());

  const commit = useCallback((next: ViewState): void => {
    viewRef.current = next;
    setView(next);
  }, []);

  const labels = () => messages(view.kind === "ready" ? view.locale : localeRef.current);

  useEffect(() => {
    applyDocumentLocale(localeRef.current);
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    let active = true;
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const bootToken = params.get("boot");
        const root = bootToken === null
          ? await composedApiRef.current.readState()
          : await composedApiRef.current.bootstrap(bootToken);
        if (bootToken !== null) {
          const url = new URL(window.location.href);
          url.hash = "profile=composed-reference-game";
          window.history.replaceState(null, "", url.toString());
        }
        const draft = await tavernApiRef.current.readDraft();
        if (
          root.chat.chat === null ||
          draft.revision !== root.chat.chat.draft.revision ||
          (draft.text !== null) !== root.chat.chat.draft.present
        ) {
          throw new ReferencePipelineSessionError("state_reconciliation_required");
        }
        if (!active) return;
        const session = createReferencePipelineSession(root.chat);
        setPreview(null);
        commit({ kind: "ready", root, session, draft, locale: localeRef.current });
      } catch (error) {
        if (active) commit(problemView(error, messages(localeRef.current)));
      }
    })();
    return () => {
      active = false;
      cancelledRef.current = true;
    };
  }, [commit]);

  const eventStreamEpoch = view.kind === "ready" ? view.session.snapshot.eventStream?.epoch : undefined;

  const readCabins = useCallback(async (): Promise<void> => {
    setCabinView({ kind: "loading" });
    try {
      const result = await composedApiRef.current.readStardewCabins();
      cabinIdempotencyKeysRef.current = new Map(
        result.choices.map((choice) => [choice.choiceHandle, newIdempotencyKey()]),
      );
      setCabinView({ kind: "choices", choices: result.choices });
    } catch {
      setCabinView({ kind: "unavailable" });
    }
  }, []);

  useEffect(() => {
    if (view.kind !== "ready") return;
    void readCabins();
  }, [view.kind, readCabins]);

  useEffect(() => {
    if (view.kind !== "ready" || view.session.snapshot.eventStream === null) return;
    let disposed = false;
    let recovering = false;
    let work = Promise.resolve();
    let cursor = view.session.snapshot.eventStream.cursor;
    let pendingResetCursor = false;

    const closeSource = (): void => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
    const recover = async (resetCursor = false): Promise<void> => {
      if (resetCursor) pendingResetCursor = true;
      if (disposed || recovering) return;
      recovering = true;
      closeSource();
      try {
        const doReset = pendingResetCursor;
        pendingResetCursor = false;
        const root = await composedApiRef.current.readState();
        const draft = await tavernApiRef.current.readDraft();
        if (disposed) return;
        const current = viewRef.current;
        if (current.kind !== "ready" || root.chat.chat === null) return;
        const epochChanged = root.chat.eventStream?.epoch !== current.session.snapshot.eventStream?.epoch;
        let session = current.session.applySnapshot(root.chat);
        if (
          draft.revision !== root.chat.chat.draft.revision ||
          (draft.text !== null) !== root.chat.chat.draft.present
        ) throw new ReferencePipelineSessionError("state_reconciliation_required");
        if (doReset || epochChanged) {
          if (root.chat.eventStream === null) throw new ReferencePipelineSessionError("stream_resync_required");
          cursor = root.chat.eventStream.cursor;
          session = session.resetEventCheckpoint();
        }
        setPreview(null);
        commit({ kind: "ready", root, session, draft, locale: current.locale });
      } catch (error) {
        if (!disposed) commit(problemView(error, messages(localeRef.current)));
      } finally {
        recovering = false;
        if (pendingResetCursor && !disposed) void recover(true);
        else if (!disposed && viewRef.current.kind === "ready") connect();
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
            setPreview((existing) => Object.freeze({
              turnHandle: event.payload.turnHandle,
              text: existing?.turnHandle === event.payload.turnHandle
                ? `${existing.text}${event.payload.delta}`
                : event.payload.delta,
            }));
            return;
          }
          if (event.eventType === "message.committed" || event.eventType === "turn.state_changed") setPreview(null);
          const root = await composedApiRef.current.readState();
          const draft = await tavernApiRef.current.readDraft();
          if (disposed || root.chat.chat === null) return;
          if (
            draft.revision !== root.chat.chat.draft.revision ||
            (draft.text !== null) !== root.chat.chat.draft.present
          ) throw new ReferencePipelineSessionError("state_reconciliation_required");
          const session = checkpointed.applySnapshot(root.chat);
          setPreview(null);
          commit({ kind: "ready", root, session, draft, locale: current.locale });
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
          onError: () => void recover(),
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
      attempts += 1;
      if (attempts > MAX_POLL_ATTEMPTS) {
        pollActiveRef.current = false;
        return;
      }
      const pending = current.session.pending;
      try {
        const root = await composedApiRef.current.readState();
        const draft = await tavernApiRef.current.readDraft();
        if (
          root.chat.chat === null ||
          draft.revision !== root.chat.chat.draft.revision ||
          (draft.text !== null) !== root.chat.chat.draft.present
        ) {
          throw new ReferencePipelineSessionError("state_reconciliation_required");
        }
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
        commit(next);
        if (terminalTurn(root.chat.chat?.turn ?? null) || session.pending === null) {
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
        const backoff = POLL_BACKOFF_MS[Math.min(attempts, POLL_BACKOFF_MS.length) - 1] ?? POLL_BACKOFF_MS[POLL_BACKOFF_MS.length - 1];
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
      await tavernApiRef.current.submit(
        {
          apiVersion: 1,
          selectionGeneration: pending.selectionGeneration,
          text,
          locale: current.locale,
          expectedDraftRevision: pending.expectedDraftRevision,
        },
        { csrfToken: current.session.snapshot.csrfToken, idempotencyKey },
      );
    } catch (error) {
      if (error instanceof TavernProblemError && !error.retryable) {
        commit({ ...current, session: current.session.withPending(null) });
        commit(problemView(error, messages(current.locale)));
        return;
      }
    }
    startPolling();
  };

  const reread = async (): Promise<void> => {
    const current = viewRef.current;
    if (current.kind !== "ready") return;
    const root = await composedApiRef.current.readState();
    const draft = await tavernApiRef.current.readDraft();
    if (root.chat.chat === null || draft.revision !== root.chat.chat.draft.revision || (draft.text !== null) !== root.chat.chat.draft.present) {
      throw new ReferencePipelineSessionError("state_reconciliation_required");
    }
    setPreview(null);
    commit({ ...current, root, session: current.session.applySnapshot(root.chat), draft });
  };

  const handleCabinConfirmation = async (choice: StardewCabinChoiceV1): Promise<void> => {
    if (cabinConfirmationActiveRef.current || cabinView.kind !== "choices") return;
    if (choice.expiresAtMs <= Date.now()) {
      void readCabins();
      return;
    }
    const idempotencyKey = cabinIdempotencyKeysRef.current.get(choice.choiceHandle);
    if (idempotencyKey === undefined) {
      setCabinView({ kind: "unavailable" });
      return;
    }
    cabinConfirmationActiveRef.current = true;
    setCabinView({ kind: "confirming", choices: cabinView.choices, choiceHandle: choice.choiceHandle });
    try {
      await composedApiRef.current.confirmStardewCabin({
        apiVersion: 1,
        idempotencyKey,
        choiceHandle: choice.choiceHandle,
        confirmed: true,
      });
      setCabinView({ kind: "admitted" });
    } catch (error) {
      if (
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "stardew_cabin_choice_stale"
      ) {
        cabinConfirmationActiveRef.current = false;
        await readCabins();
        return;
      }
      // An explicit uncertain outcome or a missing/malformed response may have
      // followed successful publication. Never refetch or replay this command.
      setCabinView({ kind: "uncertain" });
    }
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
      await tavernApiRef.current.cancel(
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

  const submitAvailable = view.kind === "ready" && view.session.pending === null && view.session.snapshot.operations.some((op) => op.operationId === "chat.submit" && op.availability === "available");
  const stopAvailable = view.kind === "ready" && view.session.snapshot.chat?.turn?.canCancel === true && view.session.snapshot.operations.some((op) => op.operationId === "chat.cancel" && op.availability === "available");
  const terminalTurnNotice = view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "cancelled"
    ? labels().chatStopped
    : view.kind === "ready" && view.session.snapshot.chat?.turn?.state === "failed" ? labels().chatFailed : null;

  return (
    <div className="tavern-app-shell" data-profile="composed-reference-game">
      <SkipLink label={labels().skipToChat} />
      {view.kind === "loading" && <main id="main-content" className="app-main-content"><div className="state-placeholder"><p className="loading-text">{labels().openingChat}</p></div></main>}
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
             {terminalTurnNotice !== null && <p className="reference-turn-notice" role="status">{terminalTurnNotice}</p>}
             <section className="reference-draft-section" aria-label={labels().savedDraft}>
               {view.session.snapshot.chat.draft.present && view.draft.text !== null ? (
                 <p>{view.draft.text}</p>
               ) : (
                 <p>{labels().noSavedDraft}</p>
               )}
             </section>
              <section className="composed-game-drawer" aria-label={labels().gameState}>
               <GameProjection game={view.root.game} />
               <StardewCabinHandoff
                 state={cabinView}
                 labels={labels()}
                 onConfirm={(choice) => void handleCabinConfirmation(choice)}
               />
             </section>
            <Composer
              value={inputText}
              onChange={setInputText}
              onSend={() => void handleSend()}
              onStop={() => void handleStop()}
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

function StardewCabinHandoff({
  state,
  labels,
  onConfirm,
}: {
  state: CabinViewState;
  labels: ReturnType<typeof messages>;
  onConfirm(choice: StardewCabinChoiceV1): void;
}) {
  return (
    <section className="stardew-cabin-handoff" aria-label={labels.stardewCabinSelection}>
      <h3>{labels.stardewCabinSelection}</h3>
      {state.kind === "loading" && <p>{labels.stardewCabinsLoading}</p>}
      {state.kind === "unavailable" && <p role="status">{labels.stardewCabinsUnavailable}</p>}
      {state.kind === "uncertain" && <p role="status">{labels.stardewCabinConfirmationUncertain}</p>}
      {state.kind === "admitted" && <p role="status">{labels.stardewManifestAdmitted}</p>}
      {(state.kind === "choices" || state.kind === "confirming") && (
        state.choices.length === 0 ? <p>{labels.stardewCabinsEmpty}</p> : (
          <ul>
            {state.choices.map((choice) => (
              <li key={choice.choiceHandle}>
                <span>{choice.displayLabel}</span>
                <button
                  type="button"
                  disabled={state.kind === "confirming"}
                  onClick={() => onConfirm(choice)}
                >
                  {labels.stardewCabinConfirm}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

function GameProjection({ game }: { game: GameBrowserStateV1 | null }) {
  if (game === null) {
    return <div className="game-projection" data-game-state="null"><h2>Game</h2><p>Game state is unavailable for this profile.</p></div>;
  }
  const projection = game.game;
  return (
    <div className="game-projection" data-game-state="available">
      <h2>Game</h2>
      <dl>
        <div><dt>Connection</dt><dd>{projection.connectionStatus}</dd></div>
        <div><dt>Instance</dt><dd>{projection.instance.gameTitle ?? projection.instance.status}</dd></div>
        <div><dt>World</dt><dd>{projection.selectedWorld ?? "—"}</dd></div>
        <div><dt>Save</dt><dd>{projection.selectedSave ?? "—"}</dd></div>
        <div><dt>Compatibility</dt><dd>{projection.compatibility.message ?? projection.compatibility.status}</dd></div>
        <div><dt>Capabilities</dt><dd>{projection.capabilitySummary.available ? projection.capabilitySummary.count : "unavailable"}</dd></div>
      </dl>
    </div>
  );
}

function problemView(error: unknown, labels: ReturnType<typeof messages>): ProblemViewState {
  if ((error instanceof TavernProblemError || error instanceof ComposedReferenceGameProblemError) && error.retryable) {
    return { kind: "problem", title: labels.problemTemporarilyUnavailableTitle, detail: labels.problemTemporarilyUnavailableDetail };
  }
  return { kind: "problem", title: labels.problemReconciliationFailedTitle, detail: labels.problemReconciliationFailedDetail };
}
