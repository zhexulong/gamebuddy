/**
 * The Game surface's producer: the transitions the panel cannot learn from its own commands.
 *
 * What a mounted panel actually observes is the browser journey's subject. What this file pins is the narrow claim the
 * journey depends on: the coordinator ANNOUNCES a fact at the assignment that changed it, announces the three facts
 * that can move without a player and nothing else, and announces each one once per transition - no timer, and no
 * heartbeat pretending to be a transition.
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

type GameFact = "instance" | "attachment" | "selectedWorld";

/** Collects what a subscriber would have been told, in order. */
function collectFacts(fixture: Awaited<ReturnType<typeof createFixture>>): {
  facts: GameFact[];
  end(): void;
} {
  const facts: GameFact[] = [];
  const end = fixture.coordinator.subscribeGameFacts((fact) => facts.push(fact as GameFact));
  return { facts, end };
}

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
      for (const watcher of watchers) watcher(exit);
    },
  });
}

test("a resume announces the world it bound and the attachment it armed, in that order", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({
        gameSessionId: "session-abc",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
    },
  });
  try {
    const { facts } = collectFacts(fixture);
    await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    // The world is bound before the attachment is armed, and the attachment generation/connection is one fact: the
    // pair of assignments publishes once, not once each.
    assert.deepEqual(facts, ["selectedWorld", "attachment"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("a command that only moves action authority announces nothing", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({
        gameSessionId: "session-abc",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
    },
  });
  try {
    await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    const { facts } = collectFacts(fixture);
    // Reopen moves `actionAuthority` from paused to active and touches nothing else. It is a command-driven fact -
    // the command's own confirmation read answers it - so it is deliberately not on the stream. A surface that
    // pushed it would publish an event for every command, which is the storm this seam must not become.
    await fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), {
      apiVersion: 1,
      idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    assert.deepEqual(facts, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("a game the Guardian reports ended announces the instance once, and reads after it announce nothing", async () => {
  await withWindowsPlatform(async () => {
    const guardian = guardianSession();
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(guardian.session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
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
      const { facts } = collectFacts(fixture);

      // A paused world ticks its clock but does not run its update loop, so the Mod sends no heartbeat to notice
      // this: the fact is the Host's own, discovered by the reads it already makes.
      guardian.report(Object.freeze({ role: "player_host", exitCode: 3221225781 }));
      assert.deepEqual(facts, [], "nothing was observed yet, so nothing is claimed");

      fixture.coordinator.launchReadinessReader.readLaunchReadinessView();
      assert.deepEqual(facts, ["instance"]);
      // The exit is latched: every later read answers the same ending, and the transition is already announced.
      fixture.coordinator.launchReadinessReader.readLaunchReadinessView();
      fixture.coordinator.launchReadinessReader.readLaunchReadinessView();
      assert.deepEqual(facts, ["instance"]);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("the announcement is that subscriber's alone, and ends when it ends", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({
        gameSessionId: "session-abc",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
    },
  });
  try {
    const first = collectFacts(fixture);
    const second = collectFacts(fixture);
    first.end();
    await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(first.facts, [], "an ended subscription is not called");
    assert.deepEqual(second.facts, ["selectedWorld", "attachment"]);
    assert.throws(() => fixture.coordinator.subscribeGameFacts(undefined as never), /game_fact_listener_invalid/);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
