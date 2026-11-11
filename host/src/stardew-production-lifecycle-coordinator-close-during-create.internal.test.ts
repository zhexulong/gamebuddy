import {
  deferredVoid,
  awaitParkedPhase,
  withWindowsPlatform,
  createFixture,
  waitForAttachmentRequest,
  publishAttachmentAdmission,
  attachmentRequestId,
  publishNextAttachmentAdmission,
  availableCabins,
  prepareCabinCoordinator,
  fakeGameSessionCreationAuthority,
  startEndgameLifecycle,
  containedGuardianSessionRecorder,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { StardewGameSessionCreationAuthority } from "./stardew-production-lifecycle-coordinator.internal.js";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
} from "./composition/stardew/stardew-guardian-platform.js";

installLifecycleTestHooks();

test("close during create settles the interrupted create through the same durable closure", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const completionEntered = deferredVoid();
  const completionGate = deferredVoid();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: Object.freeze({
        ...fake.authority,
        completeGameSessionBinding: async (
          input: Parameters<StardewGameSessionCreationAuthority["completeGameSessionBinding"]>[0],
        ) => {
          completionEntered.resolve();
          await completionGate.promise;
          return fake.authority.completeGameSessionBinding(input);
        },
      }),
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // Parked inside the completion step: the binding is registered and the
    // session is one step short of `resumable`.
    await completionEntered.promise;
    assert.equal(fake.sessions()[0]!.status, "pending");
    assert.equal(fake.readBinding(fake.sessions()[0]!.gameSessionId)?.status, "registered");
    // Design card 114: an unfinished create stops before close and is settled by
    // the durable failure rules. close() joins this attempt, so the closure runs
    // before any teardown and the post-close state is terminal + failed, never a
    // registered binding with resumable metadata behind.
    const closing = fixture.coordinator.close();
    completionGate.resolve();
    await assert.rejects(creating, /stardew_lifecycle_closing/);
    await closing;
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "terminal",
      revision: 2,
    });
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 3,
    });
    assert.deepEqual(fake.listResumable(), []);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("close after an explicit endgame joins an in-flight create so its durable rows settle before close resolves", async () => {
  await withWindowsPlatform(async () => {
    const fake = fakeGameSessionCreationAuthority();
    const slotReadEntered = deferredVoid();
    const slotReadGate = deferredVoid();
    const sessionCalls: string[] = [];
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(containedGuardianSessionRecorder(sessionCalls)),
    );
    const fixture = await createFixture({
      overrides: {
        runtimeLaunchContained: collaborator,
        gameSessionCreationAuthority: Object.freeze({
          ...fake.authority,
          // Parked in the world-slot read: the native world seam has already run
          // and the session is one step short of registering its binding. This
          // is the deepest point a post-endgame create can reach -- the endgame
          // released the registration pointer, so `readWorldBindingHolderHandle`
          // refuses every later registration under its own bounded code and no
          // registered binding with resumable metadata can exist on this path.
          readGameSessionWorldBindingSlotHolder: async (
            input: Parameters<StardewGameSessionCreationAuthority["readGameSessionWorldBindingSlotHolder"]>[0],
          ) => {
            slotReadEntered.resolve();
            await slotReadGate.promise;
            return fake.authority.readGameSessionWorldBindingSlotHolder(input);
          },
        }),
        createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
      },
    });
    try {
      await startEndgameLifecycle(fixture);
      const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
      const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        integrationId: "stardew",
        continuityIdentityId: null,
      });
      let createSettled = false;
      void creating.then(
        () => {
          createSettled = true;
        },
        () => {
          createSettled = true;
        },
      );
      await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
      await awaitParkedPhase(slotReadEntered, "world_slot_read");
      const sessionId = fake.sessions()[0]!.gameSessionId;
      assert.equal(fake.readMetadata(sessionId)?.status, "pending");
      assert.equal(fake.readBinding(sessionId), null);
      const closing = fixture.coordinator.close();
      slotReadGate.resolve();
      await closing;
      // Nothing was awaited between `close()` and these assertions, so they run
      // at the exact instant close resolved -- that ordering is the point: the
      // endgame branch of close used to return without joining the create, so it
      // could resolve while the create's durable settle was still pending.
      // close() joins the in-flight create on EVERY path, so the create's own
      // failure closure has already run here.
      assert.equal(createSettled, true);
      assert.deepEqual(fake.readMetadata(sessionId), {
        gameSessionId: sessionId,
        integrationId: "stardew",
        continuityIdentityId: null,
        status: "failed",
        revision: 2,
      });
      assert.equal(fake.readBinding(sessionId), null);
      assert.deepEqual(fake.listResumable(), []);
      await assert.rejects(creating, /stardew_lifecycle_closing/);
    } finally {
      // The parked create has to be released before close can join it, even on a
      // failure exit; resolving an already-resolved gate is a no-op.
      slotReadGate.resolve();
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("close after an explicit endgame leaves no facade or lease open for the create it drained", async () => {
  await withWindowsPlatform(async () => {
    const fake = fakeGameSessionCreationAuthority();
    const seamEntered = deferredVoid();
    const seamGate = deferredVoid();
    const sessionCalls: string[] = [];
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(containedGuardianSessionRecorder(sessionCalls)),
    );
    const fixture = await createFixture({
      overrides: {
        runtimeLaunchContained: collaborator,
        gameSessionCreationAuthority: fake.authority,
        // Parked in the world-creation seam, i.e. BEFORE registration: the other
        // mutually exclusive durable create failure shape.
        createWorldBinding: async () => {
          seamEntered.resolve();
          await seamGate.promise;
          return Object.freeze({ bindingRef: "Farm_389124477" });
        },
      },
    });
    try {
      await startEndgameLifecycle(fixture);
      const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
      const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        integrationId: "stardew",
        continuityIdentityId: null,
      });
      let createSettled = false;
      void creating.then(
        () => {
          createSettled = true;
        },
        () => {
          createSettled = true;
        },
      );
      await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
      await seamEntered.promise;
      const sessionId = fake.sessions()[0]!.gameSessionId;
      assert.equal(fake.readBinding(sessionId), null);
      const closing = fixture.coordinator.close();
      seamGate.resolve();
      await closing;
      // Immediately after close resolved, without awaiting the create first.
      assert.equal(createSettled, true);
      assert.deepEqual(fake.readMetadata(sessionId), {
        gameSessionId: sessionId,
        integrationId: "stardew",
        continuityIdentityId: null,
        status: "failed",
        revision: 2,
      });
      assert.equal(fake.readBinding(sessionId), null);
      assert.deepEqual(fake.listResumable(), []);
      // No facade/lease is left open. On this path the drained create cannot mint
      // one at all: the endgame already drove the durable owner record to
      // `contained`, so the AI-client launch and the bridge consumption it would
      // need both fail closed before `attachResumedWorld` can reach :1449/:1485.
      // The assertions below show the whole path is drained: the only facade and
      // lease this lifecycle built came from the cabin confirmation, the
      // endgame's own teardown closed the facade exactly once, and the drained
      // create left no second, unclosed one behind.
      assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
        status: "none",
        generation: 0,
        connectionStatus: "none",
      });
      assert.equal(fixture.bridgeConnectCalls.length, 1);
      assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
      assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("game.create after a failed FIRST AI launch re-arms a fresh activation instead of retrying consumed reservations", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    // The very first AI-client spawn of this lifecycle fails.
    aiSpawnFailureAt: 1,
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const firstCreating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const firstRequest = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, firstRequest, availableCabins[0]!);
    const first = await firstCreating;
    // The first create settled post-registration as unavailable: terminal
    // binding + failed metadata (the D2 shape, driven by the ONE closure).
    assert.deepEqual(first, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.spawnCalls[0]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-1");
    const firstSessionId = fake.sessions()[0]!.gameSessionId;
    assert.equal(fake.readBinding(firstSessionId)?.status, "terminal");
    assert.equal(fake.readMetadata(firstSessionId)?.status, "failed");
    // The failed launch still consumed the owner's one-shot AI-client launch and
    // bridge connection reservations. A later create in the same lifecycle must
    // therefore re-arm a fresh activation generation instead of retrying them
    // (which would fail closed with stardew_ai_client_launch_not_available).
    const secondRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const secondCreating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    await publishNextAttachmentAdmission(fixture.runtimeRoot, secondRequestId, availableCabins[0]!);
    const second = await secondCreating;
    assert.equal(second.status, "attached");
    assert.notEqual(second.gameSessionId, firstSessionId);
    assert.match(second.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2"],
    );
    assert.equal(fake.readMetadata(second.gameSessionId!)?.status, "resumable");
    assert.equal(fake.readBinding(second.gameSessionId!)?.status, "registered");
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // The Player world is untouched by either create or by the failed launch.
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.equal(fixture.playerSpawnCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
