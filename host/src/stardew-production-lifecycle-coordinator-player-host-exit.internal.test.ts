/**
 * A game that died must stop looking like a game that is starting.
 *
 * The chain this file drives is the whole one, as far as it can be driven in one process:
 * the Guardian's own `role_exited` fact reaches the platform, the platform's collaborator,
 * the lifecycle coordinator's one latched record, and from there the two things the browser
 * actually reads - the cabin read's refusal and the game state projection - over the composed
 * HTTP wire the panel talks to.
 *
 * The negative is the point of the second test: with no exit reported, none of those answers
 * may claim the game ended. "Unknown" and "gone" are different facts and the panel has
 * different words for them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
} from "./composition/stardew/stardew-guardian-platform.js";
import type { DesktopGuardianSession, GuardianRoleExit } from "./containment/auth/desktop-guardian-session.internal.js";
import { readStardewInstallationRegistration } from "./stardew-installation-registration.internal.js";
import {
  containedSessionAck,
  createFixture,
  installLifecycleTestHooks,
  publishSignedPlayerHostSession,
  withWindowsPlatform,
} from "./stardew-production-lifecycle-coordinator.test-support.js";

installLifecycleTestHooks();

/** The native exit code a Windows process killed by a loader failure reports. */
const PLAYER_HOST_EXIT_CODE = 3221225781;

/** The code Windows reports for a process that ended on its own: the player quit the game. */
const PLAYER_QUIT_EXIT_CODE = 0;

/**
 * A Guardian session whose role exits this test publishes itself.
 *
 * It answers the three commands the contained Player Host launch sends with the exact
 * acknowledgement shape, and hands the test the watcher the platform registers - which is
 * the same call the real session makes from `receive()` when it parses a `role_exited`
 * frame (`bootstrap/wire/desktop-runtime-bootstrap.internal.ts`, `GuardianSessionClient`).
 */
function guardianSession(): Readonly<{
  session: DesktopGuardianSession;
  report(exit: GuardianRoleExit): void;
}> {
  const watchers: Array<(exit: GuardianRoleExit) => void> = [];
  const session: DesktopGuardianSession = Object.freeze({
    onRoleExit(handler: (exit: GuardianRoleExit) => void) {
      watchers.push(handler);
    },
    arm: async () => containedSessionAck("arm_attempt"),
    launch: async (input) => containedSessionAck("launch_role", input.role),
    contain: async (input) => containedSessionAck("contain_role", input.role),
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    close: async () => undefined,
  });
  return Object.freeze({
    session,
    report(exit: GuardianRoleExit): void {
      assert.equal(watchers.length, 1, "the platform registers exactly one exit watcher");
      for (const watcher of watchers) watcher(exit);
    },
  });
}

/** Stages the fixture's Player Host (activation + profile staging) without launching it. */
async function stageOwnedPlayerHost(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  await fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation"));
  await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
    apiVersion: 1,
    idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
  });
}

/** Stages, launches and attests the fixture's Player Host through the contained runtime. */
async function launchOwnedPlayerHost(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  await stageOwnedPlayerHost(fixture);
  await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
    apiVersion: 1,
    idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
    expectedInstanceGeneration: 1,
  });
}

/** Reads one game route over the composed HTTP wire, exactly as the panel does. */
async function readRoute(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  path: string,
): Promise<Readonly<{ status: number; body: Record<string, unknown> }>> {
  const response = await fetch(`${fixture.broker.origin}${path}`, {
    method: "GET",
    headers: {
      origin: fixture.broker.origin,
      cookie: fixture.broker.cookie,
      "x-csrf-token": fixture.broker.csrfToken,
    },
  });
  return Object.freeze({ status: response.status, body: (await response.json()) as Record<string, unknown> });
}

