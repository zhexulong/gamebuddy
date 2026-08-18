import assert from "node:assert/strict";
import test from "node:test";

import {
  FARMHAND_COMPANION_PREVIEW_READY_MARKER,
  parseFarmhandCompanionPreviewConfig,
  relaunchFarmhandCompanionPreviewForTest,
  startFarmhandCompanionPreviewForTest,
  type FarmhandCompanionPreview,
  type FarmhandCompanionPreviewDependencies,
} from "./farmhand-companion-preview.js";
import { createActionExecutionCoordinator } from "./action-execution-coordinator.internal.js";
import { RECEIPT_BACKED_INTEGRATION_AUTHORITY, type IntegrationLaunchHandle } from "./integration-launcher.js";
import type { IntegrationConnection } from "./integration-types.js";
import {
  StardewExecutionRecoverySupervisor,
  type ExactReceiptRecoveryPort,
} from "./stardew-execution-recovery-supervisor.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

const config = {
  schemaVersion: 1,
  runtimeRoot: "E:\\GameBuddy\\preview",
  runtimeInstanceId: "runtime_01",
  requiredPresentationLocale: "zh-CN",
  identity: { playerId: "player_01", companionId: "companion_01", saveId: "save_01", worldId: "world_01" },
  bridge: { pipeName: "gamebuddy_preview", bridgeToken: "a".repeat(32) },
};

function handle(presentationLocale = "zh-CN"): IntegrationLaunchHandle {
  const connection = {
    scope: {
      integrationId: "stardew",
      saveId: "save_01",
      worldId: "world_01",
      playerId: "player_01",
      companionId: "companion_01",
    },
    module: STARDEW_INTEGRATION_MODULE,
    state: {
      connected: true,
      capabilities: ["move_to_tile"],
      latestReceipt: null,
      latestReasonCode: null,
      snapshot: { revision: 3, presentationLocale },
    },
    executionGate: { executable: true },
  } as never;
  return {
    connection,
    presentationBridge: {
      state: { snapshot: { revision: 3 } },
      async presentCompanionText() {},
      async presentSystemNotice() {},
    },
    events: { onFact: () => () => undefined, onLifecycle: () => () => undefined },
    authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
    lifecycle: "ready",
    initialFacts: [{ source: "stardew_mod", kind: "snapshot", correlationId: "snapshot_01", revision: 3, payload: {} }],
    revoke() {},
    close() {},
  };
}

function dependencies(
  events: string[],
  launch = handle(),
  captureEvidence?: (value: unknown) => void,
): FarmhandCompanionPreviewDependencies {
  const runtime = {
    session: { dispose: () => events.push("dispose") },
    interruption: {} as never,
    interruptIntegrationExecutions: async () => {
      events.push("interrupt");
    },
  } as never;
  return {
    launcher: {
      integrationId: "stardew",
      module: STARDEW_INTEGRATION_MODULE,
      launch: async () => {
        events.push("launch");
        return launch;
      },
    },
    createRuntime: async (_identity, _root, _connection, presentationBridge, _sessionId, turnTracker, presentationLocale) => {
      events.push("runtime");
      assert.equal(typeof presentationBridge.presentCompanionText, "function");
      assert.ok(turnTracker instanceof Object);
      assert.equal(
        presentationLocale,
        (launch.connection.state as { snapshot: { presentationLocale: string } }).snapshot.presentationLocale,
      );
      return runtime;
    },
    createLoop: () => ({ attachTurnObserver: () => events.push("bind-worker") }) as never,
    createHost: (_loop, _launch, _runtime, turnTracker, evidence) => {
      assert.ok(turnTracker instanceof Object);
      captureEvidence?.(evidence);
      return {
        attachVoiceStopper: () => events.push("bind-stop"),
        attachStopSystemNoticePresenter: () => events.push("bind-stop-system-notice"),
        acceptInitialFacts: () => events.push("initial-facts"),
        close: () => events.push("host-close"),
      } as never;
    },
  };
}

test("production entry exposes a fixed redacted readiness marker", () => {
  assert.equal(FARMHAND_COMPANION_PREVIEW_READY_MARKER, "farmhand_companion_preview_ready");
  assert.match(FARMHAND_COMPANION_PREVIEW_READY_MARKER, /^[a-z0-9_]+$/);
});

