import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  brandRuntimeOwnerIdentity,
  drainBindingMaterializations,
  mintBindingToken,
  mintGameRuntimeBindingFacts,
  revokeBindingToken,
  stopAcceptingBindingMaterialization,
  type GameRuntimeBindingExecution,
  type OpaqueGameRuntimeBindingToken,
  type ReservedGameRuntimeMaterialization,
  reserveGameRuntimeMaterialization,
  withConsumedBindingExecution,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import type { GameRuntimeBinding } from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import type { ProductionGamePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
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
import { gameTurnWorldStateText } from "./continuity-semantic-game-runtime-materializer.js";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });

/** The language-neutral wire contract: the authority for every snapshot family's row shape. */
const WIRE_SCHEMA: any = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../protocol/bridge-v1.schema.json", import.meta.url)), "utf8"),
);

async function canonicalTemporaryRoot(prefix: string): Promise<string> {
  return canonicalTestRoot(prefix);
}

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

function fixture(
  onClose: () => void,
  onRevoke: () => void,
): { launcher: ConfigurableIntegrationLauncher; handle: IntegrationLaunchHandle } {
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
        },
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
  const launcher: ConfigurableIntegrationLauncher = {
    integrationId: "test-arcade",
    module,
    prepare: async () =>
      Object.freeze({
        launchConfig: Object.freeze({ prepared: true }),
        identityScope: Object.freeze({ saveId: "save_01", worldId: "world_01" }),
      }),
    launch: async () => handle,
  };
  return Object.freeze({ launcher, handle });
}

