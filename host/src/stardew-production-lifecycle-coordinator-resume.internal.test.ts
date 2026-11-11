import {
  withWindowsPlatform,
  createFixture,
  publishSignedPlayerHostSession,
  waitForAttachmentRequest,
  publishAttachmentAdmission,
  availableCabins,
  prepareCabinCoordinator,
  confirmFirstCabin,
  staleEpochRefusal,
  wireIdempotencyKey,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readStardewInstallationRegistration } from "./stardew-installation-registration.internal.js";
import { GameBrowserValidatorsV1, type GameBrowserStateV1 } from "./game-browser-contract/index.js";

installLifecycleTestHooks();

// ─── Slice 1B: coordinator fresh-generation resume seam ─────────────────────

test("resume admits a registered binding, bumps attachment generation to >= 2, pauses actions, and runs no old task", async () => {
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
    const result = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(result, { apiVersion: 1, status: "accepted" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "reconnecting",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // No fresh native/attachment work and no old task in this slice.
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    assert.deepEqual(fixture.bridgeConnectCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 0);
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 0);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume of a named session with no resumable world is refused by name and creates no activation", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => null,
    },
  });
  try {
    await assert.rejects(
      () =>
        fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-absent",
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_resume_session_unavailable/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    assert.deepEqual(fixture.spawnCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume resolves the exact session the command names, and another session's id is refused", async () => {
  // The resolver here is the REAL one over a store view the test owns, so the
  // binding is found by the id the command carries rather than by the fixture
  // returning whatever it is asked for. That is what makes the second half
  // meaningful: the same coordinator, the same world, a different id.
  const registered = new Map([
    [
      "session-mine",
      {
        gameSessionId: "session-mine",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      },
    ],
  ]);
  const resolvedIds: string[] = [];
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async (input: Readonly<{ gameSessionId: string; integrationId: string }>) => {
        resolvedIds.push(input.gameSessionId);
        return registered.get(input.gameSessionId) ?? null;
      },
    },
  });
  try {
    const result = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-mine",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(result, { apiVersion: 1, status: "accepted" });
    assert.deepEqual(resolvedIds, ["session-mine"]);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "reconnecting",
    });

    // The same lifecycle, a session it holds no world for. The refusal names the
    // session identity, so the browser can say which game cannot be resumed
    // instead of "try again later", and nothing about the live world changes.
    await fixture.coordinator.close();
    const second = await createFixture({
      overrides: {
        worldBindingResolver: async (input: Readonly<{ gameSessionId: string; integrationId: string }>) => {
          resolvedIds.push(input.gameSessionId);
          return registered.get(input.gameSessionId) ?? null;
        },
      },
    });
    try {
      await assert.rejects(
        () =>
          second.coordinator.activationOwner.resume(second.broker.issue("game_resume"), {
            apiVersion: 1,
            gameSessionId: "session-someone-else",
            idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
            expectedAttachmentGeneration: 2,
          }),
        /stardew_game_resume_session_unavailable/,
      );
      assert.ok(resolvedIds.includes("session-someone-else"), "the refusal came from resolving THAT id");
      assert.deepEqual(second.coordinator.attachmentReader.readAttachmentView(), {
        status: "none",
        generation: 0,
        connectionStatus: "none",
      });
      assert.deepEqual(second.spawnCalls, []);
      assert.deepEqual(second.bridgeConnectCalls, []);
    } finally {
      await second.coordinator.close();
      await second.broker.close();
    }
  } finally {
    await fixture.coordinator.close().catch(() => undefined);
  }
});

