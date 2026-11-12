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

import { composeCoordinatorRoleLifecycleView } from "../../host/src/stardew-role-lifecycle-projection.internal.js";
import { createStardewRoleLifecycleFacade } from "../../host/src/stardew-role-lifecycle-facade.js";
import { createGameBrowserStateProvider } from "../../host/src/game-browser/game-browser-state-provider.js";
import { composeGameProfile } from "../../host/src/game-browser-contract/index.js";
import {
  deriveGameLifecycleControlAvailability,
  deriveGameSessionControls,
  GAME_SESSION_INPUTS,
  GAME_SESSION_PHASES,
} from "../src/game-lifecycle-controls.ts";
import { messages } from "../src/i18n.ts";

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
  return Object.freeze({ readLaunchReadinessView: () => Object.freeze({ ...view }) });
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
  });
});

test("before activation the coordinator defers to the facade and the client still offers activation", async () => {
  const idleFacadeView = await facadeViewFor("idle");
  assert.deepEqual(idleFacadeView.playerHost, { state: "not_started", ownership: "none" });
  // An inactive lifecycle is not a state the coordinator owns.
  assert.equal(composeCoordinatorRoleLifecycleView("inactive", idleFacadeView), idleFacadeView);

  const gameState = await readState(idleFacadeView, { status: "none", generation: 0 });
  assert.equal(gameState.game.prerequisites.status, "unknown");
  assert.deepEqual(gameState.game.instance, { status: "none", gameTitle: null, generation: 0 });
  assert.deepEqual(clientControls(gameState), {
    activationAvailable: true,
    setupAvailable: true,
    launchAvailable: false,
    launchGeneration: null,
  });
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
