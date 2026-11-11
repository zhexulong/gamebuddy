import {
  withWindowsPlatform,
  createFixture,
  ownerRecord,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import { createStardewProductionLifecycleCoordinator } from "./stardew-production-lifecycle-coordinator.internal.js";
import type { SemanticGameProductionAuthority } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";

installLifecycleTestHooks();

test("ordinary close preserves the Player Host and never invokes its explicit stop", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner
        .setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        })
        .then(() =>
          fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
            expectedInstanceGeneration: 1,
          }),
        );
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("ordinary close does not retry or terminate the Player Host", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({ playerKillResults: [false, true] });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner
        .setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        })
        .then(() =>
          fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
            apiVersion: 1,
            idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
            expectedInstanceGeneration: 1,
          }),
        );
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      await fixture.coordinator.close();
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Stage B failure transitions to failed, durably quarantines, and never spawns", async () => {
  const fixture = await createFixture({ failStaging: true });
  try {
    await assert.rejects(
      fixture.coordinator.activationOwner.activate(fixture.broker.issue()),
      /stardew_lifecycle_activation_failed/,
    );
    assert.deepEqual(fixture.coordinator.activationOwner.readPrivateActivationSnapshot(), {
      schemaVersion: 1,
      requestId: "request-1",
      authorityGeneration: 1,
      revision: 3,
      state: "failed",
    });
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    const owner = await ownerRecord(fixture.runtimeRoot);
    assert.equal(owner.state, "quarantined");
    assert.equal(owner.cleanupDisposition, "retry_required");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("close during controlled staging drains, quarantines, terminalizes, and closes without spawning", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createFixture({ stagingGate: gate });
  try {
    const activation = fixture.coordinator.activationOwner.activate(fixture.broker.issue());
    while (fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state !== "staging") {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const close = fixture.coordinator.close();
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closing");
    release();
    await assert.rejects(activation, /stardew_lifecycle_activation_failed/);
    await close;
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closed");
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
  } finally {
    release();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("aggregate close attempts every role and retry skips successful cleanup proofs", async () => {
  let brokerAttempts = 0;
  let aiAttempts = 0;
  let playerAttempts = 0;
  const fixture = await createFixture({
    overrides: {
      closeBroker(underlying) {
        brokerAttempts += 1;
        if (brokerAttempts === 1) throw new Error("controlled-broker-close-failure");
        underlying();
      },
      stopAiClient(underlying) {
        aiAttempts += 1;
        if (aiAttempts === 1) throw new Error("controlled-ai-stop-failure");
        return underlying();
      },
      stopPlayerHost(underlying) {
        playerAttempts += 1;
        return underlying();
      },
    },
  });
  try {
    await assert.rejects(fixture.coordinator.close(), /stardew_lifecycle_close_incomplete/);
    assert.deepEqual(
      { brokerAttempts, aiAttempts, playerAttempts },
      { brokerAttempts: 1, aiAttempts: 1, playerAttempts: 0 },
    );
    await fixture.coordinator.close();
    assert.deepEqual(
      { brokerAttempts, aiAttempts, playerAttempts },
      { brokerAttempts: 2, aiAttempts: 2, playerAttempts: 0 },
    );
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "closed");
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("production lifecycle construction is fail-closed off Windows", async () => {
  const manifest: HostDeploymentManifest = Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: process.cwd(),
    principal: Object.freeze({ continuityId: "continuity-1", playerId: "player-1", companionId: "companion-1" }),
    bootstrapOperationId: "request-1",
    authorityGeneration: 1,
  });
  if (process.platform !== "win32") {
    await assert.rejects(
      () =>
        Promise.resolve(
          createStardewProductionLifecycleCoordinator(
            manifest,
            () => null,
            undefined as unknown as SemanticGameProductionAuthority,
          ),
        ),
      /stardew_private_bootstrap_composition_requires_windows/,
    );
  }
});