test("resume names the generation it will establish, not the one on screen", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async (input: Readonly<{ gameSessionId: string; integrationId: string }>) => ({
        gameSessionId: input.gameSessionId,
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
    },
  });
  try {
    const first = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-mine",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(first, { apiVersion: 1, status: "accepted" });
    assert.equal(fixture.coordinator.attachmentReader.readAttachmentView().generation, 2);
    // The retry a failed attempt earns. The player is looking at generation 2, and
    // the reconnect they are asking for would establish 3 - so naming 2 is the
    // stale-controller refusal. That is the direction the browser panel used to
    // send, which is why no resume could ever be admitted. The refusal is a
    // synchronous one (the command tuple is checked before any attempt starts).
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-mine",
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_attachment_generation_conflict/,
    );
    assert.deepEqual(
      await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
        apiVersion: 1,
        gameSessionId: "session-mine",
        idempotencyKey: "CBEiM0RVZneImaq7zN3u_w",
        expectedAttachmentGeneration: 3,
      }),
      { apiVersion: 1, status: "accepted" },
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("a session-less resume stays the typed unavailable outcome with no refusal and no side effect", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => {
        throw new Error("resume_without_a_session_must_not_resolve_a_binding");
      },
    },
  });
  try {
    const result = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(result, { apiVersion: 1, status: "unavailable" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.spawnCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume replays a duplicate idempotency key with the same accepted result and rejects a changed tuple", async () => {
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
    const command = {
      apiVersion: 1 as const,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    };
    const first = fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), command);
    const replay = fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), command);
    assert.equal(replay, first);
    assert.deepEqual(await first, { apiVersion: 1, status: "accepted" });
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-abc",
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 3,
        }),
      /stardew_game_resume_idempotency_conflict/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume fails closed when expectedAttachmentGeneration does not match the fresh generation", async () => {
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
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-abc",
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_attachment_generation_conflict/,
    );
    // A mismatch must never mint a fresh activation.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "reconnecting",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume rejects a second resume while the first is still in progress", async () => {
  let releaseSet: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseSet = resolve;
  });
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => {
        await gate;
        return {
          gameSessionId: "session-abc",
          integrationId: "stardew",
          bindingRef: "opaque-world-ref",
          status: "registered" as const,
          revision: 1,
        };
      },
    },
  });
  try {
    const pending = fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-abc",
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_resume_in_progress/,
    );
    releaseSet!();
    assert.deepEqual(await pending, { apiVersion: 1, status: "accepted" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("resume fails closed when a different resumed session is presented after one world binding", async () => {
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async (input) =>
        input.gameSessionId === "session-abc"
          ? {
              gameSessionId: input.gameSessionId,
              integrationId: "stardew",
              bindingRef: "opaque-world-ref",
              status: "registered" as const,
              revision: 1,
            }
          : {
              gameSessionId: input.gameSessionId,
              integrationId: "stardew",
              bindingRef: "opaque-world-ref",
              status: "registered" as const,
              revision: 2,
            },
    },
  });
  try {
    await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    // The same coordinator never attaches a second world binding.
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-other",
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 3,
        }),
      /stardew_game_resume_idempotency_conflict/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
// ─── Slice 2: resume fresh attachment chain, stale teardown, and projection ──

