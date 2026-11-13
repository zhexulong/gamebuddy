import {
  connectedSemanticGameLeaseFixture,
  withWindowsPlatform,
  createFixture,
  publishSignedPlayerHostSessionSync,
  waitForAttachmentRequest,
  publishAttachmentAdmission,
  ownerRecord,
  attachmentRequestId,
  publishNextAttachmentAdmission,
  availableCabins,
  prepareCabinCoordinator,
  confirmFirstCabin,
  fakeGameSessionCreationAuthority,
  waitFor,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { stardewFarmhandJoinBudgetMs } from "./stardew-production-lifecycle-coordinator.internal.js";
import { GameBrowserValidatorsV1 } from "./game-browser-contract/index.js";

installLifecycleTestHooks();

// ─── Slice 3: game.create two-phase flow and failure/terminal discipline ────

test("game.create fails explicitly without a launched and attested Player Host and writes nothing durable", async () => {
  // Owner ruling (a)/(b): create is admitted only over the exact Player Host
  // this lifecycle already launched and attested. Neither a never-activated
  // lifecycle nor an activated-but-unlaunched one may persist a binding intent
  // and sit at `accepted` forever.
  for (const stage of ["never_activated", "activated_not_launched"] as const) {
    const fake = fakeGameSessionCreationAuthority();
    const fixture = await createFixture({
      overrides: {
        gameSessionCreationAuthority: fake.authority,
        createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
      },
    });
    try {
      if (stage === "activated_not_launched") {
        await withWindowsPlatform(async () => {
          await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
        });
      }
      assert.throws(
        () =>
          fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
            integrationId: "stardew",
            continuityIdentityId: null,
          }),
        /stardew_game_create_player_host_unavailable/,
      );
      // Fail-closed before any durable write, and no native or attachment work.
      assert.deepEqual(fake.sessions(), []);
      assert.deepEqual(fake.inputs(), []);
      assert.deepEqual(fixture.spawnCalls, []);
      assert.deepEqual(fixture.playerSpawnCalls, []);
      assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
        status: "none",
        generation: 0,
        connectionStatus: "none",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  }
});

test("game.create over the launched exact owner re-admits the manifest handoff and attaches the first activation", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      // Integration-private seam stand-in: the Stardew implementation drives the
      // game's own native new-game entry and returns the physical slot basename
      // it observed. The coordinator never names a slot and persists the opaque
      // ref verbatim.
      createWorldBinding: async () => Object.freeze({ bindingRef: "Farm_389124477" }),
    },
  });
  try {
    // Launch-before-create only launched the Player Host: no cabin was admitted
    // yet, so the AI-client profile is not materialized and the first
    // activation still needs the manifest handoff re-admission.
    assert.equal(fixture.spawnCalls.length, 0);
    const created = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await created;
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    assert.equal(result.status, "attached");
    assert.match(result.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    const sessionId = result.gameSessionId!;
    // Phase 2a-2c persisted the store-minted id and the seam's opaque bindingRef.
    assert.deepEqual(fake.inputs(), ["create", "register", "complete"]);
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "resumable",
      revision: 2,
    });
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      bindingRef: "Farm_389124477",
      status: "registered",
      revision: 1,
    });
    assert.deepEqual(fake.listResumable(), [fake.readMetadata(sessionId)]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // The first activation launches the AI client through the reservations the
    // owner already holds; only an owner whose previous activation ended is
    // re-armed onto a fresh launch generation.
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.spawnCalls[0]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-1");
    assert.equal(fixture.bridgeConnectCalls.length, 1);
    assert.equal(fixture.bridgeConnectCalls[0]!.launchGeneration, "ai-generation-1");
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create fails closed as unavailable with a failed pending row when world creation is unavailable or fails", async () => {
  for (const seamMode of ["absent", "authority-only", "throwing"] as const) {
    const fake = fakeGameSessionCreationAuthority();
    // Launch-before-create: the create is admitted over a launched and attested
    // Player Host, so these cases exercise the seam contract itself rather than
    // the launch precondition.
    const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
      overrides:
        seamMode === "absent"
          ? {}
          : seamMode === "authority-only"
            ? { gameSessionCreationAuthority: fake.authority }
            : {
                gameSessionCreationAuthority: fake.authority,
                createWorldBinding: async () => {
                  throw new Error("controlled-world-creation-failure");
                },
              },
    });
    try {
      const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        integrationId: "stardew",
        continuityIdentityId: null,
      });
      if (seamMode === "throwing") {
        // The manifest handoff admission now precedes the seam (Loop 4 path
        // B'), so a mounted-seam create publishes and waits for its own
        // attachment request before the seam runs.
        const request = await waitForAttachmentRequest(fixture.runtimeRoot);
        await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
      }
      const result = await creating;
      assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
      assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
      if (seamMode === "absent" || seamMode === "authority-only") {
        // A sealed/unmounted seam fails before any durable write: no rows at all,
        // regardless of whether the authority alone was already connected.
        assert.deepEqual(fake.sessions(), []);
        assert.deepEqual(fake.inputs(), []);
      } else {
        // An attempted world creation failure follows the D2 failure table:
        // pending → failed rev2, no binding row, never resumable.
        const legacy = fake.sessions();
        assert.equal(legacy.length, 1);
        assert.deepEqual(legacy[0], {
          gameSessionId: legacy[0]!.gameSessionId,
          integrationId: "stardew",
          continuityIdentityId: null,
          status: "failed",
          revision: 2,
        });
        assert.equal(fake.readBinding(legacy[0]!.gameSessionId), null);
        assert.deepEqual(fake.listResumable(), []);
        assert.deepEqual(fake.inputs(), ["create", "fail"]);
        // The failure path re-verifies the store-minted id for the CAS.
        assert.ok(fake.inputs().includes("fail"));
      }
      // The failed create launched no role itself: the only Player Host spawn
      // is the launch that preceded the create.
      assert.deepEqual(fixture.spawnCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  }
});

