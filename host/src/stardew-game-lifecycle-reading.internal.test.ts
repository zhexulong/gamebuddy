/**
 * The Game lifecycle's player-visible reading, driven through the real chain.
 *
 * The defect this file exists for: the coordinator described one lifecycle in four
 * parallel places - an activation state string, a `launchTerminal` boolean, the facade's
 * process-owner slot, and a projection rule that OVERRODE that slot - and the browser read
 * the one that could not advance. After a launch whose Player Host advertisement was
 * correlated, the coordinator stayed in `awaiting_player_host_attestation` forever, so
 * `projectCoordinatorPlayerHostSlot` answered `awaiting_attestation` for the rest of the
 * process and `game.instance.status` could only ever say `launching`. The attested state
 * did not exist at all, which is why no reachability gate over the old graph had anything
 * to reach: `game.instance.status: running` was unproducible, not merely unreached.
 *
 * These are behavioural readings, not type pins: the whole real fixture - activation, the
 * signed advertisement, the launch - then the real `game.state.read` provider.
 */
import {
  createFixture,
  installLifecycleTestHooks,
  publishSignedPlayerHostSession,
  withWindowsPlatform,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import { composeGameProfile } from "./game-browser-contract/index.js";
import { createGameBrowserStateProvider } from "./game-browser/game-browser-state-provider.js";
import assert from "node:assert/strict";
import test from "node:test";

installLifecycleTestHooks();

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

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** The production `game.state.read`, over exactly the readers this coordinator publishes. */
function readGameState(fixture: Fixture) {
  return createGameBrowserStateProvider(
    gameProfile,
    fixture.coordinator.lifecycleReader,
    fixture.coordinator.attachmentReader,
    fixture.coordinator.launchReadinessReader,
  ).readState(CONTEXT);
}

const LAUNCH = Object.freeze({
  apiVersion: 1 as const,
  idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
  expectedInstanceGeneration: 1,
});

/**
 * Drives one complete, successful launch: activation, the Player Host's own signed
 * advertisement, setup, and the admitted launch.
 */
async function launchPlayerHost(fixture: Fixture): Promise<void> {
  await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
  await publishSignedPlayerHostSession(fixture.runtimeRoot);
  await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
    apiVersion: 1,
    idempotencyKey: LAUNCH.idempotencyKey,
  });
  await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), LAUNCH);
}

test("an attested Player Host publishes instance.status running, not launching", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await launchPlayerHost(fixture);

      // The launch correlated this attempt's own signed advertisement, so the lifecycle is
      // at its target state - not still waiting for an attestation it already has.
      assert.equal(
        fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
        "player_host_attested",
        "the correlated advertisement advances the one lifecycle state",
      );

      const state = await readGameState(fixture);
      assert.equal(
        state.game.instance.status,
        "running",
        "a Player Host that is up and attested is `running`; `launching` would say a launch is still in flight",
      );
      assert.equal(state.game.prerequisites.status, "met");
      // `instance.generation` is the LAUNCH-READY generation, so it is 0 once a launch has
      // happened: there is nothing left for the launch control to bind. Asserting it here keeps
      // the word's meaning pinned while the instance itself says `running`.
      assert.equal(state.game.instance.generation, 0);
      // The negative half: the projection must not still be reading a launch in flight.
      assert.equal(state.game.latestOutcome, "none");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("a launch waiting for its advertisement still reads launching, and the next read settles it", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      // The advertisement arrives only after the launch's own correlation attempt, which is
      // the shape an advertising world has on a slow first join: the launch succeeds and the
      // state stays `awaiting_player_host_attestation` until a read correlates it.
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: LAUNCH.idempotencyKey,
      });
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), LAUNCH);
      assert.equal(
        fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
        "awaiting_player_host_attestation",
      );
      assert.equal((await readGameState(fixture)).game.instance.status, "launching");

      await publishSignedPlayerHostSession(fixture.runtimeRoot);
      assert.equal(
        (await readGameState(fixture)).game.instance.status,
        "running",
        "the read that correlates the advertisement is the transition to the attested state",
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});
