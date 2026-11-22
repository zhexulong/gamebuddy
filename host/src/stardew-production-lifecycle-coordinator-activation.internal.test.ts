import {
  bootstrapToken,
  gameDirectoryCandidate,
  installationChain,
  gameProfile,
  temporaryRoots,
  sequencedInstallationInspector,
  withWindowsPlatform,
  containedSessionAck,
  canonicalTemporaryRoot,
  createFixture,
  publishSignedPlayerHostSession,
  ownerRecord,
  availableCabins,
  prepareCabinCoordinator,
  confirmFirstCabin,
  installLifecycleTestHooks,
} from "./stardew-production-lifecycle-coordinator.test-support.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readSourceShape } from "./test-support/source-shape.test-support.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readStardewInstallationRegistration } from "./stardew-installation-registration.internal.js";
import { GameBrowserValidatorsV1 } from "./game-browser-contract/index.js";
import { createGameBrowserStateProvider } from "./game-browser/game-browser-state-provider.js";
import { createStardewProductionLifecycleCoordinatorForTesting } from "./stardew-production-lifecycle-coordinator.test-support-internal.js";
import {
  containedAiClientLaunchDecision,
  containedPlayerHostLaunchDecision,
  containedRuntimeTeardownFromCollaborator,
  formatStardewBootstrapRegistrationReconcile,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import type { StardewOwnedPlayerHostBootstrap } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.js";
import type {
  StardewContainedAiClientLaunchSeam,
  StardewContainedPlayerHostLaunchSeam,
  StardewPlayerHostRuntimeLaunchCollaborator,
} from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.js";
import type { DesktopGuardianSession } from "./containment/auth/desktop-guardian-session.internal.js";
import { DESKTOP_BOOTSTRAP_REFUSAL_PREFIX } from "./containment/auth/desktop-guardian-session.internal.js";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
} from "./composition/stardew/stardew-guardian-platform.js";
import type { StardewOwnerRecoveryRequest } from "./games/stardew/lifecycle/stardew-lifecycle-platform-ports.js";
import { STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS } from "./composition/stardew/stardew-native-role-launch-plan.private.js";
import { STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS } from "./stardew-production-lifecycle-coordinator.internal.js";

installLifecycleTestHooks();

