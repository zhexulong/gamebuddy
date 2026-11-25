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
  confirmFirstCabin,
  installLifecycleTestHooks,
  canonicalTemporaryRoot,
  temporaryRoots,
  identityChainFor,
  ownerRecord,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import {
  STARDEW_CABIN_PRESS_WINDOW_MS,
  STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
  STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS,
  stardewFarmhandJoinBudgetMs,
} from "./stardew-production-lifecycle-coordinator.internal.js";
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
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "player_host_attested");
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
      // The published deadline is the press window: how long a person may take over this offer. It is not
      // the join budget (the attach's own wait, which this fixture's advertisement used to be the smaller
      // term of by accident) and not the advertisement's lease.
      assert.ok(choice.expiresAtMs <= readCompletedAt + STARDEW_CABIN_PRESS_WINDOW_MS);
      assert.ok(choice.expiresAtMs >= readStartedAt + STARDEW_CABIN_PRESS_WINDOW_MS);
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
    // The choice's deadline is the JOIN wait (the retry loop keeps it); the attempt
    // itself may spend at most the connect budget, so one hung pipe no longer owns
    // the join the player's Mods bought.
    assert.ok(
      bridgeConnection.deadlineMs < choices.choices[0]!.expiresAtMs,
      "the connect must own its own budget, not the whole join",
    );
    assert.ok(
      bridgeConnection.deadlineMs >= readCompletedAt + STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
      "the connect must get its whole budget, not less",
    );
    assert.ok(
      bridgeConnection.deadlineMs <= Date.now() + STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
      "the connect must not be granted more than its budget",
    );
    assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).aiClient, {
      state: "awaiting_attestation",
      ownership: "gamebuddy_direct_spawn",
      lastStopOutcome: "none",
    });
    assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "player_host_attested");
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
    // Nothing is attached, so nothing names a cabin: the word cannot outlive the binding it was published with.
    assert.equal(fixture.coordinator.attachmentReader.readAttachmentCabinView?.(), null);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * THE CABIN SHE MOVED INTO IS A FACT THE HOST PUBLISHES WITH THE BINDING, not a label the page that pressed the
 * confirm keeps for itself.
 *
 * The Mod's document names each cabin by identity (`cabins[].cabinId`, written from `cabin.NameOrUniqueName`) and
 * carries no label at all (`FarmhandProvisioningFact` has id, owner, bound companion, busy), so the word is this
 * layer's rendering of the cabin's position in the Mod's own list - and it travels with the identity it was rendered
 * for. A page opened afterwards reads both from the attachment and can name her cabin; before this, only the page that
 * pressed the confirm knew it (`.tmp/lane-copyreach.md` §1).
 */
