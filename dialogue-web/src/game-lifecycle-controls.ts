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
 *   `"running"` means a Player Host is attached), so neither is a state from which
 *   a launch may be started.
 * - `instance.status: "crashed"`/`"stopped"` is a game that ENDED - and there are two
 *   different facts behind those two words, which `attemptEndedWithKnownOutcome` below
 *   tells apart: an attempt the Host watched end (it has the report, so the next
 *   activation hands it back and stages the next instance) and one whose outcome nobody
 *   knows (the coordinator's launch quarantine, which no press in this process can leave).
 *   The first of the two leads the derivation even while this browser still holds its
 *   attachment: an attachment that outlived its world is a true fact, and it must not own the
 *   phase, because the activation it would withhold is the very press that releases it
 *   (`settleEndedAttempt`).
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
 * Setup keeps its offer in this derivation - `pre_activation` is the shape the panel draws it in,
 * and `GameSurface`'s handler guards on it - but the PANEL withholds the press while
 * `activationBlockedBy` names the missing registration. The premise setup needs is the same one
 * activation needs: the coordinator refuses setup until an attempt is staged
 * (`stardew_player_host_launch_not_staged` in
 * `stardew-production-lifecycle-coordinator.internal.ts`), and nothing can be staged without the
 * registration. So in that shape setup's only answer was "enable companion play" - the control the
 * same step has just withheld - and the offer stood beside a reason it contradicted. The step that
 * can act there is the installation panel on this page, which `gameInstallationRequired` names.
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

/**
 * Whether this instance slot is an attempt that ended AND whose ending the Host has.
 *
 * The two words the projection publishes for an ended game are not one fact, and the one
 * field that tells them apart is already published once:
 *
 * - `playerHostExitCode` is present exactly when this Host's Guardian watched the game
 *   process end (`game-browser-contract/index.ts`, `GameInstanceV1Schema`), and that
 *   ending is what the coordinator's settle needs. Either code - a crash's number or the
 *   OS's normal-termination 0 - is knowledge, and so is the player's own endgame, which
 *   publishes `stopped` with no code at all.
 * - `crashed` with NO code is the coordinator's launch quarantine: nobody knows what the
 *   Player Host did, so nothing is handed back and no press in this process reaches it
 *   (`STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS`).
 *
 * So the predicate is the Host's own settle condition, read off the two published fields
 * rather than guessed beside them.
 */
function attemptEndedWithKnownOutcome(instance: GameBrowserStateV1["game"]["instance"]): boolean {
  if (instance.status === "stopped") return true;
  return instance.status === "crashed" && instance.playerHostExitCode !== undefined;
}

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
  //
  // A game that ended occupies no instance either. An attempt the Host watched end is
  // handed back by the very activation this derivation offers, which then stages the next
  // instance - so the same three controls a first run starts with are the ones that start
  // another one. Withholding them was the dead end: `restart_gamebuddy` was the only step
  // left for a game the Host could start again in the same process.
  const nothingRunning = instance.status === "none" || attemptEndedWithKnownOutcome(instance);
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
   * No attachment while a Player Host runs, and the player is the reason: this browser disconnected
   * deliberately (`connectionStatus: "disconnected"`, the word `game/disconnect` publishes - it closes the
   * semantic attachment and never the world).
   *
   * The distinction from `running_without_attachment` is the whole point. There, the panel waits for a game
   * that has not handed over a farm yet, and "waiting for the game to hand this window your farm" is true.
   * Here nothing is coming: the world is still running and this browser let go of it, so the waiting
   * sentence is a promise nobody keeps, and the two states have two different steps.
   */
  | "disconnected_world_running"
  /**
   * No attachment and the launch failed for good: the coordinator is in `launch_quarantined`
   * (`stardew-game-lifecycle-state.internal.ts`) and answers every further launch with
   * `stardew_player_host_launch_quarantined`, so no control on this page can carry the player out.
   *
   * This is the ONE ending a GameBuddy restart is the answer to, and only because it is the one
   * ending no press reaches: the failed attempt leaves an owner record in the terminal
   * `quarantined` state, that record holds the installation registration the next launch has to
   * reserve, and the in-process settle refuses it by name (`stardew_player_host_attempt_settle_refused`,
   * because the launch's outcome nobody knows is exactly what must not be re-driven). Settlement
   * cannot release it: a launch that never reached the contained runtime has no runtime to contain,
   * and where one did, the settlement's first durable transition (`arm`) needs the `reserved`
   * predecessor the quarantine consumed. Nothing mints a settlement proof for a quarantined revision
   * either, and one would free the registration for a process whose containment was never observed.
   * The exit is a `never_spawned` proof - that no runtime was ever created - which belongs to the
   * next unit and not to this page. That gap is declared, with its reason, in
   * `STARDEW_GAME_LIFECYCLE_TRAPPED_TERMINALS`.
   *
   * So the phase names the honest step (`restart_gamebuddy`, kept because it is the only thing
   * this page can even name) and the sentence says it is not the cure.
   */
  | "launch_failed"
  /**
   * The game ended with a Host that holds the ending: the Guardian reported the process exiting (with
   * any code, the OS's normal-termination 0 included) or the player ended the game themselves. The
   * attempt is over, and the surface offers the step a first run starts with - activation, which is the
   * press that hands the ended attempt back and stages the next instance (`settleEndedAttempt`, then the
   * reservation that takes the durable registration's next number).
   *
   * This browser's attachment may still be latched (`attachment: attached`, `connectionStatus:
   * stopped`) while the phase is this one: nothing has released it yet, and the press above is what
   * does (`settleEndedAttempt` clears the attachment generation). So the attachment is not offered as a
   * step here - there is no session left to let go of, and the world it belonged to is gone.
   *
   * The crash and the quit are two events and one step, so they are two readings of the instance
   * row ("Ended (exit code 86)" beside "Ended (exit code 0)") and one phase: whichever way the
   * game went, what is left to do is the same. The distinction from `launch_failed` is the whole
   * point of the pair - there the Host has nothing, and here it has an ending it can act on.
   */
  | "ended_attempt_ready"
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
   * Whether the companion is in the player's farm, i.e. the phase is one a live attachment leads.
   *
   * `GameStatePanel` draws the in-farm affordances, and the cabin handoff with them, instead of the
   * getting-going guide exactly while this holds. The panel read `attachment.status` itself until an
   * attachment that outlived its world put it in the in-farm shape over a game the Host had already
   * watched end; the attachment is a true fact there and the phase is `ended_attempt_ready`, so the
   * phase is what the surface reads.
   */
  companionInFarm: boolean;
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
   * of the getting-going guide. True exactly in `launch_failed`, the one ending no
   * press on this page reaches.
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
   * getting-going guide. True in `game_not_read` and in `disconnected_world_running`, which
   * are two different questions with one answer: the Host has no reading to act on (it never
   * read the game), and the reading the player has is the one they took themselves (they
   * disconnected and the world went on). The panel draws the sentences apart - the control
   * and its handler are the same read.
   */
  rereadAvailable: boolean;
  /**
   * Whether the surface must state that the player disconnected from a world that is still
   * running, with the step that is left. True exactly in `disconnected_world_running`.
   */
  disconnectedWorldRunning: boolean;
}>;

