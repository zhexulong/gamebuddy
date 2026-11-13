import { assertNever } from "./assert-never";
import type { GameBrowserStateV1, StardewCabinChoiceV1 } from "./composed-reference-game-browser-api";

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
 * One lower bound is not a client-side guess but the same registration the Host
 * itself reads: activation cannot succeed before the session holds a ready Stardew
 * installation registration. It reserves and stages the owned Player Host against
 * that registration and answers `stardew_bootstrap_registration_unavailable`
 * without it. The projection publishes that exact fact as `prerequisites: "met"`
 * (`game-browser-state-provider.ts` reads the one `readInstallationView`
 * registration the launch path also gates on), so gating on it is the Host's fact
 * and not a second source of truth about installation state. Offering the control
 * enabled without it is a control whose only possible answer is a refusal, which
 * is what this bound removes.
 *
 * Setup is deliberately not gated the same way: it is offered behind the guide's
 * "already enabled companion play?" disclosure, and the Host's answer there
 * (`game_prerequisites_missing`) already reads as the prerequisite rather than as
 * a fault. Gating it would remove the one escape a player who believes their
 * attempt is already staged needs.
 *
 * A client-side guard must not add a further condition of its own here: these
 * flags are exactly what the Host's projection distinguishes, and the
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
  /**
   * The published fact that withholds the activation control, named rather than
   * left to a second guess, or `null` when it is offered. `AGENTS.md`'s
   * observable-state rule: the condition the surface can distinguish is a field
   * its caller can act on, not an absence of flags.
   */
  activationBlockedBy: "installation_not_registered" | null;
}>;

const NO_CONTROLS: GameLifecycleControlAvailability = Object.freeze({
  activationAvailable: false,
  setupAvailable: false,
  launchAvailable: false,
  launchGeneration: null,
  // No projection at all is not evidence about the installation: the session
  // derivation answers that shape with `no_projection`.
  activationBlockedBy: null,
});