test("the attachment publishes the cabin her confirmation bound, by the Mod's identity and the word it carried", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000);
  try {
    await confirmFirstCabin(fixture);
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentCabinView?.(), {
      cabinId: "cabin-alpha",
      label: "Cabin 1",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The word is the cabin's place in the MOD'S OWN list, never its slot among the cabins this companion may use.
 *
 * In this world the first cabin is already another companion's, so the offer list this companion may confirm starts
 * at the second one. Numbering the offers made that cabin "Cabin 1" — the same word the first cabin carried in the
 * previous world state, and the reason a stale word could not be told apart from a real one. The binding publishes the
 * identity it actually bound with the word for that identity, so a world where her cabin moved gives a different pair
 * rather than the old word over a new cabin.
 */
test("the bound cabin's word follows its identity, not its slot among the offers", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000);
  try {
    // Cabin 1 belongs to another companion; cabin 2 is hers. Everything else (busy, foreign) is filtered from the
    // offers, and the world's own order is what the words are rendered from.
    await publishSignedPlayerHostSession(
      fixture.runtimeRoot,
      "player-generation-1",
      [
        { cabinId: "cabin-alpha", ownerFarmhandId: "101", boundCompanionId: "other-companion", isBusy: false },
        { cabinId: "cabin-beta", ownerFarmhandId: "202", boundCompanionId: "companion-1", isBusy: false },
        { cabinId: "cabin-busy", ownerFarmhandId: "303", boundCompanionId: "", isBusy: true },
      ],
      Date.now() + 5 * 60_000,
    );
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    assert.deepEqual(
      choices.choices.map((choice) => choice.displayLabel),
      ["Cabin 2"],
      "her cabin is the world's second cabin, and the offer may not renumber it to fit the list",
    );
    const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
      apiVersion: 1,
      choiceHandle: choices.choices[0]!.choiceHandle,
      idempotencyKey: "confirm-second-cabin-key",
      confirmed: true,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[1]!);
    await confirmation;
    assert.deepEqual(fixture.coordinator.attachmentReader.readAttachmentCabinView?.(), {
      cabinId: "cabin-beta",
      label: "Cabin 2",
    });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The join wait used to be `Date.now() + 60_000` whatever world it was waiting for, which is less than the 60 s
 * role-launch budget the coordinator hands the Player Host on its own: a healthy launch with a real Mod pack was
 * reported as an expired one. The measurement here is the HORIZON the press's retry loop really honours, read as the
 * same clock skew - `STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS` plus five seconds - applied to two worlds that differ only
 * in the player Mods they carry: the vanilla press has expired there, the modded one is still retrying. A horizon
 * without the mod term makes both worlds expire, and a flat horizon wider than the base makes neither.
 */
test("the Farmhand join wait is sized by the player Mods the world carries", async () => {
  const joinBudgetMods = 40;
  const pastTheVanillaHorizonMs = STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS + 5_000;
  // Well past the largest horizon this test builds - the modded world's - and still inside the attempt's own
  // ten-minute deadline, so the expiry it produces is the join's and not the owner's.
  const pastEveryJoinHorizonMs = stardewFarmhandJoinBudgetMs(joinBudgetMods) + 60_000;
  const transientPipeNotReady = Object.assign(new Error("controlled_pipe_not_ready"), { code: "ENOENT" });
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
    const realDateNow = Date.now;
    let attempts = 0;
    let skewMs = pastTheVanillaHorizonMs;
    const fixture = await prepareCabinCoordinator(Date.now() + 10 * 60_000, {
      boundInstallation: { installRoot, smapi: true },
      inspectorChains: [chain, chain, chain, chain, chain, chain],
      overrides: {
        selectStardewFolder: async () => ({ status: "selected" as const, path: installRoot }),
        // The AI client is up and its pipe never answers. The skew starts here, so every read before the press's
        // retry loop - the offer's, the manifest's - sees the real clock, and the loop's own deadline reads are the
        // only ones moved.
        connectFarmhandGameRuntimeFacade: async () => {
          attempts += 1;
          Date.now = () => realDateNow() + skewMs;
          throw transientPipeNotReady;
        },
      },
    });
    try {
      // The launch's own `--mods-path` root: what the Player Host really carried is the count this world's horizon
      // is meant to be derived from, so both readings come from the same fact.
      const profileModsRoot = fixture.playerSpawnCalls[0]!.args[1]!;
      const carriedModCount = (await readdir(profileModsRoot)).filter((entry) => entry !== "GameBuddy").length;
      const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
      const confirmation = fixture.coordinator.activationOwner.confirmCabinChoice(
        fixture.broker.issue("cabin_confirm"),
        {
          apiVersion: 1,
          choiceHandle: choices.choices[0]!.choiceHandle,
          idempotencyKey: `join-horizon-${installMods}`,
          confirmed: true,
        },
      );
      let expired = false;
      void confirmation.then(
        () => undefined,
        () => {
          expired = true;
        },
      );
      const request = await waitForAttachmentRequest(fixture.runtimeRoot);
      await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
      // Let the loop reach the skew: an expired join settles on its first attempt, a live one keeps retrying.
      const observationDeadline = realDateNow() + 2_000;
      while (!expired && attempts < 2 && realDateNow() < observationDeadline)
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
      const expiredAtTheVanillaHorizon = expired;
      const attemptsAtTheVanillaHorizon = attempts;
      skewMs = pastEveryJoinHorizonMs;
      await assert.rejects(confirmation, /stardew_farmhand_join_deadline_exceeded/);
      return { carriedModCount, expiredAtTheVanillaHorizon, attemptsAtTheVanillaHorizon };
    } finally {
      Date.now = realDateNow;
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  };
  await withWindowsPlatform(async () => {
    const vanilla = await measure(0);
    const modded = await measure(joinBudgetMods);
    assert.equal(vanilla.carriedModCount, 0);
    assert.equal(modded.carriedModCount, joinBudgetMods);
    assert.equal(
      vanilla.expiredAtTheVanillaHorizon,
      true,
      `a press given no player Mods was still retrying ${pastTheVanillaHorizonMs}ms in, which is past the horizon its world buys`,
    );
    assert.equal(
      modded.expiredAtTheVanillaHorizon,
      false,
      `the press in a world of ${modded.carriedModCount} player Mods expired ${pastTheVanillaHorizonMs}ms in: the wait did not carry the world's own workload`,
    );
    assert.ok(
      modded.attemptsAtTheVanillaHorizon >= 2,
      `the modded press made ${modded.attemptsAtTheVanillaHorizon} attempt(s) inside a budget its world's ${modded.carriedModCount} player Mods bought`,
    );
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
    // Past the join budget this press's attach is granted, so the retry wait expires immediately instead of the test
    // sleeping the whole budget out. It is no longer read off the offer's deadline: the offer is the human's press
    // window, and an attempt's budget is its own number.
    skewMs = stardewFarmhandJoinBudgetMs(0) + 1_000;
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

test("the cabin press's connect is granted its own budget, never what the offer has left", async () => {
  // The advertisement this fixture publishes is the Mod's real shape: a ~3 s lease (measured live in
  // `.live-runs/gc1/w-game-launch.txt`, windows of 2697..2936 ms). The offer the browser is given is the
  // press window instead - a person's deadline - and the attach that follows the press has its own budget.
  // Handing the offer's remaining life to the bridge connect made the attempt's deadline a leftover - the
  // manifest admission, the profile materialization and the AI-client launch all happen between the two - so
  // one attempt was granted a deadline that had already passed and failed as
  // `bridge_connect_deadline_exceeded`. What is asserted here is the deadline the connect RECEIVED.
  const fixture = await prepareCabinCoordinator(Date.now() + 3_000);
  try {
    const readCompletedAt = Date.now();
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const choice = choices.choices[0]!;
    assert.ok(
      choice.expiresAtMs >= readCompletedAt + STARDEW_CABIN_PRESS_WINDOW_MS,
      `the offered press window is ${choice.expiresAtMs - readCompletedAt} ms, which is the advertisement's lease rather than the ${STARDEW_CABIN_PRESS_WINDOW_MS} ms a person is offered`,
    );
    const confirmStartedAt = Date.now();
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choice.choiceHandle,
      idempotencyKey: "confirm-key-lease",
      confirmed: true as const,
    };
    const confirmed = fixture.coordinator.activationOwner.confirmCabinChoice(
      fixture.broker.issue("cabin_confirm"),
      command,
    );
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await confirmed, { apiVersion: 1, status: "manifest_admitted" });
    assert.equal(fixture.bridgeConnectCalls.length, 1);
    const connection = fixture.bridgeConnectCalls[0]!;
    const grantedMs = connection.deadlineMs - confirmStartedAt;
    assert.ok(
      grantedMs >= STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
      `the connect was granted ${grantedMs} ms, which is what was left of a ${choice.expiresAtMs - confirmStartedAt} ms offer rather than the ${STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS} ms an attempt owns`,
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The press window, in the numbers the Mod actually publishes.
 *
 * `HostFarmhandProvisioner` republishes its advertisement every second with a `now + 3_000` expiry
 * (`integrations/stardew/HostFarmhandProvisioner.cs:284`) so no reader can trust a document whose publisher
 * stopped. That lease says how old the DOCUMENT may be; it was never a claim about how long a person needs to
 * read an offer and press it. Handing it to the browser as the choice's own deadline made the window a human
 * had ~2.8 s, and the press then failed `stardew_cabin_choice_expired` for a publication beat rather than for
 * anything the world had said (lane CABINDEADLINE).
 *
 * What this pins: an offer drawn under a three-second advertisement and pressed ten seconds later, while the
 * Mod keeps naming the cabin, is answered by the world - the request is published and the join admitted.
 */
test("a cabin press ten seconds after the offer was drawn is answered by the world, not by the advertisement's lease", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000);
  try {
    // The real advertisement shape: republished every beat, each copy one beat out.
    await publishSignedPlayerHostSession(
      fixture.runtimeRoot,
      "player-generation-1",
      availableCabins,
      Date.now() + 3_000,
    );
    const readStartedAt = Date.now();
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const choice = choices.choices[0]!;
    assert.ok(
      choice.expiresAtMs >= readStartedAt + STARDEW_CABIN_PRESS_WINDOW_MS,
      `the drawn offer lives ${choice.expiresAtMs - readStartedAt} ms: that is the advertisement's lease, not the ${STARDEW_CABIN_PRESS_WINDOW_MS} ms press window a person is offered`,
    );
    // A person reading the panel, deciding, and moving the mouse: ten seconds, three and a bit advertisement
    // beats after the offer was drawn.
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10_000));
    // The Mod's own loop: the advertisement that names this cabin is republished, as `Update()` does every second.
    await publishSignedPlayerHostSession(
      fixture.runtimeRoot,
      "player-generation-1",
      availableCabins,
      Date.now() + 3_000,
    );
    const confirmed = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
      apiVersion: 1,
      choiceHandle: choice.choiceHandle,
      idempotencyKey: "slow-press-key",
      confirmed: true,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    assert.equal(request.cabinId, "cabin-alpha");
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await confirmed, { apiVersion: 1, status: "manifest_admitted" });
    assert.equal(fixture.spawnCalls.length, 1);
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

/**
 * The other half of the same bound: the window is the HOST's, validity is the WORLD's. A press whose cabin
 * another companion has taken is refused by the world's own name and publishes nothing - widening the press
 * window may not turn "someone else took it" into an accepted press.
 */
test("a press on a cabin the world no longer offers is refused by name and publishes nothing", async () => {
  const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000);
  try {
    await publishSignedPlayerHostSession(
      fixture.runtimeRoot,
      "player-generation-1",
      availableCabins,
      Date.now() + 3_000,
    );
    const choices = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const choice = choices.choices[0]!;
    const command = {
      apiVersion: 1 as const,
      choiceHandle: choice.choiceHandle,
      idempotencyKey: "taken-cabin-key",
      confirmed: true as const,
    };
    // Another companion moved into the cabin this offer named, while the offer was on screen.
    await publishSignedPlayerHostSession(
      fixture.runtimeRoot,
      "player-generation-1",
      [{ ...availableCabins[0]!, isBusy: true }, ...availableCabins.slice(1)],
      Date.now() + 3_000,
    );
    await assert.rejects(
      fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), command),
      /target_farmhand_busy/,
      "the press must answer with the fact the world refused on, not with the lease the render happened to carry",
    );
    // Nothing was published: the refusal is the world's own read, made before any request could be written.
    assert.equal(await attachmentRequestId(fixture.runtimeRoot), null);

    // And the refused press left the player a forward path: the answer is "read the offers again", so the fresh
    // read is what the next press is drawn from - and it is admitted once the cabin is free.
    await publishSignedPlayerHostSession(
      fixture.runtimeRoot,
      "player-generation-1",
      availableCabins,
      Date.now() + 3_000,
    );
    const reread = await fixture.coordinator.activationOwner.readCabinChoices(fixture.broker.issue("cabin_read"));
    const retried = fixture.coordinator.activationOwner.confirmCabinChoice(fixture.broker.issue("cabin_confirm"), {
      apiVersion: 1,
      choiceHandle: reread.choices[0]!.choiceHandle,
      idempotencyKey: "freed-cabin-key",
      confirmed: true,
    });
    const request = await waitForAttachmentRequest(fixture.runtimeRoot);
    await publishAttachmentAdmission(fixture.runtimeRoot, request, availableCabins[0]!);
    assert.deepEqual(await retried, { apiVersion: 1, status: "manifest_admitted" });
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});
