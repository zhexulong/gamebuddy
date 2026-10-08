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
  type GameCreateRequestV1,
  type GameCreateResultV1,
  type GameResumeResultV1,
  type StardewCabinChoiceV1,
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
} from "../composed-reference-game-browser-api";
import { composedProblemView as problemView, type ProblemViewState } from "../composed-problem-view";
import { deriveGameLifecycleControlAvailability } from "../game-lifecycle-controls";
import { Composer } from "./Composer";
import { GameStatePanel, type CabinViewState } from "./GameStatePanel";
import { ProblemView } from "./ProblemView";
import { SkipLink } from "./SkipLink";
import { Timeline } from "./Timeline";
import { StardewInstallationDiscovery } from "./StardewInstallationDiscovery";


const POLL_FIRST_MS = 250;
const POLL_INTERVAL_MS = 1_000;
const POLL_BACKOFF_MS = [1_000, 2_000, 4_000, 5_000] as const;
const MAX_POLL_ATTEMPTS = 60;
const TERMINAL_TURN_STATES = new Set(["completed", "cancelled", "failed"]);

/**
 * Bounded authoritative reread budget while an admitted `game.resume` or
 * `game.reopen` is converging. `accepted`/`attached`/`reopened` transport
 * results are never runtime success: the composed authoritative Game
 * projection is the sole terminal authority. This budget fails an unconverged
 * attempt over to the existing unavailable presentation (exact generation key
 * preserved) instead of ever clearing in-flight early and re-enabling a
 * duplicate command.
 */
const RESUME_REREAD_INTERVAL_MS = 500;
const RESUME_REREAD_MAX_ATTEMPTS = 60;

/**
 * Redacted connection presentations that were attached and then dropped in a
 * way a player may recover with the generation-bound `game.resume` command.
 * `reconnecting` is already under backend recovery, and `stopped` is the
 * deliberate end state after STOP, so neither is player-resumable here.
 */
const RESUMABLE_CONNECTION_STATUSES: ReadonlySet<string> = new Set(["failed", "disconnected"]);

const STARDEW_GAME_INTEGRATION_ID = "stardew" as const;