test("the Guardian's player-role exit reaches the cabin read and the game projection", async () => {
  await withWindowsPlatform(async () => {
    const guardian = guardianSession();
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(guardian.session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await launchOwnedPlayerHost(fixture);
      // Before the exit: the Host knows nothing about the process either way, and says so.
      const liveCabinRead = await readRoute(fixture, "/api/composed-reference-game/v1/game/stardew/cabins");
      assert.notEqual(
        liveCabinRead.body.code,
        "stardew_player_host_exited",
        "a session that reported no exit must never be read as a game that ended",
      );
      const liveGame = await readRoute(fixture, "/api/composed-reference-game/v1/game");
      const liveInstance = (liveGame.body.game as Record<string, unknown>).instance as Record<string, unknown>;
      assert.equal(Object.hasOwn(liveInstance, "playerHostExitCode"), false);
      assert.notEqual(liveInstance.status, "crashed");

      // The Guardian reports the game process ended, with the code the OS gave it.
      guardian.report(Object.freeze({ role: "player_host", exitCode: PLAYER_HOST_EXIT_CODE }));

      // 1. The cabin read refuses by name instead of retrying a read against a dead game.
      const cabinRead = await readRoute(fixture, "/api/composed-reference-game/v1/game/stardew/cabins");
      assert.equal(cabinRead.status, 409);
      assert.deepEqual(cabinRead.body, { code: "stardew_player_host_exited" });

      // 2. The game projection states the ending and publishes the code it ended with.
      const game = await readRoute(fixture, "/api/composed-reference-game/v1/game");
      assert.equal(game.status, 200);
      const instance = ((game.body.game as Record<string, unknown>).instance ?? {}) as Record<string, unknown>;
      assert.equal(instance.status, "crashed", "a game that ended is not a game that is starting");
      assert.equal(instance.playerHostExitCode, PLAYER_HOST_EXIT_CODE);

      // 3. The coordinator's own readers agree with what the wire published: one fact, one
      //    place, no second spelling.
      assert.deepEqual(
        fixture.coordinator.launchReadinessReader.readLaunchReadinessView().playerHostExitCode,
        PLAYER_HOST_EXIT_CODE,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("a game the player quit refuses a second launch by that exit, not by a quarantine", async () => {
  await withWindowsPlatform(async () => {
    const guardian = guardianSession();
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(guardian.session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await launchOwnedPlayerHost(fixture);
      // The player closes the game. The Guardian reports the process ending on its own.
      guardian.report(Object.freeze({ role: "player_host", exitCode: PLAYER_QUIT_EXIT_CODE }));
      const game = await readRoute(fixture, "/api/composed-reference-game/v1/game");
      const instance = ((game.body.game as Record<string, unknown>).instance ?? {}) as Record<string, unknown>;
      assert.equal(instance.status, "stopped", "exit 0 is the OS's normal termination, not a crash");
      assert.equal(instance.playerHostExitCode, PLAYER_QUIT_EXIT_CODE);

      // Pressing Play again is answered with the fact that ended the attempt. A known exit
      // is knowledge, not an untrustworthy Host: it must not be dressed as a quarantine,
      // and it must not be dressed as a launch that is still in flight.
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "DEiM0RVZneImaq7zN3u_x",
          expectedInstanceGeneration: 1,
        }),
        /stardew_player_host_exited/,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("an attempt whose outcome nobody knows still refuses with the quarantine", async () => {
  await withWindowsPlatform(async () => {
    const guardian = guardianSession();
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(guardian.session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      // A Player Host that published a session for another launch generation is an attempt
      // whose evidence cannot be correlated: the launch may have run, and nothing here can
      // say what it did. That is the class that must stay terminal.
      await stageOwnedPlayerHost(fixture);
      await publishSignedPlayerHostSession(fixture.runtimeRoot, "player-generation-other");
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedInstanceGeneration: 1,
        }),
        /stardew_player_host_launch_failed/,
        "a mismatched attestation is a failed launch, never a successful one",
      );
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "DEiM0RVZneImaq7zN3u_x",
          expectedInstanceGeneration: 1,
        }),
        /stardew_player_host_launch_quarantined/,
        "an unknown outcome is never softened into the known-exit refusal",
      );
      // Ignorance is the one ending that never settles: a second attempt must not be
      // prepared on top of an attempt whose native effect nobody can prove, so this
      // lifecycle keeps its activation latch too. A KNOWN ending gives it back (see the
      // settled-attempt test below); this one never does.
      await assert.rejects(
        fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation")),
        /stardew_lifecycle_activation_conflict/,
        "the quarantine is never lifted by asking for the next attempt",
      );
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "EEiM0RVZneImaq7zN3u_y",
          expectedInstanceGeneration: 1,
        }),
        /stardew_player_host_launch_quarantined/,
        "a refused activation leaves the unknown attempt exactly as terminal as it was",
      );
      assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
        generation: 0,
        status: "failed",
        playerHostExitCode: null,
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("a settled attempt hands the surface back: the ending stops being the answer and the next attempt is generation 2", async () => {
  await withWindowsPlatform(async () => {
    const guardian = guardianSession();
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(guardian.session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await launchOwnedPlayerHost(fixture);
      // Attempt 1 ends by the player's own hand, and the Guardian says so.
      guardian.report(Object.freeze({ role: "player_host", exitCode: PLAYER_QUIT_EXIT_CODE }));
      assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
        generation: 0,
        status: "failed",
        playerHostExitCode: PLAYER_QUIT_EXIT_CODE,
      });

      // Before anything settles, a press is answered by the ending itself. That is the
      // fact that ended attempt 1, and it is not a quarantine of this Host.
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "CEiM0RVZneImaq7zN3u_v",
          expectedInstanceGeneration: 1,
        }),
        /stardew_player_host_exited/,
      );

      // Attempt 2, in the same coordinator. It begins where a first attempt begins - a
      // fresh activation - and that is the door that settles attempt 1.
      //
      // It stops one step later, at the ONE Host-side latch left below this lifecycle:
      // the Player Host process owner's own one-shot launch reservation
      // (`stardew-private-bootstrap-composer.core.internal.ts`, `reservePlayerHostLaunch`).
      // It has an "the ended activation is superseded" edge for the AI client and none
      // for the player role, so it refuses until that edge exists. Named here rather than
      // summarised, because it - and not the Desktop - is what a second attempt meets
      // first.
      await assert.rejects(
        fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation")),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, "stardew_lifecycle_activation_failed");
          assert.equal(
            (error.cause as Error | undefined)?.message,
            "owned_player_host_launch_already_active",
            "the next attempt reaches the process owner's one-shot reservation, not the Guardian",
          );
          return true;
        },
      );

      // The settle did its own work before that refusal:
      // 1. the durable registration pointer attempt 1 held is released, so a next attempt
      //    could reserve at all;
      assert.equal((await readStardewInstallationRegistration(fixture.runtimeRoot))?.activeAttempt, null);
      // 2. the ending is retained as this surface's fact about its game - the player still
      //    reads the game that ended, not a game that was never started - while the door
      //    that refuses a launch answers about the LIVE attempt and no longer refuses;
      assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
        generation: 0,
        status: "failed",
        playerHostExitCode: PLAYER_QUIT_EXIT_CODE,
      });
      const settledGame = await readRoute(fixture, "/api/composed-reference-game/v1/game");
      const settledInstance = ((settledGame.body.game as Record<string, unknown>).instance ?? {}) as Record<
        string,
        unknown
      >;
      assert.equal(settledInstance.status, "stopped", "the game that ended did not become a game that failed");
      assert.equal(settledInstance.playerHostExitCode, PLAYER_QUIT_EXIT_CODE);
      // 3. the activation that could not be prepared left the coordinator where a first
      //    attempt starts, not in a terminal `failed` the player cannot get out of;
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "inactive");
      // 4. the generation advanced to exactly 2: the settled attempt's own number is now a
      //    conflict, and the next attempt's number is the one the gate would take. The two
      //    refusals together can only come from a counter of exactly 2, and neither is
      //    "a launch is in progress" for a launch that already settled.
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "CEiM0RVZneImaq7zN3u_v",
          expectedInstanceGeneration: 1,
        }),
        /stardew_game_instance_generation_conflict/,
      );
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "EEiM0RVZneImaq7zN3u_y",
          expectedInstanceGeneration: 2,
        }),
        /stardew_player_host_launch_not_staged/,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("an AI-client exit is not the game's, and no exit at all never becomes a crash claim", async () => {
  await withWindowsPlatform(async () => {
    const guardian = guardianSession();
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(guardian.session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await launchOwnedPlayerHost(fixture);
      guardian.report(Object.freeze({ role: "ai_client", exitCode: 1 }));

      const game = await readRoute(fixture, "/api/composed-reference-game/v1/game");
      const instance = ((game.body.game as Record<string, unknown>).instance ?? {}) as Record<string, unknown>;
      assert.equal(
        Object.hasOwn(instance, "playerHostExitCode"),
        false,
        "the AI client's exit is not the game process's, so there is no exit code to publish",
      );
      assert.notEqual(instance.status, "crashed");
      const cabinRead = await readRoute(fixture, "/api/composed-reference-game/v1/game/stardew/cabins");
      assert.notEqual(cabinRead.body.code, "stardew_player_host_exited");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});
