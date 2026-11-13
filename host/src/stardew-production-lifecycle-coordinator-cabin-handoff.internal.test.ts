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
  canonicalTemporaryRoot,
  temporaryRoots,
  identityChainFor,
  ownerRecord,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import { stardewFarmhandJoinBudgetMs } from "./stardew-production-lifecycle-coordinator.internal.js";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
      // The published deadline is the join budget for the world this fixture launched: its
      // installation folder is not a real directory, so the Player Host carried no player Mod.
      const joinBudgetMs = stardewFarmhandJoinBudgetMs(0);
      assert.ok(choice.expiresAtMs <= readCompletedAt + joinBudgetMs);
      assert.ok(choice.expiresAtMs >= readStartedAt + joinBudgetMs);
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

/**
 * The join wait used to be `Date.now() + 60_000` whatever world it was waiting for, which is less than the 60 s
 * role-launch budget the coordinator hands the Player Host on its own: a healthy launch with a real Mod pack was
 * reported as an expired one. The measurement here is the deadline the read actually publishes, taken twice over the
 * same fixture machinery with only the player's Mod count differing - so the difference between the two readings can
 * only come from the world the companion joins.
 */
test("the Farmhand join wait is sized by the player Mods the world carries", async () => {
  const joinBudgetMods = 40;
  const measure = async (installMods: number) => {
    const parent = await canonicalTemporaryRoot("gamebuddy-join-budget-");
    temporaryRoots.push(parent);
    const installRoot = join(parent, "Stardew Valley");
    await mkdir(join(installRoot, "Mods"), { recursive: true });
    await writeFile(join(installRoot, "Stardew Valley.exe"), "", "utf8");
    await writeFile(join(installRoot, "StardewModdingAPI.exe"), "", "utf8");
    for (let index = 0; index < installMods; index += 1) {
      const mod = join(installRoot, "Mods", `Player Mod ${index}`);
      await mkdir(mod);
      await writeFile(join(mod, "manifest.json"), "{}", "utf8");
    }
    const chain = identityChainFor(installRoot);
    const fixture = await prepareCabinCoordinator(Date.now() + 10 * 60_000, {
      boundInstallation: { installRoot, smapi: true },
      inspectorChains: [chain, chain, chain, chain, chain, chain],
      overrides: { selectStardewFolder: async () => ({ status: "selected" as const, path: installRoot }) },
    });
    try {
      const startedAtMs = Date.now();
      const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
      const completedAtMs = Date.now();
      // The launch's own `--mods-path` root: what the Player Host really carried is the count the
      // deadline is derived from, so the two readings below come from the same fact.
      const profileModsRoot = fixture.playerSpawnCalls[0]!.args[1]!;
      const carriedModCount = (await readdir(profileModsRoot)).filter((entry) => entry !== "GameBuddy").length;
      return { deadlineMs: choices.choices[0]!.expiresAtMs, startedAtMs, completedAtMs, carriedModCount };
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  };
  await withWindowsPlatform(async () => {
    const vanilla = await measure(0);
    const modded = await measure(joinBudgetMods);
    assert.equal(vanilla.carriedModCount, 0);
    assert.equal(modded.carriedModCount, joinBudgetMods);
    for (const [measurement, playerMods] of [
      [vanilla, 0],
      [modded, joinBudgetMods],
    ] as const) {
      const joinBudgetMs = stardewFarmhandJoinBudgetMs(playerMods);
      assert.ok(
        measurement.deadlineMs - measurement.startedAtMs >= joinBudgetMs,
        `${measurement.deadlineMs - measurement.startedAtMs}ms is inside the ${joinBudgetMs}ms budget for ${playerMods} player Mods`,
      );
      assert.ok(
        measurement.deadlineMs - measurement.completedAtMs <= joinBudgetMs,
        `${measurement.deadlineMs - measurement.completedAtMs}ms exceeds the ${joinBudgetMs}ms budget for ${playerMods} player Mods`,
      );
    }
  });
});

/**
 * The defect this exists for: the join deadline expiring quarantined the exact owner - the durable terminal that
 * refuses every later open, recovery and ordinary close - even though nothing about the attempt was proven bad. The
 * AI client is running, the core restores the owner's connection state on that path, and the world is the player's.
 *
 * A slow machine is not a broken one, so the expiry must name what it waited for and leave the session closable.
 */
test("an expired Farmhand join names the wait and leaves the player's session recoverable", async () => {
  const realDateNow = Date.now;
  let attempts = 0;
  let skewMs = 0;
  const transientPipeNotReady = Object.assign(new Error("controlled_pipe_not_ready"), { code: "ENOENT" });
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
    overrides: {
      connectFarmhandGameRuntimeFacade: async () => {
        attempts += 1;
        // The AI client is up and its pipe never answers. Skewing past the deadline the read published
        // expires the retry wait immediately instead of letting this test sleep out the whole budget.
        if (attempts === 1) Date.now = () => realDateNow() + skewMs;
        throw transientPipeNotReady;
      },
    },
  });
  try {
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    skewMs = choices.choices[0]!.expiresAtMs - realDateNow() + 1_000;
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "expired-join-key",
      confirmed: true as const,
    };
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    await assert.rejects(confirmation, /stardew_farmhand_join_deadline_exceeded/);
    Date.now = realDateNow;
    assert.equal(attempts, 1);
    assert.equal(fixture.spawnCalls.length, 1);
    // The attempt is slow, not bad: the durable owner record is still the live one, so the ordinary
    // close below - not a quarantine - is what ends it, and the player's world is never touched.
    assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "reserved");
    // The admitted manifest is still not re-published by a replay of the key that admitted it.
    assert.throws(
      () => fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /stardew_cabin_publication_uncertain/,
    );
    assert.equal(attempts, 1);
    await fixture.coordinator.close();
    assert.deepEqual(fixture.aiKillCalls, [4101]);
  } finally {
    Date.now = realDateNow;
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