const RESUMABLE_CONNECTION_STATUSES: ReadonlySet<string> = new Set(["failed", "disconnected"]);

/** The flags a phase sets beyond the ones `build` derives from the phase itself. */
type GameSessionControlFlags = Partial<
  Omit<
    GameSessionControls,
    "phase" | "forwardActions" | "waitingForGame" | "restartRequired" | "rereadAvailable" | "companionInFarm"
  >
>;

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
    flags: GameSessionControlFlags,
    forwardActions: readonly GameSessionForwardAction[],
    companionInFarm = false,
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
      companionInFarm,
      forwardActions: Object.freeze([...forwardActions]),
      waitingForGame: phase === "launching" || phase === "running_without_attachment",
      restartRequired: phase === "launch_failed",
      rereadAvailable: phase === "game_not_read" || phase === "disconnected_world_running",
      disconnectedWorldRunning: phase === "disconnected_world_running",
    });

  if (!view.ready || view.game === null) return build("no_projection", {}, ["terminal"]);
  const { instance, attachment, connectionStatus, actionAuthority } = view.game.game;

  // An attempt with a published ending leads, attachment or not.
  //
  // The attachment outliving its world is a true fact and this phase does not deny it. It is not what
  // decides the step, because activation is the press that both settles the attempt and releases the
  // attachment (`settleEndedAttempt` clears the attachment generation). Leading with the attachment
  // instead turned that into the dead end: the panel withheld the one press that frees it and offered
  // only the disconnect, so a player whose game had already gone had to panic-disconnect it before the
  // product would start another one.
  if (attemptEndedWithKnownOutcome(instance)) return build("ended_attempt_ready", {}, ["activate"]);

  // Otherwise a live attachment leads, exactly as the surface has always read it: the
  // routine session controls settle it whatever the instance row says beside it.
  if (attachment.status === "attached" && attachment.generation > 0) {
    // Every phase in this block is the in-farm state - the block's own condition is the fact - so the
    // flag is set once here rather than at each of the shapes below.
    const inFarm = (
      phase: GameSessionPhase,
      flags: GameSessionControlFlags,
      forwardActions: readonly GameSessionForwardAction[],
    ): GameSessionControls => build(phase, flags, forwardActions, true);
    if (connectionStatus === "connected_idle") {
      const reopenAvailable = actionAuthority === "paused";
      return inFarm(
        reopenAvailable ? "attached_actions_paused" : "attached_connected",
        { stopAvailable: true, disconnectAvailable: true, endgameAvailable: true, reopenAvailable },
        reopenAvailable ? ["reopen", "stop", "disconnect", "endgame"] : ["stop", "disconnect", "endgame"],
      );
    }
    if (RESUMABLE_CONNECTION_STATUSES.has(connectionStatus)) {
      if (view.resumeAttemptFailed)
        return inFarm(
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
        return inFarm(
          "attached_unsettled",
          { disconnectAvailable: true, endgameAvailable: true, retryResumeAvailable: true },
          ["retry_resume", "disconnect", "endgame"],
        );
      return inFarm(
        "attached_resumable",
        { disconnectAvailable: true, endgameAvailable: true, resumeAvailable: true },
        ["resume", "disconnect", "endgame"],
      );
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
    return inFarm(phase, { disconnectAvailable: true, endgameAvailable: true }, ["disconnect", "endgame"]);
  }

  // No attachment: what the Player Host instance is doing decides the step, and
  // the staging controls are the same derivation the getting-going guide renders.
  // An attempt whose outcome nobody knows answers first: it is the one ending no press on
  // this page reaches, so it is the one that names a step off the page instead of drawing a
  // control (`attemptEndedWithKnownOutcome` states why the two are not the same word).
  if (instance.status === "crashed" && instance.playerHostExitCode === undefined)
    return build("launch_failed", {}, ["restart_gamebuddy"]);
  if (instance.status === "launching") return build("launching", {}, ["wait_for_game"]);
  // Before any lifecycle control is considered: the Host has not read the game, so
  // there is no installation standing, staged attempt or expected generation for those
  // controls to act on. The step is the read the panel already owns.
  if (instance.status === "unread") return build("game_not_read", {}, ["reread_game"]);
  if (instance.status !== "none")
    // A running game this browser let go says so in the one word the disconnect publishes, and then the
    // step is not a wait: nothing is on its way. What this page can honestly do is read the game again -
    // which is how a world the player has since quit in the game reaches `ended_attempt_ready` and its
    // own step - and say, in a sentence, that the world they left is still running.
    return connectionStatus === "disconnected"
      ? build("disconnected_world_running", {}, ["reread_game"])
      : build("running_without_attachment", {}, ["wait_for_game"]);
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
  "disconnected_world_running",
  "launch_failed",
  "ended_attempt_ready",
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
      prerequisites: Object.freeze({ status: "met" as const, detectedGame: "Stardew Valley" }),
      instance: Object.freeze({ status: "running" as const, gameTitle: "Stardew Valley", generation: 1 }),
      compatibility: Object.freeze({ status: "compatible" as const, message: null }),
      attachment: Object.freeze({ status: "none" as const, generation: 0 }),
      connectionStatus: "none" as const,
      actionAuthority: "active" as const,
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: Object.freeze({ status: "not_measured", reason: "no_attached_runtime" }),
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
        prerequisites: { status: "unknown", detectedGame: null },
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
          prerequisites: { status: "met", detectedGame: "Stardew Valley" },
        }),
      ),
      activated_not_launched: input(
        game({
          instance: { status: "none", gameTitle: null, generation: 1 },
        }),
      ),
      launching: input(game({ instance: { status: "launching", gameTitle: "Stardew Valley", generation: 1 } })),
      running_without_attachment: input(game({})),
      // The state `game/disconnect` leaves behind, exactly as a live run read it: the world still
      // running at generation 0, no attachment, `disconnected` as the reason, no action authority.
      disconnected_world_running: input(
        game({
          instance: { status: "running", gameTitle: "Stardew Valley", generation: 0 },
          connectionStatus: "disconnected",
          actionAuthority: "unavailable",
        }),
      ),
      launch_failed: input(
        game({
          // No `playerHostExitCode`: nobody knows what the Player Host did, which is exactly the
          // fact that makes this the one ending a press cannot leave.
          instance: { status: "crashed", gameTitle: "Stardew Valley", generation: 0 },
          latestOutcome: "failed",
        }),
      ),
      ended_attempt_ready: input(
        game({
          // The player quit the game: the Guardian reported the OS's own normal termination, so
          // the ending is knowledge and the attempt is the Host's to hand back.
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
  /**
   * The cabins this companion may use.
   *
   * `staleRefusal` is the game having answered the press before this read with
   * `stardew_cabin_choice_stale`: the offers here are the ones read in answer to it, so the flag says
   * what the list is, not whether it is usable. It rides the list rather than becoming a state of its
   * own because the player's next act is the same one either way - confirm one - and the only
   * difference is the sentence above it.
   */
  | Readonly<{ kind: "choices"; choices: readonly StardewCabinChoiceV1[]; staleRefusal: boolean }>
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

/**
 * What the panel's own post-launch cabin reads are doing.
 *
 * The handoff was read once, on mount, and a launch then left it alone: the only way forward out
 * of `launching` is a confirmed cabin, so the surface sat there until the player found the refresh
 * control. Measured in a live run (2026-11-15): the Host answered `Cabin 1` in 45 ms once asked.
 *
 * The shell owns the asking (it is the one holding the admitted launch and the budget) and this
 * union is what it tells the panel: `not_launching` is every ordinary screen, `reading` names the
 * attempt the budget is on, and `expired` is the budget spent with no cabin - a fact the copy has
 * to answer with a step, not a silence.
 */
export type CabinLaunchWaitState =
  | Readonly<{ kind: "not_launching" }>
  | Readonly<{ kind: "reading"; attempt: number; attempts: number }>
  | Readonly<{ kind: "expired"; attempts: number }>;

/**
 * The one line the launch wait puts above the handoff's own state, carrying its own numbers.
 *
 * `launching` with a cabin in hand and `launching` with nothing yet are different facts about the
 * same word, and a player reading the second as the first would think the choice had gone. So the
 * line is derived from the cabin view, the wait and the projection together rather than from any
 * one of them, and `none` means the handoff's ordinary copy is the whole of it.
 */
export type CabinLaunchLine =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "reading"; attempt: number; attempts: number }>
  | Readonly<{ kind: "cabin_ready" }>
  | Readonly<{ kind: "wait_expired"; attempts: number }>;

/**
 * Which line, if any, the launch wait adds.
 *
 * `launching` is the precondition of every one of them: with the launch in flight the panel is
 * asking, and the only question is what it has found. A cabin in hand wins over everything (§ once
 * the list is there the player's next act is the choice, and nothing else about the wait matters);
 * below it are the two shapes of "nothing yet" - still asking, with the attempt the budget is on so
 * the panel's own asking is visible instead of a screen that changes for no stated reason, and done
 * asking.
 */
export function deriveCabinLaunchLine(
  view: Readonly<{ cabin: CabinViewState; wait: CabinLaunchWaitState; launchInFlight: boolean }>,
): CabinLaunchLine {
  if (!view.launchInFlight) return Object.freeze({ kind: "none" });
  if (view.cabin.kind === "choices") return Object.freeze({ kind: "cabin_ready" });
  switch (view.wait.kind) {
    case "reading":
      return Object.freeze({ kind: "reading", attempt: view.wait.attempt, attempts: view.wait.attempts });
    case "expired":
      return Object.freeze({ kind: "wait_expired", attempts: view.wait.attempts });
    case "not_launching":
      return Object.freeze({ kind: "none" });
    // The assertion travels with the switch for the reason `deriveCabinHandoffActions` states: the
    // declaration already refuses a new kind, and the guard keeps that refusal in the switch itself.
    default:
      return assertNever(view.wait);
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
  choices: Object.freeze({ kind: "choices" as const, choices: Object.freeze([]), staleRefusal: false }),
  confirming: Object.freeze({ kind: "confirming" as const, choices: Object.freeze([]), choiceHandle: "CHOICE" }),
  admitted: Object.freeze({ kind: "admitted" as const }),
  uncertain: Object.freeze({ kind: "uncertain" as const }),
  unavailable: Object.freeze({ kind: "unavailable" as const, reread: false }),
  missing: Object.freeze({ kind: "missing" as const, reread: false }),
});

/**
 * Whether an authoritative reading proves the setup attempt staged NOTHING.
 *
 * This is the fact a retry's idempotency key turns on, and it is deliberately not a fact about the
 * installation. A setup command whose attempt staged nothing can be retried under a fresh key without
 * risking a duplicate, and the coordinator re-executes it; an attempt that staged something must be
 * retried under the SAME key, because the command may already have been admitted and a new key would
 * repeat its side effect rather than ask what happened.
 *
 * `instance.status`/`instance.generation` are the Host's own words for "nothing is staged";
 * `prerequisites` is a fact about the registration, and reading that here is how the rule came to fire
 * only in the shape where the panel no longer offers the press at all (a registered folder is what
 * makes setup offered - see `deriveGameLifecycleControlAvailability`). `handleGameLaunch` already asks
 * the same question the same way.
 */
export function setupStagedNothing(game: GameBrowserStateV1 | null): boolean {
  return game !== null && game.game.instance.status === "none" && game.game.instance.generation < 1;
}
