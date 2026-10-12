import { Gamepad2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Messages } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import {
  ComposedReferenceGameProblemError,
  type ComposedReferenceGameBrowserApi,
  type GameBrowserStateV1,
  type GameCreateRequestV1,
  type GameCreateResultV1,
  type GameResumeResultV1,
  type StardewCabinChoiceV1,
} from "../composed-reference-game-browser-api";
import { deriveGameLifecycleControlAvailability } from "../game-lifecycle-controls";
import { GameDiagnosticsDisclosure } from "./GameDiagnosticsDisclosure";
import { GameStatePanel, type CabinViewState } from "./GameStatePanel";
import { StardewInstallationDiscovery } from "./StardewInstallationDiscovery";
import { SurfaceModelSettings } from "./SurfaceModelSettings";
import { SurfaceView } from "./SurfaceView";
import {
  delay,
  newIdempotencyKey,
  RESUMABLE_CONNECTION_STATUSES,
  RESUME_REREAD_INTERVAL_MS,
  RESUME_REREAD_MAX_ATTEMPTS,
  STARDEW_GAME_INTEGRATION_ID,
  type ViewState,
} from "./composed-reference-game-view";

/**
 * The Game peer surface.
 *
 * It owns the Game lifecycle wiring the shell used to hold: cabin discovery, the
 * first-run activation/setup/launch controls, the session stop/disconnect/
 * resume/reopen/create commands, the bounded authoritative rereads that decide
 * when one of them is really done, and the panel that renders all of it. The
 * shell supplies only the session seam it cannot own - the live view, the commit
 * that publishes a new Game projection, the preview reset every authoritative
 * reread performs, the cancellation flag, the two clients and the labels.
 *
 * It is always mounted while the shell has a ready view and returns null when it
 * is not the selected surface, so its state survives a surface switch exactly as
 * it did inside the shell (a peer surface that resets its in-flight attempt on
 * every AppBar click would forget a resume the player is watching).
 */
