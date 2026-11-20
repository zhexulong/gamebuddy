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
  launches: string[];
  closes(): number;
  report(exit: GuardianRoleExit): void;
}> {
  const watchers: Array<(exit: GuardianRoleExit) => void> = [];
  const launches: string[] = [];
  let closeCount = 0;
  const session: DesktopGuardianSession = Object.freeze({
    onRoleExit(handler: (exit: GuardianRoleExit) => void) {
      watchers.push(handler);
    },
    arm: async () => containedSessionAck("arm_attempt"),
    launch: async (input) => {
      launches.push(input.role);
      return containedSessionAck("launch_role", input.role);
    },
    contain: async (input) => containedSessionAck("contain_role", input.role),
    recover: async () => Object.freeze({ outcome: "contained" as const }),
    close: async () => {
      closeCount += 1;
    },
  });
  return Object.freeze({
    session,
    launches,
    closes: () => closeCount,
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

test("a settled attempt hands the surface back: the ending stops being the answer and the next attempt is generation 2", async (t) => {
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

      // Attempt 2, in the same coordinator and the same Host process. It begins where a first
      // attempt begins - a fresh activation - and that is the door that settles attempt 1; the settle
      // is what hands back everything attempt 1 held, including the Player Host process owner's
      // one-shot launch reservation.
      const secondActivation = await fixture.coordinator.activationOwner.activate(
        fixture.broker.issue("lifecycle_activation"),
      );
      t.diagnostic(`attempt 2: activation ${JSON.stringify(secondActivation)}`);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      // The settle did its own work before this attempt was prepared:
      // 1. the durable registration is what issued the second instance number, and the pointer attempt 1
      //    held is now this attempt's - which it could not be if attempt 1 still held it;
      const registration = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.equal(registration?.instanceGeneration, 2, "the durable registration issued instance 2");
      assert.notEqual(registration?.activeAttempt, null, "and the attempt that holds it is the new one");
      // 2. the second attempt is instance 2 and the launch gate is open for it. The reading is the
      //    number the browser is handed; the ended attempt's own number is refused below.
      assert.deepEqual(
        fixture.coordinator.launchReadinessReader.readLaunchReadinessView(),
        { generation: 2, status: "ready", playerHostExitCode: null },
        "the ended attempt's ending stops being this surface's game, and the next attempt is instance 2",
      );
      // 3. attempt 1's number is not this attempt's, and the refusal names the generation rather than
      //    a launch that is in progress.
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "CEiM0RVZneImaq7zN3u_v",
          expectedInstanceGeneration: 1,
        }),
        /stardew_game_instance_generation_conflict/,
      );
      // 4. and the second attempt really starts, in the same process, after the first one's game ended.
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "DEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 2,
      });
      t.diagnostic(`attempt 2: Player Host launches ${JSON.stringify(guardian.launches)}`);
      assert.deepEqual(guardian.launches, ["player_host", "player_host"], "both attempts launched the Player Host");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("a settle is one per ATTEMPT: the attempt after it is prepared once, and a press on a running attempt settles nothing", async () => {
  await withWindowsPlatform(async () => {
    const guardian = guardianSession();
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(guardian.session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await launchOwnedPlayerHost(fixture);
      guardian.report(Object.freeze({ role: "player_host", exitCode: PLAYER_QUIT_EXIT_CODE }));

      // Press 2 settles the ended attempt and prepares the next one. The reading that says the
      // settle ran exactly once is the authenticated session it closes: attempt 1's session is
      // released by the settle, and only by it.
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation"));
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      assert.equal(guardian.closes(), 1, "attempt 1's Guardian session was released by its settle, once");
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");

      // Press 3 arrives while attempt 2 is prepared, not ended. Nothing of attempt 1 is left to hand
      // back and attempt 2 is not over, so this press settles nothing: a settle here would close the
      // session attempt 2 is about to launch through and would hand back an attempt that is still
      // holding its own reservation.
      await assert.rejects(
        fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation")),
        /stardew_lifecycle_activation_conflict/,
      );
      assert.equal(guardian.closes(), 1, "a press on a prepared attempt settles nothing");
      assert.deepEqual(
        fixture.coordinator.launchReadinessReader.readLaunchReadinessView(),
        { generation: 2, status: "ready", playerHostExitCode: null },
        "and the attempt that was prepared is still the one the launch gate names",
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