test("activation stages the durable Player Host profile without spawning and returns a frozen redacted revision-3 snapshot", async () => {
  const fixture = await createFixture();
  try {
    const admission = fixture.broker.issue();
    const activation = fixture.coordinator.activationOwner.activate(admission);
    const result = await activation.catch((error: unknown) => {
      throw error instanceof Error && error.cause instanceof Error ? error.cause : error;
    });
    assert.deepEqual(result, {
      schemaVersion: 1,
      requestId: "request-1",
      authorityGeneration: 1,
      revision: 3,
      state: "staged",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(Object.keys(result).sort(), [
      "authorityGeneration",
      "requestId",
      "revision",
      "schemaVersion",
      "state",
    ]);
    assert.equal(JSON.stringify(result).includes("bootstrap-coordinator-1"), false);
    assert.deepEqual(fixture.spawnCalls, []);
    assert.deepEqual(fixture.playerSpawnCalls, []);
    const owner = await ownerRecord(fixture.runtimeRoot);
    assert.equal(owner.state, "reserved");
    assert.equal(owner.managedPaths.includes("player-host/Mods/GameBuddy/config.json"), true);
    assert.equal(
      await readFile(
        join(
          fixture.runtimeRoot,
          "stardew-private-bootstrap",
          "bootstrap-coordinator-1",
          "player-host",
          "Mods",
          "GameBuddy",
          "GameBuddy.Stardew.dll",
        ),
        "utf8",
      ),
      "fixed-GameBuddy.Stardew.dll",
    );
  } finally {
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("same admission joins the exact activation Promise while a conflicting admission remains consumable", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await createFixture({ stagingGate: gate });
  try {
    const accepted = fixture.broker.issue();
    const conflicting = fixture.broker.issue();
    const first = fixture.coordinator.activationOwner.activate(accepted);
    const joined = fixture.coordinator.activationOwner.activate(accepted);
    assert.equal(joined, first);
    await assert.rejects(
      fixture.coordinator.activationOwner.activate(conflicting),
      /stardew_lifecycle_activation_conflict/,
    );
    release();
    await first;
    assert.equal(fixture.packageReadCount(), 2);
    const secondRuntimeRoot = await canonicalTemporaryRoot("gamebuddy-lifecycle-conflict-");
    temporaryRoots.push(secondRuntimeRoot);
    const second = createStardewProductionLifecycleCoordinatorForTesting(
      Object.freeze({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot: secondRuntimeRoot,
        principal: Object.freeze({ continuityId: "continuity-2", playerId: "player-2", companionId: "companion-2" }),
        bootstrapOperationId: "request-2",
        authorityGeneration: 1,
      }),
      {
        rawSpawn: () => Object.freeze({ pid: 1, kill: () => true }),
        rawProbe: () => null,
        rawPlayerHostSpawn: () => Object.freeze({ pid: 2, kill: () => true }),
        rawPlayerHostProbe: () => null,
        createBootstrapIdentity: () => "bootstrap-conflict-2",
        createGuardianRevision: () => "guardian-revision-conflict-2",
        createGuardianInstanceId: () => "guardian-instance-conflict-2",
        createGuardianEpoch: () => 1,
        createGuardianLeaseName: () => "Local\\GameBuddy-Conflict-Lease-2",
        createGuardianPlayerJobName: () => "Local\\GameBuddy-Conflict-Player-2",
        createGuardianAiJobName: () => "Local\\GameBuddy-Conflict-Ai-2",
        createLaunchGeneration: () => "ai-2",
        createPlayerHostLaunchGeneration: () => "player-2",
        createBridgePipeName: () => "gamebuddy-stardew-conflict-bridge",
        createBridgeToken: () => "conflict-bridge-token-0123456789",
        nowMs: () => Date.now(),
        staging: {
          readPackage: async () => {
            throw new Error("proof-consumed");
          },
          createSecret: () => "secret-conflict-012345",
          nowMs: () => Date.now(),
        },
      },
    );
    second.activationOwner.bindBrowserAdmissionIssuer(fixture.broker.handler.lifecycleActivationIssuer);
    await assert.rejects(second.activationOwner.activate(conflicting), /stardew_lifecycle_activation_failed/);
    assert.equal(second.activationOwner.readPrivateActivationSnapshot().state, "activation_failed");
    await second.close();
  } finally {
    release();
    await fixture.coordinator.close();
    await fixture.broker.close();
  }
});

test("staged Player Host admits internally, direct-spawns once, and projects only awaiting attestation", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const first = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      const joined = fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      assert.equal(joined, first);
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        }),
        /stardew_game_setup_in_progress/,
      );
      await first;
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      const result = fixture.coordinator.activationOwner.readPrivateActivationSnapshot();
      assert.equal(result.state, "awaiting_player_host_attestation");
      assert.equal(Object.isFrozen(result), true);
      assert.deepEqual(Object.keys(result).sort(), [
        "authorityGeneration",
        "requestId",
        "revision",
        "schemaVersion",
        "state",
      ]);
      const serialized = JSON.stringify(result);
      for (const forbidden of [
        gameDirectoryCandidate,
        "StardewModdingAPI.exe",
        "bootstrap-coordinator-1",
        "player-generation-1",
        "4102",
        "owner",
        "installation",
        "executable",
        "generation",
        "pid",
      ])
        assert.equal(serialized.includes(forbidden), false, forbidden);
      assert.equal(fixture.playerSpawnCalls.length, 1);
      const playerSpawn = fixture.playerSpawnCalls[0]!;
      assert.equal(playerSpawn.executable, `${gameDirectoryCandidate}\\StardewModdingAPI.exe`);
      assert.deepEqual(playerSpawn.args, [
        "--mods-path",
        join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "player-host", "Mods"),
      ]);
      assert.equal(playerSpawn.options.cwd, gameDirectoryCandidate);
      assert.equal(playerSpawn.options.shell, false);
      assert.equal(playerSpawn.options.windowsHide, true);
      assert.equal(playerSpawn.options.env.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "player-generation-1");
      assert.deepEqual(fixture.spawnCalls, []);
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
      });
      assert.equal(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        }),
        first,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("the activation route stages the owned player host through the coordinator's own activation path", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({ overrides: {} });
    try {
      // Failure caught: the composed shell issuing the `lifecycle_activation` admission for
      // `POST /lifecycle/activate` while dispatch has no branch for the path, so the browser's
      // first activation step answers 404 and the state can never leave `inactive` - which is
      // exactly why `setup` and `launch` refuse afterwards with
      // `stardew_player_host_launch_not_staged`.
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "inactive");
      const path = `${fixture.broker.origin}/api/composed-reference-game/v1/lifecycle/activate`;
      const response = await fetch(path, {
        method: "POST",
        headers: {
          origin: fixture.broker.origin,
          cookie: fixture.broker.cookie,
          "x-csrf-token": fixture.broker.csrfToken,
          "content-type": "application/json",
        },
      });
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      // The route is a producer, not an opening: an unauthenticated caller is still refused and
      // the state it produced is not advanced by the refusal.
      const unauthenticated = await fetch(path, {
        method: "POST",
        headers: { origin: fixture.broker.origin, "content-type": "application/json" },
      });
      assert.equal(unauthenticated.status, 401);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup inspection failure preserves registration and does not spawn Player Host", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture({
      overrides: {
        createInstallationInspector: async () => {
          throw new Error("controlled_inspector_unavailable");
        },
      },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const registrationBeforeSetup = await readStardewInstallationRegistration(fixture.runtimeRoot);
      await assert.rejects(
        fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
          apiVersion: 1,
          idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
        }),
        /stardew_game_setup_failed/,
      );
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), registrationBeforeSetup);
      assert.equal(fixture.playerSpawnCalls.length, 0);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup registers only the selected installation and Player Host fresh-admits it immediately before spawning", async () => {
  await withWindowsPlatform(async () => {
    const setupChain = installationChain.map((entry, index) =>
      index === 2 ? Object.freeze({ ...entry, fileId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) : entry,
    );
    const launchChain = installationChain.map((entry, index) =>
      index === 2 ? Object.freeze({ ...entry, fileId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) : entry,
    );
    const inspector = sequencedInstallationInspector([
      [setupChain, setupChain],
      [launchChain, launchChain, launchChain],
    ]);
    const fixture = await createFixture({
      overrides: { createInstallationInspector: async () => inspector },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      assert.deepEqual(fixture.playerSpawnCalls, []);
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(await readStardewInstallationRegistration(fixture.runtimeRoot), {
        schema: "gamebuddy-stardew-installation-registration/v1",
        binding: { rootLayoutVersion: 1 },
        revision: 3,
        state: "ready",
        locator: gameDirectoryCandidate,
        activeAttempt: { bootstrapCorrelation: "bootstrap-coordinator-1" },
        instanceGeneration: 1,
      });
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      assert.equal(fixture.playerSpawnCalls.length, 1);
      assert.equal(
        JSON.stringify(fixture.coordinator.activationOwner.readPrivateActivationSnapshot()).includes(
          gameDirectoryCandidate,
        ),
        false,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game setup projects activeAttempt without spawning Player Host", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      const registration = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.equal(registration?.state, "ready");
      assert.deepEqual(registration?.activeAttempt, { bootstrapCorrelation: "bootstrap-coordinator-1" });
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      const staged = await readStardewInstallationRegistration(fixture.runtimeRoot);
      assert.equal(staged?.state, "ready");
      assert.deepEqual(staged?.activeAttempt, { bootstrapCorrelation: "bootstrap-coordinator-1" });
      assert.equal(fixture.playerSpawnCalls.length, 0);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("launch-readiness generation is 0 before activation, then 1 while staged, and resets once launch starts", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 0);
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 1);
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 1);
      assert.deepEqual(fixture.playerSpawnCalls, []);
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      assert.equal(
        fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
        "awaiting_player_host_attestation",
      );
      assert.equal(fixture.coordinator.launchReadinessReader.readLaunchReadinessView().generation, 0);
      assert.equal(
        JSON.stringify(fixture.coordinator.launchReadinessReader.readLaunchReadinessView()).includes(
          "player-generation-1",
        ),
        false,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("a staged but not yet launched attempt projects nothing running instead of launching", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      // The attempt owns the exact expected generation and no Player Host
      // process: the launch reservation minted by activation is an
      // authorization, not a launch in flight.
      assert.deepEqual(fixture.coordinator.launchReadinessReader.readLaunchReadinessView(), {
        generation: 1,
        status: "ready",
        playerHostExitCode: null,
      });
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "not_started",
        ownership: "none",
      });
      const state = await createGameBrowserStateProvider(
        gameProfile,
        fixture.coordinator.lifecycleReader,
        fixture.coordinator.attachmentReader,
        fixture.coordinator.launchReadinessReader,
        fixture.coordinator.actionAuthorityReader,
      ).readState({ csrfToken: bootstrapToken, browserSessionExpiresAtMs: 100_000 });
      assert.equal(GameBrowserValidatorsV1.GameBrowserStateV1Schema.Check(state), true);
      assert.equal(state.game.prerequisites.status, "met");
      // `none` is the honest word for "nothing is running, and the product is
      // ready to start it"; `launching` would strand the player, because the
      // launch control requires this exact shape.
      assert.deepEqual(state.game.instance, { status: "none", gameTitle: null, generation: 1 });
      assert.equal(state.game.latestOutcome, "none");
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game launch rejects an incorrect first instance generation before spawning", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedInstanceGeneration: 2,
        }),
        /stardew_game_instance_generation_conflict/,
      );
      assert.deepEqual(fixture.playerSpawnCalls, []);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("Game launch consumes setup once and replays exact command", async () => {
  await withWindowsPlatform(async () => {
    const fixture = await createFixture();
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      const command = {
        apiVersion: 1 as const,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      };
      const first = fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), command);
      const replay = fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), command);
      assert.equal(replay, first);
      await first;
      assert.equal(fixture.playerSpawnCalls.length, 1);
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          ...command,
          expectedInstanceGeneration: 2,
        }),
        /stardew_game_launch_idempotency_conflict/,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("contained Player Host success constructs the real contained runtime and session launch with exact typed-facts plan and 60s deadline", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const firstDeadlineUnixMs: number[] = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        firstDeadlineUnixMs.push(input.deadlineUnixMs);
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() {
        sessionCalls.push({ operation: "close", input: {} });
      },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(session),
    );
    // Deterministic lifecycle clock: the RoleLaunchOperation deadline must be
    // exactly this fixed instant plus the budget, never a rubric of uncertainty.
    const fixedNow = Date.now();
    const fixture = await createFixture({
      overrides: { runtimeLaunchContained: collaborator, containedLaunchNowMs: () => fixedNow },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      // Neither the Player Host nor the AI-client process-owner raw-spawn path
      // may run when the contained runtime owns the launch.
      assert.equal(fixture.playerSpawnCalls.length, 0);
      assert.equal(fixture.spawnCalls.length, 0);
      assert.deepEqual(
        sessionCalls.map((call) => call.operation),
        ["arm", "launch"],
      );
      const launchCall = sessionCalls[1]!;
      assert.equal(launchCall.input.role, "player_host");
      assert.equal(launchCall.input.guardianEpoch, 1);
      assert.equal(launchCall.input.attemptId, "bootstrap-coordinator-1");
      const decode = (frame: Uint8Array) => JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>;
      const plan = decode(new Uint8Array(launchCall.input.privateFrame as readonly number[]));
      // ParseLaunch schema: exactly the ten keys, fully qualified executable/cwd,
      // and the six-key environment allowlist with the generation var.
      assert.deepEqual(
        Object.keys(plan).sort(),
        [
          "arguments",
          "attemptId",
          "cwd",
          "deadlineUnixMs",
          "environment",
          "executable",
          "guardianEpoch",
          "guardianInstanceId",
          "planId",
          "role",
        ].sort(),
      );
      assert.equal(plan.role, "player_host");
      assert.equal(
        plan.planId === undefined ||
          (typeof plan.planId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(plan.planId)),
        true,
        "planId",
      );
      assert.equal(plan.executable, `${gameDirectoryCandidate}\\StardewModdingAPI.exe`);
      assert.equal(plan.cwd, gameDirectoryCandidate);
      assert.deepEqual(plan.arguments, [
        "--mods-path",
        join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "player-host", "Mods"),
      ]);
      const environment = plan.environment as Record<string, string>;
      assert.deepEqual(Object.keys(environment).sort(), [...STARDEW_NATIVE_ROLE_ENVIRONMENT_KEYS].sort());
      assert.equal(environment.GAMEBUDDY_STARDEW_LAUNCH_GENERATION, "player-generation-1");
      const deadlineUnixMs = firstDeadlineUnixMs[0]!;
      assert.equal(plan.deadlineUnixMs, deadlineUnixMs);
      // Exact lifecycle-created deadline: fixed clock + budget, equal in both
      // the session launch input and the encoded plan.
      assert.equal(deadlineUnixMs, fixedNow + STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS);
      assert.equal(plan.deadlineUnixMs, fixedNow + STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS);
      assert.equal(
        fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
        "awaiting_player_host_attestation",
      );
      // The coordinated launch decision rejects a concurrent launch while the
      // first invocation's launchPromise remains authoritative.
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "CCEiM0RVZneImaq7zN3u_w",
          expectedInstanceGeneration: 1,
        }),
        /stardew_game_launch_in_progress/,
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("explicit endgame settles the contained attempt, releases the registration pointer, and projects gameended", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() {
        sessionCalls.push({ operation: "close", input: {} });
      },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await publishSignedPlayerHostSession(
        fixture.runtimeRoot,
        "player-generation-1",
        availableCabins,
        Date.now() + 5 * 60_000,
      );
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
      // Bind the attachment: launch alone leaves the registration pointer held
      // but no attachment generation, exactly like the product cabin flow.
      await confirmFirstCabin(fixture);
      // The launch bound the registration's active attempt: the pointer is held.
      assert.deepEqual((await readStardewInstallationRegistration(fixture.runtimeRoot))?.activeAttempt, {
        bootstrapCorrelation: "bootstrap-coordinator-1",
      });
      const command = {
        apiVersion: 1 as const,
        idempotencyKey: "endgame-key-1",
        expectedAttachmentGeneration: 1,
        confirm: true as const,
      };
      const result = await fixture.coordinator.activationOwner.endgameGame(
        fixture.broker.issue("game_endgame"),
        command,
      );
      assert.deepEqual(result, { apiVersion: 1, status: "gameended" });
      // The explicit endgame is what releases the pointer: an ordinary close
      // deliberately never contains the Player, so nothing else could.
      assert.equal((await readStardewInstallationRegistration(fixture.runtimeRoot))?.activeAttempt, null);
      // Both roles were contained through the Guardian, and the durable owner
      // attempt reached its terminal contained state.
      const containCalls = sessionCalls.filter((call) => call.operation === "contain");
      assert.deepEqual(
        containCalls.map((call) => call.input.role),
        ["player_host", "ai_client"],
      );
      const ownerPath = join(fixture.runtimeRoot, "stardew-private-bootstrap", "bootstrap-coordinator-1", "owner.json");
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
      assert.equal(owner.state, "contained");
      assert.equal(owner.guardianState, "contained");
      assert.equal(owner.playerHostState, "contained");
      assert.equal(owner.aiClientState, "contained");
      // Replay is idempotent and never re-settles the attempt.
      const containCountAfterFirst = containCalls.length;
      assert.deepEqual(
        await fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), command),
        { apiVersion: 1, status: "gameended" },
      );
      assert.equal(sessionCalls.filter((call) => call.operation === "contain").length, containCountAfterFirst);
      // Idempotency is per ATTEMPT, not merely per idempotency key: the same
      // terminal outcome must come back under a fresh key too, instead of
      // re-driving the runtime into its settled latch and surfacing an opaque
      // `stardew_contained_runtime_settlement_unavailable` for an ended game.
      const settleCountAfterFirst = sessionCalls.filter((call) => call.operation === "close").length;
      assert.deepEqual(
        await fixture.coordinator.activationOwner.endgameGame(fixture.broker.issue("game_endgame"), {
          ...command,
          idempotencyKey: "endgame-key-2",
        }),
        { apiVersion: 1, status: "gameended" },
      );
      assert.equal(sessionCalls.filter((call) => call.operation === "contain").length, containCountAfterFirst);
      assert.equal(sessionCalls.filter((call) => call.operation === "close").length, settleCountAfterFirst);
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("contained Player Host launch failure after the claim durably quarantines the exact owner record", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        throw new Error("controlled_contained_native_launch_failure");
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() {
        sessionCalls.push({ operation: "close", input: {} });
      },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(session),
    );
    const fixture = await createFixture({ overrides: { runtimeLaunchContained: collaborator } });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedInstanceGeneration: 1,
        }),
        /stardew_player_host_launch_failed/,
      );
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "launch_quarantined");
      // Durable authority, not just the lifecycle snapshot: the exact owner record
      // must be quarantined (termination of the launchMayHaveRun path).
      assert.equal((await ownerRecord(fixture.runtimeRoot)).state, "quarantined");
      assert.equal(fixture.playerSpawnCalls.length, 0);
      // The claim was attempted exactly once: no blind native retry.
      assert.deepEqual(
        sessionCalls.map((call) => call.operation),
        ["arm", "launch"],
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("contained Player Host decision failing before the claim restores staged with zero session calls and a retry succeeds", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() {
        sessionCalls.push({ operation: "close", input: {} });
      },
    });
    // Stale lifecycle clock: the RoleLaunchOperation deadline is invalid before
    // any native/session call, so the launch decision fails pre-claim.
    let nowMs: () => number = () => Date.now() - 1_000_000;
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(session),
    );
    const fixture = await createFixture({
      overrides: { runtimeLaunchContained: collaborator, containedLaunchNowMs: () => nowMs() },
    });
    try {
      await fixture.coordinator.activationOwner.activate(fixture.broker.issue());
      await fixture.coordinator.activationOwner.setupPlayerHost(fixture.broker.issue("game_setup"), {
        apiVersion: 1,
        idempotencyKey: "ABEiM0RVZneImaq7zN3u_w",
      });
      await assert.rejects(
        fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
          apiVersion: 1,
          idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
          expectedInstanceGeneration: 1,
        }),
        /stardew_player_host_launch_failed/,
      );
      // Pre-claim failure: staged marker restored and no native/session call ran.
      assert.equal(fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state, "staged");
      assert.deepEqual(sessionCalls.length, 0);
      assert.equal(fixture.playerSpawnCalls.length, 0);
      // A fresh launch invocation with a valid lifecycle clock succeeds through
      // the same real runtime/executor path.
      nowMs = () => Date.now();
      await fixture.coordinator.activationOwner.launchPlayerHost(fixture.broker.issue("game_launch"), {
        apiVersion: 1,
        idempotencyKey: "CCEiM0RVZneImaq7zN3u_w",
        expectedInstanceGeneration: 1,
      });
      assert.deepEqual(
        sessionCalls.map((call) => call.operation),
        ["arm", "launch"],
      );
      assert.equal(
        fixture.coordinator.activationOwner.readPrivateActivationSnapshot().state,
        "awaiting_player_host_attestation",
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("contained AI and Player roles share one per-owner runtime, close drains AI and preserves the Player", async () => {
  await withWindowsPlatform(async () => {
    const sessionCalls: Array<Readonly<{ operation: string; input: Record<string, unknown> }>> = [];
    const session: DesktopGuardianSession = Object.freeze({
      async arm(input) {
        sessionCalls.push({ operation: "arm", input: { ...input, privateFrame: "<bytes>" } });
        return containedSessionAck("arm_attempt");
      },
      async launch(input) {
        sessionCalls.push({ operation: "launch", input: { ...input, privateFrame: [...input.privateFrame] } });
        return containedSessionAck("launch_role", input.role);
      },
      async contain(input) {
        sessionCalls.push({ operation: "contain", input: { ...input } });
        return containedSessionAck("contain_role", input.role);
      },
      // These launches never drive a recovery, but the session contract carries
      // it and an honest literal fake answers it explicitly.
      async recover() {
        sessionCalls.push({ operation: "recover", input: {} });
        return Object.freeze({ outcome: "contained" as const });
      },
      async close() {
        sessionCalls.push({ operation: "close", input: {} });
      },
    });
    const collaborator = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
      createDesktopGuardianGameRuntimePlatform(session),
    );
    const fixture = await prepareCabinCoordinator(Date.now() + 5 * 60_000, {
      overrides: { runtimeLaunchContained: collaborator },
    });
    try {
      // Player Host launched first through the runtime; the shared per-owner
      // runtime arms exactly once.
      assert.deepEqual(
        sessionCalls.map((call) => call.operation),
        ["arm", "launch"],
      );
      assert.equal(sessionCalls[1]!.input.role, "player_host");
      assert.equal(fixture.playerSpawnCalls.length, 0);
      assert.equal(fixture.spawnCalls.length, 0);
      // Cabin confirm launches the AI client through the SAME runtime: no second
      // arm, so the per-owner runtime binding is proven shared.
      await confirmFirstCabin(fixture);
      assert.deepEqual(
        sessionCalls.map((call) => call.operation),
        ["arm", "launch", "launch"],
      );
      assert.equal(sessionCalls[1]!.input.role, "player_host");
      assert.equal(sessionCalls[2]!.input.role, "ai_client");
      assert.equal(fixture.playerSpawnCalls.length, 0);
      assert.equal(fixture.spawnCalls.length, 0);
      // The contained launch marks the AI process owner awaiting attestation
      // without a pid, so the bridge correlation succeeds and both lifecycle
      // view slots stay authoritative.
      assert.equal(fixture.gameRuntimeFacadeEnterCalls(), 1);
      // The contained launch correlated the Player Host's advertisement, so the lifecycle's own
      // state is the attested one - the slot the browser reads follows it, and the AI-client
      // slot stays the facade's own reading.
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).playerHost, {
        state: "attested",
        ownership: "gamebuddy_direct_spawn",
      });
      assert.deepEqual((await fixture.coordinator.lifecycleReader.readRoleLifecycleView()).aiClient, {
        state: "awaiting_attestation",
        ownership: "gamebuddy_direct_spawn",
        lastStopOutcome: "none",
      });
      // Close: the no-pid stop is a success no-op, then the AI role is drained
      // and the platform session closes. The Player Host is NOT contained here:
      // its Job is non-kill-on-close and an ordinary close must not end the
      // player's world. ADR-0007's superseding clarification forbids turning
      // last-handle close into an implicit endgame, and the survival task removes
      // "default close/crash player kill" outright, so a `contain_role` for
      // player_host on this path would be the defect.
      await fixture.coordinator.close();
      assert.deepEqual(fixture.aiKillCalls, []);
      assert.deepEqual(fixture.playerKillCalls, []);
      assert.deepEqual(
        sessionCalls.map((call) => call.operation),
        ["arm", "launch", "launch", "contain", "close"],
      );
      assert.equal(sessionCalls[3]!.input.role, "ai_client");
      assert.equal(
        sessionCalls.some((call) => call.operation === "contain" && call.input.role === "player_host"),
        false,
        "ordinary close must not contain the Player Host role",
      );
    } finally {
      await fixture.coordinator.close();
      await fixture.broker.close();
    }
  });
});