test("preview config rejects untrusted capability, legacy bridge expiry, and invalid identities", () => {
  assert.throws(
    () => parseFarmhandCompanionPreviewConfig({ ...config, capabilities: ["move_to_tile"] }),
    /invalid_farmhand_companion_preview_config/,
  );
  assert.throws(
    () =>
      parseFarmhandCompanionPreviewConfig({ ...config, bridge: { ...config.bridge, expiresAtUnixMs: 1_060_000 } }),
    /invalid_farmhand_companion_preview_config/,
  );
  assert.throws(
    () => parseFarmhandCompanionPreviewConfig({ ...config, identity: { ...config.identity, playerId: "bad id" } }),
    /invalid_farmhand_companion_preview_config/,
  );
  assert.throws(
    () =>
      parseFarmhandCompanionPreviewConfig({ ...config, identity: { ...config.identity, continuityId: "semantic_memory_partition" } }),
    /invalid_farmhand_companion_preview_config/,
  );
  assert.throws(
    () => parseFarmhandCompanionPreviewConfig({ ...config, requiredPresentationLocale: "ja-JP" }),
    /invalid_farmhand_companion_preview_config/,
  );
});

test("preview launches observed bridge before runtime and binds initial snapshot only after STOP/worker wiring", async () => {
  const events: string[] = [];
  await startFarmhandCompanionPreviewForTest(config, dependencies(events));
  assert.deepEqual(events, ["launch", "runtime", "bind-worker", "bind-stop", "bind-stop-system-notice", "initial-facts"]);
});

test("preview accepts the release-verified en-US locale and rejects an observed locale mismatch", async () => {
  const englishConfig = { ...config, requiredPresentationLocale: "en-US" as const };
  const englishEvents: string[] = [];
  await startFarmhandCompanionPreviewForTest(englishConfig, dependencies(englishEvents, handle("en-US")));
  assert.deepEqual(englishEvents, ["launch", "runtime", "bind-worker", "bind-stop", "bind-stop-system-notice", "initial-facts"]);

  const events: string[] = [];
  const bad = handle("en-US");
  const close = () => events.push("close");
  const revoke = () => events.push("revoke");
  const launch = { ...bad, close, revoke };
  await assert.rejects(
    startFarmhandCompanionPreviewForTest(config, dependencies(events, launch)),
    /farmhand_preview_presentation_locale_mismatch/,
  );
  assert.deepEqual(events, ["launch", "revoke", "close"]);
});

test("preview rejects a launch without an exact observed initial snapshot and closes bridge", async () => {
  const events: string[] = [];
  const bad = handle();
  const close = () => events.push("close");
  const revoke = () => events.push("revoke");
  const launch = { ...bad, initialFacts: [], close, revoke };
  await assert.rejects(
    startFarmhandCompanionPreviewForTest(config, dependencies(events, launch)),
    /receipt_backed_integration_launch_required/,
  );
  assert.deepEqual(events, ["launch", "revoke", "close"]);
});

test("preview rejects a launch without its adapter-owned presentation bridge before runtime construction", async () => {
  const events: string[] = [];
  const bad = handle();
  const close = () => events.push("close");
  const revoke = () => events.push("revoke");
  const launch = { ...bad, presentationBridge: undefined, close, revoke };
  await assert.rejects(
    startFarmhandCompanionPreviewForTest(config, dependencies(events, launch)),
    /farmhand_preview_presentation_bridge_unavailable/,
  );
  assert.deepEqual(events, ["launch", "revoke", "close"]);
});

test("preview passes its activated evidence sink into the real Host composition", async () => {
  const events: string[] = [];
  const launch = handle();
  const evidenceConfig = {
    ...config,
    evidence: {
      path: "E:\\GameBuddy\\preview-evidence.jsonl",
      manifestSha256: "a".repeat(64),
    },
  };
  let receivedEvidence: unknown;
  await startFarmhandCompanionPreviewForTest(
    evidenceConfig,
    dependencies(events, launch, (evidence) => {
      receivedEvidence = evidence;
    }),
  );
  assert.ok(receivedEvidence !== undefined);
});

test("preview close revokes before Host/runtime disposal and bridge close, once", async () => {
  const events: string[] = [];
  const base = handle();
  const launch = { ...base, revoke: () => events.push("revoke"), close: () => events.push("close") };
  const preview = await startFarmhandCompanionPreviewForTest(config, dependencies(events, launch));
  await preview.close();
  await preview.close();
  assert.deepEqual(events, [
    "launch",
    "runtime",
    "bind-worker",
    "bind-stop",
    "bind-stop-system-notice",
    "initial-facts",
    "revoke",
    "host-close",
    "interrupt",
    "dispose",
    "close",
  ]);
});

