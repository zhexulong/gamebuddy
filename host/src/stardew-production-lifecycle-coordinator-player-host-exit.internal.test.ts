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
import {
  containedSessionAck,
  createFixture,
  installLifecycleTestHooks,
  withWindowsPlatform,
} from "./stardew-production-lifecycle-coordinator.test-support.js";

installLifecycleTestHooks();

/** The native exit code a Windows process killed by a loader failure reports. */
const PLAYER_HOST_EXIT_CODE = 3221225781;

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

/** Stages, launches and attests the fixture's Player Host through the contained runtime. */
async function launchOwnedPlayerHost(fixture: Awaited<ReturnType<typeof createFixture>>): Promise<void> {
  await fixture.coordinator.activationOwner.activate(fixture.broker.issue("lifecycle_activation"));
  await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
    apiVersion: 1,
    idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
  });
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
