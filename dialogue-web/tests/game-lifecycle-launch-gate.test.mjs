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
 * `stardew-private-bootstrap-composer.test.ts`), and a staged attempt's
 * launch-readiness reader says `{ status: "ready", generation: 1 }`
 * (`stardew-production-lifecycle-coordinator.internal.test.ts`).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { composeCoordinatorRoleLifecycleView } from "../../host/src/stardew-role-lifecycle-projection.internal.js";
import { createStardewRoleLifecycleFacade } from "../../host/src/stardew-role-lifecycle-facade.js";
import { createGameBrowserStateProvider } from "../../host/src/game-browser/game-browser-state-provider.js";
import { composeGameProfile } from "../../host/src/game-browser-contract/index.js";
import { deriveGameLifecycleControlAvailability } from "../src/game-lifecycle-controls.ts";

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

function readState(lifecycleView, readiness) {
  return createGameBrowserStateProvider(
    gameProfile,
    lifecycleReader(lifecycleView),
    attachmentReader(),
    launchReadinessReader(readiness),
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
