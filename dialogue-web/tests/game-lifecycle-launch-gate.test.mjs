/**
 * Cross-boundary launch-control test.
 *
 * The failure this file exists for: the Host's projection and the client's gates
 * each passed their own tests while disagreeing about one word. After a
 * successful activation the Host projected `instance.status === "launching"`
 * (because the facade's process owner reports the launch reservation minted at
 * activation as a pending role), while the client only offers the launch control
 * for `prerequisites: "met"` + `instance.status: "none"` + the expected
 * generation. The player was left holding an activated attempt with no control
 * to start it.
 *
 * So this test crosses the boundary for real, in one process:
 *   Host   `createStardewRoleLifecycleFacade` (the real facade, fed the real
 *          process-owner status an activated-but-not-launched attempt has)
 *   Host   `composeCoordinatorRoleLifecycleView` (the production composition rule)
 *   Host   `createGameBrowserStateProvider` (the production `game.state.read`)
 *   Client `deriveGameLifecycleControlAvailability` (the component's own gate)
 *
 * If any of the three transformations drifts back to the old disagreement the
 * client's launch flag goes false while activation is also false, and the
 * assertion below reports the dead end instead of both sides staying green.
 *
 * The two leaf facts are the input to the Host chain, and both are pinned by the
 * Host's own suite: an activated attempt holds an outstanding Player Host launch
 * reservation (`player_host_launch_pending` in
 * `stardew-private-bootstrap-composer.private.test.ts`), and a staged attempt's
 * launch-readiness reader says `{ status: "ready", generation: 1 }`
 * (`stardew-production-lifecycle-coordinator.internal.test.ts`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { composeCoordinatorRoleLifecycleView } from "../../host/src/games/stardew/lifecycle/stardew-role-lifecycle-projection.internal.js";
import { createStardewRoleLifecycleFacade } from "../../host/src/stardew-role-lifecycle-facade.js";
import { createGameBrowserStateProvider } from "../../host/src/game-browser/game-browser-state-provider.js";
import { composeGameProfile } from "../../host/src/game-browser-contract/index.js";
import {
  deriveCabinHandoffActions,
  deriveCabinLaunchLine,
  deriveGameLifecycleControlAvailability,
  deriveGameSessionControls,
  GAME_SESSION_INPUTS,
  GAME_SESSION_PHASES,
  CABIN_HANDOFF_INPUTS,
  CABIN_HANDOFF_KINDS,
  setupStagedNothing,
} from "../src/game-lifecycle-controls.ts";
import { messages } from "../src/i18n.ts";
import { instanceLabel } from "../src/game-presentation.ts";
import { composedProblemView, gameOperationFailure } from "../src/composed-problem-view.ts";
import { ComposedReferenceGameProblemError } from "../src/composed-reference-game-browser-api.ts";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE = join(DIALOGUE_WEB, "src", "game-lifecycle-controls.ts");
/** The player-facing sentences this gate reads, in the product's own default locale. */
const MESSAGES = messages("en");
/**
 * The session step vocabulary, read out of the module's own union rather than
 * retyped here, so a member added there is covered without the gate keeping a
 * second copy that can drift.
 *
 * The anchor deliberately does NOT include the `export` keyword. This type is used only inside its own
 * module, so a lint pass that removes a needless `export` must not be able to break this gate - and it
 * did exactly that once. An anchor on the declaration itself survives a visibility change, which is
 * the only thing that anchor is about; the union's members are the fact being read.
 */
const SESSION_FORWARD_ACTIONS = (() => {
  const source = readFileSync(MODULE, "utf8");
  const start = source.search(/\btype\s+GameSessionForwardAction\s*=/u);
  assert.notEqual(start, -1, "the session step union is declared where this gate reads it");
  const end = source.indexOf(";", start);
  return [...source.slice(start, end).matchAll(/\|\s*"([a-z_]+)"/gu)].map((match) => match[1]);
})();

const CONTEXT = Object.freeze({
  csrfToken: "QWxhZGRpbjpvcGVuIHNlc2FtZQ",
  browserSessionExpiresAtMs: 100_000,
});

const gameProfile = composeGameProfile({
  profileId: "gamebuddy.game.preview",
  releaseTier: "game_preview",
  operationIds: ["game.state.read"],
  navigationItemIds: ["game"],
});

const NOT_ATTACHED = Object.freeze({ status: "none", generation: 0, connectionStatus: "none" });

function attachmentReader() {
  return Object.freeze({ readAttachmentView: () => NOT_ATTACHED });
}

function launchReadinessReader(view) {
  // `playerHostExitCode` is part of the launch-readiness fact: absent means the Host observed no
  // exit for this lifecycle's game process. The default keeps every fixture below honest about
  // that instead of letting an omitted field reach the projection as `undefined`.
  return Object.freeze({ readLaunchReadinessView: () => Object.freeze({ playerHostExitCode: null, ...view }) });
}

function lifecycleReader(view) {
  return Object.freeze({ readRoleLifecycleView: async () => view });
}

function installationReader(value) {
  return Object.freeze({ readInstallationView: async () => value });
}

function readState(lifecycleView, readiness, installation) {
  return createGameBrowserStateProvider(
    gameProfile,
    lifecycleReader(lifecycleView),
    attachmentReader(),
    launchReadinessReader(readiness),
    undefined,
    installation === undefined ? undefined : installationReader(installation),
  ).readState(CONTEXT);
}

/** The real facade with the process-owner status a Player Host role has. */
async function facadeViewFor(playerHostStatus) {
  const aiClientOwner = Object.freeze({ readStatus: () => Object.freeze({ kind: "ai_client_launch_pending" }) });
  const playerHostOwner = Object.freeze({ readStatus: () => Object.freeze({ kind: playerHostStatus }) });
  const facade = createStardewRoleLifecycleFacade(null, aiClientOwner, playerHostOwner);
  return await facade.readRoleLifecycleView();
}

function clientControls(gameState) {
  return deriveGameLifecycleControlAvailability({ ready: true, game: gameState });
}

test("an activated but not yet launched attempt offers the player the launch control", async () => {
  // The real facade reports the launch reservation as a pending role: this is
  // the word the two sides disagreed about.
  const facadeView = await facadeViewFor("player_host_launch_pending");
  assert.deepEqual(facadeView.playerHost, { state: "pending", ownership: "gamebuddy_direct_spawn" });

  // The coordinator owns the activation state and knows no launch was requested.
  const stagedView = composeCoordinatorRoleLifecycleView("staged", facadeView);
  assert.deepEqual(stagedView.playerHost, { state: "not_started", ownership: "none" });

  const gameState = await readState(stagedView, { status: "ready", generation: 1 });
  assert.equal(gameState.game.prerequisites.status, "met");
  assert.deepEqual(gameState.game.instance, { status: "none", gameTitle: null, generation: 1 });

  assert.deepEqual(clientControls(gameState), {
    activationAvailable: false,
    setupAvailable: false,
    launchAvailable: true,
    launchGeneration: 1,
    activationBlockedBy: null,
  });
});

