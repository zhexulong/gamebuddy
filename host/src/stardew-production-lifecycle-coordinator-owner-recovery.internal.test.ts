import {
  withWindowsPlatform,
  createFixture,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
  driveStardewOwnedPlayerHostRecovery,
  isFirstFarmhandAiClientActivationIntact,
  isResumeAttachDeferredError,
  type StardewContainedRuntimeTeardown,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import type { StardewOwnedPlayerHostBootstrap } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
import { prepareMaterializedAiClientFixture } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-fixtures.js";
import { FarmhandBridgeConnectionNotAvailableError } from "./containment/runtime/contract/game-runtime.js";
import type { RedactedRecoveryOutcome } from "./containment/runtime/contract/game-runtime.js";
import type { StardewOwnerRecoveryRequest } from "./composition/stardew/stardew-guardian-platform.js";

installLifecycleTestHooks();

/**
 * The recovery drive the admission judge uses: one bounded recovery, closed out
 * in the same step. The seams below are scripted, so the ordering, the
 * exactly-once attempt count and every refusal path are observed rather than
 * assumed.
 *
 * A recovery that did not reach a terminal the drive accepts is never finalized:
 * an uncertain native recovery must be neither closed out as if it had succeeded
 * nor re-driven. Its two failing answers are pinned separately, because they do not
 * mean the same thing: `unavailable` reports a recovery that did not reach
 * containment, while a held native gate reports the LEASE verdict - the holder
 * was not proven gone - under its own bounded code. The two terminals the drive
 * DOES accept each go through their own closure, and the order is pinned: the
 * closure runs before the terminal's code is reported, and a closure that refuses
 * replaces that code rather than being swallowed.
 */
test("the owner recovery drive finalizes every terminal it accepts, exactly once, and never fabricates one", async () => {
  const request: StardewOwnerRecoveryRequest = Object.freeze({
    recoveryInstanceId: "0a5c1e7b-2f3d-4a90-8c11-6d2b7e4f9a02",
    readRecoveryBinding: async () => Object.freeze({}),
  });
  const owner = Object.freeze({}) as unknown as StardewOwnedPlayerHostBootstrap;
  const scripted = (
    events: string[],
    recover: (received: StardewOwnerRecoveryRequest) => Promise<RedactedRecoveryOutcome>,
    finalize: (received: StardewOwnerRecoveryRequest) => Promise<void>,
    finalizeAiSettled: (received: StardewOwnerRecoveryRequest) => Promise<void> = finalize,
  ): StardewContainedRuntimeTeardown =>
    Object.freeze({
      containPlayerHost: async () => {
        events.push("containPlayerHost");
      },
      containAiClient: async () => {
        events.push("containAiClient");
      },
      settle: async () => {
        events.push("settle");
      },
      recover: async (_owner, received) => {
        events.push("recover");
        return recover(received);
      },
      finalizeRecovered: async (_owner, received) => {
        events.push("finalizeRecovered");
        await finalize(received);
      },
      finalizeRecoveredAiSettled: async (_owner, received) => {
        events.push("finalizeRecoveredAiSettled");
        await finalizeAiSettled(received);
      },
      close: async () => {
        events.push("close");
      },
    });

  // (a) A recovery that reached containment is finalized, with the SAME request
  // object the recovery took: the actor the durable CASes recorded and the actor
  // the finalization must match cannot drift apart.
  const successEvents: string[] = [];
  const receivedRequests: StardewOwnerRecoveryRequest[] = [];
  await driveStardewOwnedPlayerHostRecovery(
    scripted(
      successEvents,
      async (received) => {
        receivedRequests.push(received);
        return Object.freeze({ status: "recovered" as const });
      },
      async (received) => {
        receivedRequests.push(received);
      },
    ),
    owner,
    request,
  );
  assert.deepEqual(successEvents, ["recover", "finalizeRecovered"]);
  assert.deepEqual(receivedRequests, [request, request]);

  // (b) An outcome short of containment is never finalized, and the recovery is
  // attempted exactly once.
  const unavailableEvents: string[] = [];
  const unavailableTeardown = scripted(
    unavailableEvents,
    async () => Object.freeze({ status: "unavailable" as const }),
    async () => {
      throw new Error("finalization_must_not_run");
    },
  );
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(unavailableTeardown, owner, request),
    /stardew_owner_recovery_unavailable/,
  );
  assert.deepEqual(unavailableEvents, ["recover"]);

  // (c) A recovery the seam refuses outright propagates that bounded refusal and
  // still never finalizes anything.
  const refusedEvents: string[] = [];
  await assert.rejects(
    () =>
      driveStardewOwnedPlayerHostRecovery(
        scripted(
          refusedEvents,
          async () => {
            throw new Error("stardew_contained_recovery_drive_unavailable");
          },
          async () => {
            throw new Error("finalization_must_not_run");
          },
        ),
        owner,
        request,
      ),
    /stardew_contained_recovery_drive_unavailable/,
  );
  assert.deepEqual(refusedEvents, ["recover"]);

  // (d) A finalization that refuses reports its own bounded error and does not
  // re-drive the recovery.
  const finalizeRefusedEvents: string[] = [];
  await assert.rejects(
    () =>
      driveStardewOwnedPlayerHostRecovery(
        scripted(
          finalizeRefusedEvents,
          async () => Object.freeze({ status: "recovered" as const }),
          async () => {
            throw new Error("stardew_bootstrap_owner_recovery_finalize_failed");
          },
        ),
        owner,
        request,
      ),
    /stardew_bootstrap_owner_recovery_finalize_failed/,
  );
  assert.deepEqual(finalizeRefusedEvents, ["recover", "finalizeRecovered"]);

  // (e) Without the seam there is nothing to drive, and the refusal is bounded.
  await assert.rejects(
    () => driveStardewOwnedPlayerHostRecovery(undefined, owner, request),
    /stardew_owner_recovery_seam_unavailable/,
  );

  // (f) A HELD native gate carries its own bounded code instead of the generic
  // unavailable one. The two are not interchangeable: this answer is about the
  // holder's lease - a live handle exists at the lease name, so the holder was
  // NOT proven gone - and a caller that has to decide whether that holder's world
  // slot may be released reads exactly this code to refuse. It finalizes nothing,
  // drives the recovery once, and is never retried.
  const gateHeldEvents: string[] = [];
  await assert.rejects(
    () =>
      driveStardewOwnedPlayerHostRecovery(
        scripted(
          gateHeldEvents,
          async () => Object.freeze({ status: "gate_held" as const }),
          async () => {
            throw new Error("finalization_must_not_run");
          },
        ),
        owner,
        request,
      ),
    (error: unknown) => error instanceof Error && error.message === "stardew_owner_recovery_gate_held",
  );
  assert.deepEqual(gateHeldEvents, ["recover"]);

  // (g) The AI-side terminal is closed out through the seam's OWN terminal member
  // and only then reported under its own bounded code, checked BEFORE the generic
  // non-recovered refusal so it is never reported as an uncertainty or as a held
  // gate: the gate DID open, the AI side is settled and the player's world was
  // deliberately preserved. The close-out runs FIRST, so no attempt is ever
  // reported as closed out while it still occupies its registration.
  const aiSettledEvents: string[] = [];
  await assert.rejects(
    () =>
      driveStardewOwnedPlayerHostRecovery(
        scripted(
          aiSettledEvents,
          async () => Object.freeze({ status: "ai_settled_player_preserved" as const }),
          async () => {
            throw new Error("finalization_must_not_run");
          },
          async () => undefined,
        ),
        owner,
        request,
      ),
    (error: unknown) =>
      error instanceof Error && error.message === "stardew_owner_recovery_ai_settled_player_preserved",
  );
  assert.deepEqual(aiSettledEvents, ["recover", "finalizeRecoveredAiSettled"]);

  // (h) A close-out that refuses is never swallowed, and the terminal code is NOT
  // reported for an attempt that was not closed out: the attempt would still
  // occupy its registration, so reporting the terminal would be exactly the
  // fabricated success this seam must never produce.
  const aiSettledRefusedEvents: string[] = [];
  await assert.rejects(
    () =>
      driveStardewOwnedPlayerHostRecovery(
        scripted(
          aiSettledRefusedEvents,
          async () => Object.freeze({ status: "ai_settled_player_preserved" as const }),
          async () => {
            throw new Error("finalization_must_not_run");
          },
          async () => {
            throw new Error("stardew_bootstrap_owner_recovery_finalize_failed");
          },
        ),
        owner,
        request,
      ),
    (error: unknown) => error instanceof Error && error.message === "stardew_bootstrap_owner_recovery_finalize_failed",
  );
  assert.deepEqual(aiSettledRefusedEvents, ["recover", "finalizeRecoveredAiSettled"]);
});

