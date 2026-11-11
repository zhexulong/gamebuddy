import {
  connectedSemanticGameLeaseFixture,
  createFixture,
  publishSignedPlayerHostSessionSync,
  waitForAttachmentRequest,
  publishAttachmentAdmission,
  availableCabins,
  prepareCabinCoordinator,
  confirmFirstCabin,
  waitFor,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { GameBrowserValidatorsV1 } from "./game-browser-contract/index.js";
import type { StardewLifecycleCoordinatorTestingOverrides } from "./stardew-production-lifecycle-coordinator.test-support-internal.js";

installLifecycleTestHooks();

// ─── Slice 3: game.resume.cancel epoch termination ──────────────────────────

test("game.resume.cancel fails closed without an in-flight resume or on a stale generation", async () => {
  const fixture = await createFixture();
  try {
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.cancelResume(fixture.broker.issue("game_resume_cancel"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_resume_cancel_unavailable/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("game.resume.cancel terminates the reconnect epoch, keeps the armed generation, and the retry mints a new attempt identity", async () => {
  let allowAttach = false;
  let connectChainCalls = 0;
  let resumeConnectCalls = 0;
  let enterCalls = 0;
  let ingressCalls = 0;
  let voiceStopperCalls = 0;
  const recordedConnectGenerations: string[] = [];
  const recordConnect = (
    connection: Parameters<
      NonNullable<StardewLifecycleCoordinatorTestingOverrides["connectFarmhandGameRuntimeFacade"]>
    >[0],
  ) => {
    recordedConnectGenerations.push(connection.launchGeneration);
  };
  const semanticFacadeFixture = () =>
    Object.freeze({
      authority: "SEMANTIC" as const,
      runEnter: async () => {
        enterCalls += 1;
        return connectedSemanticGameLeaseFixture({
          onAttachVoiceStopper: () => {
            voiceStopperCalls += 1;
          },
          onActivate: () => {
            ingressCalls += 1;
          },
        });
      },
      recoverDeadOwner: async () => undefined,
      close: async () => undefined,
    });
  const transientError = Object.assign(new Error("bridge-not-ready"), { code: "ECONNREFUSED" });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({
        gameSessionId: "session-abc",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
      connectFarmhandGameRuntimeFacade: async (connection) => {
        connectChainCalls += 1;
        recordConnect(connection);
        if (connectChainCalls > 1) {
          resumeConnectCalls += 1;
          if (!allowAttach) throw transientError;
        }
        return semanticFacadeFixture();
      },
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "cancel-disconnect",
      expectedAttachmentGeneration: 1,
    });
    // Producer: an in-flight resume attempt is parked in the bridge retry loop
    // (generation 2 armed, AI freshly launched).
    const resuming = fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "cancel-resume-attempt",
      expectedAttachmentGeneration: 2,
    });
    resuming.catch(() => undefined);
    await waitFor(() => resumeConnectCalls >= 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "syncing",
    });
    // A stale cancel epoch for the wrong generation fails closed without
    // disturbing the attempt.
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.cancelResume(fixture.broker.issue("game_resume_cancel"), {
          apiVersion: 1,
          idempotencyKey: "cancel-stale-gen",
          expectedAttachmentGeneration: 3,
        }),
      /stardew_game_attachment_generation_conflict/,
    );
    // Consumer: the exact in-flight epoch is cancelled; the retry loop stops,
    // the armed activation is abandoned, the partial facade (none here) is
    // closed, and the projection becomes disconnected/unavailable while the
    // generation keeps its armed value.
    const cancelled = await fixture.coordinator.activationOwner.cancelResume(
      fixture.broker.issue("game_resume_cancel"),
      { apiVersion: 1, idempotencyKey: "cancel-attempt-2", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(cancelled, { apiVersion: 1, status: "cancelled" });
    assert.equal(GameBrowserValidatorsV1.GameResumeCancelResultV1Schema.Check(cancelled), true);
    await assert.rejects(resuming, /stardew_game_resume_cancelled/);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "disconnected",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    // Replay of the same cancel key returns the same cancelled result; a
    // changed tuple fails closed.
    const replay = await fixture.coordinator.activationOwner.cancelResume(fixture.broker.issue("game_resume_cancel"), {
      apiVersion: 1,
      idempotencyKey: "cancel-attempt-2",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(replay, { apiVersion: 1, status: "cancelled" });
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.cancelResume(fixture.broker.issue("game_resume_cancel"), {
          apiVersion: 1,
          idempotencyKey: "cancel-attempt-2",
          expectedAttachmentGeneration: 3,
        }),
      /stardew_game_resume_cancel_idempotency_conflict/,
    );
    // No stale reconnect completes after the cancel: even with the attach
    // gate open, no further cancelled-epoch connect attempt runs and nothing
    // attaches until a fresh resume attempt starts.
    const cancelledEpochAttempts = recordedConnectGenerations.filter(
      (generation) => generation === "ai-generation-2",
    ).length;
    assert.ok(cancelledEpochAttempts >= 1);
    allowAttach = true;
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 80));
    assert.equal(
      recordedConnectGenerations.filter((generation) => generation === "ai-generation-2").length,
      cancelledEpochAttempts,
    );
    assert.equal(enterCalls, 1);
    assert.equal(ingressCalls, 1);
    assert.equal(voiceStopperCalls, 1);
    // Verifier: Player world untouched; only the armed AI activation was
    // abandoned (the retry below stops it via the per-activation prepare).
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    // Retry: a fresh attempt identity (generation G+1) re-attaches through the
    // resume pipeline without reusing the cancelled attempt's launch identity.
    const retried = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "cancel-retry-attempt",
      expectedAttachmentGeneration: 3,
    });
    assert.deepEqual(retried, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 3,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2", "ai-generation-3"],
    );
    // The initial cabin attach and the retry consumed fresh launch identities;
    // the cancelled epoch consumed only its own generation and the retry
    // minted a strictly newer one — the cancelled identity is never reused.
    assert.deepEqual(
      new Set(recordedConnectGenerations),
      new Set(["ai-generation-1", "ai-generation-2", "ai-generation-3"]),
    );
    assert.equal(recordedConnectGenerations.at(-1), "ai-generation-3");
    assert.equal(enterCalls, 2);
    assert.equal(ingressCalls, 2);
    assert.equal(voiceStopperCalls, 2);
    // The retry is the next attempt identity; the old cancelled one is terminal.
    assert.deepEqual(fixture.aiKillCalls, [4101, 4101]);
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.equal(fixture.playerSpawnCalls.length, 1);
    // A cancel after the resume settled is stale and fails closed.
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.cancelResume(fixture.broker.issue("game_resume_cancel"), {
          apiVersion: 1,
          idempotencyKey: "cancel-stale-after-settle",
          expectedAttachmentGeneration: 3,
        }),
      /stardew_game_resume_cancel_unavailable/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("headless operational admission consumes one fresh registered installation through the existing lifecycle core", async () => {
  let runtimeRootForSession = "";
  const fixture = await createFixture({
    afterPlayerSpawn: () => {
      // The Player Host game thread publishes its signed session advertisement
      // immediately after spawning; the attestation correlation reads it back.
      // cabin-alpha is free for this companion; cabin-foreign is bound to
      // another companion and cabin-busy is occupied, so headless auto-select
      // deterministically picks the single free Farmhand cabin.
      publishSignedPlayerHostSessionSync(runtimeRootForSession, "player-generation-1", availableCabins);
    },
  });
  runtimeRootForSession = fixture.runtimeRoot;
  try {
    // When the headless flow writes its attachment request, the fixture Host
    // (standing in for the game thread) answers with a signed ready response
    // and the issued Farmhand join manifest exactly like the browser path.
    const responder = setInterval(() => {
      void (async () => {
        try {
          const request = await waitForAttachmentRequest(runtimeRootForSession);
          const cabin = availableCabins[0]!;
          await publishAttachmentAdmission(runtimeRootForSession, request, cabin);
          clearInterval(responder);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && !((error as Error).message ?? "").includes("wait_for_attachment_request_timeout")) {
            // ignore transient missing-file; only stop on real failure
          }
        }
      })();
    }, 10);
    const lease = await fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest);
    clearInterval(responder);
    assert.equal(lease.activateCommittedIngress.length, 0);
    assert.equal(typeof lease.close, "function");
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    // Design 100 Step 1 asserts exact-once fresh registration admission. The
    // Player Host launch and the AI-client launch each fresh-admit the private
    // locator exactly once, so the count is exactly 2.
    assert.equal(fixture.freshRegistrationAdmissionCount(), 2);
    // The committed ingress is deferred to the lease owner: it is armed but not
    // yet released, then one-shot activated and double-activation rejected.
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 0);
    // Phase A: the lease exposes exactly the task-ingress composition surface
    // (piSessionId/gameSessionId/dispatch/cancel/evidence) on top of ingress
    // activation and close — no facade, snapshot, installation, or bridge facts.
    assert.equal(lease.piSessionId, "pi-session-stardew-test");
    assert.equal(lease.gameSessionId, "game-session-stardew-test");
    assert.equal(typeof lease.dispatchPromptDefinedTask, "function");
    assert.equal(typeof lease.cancelPromptDefinedTask, "function");
    // The evidence face is optional at the lease level: it is armed only when
    // the production composition supplies a game-operational-gate nonce (the
    // headless fixture runs without one, so it stays undefined here). The type
    // surface is what Phase A pins; the armed path is exercised in Phase B/3.
    assert.ok(
      lease.nextOperationalGateEvidence === undefined || typeof lease.nextOperationalGateEvidence === "function",
      "evidence face must be absent or a function",
    );
    assert.equal(Object.isFrozen(lease), true);
    lease.activateCommittedIngress();
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.throws(() => lease.activateCommittedIngress(), /stardew_headless_ingress_already_activated/);
    await lease.close();
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("duplicate or payload-drift headless admission cannot rematerialize or launch", async () => {
  let runtimeRootForSession = "";
  const fixture = await createFixture({
    afterPlayerSpawn: () => {
      publishSignedPlayerHostSessionSync(runtimeRootForSession, "player-generation-1", availableCabins);
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
          /* transient */
        }
      })();
    }, 10);
    const drifted = { ...fixture.manifest, authorityGeneration: 999 };
    // A payload-drift manifest is rejected before any lifecycle core call.
    await assert.rejects(
      () => fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(drifted),
      /stardew_headless_manifest_identity_mismatch/,
    );
    assert.equal(fixture.playerSpawnCalls.length, 0);
    assert.equal(fixture.spawnCalls.length, 0);
    // Once the first headless admission is in flight, a second (even identical)
    // attempt fails closed with activation_conflict and never re-launches.
    const first = fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest);
    await assert.rejects(
      () => fixture.coordinator.headlessOperationalGame.activateHeadlessOperationalGame(fixture.manifest),
      /stardew_lifecycle_activation_conflict/,
    );
    const lease = await first;
    clearInterval(responder);
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    await lease.close();
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
