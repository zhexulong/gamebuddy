import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type GameRuntimeBindingExecution,
  type ReservedGameRuntimeMaterialization,
  reserveGameRuntimeMaterialization,
  withConsumedBindingExecution,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import {
  createGameRuntimeBinding,
  type GameRuntimeBinding,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import type { ProductionGamePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { loadHostDeploymentManifest } from "../deployment-manifest.js";
import type { ConfigurableIntegrationLauncher } from "../integration-catalog.js";
import { type IntegrationLaunchHandle, RECEIPT_BACKED_INTEGRATION_AUTHORITY } from "../integration-launcher.js";
import {
  createActionExecutionCoordinator,
  type ActionExecutionCoordinator,
} from "../action-execution-coordinator.internal.js";
import { createIntegrationActionCatalog, type GameIntegrationAdapter } from "../game-integration-adapter.js";
import type { GameConnection } from "../game-connection.js";
import { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import { StardewExecutionRecoverySupervisor } from "../stardew-execution-recovery-supervisor.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { createTestGameRuntimeMaterializer } from "./continuity-semantic-game-runtime-materializer.test-support.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

async function canonicalTemporaryRoot(prefix: string): Promise<string> {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

function fixture(onClose: () => void, onRevoke: () => void): ConfigurableIntegrationLauncher {
  const module: GameIntegrationAdapter = {
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
    actorId: () => principal.playerId,
    assertIdentityBinding: (_connection, identity) => {
      if (
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
      capabilityRevision: 1,
      registrations: [
        {
          actionId: "activate",
          familyId: "interaction",
          identityVersion: 1,
          lifecycle: "published",
          kind: "execution",
        }
      ],
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
    revoke: onRevoke,
    close: onClose,
  };
  return {
    integrationId: "test-arcade",
    module,
    prepare: async () =>
      Object.freeze({
        launchConfig: Object.freeze({ prepared: true }),
        identityScope: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
      }),
    launch: async () => handle,
  };
}

async function binding(): Promise<GameRuntimeBinding> {
  const root = await canonicalTemporaryRoot("game-runtime-materializer-");
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  const manifestPath = join(root, "manifest.json");
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
  return createGameRuntimeBinding({
    manifest: await loadHostDeploymentManifest(manifestPath),
    launcher: fixture(
      () => undefined,
      () => undefined,
    ),
    launcherConfig: null,
    configDirectory: process.cwd(),
  });
}

function permit(
  execution: GameRuntimeBindingExecution,
  overrides: Partial<ProductionGamePermit> = {},
): ProductionGamePermit {
  return Object.freeze({
    principal: execution.principal,
    operationId: "operation_01",
    requestId: "request_01",
    kind: "enter",
    gameSessionId: "game_session_01",
    world: execution.world,
    bindingDigest: execution.bindingFacts.bindingDigest,
    owner: execution.bindingFacts.owner,
    deadlineAtMs: Date.now() + 5_000,
    expected: Object.freeze({
      partitionRevision: 1,
      gameRevision: 0,
      leaseRevision: 0,
      fenceEpoch: 1,
    }),
    payloadDigest: "b".repeat(64),
    fenceToken: "fence_01",
    prepared: Object.freeze({
      partitionRevision: 2,
      gameRevision: 0,
      leaseRevision: 1,
      fenceEpoch: 2,
    }),
    ...overrides,
  });
}

async function inActiveBinding<T>(
  binding: GameRuntimeBinding,
  callback: (execution: GameRuntimeBindingExecution, reservation: ReservedGameRuntimeMaterialization) => Promise<T> | T,
): Promise<T> {
  return binding.executeWithBinding((token) =>
    withConsumedBindingExecution(token, (execution) =>
      callback(execution, reserveGameRuntimeMaterialization(execution)),
    ),
  );
}

test("materializes only an exact enter permit and mints a permit-exact Host receipt", async () => {
  let factoryCalls = 0;
  let sessionDisposed = 0;
  let workerDisposed = 0;
  const materializer = createTestGameRuntimeMaterializer(async () => {
    factoryCalls += 1;
    return Object.freeze({
      session: Object.freeze({
        dispose: () => {
          sessionDisposed += 1;
        },
      }),
      gameplaySubagent: Object.freeze({
        dispose: () => {
          workerDisposed += 1;
        },
      }),
    });
  });
  const runtimeBinding = await binding();
  let entered!: ProductionGamePermit;
  try {
    const result = await inActiveBinding(runtimeBinding, (execution, reservation) => {
      entered = permit(execution);
      return materializer.materializeEnter(reservation, entered);
    });
    assert.equal(factoryCalls, 1);
    assert.equal(result.receipt.kind, "runtime_bootstrapped");
    assert.equal(result.receipt.operationId, entered.operationId);
    assert.equal(result.receipt.requestId, entered.requestId);
    assert.equal(result.receipt.gameSessionId, entered.gameSessionId);
    assert.equal(result.receipt.bindingDigest, entered.bindingDigest);
    assert.deepEqual(result.receipt.world, entered.world);
    assert.deepEqual(result.receipt.owner, entered.owner);
    assert.equal(result.receipt.fenceToken, entered.fenceToken);
    assert.ok(result.receipt.occurredAtMs <= entered.deadlineAtMs);
    await result.close();
    await result.close();
    assert.equal(workerDisposed, 1);
    assert.equal(sessionDisposed, 1);
  } finally {
    await runtimeBinding.close();
  }
});

test("tears down only for the exact same-session close permit, marks the neutral connection state, and mints runtime_torn_down afterwards", async () => {
  let disposed = 0;
  let closingMarks = 0;
  let exactClose!: ProductionGamePermit;
  const materializer = createTestGameRuntimeMaterializer(async () =>
    Object.freeze({
      session: Object.freeze({
        dispose: () => {
          disposed += 1;
        },
      }),
      connected: Object.freeze({
        host: Object.freeze({ close: () => undefined }) as never,
        lifecycleSnapshot: () =>
          Object.freeze({
            availability: "available" as const,
            surface: "active" as const,
            freshness: "current" as const,
            availableCapabilities: Object.freeze({ category: "none" as const, count: 0 }),
            activeExecution: "none" as const,
            latestAuthoritativeReceipt: "none" as const,
          }),
        markClosing: () => {
          closingMarks += 1;
        },
        activateIngress: () => undefined,
      }),
    }),
  );
  const runtimeBinding = await binding();
  try {
    const result = await inActiveBinding(runtimeBinding, (execution, reservation) => {
      exactClose = permit(execution, {
        kind: "close",
        operationId: "close_01",
        requestId: "close_request_01",
        fenceToken: "close_fence_01",
      });
      return materializer.materializeEnter(reservation, permit(execution));
    });
    await assert.rejects(
      result.teardownClose(Object.freeze({ ...exactClose, gameSessionId: "foreign_session" })),
      /game_runtime_materialization_close_permit_rejected/,
    );
    assert.equal(disposed, 0);
    assert.equal(closingMarks, 0);
    const receipt = await result.teardownClose(exactClose);
    assert.equal(receipt.kind, "runtime_torn_down");
    assert.equal(closingMarks, 1);
    assert.equal(receipt.operationId, exactClose.operationId);
    assert.equal(disposed, 1);
    await assert.rejects(result.teardownClose(exactClose), /game_runtime_materialization_unavailable/);
  } finally {
    await runtimeBinding.close();
  }
});

test("a teardown rejection retains the exact runtime for a same-permit retry", async () => {
  let attempts = 0;
  let exactClose!: ProductionGamePermit;
  const materializer = createTestGameRuntimeMaterializer(async () =>
    Object.freeze({
      session: Object.freeze({
        dispose: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("first_teardown_failed");
        },
      }),
    }),
  );
  const runtimeBinding = await binding();
  try {
    const result = await inActiveBinding(runtimeBinding, (execution, reservation) => {
      exactClose = permit(execution, {
        kind: "close",
        operationId: "close_retry_01",
        requestId: "close_retry_request_01",
        fenceToken: "close_retry_fence_01",
      });
      return materializer.materializeEnter(reservation, permit(execution));
    });
    await assert.rejects(result.teardownClose(exactClose), /game_runtime_materialization_close_failed/);
    const terminal = await result.teardownClose(exactClose);
    assert.equal(terminal.kind, "runtime_torn_down");
    assert.equal(terminal.operationId, exactClose.operationId);
    assert.equal(attempts, 2);
  } finally {
    await runtimeBinding.close();
  }
});

test("rejects a drifted permit before factory invocation and never mints a receipt", async () => {
  let factoryCalls = 0;
  const materializer = createTestGameRuntimeMaterializer(async () => {
    factoryCalls += 1;
    return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
  });
  const runtimeBinding = await binding();
  try {
    await assert.rejects(
      inActiveBinding(runtimeBinding, (execution, reservation) =>
        materializer.materializeEnter(reservation, permit(execution, { bindingDigest: "c".repeat(64) })),
      ),
      /game_runtime_materialization_permit_rejected/,
    );
    assert.equal(factoryCalls, 0);
  } finally {
    await runtimeBinding.close();
  }
});

test("rejects forged reservations and permits exactly one deferred use of a callback-admitted reservation", async () => {
  let factoryCalls = 0;
  const materializer = createTestGameRuntimeMaterializer(async () => {
    factoryCalls += 1;
    return Object.freeze({ session: Object.freeze({ dispose: () => undefined }) });
  });
  const runtimeBinding = await binding();
  let retainedExecution!: GameRuntimeBindingExecution;
  let retainedReservation!: ReservedGameRuntimeMaterialization;
  try {
    await inActiveBinding(runtimeBinding, (execution, reservation) => {
      retainedExecution = execution;
      retainedReservation = reservation;
      assert.throws(() => reserveGameRuntimeMaterialization(execution), /game_runtime_binding_execution_rejected/);
    });
    await assert.rejects(
      materializer.materializeEnter({} as ReservedGameRuntimeMaterialization, permit(retainedExecution)),
      /game_runtime_binding_execution_rejected/,
    );
    const result = await materializer.materializeEnter(retainedReservation, permit(retainedExecution));
    assert.equal(factoryCalls, 1);
    await result.close();
    await assert.rejects(
      materializer.materializeEnter(retainedReservation, permit(retainedExecution)),
      /game_runtime_binding_execution_rejected/,
    );
  } finally {
    await runtimeBinding.close();
  }
});

test("propagates materialization failure and does not synthesize a lifecycle receipt", async () => {
  const materializer = createTestGameRuntimeMaterializer(async () => {
    throw new Error("runtime_creation_failed");
  });
  const runtimeBinding = await binding();
  try {
    await assert.rejects(
      inActiveBinding(runtimeBinding, (execution, reservation) =>
        materializer.materializeEnter(reservation, permit(execution)),
      ),
      /runtime_creation_failed/,
    );
  } finally {
    await runtimeBinding.close();
  }
});

test("does not let a detached continuation create a reservation after callback completion", async () => {
  const runtimeBinding = await binding();
  let execution!: GameRuntimeBindingExecution;
  let detached!: Promise<void>;
  try {
    await runtimeBinding.executeWithBinding((token) =>
      withConsumedBindingExecution(token, (current) => {
        execution = current;
        detached = Promise.resolve().then(() => {
          assert.throws(() => reserveGameRuntimeMaterialization(execution), /game_runtime_binding_execution_rejected/);
        });
      }),
    );
    await detached;
  } finally {
    await runtimeBinding.close();
  }
});

test("close drains materialization admitted before callback completion", async () => {
  let disposed = 0;
  let release!: () => void;
  const factoryStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const materializer = createTestGameRuntimeMaterializer(async () => {
    await factoryStarted;
    return Object.freeze({
      session: Object.freeze({
        dispose: () => {
          disposed += 1;
        },
      }),
    });
  });
  const runtimeBinding = await binding();
  let admitted!: Promise<unknown>;
  try {
    await inActiveBinding(runtimeBinding, async (execution, reservation) => {
      admitted = materializer.materializeEnter(reservation, permit(execution, { deadlineAtMs: Date.now() + 5_000 }));
      await delay(0);
    });
    const closing = runtimeBinding.close();
    release();
    const result = await admitted;
    assert.equal(typeof (result as { close(): Promise<void> }).close, "function");
    await closing;
    assert.equal(disposed, 0);
  } finally {
    await runtimeBinding.close();
  }
});

test("retains a durable uncertain action journal across materializer close without resending a missing execute response", async () => {
  const journalRoot = await canonicalTemporaryRoot("game-runtime-materializer-recovery-");
  const journalDirectory = join(journalRoot, "journal");
  await mkdir(journalDirectory);
  const recoveryIdentity = Object.freeze({
    product: "stardew" as const,
    continuityId: principal.continuityId,
    integrationId: "stardew",
    saveId: "save_01",
    worldId: "world_01",
  });
  let journal!: StardewLogicalActionRecoveryJournal;
  let coordinator!: ActionExecutionCoordinator;
  let executeCalls = 0;
  const materializer = createTestGameRuntimeMaterializer(async () => {
    journal = await StardewLogicalActionRecoveryJournal.open(
      Object.freeze({ directory: journalDirectory, scope: recoveryIdentity }),
    );
    const connection = Object.freeze({
      scope: Object.freeze({ integrationId: "stardew" }),
      module: Object.freeze({
        cancelExecution: async () => {
          throw new Error("unexpected_cancel");
        },
      }),
      state: Object.freeze({}),
    }) as unknown as GameConnection;
    coordinator = createActionExecutionCoordinator(connection, {
      recoveryJournal: journal,
      recoveryBinding: Object.freeze({
        scope: recoveryIdentity,
        bindingIdentity: recoveryIdentity,
      }),
    });
    return Object.freeze({
      session: Object.freeze({ dispose: () => undefined }),
      closeRecoveryJournal: () => journal.close(),
    });
  });
  const runtimeBinding = await binding();
  try {
    const materialized = await inActiveBinding(runtimeBinding, (execution, reservation) =>
      materializer.materializeEnter(reservation, permit(execution)),
    );
    const admission = coordinator.createAdmission();
    const request = Object.freeze({
      requestId: "request_missing_response_01",
      idempotencyKey: "idempotency_missing_response_01",
      action: "till_soil" as const,
      args: Object.freeze({ x: 1, y: 2 }),
      expectedRevision: 1,
      deadlineMs: Date.now() + 5_000,
    });
    const dispatch = Object.freeze({
      ...admission.owner,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      recoveryMaterial: Object.freeze({
        logicalActionId: "logical_missing_response_01",
        request,
      }),
    });

    await admission.observer.beforeWrite(dispatch);
    executeCalls += 1;
    await admission.observer.markUncertain(dispatch);
    assert.equal(journal.record("logical_missing_response_01")?.state, "recovery_pending");
    await materialized.close();

    const reopened = await StardewLogicalActionRecoveryJournal.open(
      Object.freeze({ directory: journalDirectory, scope: recoveryIdentity }),
    );
    try {
      const recoveredCoordinator = createActionExecutionCoordinator(
        Object.freeze({
          scope: Object.freeze({ integrationId: "stardew" }),
          module: Object.freeze({
            cancelExecution: async () => {
              throw new Error("unexpected_cancel");
            },
          }),
          state: Object.freeze({}),
        }) as unknown as GameConnection,
        { recoveryJournal: reopened },
      );
      const receiptQueries: unknown[] = [];
      const outcome = await new StardewExecutionRecoverySupervisor(recoveredCoordinator).recoverFromFreshBinding({
        scope: recoveryIdentity,
        bindingIdentity: recoveryIdentity,
        queryExecutionReceipt: async (query) => {
          receiptQueries.push(query);
          return Object.freeze({
            requestId: request.requestId,
            executionId: "execution_missing_response_01",
            actionId: request.action,
            state: "accepted" as const,
            reasonCode: "accepted",
            revision: 1,
            evidence: null,
          });
        },
      });
      assert.equal(executeCalls, 1, "receipt recovery must not resend the action");
      assert.deepEqual(receiptQueries, [
        { requestId: request.requestId, idempotencyKey: request.idempotencyKey },
      ]);
      assert.deepEqual(outcome, [
        { requestId: request.requestId, result: "admitted", state: "accepted" },
      ]);
      assert.equal(reopened.record("logical_missing_response_01")?.state, "recovery_pending");
    } finally {
      await reopened.close();
    }
  } finally {
    await runtimeBinding.close();
  }
});

test("rejects expired and deadline-overrun materialization without retaining a runtime", async () => {
  let disposed = 0;
  const materializer = createTestGameRuntimeMaterializer(async () => {
    await delay(5);
    return Object.freeze({
      session: Object.freeze({
        dispose: () => {
          disposed += 1;
        },
      }),
    });
  });
  const expiredBinding = await binding();
  try {
    await assert.rejects(
      inActiveBinding(expiredBinding, (execution, reservation) =>
        materializer.materializeEnter(reservation, permit(execution, { deadlineAtMs: 0 })),
      ),
      /game_runtime_materialization_permit_rejected/,
    );
  } finally {
    await expiredBinding.close();
  }
  const overrunBinding = await binding();
  try {
    await assert.rejects(
      inActiveBinding(overrunBinding, (execution, reservation) =>
        materializer.materializeEnter(reservation, permit(execution, { deadlineAtMs: Date.now() + 1 })),
      ),
      /game_runtime_materialization_permit_rejected/,
    );
    assert.equal(disposed, 1);
  } finally {
    await overrunBinding.close();
  }
});

test("rejects nested permit extension fields and reconstructs closed receipt records", async () => {
  const materializer = createTestGameRuntimeMaterializer(async () =>
    Object.freeze({ session: Object.freeze({ dispose: () => undefined }) }),
  );
  const invalidBinding = await binding();
  try {
    await assert.rejects(
      inActiveBinding(invalidBinding, (execution, reservation) =>
        materializer.materializeEnter(
          reservation,
          permit(execution, {
            deadlineAtMs: Date.now() + 5_000,
            world: Object.freeze({ ...execution.world, injected: "x" }) as never,
          }),
        ),
      ),
      /game_runtime_materialization_permit_rejected/,
    );
  } finally {
    await invalidBinding.close();
  }
  const validBinding = await binding();
  try {
    const result = await inActiveBinding(validBinding, (execution, reservation) =>
      materializer.materializeEnter(reservation, permit(execution, { deadlineAtMs: Date.now() + 5_000 })),
    );
    assert.deepEqual(Object.keys(result.receipt.world).sort(), ["integrationId", "saveId", "worldId"]);
    assert.deepEqual(Object.keys(result.receipt.owner).sort(), [
      "ownerPid",
      "ownerProcessStartIdentity",
      "ownerToken",
      "runtimeInstanceId",
    ]);
    await result.close();
  } finally {
    await validBinding.close();
  }
});

test("production materializer source rejects legacy lifecycle, facade, store command, and entrypoint ingress", async () => {
  const root = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/continuity-semantic-game-runtime-materializer",
  );
  const sources = await Promise.all([
    readFile(join(root, "continuity-semantic-game-runtime-materializer.ts"), "utf8"),
    readFile(join(root, "continuity-semantic-game-runtime-materializer.internal.ts"), "utf8"),
  ]);
  const forbidden = [
    "integration-bootstrap",
    "game-surface-lifecycle",
    "GameSurfaceLifecycle",
    "markReturning",
    "continuity.js",
    "deployment-composition",
    "-facade",
    "main.js",
    "dialogue-web-main",
    "prepareGame(",
    "commitGameTerminal(",
    "failGame(",
  ];
  for (const source of sources)
    for (const segment of forbidden) assert.equal(source.includes(segment), false, `forbidden S4c ingress: ${segment}`);
  assert.equal(
    sources.some((source) => /export\s+(?:async\s+)?function\s+create(?:Host|Materialized)GameRuntime\b/.test(source)),
    false,
    "S4c must not export a Game-specific runtime constructor",
  );
  assert.equal(
    sources.some((source) => /async\s+function\s+createMaterializedGameRuntime\b/.test(source)),
    true,
    "S4c must keep its named Game construction helper private to the materializer",
  );
  assert.equal(
    sources.some((source) => /import\s*\{[^}]*createMaterializedGameCompanionRuntime/.test(source)),
    true,
    "S4c uses the explicit fixed-tool Game runtime constructor",
  );
  assert.equal(
    sources.some((source) => source.includes("GameRuntimeBindingExecution")),
    true,
    "S4c materialization remains bound to S4b execution facts",
  );
  assert.equal(
    sources.some((source) => source.includes("gameOperationalGateNonceSha256")),
    true,
    "S4c accepts the construction-owned operational marker option",
  );
  assert.match(
    sources[0],
    /const workerAttachment = gameplayWorkerEnabled\s*\n\s*\? await/,
    "armed production Game materialization constructs the worker attachment",
  );
  assert.match(
    sources[0],
    /gameplaySubagentEnabled: true[\s\S]*hostBindingFactory/,
    "armed production Game materialization constructs the worker attachment",
  );
  assert.match(
    sources[0],
    /workerAttachment === undefined && recoveryAttachment === undefined \? hostBindingFactory : undefined,/,
    "unarmed production Game materialization preserves ordinary Host binding without an attachment",
  );
  assert.match(
    sources[0],
    /workerAttachment === undefined[\s\S]*?gameplaySubagentEnabled: false,[\s\S]*?hostBindingFactory,[\s\S]*?recoveryJournal:/,
    "recovery-only materialization preserves the ordinary Host binding in its attachment",
  );
  assert.match(
    sources.join("\n"),
    /createGameOperationalGateEvidenceProjection\(\s*execution\.connection\.module,\s*execution\.connection,\s*execution\.launch\.events,\s*host,\s*\)/,
    "S4c supplies the existing Host's read-only exact STOP settlement observer to the gate projection",
  );
});

test("public runtime facade, attachment, GameConnection, and adapter surfaces do not name a program port or tool API", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const publicSources = await Promise.all([
    "game-connection.ts",
    "runtime.ts",
    "runtime-core.internal.ts",
    "game-integration-adapter.ts",
    "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.ts",
  ].map((path) => readFile(join(root, path), "utf8")));
  for (const source of publicSources) {
    assert.equal(source.includes("bodyProgramTransport"), false);
    assert.equal(source.includes("BodyProgramPort"), false);
    assert.equal(source.includes("programVerify"), false);
    assert.equal(source.includes("programSubmit"), false);
  }
  const materializer = await readFile(join(root, "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts"), "utf8");
   assert.equal(materializer.includes("bodyProgramTransport"), false);
   assert.equal(materializer.includes(".test-support"), false, "production materializer must not enter the test-support graph");
});

test("production Game presentation composition supplies session and opaque admission only inside materialization", async () => {
  const source = await readFile(
    join(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../src/continuity-semantic-game-runtime-materializer"),
      "continuity-semantic-game-runtime-materializer.ts",
    ),
    "utf8",
  );
  assert.match(source, /gameVoicePresentation\?: GameVoicePresentationAttachment/);
  assert.doesNotMatch(source, /gamePresentation\?:/);
  assert.match(source, /sessionId: gameSessionId/);
  assert.match(source, /createGamePresentationAdmissionProvider\(\s*turnTracker,\s*handle\.interruption,\s*\)/);
  assert.match(source, /createFarmhandCompanionPresentationPort/);
  assert.match(source, /host\.attachVoiceStopper\(\s*consumeGameVoicePresentationAttachment/);
  assert.match(source, /const activateIngress/);
  assert.doesNotMatch(source, /trace.*sink/i);
  assert.doesNotMatch(source, /inputId.*admission/i);
});

test("Game materializer source mints origin-free receipts and exposes only close teardown", async () => {
  const source = await readFile(
    join(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../src/continuity-semantic-game-runtime-materializer"),
      "continuity-semantic-game-runtime-materializer.internal.ts",
    ),
    "utf8",
  );
  for (const forbidden of [
    "teardownReturn",
    "returnPermit",
    "GameOrigin",
    "permit.origin",
    "origin:",
    "GameSurfaceLifecycle",
    "markReturning",
    "game-surface-lifecycle",
  ])
    assert.equal(source.includes(forbidden), false, `forbidden Game materializer semantic: ${forbidden}`);
  assert.match(source, /teardownClose\(permit: ProductionGamePermit\)/);
});

test("connected runtime privately dispatches one exact prompt-defined task and discards the worker result", async () => {
  const calls: string[] = [];
  const workerResult = Object.freeze({ taskId: "task_01", report: "not exposed" });
  const materializer = createTestGameRuntimeMaterializer(async () =>
    Object.freeze({
      session: Object.freeze({ dispose: () => undefined }),
      gameplaySubagent: Object.freeze({
        dispose: () => undefined,
        run: async (task: string) => {
          calls.push(task);
          return workerResult;
        },
      }),
    }),
  );
  const runtimeBinding = await binding();
  try {
    const result = await inActiveBinding(runtimeBinding, (execution, reservation) =>
      materializer.materializeEnter(reservation, permit(execution)),
    );
    assert.ok(result.connected);
    const task = "Walk to the 🌾 chest, then wait — untouched text.";
    const dispatched = await result.connected.dispatchPromptDefinedTask(task);
    assert.equal(dispatched, undefined);
    assert.deepEqual(calls, [task]);
    assert.equal(Object.hasOwn(result.connected, "gameplaySubagent"), false);
    assert.equal(Object.hasOwn(result.connected, "runtime"), false);
    assert.equal(Object.hasOwn(result.connected, "result"), false);
    assert.equal(Object.hasOwn(result.connected, "taskId"), false);
  } finally {
    await runtimeBinding.close();
  }
});

test("connected dispatch validates Unicode scalar text and fails closed when no worker exists", async () => {
  let calls = 0;
  const materializer = createTestGameRuntimeMaterializer(async () =>
    Object.freeze({
      session: Object.freeze({ dispose: () => undefined }),
      gameplaySubagent: Object.freeze({
        dispose: () => undefined,
        run: async (_task: string) => {
          calls += 1;
          return Object.freeze({ state: "completed" });
        },
      }),
    }),
  );
  const runtimeBinding = await binding();
  try {
    const result = await inActiveBinding(runtimeBinding, (execution, reservation) =>
      materializer.materializeEnter(reservation, permit(execution)),
    );
    assert.ok(result.connected);
    const connected = result.connected;
    const maximumTask = "🙂".repeat(2_000);
    await connected.dispatchPromptDefinedTask(maximumTask);
    assert.equal(calls, 1);
    await assert.rejects(connected.dispatchPromptDefinedTask(""), /invalid_gameplay_task/);
    await assert.rejects(connected.dispatchPromptDefinedTask("a".repeat(2_001)), /invalid_gameplay_task/);
    await assert.rejects(connected.dispatchPromptDefinedTask("contains\u0000nul"), /invalid_gameplay_task/);
    await assert.rejects(connected.dispatchPromptDefinedTask("\ud800"), /invalid_gameplay_task/);
    await assert.rejects(connected.dispatchPromptDefinedTask("\udfff"), /invalid_gameplay_task/);
    await assert.rejects(
      connected.dispatchPromptDefinedTask(undefined as unknown as string),
      /invalid_gameplay_task/,
    );
    assert.equal(calls, 1);
  } finally {
    await runtimeBinding.close();
  }

  const missingWorkerMaterializer = createTestGameRuntimeMaterializer(async () =>
    Object.freeze({ session: Object.freeze({ dispose: () => undefined }) }),
  );
  const missingWorkerBinding = await binding();
  try {
    const result = await inActiveBinding(missingWorkerBinding, (execution, reservation) =>
      missingWorkerMaterializer.materializeEnter(reservation, permit(execution)),
    );
    assert.ok(result.connected);
    await assert.rejects(
      result.connected.dispatchPromptDefinedTask("valid task"),
      /gameplay_task_dispatch_unavailable/,
    );
  } finally {
    await missingWorkerBinding.close();
  }
});
