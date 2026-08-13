import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createUnmountedDialogueSemanticFacade } from "./continuity-semantic-deployment-composition.js";
import { constructTestKnownUnmountedGameSemanticFacade } from "./continuity-semantic-game-facade.test-support.js";
import { createTestGameRuntimeMaterializer } from "../continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.test-support.js";
import { createGameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { createKnownSemanticGameProductionAuthorityFromDeploymentManifest } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js";
import { createIntegrationActionCatalog, type GameIntegrationModule } from "../integration-module.js";
import { RECEIPT_BACKED_INTEGRATION_AUTHORITY, type IntegrationLaunchHandle } from "../integration-launcher.js";
import type { ConfigurableIntegrationLauncher } from "../integration-catalog.js";
import type { IntegrationConnection } from "../integration-types.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const principal = { continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "s4-compose-")),
    runtimeRoot = join(root, "runtime"),
    manifestPath = join(root, "manifest.json");
  await mkdir(runtimeRoot);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      topology: "dialogue_initializes_game_opens",
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
    "integration-bootstrap",
    "production-game-continuity",
    "continuity.js",
    "main.js",
    "dialogue-web-main",
    "createCompanionRuntime(",
  ])
    assert.equal(internalSource.includes(segment), false, `facade internal forbidden ingress: ${segment}`);
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
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifestPath: f.manifestPath,
          launcher: selected,
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(
        JSON.parse(await (await import("node:fs/promises")).readFile(f.manifestPath, "utf8")),
      );
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
      assert.deepEqual(Object.keys(g).sort(), ["authority", "close", "runEnter"]);
      assert.deepEqual(await g.runEnter(), { state: "active" });
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
  "failed return remains durable recovery and refuses reverse closure",
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
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifestPath: f.manifestPath,
          launcher: selected,
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(
        JSON.parse(await (await import("node:fs/promises")).readFile(f.manifestPath, "utf8")),
      );
      const g = constructTestKnownUnmountedGameSemanticFacade(
        binding,
        game,
        createTestGameRuntimeMaterializer(async () =>
          Object.freeze({
            session: Object.freeze({
              dispose: () => {
                throw new Error("dispose_failed");
              },
            }),
          }),
        ),
      );
      await g.runEnter();
      await assert.rejects(g.close(), /game_runtime_materialization_close_failed/);
      await assert.rejects(g.close(), /recovery_required/);
      await assert.rejects(g.runEnter(), /unavailable/);
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
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifestPath: f.manifestPath,
          launcher: launcher(),
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(
        JSON.parse(await (await import("node:fs/promises")).readFile(f.manifestPath, "utf8")),
      );
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
      binding = await createGameRuntimeBinding(
        Object.freeze({
          manifestPath: f.manifestPath,
          launcher: launcher(),
          launcherConfig: null,
          configDirectory: process.cwd(),
        }),
      );
      game = await createKnownSemanticGameProductionAuthorityFromDeploymentManifest(
        JSON.parse(await (await import("node:fs/promises")).readFile(f.manifestPath, "utf8")),
      );
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
