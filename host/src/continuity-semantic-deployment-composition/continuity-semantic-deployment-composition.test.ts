import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createGameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { createTestGameRuntimeMaterializer } from "../continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.test-support.js";
import { createKnownSemanticGameProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import type { ConfigurableIntegrationLauncher } from "../integration-catalog.js";
import { type IntegrationLaunchHandle, RECEIPT_BACKED_INTEGRATION_AUTHORITY } from "../integration-launcher.js";
import { createIntegrationActionCatalog, type GameIntegrationModule } from "../integration-module.js";
import type { IntegrationConnection } from "../integration-types.js";
import {
  createUnmountedDialogueInitialChatResumeFacade,
  createUnmountedDialogueSemanticFacade,
} from "./continuity-semantic-deployment-composition.js";
import { constructTestKnownUnmountedGameSemanticFacade } from "./continuity-semantic-game-facade.test-support.js";

const principal = { continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "s4-compose-")),
    runtimeRoot = join(root, "runtime"),
    manifestPath = join(root, "manifest.json");
  await mkdir(runtimeRoot);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  return { root, manifestPath };
}
function launcher(): ConfigurableIntegrationLauncher {
  const module: GameIntegrationModule = {
    descriptor: { integrationId: "test-arcade", version: "fixture-v1", toolNamePrefix: "arcade_" },
    actionCatalog: createIntegrationActionCatalog([
      {
        actionId: "activate",
        familyId: "interaction",
        actionClass: "primitive",
        lifecycle: "published",
        label: "Activate",
        description: "Activate",
        targetKinds: ["console"],
        requiredCapability: "activate",
      },
    ]),
    defaultPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
    parsePolicy: (value) => value as never,
    assertIdentityBinding: (_connection, identity) => {
      if (
        identity.playerId !== principal.playerId ||
        identity.companionId !== principal.companionId ||
        identity.saveId !== "save_01" ||
        identity.worldId !== "world_01"
      )
        throw new Error("identity_drift");
    },
    worldScope: () => Object.freeze({ integrationId: "test-arcade", saveId: "save_01", worldId: "world_01" }),
    createToolSet: () => ({
      observation: [],
      actions: [
        defineTool({
          name: "arcade_activate",
          label: "Activate",
          description: "Activate",
          parameters: Type.Object({}),
          execute: async () => ({ content: [], details: {} }),
        }),
      ],
      knowledge: [],
    }),
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    readState: () => ({
      connected: true,
      sessionId: "session_01",
      capabilities: ["activate"],
      snapshotRevision: 1,
      activeExecution: null,
      latestReceipt: null,
      latestReasonCode: null,
    }),
    status: () => ({
      connected: true,
      capabilities: ["activate"],
      snapshotRevision: 1,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    cancelExecution: () => undefined,
    parseReceipt: () => null,
    actionIdForToolName: (name) => (name === "arcade_activate" ? "activate" : null),
    isCancellationTool: () => false,
  };
  const connection: IntegrationConnection = {
    scope: { integrationId: "test-arcade" },
    module,
    state: Object.freeze({ connected: true }),
    executionGate: { executable: true },
  };
  const handle: IntegrationLaunchHandle = {
    connection,
    events: { onFact: () => () => undefined, onLifecycle: () => () => undefined },
    authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
    lifecycle: "ready",
    initialFacts: [{ source: "fixture", kind: "snapshot", correlationId: "snapshot_01", revision: 1, payload: {} }],
    revoke: () => undefined,
    close: () => undefined,
  };
  return {
    integrationId: "test-arcade",
    module,
    prepare: async () =>
      Object.freeze({
        launchConfig: Object.freeze({}),
        identityScope: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
      }),
    launch: async () => handle,
  };
}
test("unmounted Dialogue exposes no holder/raw identity while Game has no public construction route", async () => {
  const f = await fixture();
  try {
    const d = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath }));
    assert.deepEqual(Object.keys(d).sort(), ["authority", "close", "initializeInitialChat", "resumeInitialChat"]);
    const initialized = await d.initializeInitialChat();
    assert.equal(initialized.phase, "selected");
    assert.deepEqual(await d.resumeInitialChat(), initialized);
    await d.close();
    const publicModule = await import("./continuity-semantic-deployment-composition.js");
    assert.equal("createUnmountedGameSemanticFacade" in publicModule, false);
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("Game facade graph keeps construction-only dependencies private", async () => {
  const { readFile } = await import("node:fs/promises"),
    { dirname, resolve } = await import("node:path"),
    { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/continuity-semantic-deployment-composition");
  const publicSource = await readFile(join(root, "continuity-semantic-deployment-composition.ts"), "utf8"),
    internalSource = await readFile(join(root, "continuity-semantic-game-facade.internal.ts"), "utf8"),
    testSupport = await readFile(join(root, "continuity-semantic-game-facade.test-support.ts"), "utf8");
  for (const segment of [
    "test-support",
    "createTestGameRuntimeMaterializer",
    "createCompanionRuntime(",
    "createGameRuntimeBinding",
    "createHostGameRuntimeMaterializer",
    "createKnownSemanticGameProductionAuthority",
  ])
    assert.equal(publicSource.includes(segment), false, `public production facade ingress: ${segment}`);
  for (const segment of [
    "ChatOrigin",
    "returnPermit",
    "teardownReturn",
    "integration-bootstrap",
    "continuity.js",
    "main.js",
    "dialogue-web-main",
    "createCompanionRuntime(",
  ])
    assert.equal(internalSource.includes(segment), false, `facade internal forbidden ingress: ${segment}`);
  assert.match(
    internalSource,
    /from "\.\.\/continuity-semantic-production-coordinator\/continuity-semantic-production-coordinator\.js"/,
  );
  assert.doesNotMatch(internalSource, /continuity-semantic-production-coordinator\.internal\.js/);
  assert.equal(testSupport.includes("constructKnownUnmountedGameSemanticFacade"), true);
});

test(
  "known-open Game composes unlocked enter and internal close-return without leaking authority",
  { skip: process.platform !== "win32" ? "requires concrete Windows binding" : false },
  async () => {
    const f = await fixture();
    let binding: Awaited<ReturnType<typeof createGameRuntimeBinding>> | undefined;
    let game: Awaited<ReturnType<typeof createKnownSemanticGameProductionAuthorityFromDeploymentManifest>> | undefined;
    try {
      const d = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath }));
      await d.initializeInitialChat();
      await d.close();
      const selected = launcher();
      const manifest = await loadHostDeploymentManifest(f.manifestPath);
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifest,
          launcher: selected,
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
      let disposed = 0;
      const g = constructTestKnownUnmountedGameSemanticFacade(
        binding,
        game,
        createTestGameRuntimeMaterializer(async () =>
          Object.freeze({
            session: Object.freeze({
              dispose: () => {
                disposed += 1;
              },
            }),
          }),
        ),
      );
      assert.deepEqual(Object.keys(g).sort(), ["authority", "close", "recoverDeadOwner", "runEnter"]);
      const lease = await g.runEnter();
      assert.deepEqual(Object.keys(lease).sort(), [
        "activateCommittedIngress",
        "gameSessionId",
        "host",
        "lifecycleSnapshot",
        "piSessionId",
      ]);
      assert.equal(lease.piSessionId, "pi_session_test_01");
      assert.equal(typeof lease.host.close, "function");
      assert.equal(lease.lifecycleSnapshot().surface, "active");
      await g.close();
      assert.equal(disposed, 1);
    } finally {
      if (game) await game.close().catch(() => undefined);
      if (binding) await binding.close().catch(() => undefined);
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "failed teardown retains exact live runtime and permit for same-facade retry",
  { skip: process.platform !== "win32" ? "requires concrete Windows binding" : false },
  async () => {
    const f = await fixture();
    let binding: Awaited<ReturnType<typeof createGameRuntimeBinding>> | undefined;
    let game: Awaited<ReturnType<typeof createKnownSemanticGameProductionAuthorityFromDeploymentManifest>> | undefined;
    try {
      const d = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath }));
      await d.initializeInitialChat();
      await d.close();
      const selected = launcher();
      const manifest = await loadHostDeploymentManifest(f.manifestPath);
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifest,
          launcher: selected,
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
      let disposeCalls = 0;
      const g = constructTestKnownUnmountedGameSemanticFacade(
        binding,
        game,
        createTestGameRuntimeMaterializer(async () =>
          Object.freeze({
            session: Object.freeze({
              dispose: () => {
                disposeCalls += 1;
                if (disposeCalls === 1) throw new Error("dispose_failed");
              },
            }),
          }),
        ),
      );
      await g.runEnter();
      await assert.rejects(g.close(), /game_runtime_materialization_close_failed/);
      // The same facade retains its exact runtime/permit; no new Game may
      // enter between attempts and the second teardown settles that permit.
      await assert.rejects(g.runEnter(), /unavailable/);
      await g.close();
      assert.equal(disposeCalls, 2);
    } finally {
      if (game) await game.close().catch(() => undefined);
      if (binding) await binding.close().catch(() => undefined);
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "failed durable enter transition seals the facade and prevents reverse closure",
  { skip: process.platform !== "win32" ? "requires concrete Windows binding" : false },
  async () => {
    const f = await fixture();
    let binding: Awaited<ReturnType<typeof createGameRuntimeBinding>> | undefined;
    let game: Awaited<ReturnType<typeof createKnownSemanticGameProductionAuthorityFromDeploymentManifest>> | undefined;
    try {
      const d = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath }));
      await d.initializeInitialChat();
      await d.close();
      const manifest = await loadHostDeploymentManifest(f.manifestPath);
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifest,
          launcher: launcher(),
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
      let bindingClosed = 0,
        gameClosed = 0;
      const trappedGame = Object.freeze({
          ...game,
          failEnter: async () => {
            throw new Error("fail_enter_fault");
          },
          close: async () => {
            gameClosed += 1;
            return game!.close();
          },
        }),
        trappedBinding = Object.freeze({
          ...binding,
          close: async () => {
            bindingClosed += 1;
            return binding!.close();
          },
        });
      const g = constructTestKnownUnmountedGameSemanticFacade(
        trappedBinding,
        trappedGame,
        createTestGameRuntimeMaterializer(async () => {
          throw new Error("materialize_fault");
        }),
      );
      await assert.rejects(g.runEnter(), /materialize_fault/);
      await assert.rejects(g.close(), /recovery_required/);
      await assert.rejects(g.runEnter(), /unavailable/);
      assert.equal(bindingClosed, 0);
      assert.equal(gameClosed, 0);
    } finally {
      if (game) await game.close().catch(() => undefined);
      if (binding) await binding.close().catch(() => undefined);
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test(
  "facade reverse-closes Game authority before runtime binding",
  { skip: process.platform !== "win32" ? "requires concrete Windows binding" : false },
  async () => {
    const f = await fixture();
    let binding: Awaited<ReturnType<typeof createGameRuntimeBinding>> | undefined;
    let game: Awaited<ReturnType<typeof createKnownSemanticGameProductionAuthorityFromDeploymentManifest>> | undefined;
    try {
      const d = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath }));
      await d.initializeInitialChat();
      await d.close();
      const manifest = await loadHostDeploymentManifest(f.manifestPath);
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifest,
          launcher: launcher(),
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(manifest);
      const events: string[] = [];
      const orderedGame = Object.freeze({
          ...game,
          close: async () => {
            events.push("game");
            return game!.close();
          },
        }),
        orderedBinding = Object.freeze({
          ...binding,
          close: async () => {
            events.push("binding");
            return binding!.close();
          },
        });
      const g = constructTestKnownUnmountedGameSemanticFacade(
        orderedBinding,
        orderedGame,
        createTestGameRuntimeMaterializer(async () =>
          Object.freeze({ session: Object.freeze({ dispose: () => undefined }) }),
        ),
      );
      await g.runEnter();
      await g.close();
      assert.deepEqual(events, ["game", "binding"]);
    } finally {
      if (game) await game.close().catch(() => undefined);
      if (binding) await binding.close().catch(() => undefined);
      await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);