test("a launch actually in flight still projects launching and offers no launch control", async () => {
  const facadeView = await facadeViewFor("player_host_launch_pending");
  const launchingView = composeCoordinatorRoleLifecycleView("launching_player_host", facadeView);
  assert.deepEqual(launchingView.playerHost, { state: "pending", ownership: "gamebuddy_direct_spawn" });

  const gameState = await readState(launchingView, { status: "none", generation: 0 });
  assert.equal(gameState.game.instance.status, "launching");
  assert.deepEqual(clientControls(gameState), {
    activationAvailable: false,
    setupAvailable: false,
    launchAvailable: false,
    launchGeneration: null,
    activationBlockedBy: null,
  });
});

test("before the player's game folder is registered the activation control is withheld and its reason is named", async () => {
  const idleFacadeView = await facadeViewFor("idle");
  assert.deepEqual(idleFacadeView.playerHost, { state: "not_started", ownership: "none" });
  // An inactive lifecycle is not a state the coordinator owns.
  assert.equal(composeCoordinatorRoleLifecycleView("inactive", idleFacadeView), idleFacadeView);

  // No installation reader is mounted, which is the same projection a session with no bound
  // registration publishes: activation reserves and stages the owned Player Host *against that
  // registration* and answers `stardew_bootstrap_registration_unavailable` without one.
  const gameState = await readState(idleFacadeView, { status: "none", generation: 0 });
  assert.equal(gameState.game.prerequisites.status, "unknown");
  assert.deepEqual(gameState.game.instance, { status: "none", gameTitle: null, generation: 0 });
  // The client's own gate: the press is withheld, and the fact that withholds it is named
  // rather than left to the refusal the press would earn.
  assert.deepEqual(clientControls(gameState), {
    activationAvailable: false,
    setupAvailable: true,
    launchAvailable: false,
    launchGeneration: null,
    activationBlockedBy: "installation_not_registered",
  });
  // The step is still step 1 - the phase does not move - and the panel states why.
  const controls = deriveGameSessionControls({
    ready: true,
    game: gameState,
    resumeFailureSurface: false,
    resumeAttemptFailed: false,
  });
  assert.equal(controls.phase, "pre_activation", "nothing is staged, so the phase is unchanged");
  assert.deepEqual([...controls.forwardActions], ["activate", "setup"]);
  assert.equal(controls.installationRequired, true, "the panel withholds the press and states the reason");
});

/**
 * The retry key's rule, both halves, over the client's own phase population.
 *
 * `setupStagedNothing` is what `handleGameSetup` reads to decide whether a refused attempt may be
 * retried under a fresh idempotency key, and the temptation this gate removes is reading it off the
 * installation instead: the panel offers setup only while a registration exists, so a rule phrased on
 * `prerequisites.status === "unknown"` could never fire in the shape where the press exists, and the
 * player's retry after a terminal failure replayed a cached rejection. The two directions are the
 * whole rule: nothing staged -> a fresh key is safe, because the command's side effect is not on the
 * game; something staged -> the SAME key, because the command may already have been admitted.
 */
test("a setup retry may use a fresh key exactly when the reading proves nothing was staged", () => {
  const registered = GAME_SESSION_INPUTS.pre_activation.game;
  const staged = GAME_SESSION_INPUTS.activated_not_launched.game;
  const launching = GAME_SESSION_INPUTS.launching.game;

  assert.equal(setupStagedNothing(registered), true, "a registered folder with nothing staged is retryable");
  // The same projection with no registration: the rule is about staged-ness, so it answers the same.
  // Reading `prerequisites` here is the bug this gate exists for.
  const unregistered = {
    ...registered,
    game: {
      ...registered.game,
      prerequisites: { status: "unknown", detectedGame: null },
    },
  };
  assert.equal(
    setupStagedNothing(unregistered),
    true,
    "the registration is a separate fact and must not move this rule",
  );

  assert.equal(
    setupStagedNothing(staged),
    false,
    "an attempt that staged a Player Host is NOT retryable under a fresh key: the command may have been admitted",
  );
  assert.equal(setupStagedNothing(launching), false, "a launch in flight staged something too");
  assert.equal(setupStagedNothing(null), false, "no projection proves nothing, so it proves no such thing");
});

test("a running lifecycle stays running and is never a launch-from-idle candidate", async () => {
  // Provider vocabulary pin: `authenticated` is the composed word for a running,
  // attached Player Host. (The coordinator constructs its facade without an
  // attachment flow today, so this pins the client boundary rather than a
  // coordinator-reachable state.)
  const runningView = Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({
      state: "authenticated",
      ownership: "player_external",
      compatibility: "verified",
      attachmentAllowed: true,
    }),
    aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
  });
  const gameState = await readState(runningView, { status: "none", generation: 0 });
  assert.equal(gameState.game.instance.status, "running");
  assert.deepEqual(clientControls(gameState), {
    activationAvailable: false,
    setupAvailable: false,
    launchAvailable: false,
    launchGeneration: null,
    activationBlockedBy: null,
  });
});

/**
 * The first run after the player confirms their installation.
 *
 * Confirming a game folder publishes a ready registration, and the state provider
 * counts that registration as `prerequisites: "met"` (`game-browser-state-provider.ts:76`).
 * The lifecycle itself is untouched - no owner, no staged attempt, no expected
 * generation - so the projection is `met` / `none` / generation 0, which is neither
 * the pre-activation shape the staging controls used to require (`prerequisites:
 * "unknown"`) nor the activated shape the launch control requires (generation >= 1).
 *
 * The failure this catches: reading `prerequisites` as the word for "was activation
 * done" retired both staging controls the moment the installation was confirmed, and
 * with no expected generation the launch control was not offered either - a brand-new
 * player who had just confirmed their installation was left with no control at all.
 */
test("a confirmed installation with no staged attempt still offers the player activation", async () => {
  const idleFacadeView = await facadeViewFor("idle");
  const gameState = await readState(idleFacadeView, { status: "none", generation: 0 }, "registered");

  // The installation registration is what the player just produced; it is not evidence
  // that anything was activated.
  assert.equal(gameState.game.prerequisites.status, "met");
  assert.deepEqual(gameState.game.instance, { status: "none", gameTitle: null, generation: 0 });

  assert.deepEqual(clientControls(gameState), {
    activationAvailable: true,
    setupAvailable: true,
    launchAvailable: false,
    launchGeneration: null,
    activationBlockedBy: null,
  });
});