test("slice 2: resume rejects while a live healthy attachment is attached without disturbing it", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
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
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
    // A live, healthy attachment is still a single-activation authority: the
    // fresh resume generation is refused without touching the live world.
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
          apiVersion: 1,
          gameSessionId: "session-abc",
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 2,
        }),
      /stardew_game_runtime_unavailable/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: resume closes a stale failed attachment through the shared teardown and truly re-attaches the fresh generation", async () => {
  // The gen-1 facade close fails once (stale failed attachment), then succeeds
  // when the resume reuses the exact teardown machinery.
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, true],
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
    await confirmFirstCabin(fixture);
    await assert.rejects(
      fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
        apiVersion: 1,
        idempotencyKey: "slice2-stale-disconnect",
        expectedAttachmentGeneration: 1,
      }),
      /controlled_game_runtime_binding_close_failure/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "failed",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, []);

    const result = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(result, { apiVersion: 1, status: "attached" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    // The stale gen-1 activation was torn down through the shared teardown
    // timing (prompt-task cancel + exact facade close), so no old-activation
    // in-memory objects outlive the fresh claim.
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 2);
    // Producer: fresh per-activation prepare stopped the ended AI and armed a
    // fresh generation. Consumer: fresh AI launch + bridge consume + enter ran
    // end-to-end. Verifier: second spawn/connect used ai-generation-2 while
    // the scope stayed the registered world binding.
    assert.equal(fixture.aiKillCalls.length, 1);
    assert.equal(fixture.spawnCalls.length, 2);
    assert.equal(fixture.spawnCalls[1]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-2");
    assert.equal(fixture.bridgeConnectCalls.length, 2);
    assert.equal(fixture.bridgeConnectCalls[1]!.launchGeneration, "ai-generation-2");
    assert.deepEqual(fixture.bridgeConnectCalls[1]!.scope, fixture.bridgeConnectCalls[0]!.scope);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 2);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 2);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 2);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: resume fails closed when the stale attachment teardown itself fails and claims no fresh generation", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, false],
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
    await confirmFirstCabin(fixture);
    await assert.rejects(
      fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
        apiVersion: 1,
        idempotencyKey: "slice2-teardown-fail-disconnect",
        expectedAttachmentGeneration: 1,
      }),
      /controlled_game_runtime_binding_close_failure/,
    );
    await assert.rejects(
      fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
        apiVersion: 1,
        gameSessionId: "session-abc",
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        expectedAttachmentGeneration: 2,
      }),
      /controlled_game_runtime_binding_close_failure/,
    );
    // No stale object was torn down and no fresh activation was claimed: the
    // coordinator retains exactly the failed-disconnect state for retry.
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "failed",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: resume after a clean disconnect truly re-attaches the fresh generation with a new AI launch and connection", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
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
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "slice2-clean-disconnect",
      expectedAttachmentGeneration: 1,
    });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "none",
      generation: 0,
      connectionStatus: "none",
    });
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);

    const result = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(result, { apiVersion: 1, status: "attached" });
    assert.equal(GameBrowserValidatorsV1.GameResumeResultV1Schema.Check(result), true);
    // Producer: fresh per-activation prepare ends the previous AI and arms a
    // fresh generation. Consumer: fresh AI launch + bridge consume + enter
    // ran end-to-end. Verifier: second spawn/connect used ai-generation-2
    // while the scope stayed the registered world binding, no old task or
    // stale objects survived (enter #2, ingress #2, ready-actions-paused).
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.equal(fixture.spawnCalls.length, 2);
    assert.equal(fixture.spawnCalls[1]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-2");
    assert.equal(fixture.bridgeConnectCalls.length, 2);
    assert.equal(fixture.bridgeConnectCalls[1]!.launchGeneration, "ai-generation-2");
    assert.deepEqual(fixture.bridgeConnectCalls[1]!.scope, fixture.bridgeConnectCalls[0]!.scope);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 2);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 2);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 2);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("a stale attachment epoch cannot mutate the live world, and every stale verb is refused by name with no side effect", async () => {
  // The epoch advance here is the product's own reconnect, not a fabricated
  // number: the clean disconnect at generation 1 tears the first attachment down
  // and the resume mints generation 2 over the same registered world binding. A
  // controller that was driving generation 1 is then stale, and this drives every
  // mutation it can still send against the live world.
  //
  // Faces, stated so neither is mistaken for the other:
  // - BEHAVIOUR face: the attachment view, the action-authority view, and every
  //   spy the composed runtime already exposes (STOP calls, kills, spawns, Bridge
  //   connects, facade enter/ingress/cancel, facade closes, lifecycle order).
  // - NOT OBSERVABLE here: a raw action request is not a browser command - it is
  //   dispatched on the attachment's lease, which the disconnect closed and the
  //   resume replaced (facade enter #2 below). This harness's lease stand-in does
  //   not model revocation of a closed lease, so "the old lease can no longer act"
  //   is NOT observable in this fixture and is not claimed by these assertions.
  //   What is claimed is the browser-visible half: the stale controller cannot
  //   re-open action authority, stop, close, endgame, resume or cancel.
  // The two ways this lifecycle can end the player's world, both counted so that
  // "the refusal reached nothing" is an observation rather than a missing throw:
  // the contained-runtime seam (`settle` is the one member that advances the
  // durable attempt to `contained` and releases the bound registration pointer)
  // and the durable session store slice the lifecycle owns.
  const containmentCalls: string[] = [];
  const durableStoreCalls: string[] = [];
  const unreachableStoreMember = (member: string) => async (): Promise<never> => {
    durableStoreCalls.push(member);
    throw new Error(`stardew_durable_store_unreachable:${member}`);
  };
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      worldBindingResolver: async () => ({
        gameSessionId: "session-abc",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
      containedRuntimeTeardown: Object.freeze({
        containPlayerHost: async () => {
          containmentCalls.push("contain_player_host");
        },
        containAiClient: async () => {
          containmentCalls.push("contain_ai_client");
        },
        settle: async () => {
          containmentCalls.push("settle");
        },
        recover: async () => {
          throw new Error("stardew_contained_recovery_drive_unavailable");
        },
        finalizeRecovered: async () => {
          throw new Error("stardew_contained_recovery_drive_unavailable");
        },
        finalizeRecoveredAiSettled: async () => {
          throw new Error("stardew_contained_recovery_drive_unavailable");
        },
        close: async () => {
          containmentCalls.push("close");
        },
      }),
      gameSessionCreationAuthority: Object.freeze({
        createGameSessionMetadata: unreachableStoreMember("createGameSessionMetadata"),
        registerGameSessionWorldBinding: unreachableStoreMember("registerGameSessionWorldBinding"),
        completeGameSessionBinding: unreachableStoreMember("completeGameSessionBinding"),
        failGameSessionCreation: unreachableStoreMember("failGameSessionCreation"),
        markGameSessionWorldBindingTerminal: unreachableStoreMember("markGameSessionWorldBindingTerminal"),
        readGameSessionWorldBindingSlotHolder: unreachableStoreMember("readGameSessionWorldBindingSlotHolder"),
        releaseGameSessionWorldBindingSlot: unreachableStoreMember("releaseGameSessionWorldBindingSlot"),
      }),
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "stale-epoch-clean-disconnect",
      expectedAttachmentGeneration: 1,
    });
    assert.deepEqual(
      await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
        apiVersion: 1,
        gameSessionId: "session-abc",
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        expectedAttachmentGeneration: 2,
      }),
      { apiVersion: 1, status: "attached" },
    );
    const liveAttachment = fixture.coordinator.attachmentReader.readAttachmentView();
    assert.deepEqual(liveAttachment, { status: "attached", generation: 2, connectionStatus: "connected_idle" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });

    const before = Object.freeze({
      stops: fixture.gameStopCalls.length,
      aiKills: [...fixture.aiKillCalls],
      playerKills: [...fixture.playerKillCalls],
      bridgeCloses: [...fixture.bridgeCloseCalls],
      bridgeConnects: fixture.bridgeConnectCalls.length,
      aiSpawns: fixture.spawnCalls.length,
      playerSpawns: fixture.playerSpawnCalls.length,
      enters: fixture.gameRuntimeFacadeEnterCalls(),
      ingresses: fixture.gameRuntimeIngressActivationCalls(),
      voiceStoppers: fixture.gameRuntimeVoiceStopperAttachCalls(),
      taskCancels: fixture.gameRuntimeTaskCancelCalls(),
      lifecycleOrder: [...fixture.lifecycleOrder],
    });
    // The reconnect really did re-attach: without this the matrix below would be
    // asserting against an epoch that was never minted.
    assert.equal(before.enters, 2);
    assert.equal(before.bridgeConnects, 2);
    // The real durable pointer binding this live attempt to the installation. The
    // explicit endgame is the only operation that releases it (`settle` settles the
    // attempt and releases the pointer), so its survival is what "the stale
    // endgame did not end the new world" means in durable terms.
    const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
    assert.notEqual(
      registrationBefore?.activeAttempt ?? null,
      null,
      "the live attempt is bound before the matrix runs",
    );

    const stale = { expectedAttachmentGeneration: 1 } as const;
    const mutations: readonly Readonly<{ name: string; expectedRefusal: string; run(): unknown }>[] = Object.freeze([
      {
        name: "stop",
        expectedRefusal: "stardew_game_attachment_generation_conflict",
        run: () =>
          fixture.coordinator.activationOwner.stopGame(fixture.broker.issue("game_stop"), {
            apiVersion: 1,
            idempotencyKey: "stale-epoch-stop",
            ...stale,
          }),
      },
      {
        name: "close (disconnect)",
        expectedRefusal: "stardew_game_attachment_generation_conflict",
        run: () =>
          fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
            apiVersion: 1,
            idempotencyKey: "stale-epoch-close",
            ...stale,
          }),
      },
      {
        // A live attachment is refused before the generation is even read, so the
        // name says the useful thing - there IS a live attachment, so no fresh
        // generation can be minted on top of it - rather than "stale".
        name: "reconnect (resume)",
        expectedRefusal: "stardew_game_runtime_unavailable",
        run: () =>
          fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
            apiVersion: 1,
            gameSessionId: "session-abc",
            idempotencyKey: "stale-epoch-resume",
            ...stale,
          }),
      },
      {
        name: "retry/cancel (resume.cancel)",
        expectedRefusal: "stardew_game_resume_cancel_unavailable",
        run: () =>
          fixture.coordinator.activationOwner.cancelResume(fixture.broker.issue("game_resume_cancel"), {
            apiVersion: 1,
            idempotencyKey: "stale-epoch-cancel",
            ...stale,
          }),
      },
      {
        name: "action authority reopen",
        expectedRefusal: "stardew_game_attachment_generation_conflict",
        run: () =>
          fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), {
            apiVersion: 1,
            idempotencyKey: "stale-epoch-action",
            ...stale,
          }),
      },
      {
        name: "explicit endgame",
        expectedRefusal: "stardew_game_attachment_generation_conflict",
        run: () =>
          fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), {
            apiVersion: 1,
            idempotencyKey: "stale-epoch-endgame",
            confirm: true,
            ...stale,
          }),
      },
    ]);

    // Every row is refused FIRST and asserted together, so a guard that stops
    // answering names the row that drifted instead of hiding the rest behind the
    // first failure.
    const refusals: string[] = [];
    for (const mutation of mutations) refusals.push(`${mutation.name}: ${await staleEpochRefusal(mutation.run)}`);
    assert.deepEqual(
      refusals,
      mutations.map((mutation) => `${mutation.name}: ${mutation.expectedRefusal}`),
      "every stale-epoch verb is refused by the identity it was issued against",
    );

    for (const mutation of mutations) {
      // Re-read after EVERY verb: a refusal that also mutated the live attachment
      // would otherwise pass on the refusal alone.
      const detail = `${mutation.name} had a side effect on the live epoch`;
      assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), liveAttachment, detail);
      assert.deepEqual(
        fixture.coordinator.actionAuthorityReader.readActionAuthorityView(),
        { status: "paused" },
        detail,
      );
      assert.equal(fixture.gameStopCalls.length, before.stops, detail);
      assert.deepEqual(fixture.aiKillCalls, before.aiKills, detail);
      assert.deepEqual(fixture.playerKillCalls, before.playerKills, detail);
      assert.deepEqual(fixture.bridgeCloseCalls, before.bridgeCloses, detail);
      assert.equal(fixture.bridgeConnectCalls.length, before.bridgeConnects, detail);
      assert.equal(fixture.spawnCalls.length, before.aiSpawns, detail);
      assert.equal(fixture.playerSpawnCalls.length, before.playerSpawns, detail);
      assert.equal(fixture.gameRuntimeFacadeEnterCalls(), before.enters, detail);
      assert.equal(fixture.gameRuntimeIngressActivationCalls(), before.ingresses, detail);
      assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), before.voiceStoppers, detail);
      assert.equal(fixture.gameRuntimeTaskCancelCalls(), before.taskCancels, detail);
      assert.deepEqual(fixture.lifecycleOrder, before.lifecycleOrder, detail);
      // Containment is how a stale endgame would REALLY end the live world: these
      // three members are the only path to terminating both role Jobs and
      // settling the attempt. A refusal that still ran them would otherwise pass
      // on the refusal alone.
      assert.deepEqual(containmentCalls, [], `${detail} (contained-runtime containment/settle)`);
      // The durable half: no new store row, no terminal binding, no receipt - the
      // store slice the lifecycle owns was never reached by a refused verb.
      assert.deepEqual(durableStoreCalls, [], `${detail} (durable store write)`);
      assert.deepEqual(
        await readStardewInstallationRegistration(fixture.runtimeRoot),
        registrationBefore,
        `${detail} (the bound attempt pointer endgame releases)`,
      );
    }
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("a stale attachment epoch sent through the real browser ingress is refused by name at the wire and mutates nothing", async () => {
  // The coordinator-level matrix above proves the guards answer a stale epoch. It cannot
  // prove the PLAYER's own path reaches them: it hands the activation owner a command
  // object, so the transport, the bootstrap/CSRF/origin admission, the command schema and
  // the problem-code projection are all absent. This drives the same stale identities
  // through the composed request handler over a real loopback socket, so every refusal
  // below is the Host answering a real POST.
  //
  // Faces, stated so neither is mistaken for the other:
  // - HERE: the browser wire. Each row asserts the status and problem code the player would
  //   see, the side-effect counters that would move if the refusal had not held, and that
  //   the live attachment is still the one the reconnect minted.
  // - NOT HERE: an Agent action. `game_browser_api/v1` declares no action operation at all:
  //   an action is the Agent's own tool call inside the attached runtime, and a browser
  //   cannot send one. `game.action` is therefore read below as the absent route it is, not
  //   as a guarded one - there is no epoch check on that path to inject.
  const containmentCalls: string[] = [];
  const durableStoreCalls: string[] = [];
  const unreachableStoreMember = (member: string) => async (): Promise<never> => {
    durableStoreCalls.push(member);
    throw new Error(`stardew_durable_store_unreachable:${member}`);
  };
  const fixture = await createFixture({
    overrides: {
      worldBindingResolver: async () => ({
        gameSessionId: "session-abc",
        integrationId: "stardew",
        bindingRef: "opaque-world-ref",
        status: "registered" as const,
        revision: 1,
      }),
      containedRuntimeTeardown: Object.freeze({
        containPlayerHost: async () => {
          containmentCalls.push("contain_player_host");
        },
        containAiClient: async () => {
          containmentCalls.push("contain_ai_client");
        },
        settle: async () => {
          containmentCalls.push("settle");
        },
        recover: async () => {
          throw new Error("stardew_contained_recovery_drive_unavailable");
        },
        finalizeRecovered: async () => {
          throw new Error("stardew_contained_recovery_drive_unavailable");
        },
        finalizeRecoveredAiSettled: async () => {
          throw new Error("stardew_contained_recovery_drive_unavailable");
        },
        close: async () => {
          containmentCalls.push("close");
        },
      }),
      gameSessionCreationAuthority: Object.freeze({
        createGameSessionMetadata: unreachableStoreMember("createGameSessionMetadata"),
        registerGameSessionWorldBinding: unreachableStoreMember("registerGameSessionWorldBinding"),
        completeGameSessionBinding: unreachableStoreMember("completeGameSessionBinding"),
        failGameSessionCreation: unreachableStoreMember("failGameSessionCreation"),
        markGameSessionWorldBindingTerminal: unreachableStoreMember("markGameSessionWorldBindingTerminal"),
        readGameSessionWorldBindingSlotHolder: unreachableStoreMember("readGameSessionWorldBindingSlotHolder"),
        releaseGameSessionWorldBindingSlot: unreachableStoreMember("releaseGameSessionWorldBindingSlot"),
      }),
    },
  });
  try {
    const { origin, cookie, csrfToken } = fixture.broker;
    const base = `${origin}/api/composed-reference-game/v1`;
    const readHeaders = Object.freeze({ origin, cookie });
    const commandHeaders = Object.freeze({
      origin,
      cookie,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
    });
    const post = async (path: string, body: unknown): Promise<Response> =>
      await fetch(`${base}${path}`, { method: "POST", headers: commandHeaders, body: JSON.stringify(body) });
    const readGameState = async (): Promise<GameBrowserStateV1> => {
      const response = await fetch(`${base}/game`, { headers: readHeaders });
      assert.equal(response.status, 200, "the live attachment is still readable after every refusal");
      return (await response.json()) as GameBrowserStateV1;
    };

    // Generation 1: the whole attach runs on the wire - activation, prerequisites, launch,
    // the cabin read and the confirmation that actually spawns the AI client, connects the
    // bridge and enters the runtime.
    await withWindowsPlatform(async () => {
      const activated = await fetch(`${base}/lifecycle/activate`, {
        method: "POST",
        headers: commandHeaders,
      });
      assert.equal(activated.status, 204);
      await publishSignedPlayerHostSession(
        fixture.runtimeRoot,
        "player-generation-1",
        availableCabins,
        Date.now() + 5 * 60_000,
      );
      assert.equal(
        (await post("/game/prerequisites/setup", { apiVersion: 1, idempotencyKey: wireIdempotencyKey("wire-setup") }))
          .status,
        204,
      );
      assert.equal(
        (
          await post("/game/launch", {
            apiVersion: 1,
            idempotencyKey: wireIdempotencyKey("wire-launch"),
            expectedInstanceGeneration: 1,
          })
        ).status,
        204,
      );
    });
    const cabins = await fetch(`${base}/game/stardew/cabins`, { headers: readHeaders });
    assert.equal(cabins.status, 200);
    const choices = (await cabins.json()) as Readonly<{ choices: readonly Readonly<{ choiceHandle: string }>[] }>;
    const confirmation = post("/game/stardew/cabins/confirm", {
      apiVersion: 1,
      idempotencyKey: wireIdempotencyKey("wire-confirm"),
      choiceHandle: choices.choices[0]!.choiceHandle,
      confirmed: true,
    });
    await publishAttachmentAdmission(
      fixture.runtimeRoot,
      await waitForAttachmentRequest(fixture.runtimeRoot),
      availableCabins[0]!,
    );
    assert.equal((await confirmation).status, 200);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });

    // The epoch advance is the product's own reconnect driven through the same wire, not a
    // fabricated number: the clean disconnect tears generation 1 down and the resume mints
    // generation 2 over the same registered world binding.
    assert.equal(
      (
        await post("/game/disconnect", {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("wire-disconnect"),
          expectedAttachmentGeneration: 1,
        })
      ).status,
      204,
    );
    const resumed = await post("/game/resume", {
      apiVersion: 1,
      idempotencyKey: wireIdempotencyKey("wire-resume"),
      expectedAttachmentGeneration: 2,
      gameSessionId: "session-abc",
    });
    assert.equal(resumed.status, 200);
    assert.deepEqual(await resumed.json(), { apiVersion: 1, status: "attached" });
    const liveAttachment = fixture.coordinator.attachmentReader.readAttachmentView();
    assert.deepEqual(liveAttachment, { status: "attached", generation: 2, connectionStatus: "connected_idle" });
    const liveState = await readGameState();
    assert.equal(liveState.game.attachment.generation, 2);
    assert.equal(liveState.game.connectionStatus, "connected_idle");
    assert.equal(liveState.game.actionAuthority, "paused");

    // Without these, the matrix below would be asserting against an epoch that a fresh
    // attachment never minted.
    const before = Object.freeze({
      stops: fixture.gameStopCalls.length,
      aiKills: [...fixture.aiKillCalls],
      playerKills: [...fixture.playerKillCalls],
      bridgeCloses: [...fixture.bridgeCloseCalls],
      bridgeConnects: fixture.bridgeConnectCalls.length,
      aiSpawns: fixture.spawnCalls.length,
      playerSpawns: fixture.playerSpawnCalls.length,
      enters: fixture.gameRuntimeFacadeEnterCalls(),
      ingresses: fixture.gameRuntimeIngressActivationCalls(),
      voiceStoppers: fixture.gameRuntimeVoiceStopperAttachCalls(),
      taskCancels: fixture.gameRuntimeTaskCancelCalls(),
      lifecycleOrder: [...fixture.lifecycleOrder],
    });
    assert.equal(before.bridgeConnects, 2);
    assert.equal(before.aiSpawns, 2);
    assert.equal(before.enters, 2);
    const registrationBefore = await readStardewInstallationRegistration(fixture.runtimeRoot);
    assert.notEqual(
      registrationBefore?.activeAttempt ?? null,
      null,
      "the live attempt is bound before the matrix runs",
    );

    // A controller issued against generation 1 now sends every mutation it can, on the same
    // authenticated browser session, over the same socket the live controller uses.
    const staleGeneration = 1 as const;
    const rows = Object.freeze([
      {
        name: "game.stop",
        path: "/game/stop",
        body: {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("stale-stop"),
          expectedAttachmentGeneration: staleGeneration,
        },
        status: 409,
        code: "game_attachment_conflict",
      },
      {
        name: "game.endgame",
        path: "/game/endgame",
        body: {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("stale-endgame"),
          expectedAttachmentGeneration: staleGeneration,
          confirm: true as const,
        },
        status: 409,
        code: "game_attachment_conflict",
      },
      {
        name: "game.disconnect",
        path: "/game/disconnect",
        body: {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("stale-disconnect"),
          expectedAttachmentGeneration: staleGeneration,
        },
        status: 409,
        code: "game_attachment_conflict",
      },
      {
        name: "game.reopen",
        path: "/game/reopen",
        body: {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("stale-reopen"),
          expectedAttachmentGeneration: staleGeneration,
        },
        status: 409,
        code: "game_attachment_conflict",
      },
      {
        // Not the epoch's own word: a live healthy attachment is refused before the
        // generation is even read, so the code names the fact that decides it. What the
        // row proves is that no reconnect was started on top of the live one.
        name: "game.resume",
        path: "/game/resume",
        body: {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("stale-resume"),
          expectedAttachmentGeneration: staleGeneration,
          gameSessionId: "session-abc",
        },
        status: 409,
        code: "game_runtime_unavailable",
      },
      {
        // No in-flight reconnect exists under this identity, so the cancel has nothing it
        // may terminate.
        name: "game.resume.cancel",
        path: "/game/resume/cancel",
        body: {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("stale-cancel"),
          expectedAttachmentGeneration: staleGeneration,
        },
        status: 409,
        code: "game_unavailable",
      },
      {
        // The absent route, read as absent: `game_browser_api/v1` publishes no action
        // operation, so there is no stale-epoch action request a browser can send.
        name: "game.action (not a declared operation)",
        path: "/game/action",
        body: {
          apiVersion: 1,
          idempotencyKey: wireIdempotencyKey("stale-action"),
          expectedAttachmentGeneration: staleGeneration,
        },
        status: 404,
        code: "not_found",
      },
    ]);

    // Every row is sent and its answer collected FIRST, so a guard that stops answering names
    // the row that drifted instead of hiding the rest behind the first failure.
    const refusals: string[] = [];
    for (const row of rows) {
      const response = await post(row.path, row.body);
      // The problem DTO is read as text first, so a request that was ACCEPTED instead of
      // refused (or answered with an empty body) names its own row in the diff below
      // rather than throwing out of the collector and hiding which verb drifted.
      const body = await response.text();
      let code: string;
      try {
        const parsed = JSON.parse(body) as { code?: unknown };
        code = typeof parsed.code === "string" ? parsed.code : `<no code: ${body}>`;
      } catch {
        code = `<unparsed ${body.length}-byte body>`;
      }
      refusals.push(`${row.name}: ${response.status} ${code}`);
    }
    assert.deepEqual(
      refusals,
      rows.map((row) => `${row.name}: ${row.status} ${row.code}`),
      "every stale-epoch request is refused by name on the real wire",
    );

    for (const row of rows) {
      const detail = `${row.name} had a side effect on the live epoch`;
      // Re-read the live attachment after EVERY row: a refusal that also moved the epoch or
      // the action authority would otherwise pass on the refusal alone.
      assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), liveAttachment, detail);
      assert.deepEqual(
        fixture.coordinator.actionAuthorityReader.readActionAuthorityView(),
        { status: "paused" },
        detail,
      );
      const state = await readGameState();
      assert.equal(state.game.attachment.generation, 2, detail);
      assert.equal(state.game.connectionStatus, "connected_idle", detail);
      assert.equal(state.game.actionAuthority, "paused", detail);
      assert.equal(fixture.gameStopCalls.length, before.stops, detail);
      assert.deepEqual(fixture.aiKillCalls, before.aiKills, detail);
      assert.deepEqual(fixture.playerKillCalls, before.playerKills, detail);
      assert.deepEqual(fixture.bridgeCloseCalls, before.bridgeCloses, detail);
      assert.equal(fixture.bridgeConnectCalls.length, before.bridgeConnects, detail);
      assert.equal(fixture.spawnCalls.length, before.aiSpawns, detail);
      assert.equal(fixture.playerSpawnCalls.length, before.playerSpawns, detail);
      assert.equal(fixture.gameRuntimeFacadeEnterCalls(), before.enters, detail);
      assert.equal(fixture.gameRuntimeIngressActivationCalls(), before.ingresses, detail);
      assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), before.voiceStoppers, detail);
      assert.equal(fixture.gameRuntimeTaskCancelCalls(), before.taskCancels, detail);
      assert.deepEqual(fixture.lifecycleOrder, before.lifecycleOrder, detail);
      // Containment/settlement is how a stale endgame would really end the live world.
      assert.deepEqual(containmentCalls, [], `${detail} (contained-runtime containment/settle)`);
      // The durable half: no store write was reached by a refused request.
      assert.deepEqual(durableStoreCalls, [], `${detail} (durable store write)`);
      assert.deepEqual(
        await readStardewInstallationRegistration(fixture.runtimeRoot),
        registrationBefore,
        `${detail} (the bound attempt pointer endgame releases)`,
      );
    }

    // The last reading: the same route, the same session, the same socket - only the epoch
    // differs. A stale epoch was refused; the live one reopens what the resume paused.
    const reopened = await post("/game/reopen", {
      apiVersion: 1,
      idempotencyKey: wireIdempotencyKey("live-reopen"),
      expectedAttachmentGeneration: 2,
    });
    assert.equal(reopened.status, 200);
    assert.deepEqual(await reopened.json(), { apiVersion: 1, status: "reopened" });
    const afterReopen = await readGameState();
    assert.equal(afterReopen.game.attachment.generation, 2);
    assert.equal(afterReopen.game.actionAuthority, "active");
    assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), registrationBefore);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: every resume mints a fresh generation — consecutive resume cycles each truly attach", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
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
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
    // Cycle 1: disconnect, then resume -> genuinely attached at generation 2.
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "cycle1-disconnect",
      expectedAttachmentGeneration: 1,
    });
    const firstResume = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "cycle1-resume",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(firstResume, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
    // Cycle 2: the per-activation machine arms a THIRD launch generation; the
    // second resume never reuses the first resume's connection/callback/lease.
    // The coordinator attachment generation is per-attachment (restarts at >= 2
    // after a full teardown), while the underlying AI launch/bridge generations
    // strictly increase and prove the fresh mint.
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "cycle2-disconnect",
      expectedAttachmentGeneration: 2,
    });
    const secondResume = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "cycle2-resume",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(secondResume, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // Producer -> consumer -> verifier across both cycles: exactly three
    // native AI spawns and three bridge connects, each with its own generation
    // (never reused), and every ended AI was stopped before the next
    // activation; the old task was never replayed.
    assert.deepEqual(fixture.aiKillCalls, [4101, 4101]);
    assert.deepEqual(
      fixture.spawnCalls.map((call) => call.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION),
      ["ai-generation-1", "ai-generation-2", "ai-generation-3"],
    );
    assert.deepEqual(
      fixture.bridgeConnectCalls.map((call) => call.launchGeneration),
      ["ai-generation-1", "ai-generation-2", "ai-generation-3"],
    );
    assert.equal(new Set(fixture.bridgeConnectCalls.map((call) => call.launchGeneration)).size, 3);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 3);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 3);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 3);
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge", "bridge"]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("slice 2: a failed fresh resume launch is abandoned and the next resume truly attaches with a newer generation", async () => {
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
    },
  });
  try {
    await confirmFirstCabin(fixture);
    await fixture.coordinator.activationOwner.disconnectGame(fixture.broker.issue("game_disconnect"), {
      apiVersion: 1,
      idempotencyKey: "retry-disconnect",
      expectedAttachmentGeneration: 1,
    });
    // The fresh resume launch itself fails (second spawn attempt): the attempt
    // fails closed and abandons the armed activation so a later resume can
    // prepare a new generation again.
    await assert.rejects(
      fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
        apiVersion: 1,
        gameSessionId: "session-abc",
        idempotencyKey: "retry-resume-1",
        expectedAttachmentGeneration: 2,
      }),
      /controlled-ai-spawn-failure/,
    );
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "failed",
    });
    assert.equal(fixture.bridgeConnectCalls.length, 1);
    // The retry arms yet another generation and genuinely attaches.
    const retried = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "retry-resume-2",
      expectedAttachmentGeneration: 3,
    });
    assert.deepEqual(retried, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 3,
      connectionStatus: "connected_idle",
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    // Producer -> consumer -> verifier: spawns #1 (initial) and #3 (retry)
    // are the only live AI launches; the failed #2 never connected, and the
    // retry consumed a fresh generation (ai-generation-3), never the failed
    // attempt's generation 2.
    assert.equal(fixture.spawnCalls.length, 3);
    assert.equal(fixture.spawnCalls[2]!.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-3");
    assert.deepEqual(
      fixture.bridgeConnectCalls.map((call) => call.launchGeneration),
      ["ai-generation-1", "ai-generation-3"],
    );
    assert.deepEqual(fixture.aiKillCalls, [4101]);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