export function GameSurface({
  selected,
  ready,
  game,
  csrfToken,
  labels,
  readView,
  commit,
  clearPreview,
  isCancelled,
  composedApi,
  managementApi,
  restoreFocusTo,
}: {
  selected: boolean;
  ready: boolean;
  game: GameBrowserStateV1 | null;
  csrfToken: string;
  labels: Messages;
  readView: () => ViewState;
  commit: (next: ViewState) => void;
  clearPreview: () => void;
  isCancelled: () => boolean;
  composedApi: ComposedReferenceGameBrowserApi;
  managementApi: ManagementPipelineApi;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
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

  const readCabins = useCallback(async (): Promise<void> => {
    setCabinView({ kind: "loading" });
    try {
      const result = await composedApi.readStardewCabins();
      cabinIdempotencyKeysRef.current = new Map(
        result.choices.map((choice) => [choice.choiceHandle, newIdempotencyKey()]),
      );
      setCabinView({ kind: "choices", choices: result.choices });
    } catch {
      setCabinView({ kind: "unavailable" });
    }
  }, [composedApi]);

  useEffect(() => {
    if (!ready) return;
    void readCabins();
  }, [ready, readCabins]);

  /**
   * Authoritative reread for a Game-owned operation. A Game operation's subject
   * is the composed root's game/lifecycle projection, never the Chat draft, so
   * this reads only that projection and applies it: a Chat draft revision that
   * moves between the reads (the player typing in the conversation, another
   * tab, a background poll) must never fail a Game operation. A Game operation
   * that needs a "did the thing I acted on change" check uses the Game
   * projection's own attachment generation, which its handler compares against
   * the generation it acted on.
   */
  const rereadGame = async (): Promise<void> => {
    const current = readView();
    if (current.kind !== "ready") return;
    const root = await composedApi.readState();
    clearPreview();
    commit({ ...current, root, session: current.session.applySnapshot(root.chat) });
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
      await composedApi.confirmStardewCabin({
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
    const current = readView();
    if (gameActivationActiveRef.current || current.kind !== "ready") return;
    // The click-time re-check is the same derivation the control is offered
    // from, so a control can never be offered in a state its own handler refuses.
    if (!deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game }).activationAvailable) return;
    gameActivationActiveRef.current = true;
    setGameActivationActive(true);
    setGameActivationFailed(false);
    setGameActivationUnavailable(false);
    try {
      await composedApi.activateLifecycle();
      await rereadGame();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
    const current = readView();
    if (gameSetupActiveRef.current || current.kind !== "ready") return;
    if (!deriveGameLifecycleControlAvailability({ ready: true, game: current.root.game }).setupAvailable) return;
    const idempotencyKey = gameSetupKeyRef.current ?? newIdempotencyKey();
    gameSetupKeyRef.current = idempotencyKey;
    gameSetupActiveRef.current = true;
    setGameSetupActive(true);
    setGameSetupFailed(false);
    setGameSetupNotStaged(false);
    try {
      await composedApi.setupGame({ apiVersion: 1, idempotencyKey });
      await rereadGame();
      const afterSetup = readView();
      if (afterSetup.kind === "ready" && afterSetup.root.game?.game.prerequisites.status === "unknown")
        gameSetupKeyRef.current = undefined;
    } catch (error) {
      const notStaged = isNotStagedRefusal(error);
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch {
        // Preserve the original key while the command outcome is uncertain.
      }
      setGameSetupNotStaged(notStaged);
      setGameSetupFailed(!notStaged);
      const latest = readView();
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
    const current = readView();
    const gameProjection = current.kind === "ready" ? current.root.game : null;
    if (
      gameStopActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      gameProjection.game.connectionStatus !== "connected_idle"
    ) return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameStopKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameStopKeysRef.current.set(generation, idempotencyKey);
    gameStopActiveRef.current = true;
    setGameStopActive(true);
    setGameStopFailed(false);
    try {
      await composedApi.stopGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      await rereadGame();
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
    const current = readView();
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
      await composedApi.launchGame({
        apiVersion: 1,
        idempotencyKey,
        expectedInstanceGeneration: generation,
      });
      await rereadGame();
    } catch (error) {
      const notStaged = isNotStagedRefusal(error);
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
    const current = readView();
    const gameProjection = current.kind === "ready" ? current.root.game : null;
    if (
      disconnectActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      !current.root.game?.game ||
      gameProjection.game.attachment.generation < 1
    ) return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = disconnectKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    disconnectKeysRef.current.set(generation, idempotencyKey);
    disconnectActiveRef.current = true;
    setDisconnectActive(true);
    setDisconnectFailed(false);
    try {
      await composedApi.disconnectGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      await rereadGame();
    } catch {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
    if (isCancelled() || attempts > RESUME_REREAD_MAX_ATTEMPTS) return "unavailable";
    try {
      await rereadGame();
    } catch {
      if (isCancelled()) return "unavailable";
      // An inconclusive authoritative read never completes the resume; keep
      // rereading inside the bounded budget.
      await delay(RESUME_REREAD_INTERVAL_MS);
      return resumeAwaitAuthoritative(generation, attempts + 1);
    }
    const fresh = readView();
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
    const current = readView();
    const gameProjection = current.kind === "ready" ? current.root.game : null;
    if (
      gameResumeActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      !RESUMABLE_CONNECTION_STATUSES.has(gameProjection.game.connectionStatus)
    ) return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameResumeKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameResumeKeysRef.current.set(generation, idempotencyKey);
    gameResumeActiveRef.current = true;
    setGameResumeActive(true);
    setGameResumeFailed(false);
    setGameResumeUnavailable(false);
    let outcome: GameResumeResultV1 | undefined;
    try {
      outcome = await composedApi.resumeGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
        await rereadGame();
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
    if (isCancelled() || attempts > RESUME_REREAD_MAX_ATTEMPTS) return "unavailable";
    try {
      await rereadGame();
    } catch {
      if (isCancelled()) return "unavailable";
      // An inconclusive authoritative read never completes the reopen; keep
      // rereading inside the bounded budget.
      await delay(RESUME_REREAD_INTERVAL_MS);
      return reopenAwaitAuthoritative(generation, attempts + 1);
    }
    const fresh = readView();
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
    const current = readView();
    const gameProjection = current.kind === "ready" ? current.root.game : null;
    // ready-actions-paused is the exact precondition: connected_idle equals a
    // live observation surface, actionAuthority "paused" means only a new
    // explicit Game instruction may reopen action admission. Never approximate
    // it with the connection status alone.
    if (
      gameReopenActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.actionAuthority !== "paused" ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      gameProjection.game.connectionStatus !== "connected_idle"
    ) return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameReopenKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameReopenKeysRef.current.set(generation, idempotencyKey);
    gameReopenActiveRef.current = true;
    setGameReopenActive(true);
    setGameReopenFailed(false);
    setGameReopenUnavailable(false);
    try {
      await composedApi.reopenGame({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
    const current = readView();
    const gameProjection = current.kind === "ready" ? current.root.game : null;
    if (
      gameResumeCancelActiveRef.current ||
      current.kind !== "ready" ||
      gameProjection === null ||
      gameProjection.game.attachment.status !== "attached" ||
      gameProjection.game.attachment.generation < 1 ||
      !RESUMABLE_CONNECTION_STATUSES.has(gameProjection.game.connectionStatus) ||
      (!gameResumeFailed && !gameResumeUnavailable)
    ) return;
    const generation = gameProjection.game.attachment.generation;
    const existingKey = gameResumeCancelKeysRef.current.get(generation);
    const idempotencyKey = existingKey ?? newIdempotencyKey();
    gameResumeCancelKeysRef.current.set(generation, idempotencyKey);
    gameResumeCancelActiveRef.current = true;
    setGameResumeCancelActive(true);
    setGameResumeCancelFailed(false);
    try {
      await composedApi.cancelResume({
        apiVersion: 1,
        idempotencyKey,
        expectedAttachmentGeneration: generation,
      });
      try {
        await rereadGame();
      } catch { /* retain the current authoritative projection */ }
      setGameResumeFailed(false);
      setGameResumeUnavailable(false);
    } catch (error) {
      let rereadSucceeded = false;
      try {
        await rereadGame();
        rereadSucceeded = true;
      } catch { /* retain the current authoritative projection */ }
      const fresh = readView();
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
    if (isCancelled() || attempts > RESUME_REREAD_MAX_ATTEMPTS) return "unavailable";
    try {
      await rereadGame();
    } catch {
      if (isCancelled()) return "unavailable";
      // An inconclusive authoritative read never completes the create; keep
      // rereading inside the bounded budget.
      await delay(RESUME_REREAD_INTERVAL_MS);
      return createAwaitAuthoritative(attempts + 1);
    }
    const fresh = readView();
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
    const current = readView();
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
      outcome = await composedApi.createGameSession(request);
    } catch {
      try {
        await rereadGame();
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
        await rereadGame();
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

  const {
    activationAvailable: gameActivationAvailable,
    setupAvailable: gameSetupAvailable,
    launchAvailable: gameLaunchAvailable,
  } = deriveGameLifecycleControlAvailability({
    ready,
    game,
  });
  const gameStopAvailable = ready &&
    game !== null &&
    game.game.attachment.status === "attached" &&
    game.game.attachment.generation > 0 &&
    game.game.connectionStatus === "connected_idle";
  const disconnectAvailable = ready &&
    game !== null &&
    game.game.attachment.status === "attached" &&
    game.game.attachment.generation > 0;
  const resumeFailureSurface = ready &&
    game !== null &&
    game.game.attachment.status === "attached" &&
    game.game.attachment.generation > 0 &&
    RESUMABLE_CONNECTION_STATUSES.has(game.game.connectionStatus) &&
    (gameResumeFailed || gameResumeUnavailable || game.game.latestOutcome === "failed");
  // One command, one control. `game.resume` is both the connection-restore
  // action and its own retry, so the panel offers it under exactly one honest
  // name: the failure rollup (`Retry`) owns the attempt that already failed
  // (design/26 §4.1 offers `Try again` only where the exact request is safe to
  // replay - which the preserved generation-bound idempotency key makes it), and
  // `Resume game` owns the degraded connection that no attempt has failed on.
  // Offering both at once was the surface naming its own command twice.
  const gameResumeAvailable = ready &&
    game !== null &&
    game.game.attachment.status === "attached" &&
    game.game.attachment.generation > 0 &&
    RESUMABLE_CONNECTION_STATUSES.has(game.game.connectionStatus) &&
    !resumeFailureSurface;
  const gameReopenAvailable = ready &&
    game !== null &&
    game.game.actionAuthority === "paused" &&
    game.game.attachment.status === "attached" &&
    game.game.attachment.generation > 0 &&
    game.game.connectionStatus === "connected_idle";
  const gameSyncing = ready &&
    game !== null &&
    game.game.connectionStatus === "syncing";

  if (!selected) return null;

  return (
    <SurfaceView
      title={labels.gamePanel}
      testId="game-surface"
      icon={Gamepad2}
      restoreFocusTo={restoreFocusTo}
    >
      {/* Installation discovery is a sibling of the Game state region,
          never inside it, so the region's scope stays exactly its own
          controls (its Retry/Cancel would otherwise make the region's
          strict-mode queries ambiguous). */}
      <GameStatePanel
        game={game}
        labels={labels}
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
      <StardewInstallationDiscovery api={composedApi} labels={labels} />
      {/* The Game Agent's own model settings, on the Game surface (design/
          architecture/product-surfaces.md); the Host stores this half of
          settings/profiles separately from Chat's. */}
      <SurfaceModelSettings
        surface="game"
        api={managementApi}
        csrfToken={csrfToken}
        labels={labels}
      />
      {/* Read-only Host data at the bottom of the Game surface: the
          instance and session projection the composed state route
          publishes, and the honest fact that this Host mounts no
          diagnostics route. Collapsed by default; see the component
          for the reachability evidence. */}
      <GameDiagnosticsDisclosure game={game} labels={labels} />
    </SurfaceView>
  );
}