/**
 * No player-reachable lifecycle shape is a control dead end: whenever nothing is
 * running, exactly one of the three lifecycle controls is offered, and the player is
 * never shown nothing to press. The population is derived from the two flags the
 * browser contract distinguishes rather than from a hand-written list of states, so a
 * future projection shape cannot reintroduce the dead end silently.
 */
test("every nothing-running lifecycle shape offers the player a lifecycle control", async () => {
  const idleFacadeView = await facadeViewFor("idle");
  const deadEnds = [];
  for (const installation of ["absent", "registered"])
    for (const generation of [0, 1]) {
      const gameState = await readState(idleFacadeView, { status: generation === 1 ? "ready" : "none", generation }, installation);
      const controls = clientControls(gameState);
      if (!controls.activationAvailable && !controls.setupAvailable && !controls.launchAvailable)
        deadEnds.push({ installation, generation, prerequisites: gameState.game.prerequisites.status });
    }

  assert.deepEqual(deadEnds, []);
});

/**
 * The second half of the same rule: the session-and-recovery state machine.
 *
 * `GameStatePanel.tsx`'s end-or-recover half - Stop, Disconnect, Endgame, and the
 * three ways out of a failed Resume - was the untested half of the highest-ranked
 * gap in `tests/frontend-coverage-surface.md`, and it is the half whose failure
 * mode is a live game with no exit. The state machine it belongs to now has the
 * same single derivation the launch controls got (`game-lifecycle-controls.ts`),
 * so the gate below can enumerate it instead of restating it.
 *
 * The population is DERIVED, twice over, exactly as `forward-path.1`..`6` do it:
 *
 *  - the phases come from `GAME_SESSION_PHASES`, the module's own list, so adding
 *    a phase fails here until somebody states its forward action;
 *  - each phase is reached by driving `deriveGameSessionControls` with the input
 *    `GAME_SESSION_INPUTS` declares, so a phase the derivation can no longer
 *    produce is reported as unreachable rather than passing on a hand-written row.
 *
 * The one allowed exception is `no_projection`: the Host published no Game
 * projection at all, so there is no session to advance and the step out is the
 * AppBar's own surface switch - shell chrome, present whenever this surface is.
 * That is the same shape `in_play` has for the companion roster, and the gate
 * keeps it the only such phase.
 */

/** Whether the flags a derivation returned carry the step it names. */
export function sessionForwardActionHolds(controls, action) {
  switch (action) {
    case "terminal":
      // Reserved for the phase with no session to advance: the AppBar is the step.
      return controls.phase === "no_projection";
    case "activate":
      return controls.phase === "pre_activation";
    case "setup":
      return controls.phase === "pre_activation";
    case "launch":
      return controls.phase === "activated_not_launched" || controls.phase === "running_without_attachment";
    case "stop":
      return controls.stopAvailable;
    case "disconnect":
      return controls.disconnectAvailable;
    case "endgame":
      return controls.endgameAvailable;
    case "resume":
      return controls.resumeAvailable;
    case "retry_resume":
      return controls.retryResumeAvailable;
    case "cancel_resume":
      return controls.cancelResumeAvailable;
    case "create":
      return controls.createAvailable;
    case "reopen":
      return controls.reopenAvailable;
    case "wait_for_game":
      return controls.waitingForGame;
    case "reread_game":
      // The Host has not read the player's game: the step is the read, and the
      // sentence that names it is what the panel draws.
      return controls.rereadAvailable;
    case "restart_gamebuddy":
      // A step the surface cannot draw. It is a step only because the sentence
      // that names it is drawn instead, so the flag is the whole proof.
      return controls.restartRequired;
    default:
      return false;
  }
}

/** The rule over any population, so a planted phase drives the exact comparison the gate runs. */
export function sessionZeroForwardPathFindings(phases, inputs, derive) {
  const findings = [];
  for (const phase of phases) {
    const declared = inputs[phase];
    if (declared === undefined) {
      findings.push(`${phase}: reachable phase with no declared inputs, so nothing can reach it`);
      continue;
    }
    const controls = derive(declared);
    if (controls.phase !== phase) {
      findings.push(
        `${phase}: the derivation answers ${JSON.stringify(controls.phase)} for ${phase}'s own inputs, so the phase is unreachable`,
      );
      continue;
    }
    if (controls.forwardActions.length === 0) {
      findings.push(`${phase}: reachable non-terminal phase with no forward action`);
      continue;
    }
    for (const action of controls.forwardActions) {
      if (!sessionForwardActionHolds(controls, action)) {
        findings.push(
          `${phase}: names the forward action ${JSON.stringify(action)} but its flags do not offer it ` +
            `(stop=${controls.stopAvailable}, disconnect=${controls.disconnectAvailable}, endgame=${controls.endgameAvailable}, ` +
            `resume=${controls.resumeAvailable}, retryResume=${controls.retryResumeAvailable}, ` +
            `cancelResume=${controls.cancelResumeAvailable}, create=${controls.createAvailable}, ` +
            `reopen=${controls.reopenAvailable}, waitingForGame=${controls.waitingForGame}, ` +
            `restartRequired=${controls.restartRequired})`,
        );
      }
    }
  }
  return findings;
}

test("session-forward-path.1: every reachable Game session phase offers the player a step", (t) => {
  const findings = sessionZeroForwardPathFindings(GAME_SESSION_PHASES, GAME_SESSION_INPUTS, deriveGameSessionControls);
  t.diagnostic(
    `session-forward-path.1: ${GAME_SESSION_PHASES.length} phase(s): ` +
      GAME_SESSION_PHASES.map(
        (phase) => `${phase}->${deriveGameSessionControls(GAME_SESSION_INPUTS[phase]).forwardActions.join("+") || "(none)"}`,
      ).join(", "),
  );
  assert.deepEqual(findings, [], "a reachable Game state with nothing to press and no step named is a dead end");
});

test("session-forward-path.2: `no_projection` is the ONLY phase with no step of its own", (t) => {
  const terminal = GAME_SESSION_PHASES.filter((phase) =>
    deriveGameSessionControls(GAME_SESSION_INPUTS[phase]).forwardActions.includes("terminal"),
  );
  assert.deepEqual(
    terminal,
    ["no_projection"],
    "there is no Game projection to advance there, and the AppBar's surface switch is the step; " +
      "any other terminal phase is the dead end this gate exists for",
  );
  t.diagnostic(`session-forward-path.2: terminal=${terminal.join(", ")}`);
});