/** A game-shaped predecessor runtime whose private coordinator holds one uncertain dispatch. */
function gameRuntimeWithCoordinator(events: string[]) {
  const connection = {
    module: {
      cancelExecution: async () => ({
        requestId: "request_recovery_01",
        executionId: "execution_recovery_01",
        state: "cancelled" as const,
        reasonCode: "stop_requested",
        revision: 1,
        evidence: null,
      }),
    },
  } as unknown as IntegrationConnection;
  const coordinator = createActionExecutionCoordinator(connection);
  const admission = coordinator.createAdmission();
  const dispatch = {
    ...admission.owner,
    requestId: "request_recovery_01",
    idempotencyKey: "idempotency_recovery_01",
  };
  admission.observer.beforeWrite(dispatch);
  admission.observer.markUncertain(dispatch);
  const runtime = {
    session: { dispose: () => events.push("dispose") },
    recoverStardewExecutionReceipts: async (port: ExactReceiptRecoveryPort) => {
      events.push("recover");
      return await new StardewExecutionRecoverySupervisor(coordinator).recoverFromFreshBinding(port);
    },
  } as never;
  return { runtime, uncertain: () => coordinator.uncertainDispatches() };
}

function predecessorPreview(events: string[]): FarmhandCompanionPreview {
  const { runtime } = gameRuntimeWithCoordinator(events);
  return { host: {} as never, runtime, identity: config.identity, close: async () => { events.push("close"); } };
}

test("relaunch is explicit only: a non-game predecessor never reaches the launcher", async () => {
  const events: string[] = [];
  const predecessor = {
    host: {} as never,
    runtime: { session: { dispose: () => events.push("dispose") } } as never,
    identity: config.identity,
    close: async () => { events.push("close"); },
  };
  await assert.rejects(
    relaunchFarmhandCompanionPreviewForTest(predecessor, config, dependencies(events)),
    /farmhand_preview_relaunch_requires_game_runtime/,
  );
  assert.deepEqual(events, [], "no launch may happen without an explicit capable relaunch");
});

test("relaunch rejects a different game identity before opening a new binding", async () => {
  const events: string[] = [];
  const { runtime, uncertain } = gameRuntimeWithCoordinator(events);
  const predecessor = { host: {} as never, runtime, identity: config.identity, close: async () => { events.push("close"); } };
  const foreignConfig = {
    ...config,
    identity: { ...config.identity, saveId: "save_02", worldId: "world_02" },
  };
  await assert.rejects(
    relaunchFarmhandCompanionPreviewForTest(predecessor, foreignConfig, dependencies(events)),
    /farmhand_preview_relaunch_identity_mismatch/,
  );
  assert.deepEqual(events, []);
  assert.equal(uncertain().length, 1);
});

test("relaunch fails closed before recovery when the new launch is not receipt-backed", async () => {
  const events: string[] = [];
  const { runtime, uncertain } = gameRuntimeWithCoordinator(events);
  const predecessor = { host: {} as never, runtime, identity: config.identity, close: async () => { events.push("close"); } };
  const bad = handle();
  const launch = { ...bad, initialFacts: [], close: () => events.push("close"), revoke: () => events.push("revoke") };
  await assert.rejects(
    relaunchFarmhandCompanionPreviewForTest(predecessor, config, dependencies(events, launch)),
    /receipt_backed_integration_launch_required/,
  );
  assert.equal(uncertain().length, 1, "a failed authoritative launch must never invoke recovery");
  assert.deepEqual(events, ["launch", "revoke", "close"]);
});

test("relaunch rejects a new binding without the narrow receiptRecovery capability and closes it", async () => {
  const events: string[] = [];
  const { runtime, uncertain } = gameRuntimeWithCoordinator(events);
  const predecessor = { host: {} as never, runtime, identity: config.identity, close: async () => { events.push("close"); } };
  const launch = { ...handle(), close: () => events.push("close"), revoke: () => events.push("revoke") };
  await assert.rejects(
    relaunchFarmhandCompanionPreviewForTest(predecessor, config, dependencies(events, launch)),
    /farmhand_preview_receipt_recovery_capability_unavailable/,
  );
  assert.equal(uncertain().length, 1, "no recovery may run without the validated capability");
  assert.deepEqual(events, ["launch", "revoke", "close"]);
});