async function binding(): Promise<GameRuntimeBinding> {
  const root = await canonicalTemporaryRoot("game-runtime-materializer-");
  const runtimeRoot = join(root, "runtime");
  await mkdir(runtimeRoot);
  const current = fixture(
    () => undefined,
    () => undefined,
  );
  const world = Object.freeze({ integrationId: "test-arcade", saveId: "save_01", worldId: "world_01" });
  const ownerIdentity = brandRuntimeOwnerIdentity({ processId: process.pid, creationTime100ns: "1" });
  const execution = Object.freeze({
    principal,
    runtimeRoot,
    connection: current.handle.connection,
    world,
    launch: current.handle,
    ownerIdentity,
    bindingFacts: mintGameRuntimeBindingFacts({ principal, world, ownerIdentity }),
  });
  const token = mintBindingToken(execution);
  let closed = false;
  return Object.freeze({
    async executeWithBinding<T>(callback: (token: OpaqueGameRuntimeBindingToken) => Promise<T> | T): Promise<T> {
      if (closed) throw new Error("game_runtime_binding_unavailable");
      try {
        return await callback(token);
      } finally {
        stopAcceptingBindingMaterialization(token);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      stopAcceptingBindingMaterialization(token);
      await drainBindingMaterializations(token);
      revokeBindingToken(token);
      current.handle.revoke("game_runtime_binding_closed");
      current.handle.close();
    },
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
      assert.deepEqual(receiptQueries, [{ requestId: request.requestId, idempotencyKey: request.idempotencyKey }]);
      assert.deepEqual(outcome, [{ requestId: request.requestId, result: "admitted", state: "accepted" }]);
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
  let overrunDeadlineAtMs = 0;
  const materializer = createTestGameRuntimeMaterializer(async () => {
    await delay(Math.max(0, overrunDeadlineAtMs - Date.now() + 10));
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
    overrunDeadlineAtMs = Date.now() + 25;
    await assert.rejects(
      inActiveBinding(overrunBinding, (execution, reservation) =>
        materializer.materializeEnter(reservation, permit(execution, { deadlineAtMs: overrunDeadlineAtMs })),
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
    /const gameplayWorkerEnabled = gameOperationalGateNonceSha256 !== undefined;/,
    "the construction-owned operational marker decides only whether the gameplay worker is armed",
  );
  assert.match(
    sources[0],
    /const runtimeAttachment = await createGameRuntimeAttachment\(\{\s*\n\s*runtimeRoot,\s*\n\s*agentDir: resolveRuntimePaths\(identity, runtimeRoot\)\.agentDir,\s*\n\s*gameplayWorkerEnabled,\s*\n\s*hostBindingFactory,\s*\n\s*\.\.\.\(recoveryAttachment === undefined \? \{\} : \{ recoveryAttachment \}\),\s*\n\s*\}\);/,
    "every Game materialization builds its attachment unconditionally, with the player's model configuration and the connection directory both surfaces share inside it",
  );
  assert.equal(
    sources[0].includes("workerAttachment"),
    false,
    "the gate nonce may no longer choose between an attachment with and without a model configuration",
  );
  assert.match(
    sources[0],
    /gameOperationalGateNonceSha256 === undefined\s*\n\s*\? undefined\s*\n\s*: Object\.freeze\(\{ nonceSha256: gameOperationalGateNonceSha256 \}\),\s*\n\s*undefined,\s*\n\s*runtimeAttachment,/,
    "the armed gate marker stays construction-owned while the binding travels in the attachment",
  );
  assert.match(
    sources.join("\n"),
    /createGameOperationalGateEvidenceProjection\(\s*execution\.connection\.module,\s*execution\.connection,\s*execution\.launch\.events,\s*host,\s*\)/,
    "S4c supplies the existing Host's read-only exact STOP settlement observer to the gate projection",
  );
});

test("public runtime facade, attachment, GameConnection, and adapter surfaces do not name a program port or tool API", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const publicSources = await Promise.all(
    [
      "game-connection.ts",
      "runtime.ts",
      "runtime-core.internal.ts",
      "game-integration-adapter.ts",
      "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.ts",
    ].map((path) => readFile(join(root, path), "utf8")),
  );
  for (const source of publicSources) {
    assert.equal(source.includes("bodyProgramTransport"), false);
    assert.equal(source.includes("BodyProgramPort"), false);
    assert.equal(source.includes("programVerify"), false);
    assert.equal(source.includes("programSubmit"), false);
  }
  const materializer = await readFile(
    join(root, "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts"),
    "utf8",
  );
  assert.equal(materializer.includes("bodyProgramTransport"), false);
  assert.equal(
    materializer.includes(".test-support"),
    false,
    "production materializer must not enter the test-support graph",
  );
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
  // The two ARGUMENTS are what must hold - the turn tracker and the interruption handle the
  // admission is fenced by - so the trailing comma is optional here: the formatter breaks this
  // call across lines only while it does not fit on one, and this pin broke the first time the
  // call was short enough to collapse (`handle.interruption,` + newline became `handle.interruption)`),
  // which says nothing about the behaviour the assertion protects.
  assert.match(source, /createGamePresentationAdmissionProvider\(\s*turnTracker,\s*handle\.interruption,?\s*\)/);
  assert.match(source, /createFarmhandCompanionPresentationPort/);
  // The voice path is asserted as BEHAVIOUR, not as a spelling. Commit 75eb1dae
  // deliberately hoisted the attachment consumption into `gameVoicePayload` (so the
  // streaming sink and the stop function come from one consumption) and rewired this
  // line; the earlier assertion pinned the pre-hoist nesting instead. What must stay
  // true is that exactly one attachment is consumed and the stopper is handed that
  // consumption's stop function - a second consumption is the defect class this pins.
  assert.equal(
    source.match(/consumeGameVoicePresentationAttachment\(/gu)?.length,
    1,
    "the presentation attachment must be consumed exactly once",
  );
  assert.match(source, /host\.attachVoiceStopper\(\s*gameVoicePayload\.stopVoice\s*\)/);
  assert.match(source, /const gameVoicePayload =\s*\n?\s*options\.gameVoicePresentation === undefined/);
  assert.match(source, /const activateIngress/);
  assert.doesNotMatch(source, /trace.*sink/i);
  assert.doesNotMatch(source, /inputId.*admission/i);
});

test("Game materializer assembles canonical Game context through the tested assembly seam", async () => {
  const materializerDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../src/continuity-semantic-game-runtime-materializer",
  );
  const materializerSource = await readFile(
    join(materializerDirectory, "continuity-semantic-game-runtime-materializer.ts"),
    "utf8",
  );
  const assemblySource = await readFile(join(materializerDirectory, "game-runtime-context-assembly.ts"), "utf8");
  // System assembly, not caller/script injection: the materializer delegates to
  // the shared seam inside the runtime constructor and forwards both resolved
  // values to the runtime core.
  assert.match(materializerSource, /const context = await assembleGameRuntimeContext\(\{/);
  assert.match(materializerSource, /const assembledProfile = context\.profile/);
  assert.match(materializerSource, /const assembledWorldBook = context\.worldBook/);
  assert.match(materializerSource, /const assembledScenario = context\.scenario/);
  assert.match(materializerSource, /initialProfile: assembledProfile/);
  assert.match(materializerSource, /worldBook: assembledWorldBook/);
  // The scenario reaches the Game catalog alongside the book: a companion whose
  // card carries only a scenario (no character book) still publishes it.
  assert.match(materializerSource, /assembledWorldBook === undefined && assembledScenario === undefined/);
  assert.match(materializerSource, /buildGameSurfaceAuthoredCatalog\(/);
  // Both resolved layers reach the catalog call. The pin names the call and the arguments it carries,
  // not the call's tail formatting: the previous form pinned `assembledScenario,` immediately before the
  // closing parenthesis, so adding a layer to the call broke the assertion while the seam was correct.
  assert.match(
    materializerSource,
    /buildGameSurfaceAuthoredCatalog\([\s\S]*?assembledScenario,[\s\S]*?assembledWorldInfo,/,
  );
  // The seam reads the same identity-profile/world-book files the Chat surface
  // consumes, and never writes (the runtime core owns default creation).
  assert.match(assemblySource, /resolveRuntimePaths\(input\.identity, input\.runtimeRoot\)/);
  assert.match(assemblySource, /readIdentityProfile\(path\)/);
  assert.match(assemblySource, /readWorldBook\(join\(runtimeCwd, "worldbook\.json"\)\)/);
  assert.match(assemblySource, /input\.identityProfile \?\?/);
  assert.match(assemblySource, /input\.worldBook \?\?/);
  assert.doesNotMatch(assemblySource, /writeIdentityProfile\(/);
  assert.doesNotMatch(assemblySource, /readOrCreateIdentityProfile\(/);
  // The scenario IS read, but only as the companion's own durable record through
  // the same resolver a new Chat binds - never a stray file beside the profile,
  // never a Chat thread-scoped catalog.
  assert.match(assemblySource, /resolveCompanionOwnScenario\(/);
  assert.match(assemblySource, /new TavernArtifactStore\(runtimeRoot\)/);
  assert.match(assemblySource, /resolveTavernPaths\(runtimePaths, identity\)/);
  assert.doesNotMatch(assemblySource, /scenario\.json|materializeTavernAuthoredContextCatalog/);
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
    await assert.rejects(connected.dispatchPromptDefinedTask(undefined as unknown as string), /invalid_gameplay_task/);
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

test("the Game channel's per-turn world-state corpus is the line Magic Context injects, and an absent or non-Stardew snapshot invents nothing", () => {
  // The Game surface selects her keyword-gated world-book entries against the SAME world-state
  // line Magic Context injects for that turn (`<runtime-environment>`), which is what makes
  // entries keyed on the weather, the clock, the season or her actor's stamina reachable at all.
  const text = gameTurnWorldStateText({
    state: {
      snapshot: {
        revision: 3,
        location: "Farm",
        tile: { x: 1, y: 2 },
        stamina: 20,
        exhausted: true,
        health: 100,
        actionable: true,
        capabilities: [],
        timeOfDay: 1500,
        dayOfMonth: 3,
        seasonIndex: 0,
        year: 1,
        weather: "rain",
        presentationLocale: "zh-CN",
      },
    },
  } as never);
  assert.match(text, /天气：雨天/);
  assert.match(text, /体力: 20（已疲惫）/);
  // The Chinese locale names the map in words: a fact line that said `位置: Farm` would be handing the model a
  // technical id to read aloud, which the conduct explicitly forbids. `LOCATION_NAMES_ZH` is what makes the two agree.
  assert.match(text, /位置: 农场/);
  assert.match(text, /春季/);
  // An absent snapshot and a non-Stardew connection state render nothing rather than inventing it.
  assert.equal(gameTurnWorldStateText({ state: { snapshot: null } } as never), "");
  assert.equal(gameTurnWorldStateText({ state: undefined } as never), "");
  assert.equal(gameTurnWorldStateText({ state: {} } as never), "");
});

/**
 * The row properties the WIRE publishes for one snapshot family, from `protocol/bridge-v1.schema.json`.
 *
 * The schema is the row-shape authority on both sides: `schema-contract.test.ts` proves `protocol.ts` against it, and
 * the plan parameters are prose about the same rows. Reading it here rather than restating the shapes is what makes the
 * assertion below fail when a family gains or loses a field instead of when someone edits this file.
 */
function rowProperties(family: string): readonly string[] | null {
  const spec = (WIRE_SCHEMA["$defs"]?.snapshot?.properties ?? {})[family];
  const reference = spec?.items?.["$ref"];
  if (typeof reference !== "string") return null;
  const definition = WIRE_SCHEMA["$defs"]?.[reference.slice(reference.lastIndexOf("/") + 1)];
  const properties = definition?.properties;
  return properties === undefined || typeof properties !== "object" ? null : Object.keys(properties);
}

/**
 * Every array family the Host validates, read from `SNAPSHOT_FAMILY_RULES` itself.
 *
 * The table, not a name suffix. The version of this helper that filtered `Snapshot` fields ending in `Targets` was
 * blind to `chests` - a family whose entries each carry their own `items` array, so it cannot be named `*Targets` - and
 * the plan tool could have named a retired family while omitting the live one with this gate staying green. A family
 * added to the Host's validation is now a family the parameter must name.
 */
async function snapshotFamilies(root: string): Promise<readonly string[]> {
  const protocol = await readFile(join(root, "protocol.ts"), "utf8");
  const start = protocol.indexOf("export const SNAPSHOT_FAMILY_RULES");
  assert.notEqual(start, -1, "the family table is declared in protocol.ts");
  const table = protocol.slice(start, protocol.indexOf("]);", start));
  const fields = [...table.matchAll(/\{\s*field:\s*"([A-Za-z0-9_]+)"/gu)].map((match) => match[1] as string);
  assert.ok(fields.length > 0, "the family table declares at least one family");
  return fields;
}

/**
 * The validated families the plan tool's parameters deliberately do not list, each with the reason.
 *
 * A named exclusion, not a name pattern: the pattern version silently exempted every family that was not spelled
 * `*Targets`, which is how a family could be retired from the snapshot and left in the parameter text - or added to the
 * snapshot and never reach a script - without a single assertion moving. Each entry here is a decision someone made.
 */
const FAMILIES_NOT_IN_PLAN_PARAMETERS: Readonly<Record<string, string>> = Object.freeze({
  pendingLevelUps: "`skill@level` strings, not targets: no action takes one as an argument",
  pendingLevelUpChoices: "answered through respond_level_up's own two branch arguments",
  professions: "profession ids, not targets",
  activeSpecialOrderKeys: "quest keys, not targets",
  warps: "traversal facts a script reads but no action addresses by index",
  soilTiles:
    "the soil roster - every hoed or tillable tile within reach, each stating its `hoeDirt` state; till_soil names a tile, not a row",
  toolSlots: "named separately in the parameters beside `currentTool`, because a slot argument reads it",
  wateringCanFacts: "named beside `toolSlots` as the held can's own water facts",
  lanternSlots: "the pack's lantern slots; light_lantern names a tile",
  villagerWhereabouts: "a roster of where villagers are, addressed through npcRelationshipTargets",
  wateringWhereabouts:
    "a per-location summary of how thirsty each map is, read by the fact line and addressed through cropTargets",
  harvestWhereabouts: "a per-location summary, addressed through harvestTargets",
  inventoryItemFacts: "reread evidence for one action, not a family a script loops",
  panSites: "pan_for_ore's sites; published per-family and addressed through the action's own target",
  waterTargets:
    "the tiles a rod may cast at, each with its id; fish_here names one tile and its expectedTargetId, and no action loops over water - a loop over it would be a second cast per tile the engine never asked for",
  seedSupplyTargets:
    "what the seeds she needs sell for and how many she holds - the shortage fact reads it, and no action takes a supply row as an argument (plant_seed names a tile and a slot)",
  discoveryExclusions:
    "why a family came back empty this turn - a diagnostic roster the fact line reads, never a target any action addresses",
});

test("a plan does not hold the turn unless the caller asks it to", async () => {
  // This is a CORRECTION, and the assertion exists so it cannot be undone by accident.
  //
  // `plan_work` first blocked until the program settled, which saved one model round trip (polling fell 48 -> 4) and
  // took away the control points that make a body program usable: while the call is held the model cannot `stop`,
  // `append` or redirect, so `program_stop` is unreachable exactly when a player needs it, and a steering message waits
  // behind the call for up to MAX_PROGRAM_STATUS_WAIT_MS. A companion you cannot interrupt mid-swing is not the product.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const source = await readFile(
    join(root, "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts"),
    "utf8",
  );
  const plan = source.slice(source.indexOf("const submitted = await submitProgram({ programId, nodes });"));
  const guard = plan.indexOf("waitMs <= 0");
  const wait = plan.indexOf("waitForTerminalProgramStatus(");
  assert.ok(guard > 0, "the plan tool guards on the caller's own waitMs");
  assert.ok(wait > guard, "and reaches the shared waiter only past that guard, so the default cannot block");
  // Re-anchored when the answer stopped saying `settled: false` unconditionally: that field now reports the BATCH, so a
  // source assertion about its spelling was a proxy for this property rather than the property itself. What makes the
  // default non-blocking is that the immediate branch awaits nothing - it answers from the snapshot the submit already
  // carried - so the assertion is that the region between the guard and the first awaited read contains no await.
  const waiterAt = plan.indexOf("const bounded =");
  assert.ok(waiterAt > guard, "the guarded branch ends where the bounded wait begins");
  assert.doesNotMatch(
    plan.slice(guard, waiterAt),
    /await |readStatus\(|port\.status\(/u,
    "the immediate answer awaits nothing: it answers from the journal the submit already carried, so it cannot hold the turn",
  );
  assert.match(
    plan.slice(guard, wait),
    /planBatchAnswer\(nodes, recorded,/u,
    "and the immediate answer still names every node the caller wrote",
  );
});

test("the plan tool hands its compiled program to the one submission path a model-authored program takes", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
  const source = await readFile(
    join(root, "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts"),
    "utf8",
  );
  // One call site reaches the port at all: a plan cannot arrive at the Mod by a route a program authored by the
  // model cannot, and a second copy of the submission could drift from the preflight, the journal answer or the
  // reader reveal without any test noticing.
  assert.equal(
    (source.match(/port\.submit\(/gu) ?? []).length,
    1,
    "the program port has exactly one submission call site",
  );
  assert.match(source, /const submitProgram = async \(request: BodyProgramCandidateRequest\) => \{/u);
  assert.match(source, /const result = await invoke\(request, validateBodyProgramCandidateRequest,/u);
  // Both tools enter that one function: the raw tool with its own arguments, the plan tool with what it compiled.
  assert.match(
    source,
    /execute: async \(_toolCallId, params\) => \{\n\s+if \(!isBodyProgramCandidateRequest\(params\)\) throw new Error\("invalid_body_program_tool_arguments"\);\n\s+return submitProgram\(params\);/u,
  );
  assert.match(source, /const submitted = await submitProgram\(\{ programId, nodes \}\);/u);
  // The plan is compiled and submitted in the same call, inside the same frozen closure as the raw program tool.
  assert.match(
    source,
    /return Object\.freeze\(\[\n\s+submitTool\(\),\n\s+Object\.freeze\(\n\s+defineTool\(\{\n\s+name: "stardew_plan_work",/u,
  );
  assert.match(source, /compilePlanScript\(readPlanScriptRequest\(params\), \{/u);
  // It carries the companion's own plan in its own words, and the description says what the Mod does with it.
  const parameters = source.slice(
    source.indexOf("const PLAN_TARGET_FAMILIES"),
    source.indexOf("function isBodyProgramCandidateRequest("),
  );
  assert.ok(parameters.includes("script: Type.String("), "the plan tool takes one script");
  // The description is BUILT from the actions the tool itself compiles against, not written inline: the vocabulary the
  // companion reads and the vocabulary the builder accepts are then the same list by construction. What it says is
  // asserted in `body-program-script.test.ts`, where the description and its gate live beside the surface artifact.
  assert.match(source, /description: planWorkDescription\(readPlanActions\(connection\)\),/u);
  // The population is the Host's own family table, and the LIST is read out of the parameter block itself rather than
  // searched as a substring: several excluded families are named in the prose beside the array (`toolSlots`, the held
  // can's facts), so a substring test would call a correct exclusion stale.
  const families = await snapshotFamilies(root);
  const listed = new Set(
    (parameters.match(/`([a-z][A-Za-z0-9 ]*)`\.split\(/u)?.[1] ?? "").split(" ").filter((name) => name.length > 0),
  );
  assert.ok(
    listed.has("chests"),
    "the family list names `chests`, the container family that replaced the flattened pair",
  );
  assert.deepEqual(
    families.filter((family) => !FAMILIES_NOT_IN_PLAN_PARAMETERS[family] && !listed.has(family)),
    [],
    "every family the Host validates is either listed for scripts or excluded here with a reason",
  );
  assert.deepEqual(
    [...listed].filter((family) => !families.includes(family)),
    [],
    "the family list names an array the Host does not validate",
  );
  // A reason cannot outlive its family, and an entry for a family that IS listed would exempt nothing.
  for (const [family, reason] of Object.entries(FAMILIES_NOT_IN_PLAN_PARAMETERS)) {
    assert.ok(reason.trim().length > 0, `${family} is excluded from the plan parameters with an empty reason`);
    assert.ok(families.includes(family), `${family} is excluded but the Host no longer validates it`);
    assert.equal(listed.has(family), false, `${family} is listed for scripts, so drop its exclusion`);
  }
  // The parameter block is a TEMPLATE: the family lists reach the model expanded, so the clause reader must see the
  // same text the tool parameter carries. The declared lists are read out of the same block, so a constant that stops
  // being declared fails here rather than being silently replaced by an empty string.
  const declaredList = (name: string): readonly string[] => {
    const match = new RegExp(
      `const ${name}: readonly string\\[\\] = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`,
      "u",
    ).exec(parameters);
    assert.notEqual(match, null, `the plan parameters no longer declare \`${name}\``);
    const members = [...match![1]!.matchAll(/"([A-Za-z0-9_]+)"/gu)].map((entry) => entry[1] as string);
    assert.ok(members.length > 0, `\`${name}\` declares no family`);
    return members;
  };
  const parameterText = [
    ["PLAN_TARGET_FAMILIES", [...listed]],
    ["PLAN_TILELESS_FAMILIES", declaredList("PLAN_TILELESS_FAMILIES")],
    ["PLAN_UNIDENTIFIED_FAMILIES", declaredList("PLAN_UNIDENTIFIED_FAMILIES")],
  ].reduce(
    (text, [name, members]) =>
      text.replaceAll(`\${${String(name)}.join(", ")}`, (members as readonly string[]).join(", ")),
    parameters.replaceAll("\\`", "`"),
  );
  assert.ok(
    !/\$\{PLAN_[A-Z_]+FAMILIES\.join/u.test(parameterText),
    "every family interpolation in the parameter block was expanded, so the clauses below are read as the model sees them",
  );
  assert.match(parameterText, /`snapshot\.tile` is your own `\{ x, y \}`/u);
  // THE ROW SHAPE THE PARAMETERS PROMISE, against the wire's own authority.
  //
  // The text used to say "every entry carries `targetId`, `x` and `y`" with four named exceptions. Measured 2026-11-01
  // against `protocol/bridge-v1.schema.json`: 13 of the 69 families carry no tile and the text named 4 of them, one of
  // which (`chests`) does carry `x`/`y`. A script over `minecartTargets` or `shopTargets` that believed the text read a
  // coordinate the row never had, so the population here is the SCHEMA's row shapes over the families the text LISTS as
  // arrays, and the thing read is the CLAIM clause alone - the family list above it also contains every one of these
  // names, so a substring test over the whole parameter block would stay green through exactly the defect this exists
  // for.
  const rowFamilies = [...listed].filter((family) => rowProperties(family) !== null);
  const tileless = rowFamilies.filter((family) => {
    const properties = rowProperties(family)!;
    return !(properties.includes("x") && properties.includes("y"));
  });
  const unidentified = rowFamilies.filter((family) => !rowProperties(family)!.includes("targetId"));
  /**
   * The families a claim about one row property names, read from the description ALONE.
   *
   * The reader is scoped to the tool description (from `One synchronous script body` to the end of its template),
   * because both the family list and the doc comment above `PLAN_TILELESS_FAMILIES` quote the same phrase and name the
   * same families - a substring test over the whole block would stay green through exactly the defect this exists for.
   * Within the description the claim is read to the first sentence break, so a reworded lead still yields the set it
   * lists and the failure is the POPULATION rather than a missing phrase.
   */
  const description = parameterText.slice(parameterText.indexOf("One synchronous script body"));
  const claimFamilies = (property: string): readonly string[] => {
    const claimsAt = description.indexOf("every entry carries");
    assert.notEqual(claimsAt, -1, "the plan tool's description no longer states any row shape");
    const at = description.indexOf(property, claimsAt);
    assert.notEqual(at, -1, `the plan tool's description no longer states the row property ${property}`);
    const rest = description.slice(at + property.length);
    const stop = rest.search(/[;.](?=\s|$)/u);
    const clause = stop === -1 ? rest : rest.slice(0, stop);
    return [...listed].filter((family) => new RegExp(`\\b${family}\\b`, "u").test(clause)).sort();
  };
  assert.deepEqual(
    claimFamilies("`targetId`"),
    [...unidentified].sort(),
    `the plan parameters name the wrong set of families that carry no \`targetId\`. The wire schema says ` +
      `[${[...unidentified].sort().join(", ")}], so an action addressed through one of those cannot be reached by a ` +
      `script that copies \`row.targetId\`.`,
  );
  assert.deepEqual(
    claimFamilies("`x` and `y`"),
    [...tileless].sort(),
    `the plan parameters name the wrong set of families whose rows carry no tile. The wire schema says ` +
      `[${[...tileless].sort().join(", ")}]; a script reading \`row.x\` on a family the text omits gets \`undefined\`, and ` +
      `one the text wrongly lists is a coordinate it was told not to use.`,
  );
  // Equipment is a live fact, not a static one: the parameters name the held tool and the pack's tool slots so a script
  // can read the slot a tool action must name instead of guessing an index.
  assert.match(parameterText, /`snapshot\.currentTool` is the qualified id of the tool the farmer holds/u);
  assert.match(parameterText, /`snapshot\.toolSlots` lists/u);
  // A name the builder does not have answers with the ids it DOES have, bounded, so a typo teaches instead of blocking.
  assert.match(source, /legalActionIds: legalPlanActionIds\(actions\)/u);
  // A builder call with the wrong arguments answers with that action's own declaration - name, kind and closed set -
  // because the per-action tools that used to carry a schema are no longer mounted.
  assert.match(source, /requiredArguments: compiled\.requirement\.requiredArguments,/u);
  // The shape of one action (or one family) stays reachable as a read-only tool instead of 95 schemas in every context.
  assert.match(source, /name: "stardew_plan_shape",/u);
  // A permissive compile is fine; a permissive answer is not. Measured on a live run: six statements, two refused
  // for a missing required argument, and the answer said `{accepted: true, nodeCount: 5}` with nothing else, so the
  // companion planned around an item it never picked up. Both answer branches must carry what was refused.
  assert.match(source, /droppedCount: compiled\.rejectedCount,/u);
  assert.match(source, /dropped: compiled\.rejected\.map\(/u);
  assert.equal(
    [...source.matchAll(/\.\.\.refused,/gu)].length,
    2,
    "both the accepted and the refused answer branch must spread the refusal summary",
  );
  // A caller that names one action writes `actionId`; the schema says `actionIds`. The reader accepts both.
  assert.match(source, /value\.actionIds === undefined \? value\.actionId : value\.actionIds/u);
  // The property, not the sentence: the tool reads its request once and hands that request to `planShape`. Written
  // this way it survives a second local (measured: the reader is now stored so its `received` keys can be echoed).
  assert.match(
    source,
    /readPlanShapeRequest\(params\)[\s\S]{0,200}planShape\(readPlanActions\(connection\), request\);/u,
  );
  // Every outcome answers the same two questions; a refusal adds the compiler's own reason name, unchanged.
  assert.match(
    source,
    /return planDetails\(\{\n\s+accepted: false,\n\s+nodeCount: 0,\n\s+reasonCode: compiled\.reasonCode,/u,
  );
  // What the accepted plan ANSWERS, as a property rather than as one line of source: it must name the program, it must
  // say whether the plan settled, and it must carry the same status payload a status call would have - because the
  // whole point of awaiting inside `plan_work` is that the caller needs no second call to learn the outcome.
  //
  // Re-anchored 2026-11-03: the previous assertion pinned `accepted: code === "accepted" || code === "idempotent"` and
  // went red the moment the return grew. An assertion about the SHAPE of the answer is what this test exists for; the
  // original spelling of that line was not the property.
  // One computation of "accepted", named once and reused by every branch: two spellings of the same predicate is how
  // the refusal path and the success path start disagreeing about what `idempotent` means.
  assert.match(
    source,
    /const accepted = code === "accepted" \|\| code === "idempotent";/u,
    "an accepted submission is named once",
  );
  assert.match(source, /^\s+accepted,$/mu, "and every branch reports that same fact");
  assert.match(source, /^\s+nodeCount: nodes\.length,$/mu, "the plan reports how many steps it carries");
  assert.match(
    source,
    /^\s+settled: answer\.settled,$/mu,
    "the plan reports whether the BATCH settled, not whether this call waited",
  );
  assert.match(source, /^\s+remaining: answer\.remaining,$/mu, "and how many nodes have not stopped yet");
  assert.match(source, /^\s+nodes: answer\.nodes,$/mu, "with one row per node, at the index the caller wrote it");
  assert.match(source, /^\s+status: settled\.result,$/mu, "and carries the status a second call would have fetched");
  assert.match(
    source,
    /await waitForTerminalProgramStatus\(readStatus, first, bounded\)/u,
    "by WAITING for it with the one waiter, not by returning early and inviting a poll",
  );
  // The run artifact keeps the script, the snapshot it read and the program it produced, so a failed plan can be
  // replayed and audited instead of guessed at.
  assert.match(
    source,
    /runTrace\.begin\("plan\.script", \{\n\s+scriptSource: compiled\.scriptSource,\n\s+snapshotRevision: compiled\.snapshotRevision \?\? -1,\n\s+producedProgram: compiled\.ok \? JSON\.stringify\(compiled\.program\) : "",/u,
  );
});
