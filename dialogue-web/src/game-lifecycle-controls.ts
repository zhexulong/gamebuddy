import type { GameBrowserStateV1 } from "./composed-reference-game-browser-api";

/**
 * The single derivation of the three lifecycle controls the player sees
 * (activation, setup, launch), so the buttons a player is offered and the
 * meanings the Host publishes cannot drift apart in two places.
 *
 * The frozen `game_browser_api/v1` vocabulary these gates read means:
 *
 * - `instance.status: "none"` + no expected generation is the pre-activation
 *   shape: nothing is running and no launch can be started, whether or not the
 *   player has already registered an installation. This is where activation and
 *   setup belong - activation is what stages the attempt they precede.
 * - `prerequisites: "met"` + `instance.status: "none"` + the exact expected
 *   generation >= 1 is the activated-but-not-launched shape: the lifecycle is
 *   ready to start a Player Host and nothing is running. This is where the
 *   launch control belongs.
 * - `instance.status: "launching"` means a launch is actually in flight (and
 *   `"running"`/`"crashed"` mean a Player Host is attached/failed), so neither
 *   is a state from which a launch may be started.
 *
 * What separates the first two shapes is the expected generation, not
 * `prerequisites`: that flag turns `met` as soon as the Host holds a ready
 * installation registration, which the player produces by confirming their game
 * folder - before any activation. Reading `prerequisites: "unknown"` as the
 * test for "not activated yet" therefore retired both staging controls at the
 * exact moment a first-run player confirmed their installation, and the surface
 * offered no control at all.
 *
 * A client-side guard must not add a further condition of its own here: these
 * three flags are exactly what the Host's projection distinguishes, and the
 * cross-boundary test in `tests/game-lifecycle-launch-gate.test.mjs` feeds a
 * real Host projection through this function.
 */
export type GameLifecycleControlAvailability = Readonly<{
  activationAvailable: boolean;
  setupAvailable: boolean;
  launchAvailable: boolean;
  /**
   * The exact expected Player Host instance generation the launch command must
   * bind, present exactly when `launchAvailable` is true.
   */
  launchGeneration: number | null;
}>;

const NO_CONTROLS: GameLifecycleControlAvailability = Object.freeze({
  activationAvailable: false,
  setupAvailable: false,
  launchAvailable: false,
  launchGeneration: null,
});

export function deriveGameLifecycleControlAvailability(
  view: Readonly<{ ready: boolean; game: GameBrowserStateV1 | null }>,
): GameLifecycleControlAvailability {
  if (!view.ready || view.game === null) return NO_CONTROLS;
  const { instance, prerequisites } = view.game.game;
  const nothingRunning = instance.status === "none";
  const launchable = nothingRunning && prerequisites.status === "met" && instance.generation >= 1;
  const preActivation = nothingRunning && !launchable;
  return Object.freeze({
    activationAvailable: preActivation && instance.generation < 1,
    setupAvailable: preActivation,
    launchAvailable: launchable,
    launchGeneration: launchable ? instance.generation : null,
  });
}

/**
 * Every state the Game surface's session-and-recovery half can be in.
 *
 * These are the situations the product really distinguishes, not a hand-written
 * sample of them. Two published facts decide the phase:
 *
 * - whether this browser holds a live attachment (`attachment.status` /
 *   `attachment.generation`, from the coordinator's attachment reader), which is
 *   what the session controls act on;
 * - when it does not, what the Player Host instance is doing (`instance.status`,
 *   projected from the coordinator's launch readiness and lifecycle slot by
 *   `host/src/game-browser/game-browser-state-provider.ts`).
 *
 * The one shape the client adds on top of a Host projection is
 * `attached_resume_failed`: a resume attempt this surface made and watched fail.
 *
 * `GAME_SESSION_PHASES` is the only list of them and `GAME_SESSION_INPUTS` the
 * only projection for each, so `tests/game-lifecycle-launch-gate.test.mjs` drives
 * every phase through `deriveGameSessionControls` and fails by name on the one
 * that offers the player nothing to press.
 */