export function deriveGameLifecycleControlAvailability(
  view: Readonly<{ ready: boolean; game: GameBrowserStateV1 | null }>,
): GameLifecycleControlAvailability {
  if (!view.ready || view.game === null) return NO_CONTROLS;
  const { instance, prerequisites } = view.game.game;
  // `unread` is not "nothing is running": the Host holds no read of the game at all, so
  // no lifecycle control is offered either - see `game_not_read` in the session
  // derivation below, which is the state that says so.
  const nothingRunning = instance.status === "none";
  const launchable = nothingRunning && prerequisites.status === "met" && instance.generation >= 1;
  const installationRegistered = prerequisites.status === "met";
  const preActivation = nothingRunning && !launchable;
  return Object.freeze({
    activationAvailable: preActivation && instance.generation < 1 && installationRegistered,
    setupAvailable: preActivation,
    launchAvailable: launchable,
    launchGeneration: launchable ? instance.generation : null,
    activationBlockedBy: preActivation && !installationRegistered ? "installation_not_registered" : null,
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
  /** No attachment, nothing running, nothing staged: the staging controls belong here once
   * the Host holds a ready installation registration, and the installation step is the one
   * offered instead of them while it does not. */
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
  /**
   * No attachment and the game ended without failing: the Guardian reported the
   * process exiting with the OS's normal-termination code, so the instance reads
   * `stopped` rather than `crashed`. The attempt is terminal exactly as a failed
   * launch is - the same quarantine refuses every further launch for the life of
   * this Host process - but nothing here failed, so this phase exists to keep the
   * surface from telling a player who quit the game that it crashed.
   */
  | "game_ended"
  /**
   * No attachment and the Host has not read the player's game (`instance.status:
   * "unread"`, from the coordinator's own `unavailable`/`unknown` Player Host slot).
   * Every control the getting-going guide offers acts on a premise that read would
   * establish - the installation's standing, the staged attempt, the expected
   * generation - so none of them is offered here and the step is the read itself.
   */
  | "game_not_read"
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
 *   off this page entirely. Both endings of a game - the failed launch and the
 *   game the player quit - reach it, because the quarantine is the same in both.
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
  | "reread_game"
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
   * of the getting-going guide. True exactly in `launch_failed` and `game_ended`,
   * whose two sentences differ because only one of them names a failure.
   */
  restartRequired: boolean;
  /**
   * Whether the surface must state that the player's game folder has to be
   * registered before companion play can be enabled, and withhold the activation
   * control's press. True exactly while `activationBlockedBy` names that fact.
   */
  installationRequired: boolean;
  /**
   * Whether this state's step is the panel's own read of the game, in place of the
   * getting-going guide. True exactly in `game_not_read`.
   */
  rereadAvailable: boolean;
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
    flags: Partial<
      Omit<GameSessionControls, "phase" | "forwardActions" | "waitingForGame" | "restartRequired" | "rereadAvailable">
    >,
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
      installationRequired: false,
      ...flags,
      forwardActions: Object.freeze([...forwardActions]),
      waitingForGame: phase === "launching" || phase === "running_without_attachment",
      restartRequired: phase === "launch_failed" || phase === "game_ended",
      rereadAvailable: phase === "game_not_read",
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
  // The game the player ended. Its attempt is as terminal as a failed launch's (the
  // coordinator's launch is refused for the rest of this Host process), so the step is the
  // same and only the sentence differs - see `restartRequired`.
  if (instance.status === "stopped") return build("game_ended", {}, ["restart_gamebuddy"]);
  if (instance.status === "launching") return build("launching", {}, ["wait_for_game"]);
  // Before any lifecycle control is considered: the Host has not read the game, so
  // there is no installation standing, staged attempt or expected generation for those
  // controls to act on. The step is the read the panel already owns.
  if (instance.status === "unread") return build("game_not_read", {}, ["reread_game"]);
  if (instance.status !== "none") return build("running_without_attachment", {}, ["wait_for_game"]);
  const lifecycle = deriveGameLifecycleControlAvailability(view);
  if (lifecycle.launchAvailable) return build("activated_not_launched", {}, ["launch"]);
  // Step 1 is still the activation step, and the reason it cannot be pressed yet is
  // carried as a fact the panel states rather than left to the refusal a press earns.
  return build("pre_activation", { installationRequired: lifecycle.activationBlockedBy !== null }, [
    "activate",
    "setup",
  ]);
}

/** Every phase this derivation can produce, for the totality gate to enumerate. */
export const GAME_SESSION_PHASES: readonly GameSessionPhase[] = Object.freeze([
  "no_projection",
  "pre_activation",
  "activated_not_launched",
  "launching",
  "running_without_attachment",
  "launch_failed",
  "game_ended",
  "game_not_read",
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
      // The phase's control-bearing shape: a ready installation registration and nothing
      // staged is where activation and setup are offered. The same phase with the
      // registration absent answers with `installationRequired` and the installation step
      // instead - the shape `tests/game-panel-forward-path.spec.ts` mounts.
      pre_activation: input(
        unstarted({
          prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
        }),
      ),
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
      game_ended: input(
        game({
          instance: { status: "stopped", gameTitle: "Stardew Valley", generation: 0, playerHostExitCode: 0 },
        }),
      ),
      game_not_read: input(
        game({
          instance: { status: "unread", gameTitle: null, generation: 0 },
          actionAuthority: "unavailable",
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

/**
 * Every state the cabin handoff can be in.
 *
 * The handoff is the third step of the first run: the Host offers the cabins this companion
 * may use in the loaded farm, the player confirms one, and the companion moves in. It lives
 * here rather than in the panel for the reason the session phases do: the states are the
 * product's, so the zero-forward-path rule over them has one population to read instead of a
 * panel whose shape only its own JSX knows.
 *
 * It is declared in this module and not in `GameStatePanel.tsx` because a node gate cannot
 * import a `.tsx` module, and a rule only a browser gate can read is a rule half the suite
 * cannot see.
 */
export type CabinViewState =
  /** The handoff's first read is in flight; the answer settles it. */
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "choices"; choices: readonly StardewCabinChoiceV1[] }>
  | Readonly<{ kind: "confirming"; choices: readonly StardewCabinChoiceV1[]; choiceHandle: string }>
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "uncertain" }>
  /** The read could not be made, and the panel offers the control that makes it again. */
  | Readonly<{ kind: "unavailable"; reread: boolean }>
  /**
   * No cabin this companion may use in the current host world.
   *
   * Distinct from `unavailable`, and the distinction is the whole point: this state has a CURE the player can act
   * on - have Robin build one - while `unavailable` is "the read could not be made". The Host has always known the
   * difference (`stardew_player_host_cabin_unavailable`); it was flattened to `state_unavailable` on the read route
   * until 2026-10-28, so the panel had one word for two situations and a player reading the wrong one retried
   * forever.
   *
   * `reread` is the shell's answer to "did my click do anything": true once the player asked again and the answer was
   * still this state. Without it the refresh button under it is a control whose result is the screen the player is
   * already looking at. The shell is the only party that knows, so it carries the fact rather than the panel guessing.
   */
  | Readonly<{ kind: "missing"; reread: boolean }>;

/**
 * The step each cabin-handoff state offers, named rather than implied.
 *
 * `AGENTS.md`'s zero-forward-path rule is why this exists: a state the handoff can really be
 * in, from which the player could do nothing, is a dead end whose only exit is reloading the
 * page - and reloading drops the Host connection and this surface's own attachment. The three
 * members that are not a press on this page are still steps a player takes:
 *
 * - `wait_for_read` is the handoff's own in-flight read or confirmation settling it
 *   (`loading`, `confirming`). The panel states it rather than offering a control whose
 *   command is already in flight.
 * - `terminal` is the handoff being over (`admitted`): the companion is moving in and the game
 *   is what happens next.
 * - `read_cabins_again` / `read_game_again` are the reads this surface owns, and they are
 *   deliberately two different ones - see `deriveCabinHandoffActions`.
 */
export type CabinHandoffAction = "terminal" | "confirm" | "wait_for_read" | "read_cabins_again" | "read_game_again";

/**
 * The one step each state offers, in reading order.
 *
 * `uncertain` is the state that forced the distinction between the two reads. Its fact is a
 * confirmation whose publication is unknown (`stardew_cabin_publication_uncertain`), and the
 * one thing that must not happen next is a second confirmation: the Host keeps the confirmed
 * choice handle consumed and answers any later confirmation with
 * `stardew_cabin_confirmation_conflict` for the life of the coordinator. Re-reading the cabin
 * choices would therefore re-arm a confirm button the Host can only refuse, so the honest step
 * is the panel's own authoritative read of the game: it sends no handoff command at all, and
 * the attachment the Host publishes once the confirmation landed is what answers the question.
 * When it did not land, the state stays exactly as it is, and the panel says so.
 */
export function deriveCabinHandoffActions(state: CabinViewState): readonly CabinHandoffAction[] {
  switch (state.kind) {
    case "loading":
    case "confirming":
      return Object.freeze(["wait_for_read"]);
    case "choices":
      return Object.freeze(["confirm"]);
    case "unavailable":
    case "missing":
      return Object.freeze(["read_cabins_again"]);
    case "uncertain":
      return Object.freeze(["read_game_again"]);
    case "admitted":
      return Object.freeze(["terminal"]);
    // The assertion travels with the switch. The declared return type already refuses a new kind -
    // `strict` answers `TS2366: Function lacks ending return statement and return type does not include
    // 'undefined'` the moment one is added - but that guarantee belongs to this signature, while
    // `assertNever` belongs to the switch: a later edit that returns a value, relaxes the type or puts a
    // statement after it keeps the refusal only if the guard is here.
    default:
      return assertNever(state);
  }
}

/** Every kind the union above declares, for the handoff's totality gate to enumerate. */
export const CABIN_HANDOFF_KINDS: readonly CabinViewState["kind"][] = Object.freeze([
  "loading",
  "choices",
  "confirming",
  "admitted",
  "uncertain",
  "unavailable",
  "missing",
]);

/** The cheapest instance of each kind, so the gate drives the real derivation per state. */
export const CABIN_HANDOFF_INPUTS: Readonly<Record<CabinViewState["kind"], CabinViewState>> = Object.freeze({
  loading: Object.freeze({ kind: "loading" as const }),
  choices: Object.freeze({ kind: "choices" as const, choices: Object.freeze([]) }),
  confirming: Object.freeze({ kind: "confirming" as const, choices: Object.freeze([]), choiceHandle: "CHOICE" }),
  admitted: Object.freeze({ kind: "admitted" as const }),
  uncertain: Object.freeze({ kind: "uncertain" as const }),
  unavailable: Object.freeze({ kind: "unavailable" as const, reread: false }),
  missing: Object.freeze({ kind: "missing" as const, reread: false }),
});