/**
 * The coordinator reads two different states off the SAME composition probe:
 * "the owner's first one-shot activation is still intact" (a create launches
 * through the untouched reservations) and "this attach cannot be built here"
 * (the attach defers to the next layer's fresh authority). The composition is
 * the only side that can see its refusal's text, so a message comparison on this
 * side is a silent coupling: renaming that text would reclassify an intact
 * activation as a hard failure with no test on either side going red.
 *
 * This test drives the real composition to its real refusal and asks the real
 * classifiers about that exact value, then asks the same classifier about the
 * refusal's text rebuilt as a plain Error -- the value a message comparison
 * accepted. It fails in both directions: if the composition stops refusing with
 * the port's exported identity, and if this side starts classifying by text
 * again.
 */
test("the intact first Farmhand activation classification is bound to the composition's typed refusal", async () => {
  // A materialized AI-client profile whose first activation was never consumed:
  // exactly the owner shape a create launches through.
  const fixture = await prepareMaterializedAiClientFixture();
  try {
    let refusal: unknown;
    try {
      await fixture.testCore.prepareFreshFarmhandAiClientActivation(fixture.owner);
    } catch (error) {
      refusal = error;
    }
    assert.ok(
      refusal instanceof FarmhandBridgeConnectionNotAvailableError,
      `the composition must refuse with the platform contract's identity, got ${String(refusal)}`,
    );
    // The composition's real refusal IS the intact-first-activation state...
    assert.equal(isFirstFarmhandAiClientActivationIntact(refusal), true);
    // ...and only that identity: the same text as a plain Error is not.
    assert.equal(isFirstFarmhandAiClientActivationIntact(new Error(refusal.message)), false);
    // The other consumer of the same probe still reads the refusal by its text,
    // and this lane deliberately left it that way: converting this one side must
    // not change what a resume attach defers on.
    assert.equal(isResumeAttachDeferredError(refusal), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Game launch rejects a different key while the first launch is pending", async () => {
  await withWindowsPlatform(async () => {
    let fixture!: Awaited<ReturnType<typeof createFixture>>;
    let competingLaunch!: Promise<unknown>;
    fixture = await createFixture({
      afterPlayerSpawn: () => {
        competingLaunch = fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedInstanceGeneration: 1,
        });
        competingLaunch.catch(() => undefined);
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "CDEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      assert.notEqual(competingLaunch, undefined);
      await assert.rejects(competingLaunch, /stardew_game_launch_in_progress/);
      assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});
