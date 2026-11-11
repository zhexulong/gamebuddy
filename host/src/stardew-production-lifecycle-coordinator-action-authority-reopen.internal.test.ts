import {
  createFixture,
  prepareCabinCoordinator,
  confirmFirstCabin,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import { GameBrowserValidatorsV1 } from "./game-browser-contract/index.js";

installLifecycleTestHooks();

// ─── Slice 2C: coordinator action-authority reopen seam ─────────────────────

test("reopenActionAuthority reopens a paused authority to active over the same attachment without touching old task/facade/lease", async () => {
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
    // Producer: a fresh resume admits the paused authority (generation 2).
    const resumed = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(resumed, { apiVersion: 1, status: "accepted" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "reconnecting",
    });
    // Consumer: the new explicit Game instruction reopens the authority to
    // active on the SAME attachment; no old task, facade, lease, or
    // attachment work happens and no generation is minted.
    const result = await fixture.coordinator.activationOwner.reopenActionAuthority(
      fixture.broker.issue("game_reopen"),
      { apiVersion: 1, idempotencyKey: "BCEiM0RVZneImaq7zN3u_w", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "reopened" });
    assert.equal(GameBrowserValidatorsV1.GameReopenActionAuthorityResultV1Schema.Check(result), true);
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    // Verifier: attachment stays on the resumed generation, and no native,
    // facade, or task machinery was invoked by the reopen.
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "reconnecting",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    assert.deepEqual(fixture.bridgeConnectCalls, []);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 0);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 0);
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 0);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reopenActionAuthority fails closed while the authority is already active", async () => {
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
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 1,
        }),
      /stardew_game_action_authority_not_paused/,
    );
    // State unchanged: still active, same attachment generation, no native work.
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
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

test("reopenActionAuthority fails closed while the authority is unavailable", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 1,
        }),
      /stardew_game_action_authority_not_paused/,
    );
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

test("reopenActionAuthority replays a duplicate idempotency key with the same result and rejects a changed tuple", async () => {
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
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    const command = {
      apiVersion: 1 as const,
      idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      expectedAttachmentGeneration: 2,
    };
    const first = fixture.coordinator.activationOwner.reopenActionAuthority(
      fixture.broker.issue("game_reopen"),
      command,
    );
    const replay = fixture.coordinator.activationOwner.reopenActionAuthority(
      fixture.broker.issue("game_reopen"),
      command,
    );
    assert.equal(replay, first);
    assert.deepEqual(await first, { apiVersion: 1, status: "reopened" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    // A changed tuple under the same idempotency key fails closed.
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 3,
        }),
      /stardew_game_reopen_idempotency_conflict/,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("reopenActionAuthority fails closed on a stale attachment generation without changing the authority", async () => {
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
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    assert.throws(
      () =>
        fixture.coordinator.activationOwner.reopenActionAuthority(fixture.broker.issue("game_reopen"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedAttachmentGeneration: 1,
        }),
      /stardew_game_attachment_generation_conflict/,
    );
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
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

test("reopenActionAuthority stays paused after teardown, then reopens the fresh resumed authority", async () => {
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
      idempotencyKey: "slice2c-teardown",
      expectedAttachmentGeneration: 1,
    });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "unavailable" });
    const resumed = await fixture.coordinator.activationOwner.resume(fixture.broker.issue("game_resume"), {
      apiVersion: 1,
      gameSessionId: "session-abc",
      idempotencyKey: "slice2c-resume",
      expectedAttachmentGeneration: 2,
    });
    assert.deepEqual(resumed, { apiVersion: 1, status: "attached" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "paused" });
    const result = await fixture.coordinator.activationOwner.reopenActionAuthority(
      fixture.broker.issue("game_reopen"),
      { apiVersion: 1, idempotencyKey: "slice2c-reopen", expectedAttachmentGeneration: 2 },
    );
    assert.deepEqual(result, { apiVersion: 1, status: "reopened" });
    assert.deepEqual(fixture.coordinator.actionAuthorityReader.readActionAuthorityView(), { status: "active" });
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 2,
      connectionStatus: "connected_idle",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