export type GameSessionPhase =
  /**
   * The Host published no Game projection for this profile at all (`game: null`
   * in the composed root), so there is no session to advance. The step out of it
   * is the AppBar's own surface switch - shell chrome that is mounted whenever
   * this surface is - which is why the gate keeps this the only phase with no
   * action of its own, the one exception `companion-activation-controls.ts`
   * already established for `in_play`.
   */
  | "no_projection"
  /** No attachment, nothing running, nothing staged: activation and setup belong here. */
  | "pre_activation"
  /** No attachment, activated and ready: the launch control is what starts the Player Host. */
  | "activated_not_launched"
  /** No attachment and a launch actually in flight: the game is what happens next. */
  | "launching"
  /** No attachment while a Player Host runs: the game owes this browser a session. */
  | "running_without_attachment"
  /**
   * No attachment and the launch failed for good: the coordinator quarantined the
   * owner (`launchTerminal` in `stardew-production-lifecycle-coordinator.internal.ts`)
   * and answers every further launch with
   * `stardew_player_host_launch_quarantined` for the life of this Host process,
   * so no control on this page can carry the player out. The step is a fresh
   * GameBuddy, and the surface's job is to name it.
   */
  | "launch_failed"
  /** Attached and connected with actions live. */
  | "attached_connected"
  /** Attached and connected with action authority paused (ready-actions-paused). */
  | "attached_actions_paused"
  /** Attached and dropping: the attachment is still held. */
  | "attached_stopping"
  /** Attached after a deliberate stop. */
  | "attached_stopped"
  /** Attached while the connection is being synchronised. */
  | "attached_syncing"
  /** Attached while a reconnect is under way. */
  | "attached_reconnecting"
  /** Attached with no connection fact published yet. */
  | "attached_unconnected"
  /** Attached and dropped, with no failed attempt yet: the restore control applies. */
  | "attached_resumable"
  /**
   * Attached and dropped with the Host's own last outcome `failed`, but no restore
   * attempt this surface can settle. Retry is offered (the restore command needs
   * only the live attachment and the resumable connection). Cancel and Start new
   * game are not: both act on an attempt - its epoch, its replacement - so their
   * handlers refuse with none in hand.
   */
  | "attached_unsettled"
  /** Attached and dropped, after an attempt that failed or could not be confirmed. */
  | "attached_resume_failed";

/**
 * The one step each state offers, named rather than implied.
 *
 * Two members are not controls on this page, and both name a step the player
 * really takes - the same precedent `companion-activation-controls.ts` set with
 * `restart`:
 *
 * - `wait_for_game` is the game's own progress (the launch is in flight, or the
 *   farm has not handed over a session yet). The surface states it, because a
 *   player reading a panel with no control has no way to tell a wait from a trap.
 * - `restart_gamebuddy` is the only way out of a quarantined launch, and it is
 *   off this page entirely.
 */
type GameSessionForwardAction =
  /**
   * No step of this state's own: the shell's surface switch is the way out. Reserved
   * for `no_projection`, where the Host published no Game projection at all, and kept
   * the only such phase by the gate - the same shape `in_play` has for the roster.
   */
  | "terminal"
  | "activate"
  | "setup"
  | "launch"
  | "stop"
  | "disconnect"
  | "endgame"
  | "resume"
  | "retry_resume"
  | "cancel_resume"
  | "create"
  | "reopen"
  | "wait_for_game"
  | "restart_gamebuddy";

export type GameSessionControls = Readonly<{
  phase: GameSessionPhase;
  stopAvailable: boolean;
  disconnectAvailable: boolean;
  endgameAvailable: boolean;
  resumeAvailable: boolean;
  retryResumeAvailable: boolean;
  cancelResumeAvailable: boolean;
  createAvailable: boolean;
  reopenAvailable: boolean;
  /**
   * Every step this state offers, in reading order. Never empty: `AGENTS.md`'s
   * zero-forward-path rule is why that is an invariant here rather than a hope,
   * and the gate fails by name on the phase that breaks it. `terminal` is the one
   * member that is not a step of this surface's own.
   */
  forwardActions: readonly GameSessionForwardAction[];
  /**
   * Whether the surface must state that the game is what happens next, in place
   * of a control. True exactly in `launching` and `running_without_attachment`.
   */
  waitingForGame: boolean;
  /**
   * Whether the surface must state that a fresh GameBuddy is the step, in place
   * of the getting-going guide. True exactly in `launch_failed`.
   */
  restartRequired: boolean;
}>;

const RESUMABLE_CONNECTION_STATUSES: ReadonlySet<string> = new Set(["failed", "disconnected"]);

/**
 * The session-and-recovery half of the Game surface, derived once.
 *
 * `GameSurface.tsx` offers exactly these controls and no others. Before this
 * function each one was an inline predicate beside its button, which is why no
 * test could ask "does this state offer the player anything at all" without
 * restating every predicate - and why nothing noticed that a launch which failed
 * for good offered neither a control nor a sentence saying what would.
 *
 * `resumeFailureSurface` is the shell's own failed-restore rule, passed in rather
 * than recomputed: the failed attempt is client state the projection cannot carry.
 */
