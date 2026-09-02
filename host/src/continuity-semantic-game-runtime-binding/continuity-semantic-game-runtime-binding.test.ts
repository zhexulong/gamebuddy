import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type HostDeploymentManifest, loadHostDeploymentManifest } from "../deployment-manifest.js";
import type { ConfigurableIntegrationLauncher } from "../integration-catalog.js";
import { type IntegrationLaunchHandle, RECEIPT_BACKED_INTEGRATION_AUTHORITY } from "../integration-launcher.js";
import { createIntegrationActionCatalog, type GameIntegrationAdapter } from "../game-integration-adapter.js";
import type { GameConnection } from "../game-connection.js";
import type { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import {
  brandRuntimeOwnerIdentity,
  consumeBindingToken,
  mintBindingToken,
  mintGameRuntimeBindingFacts,
  reserveGameRuntimeMaterialization,
  withConsumedBindingExecution,
} from "./continuity-semantic-game-runtime-binding.internal.js";
import {
  assertStableGameRuntimeBindingIdentity,
  createGameRuntimeBinding,
  createGameRuntimeBindingFromReceiptBackedLaunch,
  createStableGameRuntimeBindingIdentity,
  createStardewRecoveryBindingContext,
  createWindowsRuntimeOwnerIdentityPort,
  readStardewRecoveryBindingContext,
} from "./continuity-semantic-game-runtime-binding.js";

const principal = { continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" } as const;

function fixture(
  onClose: () => void,
  onRevoke: () => void,
  integrationId = "test-arcade",
): { launcher: ConfigurableIntegrationLauncher; handle: IntegrationLaunchHandle } {
  const module: GameIntegrationAdapter = {
    descriptor: { integrationId, version: "fixture-v1", toolNamePrefix: "arcade_" },
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
    actorId: () => principal.playerId,
    assertIdentityBinding: (_connection, identity) => {
      if (
        identity.companionId !== principal.companionId ||
        identity.saveId !== "save_01" ||
        identity.worldId !== "world_01"
      )
        throw new Error("identity_drift");
    },
    worldScope: () => Object.freeze({ integrationId, saveId: "save_01", worldId: "world_01" }),
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
      capabilityRevision: 1,
      registrations: [{ actionId: "activate", familyId: "interaction", identityVersion: 1, lifecycle: "published", kind: "execution" }],
      catalogRevision: 1,
      enabledActionIds: ["activate"],
      snapshotRevision: 1,
      activeExecution: null,
      latestReceipt: null,
      latestReasonCode: null,
    }),
    status: () => ({
      connected: true,
      capabilities: ["activate"],
      capabilityRevision: 1,
      snapshotRevision: 1,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    cancelExecution: () => undefined,
    parseReceipt: () => null,
    actionIdForToolName: (name) => (name === "arcade_activate" ? "activate" : null),
    isCancellationTool: () => false,
  };
  const connection: GameConnection = {
    scope: { integrationId },
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
    revoke: onRevoke,
    close: onClose,
  };
  return {
    launcher: {
      integrationId,
      module,
      prepare: async () =>
        Object.freeze({
          launchConfig: Object.freeze({ prepared: true }),
          identityScope: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
        }),
      launch: async (request) => {
        if (
          request.identity.continuityId !== principal.continuityId ||
          request.identity.playerId !== principal.playerId ||
          request.identity.companionId !== principal.companionId ||
          request.identity.saveId !== "save_01" ||
          request.identity.worldId !== "world_01"
        ) {
          throw new Error("scoped_identity_required");
        }
        return handle;
      },
    },
    handle,
  };
}

async function manifest(): Promise<HostDeploymentManifest> {
  const root = await mkdtemp(join(tmpdir(), "game-runtime-binding-"));
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  const path = join(root, "manifest.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
  );
  return loadHostDeploymentManifest(path);
}

test("mints an opaque one-shot token and exposes only executeWithBinding/close", async () => {
  let revoked = 0;
  let closed = 0;
  const { launcher } = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  const binding = await createGameRuntimeBinding({
    manifest: await manifest(),
    launcher,
    launcherConfig: { opaque: true },
    configDirectory: process.cwd(),
  });
  assert.deepEqual(Object.keys(binding).sort(), ["close", "executeWithBinding"]);
  let saved: Parameters<Parameters<typeof binding.executeWithBinding>[0]>[0] | undefined;
  await binding.executeWithBinding((token) => {
    saved = token;
    assert.deepEqual(Reflect.ownKeys(token), []);
    assert.throws(() => consumeBindingToken({}), /invalid_game_runtime_binding/);
    const execution = consumeBindingToken(token);
    assert.equal(execution.world.worldId, "world_01");
    assert.match(execution.bindingFacts.bindingDigest, /^[a-f0-9]{64}$/);
    assert.match(execution.bindingFacts.runtimeInstanceId, /^[A-Za-z0-9_-]{1,128}$/);
    assert.match(execution.bindingFacts.owner.ownerToken, /^[A-Za-z0-9_-]{1,128}$/);
    assert.equal(execution.bindingFacts.owner.runtimeInstanceId, execution.bindingFacts.runtimeInstanceId);
    assert.equal(execution.bindingFacts.owner.ownerPid, process.pid);
    assert.ok(Object.isFrozen(execution.bindingFacts));
    assert.ok(Object.isFrozen(execution.bindingFacts.owner));
  });
  assert.throws(() => consumeBindingToken(saved), /replay_rejected/);
  await binding.close();
  await binding.close();
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("mints the same one-shot binding from an existing receipt-backed launch", async (t) => {
  if (process.platform !== "win32") {
    t.skip("receipt-backed runtime binding requires Windows owner identity");
    return;
  }
  let revoked = 0;
  let closed = 0;
  const current = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  const binding = await createGameRuntimeBindingFromReceiptBackedLaunch(
    Object.freeze({
      manifest: await manifest(),
      launcher: current.launcher,
      launch: current.handle,
      expectedWorld: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
    }),
  );
  await binding.executeWithBinding((token) => {
    const execution = consumeBindingToken(token);
    assert.equal(execution.connection, current.handle.connection);
    assert.equal(execution.world.saveId, "save_01");
    assert.equal(execution.world.worldId, "world_01");
    assert.equal(execution.principal.playerId, principal.playerId);
    assert.match(execution.bindingFacts.bindingDigest, /^[a-f0-9]{64}$/);
  });
  await binding.close();
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("receipt-backed binding rejects world drift and closes the exact launch", async (t) => {
  if (process.platform !== "win32") {
    t.skip("receipt-backed runtime binding requires Windows owner identity");
    return;
  }
  let revoked = 0;
  let closed = 0;
  const current = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  await assert.rejects(
    createGameRuntimeBindingFromReceiptBackedLaunch(
      Object.freeze({
        manifest: await manifest(),
        launcher: current.launcher,
        launch: current.handle,
        expectedWorld: Object.freeze({ saveId: "save_01", worldId: "foreign_world" }),
      }),
    ),
    /identity_drift/,
  );
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("receipt-backed binding rejects a non-exact world input and closes the exact launch", async (t) => {
  if (process.platform !== "win32") {
    t.skip("receipt-backed runtime binding requires Windows owner identity");
    return;
  }
  let revoked = 0;
  let closed = 0;
  const current = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  await assert.rejects(
    createGameRuntimeBindingFromReceiptBackedLaunch(
      Object.freeze({
        manifest: await manifest(),
        launcher: current.launcher,
        launch: current.handle,
        expectedWorld: Object.freeze({ saveId: "save_01", worldId: "world_01", hidden: true }),
      }) as never,
    ),
    /invalid_receipt_backed_game_runtime_binding_input/,
  );
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("mints distinct immutable per-launch facts", async () => {
  const firstFixture = fixture(
    () => undefined,
    () => undefined,
  );
  const secondFixture = fixture(
    () => undefined,
    () => undefined,
  );
  const first = await createGameRuntimeBinding({
    manifest: await manifest(),
    launcher: firstFixture.launcher,
    launcherConfig: null,
    configDirectory: process.cwd(),
  });
  const second = await createGameRuntimeBinding({
    manifest: await manifest(),
    launcher: secondFixture.launcher,
    launcherConfig: null,
    configDirectory: process.cwd(),
  });
  let firstFacts: ReturnType<typeof consumeBindingToken>["bindingFacts"] | undefined;
  let secondFacts: ReturnType<typeof consumeBindingToken>["bindingFacts"] | undefined;
  await first.executeWithBinding((token) => {
    firstFacts = consumeBindingToken(token).bindingFacts;
  });
  await second.executeWithBinding((token) => {
    secondFacts = consumeBindingToken(token).bindingFacts;
  });
  assert.notEqual(firstFacts!.runtimeInstanceId, secondFacts!.runtimeInstanceId);
  assert.notEqual(firstFacts!.owner.ownerToken, secondFacts!.owner.ownerToken);
  assert.notEqual(firstFacts!.bindingDigest, secondFacts!.bindingDigest);
  await first.close();
  await second.close();
});

test("rejects reentrant execution and repeated or post-close callback execution", async () => {
  let saved:
    | Parameters<Parameters<Awaited<ReturnType<typeof createGameRuntimeBinding>>["executeWithBinding"]>[0]>[0]
    | undefined;
  let nested: Promise<unknown> | undefined;
  let revoked = 0;
  let closed = 0;
  const { launcher } = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  const binding = await createGameRuntimeBinding({
    manifest: await manifest(),
    launcher,
    launcherConfig: null,
    configDirectory: process.cwd(),
  });
  await binding.executeWithBinding((token) => {
    saved = token;
    nested = binding.executeWithBinding(() => undefined);
  });
  assert(nested !== undefined);
  await assert.rejects(nested, /unavailable/);
  assert(saved !== undefined);
  assert.throws(() => {
    const attempt = withConsumedBindingExecution(saved, () => undefined);
    attempt.catch(() => undefined);
  }, /replay_rejected/);
  assert.throws(() => consumeBindingToken(saved), /replay_rejected/);
  await assert.rejects(
    binding.executeWithBinding(() => undefined),
    /unavailable/,
  );
  await binding.close();
  await assert.rejects(
    binding.executeWithBinding(() => undefined),
    /unavailable/,
  );
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("rejects a launcher without adapter-owned prepare before launch", async () => {
  let launched = 0;
  const { launcher: baseLauncher } = fixture(
    () => undefined,
    () => undefined,
  );
  const launcher = {
    ...baseLauncher,
    prepare: undefined,
    launch: async (request: Parameters<ConfigurableIntegrationLauncher["launch"]>[0]) => {
      launched += 1;
      return baseLauncher.launch(request);
    },
  };
  await assert.rejects(
    createGameRuntimeBinding({
      manifest: await manifest(),
      launcher,
      launcherConfig: null,
      configDirectory: process.cwd(),
    } as never),
    /invalid_game_runtime_binding_input/,
  );
  assert.equal(launched, 0);
});

test("does not launch when adapter-owned prepare rejects", async () => {
  let launched = 0;
  const { launcher: baseLauncher } = fixture(
    () => undefined,
    () => undefined,
  );
  const launcher = {
    ...baseLauncher,
    prepare: async () => {
      throw new Error("operator_config_rejected");
    },
    launch: async (request: Parameters<ConfigurableIntegrationLauncher["launch"]>[0]) => {
      launched += 1;
      return baseLauncher.launch(request);
    },
  } as ConfigurableIntegrationLauncher;
  await assert.rejects(
    createGameRuntimeBinding({
      manifest: await manifest(),
      launcher,
      launcherConfig: null,
      configDirectory: process.cwd(),
    }),
    /operator_config_rejected/,
  );
  assert.equal(launched, 0);
});

test("rejects owner-proof injection before launch", async () => {
  let launched = 0;
  const { launcher: baseLauncher } = fixture(
    () => undefined,
    () => undefined,
  );
  const launcher = {
    ...baseLauncher,
    launch: async (request: Parameters<ConfigurableIntegrationLauncher["launch"]>[0]) => {
      launched += 1;
      return baseLauncher.launch(request);
    },
  };
  await assert.rejects(
    createGameRuntimeBinding({
      manifest: await manifest(),
      launcher,
      launcherConfig: null,
      configDirectory: process.cwd(),
      ownerIdentityPort: { createCurrentProcessOwnerIdentity: async () => ({}) },
    } as never),
    /invalid_game_runtime_binding_input/,
  );
  assert.equal(launched, 0);
});

test("rejects a mutable adapter world scope and reverse-closes the launch", async () => {
  let revoked = 0;
  let closed = 0;
  const base = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  const mutableModule: GameIntegrationAdapter = {
    ...base.launcher.module,
    readState: (connection) => base.launcher.module.readState(connection),
    worldScope: () => ({ integrationId: "test-arcade", saveId: "save_01", worldId: "world_01" }),
  };
  const mutableHandle = { ...base.handle, connection: { ...base.handle.connection, module: mutableModule } };
  const mutableLauncher = {
    ...base.launcher,
    module: mutableModule,
    launch: async () => mutableHandle,
  } as ConfigurableIntegrationLauncher;
  await assert.rejects(
    createGameRuntimeBinding({
      manifest: await manifest(),
      launcher: mutableLauncher,
      launcherConfig: null,
      configDirectory: process.cwd(),
    }),
    /integration_world_scope_invalid/,
  );
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("rejects prepared scope drift and reverse-closes the launched adapter", async () => {
  let revoked = 0;
  let closed = 0;
  const base = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  const drifted = {
    ...base.launcher,
    prepare: async () =>
      Object.freeze({
        launchConfig: Object.freeze({ prepared: true }),
        identityScope: Object.freeze({ saveId: "save_02", worldId: "world_02" }),
      }),
    launch: async () => base.handle,
  } as ConfigurableIntegrationLauncher;
  await assert.rejects(
    createGameRuntimeBinding({
      manifest: await manifest(),
      launcher: drifted,
      launcherConfig: null,
      configDirectory: process.cwd(),
    }),
    /identity_drift|integration_world_scope_invalid/,
  );
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("rejects detached microtask lease admission immediately after a synchronous callback returns", async () => {
  const { launcher } = fixture(
    () => undefined,
    () => undefined,
  );
  const binding = await createGameRuntimeBinding({
    manifest: await manifest(),
    launcher,
    launcherConfig: null,
    configDirectory: process.cwd(),
  });
  let detached!: Promise<void>;
  await binding.executeWithBinding((token) =>
    withConsumedBindingExecution(token, (execution) => {
      detached = Promise.resolve().then(() => {
        assert.throws(() => reserveGameRuntimeMaterialization(execution), /game_runtime_binding_execution_rejected/);
      });
    }),
  );
  await detached;
  await binding.close();
});

test("rejects callback-reentrant close and lets external close drain once", async () => {
  let revoked = 0;
  let closed = 0;
  let finish!: () => void;
  let entered!: () => void;
  const { launcher } = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  const binding = await createGameRuntimeBinding({
    manifest: await manifest(),
    launcher,
    launcherConfig: null,
    configDirectory: process.cwd(),
  });
  const enteredCallback = new Promise<void>((resolveEntered) => {
    entered = resolveEntered;
  });
  const execution = binding.executeWithBinding(async () => {
    await assert.rejects(binding.close(), /game_runtime_binding_close_reentrant/);
    return new Promise<void>((resolveFinish) => {
      finish = resolveFinish;
      entered();
    });
  });
  await enteredCallback;
  const closing = binding.close();
  assert.equal(revoked, 0);
  assert.equal(closed, 0);
  finish();
  await execution;
  await closing;
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});

test("concrete creation-identity provider is platform-strict and opaque", async () => {
  const ownerPort = createWindowsRuntimeOwnerIdentityPort();
  if (process.platform !== "win32") {
    await assert.rejects(ownerPort.createCurrentProcessOwnerIdentity(), /windows_runtime_owner_identity_required/);
    return;
  }
  const proof = await ownerPort.createCurrentProcessOwnerIdentity();
  assert.deepEqual(Reflect.ownKeys(proof), []);
});

test("production binding source does not import forbidden legacy, store, facade, composition, or entrypoint seams", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/continuity-semantic-game-runtime-binding");
  const sources = await Promise.all([
    readFile(join(root, "continuity-semantic-game-runtime-binding.ts"), "utf8"),
    readFile(join(root, "continuity-semantic-game-runtime-binding.internal.ts"), "utf8"),
    readFile(join(root, "continuity-semantic-game-runtime-binding.windows-owner-identity.ts"), "utf8"),
  ]);
  const forbidden = [
    "integration-bootstrap",
    "continuity.js",
    "continuity-semantic-store",
    "deployment-composition",
    "production-coordinator",
    "-facade",
    "main.js",
    "dialogue-web-main",
  ];
  for (const source of sources)
    for (const segment of forbidden)
      assert.equal(source.includes(segment), false, `forbidden production ingress: ${segment}`);
  assert.equal(
    sources.some((source) => source.includes("loadHostDeploymentManifest")),
    false,
  );
  assert.equal(sources[0]!.includes("manifestPath"), false);
});

test("creates one exact stable Stardew recovery identity from actual receipt-backed bindings", async (t) => {
  if (process.platform !== "win32") {
    t.skip("receipt-backed runtime binding requires Windows owner identity");
    return;
  }
  const firstFixture = fixture(() => undefined, () => undefined, "stardew");
  const secondFixture = fixture(() => undefined, () => undefined, "stardew");
  const firstBinding = await createGameRuntimeBindingFromReceiptBackedLaunch(
    Object.freeze({
      manifest: await manifest(),
      launcher: firstFixture.launcher,
      launch: firstFixture.handle,
      expectedWorld: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
    }),
  );
  const secondBinding = await createGameRuntimeBindingFromReceiptBackedLaunch(
    Object.freeze({
      manifest: await manifest(),
      launcher: secondFixture.launcher,
      launch: secondFixture.handle,
      expectedWorld: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
    }),
  );
  let first: ReturnType<typeof createStableGameRuntimeBindingIdentity> | undefined;
  let second: ReturnType<typeof createStableGameRuntimeBindingIdentity> | undefined;
  await firstBinding.executeWithBinding((token) => {
    first = createStableGameRuntimeBindingIdentity(consumeBindingToken(token));
  });
  await secondBinding.executeWithBinding((token) => {
    second = createStableGameRuntimeBindingIdentity(consumeBindingToken(token));
  });
  assert.deepEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(Object.keys(first!).sort(), ["continuityId", "integrationId", "product", "saveId", "worldId"]);
  assert.equal("companionId" in first!, false);
  assert.equal("playerId" in first!, false);
  assert.equal("runtimeInstanceId" in first!, false);
  assert.equal("bindingDigest" in first!, false);
  assert.equal("ownerToken" in first!, false);
  assert.equal("epoch" in first!, false);
  assertStableGameRuntimeBindingIdentity(first);
  await firstBinding.close();
  await secondBinding.close();
});

test("binds Stardew recovery context only to a branded receipt-backed execution", async (t) => {
  if (process.platform !== "win32") {
    t.skip("receipt-backed runtime binding requires Windows owner identity");
    return;
  }
  const current = fixture(() => undefined, () => undefined, "stardew");
  const receiptRecovery = Object.freeze({
    scope: Object.freeze({ product: "stardew" as const, continuityId: "continuity_01", integrationId: "stardew" as const, saveId: "save_01", worldId: "world_01" }),
    bindingIdentity: Object.freeze({ product: "stardew" as const, continuityId: "continuity_01", integrationId: "stardew" as const, saveId: "save_01", worldId: "world_01" }),
    queryExecutionReceipt: async () => {
      throw new Error("fixture receipt recovery is not invoked");
    },
  });
  (current.handle as { receiptRecovery?: typeof receiptRecovery }).receiptRecovery = receiptRecovery;
  const binding = await createGameRuntimeBindingFromReceiptBackedLaunch(
    Object.freeze({
      manifest: await manifest(),
      launcher: current.launcher,
      launch: current.handle,
      expectedWorld: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
    }),
  );
  await binding.executeWithBinding((token) => {
    const execution = consumeBindingToken(token);
    const journal = {} as StardewLogicalActionRecoveryJournal;
    const context = createStardewRecoveryBindingContext(execution, journal);
    const record = readStardewRecoveryBindingContext(context);
    assert.equal(record.journal, journal);
    assert.deepEqual(record.identity, createStableGameRuntimeBindingIdentity(execution));
    assert.equal(record.queryExecutionReceipt, receiptRecovery.queryExecutionReceipt);
  });
  await binding.close();
  assert.throws(
    () => readStardewRecoveryBindingContext(Object.freeze(Object.create(null))),
    /invalid_stardew_recovery_binding_context/,
  );
});

test("rejects arbitrary frozen matching tuples and forged execution lookalikes", () => {
  const source = Object.freeze({
    principal: Object.freeze({ continuityId: "continuity_01" }),
    world: Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" }),
  });
  assert.throws(() => createStableGameRuntimeBindingIdentity(source as never), /execution/);

  const executionPrincipal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });
  const executionWorld = Object.freeze({ integrationId: "stardew", saveId: "save_01", worldId: "world_01" });
  const ownerIdentity = brandRuntimeOwnerIdentity({ processId: 1, creationTime100ns: "1" });
  const execution = Object.freeze({
    principal: executionPrincipal,
    runtimeRoot: "runtime",
    connection: Object.freeze({}),
    world: executionWorld,
    launch: Object.freeze({}),
    ownerIdentity,
    bindingFacts: mintGameRuntimeBindingFacts({ principal: executionPrincipal, world: executionWorld, ownerIdentity }),
  });
  mintBindingToken(execution as never);
  assert.throws(() => createStableGameRuntimeBindingIdentity(execution as never), /execution/);
});


test("receipt-backed binding rejects a non-Stardew execution", async (t) => {
  if (process.platform !== "win32") {
    t.skip("receipt-backed runtime binding requires Windows owner identity");
    return;
  }
  const arcadeFixture = fixture(() => undefined, () => undefined);
  const binding = await createGameRuntimeBindingFromReceiptBackedLaunch(
    Object.freeze({
      manifest: await manifest(),
      launcher: arcadeFixture.launcher,
      launch: arcadeFixture.handle,
      expectedWorld: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
    }),
  );
  await binding.executeWithBinding((token) => {
    assert.throws(
      () => createStableGameRuntimeBindingIdentity(consumeBindingToken(token)),
      /invalid_stardew_game_runtime_binding_execution/,
    );
  });
  await binding.close();
});

test("keeps the stable identity validator exact and excludes lifecycle fields", () => {
  const identity = Object.freeze({
    product: "stardew" as const,
    continuityId: "continuity_01",
    integrationId: "stardew" as const,
    saveId: "save_01",
    worldId: "world_01",
  });
  assertStableGameRuntimeBindingIdentity(identity);
  assert.throws(
    () => assertStableGameRuntimeBindingIdentity({ ...identity, runtimeInstanceId: "forbidden" }),
    /identity$/,
  );
});

test("revokes and closes once when world validation fails", async () => {
  let revoked = 0;
  let closed = 0;
  const base = fixture(
    () => {
      closed += 1;
    },
    () => {
      revoked += 1;
    },
  );
  const badModule: GameIntegrationAdapter = {
    ...base.launcher.module,
    readState: (connection) => base.launcher.module.readState(connection),
    worldScope: () => null,
  };
  const badHandle = { ...base.handle, connection: { ...base.handle.connection, module: badModule } };
  const badLauncher = {
    ...base.launcher,
    module: badModule,
    launch: async () => badHandle,
  } as ConfigurableIntegrationLauncher;
  await assert.rejects(
    createGameRuntimeBinding({
      manifest: await manifest(),
      launcher: badLauncher,
      launcherConfig: {},
      configDirectory: process.cwd(),
    }),
    /integration_world_scope_invalid/,
  );
  assert.equal(revoked, 1);
  assert.equal(closed, 1);
});