test("production lifecycle coordinator has no direct-spawn fallback and both role launches fail closed without a runtime collaborator", async () => {
  // The compiled test runs from dist-test; the source probe reads the tracked
  // module from the Host source tree.
  const source = await readFile(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "stardew-production-lifecycle-coordinator.internal.ts",
    ),
    "utf8",
  );
  const productionFactoryStart = source.indexOf("export function createStardewProductionLifecycleCoordinator(");
  assert.notEqual(productionFactoryStart, -1);
  const productionFactory = source.slice(productionFactoryStart);
  // The production factory region never invokes the direct-spawn Stage C/D
  // consumers; the test reference lives only in the testing adapter. The
  // contained variants use the distinct `…Contained(` call shapes.
  assert.equal(/internal\.launchStagedPlayerHost\s*\(/.test(productionFactory), false);
  assert.equal(/internal\.launchMaterializedAiClient\s*\(/.test(productionFactory), false);
  // Without the runtime collaborator both role launches fail closed.
  assert.match(productionFactory, /stardew_player_host_launch_runtime_unavailable/);
  assert.match(productionFactory, /stardew_ai_client_launch_runtime_unavailable/);
  assert.match(productionFactory, /containedRuntimeTeardownFromCollaborator/);
  assert.doesNotMatch(productionFactory, /installationDiscoveryOverlay/);
  // Both installation sources are mounted in production, not just Steam: the panel's provider
  // mounted Steam alone, so a player whose game came from GOG Galaxy was told nothing was found
  // on a machine where it is installed. The GOG proposal travels with the probe that keeps its
  // unconditional default layouts from becoming rows for a game that is not there.
  assert.match(productionFactory, /createWindowsSteamInstallationSource\(\)/);
  assert.match(productionFactory, /gog: createWindowsGogDiscoveryProposal\(\)/);
  assert.match(productionFactory, /createStardewInstallationDiscoveryProvider\(\{/);
  // Loop 4 composition seams: the production factory forwards the one semantic
  // Game authority and mounts the Loop 4 path B' world-creation seam built from
  // that same authority, so the create path no longer carries an unmounted seam
  // argument. What is pinned here is that the ONE owner-bound seam reaches
  // createCoordinator.
  assert.match(productionFactory, /createStardewWorldBindingResolverFromGameAuthority\(game\)/);
  assert.match(productionFactory, /\n\s*game,\n\s*createWorldBindingSeam,\n\s*containedRuntimeTeardown/);
  assert.equal(/\n\s*game,\n\s*undefined,\n\s*containedRuntimeTeardown/.test(productionFactory), false);
  // The mounted seam is the integration-private production one: it is built per
  // create from the owner-bound attachment flow (whose staged session material
  // signs and scopes the manifest read) and the join request identity this
  // create's own admission minted.
  assert.match(productionFactory, /createStardewWorldCreationBindingSeam\(/);
  assert.match(productionFactory, /createStardewIssuedJoinManifestSource\(/);
  assert.match(productionFactory, /internal\.createOwnedPlayerHostAttachmentFlow\(owner\)/);
  assert.match(productionFactory, /StardewWorldCreationSeamFactory/);
  // The create path itself builds that seam per create, only after its own
  // manifest handoff admission and before any durable registration.
  const createPathStart = source.indexOf(
    'const createGameSession: StardewProductionLifecycleActivationOwner["createGameSession"]',
  );
  assert.notEqual(createPathStart, -1);
  const createPath = source.slice(
    createPathStart,
    source.indexOf("const cancelResume: StardewProductionLifecycleActivationOwner"),
  );
  const admissionIndex = createPath.indexOf("handoffCoordinator.confirmAndAdmit(choice.selection");
  const joinRequestIndex = createPath.indexOf(
    "joinRequestId: handoffCoordinator.readAdmittedJoinRequestId(handoffOwner, manifestAdmission)",
  );
  const seamIndex = createPath.indexOf("createWorldBindingSeamFactory({");
  const seamCallIndex = createPath.indexOf("worldCreationSeam.createWorldBinding({");
  const registerIndex = createPath.indexOf("creationAuthority.registerGameSessionWorldBinding({");
  const completeIndex = createPath.indexOf("creationAuthority.completeGameSessionBinding({");
  const materializeIndex = createPath.indexOf(
    "materializeAiClientProfileAfterManifestAdmission(handoffOwner, manifestAdmission)",
  );
  for (const [name, index] of [
    ["manifest handoff admission", admissionIndex],
    ["admitted join request identity", joinRequestIndex],
    ["per-create seam construction", seamIndex],
    ["world binding creation", seamCallIndex],
    ["binding registration", registerIndex],
    ["session completion", completeIndex],
    ["AI-client profile materialization", materializeIndex],
  ] as const)
    assert.notEqual(index, -1, `${name} missing from the create path`);
  assert.ok(
    seamIndex < joinRequestIndex && joinRequestIndex < seamCallIndex,
    "the per-create seam is built from the admitted join request identity",
  );
  assert.ok(admissionIndex < seamIndex, "the manifest handoff admission precedes the world-binding seam");
  assert.ok(
    admissionIndex < seamCallIndex && seamCallIndex < registerIndex,
    "the seam runs after the admission and before registration",
  );
  assert.ok(registerIndex < completeIndex, "the durable create protocol order is preserved");
  assert.ok(completeIndex < materializeIndex, "the AI-client profile is materialized only after the session completed");
});

/**
 * The contained runtime seam this coordinator consumes is a promise-returning
 * one: its consumers await the returned value (or attach only a rejection
 * handler) and hold no try/catch around the call, because a failure it reports
 * IS the failure they handle. That makes `async` part of the adapters' contract
 * rather than a formatting choice: an adapter that only chains `.then()` onto an
 * already-`async` collaborator member cannot reject, so the day a refusal is
 * added under such a member -- a guard in the composition, a deadline check, a
 * failed outcome -- it leaves the adapter's frame as a synchronous throw and
 * reaches the product seam as an unhandled exception instead of the awaited
 * failure the caller handles.
 *
 * Every call below is made OUTSIDE `await` and OUTSIDE `try` on purpose: a
 * wrapper that throws synchronously fails this test at the call itself, while a
 * wrapper that rejects is observed by the catch-only handlers.
 */
test("contained runtime adapters surface every refusal as a rejection rather than a synchronous throw", async () => {
  const beneathRefusal = "controlled_refusal_below_the_adapter";
  const deadlineRefusal = "stardew_player_host_role_launch_operation_deadline_invalid";
  // A synchronously refusing member is the shape a promise-returning guard takes
  // when it forgets its `async`; the platform factory declares every
  // promise-returning member `async` for exactly this reason.
  const refuseSynchronously = (): never => {
    throw new Error(beneathRefusal);
  };
  const refusingCollaborator = (
    ownersRecoveryHalf: Readonly<Record<string, unknown>>,
  ): StardewPlayerHostRuntimeLaunchCollaborator =>
    Object.freeze({
      launchPlayerHost: refuseSynchronously,
      launchAiClient: refuseSynchronously,
      containPlayerHost: refuseSynchronously,
      containAiClient: refuseSynchronously,
      recovery: refuseSynchronously,
      settle: refuseSynchronously,
      close: refuseSynchronously,
      ...ownersRecoveryHalf,
    }) as unknown as StardewPlayerHostRuntimeLaunchCollaborator;
  // The adapter forwards a recovery only to a collaborator that carries the
  // owner-held recovery half; without that half, the adapter's own refusal is
  // the one at stake. The half is both members: a drive that can recover but not
  // finalize cannot close an attempt out, so it is not read as a drive at all.
  const withRecoveryHalf = refusingCollaborator({
    recover: refuseSynchronously,
    finalizeRecovered: refuseSynchronously,
  });
  const withoutRecoveryHalf = refusingCollaborator({});
  const withRecovery = containedRuntimeTeardownFromCollaborator(withRecoveryHalf);
  const withoutRecovery = containedRuntimeTeardownFromCollaborator(withoutRecoveryHalf);
  // Nothing below reads these arguments: every refusal is produced first.
  const owner = Object.freeze({}) as unknown as StardewOwnedPlayerHostBootstrap;
  const playerLaunch: StardewContainedPlayerHostLaunchSeam = Object.freeze({
    role: "player_host",
    launchGeneration: "generation-1",
    provideAuthorization: () => undefined,
  });
  const aiClientLaunch: StardewContainedAiClientLaunchSeam = Object.freeze({
    role: "ai_client",
    launchGeneration: "generation-1",
    provideAuthorization: () => undefined,
  });
  const recoveryRequest: StardewOwnerRecoveryRequest = Object.freeze({
    recoveryInstanceId: "0a5c1e7b-2f3d-4a90-8c11-6d2b7e4f9a02",
    readRecoveryBinding: async () => Object.freeze({}),
  });
  // The launch decision's own deadline check is the adapter's own synchronous
  // throw, before any collaborator member runs.
  const invalidDeadline = (): number => Number.NaN;

  const calls: readonly Readonly<{ member: string; refusal: string; pending: Promise<unknown> }>[] = [
    {
      member: "player host launch decision",
      refusal: beneathRefusal,
      pending: containedPlayerHostLaunchDecision(withRecoveryHalf, owner, playerLaunch),
    },
    {
      member: "AI client launch decision",
      refusal: beneathRefusal,
      pending: containedAiClientLaunchDecision(withRecoveryHalf, owner, aiClientLaunch),
    },
    {
      member: "player host launch decision with an invalid deadline",
      refusal: deadlineRefusal,
      pending: containedPlayerHostLaunchDecision(withRecoveryHalf, owner, playerLaunch, invalidDeadline),
    },
    {
      member: "AI client launch decision with an invalid deadline",
      refusal: deadlineRefusal,
      pending: containedAiClientLaunchDecision(withRecoveryHalf, owner, aiClientLaunch, invalidDeadline),
    },
    { member: "contain player host", refusal: beneathRefusal, pending: withRecovery.containPlayerHost(owner) },
    { member: "contain AI client", refusal: beneathRefusal, pending: withRecovery.containAiClient(owner) },
    { member: "recovery drive", refusal: beneathRefusal, pending: withRecovery.recover(owner, recoveryRequest) },
    {
      member: "recovery finalization",
      refusal: beneathRefusal,
      pending: withRecovery.finalizeRecovered(owner, recoveryRequest),
    },
    { member: "close", refusal: beneathRefusal, pending: withRecovery.close(owner) },
    { member: "settle", refusal: beneathRefusal, pending: withRecovery.settle(owner) },
    {
      member: "recovery drive without the owner-held recovery half",
      refusal: "stardew_contained_recovery_drive_unavailable",
      pending: withoutRecovery.recover(owner, recoveryRequest),
    },
    {
      member: "recovery finalization without the owner-held recovery half",
      refusal: "stardew_contained_recovery_drive_unavailable",
      pending: withoutRecovery.finalizeRecovered(owner, recoveryRequest),
    },
  ];
  assert.equal(calls.length, 12);

  for (const call of calls) {
    // A catch-only consumer: no fulfillment branch and no surrounding try/catch,
    // exactly the shape the product seam uses.
    const refusal = await call.pending.catch((error: unknown) => error);
    assert.ok(refusal instanceof Error, `${call.member} must reject, got ${String(refusal)}`);
    assert.equal(refusal.message, call.refusal, `${call.member} must reject with its own refusal`);
  }
});

/**
 * The boot reconcile has to be reachable from every boot and has to say what it
 * did, including when it examined nothing: a pass that found no records must not
 * read like a pass that found nothing wrong.
 */
/**
 * A role launch that did not succeed is not one failure: it is the refusal the launch step
 * carried. Measured 2026-11-20 (`.tmp/lane-livenow4.md`): a real launch answered
 * `409 {"code":"game_unavailable","cause":"stardew_contained_player_host_launch_failed"}` -
 * one word standing for every failed role launch - while the step that refused had named its own
 * cause and this seam discarded it. A refusal that named nothing bounded keeps the class.
 */
test("a contained role launch that did not succeed answers the refusal it carried, not one opaque word", async () => {
  const owner = Object.freeze({}) as unknown as StardewOwnedPlayerHostBootstrap;
  const playerLaunch: StardewContainedPlayerHostLaunchSeam = Object.freeze({
    role: "player_host",
    launchGeneration: "generation-1",
    provideAuthorization: () => undefined,
  });
  const aiClientLaunch: StardewContainedAiClientLaunchSeam = Object.freeze({
    role: "ai_client",
    launchGeneration: "generation-1",
    provideAuthorization: () => undefined,
  });
  // The boundary this test does not own is the game; the launch DECISION is ours, so a stubbed
  // role outcome is the right double. Every other member is here because the seam is one object.
  const collaborator = (refusal: string | null): StardewPlayerHostRuntimeLaunchCollaborator =>
    Object.freeze({
      launchPlayerHost: async () => ({ role: "player_host", status: "failed", refusal }),
      launchAiClient: async () => ({ role: "ai_client", status: "failed", refusal }),
      containPlayerHost: async () => ({ role: "player_host", status: "succeeded" }),
      containAiClient: async () => ({ role: "ai_client", status: "succeeded" }),
      recovery: () => {
        throw new Error("a launch decision never reads the recovery drive");
      },
      settle: async () => undefined,
      close: async () => undefined,
    }) as unknown as StardewPlayerHostRuntimeLaunchCollaborator;
  const cases = [
    {
      name: "the Player Host launch",
      refusal: "guardian_command_acknowledgement_invalid",
      classCode: "stardew_contained_player_host_launch_failed",
      decision: (refusal: string | null) =>
        containedPlayerHostLaunchDecision(collaborator(refusal), owner, playerLaunch),
    },
    {
      name: "the AI-client launch",
      refusal: "stardew_native_launch_plan_executable_invalid",
      classCode: "stardew_contained_ai_client_launch_failed",
      decision: (refusal: string | null) =>
        containedAiClientLaunchDecision(collaborator(refusal), owner, aiClientLaunch),
    },
  ];

  for (const one of cases) {
    const refused = await one.decision(one.refusal).catch((error: unknown) => error);
    assert.ok(refused instanceof Error, `${one.name} must reject`);
    assert.equal(refused.message, one.refusal, `${one.name} names the refusal the launch carried`);
    assert.equal(
      refused.cause instanceof Error ? refused.cause.message : null,
      one.classCode,
      `${one.name} keeps the seam's own class on the chain`,
    );
    // A launch that named nothing bounded is still exactly one class: its own code, and no
    // invented name beside it.
    const unnamed = await one.decision(null).catch((error: unknown) => error);
    assert.ok(unnamed instanceof Error, `${one.name} must reject`);
    assert.equal(unnamed.message, one.classCode, `${one.name} answers its class when nothing was named`);
    assert.equal(unnamed.cause, undefined, `${one.name} invents no cause`);
  }
});

test("the boot reconcile line counts what it examined and prints a counted zero", () => {
  assert.equal(
    formatStardewBootstrapRegistrationReconcile({ examined: 0, released: 0, finalised: 0, records: [] }),
    "GameBuddy Stardew bootstrap registration reconcile: examined 0, released 0, finalised 0",
  );
  assert.equal(
    formatStardewBootstrapRegistrationReconcile({
      examined: 3,
      released: 1,
      finalised: 1,
      records: [
        { bootstrapCorrelation: "bootstrap-1", outcome: "released", finalisation: null },
        {
          bootstrapCorrelation: "bootstrap-2",
          outcome: "finalised",
          finalisation: "ai_settled_player_preserved",
        },
        { bootstrapCorrelation: "bootstrap-3", outcome: "kept_objects_present", finalisation: null },
      ],
    }),
    "GameBuddy Stardew bootstrap registration reconcile: examined 3, released 1, finalised 1 [bootstrap-1:released,bootstrap-2:finalised:ai_settled_player_preserved,bootstrap-3:kept_objects_present]",
  );
});

test("the coordinator binds the boot reconcile to the production OS probe, and both boots run it before they serve", async () => {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const coordinatorSource = readSourceShape(join(moduleRoot, "stardew-production-lifecycle-coordinator.internal.ts"));
  // The production probe is bound here, once: a boot that could not ask the OS
  // would leave every held pointer exactly where it is. Two halves, both read from
  // the source: the lifecycle asks its platform for the probe, and the platform is
  // the production OS probe rather than a stand-in.
  assert.match(
    coordinatorSource.shape,
    /reconcileHeldBootstrapRegistration: \(\) => internal\.reconcileHeldBootstrapRegistration\(runtimeRoot, platform\.guardian\.probeNamedObjects\)/u,
  );
  assert.match(
    coordinatorSource.shape,
    /guardian: Object\.freeze\(\{ probeNamedObjects: probeWindowsStardewGuardianObjects \}\)/u,
  );
  const providerSource = await readFile(join(moduleRoot, "games", "stardew", "provider.ts"), "utf8");
  const boot = providerSource.slice(providerSource.indexOf("async createLifecycleCoordinator"));
  const reconcileCall = boot.indexOf("await coordinator.reconcileHeldBootstrapRegistration()");
  assert.notEqual(reconcileCall, -1, "the desktop boot runs the reconcile");
  assert.ok(
    reconcileCall < boot.indexOf("return Object.freeze({"),
    "the reconcile runs before the lifecycle capability is published",
  );
  const mainSource = readSourceShape(join(moduleRoot, "main.ts"));
  assert.match(mainSource.shape, /await coordinator\.reconcileHeldBootstrapRegistration\(\)/u);
});

/**
 * The Desktop Guardian session whose arm step refuses with `refusal`.
 *
 * The Guardian is the boundary this test does not own; the arm refusal is the fact under test, so
 * every step that must never run after it records instead of pretending to succeed.
 */
function sessionRefusingToArm(refusal: string, calls: string[]): DesktopGuardianSession {
  return Object.freeze({
    async arm() {
      calls.push("arm");
      throw new Error(refusal);
    },
    async launch() {
      calls.push("launch");
      throw new Error("a refused arm must never reach the launch step");
    },
    async contain() {
      calls.push("contain");
      throw new Error("a refused arm must never reach the contain step");
    },
    async recover() {
      calls.push("recover");
      throw new Error("a refused arm must never reach the recovery step");
    },
    async close() {
      calls.push("close");
    },
  });
}

/**
 * Presses the surface's own three steps over the composed wire - activate, prerequisites, launch -
 * and answers the launch's refusal exactly as the panel receives it.
 */
async function pressLaunchOverTheWire(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const { origin, cookie, csrfToken } = fixture.broker;
  const base = `${origin}/api/composed-reference-game/v1`;
  const headers = Object.freeze({
    origin,
    cookie,
    "x-csrf-token": csrfToken,
    "content-type": "application/json",
  });
  assert.equal((await fetch(`${base}/lifecycle/activate`, { method: "POST", headers })).status, 204);
  assert.equal(
    (
      await fetch(`${base}/game/prerequisites/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ apiVersion: 1, idempotencyKey: "ABEiM0RVZneImaq7zN3u_w" }),
      })
    ).status,
    204,
  );
  const launched = await fetch(`${base}/game/launch`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      apiVersion: 1,
      idempotencyKey: "BCEiM0RVZneImaq7zN3u_w",
      expectedInstanceGeneration: 1,
    }),
  });
  return Object.freeze({ status: launched.status, body: await launched.json() });
}

test("a Player Host launch the Guardian refused while arming names that refusal instead of only the wrapper", async () => {
  // Measured 2026-11-23 (`.tmp/lane-gen2end.md` §3g): the retry after a crash answered
  // `409 game_unavailable (cause: stardew_player_host_launch_failed)` and nothing else, while no
  // game process ever appeared - so the refusal was one made before anything was started, and the
  // surface could not say by what. The wire spells its own arm refusals
  // `<wrapper><code>`, which is not a bounded code, so the projection above the launch dropped the
  // one fact the refusal carried.
  const cases = [
    // A transport refusal is the one family "nothing was started" already has a word for.
    {
      refusal: `${DESKTOP_BOOTSTRAP_REFUSAL_PREFIX}guardian_pipe_unreachable`,
      body: { code: "game_launch_unreachable" },
    },
    // Every other bounded refusal travels as the cause and the wrapper keeps the code.
    {
      refusal: `${DESKTOP_BOOTSTRAP_REFUSAL_PREFIX}guardian_command_input_invalid`,
      body: { code: "game_unavailable", cause: "guardian_command_input_invalid" },
    },
  ];
  for (const one of cases) {
    await withWindowsPlatform(async () => {
      const calls: string[] = [];
      const fixture = await createFixture({
        overrides: {
          runtimeLaunchContained: createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
            createDesktopGuardianGameRuntimePlatform(sessionRefusingToArm(one.refusal, calls)),
          ),
        },
      });
      try {
        const launched = await pressLaunchOverTheWire(fixture);
        assert.equal(launched.status, 409);
        assert.deepEqual(launched.body, one.body, `${one.refusal} must answer the name it refused under`);
        // Nothing was launched: the arm was the only step that ran, and no game process exists.
        assert.deepEqual(calls, ["arm"]);
        assert.equal(fixture.playerSpawnCalls.length, 0);
      } finally {
        await fixture.coordinator.close();
        await fixture.broker.close();
      }
    });
  }
});

test("a Player Host launch that fails with an OS message keeps the wrapper on the wire and the text in the Host's log", async () => {
  // The other half of the same projection: an OS message is prose, not a token that may cross. It
  // must therefore change nothing the panel sees - and it must not be lost either, so the launch's
  // own failure line is the reading that keeps it.
  const osMessage = "spawn E:\\Steam\\Stardew Valley\\StardewModdingAPI.exe ENOENT";
  const logged: string[] = [];
  const realConsoleError = console.error;
  console.error = ((...parts: unknown[]) => {
    logged.push(parts.map((part) => String(part)).join(" "));
  }) as typeof console.error;
  try {
    await withWindowsPlatform(async () => {
      const calls: string[] = [];
      const fixture = await createFixture({
        overrides: {
          runtimeLaunchContained: createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
            createDesktopGuardianGameRuntimePlatform(sessionRefusingToArm(osMessage, calls)),
          ),
        },
      });
      try {
        const launched = await pressLaunchOverTheWire(fixture);
        assert.equal(launched.status, 409);
        assert.deepEqual(launched.body, {
          code: "game_unavailable",
          cause: "stardew_player_host_launch_failed",
        });
        const body = JSON.stringify(launched.body);
        for (const fragment of ["Steam", "ENOENT", "spawn", "StardewModdingAPI"])
          assert.equal(body.includes(fragment), false, `"${fragment}" reached a wire field`);
        assert.equal(
          logged.some((line) => line.includes(`GameBuddy Stardew Player Host launch failed: ${osMessage}`)),
          true,
          "the failure's text was dropped instead of written to the Host's own log",
        );
      } finally {
        await fixture.coordinator.close();
        await fixture.broker.close();
      }
    });
  } finally {
    console.error = realConsoleError;
  }
});