export function deriveGameSessionControls(
  view: Readonly<{
    ready: boolean;
    game: GameBrowserStateV1 | null;
    /** The shell's failed-restore rule: see `resumeFailureSurface` in `GameSurface.tsx`. */
    resumeFailureSurface: boolean;
    /**
     * Whether this surface's own restore attempt actually failed or could not be
     * confirmed. The three ways out of the rollup act on that attempt - Retry
     * replays its key, Cancel settles its epoch, Start new game replaces it - so
     * they are offered exactly while there is an attempt to act on. The rollup
     * itself is drawn from `resumeFailureSurface`, which also covers the Host's
     * own failed outcome; in that wider shape the honest offer is the session
     * controls alone, which is why the two facts are separate here.
     */
    resumeAttemptFailed: boolean;
  }>,
): GameSessionControls {
  const build = (
    phase: GameSessionPhase,
    flags: Partial<Omit<GameSessionControls, "phase" | "forwardActions" | "waitingForGame" | "restartRequired">>,
    forwardActions: readonly GameSessionForwardAction[],
  ): GameSessionControls =>
    Object.freeze({
      phase,
      stopAvailable: false,
      disconnectAvailable: false,
      endgameAvailable: false,
      resumeAvailable: false,
      retryResumeAvailable: false,
      cancelResumeAvailable: false,
      createAvailable: false,
      reopenAvailable: false,
      ...flags,
      forwardActions: Object.freeze([...forwardActions]),
      waitingForGame: phase === "launching" || phase === "running_without_attachment",
      restartRequired: phase === "launch_failed",
    });

  if (!view.ready || view.game === null) return build("no_projection", {}, ["terminal"]);
  const { instance, attachment, connectionStatus, actionAuthority } = view.game.game;

  // A live attachment leads, exactly as the surface has always read it: the
  // routine session controls settle it whatever the instance row says beside it.
  if (attachment.status === "attached" && attachment.generation > 0) {
    if (connectionStatus === "connected_idle") {
      const reopenAvailable = actionAuthority === "paused";
      return build(
        reopenAvailable ? "attached_actions_paused" : "attached_connected",
        { stopAvailable: true, disconnectAvailable: true, endgameAvailable: true, reopenAvailable },
        reopenAvailable ? ["reopen", "stop", "disconnect", "endgame"] : ["stop", "disconnect", "endgame"],
      );
    }
    if (RESUMABLE_CONNECTION_STATUSES.has(connectionStatus)) {
      if (view.resumeAttemptFailed)
        return build(
          "attached_resume_failed",
          {
            disconnectAvailable: true,
            endgameAvailable: true,
            retryResumeAvailable: true,
            cancelResumeAvailable: true,
            createAvailable: true,
          },
          ["retry_resume", "cancel_resume", "create", "disconnect", "endgame"],
        );
      if (view.resumeFailureSurface)
        // The Host's own failed outcome, with no attempt of this surface's own to
        // settle. Retry is honest here and is offered: `handleGameResume` needs
        // only the live attachment and the resumable connection. Cancel and Start
        // new game are not, because both handlers refuse with no attempt in hand
        // (`handleGameResumeCancel`, `handleGameCreate`) - offering them would be
        // controls that do nothing.
        return build(
          "attached_unsettled",
          { disconnectAvailable: true, endgameAvailable: true, retryResumeAvailable: true },
          ["retry_resume", "disconnect", "endgame"],
        );
      return build("attached_resumable", { disconnectAvailable: true, endgameAvailable: true, resumeAvailable: true }, [
        "resume",
        "disconnect",
        "endgame",
      ]);
    }
    const phase: GameSessionPhase =
      connectionStatus === "stopping"
        ? "attached_stopping"
        : connectionStatus === "stopped"
          ? "attached_stopped"
          : connectionStatus === "syncing"
            ? "attached_syncing"
            : connectionStatus === "reconnecting"
              ? "attached_reconnecting"
              : "attached_unconnected";
    return build(phase, { disconnectAvailable: true, endgameAvailable: true }, ["disconnect", "endgame"]);
  }

  // No attachment: what the Player Host instance is doing decides the step, and
  // the staging controls are the same derivation the getting-going guide renders.
  if (instance.status === "crashed") return build("launch_failed", {}, ["restart_gamebuddy"]);
  if (instance.status === "launching") return build("launching", {}, ["wait_for_game"]);
  if (instance.status !== "none") return build("running_without_attachment", {}, ["wait_for_game"]);
  const lifecycle = deriveGameLifecycleControlAvailability(view);
  if (lifecycle.launchAvailable) return build("activated_not_launched", {}, ["launch"]);
  return build("pre_activation", {}, lifecycle.activationAvailable ? ["activate", "setup"] : ["setup"]);
}