test("P7 Task 5 characterization: fresh semantic Chat construction cannot reopen an already-provisioned authority root; the rejected re-open creates no new chat/opening/player message", async () => {
  const f = await fixture();
  try {
    const first = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath }));
    assert.deepEqual(Object.keys(first).sort(), ["authority", "close", "initializeInitialChat", "resumeInitialChat"]);
    const initialized = await first.initializeInitialChat();
    assert.equal(initialized.phase, "selected");
    const beforeReopen = await first.resumeInitialChat();
    assert.deepEqual(beforeReopen, initialized);
    // A second fresh construction over the same manifest/runtime root must fail
    // closed: the authority root already exists and is never reopened.
    await assert.rejects(
      createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath })),
      /production_authority_artifact_present/,
    );
    // The rejected re-open must not have created a second Chat/opening/player
    // message: the live facade re-reads the exact same saga readback.
    const afterReopen = await first.resumeInitialChat();
    assert.deepEqual(afterReopen, beforeReopen);
    await first.close();
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("P7 Task 5 characterization: initial-chat resume facade is saga/content-only without startMountedChatRuntime, and legacy roots are refused instead of adopted", async () => {
  const f = await fixture();
  const legacy = join(f.root, "legacy-runtime");
  await mkdir(legacy);
  const legacyArtifact = join(legacy, "companion-continuity.json");
  const legacyPayload = '{"legacy":true}';
  await writeFile(legacyArtifact, legacyPayload);
  const legacyManifest = join(f.root, "legacy-manifest.json");
  await writeFile(
    legacyManifest,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot: legacy,
      principal,
      bootstrapOperationId: "bootstrap_legacy_01",
      authorityGeneration: 1,
    }),
  );
  try {
    const first = await createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: f.manifestPath }));
    await first.initializeInitialChat();
    await first.close();
    // The known initial-chat resume lane is saga/content-only and fails closed
    // against an already-selected saga: it can never take over a completed
    // opening, so no runtime-mounted Chat is reachable through it.
    await assert.rejects(
      createUnmountedDialogueInitialChatResumeFacade(Object.freeze({ manifestPath: f.manifestPath })),
      /initial_chat_known_open_saga_selected/,
    );
    // Surface characterization in this suite's source-inspection style: the
    // resume composition binds only the saga readback lane and close, and no
    // runtime-mounting constructor exists at the deployment-composition level.
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const folder = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/continuity-semantic-deployment-composition",
    );
    const compositionSource = readFileSync(join(folder, "continuity-semantic-deployment-composition.ts"), "utf8");
    assert.equal(compositionSource.includes("resumeInitialChat(): Promise<ProductionSagaReadback | null>;"), true);
    assert.equal(compositionSource.includes("resumeInitialChatWithContent(content)"), true);
    assert.equal(compositionSource.includes("startMountedChatRuntime"), false);
    assert.equal(compositionSource.includes("createFreshUnmountedChatSemanticFacade"), false);
    // The runtime-mounting Chat constructor is not reachable from the public
    // deployment composition; no existing seam reopens a provisioned root.
    const publicModule = await import("./continuity-semantic-deployment-composition.js");
    assert.equal("createFreshUnmountedChatSemanticFacade" in publicModule, false);
    assert.equal("startMountedChatRuntime" in publicModule, false);
    // A runtime root that carries legacy continuity artifacts is refused, not
    // migrated/adopted; no authority directory is created and the legacy file
    // is untouched (no fallback/legacy path is used).
    await assert.rejects(
      createUnmountedDialogueSemanticFacade(Object.freeze({ manifestPath: legacyManifest })),
      /legacy_authority_artifact_present/,
    );
    assert.equal(existsSync(join(legacy, ".gamebuddy-semantic-continuity-v1")), false);
    assert.equal(readFileSync(legacyArtifact, "utf8"), legacyPayload);
  } finally {
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