test("game.create rejects a foreign integrationId before any durable write (published-registry guard)", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await createFixture({
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async () => Object.freeze({ bindingRef: "opaque-world-ref" }),
    },
  });
  try {
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          integrationId: "another-game",
          continuityIdentityId: null,
        }),
      /stardew_game_create_integration_conflict/,
    );
    assert.deepEqual(fake.sessions(), []);
    assert.deepEqual(fake.inputs(), []);
    // No attachment or launch projection changed.
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

test("game.create replays the same idempotency key with the same session and rejects a changed tuple", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const command = {
      apiVersion: 1 as const,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    };
    const first = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), command);
    const replay = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), command);
    assert.equal(replay, first);
    // The create is admitted over the launched Player Host and re-admits the
    // manifest handoff; the external admission publication releases it.
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    const result = await first;
    assert.equal(result.status, "attached");
    // Exactly one durable lineage was created for both requests.
    assert.equal(fake.sessions().length, 1);
    assert.deepEqual(fake.inputs(), ["create", "register", "complete"]);
    // A changed tuple under the same key fails closed.
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          integrationId: "stardew",
          continuityIdentityId: "continuity-1",
        }),
      /stardew_game_create_idempotency_conflict/,
    );
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          integrationId: "another-game",
          continuityIdentityId: null,
        }),
      /stardew_game_create_idempotency_conflict/,
    );
    // No second durable lineage appeared after the rejected tuples.
    assert.equal(fake.sessions().length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create enforces the single-activation mutual exclusion for live attachments and in-flight operations", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
    // A live healthy attachment is a live world: create is refused without
    // disturbing it (card D4).
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          integrationId: "stardew",
          continuityIdentityId: null,
        }),
      /stardew_game_runtime_unavailable/,
    );
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }

  // In-flight resume blocks create; the create admission rejects synchronously
  // without touching the store or the attempt.
  const resumeBlocked = fakeGameSessionCreationAuthority();
  const resumeFixture = await createFixture({
    overrides: {
      gameSessionCreationAuthority: resumeBlocked.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const resuming = resumeFixture.coordinator.activationOwner.resume(resumeFixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-absent",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.throws(
      () =>
        resumeFixture.coordinator.activationOwner.createGameSession(resumeFixture.broker.issue("game_create"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          integrationId: "stardew",
          continuityIdentityId: null,
        }),
      /stardew_game_create_in_progress/,
    );
    assert.deepEqual(resumeBlocked.sessions(), []);
    // The named session resolves to no resumable world, so this attempt is refused by
    // name rather than reporting the `unavailable` a session-LESS command gets. This
    // assertion still expected the older outcome: when the coordinator began refusing
    // the named-absent session by name, every sibling assertion was updated and this one
    // was missed, so the test failed while the refusal itself was correct.
    await assert.rejects(() => resuming, /stardew_game_resume_session_unavailable/);
  } finally {
    await resumeFixture.coordinator.close();
    await resumeFixture.broker.close();
  }

  // In-flight create blocks resume; the resume admission rejects synchronously
  // while the create is still pending on its own handoff re-admission.
  const createBlocked = fakeGameSessionCreationAuthority();
  const createFixtureGate = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: createBlocked.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const creating = createFixtureGate.coordinator.activationOwner.createGameSession(
      createFixtureGate.broker.issue("game_create"),
      { apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w", integrationId: "stardew", continuityIdentityId: null },
    );
    assert.throws(
      () =>
        createFixtureGate.coordinator.activationOwner.resume(createFixtureGate.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-abc",
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_resume_in_progress/,
    );
    const request = await waitForAttachmentRequest(createFixtureGate.runtimeRoot);
    await publishAttachmentAdmission(createFixtureGate.runtimeRoot, request, availableCabins[0]!);
    // The create completes its first activation over the launched exact owner
    // and never blocks the resume guard again after settling.
    const createOutcome = await creating;
    assert.equal(createOutcome.status, "attached");
    assert.match(createOutcome.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    const blockedSessions = createBlocked.sessions();
    assert.equal(blockedSessions.length, 1);
    assert.equal(blockedSessions[0]!.status, "resumable");
    assert.equal(createBlocked.readBinding(blockedSessions[0]!.gameSessionId)?.status, "registered");
  } finally {
    await createFixtureGate.coordinator.close();
    await createFixtureGate.broker.close();
  }
});

test("game.create after a clean disconnect attaches the first activation at generation 1 with actions paused", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "create-clean-disconnect",
      expectedAttachmentGeneration: 1,
    });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    // Producer: the full two-phase create, then the first activation reuses
    // the fresh-attach machinery (arm AI → launch → bridge → materialize →
    // runEnter → committed ingress). Consumer: register/complete settle the
    // durable rows before the attach. Verifier: result attached, generation 1,
    // actions paused, fresh per-activation launch generation, rows resumable.
    // The create re-admits its own manifest handoff before its seam, so it
    // mints a fresh attachment request identity that needs its own publication.
    const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
    const result = await creating;
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    assert.equal(result.status, "attached");
    assert.match(result.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    const sessionId = result.gameSessionId!;
    assert.deepEqual(fake.readMetadata(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "resumable",
      revision: 2,
    });
    assert.deepEqual(fake.readBinding(sessionId)?.status, "registered");
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.equal(fixture.spawnCalls.length, 2);
    assert.equal(fixture.spawnCalls[1]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-2");
    assert.equal(fixture.bridgeConnectCalls.length, 2);
    assert.equal(fixture.bridgeConnectCalls[1]!.launchGeneration, "ai-generation-2");
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 2);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 2);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 2);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create attach failure after registration goes terminal binding + failed metadata in one durable outcome", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    aiSpawnFailureAt: 2,
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "create-terminal-disconnect",
      expectedAttachmentGeneration: 1,
    });
    // The first activation's AI launch fails after the binding was registered
    // and the session completed: the D2 post-registration failure path applies
    // (binding terminal rev2 + metadata failed rev3), never a resumable
    // half-record, and the wire reports unavailable with no session handle.
    const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
    const result = await creating;
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(result), true);
    const sessions = fake.sessions();
    assert.equal(sessions.length, 1);
    const sessionId = sessions[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(sessionId), {
      gameSessionId: sessionId,
      integrationId: "stardew",
      bindingRef: `world-${sessionId.slice(0, 8)}`,
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
    // Verifier: the attachment never completed; generation was not left armed
    // beyond the failed epoch and no player-world process was touched.
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.deepEqual(fixture.playerKillCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create whose first AI activation bridge retry expires settles durably and the next create re-arms through the core", async () => {
  // N2: the retry wait could expire and escape the activation without rolling
  // the core back, leaving the owner's AI launch claimed while its bridge
  // connection stayed armed. The next create then asked the core for a fresh
  // generation, was refused as "not available", and reported a permanent
  // `accepted` that never progresses.
  const fake = fakeGameSessionCreationAuthority();
  const realDateNow = Date.now;
  let allowAttach = false;
  let facadeEnterCalls = 0;
  let ingressActivationCalls = 0;
  const connectGenerations: string[] = [];
  const transientPipeNotReady = Object.assign(new Error("controlled_pipe_not_ready"), { code: "ENOENT" });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
      connectFarmhandGameRuntimeFacade: async (connection) => {
        connectGenerations.push(connection.launchGeneration);
        // The AI client is launched and running; only its bridge pipe never
        // becomes connectable, so every attempt is the transient retry case.
        if (!allowAttach) throw transientPipeNotReady;
        return Object.freeze({
          authority: "SEMANTIC" as const,
          runEnter: async () => {
            facadeEnterCalls += 1;
            return connectedSemanticGameLeaseFixture({
              onActivate: () => {
                ingressActivationCalls += 1;
              },
            });
          },
          recoverDeadOwner: async () => undefined,
          close: async () => undefined,
        });
      },
    },
  });
  try {
    // Producer: launch-before-create already attested the Player Host, so this
    // create re-admits its own manifest handoff and then runs the owner's FIRST
    // activation: the AI client is launched through the untouched reservation
    // (ai-generation-1) and the bridge is retried until the create's own
    // activation deadline expires.
    const firstRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    await publishNextAttachmentAdmission(fixture.runtimeRoot, firstRequestId, availableCabins[0]!);
    // Waiting for the launch itself (the connect attempt always follows it) keeps
    // this bounded well under the create's own activation deadline.
    await waitFor(() => fixture.spawnCalls.length >= 1, 2_000);
    // The create's own activation deadline is `min(browser session expiry, now + the
    // Farmhand join budget)`, so skewing the process clock past that budget expires the
    // retry wait immediately instead of letting this test sleep it out. This fixture mounts
    // no real installation folder, so the Player Host carried no player Mod and the skew is
    // the zero-Mod budget. Restored before the second create, which must run on the real clock.
    Date.now = () => realDateNow() + stardewFarmhandJoinBudgetMs(0) + 1_000;
    const first = await creating;
    Date.now = realDateNow;
    // Consumer/verifier: an expired activation is a real failure of this
    // create and settles through the ONE durable closure (the post-registration
    // shape), never a silent `accepted` that leaves a resumable half-record.
    assert.deepEqual(first, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.equal(GameBrowserValidatorsV1.GameCreateResultV1Schema.Check(first), true);
    const failed = fake.sessions();
    assert.equal(failed.length, 1);
    const failedSessionId = failed[0]!.gameSessionId;
    assert.deepEqual(fake.readBinding(failedSessionId), {
      gameSessionId: failedSessionId,
      integrationId: "stardew",
      bindingRef: `world-${failedSessionId.slice(0, 8)}`,
      status: "terminal",
      revision: 2,
    });
    assert.deepEqual(fake.readMetadata(failedSessionId), {
      gameSessionId: failedSessionId,
      integrationId: "stardew",
      continuityIdentityId: null,
      status: "failed",
      revision: 3,
    });
    assert.deepEqual(fake.listResumable(), []);
    assert.equal(connectGenerations.filter((generation) => generation === "ai-generation-1").length >= 1, true);
    assert.equal(facadeEnterCalls, 0);
    assert.equal(ingressActivationCalls, 0);
    // Consumer: the next create in the SAME lifecycle must still work. It asks
    // the core again, and the expired activation was rolled back to the fully
    // consumed base, so the core admits a genuinely new generation
    // (ai-generation-2) instead of refusing the re-arm.
    allowAttach = true;
    const secondRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creatingAgain = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    await publishNextAttachmentAdmission(fixture.runtimeRoot, secondRequestId, availableCabins[0]!);
    const second = await creatingAgain;
    assert.equal(second.status, "attached");
    assert.match(second.gameSessionId ?? "", /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(second.gameSessionId, failedSessionId);
    assert.equal(fake.listResumable().length, 1);
    // Verifier: the re-arm ended the expired activation's AI client and the
    // fresh generation reached the launch and the bridge, and the new session
    // attached with actions paused.
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2"],
    );
    assert.equal(connectGenerations.at(-1), "ai-generation-2");
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.equal(facadeEnterCalls, 1);
    assert.equal(ingressActivationCalls, 1);
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
  } finally {
    Date.now = realDateNow;
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

// N3: a launch callback entered before its launch promise failed still consumes
// the owner's one-shot AI launch in the core, while both paths settle on a
// quarantined exact owner. No coordinator-side latch survives either attempt --
// the activation shape is asked of the core at every activation -- so a later
// create can only fail closed on the terminal owner instead of being admitted
// on a stale "untouched" decision.

test("a cabin AI launch that claimed its reservation before failing leaves no stale activation for a later create", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    aiSpawnFailureAt: 1,
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
      apiVersion: 1,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "n3-cabin-launch-key",
      confirmed: true,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    // The launch was entered (the core consumed the reservation) and its spawn
    // then failed: the cabin path settles uncertain and quarantines the owner.
    await assert.rejects(confirmation, /stardew_cabin_publication_uncertain/);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    // Verifier: a create over that exact owner is admitted by the lifecycle
    // guards and must fail closed on the terminal owner before taking either
    // activation shape, so no durable row and no second AI launch can appear.
    const created = await fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    assert.deepEqual(created, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.deepEqual(fake.inputs(), []);
    assert.deepEqual(fake.sessions(), []);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    // The create really reached the owner re-attestation and terminated the
    // exact owner there, rather than being refused earlier by a lifecycle guard.
    assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
      generation: 0,
      status: "failed",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("a headless AI launch that claimed its reservation before failing leaves no stale activation for a later create", async () => {
  const fake = fakeGameSessionCreationAuthority();
  let runtimeRootForSession = "";
  const fixture = await createFixture({
    aiSpawnFailureAt: 1,
    afterPlayerSpawn: () => {
      publishSignedPlayerHostSessionSync(runtimeRootForSession, "player-generation-1", availableCabins);
    },
    overrides: {
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  runtimeRootForSession = fixture.runtimeRoot;
  try {
    const responder = setInterval(() => {
      void (async () => {
        try {
          const request = await waitForAttachmentRequest(runtimeRootForSession);
          await publishAttachmentAdmission(runtimeRootForSession, request, availableCabins[0]!);
          clearInterval(responder);
        } catch {
          /* transient: the request file appears once the handoff is issued */
        }
      })();
    }, 10);
    // The one-shot headless admission launched the Player Host, admitted its
    // cabin, materialized the profile and then entered the AI launch callback,
    // which is where the spawn failed.
    await assert.rejects(
      () => fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest),
      /controlled-ai-spawn-failure/,
    );
    clearInterval(responder);
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    // Verifier: the later create fails closed on the terminal owner rather than
    // reporting a permanent `accepted` on the consumed-but-unfinished
    // activation.
    const created = await fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    assert.deepEqual(created, { apiVersion: 1, status: "unavailable", gameSessionId: null });
    assert.deepEqual(fake.inputs(), []);
    assert.deepEqual(fake.sessions(), []);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    // The create really reached the owner re-attestation and terminated the
    // exact owner there, rather than being refused earlier by a lifecycle guard.
    assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
      generation: 0,
      status: "failed",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.create clears the previous resume lineage so the new session can be resumed without cross-session conflicts", async () => {
  const fake = fakeGameSessionCreationAuthority();
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    aiSpawnFailureAt: 2,
    overrides: {
      worldBindingResolver: async () => ({
        gameSessionId: "session-abc",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
      gameSessionCreationAuthority: fake.authority,
      createWorldBinding: async (input) => Object.freeze({ bindingRef: `world-${input.gameSessionId.slice(0, 8)}` }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "create-lineage-disconnect",
      expectedAttachmentGeneration: 1,
    });
    // A failed resume of the old lineage leaves its resumed-session guard set
    // with the armed generation retained (same as the failed-resume retry test).
    await assert.rejects(
      fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
        apiVersion: 1,
        gameSessionId: "session-abc",
        idempotencyKey: "lineage-resume-fail",
        expectedAttachmentGeneration: 2,
      }),
      /controlled-ai-spawn-failure/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "failed",
    });
    // Start new game creates a NEW session; the old lineage's in-memory guard
    // must not shadow the fresh session's retry/resume admission. The create
    // re-admits its own manifest handoff, so it publishes its own request.
    const previousRequestId = await attachmentRequestId(fixture.runtimeRoot);
    const creating = fixture.coordinator.activationOwner.createGameSession(fixture.broker.issue("game_create"), {
      apiVersion: 1,
      idempotencyKey: "lineage-create",
      integrationId: "stardew",
      continuityIdentityId: null,
    });
    await publishNextAttachmentAdmission(fixture.runtimeRoot, previousRequestId, availableCabins[0]!);
    const created = await creating;
    assert.equal(created.status, "attached");
    const newSessionId = created.gameSessionId!;
    assert.equal(newSessionId === "session-abc", false);
    assert.deepEqual(fake.readMetadata(newSessionId)?.status, "resumable");
    // The new session's world is live, so its resume is admitted after a
    // clean disconnect: the previous lineage guard was cleared, otherwise the
    // resume would fail with a cross-session conflict.
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "lineage-disconnect-new",
      expectedAttachmentGeneration: 3,
    });
    const resumed = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: newSessionId,
      idempotencyKey: "lineage-resume-new",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(resumed, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2", "ai-generation-3", "ai-generation-4"],
    );
    assert.deepEqual(fixture.playerKillCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