test("session-forward-path.3: the endgame control is offered exactly where a live attachment can be ended", (t) => {
  // The terminal operation's precondition is the live attachment, which is the
  // same fact everything else in the session group keys on. Stating it as an
  // equality over the whole population is what keeps a future phase from
  // inheriting a control the coordinator would refuse.
  const attached = GAME_SESSION_PHASES.filter(
    (phase) => GAME_SESSION_INPUTS[phase].game?.game.attachment.status === "attached",
  );
  assert.ok(attached.length > 0, "the population still contains attached phases");
  for (const phase of attached) {
    const controls = deriveGameSessionControls(GAME_SESSION_INPUTS[phase]);
    assert.equal(controls.endgameAvailable, true, `${phase} holds a live attachment, so the terminal operation is offered`);
    assert.ok(controls.forwardActions.includes("endgame"), `${phase} names the terminal operation among its steps`);
    // And the sentence that says the operation cannot be undone is read before the
    // press, not after it: the confirm step is the panel's own contract, pinned
    // here on the catalogue string so a rewording that drops the warning fails.
    assert.match(
      MESSAGES.gameEndgameConfirm,
      /cannot be undone/u,
      "the confirm step states that ending the game cannot be undone, before the press",
    );
  }
  for (const phase of GAME_SESSION_PHASES.filter((candidate) => !attached.includes(candidate))) {
    assert.equal(
      deriveGameSessionControls(GAME_SESSION_INPUTS[phase]).endgameAvailable,
      false,
      `${phase} holds no live attachment, so there is nothing to end`,
    );
  }
  t.diagnostic(`session-forward-path.3: ${attached.length} attached phase(s) offer the terminal operation with its warning`);
});

test("session-forward-path.4: a dropped connection always offers a way back that is not a reload", (t) => {
  // The failed-resume half: after an attempt fails, the surface must offer Retry,
  // Cancel and Start new game - the three the coverage report named - and Retry
  // must replay the same command the attempt used, never a second one.
  const failed = deriveGameSessionControls(GAME_SESSION_INPUTS.attached_resume_failed);
  assert.equal(failed.phase, "attached_resume_failed");
  assert.equal(failed.retryResumeAvailable, true, "the attempt that failed is retried under its own name");
  assert.equal(failed.cancelResumeAvailable, true, "the reconnect can be cancelled");
  assert.equal(failed.createAvailable, true, "a new game is the third way out");
  assert.equal(failed.resumeAvailable, false, "one command, one control: the retry owns the attempt that failed");
  assert.deepEqual([...failed.forwardActions], ["retry_resume", "cancel_resume", "create", "disconnect", "endgame"]);

  // The state before a failed attempt offers the restore, and only it.
  const resumable = deriveGameSessionControls(GAME_SESSION_INPUTS.attached_resumable);
  assert.equal(resumable.resumeAvailable, true);
  assert.equal(resumable.retryResumeAvailable, false);
  assert.equal(resumable.cancelResumeAvailable, false, "there is no failed attempt to cancel yet");
  assert.equal(resumable.createAvailable, false, "a new game is not offered before an attempt has failed");

  // The state the Host's own failed outcome reaches without an attempt of this
  // surface's own. Retry/Cancel/Start new game act on an attempt - its key, its
  // epoch, its replacement - so offering them here would be three controls whose
  // handlers refuse (`handleGameResumeCancel` and `handleGameCreate` both return
  // early with no attempt). Measured on the real shell: the click did nothing.
  const unsettled = deriveGameSessionControls(GAME_SESSION_INPUTS.attached_unsettled);
  assert.equal(unsettled.phase, "attached_unsettled");
  assert.equal(unsettled.retryResumeAvailable, true, "the restore is offered: its handler needs only the live attachment");
  assert.equal(unsettled.cancelResumeAvailable, false, "there is no reconnect epoch to cancel");
  assert.equal(unsettled.createAvailable, false, "there is no attempt for a new game to replace");
  assert.equal(unsettled.disconnectAvailable, true, "the session is still the player's to settle");

  t.diagnostic(
    "session-forward-path.4: the rollup offers all three ways out exactly while there is an attempt to act on",
  );
});

test("session-forward-path.5 (mutation): a phase whose flags offer nothing is reported by name", (t) => {
  const planted = {
    planted_launch_dead_end: {
      phase: "planted_launch_dead_end",
      forwardActions: ["launch"],
      waitingForGame: false,
      restartRequired: false,
    },
    planted_silent: { phase: "planted_silent", forwardActions: [], waitingForGame: false, restartRequired: false },
  };
  const findings = sessionZeroForwardPathFindings(
    ["planted_launch_dead_end", "planted_silent", "attached_connected"],
    {
      planted_launch_dead_end: { name: "planted_launch_dead_end" },
      planted_silent: { name: "planted_silent" },
      attached_connected: { name: "attached_connected" },
    },
    (input) =>
      input.name === "attached_connected"
        ? deriveGameSessionControls(GAME_SESSION_INPUTS.attached_connected)
        : planted[input.name],
  );
  assert.equal(findings.length, 2, `exactly the two planted phases must fail, saw ${JSON.stringify(findings)}`);
  assert.match(findings[0], /^planted_launch_dead_end: names the forward action "launch" but its flags do not offer it/u);
  assert.match(findings[1], /^planted_silent: reachable non-terminal phase with no forward action/u);
  assert.deepEqual(
    findings.filter((finding) => finding.startsWith("attached_connected:")),
    [],
    "the real phase in the same population passes: the comparison is not simply always-red",
  );
  t.diagnostic(`session-forward-path.5: planted -> ${findings.join(" | ")}`);
});

/**
 * The state this file exists for on the read side: the Host has not read the player's game.
 *
 * `game.state.read` used to publish `instance.status: "none"` for that case - the word for
 * "nothing is running yet" - so the surface offered setup and activation to a player whose
 * game the Host had not read at all: two controls pointing at a premise that does not hold,
 * and no way to say so. The population below is the real Host chain (the facade's own view,
 * the production composition rule, the production `game.state.read`) followed by the
 * component's own derivation, so neither side can drift back to that word alone.
 */