/** Every phase this derivation can produce, for the totality gate to enumerate. */
export const GAME_SESSION_PHASES: readonly GameSessionPhase[] = Object.freeze([
  "no_projection",
  "pre_activation",
  "activated_not_launched",
  "launching",
  "running_without_attachment",
  "launch_failed",
  "attached_connected",
  "attached_actions_paused",
  "attached_stopping",
  "attached_stopped",
  "attached_syncing",
  "attached_reconnecting",
  "attached_unconnected",
  "attached_resumable",
  "attached_unsettled",
  "attached_resume_failed",
]);

/**
 * The projection one phase is, as the facts `deriveGameSessionControls` reads.
 *
 * Exported so the gate drives EVERY phase through the real derivation instead of
 * restating what each one means. A phase the gate cannot reach is a phase nothing
 * produces, which is a fact worth failing on.
 */
export const GAME_SESSION_INPUTS: Readonly<Record<GameSessionPhase, Parameters<typeof deriveGameSessionControls>[0]>> =
  (() => {
    const PROJECTION = Object.freeze({
      prerequisites: Object.freeze({ status: "met" as const, detectedGame: "Stardew Valley", missingItems: [] }),
      instance: Object.freeze({ status: "running" as const, gameTitle: "Stardew Valley", generation: 1 }),
      compatibility: Object.freeze({ status: "compatible" as const, message: null }),
      attachment: Object.freeze({ status: "none" as const, generation: 0 }),
      connectionStatus: "none" as const,
      actionAuthority: "active" as const,
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: Object.freeze({ available: false, count: 0 }),
      latestOutcome: "none" as const,
    });
    const game = (overrides: Partial<GameBrowserStateV1["game"]>): GameBrowserStateV1 =>
      Object.freeze({
        apiVersion: 1 as const,
        build: Object.freeze({ browserContract: "game_browser_api/v1" as const, profileId: "gamebuddy.game.preview" }),
        csrfToken: "CSRF",
        browserSession: Object.freeze({ expiresAtMs: 0 }),
        game: Object.freeze({ ...PROJECTION, ...overrides }),
      });
    const unstarted = (overrides: Partial<GameBrowserStateV1["game"]> = {}) =>
      game({
        prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
        instance: { status: "none", gameTitle: null, generation: 0 },
        actionAuthority: "unavailable",
        ...overrides,
      });
    const attached = (
      connectionStatus: GameBrowserStateV1["game"]["connectionStatus"],
      overrides: Partial<GameBrowserStateV1["game"]> = {},
    ) => game({ attachment: { status: "attached", generation: 1 }, connectionStatus, ...overrides });
    const input = (
      projection: GameBrowserStateV1 | null,
      facts: Readonly<{ resumeFailureSurface?: boolean; resumeAttemptFailed?: boolean }> = {},
    ) =>
      Object.freeze({
        ready: true,
        game: projection,
        resumeFailureSurface: facts.resumeFailureSurface ?? false,
        resumeAttemptFailed: facts.resumeAttemptFailed ?? false,
      });
    return Object.freeze({
      no_projection: input(null),
      pre_activation: input(unstarted()),
      activated_not_launched: input(
        game({
          instance: { status: "none", gameTitle: null, generation: 1 },
        }),
      ),
      launching: input(game({ instance: { status: "launching", gameTitle: "Stardew Valley", generation: 1 } })),
      running_without_attachment: input(game({})),
      launch_failed: input(
        game({
          instance: { status: "crashed", gameTitle: "Stardew Valley", generation: 0 },
          latestOutcome: "failed",
        }),
      ),
      attached_connected: input(attached("connected_idle")),
      attached_actions_paused: input(attached("connected_idle", { actionAuthority: "paused" })),
      attached_stopping: input(attached("stopping")),
      attached_stopped: input(attached("stopped")),
      attached_syncing: input(attached("syncing")),
      attached_reconnecting: input(attached("reconnecting")),
      attached_unconnected: input(attached("none")),
      attached_resumable: input(attached("failed")),
      attached_unsettled: input(attached("failed"), { resumeFailureSurface: true }),
      attached_resume_failed: input(attached("failed"), { resumeFailureSurface: true, resumeAttemptFailed: true }),
    });
  })();
