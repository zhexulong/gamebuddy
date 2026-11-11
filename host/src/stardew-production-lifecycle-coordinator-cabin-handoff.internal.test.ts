import {
  gameDirectoryCandidate,
  withWindowsPlatform,
  createFixture,
  publishSignedPlayerHostSession,
  waitForAttachmentRequest,
  publishAttachmentAdmission,
  attachmentRequestId,
  availableCabins,
  prepareCabinCoordinator,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

installLifecycleTestHooks();

test("a live host advertisement with no usable cabin is a named failure, never an empty choice list", async () => {
  // The world a Player Host creates must contain a Cabin for the single
  // companion it exists for, and this is the only place the browser learns that
  // it does not: an advertisement that is live, ready and generation-correlated
  // but offers no cabin this companion may use. Returning `choices: []` there was
  // indistinguishable from "cabins are still coming" and stalled the chain with
  // no product-visible reason.
  const fixture = await createFixture();
  try {
    await withWindowsPlatform(async () => {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await publishSignedPlayerHostSession(fixture.runtimeRoot, "player-generation-1", [], Date.now() + 5 * 60_000);
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
    });
    assert.equal(
      fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
      "awaiting_player_host_attestation",
    );
    await assert.rejects(
      () => fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read")),
      /stardew_player_host_cabin_unavailable/,
    );
    // The gate held: no cabin handoff was confirmable, so the AI client's one-shot
    // launch reservation was never consumed and nothing was spawned.
    assert.deepEqual(fixture.spawnCalls, []);
    assert.equal(await attachmentRequestId(fixture.runtimeRoot), null);
    assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).aiClient, {
      state: "not_started",
      ownership: "none",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("dynamic cabin handoff admits one manifest and launches the exact owned AI client", async () => {
  const startedAt = Date.now();
  const fixture = await prepareCabinCoordinator(startedAt + 5 * 60_000, {
    gameRuntimeBindingCloseResults: [false, true],
  });
  try {
    const readStartedAt = Date.now();
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const readCompletedAt = Date.now();
    assert.equal(choices.apiVersion, 1);
    assert.deepEqual(
      choices.choices.map((choice) => choice.displayLabel),
      ["Cabin 1", "Cabin 2"],
    );
    assert.equal(new Set(choices.choices.map((choice) => choice.choiceHandle)).size, 2);
    for (const choice of choices.choices) {
      assert.match(choice.choiceHandle, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(choice.availability, "available");
      assert.ok(choice.expiresAtMs <= readCompletedAt + 60_000);
      assert.ok(choice.expiresAtMs >= readStartedAt + 59_000);
      assert.deepEqual(Object.keys(choice).sort(), ["availability", "choiceHandle", "displayLabel", "expiresAtMs"]);
    }
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "confirm-key-alpha",
      confirmed: true as const,
    };
    const first = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const joined = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    assert.equal(joined, first);
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    assert.equal(request.cabinId, "cabin-alpha");
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await first, { apiVersion: 1, status: "manifest_admitted" });
    assert.deepEqual(
      await fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      {
        apiVersion: 1,
        status: "manifest_admitted",
      },
    );
    assert.equal(fixture.spawnCalls.length, 1);
    const aiSpawn = fixture.spawnCalls[0]!;
    assert.equal(aiSpawn.executable, `${gameDirectoryCandidate}\\StardewModdingAPI.exe`);
    assert.deepEqual(aiSpawn.args, [
      "--mods-path",
      join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "ai-client", "Mods"),
    ]);
    assert.equal(aiSpawn.options.cwd, gameDirectoryCandidate);
    assert.equal(aiSpawn.options.shell, false);
    assert.equal(aiSpawn.options.windowsHide, true);
    assert.equal(aiSpawn.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "ai-generation-1");
    assert.equal(fixture.playerSpawnCalls.length, 1);
    assert.equal(fixture.packageReadCount(), 4);
    assert.equal(fixture.bridgeConnectCalls.length, 1);
    const bridgeConnection = fixture.bridgeConnectCalls[0]!;
    assert.deepEqual(bridgeConnection.scope, {
      integrationId: "stardew",
      saveId: "save-coordinator",
      worldId: "world-coordinator",
      playerId: "101",
      companionId: "companion-1",
    });
    assert.equal(bridgeConnection.pipeName, "gamebuddy-stardew-coordinator-bridge");
    assert.equal(bridgeConnection.token, "coordinator-bridge-token-0123456789");
    assert.equal(bridgeConnection.launchGeneration, "ai-generation-1");
    assert.equal(bridgeConnection.deadlineMs, choices.choices[0]!.expiresAtMs);
    assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).aiClient, {
      state: "awaiting_attestation",
      ownership: "gamebuddy_direct_spawn",
      lastStopOutcome: "none",
    });
    assert.equal(
      fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
      "awaiting_player_host_attestation",
    );
    const transaction = join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1");
    const aiConfig = JSON.parse(
      await readFile(join(transaction, "ai-client", "Mods", "GameBuddy", "config.json"), "utf8"),
    );
    assert.equal(aiConfig.FarmhandProvisioner.Enable, true);
    assert.equal(
      aiConfig.FarmhandProvisioner.ManifestPath,
      join(transaction, "session", "stardew-farmhand-manifest.json"),
    );
    assert.equal("Pid" in aiConfig.FarmhandProvisioner, false);
    assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
    assert.equal(fixture.gameRuntimeVoiceStopperAttachCalls(), 1);
    assert.equal(fixture.gameRuntimeIngressActivationCalls(), 1);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "connected_idle",
    });
    await assert.rejects(fixture.coordinator.close(), /stardew_lifecycle_close_incomplete/);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentView(), {
      status: "attached",
      generation: 1,
      connectionStatus: "failed",
    });
    assert.equal(fixture.gameRuntimeTaskCancelCalls(), 1);
    assert.deepEqual(fixture.bridgeCloseCalls, []);
    assert.deepEqual(fixture.aiKillCalls, []);
    assert.deepEqual(fixture.playerKillCalls, []);
    await fixture.coordinator.close();
    assert.deepEqual(fixture.bridgeCloseCalls, ["bridge"]);
    assert.deepEqual(fixture.aiKillCalls, [4101]);
    assert.deepEqual(fixture.playerKillCalls, []);
    assert.deepEqual(fixture.lifecycleOrder, ["bridge", "ai"]);
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