test("a player game the Host has not read offers the read, not setup or activation", async (t) => {
  const unreadFacadeView = Object.freeze({
    schemaVersion: 1,
    playerHost: Object.freeze({ state: "unavailable", ownership: "player_external" }),
    aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
  });
  // The facade is authoritative here: an inactive lifecycle owns no Player Host slot.
  assert.equal(composeCoordinatorRoleLifecycleView("inactive", unreadFacadeView), unreadFacadeView);

  // A registered installation is the shape that used to read as `met` + `none` + generation 0,
  // i.e. the pre-activation state that offers setup and activation.
  const gameState = await readState(unreadFacadeView, { status: "none", generation: 0 }, "registered");
  assert.equal(gameState.game.instance.status, "unread", "the publishable word for an unread game is not `none`");
  assert.equal(gameState.game.instance.gameTitle, null, "an unread game has no title to publish");
  assert.deepEqual(clientControls(gameState), {
    activationAvailable: false,
    setupAvailable: false,
    launchAvailable: false,
    launchGeneration: null,
    activationBlockedBy: null,
  });

  const controls = deriveGameSessionControls({
    ready: true,
    game: gameState,
    resumeFailureSurface: false,
    resumeAttemptFailed: false,
  });
  assert.equal(controls.phase, "game_not_read");
  assert.deepEqual([...controls.forwardActions], ["reread_game"]);
  assert.equal(controls.rereadAvailable, true, "the panel's own read is the step");
  // The negative half: no control exists here whose premise the Host has not established.
  assert.equal(controls.reopenAvailable, false);
  assert.equal(controls.resumeAvailable, false);
  assert.equal(controls.createAvailable, false);
  assert.equal(controls.stopAvailable, false);
  assert.equal(controls.disconnectAvailable, false);
  assert.equal(controls.endgameAvailable, false);
  assert.equal(controls.waitingForGame, false, "this is not a wait for the game");
  assert.equal(controls.restartRequired, false, "a re-read is the step, not a restart");
  t.diagnostic(`game-not-read: ${controls.phase} -> ${controls.forwardActions.join("+")}`);
});

test("session-forward-path.6: the phase list, the union and the derivation are one authority", (t) => {
  const module = readFileSync(MODULE, "utf8");
  const start = module.indexOf("export type GameSessionPhase =");
  assert.notEqual(start, -1, "the session phase union is still declared where the gate reads it");
  const end = module.indexOf(";", start);
  assert.notEqual(end, -1, "the session phase union's declaration is terminated");
  const declared = [...module.slice(start, end).matchAll(/\|\s*"([a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(
    [...declared].sort(),
    [...GAME_SESSION_PHASES].sort(),
    `the union declares ${declared.length} phase(s) and the list enumerates ${GAME_SESSION_PHASES.length}: ` +
      "a phase in one and not the other is a state the gate never looks at",
  );
  for (const phase of GAME_SESSION_PHASES) {
    assert.ok(GAME_SESSION_INPUTS[phase] !== undefined, `${phase} has declared inputs, so the gate can reach it`);
    assert.ok(
      SESSION_FORWARD_ACTIONS.includes(deriveGameSessionControls(GAME_SESSION_INPUTS[phase]).forwardActions[0] ?? "") ||
        deriveGameSessionControls(GAME_SESSION_INPUTS[phase]).forwardActions.length === 0,
      `${phase}'s first step is a member of the declared vocabulary`,
    );
  }
  // Nothing in the gate declares its own list: the population, the inputs and the
  // derivation are imported, so there is no second list to forget to update.
  assert.match(
    readFileSync(fileURLToPath(import.meta.url), "utf8"),
    /import \{[^}]*GAME_SESSION_PHASES[^}]*\} from "\.\.\/src\/game-lifecycle-controls\.ts"/u,
    "the session phase list is imported from the module that owns it",
  );
  t.diagnostic(`session-forward-path.6: ${GAME_SESSION_PHASES.length} session phase(s) declared, enumerated and reachable`);
});

/**
 * The cabin handoff's own state machine.
 *
 * It is the third step of the first run, and the failure this gate exists for was measured in
 * the shell: an `uncertain` confirmation - the one outcome whose publication no one knows -
 * rendered a warning sentence and no control at all, so the only exit was reloading the page,
 * which drops the Host connection and this surface's own attachment.
 *
 * The population is the module's own union, listed and given an input per kind, exactly as the
 * session phases are, so a kind added there fails here until somebody states its step.
 */

/** The rule over any population, so a planted kind drives the exact comparison the gate runs. */
export function cabinZeroForwardPathFindings(kinds, inputs, derive) {
  const findings = [];
  for (const kind of kinds) {
    const declared = inputs[kind];
    if (declared === undefined) {
      findings.push(`${kind}: reachable kind with no declared input, so nothing can reach it`);
      continue;
    }
    if (declared.kind !== kind) {
      findings.push(`${kind}: its declared input is ${JSON.stringify(declared.kind)}, so the kind is unreachable`);
      continue;
    }
    if (derive(declared).length === 0) findings.push(`${kind}: reachable kind with no forward action`);
  }
  return findings;
}

test("cabin-forward-path.1: every reachable cabin-handoff state offers the player a step", (t) => {
  const findings = cabinZeroForwardPathFindings(CABIN_HANDOFF_KINDS, CABIN_HANDOFF_INPUTS, deriveCabinHandoffActions);
  t.diagnostic(
    `cabin-forward-path.1: ${CABIN_HANDOFF_KINDS.length} kind(s): ` +
      CABIN_HANDOFF_KINDS.map((kind) => `${kind}->${deriveCabinHandoffActions(CABIN_HANDOFF_INPUTS[kind]).join("+")}`).join(
        ", ",
      ),
  );
  assert.deepEqual(findings, [], "a reachable handoff state with nothing to press and no step named is a dead end");
});