test("one explicit relaunch launches once, recovers the private coordinator once, and never reissues an action", async () => {
  const events: string[] = [];
  const { runtime, uncertain } = gameRuntimeWithCoordinator(events);
  const predecessor = { host: {} as never, runtime, identity: config.identity, close: async () => { events.push("close"); } };
  assert.equal(uncertain().length, 1, "the predecessor coordinator must hold one uncertain dispatch");
  const queries: Array<{ requestId: string; idempotencyKey: string }> = [];
  let actionExecuted = false;
  const base = handle();
  const connection = {
    scope: base.connection.scope,
    module: base.connection.module,
    state: base.connection.state,
    executionGate: base.connection.executionGate,
    execute: async () => {
      actionExecuted = true;
      throw new Error("action_replay_must_not_happen");
    },
  } as never;
  const launch = {
    ...base,
    connection,
    receiptRecovery: {
      queryExecutionReceipt: async (query: { requestId: string; idempotencyKey: string }) => {
        queries.push(query);
        return {
          requestId: query.requestId,
          executionId: "execution_recovery_01",
          state: "succeeded" as const,
          reasonCode: "soil_tilled",
          revision: 2,
          evidence: { targetId: "soil_01" },
        };
      },
    } as ExactReceiptRecoveryPort,
  };
  const next = await relaunchFarmhandCompanionPreviewForTest(predecessor, config, dependencies(events, launch));
  assert.deepEqual(events, [
    "launch",
    "recover",
    "runtime",
    "bind-worker",
    "bind-stop",
    "bind-stop-system-notice",
    "initial-facts",
  ]);
  assert.deepEqual(queries, [{ requestId: "request_recovery_01", idempotencyKey: "idempotency_recovery_01" }]);
  assert.equal(uncertain().length, 0, "the recovered receipt must be admitted through the private coordinator");
  assert.equal(actionExecuted, false, "relaunch must never reissue an action request");
  await next.close();
});

test("relaunch is single-flight; a concurrent explicit relaunch fails closed", async () => {
  const events: string[] = [];
  const { runtime } = gameRuntimeWithCoordinator(events);
  const predecessor = { host: {} as never, runtime, identity: config.identity, close: async () => { events.push("close"); } };
  let releaseLaunch!: () => void;
  const gate = new Promise<void>((resolvePromise) => {
    releaseLaunch = resolvePromise;
  });
  let launchCount = 0;
  const deps = {
    launcher: {
      integrationId: "stardew",
      module: STARDEW_INTEGRATION_MODULE,
      launch: async () => {
        launchCount++;
        await gate;
        return {
          ...handle(),
          receiptRecovery: {
            queryExecutionReceipt: async () => ({
              requestId: "request_recovery_01",
              executionId: "execution_recovery_01",
              state: "succeeded" as const,
              reasonCode: "soil_tilled",
              revision: 2,
              evidence: { targetId: "soil_01" },
            }),
          },
        };
      },
    },
    createRuntime: async () => ({ session: { dispose: () => events.push("dispose") } }) as never,
    createLoop: () => ({ attachTurnObserver: () => events.push("bind-worker") }) as never,
    createHost: () =>
      ({
        attachVoiceStopper: () => events.push("bind-stop"),
        attachStopSystemNoticePresenter: () => events.push("bind-stop-system-notice"),
        acceptInitialFacts: () => events.push("initial-facts"),
        close: () => events.push("host-close"),
      }) as never,
  } as unknown as FarmhandCompanionPreviewDependencies;
  const first = relaunchFarmhandCompanionPreviewForTest(predecessor, config, deps);
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  await assert.rejects(
    relaunchFarmhandCompanionPreviewForTest(predecessor, config, deps),
    /farmhand_preview_relaunch_in_flight/,
  );
  releaseLaunch!();
  await first;
  assert.equal(launchCount, 1, "single-flight forbids a second launch while the first is in progress");
});

test("relaunch fails closed when the predecessor preview has closed", async () => {
  const events: string[] = [];
  const launch = handle();
  const preview = await startFarmhandCompanionPreviewForTest(config, dependencies(events, launch));
  await preview.close();
  await assert.rejects(
    relaunchFarmhandCompanionPreviewForTest(preview, config, dependencies(events, handle())),
    /farmhand_preview_relaunch_predecessor_closed/,
  );
  assert.deepEqual(
    events.filter((event) => event === "launch"),
    ["launch"],
    "a closed predecessor must never launch again",
  );
});