type ReadyView = Readonly<{
  kind: "ready";
  root: ComposedReferenceGameBrowserRootV1;
  session: ReferencePipelineSession;
  draft: BrowserDraftV1;
  locale: Locale;
}>;
type ViewState = Readonly<{ kind: "loading" }> | ReadyView | ProblemViewState;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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
  const gameActivationActiveRef = useRef(false);
  const [gameActivationActive, setGameActivationActive] = useState(false);
  const [gameActivationFailed, setGameActivationFailed] = useState(false);
  const [gameActivationUnavailable, setGameActivationUnavailable] = useState(false);
  const gameSetupActiveRef = useRef(false);
  const gameSetupKeyRef = useRef<string | undefined>(undefined);
  const [gameSetupActive, setGameSetupActive] = useState(false);
  const [gameSetupFailed, setGameSetupFailed] = useState(false);
  const [gameSetupNotStaged, setGameSetupNotStaged] = useState(false);
  const gameStopActiveRef = useRef(false);
  const gameStopKeysRef = useRef(new Map<number, string>());
  const [gameStopActive, setGameStopActive] = useState(false);
  const [gameStopFailed, setGameStopFailed] = useState(false);
  const gameLaunchActiveRef = useRef(false);
  const gameLaunchKeysRef = useRef(new Map<number, string>());
  const [gameLaunchActive, setGameLaunchActive] = useState(false);
  const [gameLaunchFailed, setGameLaunchFailed] = useState(false);
  const [gameLaunchNotStaged, setGameLaunchNotStaged] = useState(false);
  const disconnectActiveRef = useRef(false);
  const disconnectKeysRef = useRef(new Map<number, string>());
  const [disconnectActive, setDisconnectActive] = useState(false);
  const [disconnectFailed, setDisconnectFailed] = useState(false);
  const gameResumeActiveRef = useRef(false);
  const gameResumeKeysRef = useRef(new Map<number, string>());
  const [gameResumeActive, setGameResumeActive] = useState(false);
  const [gameResumeFailed, setGameResumeFailed] = useState(false);
  const [gameResumeUnavailable, setGameResumeUnavailable] = useState(false);
  const gameReopenActiveRef = useRef(false);
  const gameReopenKeysRef = useRef(new Map<number, string>());
  const [gameReopenActive, setGameReopenActive] = useState(false);
  const [gameReopenFailed, setGameReopenFailed] = useState(false);
  const [gameReopenUnavailable, setGameReopenUnavailable] = useState(false);
  const gameResumeCancelActiveRef = useRef(false);
  const gameResumeCancelKeysRef = useRef(new Map<number, string>());
  const [gameResumeCancelActive, setGameResumeCancelActive] = useState(false);
  const [gameResumeCancelFailed, setGameResumeCancelFailed] = useState(false);
  const gameCreateActiveRef = useRef(false);
  const [gameCreateActive, setGameCreateActive] = useState(false);
  const [gameCreateFailed, setGameCreateFailed] = useState(false);
  const [gameCreateUnavailable, setGameCreateUnavailable] = useState(false);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [continuityIdentityInput, setContinuityIdentityInput] = useState("");
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

  /**
   * The coordinator refuses a first-run command whose lifecycle is not staged
   * yet with `stardew_player_host_launch_not_staged`. On exactly the
   * `game/prerequisites/setup` and `game/launch` routes that error is the only
   * one mapped to the wire code `game_prerequisites_missing`, so on those routes
   * the code IS the not-staged reason and must never be rendered as a generic
   * failure.
   */
  const isNotStagedRefusal = (error: unknown): boolean =>
    error instanceof ComposedReferenceGameProblemError &&
    error.code === "game_prerequisites_missing";

  /**
   * First-run lifecycle activation. The composed Game projection carries no
   * activation field of its own: the coordinator's `staged` state reaches the
   * browser only as the launch-readiness shape (`prerequisites` met, `instance`
   * none, exact expected generation >= 1). This control is offered in exactly
   * that shape's pre-image and the coordinator's own refusal is the only other
   * signal the client has. It sends no body; the route refuses one with 409.
   */
  const handleLifecycleActivate = async (): Promise<void> => {
    const current = viewRef.current;
    if (gameActivationActiveRef.current || current.kind !== "ready") return;
    // The click-time re-check is the same derivation the control is offered
    // from, so a control can never be offered in a state its own handler refuses.
    if (!deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game }).activationAvailable) return;
    gameActivationActiveRef.current = true;
    setGameActivationActive(true);
    setGameActivationFailed(false);
    setGameActivationUnavailable(false);
    try {
      await composedApiRef.current.activateLifecycle();
      await reread();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      // A conflict only means something already activated this lifecycle: the
      // authoritative projection decides, so it is a failure only when staging
      // is still not visible after the reread.
      const staged = rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game !== null &&
        fresh.root.game.game.instance.generation >= 1;
      if (!staged) {
        if (error instanceof ComposedReferenceGameProblemError && error.code === "not_found")
          setGameActivationUnavailable(true);
        else setGameActivationFailed(true);
      }
    } finally {
      gameActivationActiveRef.current = false;
      setGameActivationActive(false);
    }
  };

  const handleGameSetup = async (): Promise<void> => {
    const current = viewRef.current;
    if (gameSetupActiveRef.current || current.kind !== "ready") return;
    if (!deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game }).setupAvailable) return;
    const idempotencyKey = gameSetupKeyRef.current ?? newIdempotencyKey();
    gameSetupKeyRef.current = idempotencyKey;
    gameSetupActiveRef.current = true;
    setGameSetupActive(true);
    setGameSetupFailed(false);
    setGameSetupNotStaged(false);
    try {
      await composedApiRef.current.setupGame({ apiVersion: 1, idempotencyKey });
      await reread();
      if (viewRef.current.kind === "ready" && viewRef.current.root.game?.game.prerequisites.status === "unknown")
        gameSetupKeyRef.current = undefined;
    } catch (error) {
      const notStaged = isNotStagedRefusal(error);
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch {
        // Preserve the original key while the command outcome is uncertain.
      }
      setGameSetupNotStaged(notStaged);
      setGameSetupFailed(!notStaged);
      const latest = viewRef.current;
      if (
        !notStaged &&
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_unavailable" &&
        rereadSucceeded &&
        latest.kind === "ready" &&
        latest.root.game?.game.prerequisites.status === "unknown" &&
        latest.root.game.game.instance.status === "none"
      ) gameSetupKeyRef.current = undefined;
    } finally {
      gameSetupActiveRef.current = false;
      setGameSetupActive(false);
    }
  };

  const handleGameStop = async (): Promise<void> => {
    const current = viewRef.current;
    const game = current.kind === "ready" ? current.root.game : null;
    if (
      gameStopActiveRef.current ||
      current.kind !== "ready" ||
      game === null ||
      game.game.attachment.status !== "attached" ||
      game.game.attachment.generation < 1 ||
      game.game.connectionStatus !== "connected_idle"
    ) return;
    const generation = game.game.attachment.generation;
    const existingKey = gameStopKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameStopKeysRef.current.set(generation, idempotencyKey);
    gameStopActiveRef.current = true;
    setGameStopActive(true);
    setGameStopFailed(false);
    try {
      await composedApiRef.current.stopGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      await reread();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      setGameStopFailed(!staleGenerationReconciled);
    } finally {
      gameStopActiveRef.current = false;
      setGameStopActive(false);
    }
  };

  const handleGameLaunch = async (): Promise<void> => {
    const current = viewRef.current;
    if (gameLaunchActiveRef.current || current.kind !== "ready") return;
    const controls = deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game });
    if (!controls.launchAvailable || controls.launchGeneration === null) return;
    const generation = controls.launchGeneration;
    const existingKey = gameLaunchKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameLaunchKeysRef.current.set(generation, idempotencyKey);
    gameLaunchActiveRef.current = true;
    setGameLaunchActive(true);
    setGameLaunchFailed(false);
    setGameLaunchNotStaged(false);
    try {
      await composedApiRef.current.launchGame({
        apiVersion: 1,
        idempotencyKey,
        expectedInstanceGeneration: generation,
      });
      await reread();
    } catch (error) {
      const notStaged = isNotStagedRefusal(error);
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      if (
        !notStaged &&
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_unavailable" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game !== null &&
        (fresh.root.game.game.prerequisites.status !== "met" ||
          fresh.root.game.game.instance.generation < 1)
      ) {
        gameLaunchKeysRef.current.delete(generation);
        gameSetupKeyRef.current = undefined;
      }
      setGameLaunchNotStaged(notStaged);
      setGameLaunchFailed(!notStaged);
    } finally {
      gameLaunchActiveRef.current = false;
      setGameLaunchActive(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    const current = viewRef.current;
    const game = current.kind === "ready" ? current.root.game : null;
    if (
      disconnectActiveRef.current ||
      current.kind !== "ready" ||
      game === null ||
      game.game.attachment.status !== "attached" ||
      !current.root.game?.game ||
      game.game.attachment.generation < 1
    ) return;
    const generation = game.game.attachment.generation;
    const existingKey = disconnectKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    disconnectKeysRef.current.set(generation, idempotencyKey);
    disconnectActiveRef.current = true;
    setDisconnectActive(true);
    setDisconnectFailed(false);
    try {
      await composedApiRef.current.disconnectGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      await reread();
    } catch {
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      if (
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.status === "attached" &&
        fresh.root.game.game.attachment.generation === generation &&
        fresh.root.game.game.connectionStatus === "failed"
      ) disconnectKeysRef.current.delete(generation);
      setDisconnectFailed(true);
    } finally {
      disconnectActiveRef.current = false;
    setDisconnectActive(false);
    }
  };

  /**
   * Bounded authoritative rereads for one admitted `game.resume`. A transport
   * `accepted`/`attached` result is never treated as runtime success; the
   * attempt stays visibly in flight until the composed authoritative Game
   * state converges at the same attachment generation (connected), a
   * newer/conflicting generation supersedes the attempt, or the bounded budget
   * expires (unavailable; the exact generation key is preserved for replay).
   */
  const resumeAwaitAuthoritative = async (
    generation: number,
    attempts: number,
  ): Promise<"connected" | "superseded" | "unavailable"> => {
    if (cancelledRef.current || attempts > RESUME_REREAD_MAX_ATTEMPTS) return "unavailable";
    try {
      await reread();
    } catch {
      if (cancelledRef.current) return "unavailable";
      // An inconclusive authoritative read never completes the resume; keep
      // rereading inside the bounded budget.
      await delay(RESUME_REREAD_INTERVAL_MS);
      return resumeAwaitAuthoritative(generation, attempts + 1);
    }
    const fresh = viewRef.current;
    if (fresh.kind !== "ready" || fresh.root.game === null) return "superseded";
    const projection = fresh.root.game.game;
    if (projection.attachment.generation !== generation) return "superseded";
    if (
      projection.attachment.status === "attached" &&
      (projection.connectionStatus === "connected_idle" || projection.connectionStatus === "active")
    ) return "connected";
    await delay(RESUME_REREAD_INTERVAL_MS);
    return resumeAwaitAuthoritative(generation, attempts + 1);
  };

  const handleGameResume = async (): Promise<void> => {
    const current = viewRef.current;
    const game = current.kind === "ready" ? current.root.game : null;
    if (
      gameResumeActiveRef.current ||
      current.kind !== "ready" ||
      game === null ||
      game.game.attachment.status !== "attached" ||
      game.game.attachment.generation < 1 ||
      !RESUMABLE_CONNECTION_STATUSES.has(game.game.connectionStatus)
    ) return;
    const generation = game.game.attachment.generation;
    const existingKey = gameResumeKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameResumeKeysRef.current.set(generation, idempotencyKey);
    gameResumeActiveRef.current = true;
    setGameResumeActive(true);
    setGameResumeFailed(false);
    setGameResumeUnavailable(false);
    let outcome: GameResumeResultV1 | undefined;
    try {
      outcome = await composedApiRef.current.resumeGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      setGameResumeFailed(!staleGenerationReconciled);
      gameResumeActiveRef.current = false;
      setGameResumeActive(false);
      return;
    }
    if (outcome === undefined) {
      gameResumeActiveRef.current = false;
      setGameResumeActive(false);
      return;
    }
    if (outcome.status === "unavailable") {
      // No side effect is known from this attempt; a single authoritative
      // reread cannot confirm completion. The exact generation key stays so a
      // player retry replays the same idempotent command.
      try {
        await reread();
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      if (
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.status === "attached" &&
        fresh.root.game.game.attachment.generation === generation
      ) setGameResumeUnavailable(true);
      gameResumeActiveRef.current = false;
      setGameResumeActive(false);
      return;
    }
    // `accepted`/`attached` are transport admissions only and never runtime
    // success. Keep the resume visibly in flight while bounded authoritative
    // rereads converge, a newer/conflicting generation supersedes the attempt,
    // or the bounded budget runs out (rendered as unavailable with the exact
    // generation key preserved).
    let convergence: "connected" | "superseded" | "unavailable";
    try {
      convergence = await resumeAwaitAuthoritative(generation, 1);
    } catch {
      convergence = "unavailable";
    }
    if (convergence === "unavailable") setGameResumeUnavailable(true);
    gameResumeActiveRef.current = false;
    setGameResumeActive(false);
  };

  /**
   * Bounded authoritative rereads for one admitted `game.reopen`. The strict
   * `reopened` result only exists on the exact same attachment generation; keep
   * the attempt visibly in flight until the composed authoritative Game
   * projection shows the paused action authority reopened to `active` at that
   * generation, a newer/conflicting generation supersedes the attempt, or the
   * bounded budget expires (unavailable; the exact generation key is preserved
   * for replay). Reopen never touches old task/facade/lease or attachment
   * machinery, so only the action-authority flip is awaited.
   */
  const reopenAwaitAuthoritative = async (
    generation: number,
    attempts: number,
  ): Promise<"active" | "superseded" | "unavailable"> => {
    if (cancelledRef.current || attempts > RESUME_REREAD_MAX_ATTEMPTS) return "unavailable";
    try {
      await reread();
    } catch {
      if (cancelledRef.current) return "unavailable";
      // An inconclusive authoritative read never completes the reopen; keep
      // rereading inside the bounded budget.
      await delay(RESUME_REREAD_INTERVAL_MS);
      return reopenAwaitAuthoritative(generation, attempts + 1);
    }
    const fresh = viewRef.current;
    if (fresh.kind !== "ready" || fresh.root.game === null) return "superseded";
    const projection = fresh.root.game.game;
    if (projection.attachment.generation !== generation) return "superseded";
    if (
      projection.attachment.status === "attached" &&
      projection.actionAuthority === "active"
    ) return "active";
    await delay(RESUME_REREAD_INTERVAL_MS);
    return reopenAwaitAuthoritative(generation, attempts + 1);
  };

  const handleGameReopen = async (): Promise<void> => {
    const current = viewRef.current;
    const game = current.kind === "ready" ? current.root.game : null;
    // ready-actions-paused is the exact precondition: connected_idle equals a
    // live observation surface, actionAuthority "paused" means only a new
    // explicit Game instruction may reopen action admission. Never approximate
    // it with the connection status alone.
    if (
      gameReopenActiveRef.current ||
      current.kind !== "ready" ||
      game === null ||
      game.game.actionAuthority !== "paused" ||
      game.game.attachment.status !== "attached" ||
      game.game.attachment.generation < 1 ||
      game.game.connectionStatus !== "connected_idle"
    ) return;
    const generation = game.game.attachment.generation;
    const existingKey = gameReopenKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameReopenKeysRef.current.set(generation, idempotencyKey);
    gameReopenActiveRef.current = true;
    setGameReopenActive(true);
    setGameReopenFailed(false);
    setGameReopenUnavailable(false);
    try {
      await composedApiRef.current.reopenGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      setGameReopenFailed(!staleGenerationReconciled);
      gameReopenActiveRef.current = false;
      setGameReopenActive(false);
      return;
    }
    // The strict `reopened` result is still not runtime success on its own: the
    // composed authoritative Game projection at the exact same attachment
    // generation must show the action authority reopened to `active`. Keep the
    // attempt visibly in flight while bounded rereads converge, a newer
    // generation supersedes the attempt, or the bounded budget expires
    // (unavailable; the exact generation key stays for an idempotent replay).
    let convergence: "active" | "superseded" | "unavailable";
    try {
      convergence = await reopenAwaitAuthoritative(generation, 1);
    } catch {
      convergence = "unavailable";
    }
    if (convergence === "unavailable") setGameReopenUnavailable(true);
    gameReopenActiveRef.current = false;
    setGameReopenActive(false);
  };

  /**
   * `game.resume.cancel` for the failed/unavailable resume surface. The cancel
   * pins the exact in-flight reconnect epoch by armed attachment generation; a
   * successful `cancelled` result settles the epoch server-side before it
   * returns, so one authoritative reread shows the disconnected projection
   * (the session stays resumable, the generation keeps its armed value). A
   * stale generation reconciles silently; any other failure is presented
   * fail-closed. The Player world and durable session state are never touched.
   */
  const handleGameResumeCancel = async (): Promise<void> => {
    const current = viewRef.current;
    const game = current.kind === "ready" ? current.root.game : null;
    if (
      gameResumeCancelActiveRef.current ||
      current.kind !== "ready" ||
      game === null ||
      game.game.attachment.status !== "attached" ||
      game.game.attachment.generation < 1 ||
      !RESUMABLE_CONNECTION_STATUSES.has(game.game.connectionStatus) ||
      (!gameResumeFailed && !gameResumeUnavailable)
    ) return;
    const generation = game.game.attachment.generation;
    const existingKey = gameResumeCancelKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameResumeCancelKeysRef.current.set(generation, idempotencyKey);
    gameResumeCancelActiveRef.current = true;
    setGameResumeCancelActive(true);
    setGameResumeCancelFailed(false);
    try {
      await composedApiRef.current.cancelResume({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      try {
        await reread();
      } catch { /* retain the current authoritative projection */ }
      setGameResumeFailed(false);
      setGameResumeUnavailable(false);
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await reread();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = viewRef.current;
      const staleGenerationReconciled =
        error instanceof ComposedReferenceGameProblemError &&
        error.code === "game_attachment_conflict" &&
        rereadSucceeded &&
        fresh.kind === "ready" &&
        fresh.root.game?.game.attachment.generation !== generation;
      if (staleGenerationReconciled) {
        // The reconnect epoch already ended under a newer attachment: there is
        // nothing to cancel, so the stale failure surface is cleared.
        setGameResumeFailed(false);
        setGameResumeUnavailable(false);
      } else {
        setGameResumeCancelFailed(true);
      }
    } finally {
      gameResumeCancelActiveRef.current = false;
      setGameResumeCancelActive(false);
    }
  };

  /**
   * Bounded authoritative rereads for one admitted `game.create`. Transport
   * `accepted`/`attached` are never runtime success; the attempt stays visibly
   * in flight until the composed authoritative Game projection converges on
   * the new attachment generation at ready-actions-paused (attached +
   * connected_idle + paused — a shape the pre-create failed/disconnected
   * surface can never produce), or the bounded budget expires (fail-closed
   * unavailable; the next form submit mints a fresh attempt identity).
   */
  const createAwaitAuthoritative = async (
    attempts: number,
  ): Promise<"converged" | "unavailable"> => {
    if (cancelledRef.current || attempts > RESUME_REREAD_MAX_ATTEMPTS) return "unavailable";
    try {
      await reread();
    } catch {
      if (cancelledRef.current) return "unavailable";
      // An inconclusive authoritative read never completes the create; keep
      // rereading inside the bounded budget.
      await delay(RESUME_REREAD_INTERVAL_MS);
      return createAwaitAuthoritative(attempts + 1);
    }
    const fresh = viewRef.current;
    if (fresh.kind !== "ready" || fresh.root.game === null) return "unavailable";
    const projection = fresh.root.game.game;
    if (
      projection.attachment.status === "attached" &&
      projection.connectionStatus === "connected_idle" &&
      projection.actionAuthority === "paused"
    ) return "converged";
    await delay(RESUME_REREAD_INTERVAL_MS);
    return createAwaitAuthoritative(attempts + 1);
  };

  /**
   * Start-new-game submission (single-flight, one fresh idempotency key per
   * attempt). The command carries only the published integration id and the
   * player's explicit continuity binding choice (empty = null = no binding);
   * the Host store mints the durable session. `unavailable` and rejected
   * commands fail closed with the form kept retryable; a converged create
   * hands the drawer over to the authoritative ready-actions-paused
   * projection.
   */
  const handleGameCreate = async (): Promise<void> => {
    const current = viewRef.current;
    if (
      gameCreateActiveRef.current ||
      current.kind !== "ready" ||
      current.root.game === null ||
      (!gameResumeFailed && !gameResumeUnavailable)
    ) return;
    const continuityText = continuityIdentityInput.trim();
    const idempotencyKey = newIdempotencyKey();
    const request: GameCreateRequestV1 = {
      apiVersion: 1,
      idempotencyKey,
      integrationId: STARDEW_GAME_INTEGRATION_ID,
      continuityIdentityId: continuityText.length === 0 ? null : continuityText,
    };
    gameCreateActiveRef.current = true;
    setGameCreateActive(true);
    setGameCreateFailed(false);
    setGameCreateUnavailable(false);
    let outcome: GameCreateResultV1 | undefined;
    try {
      outcome = await composedApiRef.current.createGameSession(request);
    } catch {
      try {
        await reread();
      } catch { /* retain the current authoritative projection */ }
      setGameCreateFailed(true);
      gameCreateActiveRef.current = false;
      setGameCreateActive(false);
      return;
    }
    if (outcome === undefined) {
      gameCreateActiveRef.current = false;
      setGameCreateActive(false);
      return;
    }
    if (outcome.status === "unavailable") {
      // The create failed closed with no resumable half-record; never project
      // a session or a ready surface from the null handle.
      try {
        await reread();
      } catch { /* retain the current authoritative projection */ }
      setGameCreateUnavailable(true);
      gameCreateActiveRef.current = false;
      setGameCreateActive(false);
      return;
    }
    // `accepted`/`attached` are transport admissions only and never runtime
    // success: keep the create visibly in flight while bounded authoritative
    // rereads converge on ready-actions-paused, or the budget expires.
    let convergence: "converged" | "unavailable";
    try {
      convergence = await createAwaitAuthoritative(1);
    } catch {
      convergence = "unavailable";
    }
    if (convergence === "unavailable") {
      setGameCreateUnavailable(true);
    } else {
      // The new session is authoritative at ready-actions-paused; the stale
      // resume failure surface is cleared and the form is done.
      setGameResumeFailed(false);
      setGameResumeUnavailable(false);
      setCreateFormOpen(false);
      setContinuityIdentityInput("");
    }
    gameCreateActiveRef.current = false;
    setGameCreateActive(false);
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
  // The three lifecycle controls are one derivation owned by
  // `game-lifecycle-controls.ts`, which reads the frozen Host vocabulary
  // directly: the activated-but-not-launched shape the coordinator publishes is
  // `prerequisites: "met"` with `instance.status: "none"` and the exact expected
  // generation, and that is where the launch control belongs.
  const {
    activationAvailable: gameActivationAvailable,
    setupAvailable: gameSetupAvailable,
    launchAvailable: gameLaunchAvailable,
  } = deriveGameLifecycleControlAvailability({
    ready: view.kind === "ready",
    game: view.kind === "ready" ? view.root.game : null,
  });
  const gameStopAvailable = view.kind === "ready" &&
    view.root.game !== null &&
    view.root.game.game.attachment.status === "attached" &&
    view.root.game.game.attachment.generation > 0 &&
    view.root.game.game.connectionStatus === "connected_idle";
  const disconnectAvailable = view.kind === "ready" &&
    view.root.game !== null &&
    view.root.game.game.attachment.status === "attached" &&
    view.root.game.game.attachment.generation > 0;
  const gameResumeAvailable = view.kind === "ready" &&
    view.root.game !== null &&
    view.root.game.game.attachment.status === "attached" &&
    view.root.game.game.attachment.generation > 0 &&
    RESUMABLE_CONNECTION_STATUSES.has(view.root.game.game.connectionStatus);
  const gameReopenAvailable = view.kind === "ready" &&
    view.root.game !== null &&
    view.root.game.game.actionAuthority === "paused" &&
    view.root.game.game.attachment.status === "attached" &&
    view.root.game.game.attachment.generation > 0 &&
    view.root.game.game.connectionStatus === "connected_idle";
  const resumeFailureSurface = view.kind === "ready" &&
    view.root.game !== null &&
    view.root.game.game.attachment.status === "attached" &&
    view.root.game.game.attachment.generation > 0 &&
    RESUMABLE_CONNECTION_STATUSES.has(view.root.game.game.connectionStatus) &&
    (gameResumeFailed || gameResumeUnavailable || view.root.game.game.latestOutcome === "failed");
  const gameSyncing = view.kind === "ready" &&
    view.root.game !== null &&
    view.root.game.game.connectionStatus === "syncing";
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
             {/* The companion is named once, next to its own monogram, exactly
                 as the chat surfaces' app bar does. The mark is a name-derived
                 monogram placeholder, never decorative imagery. */}
             <div className="app-bar-companion">
               <span className="avatar avatar-small" aria-hidden="true">
                 {view.session.snapshot.chat.companion.name.slice(0, 1).toUpperCase()}
               </span>
               <div className="app-bar-title">{view.session.snapshot.chat.companion.name}</div>
             </div>
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
               <h2>{labels().savedDraft}</h2>
               {view.session.snapshot.chat.draft.present && view.draft.text !== null ? (
                 <p>{view.draft.text}</p>
               ) : (
                 <p>{labels().noSavedDraft}</p>
               )}
             </section>
              <GameStatePanel
                game={view.root.game}
                labels={labels()}
                integrationId={STARDEW_GAME_INTEGRATION_ID}
                syncing={gameSyncing}
                lifecycle={{
                  activation: {
                    available: gameActivationAvailable,
                    active: gameActivationActive,
                    failed: gameActivationFailed,
                    unavailable: gameActivationUnavailable,
                  },
                  setup: {
                    available: gameSetupAvailable,
                    active: gameSetupActive,
                    failed: gameSetupFailed,
                    notStaged: gameSetupNotStaged,
                  },
                  launch: {
                    available: gameLaunchAvailable,
                    active: gameLaunchActive,
                    failed: gameLaunchFailed,
                    notStaged: gameLaunchNotStaged,
                  },
                }}
                session={{
                  stop: { available: gameStopAvailable, active: gameStopActive, failed: gameStopFailed },
                  disconnect: {
                    available: disconnectAvailable,
                    active: disconnectActive,
                    failed: disconnectFailed,
                  },
                }}
                resume={{
                  available: gameResumeAvailable,
                  active: gameResumeActive,
                  failed: gameResumeFailed,
                  unavailable: gameResumeUnavailable,
                  cancelActive: gameResumeCancelActive,
                  cancelFailed: gameResumeCancelFailed,
                  failureSurface: resumeFailureSurface,
                }}
                reopen={{
                  available: gameReopenAvailable,
                  active: gameReopenActive,
                  failed: gameReopenFailed,
                  unavailable: gameReopenUnavailable,
                }}
                create={{
                  active: gameCreateActive,
                  failed: gameCreateFailed,
                  unavailable: gameCreateUnavailable,
                  formOpen: createFormOpen,
                  continuityIdentity: continuityIdentityInput,
                }}
                cabin={cabinView}
                handlers={{
                  activate: () => void handleLifecycleActivate(),
                  setup: () => void handleGameSetup(),
                  launch: () => void handleGameLaunch(),
                  stop: () => void handleGameStop(),
                  disconnect: () => void handleDisconnect(),
                  resume: () => void handleGameResume(),
                  resumeCancel: () => void handleGameResumeCancel(),
                  reopen: () => void handleGameReopen(),
                  create: () => void handleGameCreate(),
                  toggleCreateForm: () => setCreateFormOpen((open) => !open),
                  setContinuityIdentity: setContinuityIdentityInput,
                  confirmCabin: (choice) => void handleCabinConfirmation(choice),
                }}
              />
              {/* The installation discovery panel is its own surface, not part of
                  the Game state region. It must stay OUTSIDE the drawer's
                  <section aria-label={gameState}>: its own status/Retry/Cancel
                  controls would otherwise pollute the region's scope and make
                  Playwright strict-mode region queries ambiguous. */}
              <StardewInstallationDiscovery api={composedApiRef.current} />
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