test("cabin-forward-path.2: the union, the kind list and the inputs are one authority", (t) => {
  const source = readFileSync(MODULE, "utf8");
  const start = source.indexOf("export type CabinViewState");
  assert.notEqual(start, -1, "the cabin view state is still declared where this gate reads it");
  const end = source.indexOf("export type CabinHandoffAction", start);
  assert.notEqual(end, -1, "the cabin step union follows the state union");
  const declared = [...source.slice(start, end).matchAll(/kind:\s*"([a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(
    [...declared].sort(),
    [...CABIN_HANDOFF_KINDS].sort(),
    `the union declares ${declared.length} kind(s) and the list enumerates ${CABIN_HANDOFF_KINDS.length}: ` +
      "a kind in one and not the other is a state the gate never looks at",
  );
  t.diagnostic(`cabin-forward-path.2: ${CABIN_HANDOFF_KINDS.length} cabin kind(s) declared, enumerated and reachable`);
});

test("cabin-forward-path.3: only an admitted handoff is over, and only an in-flight one waits", (t) => {
  const terminal = CABIN_HANDOFF_KINDS.filter((kind) => deriveCabinHandoffActions(CABIN_HANDOFF_INPUTS[kind]).includes("terminal"));
  assert.deepEqual(terminal, ["admitted"], "the handoff is over exactly where the companion is moving in");
  const waiting = CABIN_HANDOFF_KINDS.filter((kind) =>
    deriveCabinHandoffActions(CABIN_HANDOFF_INPUTS[kind]).includes("wait_for_read"),
  );
  assert.deepEqual(
    waiting.sort(),
    ["confirming", "loading"],
    "only the two states whose own operation is in flight are a wait - any other one would be a silent trap",
  );
  // The two reads are a real choice, not a synonym: the confirm button is drawn exactly where a
  // choice may be confirmed, and the cabin read exactly where no confirmation is in doubt.
  const confirming = CABIN_HANDOFF_KINDS.filter((kind) =>
    deriveCabinHandoffActions(CABIN_HANDOFF_INPUTS[kind]).includes("confirm"),
  );
  assert.deepEqual(confirming, ["choices"]);
  t.diagnostic(`cabin-forward-path.3: terminal=${terminal.join(", ")}, waiting=${waiting.join(", ")}`);
});

/**
 * The one rule an `uncertain` confirmation has: the cabins are never read again from it.
 *
 * Re-reading would re-offer a confirm button the Host refuses for the life of the attempt - the
 * confirmed choice handle stays consumed and any later confirmation answers
 * `stardew_cabin_confirmation_conflict` (`stardew-production-lifecycle-coordinator.internal.ts`).
 * So the step is the panel's own read of the game, which sends no handoff command at all, and
 * the attachment the Host publishes once that confirmation landed is what answers the question.
 */
test("cabin-forward-path.4: an unconfirmed confirmation offers the game read and never the cabin read", (t) => {
  const uncertain = deriveCabinHandoffActions(CABIN_HANDOFF_INPUTS.uncertain);
  assert.deepEqual([...uncertain], ["read_game_again"]);
  assert.ok(!uncertain.includes("read_cabins_again"), "the cabin read would re-arm a confirmation the Host refuses");
  assert.ok(
    !uncertain.includes("confirm"),
    "a second confirmation is the one thing the state forbids, and the Host refuses it",
  );
  // The copy beside that control has to say what it does and does not do, and what happens when
  // the answer has not changed - the state is otherwise an identical screen after the press.
  assert.match(MESSAGES.stardewCabinCheckGameHint, /never sent a second time/u);
  assert.match(MESSAGES.stardewCabinCheckGameHint, /waiting for recovery/u);
  t.diagnostic(`cabin-forward-path.4: uncertain -> ${uncertain.join("+")}`);
});

test("cabin-forward-path.5 (mutation): a kind whose state offers nothing is reported by name", (t) => {
  const findings = cabinZeroForwardPathFindings(
    ["uncertain", "planted_silent", "planted_unreachable"],
    {
      uncertain: CABIN_HANDOFF_INPUTS.uncertain,
      planted_silent: { kind: "planted_silent" },
      planted_unreachable: { kind: "loading" },
    },
    (input) => (input.kind === "planted_silent" ? [] : deriveCabinHandoffActions(CABIN_HANDOFF_INPUTS.uncertain)),
  );
  assert.equal(findings.length, 2, `exactly the two planted kinds must fail, saw ${JSON.stringify(findings)}`);
  assert.match(findings[0], /^planted_silent: reachable kind with no forward action$/u);
  assert.match(findings[1], /^planted_unreachable: its declared input is "loading"/u);
  assert.deepEqual(
    findings.filter((finding) => finding.startsWith("uncertain:")),
    [],
    "the real kind in the same population passes: the comparison is not simply always-red",
  );
  t.diagnostic(`cabin-forward-path.5: planted -> ${findings.join(" | ")}`);
});

/**
 * The line the post-launch wait puts above the handoff, and the two `launching` shapes it separates.
 *
 * The panel used to read the cabin once, on mount, so a launch left it alone: the only way out of
 * `launching` is a confirmed cabin, and the player had to find the refresh control to get there.
 * Measured live (2026-11-15): the Host answered `Cabin 1` in 45 ms once asked. The shell now asks by
 * itself inside a named budget (`CABIN_REREAD_MAX_ATTEMPTS`), and this is the rule over what it
 * says: every wait state has exactly one line, `launching` with a cabin in hand is not `launching`
 * with nothing yet, and the budget's end names the control the player still has.
 */
const CABIN_LAUNCH_WAIT_KINDS = (() => {
  const source = readFileSync(MODULE, "utf8");
  const start = source.indexOf("export type CabinLaunchWaitState");
  assert.notEqual(start, -1, "the launch-wait union is declared where this gate reads it");
  const end = source.indexOf("export type CabinLaunchLine", start);
  assert.notEqual(end, -1, "the line union follows the wait union");
  return [...source.slice(start, end).matchAll(/kind:\s*"([a-z_]+)"/gu)].map((match) => match[1]);
})();

const CABIN_LAUNCH_WAIT_INPUTS = Object.freeze({
  not_launching: Object.freeze({ kind: "not_launching" }),
  reading: Object.freeze({ kind: "reading", attempt: 3, attempts: 30 }),
  expired: Object.freeze({ kind: "expired", attempts: 30 }),
});

test("cabin-forward-path.6: every launch-wait state says one thing, and the two launching shapes differ", (t) => {
  const findings = [];
  const lines = [];
  for (const kind of CABIN_LAUNCH_WAIT_KINDS) {
    const wait = CABIN_LAUNCH_WAIT_INPUTS[kind];
    if (wait === undefined) {
      findings.push(`${kind}: reachable wait state with no declared input, so nothing can reach it`);
      continue;
    }
    const nothing = deriveCabinLaunchLine({ cabin: CABIN_HANDOFF_INPUTS.missing, wait, launchInFlight: true });
    lines.push(`${kind}->${nothing.kind}`);
    if (kind === "reading" && (nothing.kind !== "reading" || nothing.attempt !== 3 || nothing.attempts !== 30))
      findings.push(`${kind}: the reading must carry the attempt and the whole budget, saw ${JSON.stringify(nothing)}`);
    if (kind === "expired" && nothing.kind !== "wait_expired") findings.push(`${kind}: the spent budget must be stated`);
    if (kind === "not_launching" && nothing.kind !== "none")
      findings.push(`${kind}: an idle panel must add no launch copy at all`);
    // A launch that is no longer in flight has nothing for the wait to say, whatever the wait's last
    // attempt reported: the projection's own sentence is the whole of the reading then.
    for (const cabinKind of CABIN_HANDOFF_KINDS) {
      const idle = deriveCabinLaunchLine({ cabin: CABIN_HANDOFF_INPUTS[cabinKind], wait, launchInFlight: false });
      if (idle.kind !== "none")
        findings.push(
          `${cabinKind} + ${kind} with no launch in flight: the handoff's ordinary copy is the whole of it, saw ${idle.kind}`,
        );
    }
    // A cabin in hand while the launch is in flight is the other shape, and it wins over whatever the
    // wait's last attempt said: the player's next act is the choice, not another read.
    for (const waitKind of CABIN_LAUNCH_WAIT_KINDS) {
      const withCabin = deriveCabinLaunchLine({
        cabin: CABIN_HANDOFF_INPUTS.choices,
        wait: CABIN_LAUNCH_WAIT_INPUTS[waitKind],
        launchInFlight: true,
      });
      if (withCabin.kind !== "cabin_ready")
        findings.push(`choices + ${waitKind}: a cabin in hand during a launch must say so, saw ${withCabin.kind}`);
    }
  }
  t.diagnostic(`cabin-forward-path.6: ${CABIN_LAUNCH_WAIT_KINDS.length} wait state(s): ${lines.join(", ")}`);
  assert.deepEqual(findings, [], "a launching game must say whether her cabin is in hand or still being asked for");
});

test("cabin-forward-path.7: the budget's end names the step the player still has, in both languages", (t) => {
  const en = MESSAGES;
  const zh = messages("zh-CN");
  assert.match(en.stardewCabinsLaunchReading, /\{\{attempt\}\}/u, "the reading prints which attempt it is on");
  assert.match(en.stardewCabinsLaunchReading, /\{\{attempts\}\}/u, "and the budget it is inside");
  assert.match(zh.stardewCabinsLaunchReading, /\{\{attempt\}\}/u);
  assert.match(zh.stardewCabinsLaunchReading, /\{\{attempts\}\}/u);
  // The one line that has to be a step rather than a report: the budget is spent, so the control it
  // names is the player's, and the sentence says what to do before pressing it.
  assert.ok(
    en.stardewCabinsLaunchWaitExpired.includes(en.stardewCabinsRefresh),
    "the expired wait names the refresh control by its own name, so the player can find it",
  );
  assert.match(en.stardewCabinsLaunchWaitExpired, /Load your farm/u);
  assert.ok(
    zh.stardewCabinsLaunchWaitExpired.includes(zh.stardewCabinsRefresh),
    "and the same sentence in the other catalogue names that catalogue's own control",
  );
  t.diagnostic(
    `cabin-forward-path.7: budget spent -> ${JSON.stringify(en.stardewCabinsLaunchWaitExpired.slice(0, 48))}…`,
  );
});

/**
 * The two endings a game can have, told apart by the number the OS reported.
 *
 * Measured defect this test exists for: the Host's Guardian reports the game process ending with
 * the code the OS gave it, and the browser read the PRESENCE of that exit as a crash. A player who
 * quit Stardew normally was shown the same `crashed` instance, the same `failed` outcome and the
 * same danger sentence - "This attempt failed ..." - as a player whose game really died, with only
 * the digit in "Ended (exit code N)" telling them apart.
 *
 * The pair below is that exact pair, driven through the REAL Host projection
 * (`game-browser/game-browser-state-provider.ts`) into the panel's own derivation, so the two
 * sides cannot drift: the difference between them is the difference the product is allowed to
 * state - the ending's own word for the instance, the outcome category, and the code - and
 * nothing else. The last assertions hold the sentences to the same rule.
 */
test("exit 0 is an ending and a non-zero code is a crash, and the two differ only there", async (t) => {
  const readGame = async (playerHostExitCode) =>
    await readState(
      Object.freeze({
        schemaVersion: 1,
        playerHost: Object.freeze({ state: "not_started", ownership: "none" }),
        aiClient: Object.freeze({ state: "not_started", ownership: "none" }),
      }),
      { status: "failed", generation: 0, playerHostExitCode },
      "registered",
    );
  const quit = await readGame(0);
  const crashed = await readGame(86);

  assert.equal(quit.game.instance.status, "stopped", "the OS's normal termination is an ending, not a crash");
  assert.equal(quit.game.instance.playerHostExitCode, 0, "the code the OS reported is published as it is");
  assert.equal(quit.game.latestOutcome, "none", "a game the player ended is not a failed outcome");
  assert.equal(crashed.game.instance.status, "crashed");
  assert.equal(crashed.game.instance.playerHostExitCode, 86);
  assert.equal(crashed.game.latestOutcome, "failed");

  const controlsFor = (game) =>
    deriveGameSessionControls({ ready: true, game, resumeFailureSurface: false, resumeAttemptFailed: false });
  const quitControls = controlsFor(quit);
  const crashedControls = controlsFor(crashed);
  assert.equal(quitControls.phase, "game_ended");
  assert.equal(crashedControls.phase, "launch_failed");
  // The step is the SAME in both, and so is the reason: the attempt is terminal either way, and
  // no control on this page can launch it again.
  assert.deepEqual([...quitControls.forwardActions], ["restart_gamebuddy"]);
  assert.deepEqual([...crashedControls.forwardActions], ["restart_gamebuddy"]);
  assert.equal(quitControls.restartRequired, true);
  assert.equal(crashedControls.restartRequired, true);
  // And no staging control is offered beside it: the guide would be a panel of refusals.
  for (const [name, value] of Object.entries(clientControls(quit)))
    assert.equal(value, name === "launchGeneration" ? null : name === "activationBlockedBy" ? null : false, name);

  const en = messages("en");
  const zh = messages("zh-CN");
  assert.equal(instanceLabel(en, quit.game.instance), "Ended (exit code 0)");
  assert.equal(instanceLabel(en, crashed.game.instance), "Ended (exit code 86)");
  assert.equal(instanceLabel(zh, quit.game.instance), "已退出（退出代码 0）");
  // The two instance sentences differ in the digit and in nothing else - the ending itself is one
  // sentence, because it is one fact: the game is gone.
  assert.equal(
    instanceLabel(en, quit.game.instance).replace("0", "#"),
    instanceLabel(en, crashed.game.instance).replace("86", "#"),
    "the two endings differ only in the code the OS reported",
  );

  // The sentences are where the difference has to be stated: only the crash may claim a failure,
  // and both must name the same step, because the quarantine they walk out of is the same one.
  assert.match(en.gameLaunchQuarantined, /failed/u, "the crashed attempt's sentence names the failure it was");
  assert.doesNotMatch(en.gameEndedQuarantined, /fail/iu, "a game the player ended is not told back to them as failed");
  assert.match(zh.gameLaunchQuarantined, /失败/u);
  assert.doesNotMatch(zh.gameEndedQuarantined, /失败/u);
  for (const labels of [en, zh]) {
    assert.match(
      labels.gameEndedQuarantined,
      /GameBuddy/u,
      "the ended sentence names the one step out, which is a fresh GameBuddy",
    );
    assert.notEqual(labels.gameEndedQuarantined, labels.gameLaunchQuarantined);
  }
  assert.match(en.gameEndedQuarantined, /quit GameBuddy itself/u);
  assert.match(zh.gameEndedQuarantined, /退出 GameBuddy 本身/u);
  // The ONE clause the reported exit changes: the failed launch may still have a game running (its
  // outcome is unknown), while a reported exit is a game that is already gone - so only the failed
  // launch asks the player to close it. `instance.status` is the fact that selects which.
  for (const labels of [en, zh]) {
    assert.match(
      labels.gameLaunchQuarantined,
      /If Stardew Valley is still running, close it|如果《星露谷物语》还在运行/u,
      "an unknown launch outcome may still be running, so that sentence asks for the close",
    );
    assert.doesNotMatch(
      labels.gameEndedQuarantined,
      /still running|还在运行/u,
      "a reported exit is a game that is gone: asking the player to close it is work that cannot be done",
    );
    assert.match(
      labels.gameEndedQuarantined,
      /restarting GameBuddy is what allows another launch|重启 GameBuddy 才能再启动一次游戏/u,
      "and the step is the restart of GameBuddy, not a restart of the game",
    );
  }
  // …and both say that the page is not where that step is carried out: the lock is in GameBuddy's
  // own process, so no control here lifts it and reloading comes back to this same screen. The
  // instruction that sent the player looking for a control this page does not have is gone.
  for (const labels of [en, zh]) {
    assert.match(labels.gameLaunchQuarantined, /no control on this page|本页没有任何控件/u);
    assert.match(labels.gameLaunchQuarantined, /reloading this page does not|刷新本页也不行/u);
    assert.doesNotMatch(labels.gameLaunchQuarantined, /then play with your companion|然后再启动伙伴陪玩/u);
  }
  t.diagnostic(`game-ended: quit -> ${quitControls.phase}, crashed -> ${crashedControls.phase}`);
});

/**
 * A launch refused behind an ended attempt is the ending, not an uncertain result.
 *
 * Measured defect: the coordinator kept a reported exit under the launch-quarantine name, so the
 * command answered `stardew_player_host_launch_quarantined` and - after the split landed - a new
 * `stardew_player_host_exited` that the composed route had no case for. Either way the panel's
 * per-operation line fell back to its unsettled sentence, "the launch result is uncertain", about a
 * game the Guardian had already watched end. The code now keeps its own name on the wire, and this
 * test holds the sentence it reaches the player with to the facts of that state.
 */
test("a launch refused behind a reported exit reads as the ending, not as an uncertain result", async (t) => {
  const en = messages("en");
  const zh = messages("zh-CN");
  const refused = new ComposedReferenceGameProblemError("stardew_player_host_exited", 409);

  for (const labels of [en, zh]) {
    const view = composedProblemView(refused, labels);
    assert.equal(view.title, labels.gameProblemPlayerHostExitedTitle);
    assert.equal(view.detail, labels.gameProblemPlayerHostExitedDetail);
    assert.deepEqual(view.step, { kind: "outside_surface", step: "restart_gamebuddy" });
    // The panel's line is the refusal's own words, and the operation's uncertain sentence is the
    // false one here: the Host knew exactly what happened.
    assert.deepEqual(gameOperationFailure(refused, labels), {
      kind: "refused",
      sentence: labels.gameProblemPlayerHostExitedDetail,
    });
    assert.notEqual(view.detail, labels.gameLaunchFailed);
  }

  // The facts the launch sentence owes, in each catalogue. The ending (not a failed launch), the
  // attempt being over, the record held by GameBuddy's own process, and the restart that allows
  // another launch.
  for (const [locale, labels] of [
    ["en", en],
    ["zh-CN", zh],
  ]) {
    assert.match(labels.gameProblemPlayerHostExitedDetail, /Stardew Valley ended|《星露谷物语》已经退出/u, locale);
    assert.match(labels.gameProblemPlayerHostExitedDetail, /will not be repeated|不会再重来/u, locale);
    assert.match(labels.gameProblemPlayerHostExitedDetail, /inside GameBuddy's own process|GameBuddy 自己的进程里/u, locale);
    assert.match(labels.gameProblemPlayerHostExitedDetail, /quit GameBuddy itself|退出 GameBuddy 本身/u, locale);
    assert.match(labels.gameProblemPlayerHostExitedDetail, /another launch|再启动一次游戏/u, locale);
    // Nothing is left of the cabin read's own framing, and nothing asks the player to go close a
    // game this Host watched end.
    assert.doesNotMatch(labels.gameProblemPlayerHostExitedDetail, /cabins|读不到可选的农舍/u, locale);
    assert.doesNotMatch(labels.gameProblemPlayerHostExitedDetail, /still running|还在运行/u, locale);
  }
  t.diagnostic(`launch-exit: ${en.gameProblemPlayerHostExitedDetail}`);
});

/**
 * The held registration is not a missing installation.
 *
 * Measured defect: an activation refused because an earlier attempt still held the installation
 * registration reached the player as "the installation is not configured" - the state that asks
 * them to register a folder they had already registered. The refusal now carries its own code, so
 * the two facts have two sentences, and the held one states the two things that really free it.
 */
test("a registration an earlier attempt holds reads as its own refusal, not as a missing installation", async (t) => {
  const en = messages("en");
  const held = new ComposedReferenceGameProblemError("stardew_bootstrap_registration_held", 409);
  const view = composedProblemView(held, en);
  assert.equal(view.title, en.gameProblemRegistrationHeldTitle);
  assert.equal(view.detail, en.gameProblemRegistrationHeldDetail);
  assert.deepEqual(view.step, { kind: "outside_surface", step: "restart_gamebuddy" });
  // The Host stated it did not stage anything, so the panel's per-operation line must not say the
  // result is uncertain.
  assert.deepEqual(gameOperationFailure(held, en), { kind: "refused", sentence: en.gameProblemRegistrationHeldDetail });

  // The negative: the genuinely unregistered case keeps the words it had, and the two never
  // collapse into one sentence.
  const missing = composedProblemView(
    new ComposedReferenceGameProblemError("state_unavailable", 409, null, "stardew_bootstrap_registration_unavailable"),
    en,
  );
  assert.notEqual(missing.title, en.gameProblemRegistrationHeldTitle);
  assert.notEqual(missing.detail, en.gameProblemRegistrationHeldDetail);

  // The sentence stays true whether or not the game is still running, because the Host cannot
  // tell those apart at this point: it names both things the player can do.
  assert.match(en.gameProblemRegistrationHeldDetail, /If Stardew Valley is still running, close it/u);
  assert.match(messages("zh-CN").gameProblemRegistrationHeldDetail, /如果《星露谷物语》还在运行/u);
  t.diagnostic(`registration-held: ${view.title} -> ${view.step.step}`);
});
