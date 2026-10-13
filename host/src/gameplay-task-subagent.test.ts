import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import {
  admitGameplayAction,
  awaitTaskOwnedTerminalReceipt,
  GameplayTaskSubagent,
  hasActionPostconditionEvidence,
  hasAuthoritativeCompletion,
  selectTaskOwnedCancellation,
} from "./gameplay-task-subagent.js";
import type { ExecutionWake, IntegrationLaunchHandle } from "./integration-launcher.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import type { Scope } from "./protocol.js";
import { createStardewIntegrationLaunchHandleFromAuthenticatedBridge } from "./stardew-integration-launcher.js";
import type { RuntimePaths } from "./runtime.js";

const paths: RuntimePaths = {
  root: tmpdir(),
  runtimeCwd: join(tmpdir(), "gamebuddy-gameplay-task-tests"),
  agentDir: join(tmpdir(), "gamebuddy-gameplay-task-tests", "pi-agent"),
  sessionDir: join(tmpdir(), "gamebuddy-gameplay-task-tests", "sessions"),
  identityProfilePath: join(tmpdir(), "gamebuddy-gameplay-task-tests", "identity-profile.json"),
  identityProfileBindingPath: join(tmpdir(), "gamebuddy-gameplay-task-tests", "identity-profile-binding.json"),
  runManifestPath: join(tmpdir(), "gamebuddy-gameplay-task-tests", "companion-run-manifest.json"),
};

const integration: StardewBridgeConnection = {
  scope: {
    integrationId: "stardew",
    saveId: "save_01",
    worldId: "world_01",
    playerId: "player_01",
    companionId: "companion_01",
  },
  state: {
    connected: false,
    sessionId: null,
    capabilities: [],
    snapshot: null,
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  },
  module: STARDEW_GAME_INTEGRATION_ADAPTER,
};

test("GameplayTaskSubagent exposes no mutable task trace before a Host-created task runs", () => {
  const worker = new GameplayTaskSubagent(paths, integration);
  assert.equal(worker.activeTaskId, null);
  assert.equal(worker.lastTaskRecord, null);
  assert.equal(worker.lastTaskResult, null);
  worker.dispose();
  assert.equal(worker.activeTaskId, null);
});

test("completed worker report requires a succeeded evidenced receipt owned by the task", () => {
  const succeeded = {
    executionId: "execution_01",
    actionId: "move_to_tile",
    requestId: "request_01",
    state: "succeeded" as const,
    reasonCode: "soil_tilled",
    revision: 1,
    evidence: {
      detail:
        "location=Farm;target=3,4;before=none;after=HoeDirt;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
    },
  };
  const report = {
    state: "completed",
    evidence: { requestId: "request_01", executionId: "execution_01" },
  };
  const owned = [
    {
      actionId: "till_soil",
      requestId: "request_01",
      executionId: "execution_01",
    },
  ];
  assert.equal(
    hasAuthoritativeCompletion(report, succeeded, owned, STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog),
    true,
  );
  assert.equal(
    hasAuthoritativeCompletion(
      report,
      { ...succeeded, evidence: null },
      owned,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasAuthoritativeCompletion(
      report,
      { ...succeeded, state: "running" },
      owned,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasAuthoritativeCompletion(
      {
        ...report,
        evidence: { requestId: "other", executionId: "execution_01" },
      },
      succeeded,
      owned,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasAuthoritativeCompletion(report, succeeded, [], STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog),
    false,
  );
});

test("pickup_forage authoritative completion binds evidence target identity to pending request", () => {
  const catalog = STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog;
  const receipt = {
    requestId: "request_01",
    executionId: "execution_01",
    actionId: "pickup_forage",
    state: "succeeded",
    reasonCode: "forage_picked_up",
    revision: 1,
    evidence: {
      detail:
        "location=Farm;targetIdentity=forage_01;tile=3,4;item=(O)398;removed=true;inventory_before=0;inventory_after=1",
    },
  } as const;
  const execution = {
    actionId: "pickup_forage",
    requestId: "request_01",
    executionId: "execution_01",
    expectedTargetId: "forage_01",
    sceneTargetRef: "sr1_target_01",
  } as const;
  const report = {
    state: "completed",
    evidence: { requestId: "request_01", executionId: "execution_01" },
  } as const;
  assert.equal(hasAuthoritativeCompletion(report, receipt, [execution], catalog), true);
  assert.equal(
    hasAuthoritativeCompletion(
      report,
      { ...receipt, evidence: { detail: receipt.evidence.detail.replace("forage_01", "forage_02") } },
      [execution],
      catalog,
    ),
    false,
  );
});

test("completion evidence must contain action-specific postcondition keys", () => {
  assert.equal(
    hasActionPostconditionEvidence(
      "equip_tool",
      {
        reasonCode: "tool_equipped",
        evidence: { detail: "tool=Axe;before=none;expected=Axe;after=Axe" },
      },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    true,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "equip_tool",
      { reasonCode: "tool_equipped", evidence: { detail: "tool=Axe;before=Axe;expected=Axe;after=Axe" } },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "equip_tool",
      {
        reasonCode: "unexpected_success",
        evidence: { detail: "tool=Axe;before=none;expected=Axe;after=Axe" },
      },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "unknown_action",
      { reasonCode: "succeeded", evidence: { detail: "anything" } },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "till_soil",
      {
        reasonCode: "soil_tilled",
        evidence: { detail: "before=none;after=Stone" },
      },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  const planted = {
    reasonCode: "seed_planted",
    evidence: {
      detail: "location=Farm;target=seed_target_01;tile=3,4;item=(O)479;crop=479;inventory_before=2;inventory_after=1",
    },
  };
  assert.equal(
    hasActionPostconditionEvidence("plant_seed", planted, STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog),
    true,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "plant_seed",
      {
        ...planted,
        evidence: {
          detail:
            "location=Farm;target=seed_target_01;tile=3,4;item=(O)479;crop=479;inventory_before=2;inventory_after=2",
        },
      },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "plant_seed",
      {
        ...planted,
        evidence: {
          detail:
            "location=Farm;target=seed_target_01;tile=3,4;item=(O)479;crop=none;inventory_before=2;inventory_after=1",
        },
      },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
    ),
    false,
  );
});

test("Gameplay action admission enforces only the single embodied actor mutation serialization before dispatch", () => {
  const record = { executions: [] };
  const liveCapabilities = TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId);
  const policy = STARDEW_GAME_INTEGRATION_ADAPTER.defaultPolicy;
  assert.deepEqual(
    admitGameplayAction(
      "till_soil",
      record,
      null,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
    ),
    { ok: true },
  );
  assert.deepEqual(
    admitGameplayAction(
      "equip_tool",
      record,
      null,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
    ),
    { ok: true },
  );
  assert.deepEqual(
    admitGameplayAction(
      "equip_tool",
      record,
      null,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
    ),
    { ok: true },
  );
  assert.deepEqual(
    admitGameplayAction(
      "equip_tool",
      record,
      { requestId: "request_01", executionId: "execution_01" },
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
    ),
    { ok: false, reasonCode: "gameplay_task_active_execution_exists" },
  );
  assert.deepEqual(
    admitGameplayAction(
      "not_published",
      record,
      null,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
    ),
    {
      ok: false,
      reasonCode: "unknown_gameplay_action",
    },
  );
  assert.deepEqual(
    admitGameplayAction(
      "equip_tool",
      {
        ...record,
        executions: [
          {
            actionId: "move_to_tile",
            requestId: "request_01",
            executionId: "execution_01",
            state: "running",
          },
        ],
      },
      null,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
    ),
    { ok: false, reasonCode: "gameplay_task_active_execution_exists" },
  );
  // The freshness fence is armed by the highest revision a task-owned terminal
  // receipt observed, and refuses while the admitted projection is older - or
  // absent. (The worker only reaches this through a task-owned receipt; the
  // integration-level shape of the fence is asserted in the worker test below.)
  assert.deepEqual(
    admitGameplayAction(
      "equip_tool",
      { executions: [], minimumSnapshotRevision: 8 },
      null,
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
      7,
    ),
    { ok: false, reasonCode: "gameplay_task_snapshot_stale" },
  );
});

type MutableIntegrationState = {
  connected: boolean;
  sessionId: string | null;
  capabilities: string[];
  catalogRegistrations: readonly import("./protocol.js").ActionRegistration[];
  snapshot: any;
  latestReceipt: any;
  latestReasonCode: string | null;
};

const BRIDGE_SCOPE: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
});
const BRIDGE_TOKEN = "gameplay_task_bridge_token_0123456789";
const BRIDGE_GENERATION = "gameplay_task_generation_01";
const BRIDGE_CATALOG_REVISION = 1;
const BRIDGE_POLICY_IDENTITY = Object.freeze({
  value: "0123456789abcdef0123456789abcdef",
  capabilityRevision: 1,
});

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function until(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(message);
}

type ScriptedMod = Readonly<{
  connection: StardewBridgeConnection;
  state: MutableIntegrationState;
  /** Script the Mod's response to the next execution_request, exactly as the old in-process fake's `execute` did. */
  setExecute(handler: (request: any) => Promise<any>): void;
  /** Publish a durable receipt the Mod mints outside an execute response, and wait until the client admitted it. */
  publishReceipt(receipt: any): Promise<void>;
  /** Publish whatever `state.latestReceipt` currently holds - the shape the old in-process fake used. */
  publishLatestReceipt(): Promise<void>;
}>;

/**
 * The Stardew adapter reaches identity/scope/state/tool surfaces only through
 * the exact connection an authenticated launch minted, so a caller-built object
 * cannot drive this worker at all: the first readState/createToolSet call dies
 * with `stardew_connection_not_authenticated_or_not_live` and the test exercises
 * nothing. This harness stands up the narrow Mod side of the named pipe, drives
 * the real LocalStardewBridgeClient handshake, and mints the connection through
 * the same launch production runtime-core consumes - the pattern
 * local-stardew-bridge-attestation.test.ts uses for its own authenticated reads.
 */
async function withScriptedMod(
  initial: MutableIntegrationState,
  calls: { execute: string[]; cancel: string[] },
  operation: (mod: ScriptedMod) => Promise<void>,
): Promise<void> {
  const state = initial;
  const pipeName = `gamebuddy_gameplay_task_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  // The Mod mints the action-transaction revision. A durable receipt advances
  // it, so a later observe never replays a revision the client already left.
  let revision = state.snapshot?.revision ?? 1;
  let socket: Socket | undefined;
  let executeHandler: (request: any) => Promise<any> = async (request) => {
    calls.execute.push(request.action);
    return {
      requestId: request.requestId,
      executionId: `execution_${calls.execute.length}`,
      actionId: request.action,
      state: "accepted",
      reasonCode: "accepted",
      revision: request.expectedRevision,
      evidence: null,
    };
  };
  const snapshotPayload = () => ({
    ...state.snapshot,
    revision,
    capabilities: [...state.capabilities],
    catalogRevision: BRIDGE_CATALOG_REVISION,
    enabledActionIds: [...state.capabilities],
    presentationLocale: "en-US",
    weather: state.snapshot?.weather ?? "sunny",
    timeOfDay: state.snapshot?.timeOfDay ?? 600,
    dayOfMonth: state.snapshot?.dayOfMonth ?? 1,
    seasonIndex: state.snapshot?.seasonIndex ?? 0,
    year: state.snapshot?.year ?? 1,
  });
  const respond = async (request: any): Promise<void> => {
    const peer = socket;
    if (peer === undefined) return;
    if (request.type === "hello") {
      peer.write(
        frame({
          ...request,
          messageId: "mod_hello",
          type: "hello_ack",
          payload: {
            sessionId: state.sessionId ?? "session_01",
            capabilities: [...state.capabilities],
            catalogRevision: BRIDGE_CATALOG_REVISION,
            policyIdentity: BRIDGE_POLICY_IDENTITY,
            enabledActionIds: [...state.capabilities],
            presentationLocale: "en-US",
            registrations: [...state.catalogRegistrations],
            runtimeRole: "farmhand_client",
            launchGeneration: BRIDGE_GENERATION,
          },
        }),
      );
      return;
    }
    if (request.type === "observe_request") {
      peer.write(frame({ ...request, messageId: "mod_snapshot", type: "snapshot", payload: snapshotPayload() }));
      return;
    }
    if (request.type === "execution_request") {
      const receipt = await executeHandler(request.payload);
      state.latestReceipt = receipt;
      revision = Math.max(revision, receipt.revision ?? revision);
      peer.write(
        frame({ ...request, messageId: "mod_execution_receipt", type: "execution_receipt", payload: receipt }),
      );
      return;
    }
    if (request.type === "cancel_request") {
      calls.cancel.push(`${request.payload.requestId}:${request.payload.executionId}:${request.payload.reasonCode}`);
      const receipt = {
        requestId: request.payload.requestId,
        executionId: request.payload.executionId,
        actionId: "cancel_active_execution",
        state: "cancelled",
        reasonCode: request.payload.reasonCode,
        revision,
        evidence: null,
      };
      state.latestReceipt = receipt;
      peer.write(frame({ ...request, messageId: "mod_cancel_receipt", type: "execution_receipt", payload: receipt }));
      return;
    }
    peer.write(
      frame({ ...request, messageId: "mod_error", type: "error", payload: { reasonCode: "unexpected_request" } }),
    );
  };
  const server: Server = createServer((peer) => {
    socket = peer;
    peer.once("close", () => {
      if (socket === peer) socket = undefined;
    });
    let buffer = Buffer.alloc(0);
    peer.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        void respond(request);
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject),
  );
  let client: LocalStardewBridgeClient | undefined;
  let launch: IntegrationLaunchHandle | undefined;
  try {
    client = await LocalStardewBridgeClient.connectFarmhand(
      BRIDGE_SCOPE,
      pipeName,
      BRIDGE_TOKEN,
      BRIDGE_GENERATION,
      Date.now() + 5_000,
      STARDEW_GAME_INTEGRATION_ADAPTER,
    );
    launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
      client,
      Object.freeze({
        playerId: BRIDGE_SCOPE.playerId,
        companionId: BRIDGE_SCOPE.companionId,
        continuityId: "continuity_gameplay_task_tests",
        saveId: BRIDGE_SCOPE.saveId,
        worldId: BRIDGE_SCOPE.worldId,
      }),
      { module: STARDEW_GAME_INTEGRATION_ADAPTER },
    );
    const live = client;
    const publishReceipt = async (receipt: any): Promise<void> => {
      state.latestReceipt = receipt;
      revision = Math.max(revision, receipt.revision ?? revision);
      socket?.write(
        frame({
          protocolVersion: 1,
          messageId: `mod_receipt_${revision}_${receipt.executionId}`,
          correlationId: `mod_receipt_${revision}_${receipt.executionId}`,
          timestampMs: Date.now(),
          scope: BRIDGE_SCOPE,
          type: "execution_receipt",
          payload: receipt,
        }),
      );
      await until(() => {
        const current = live.state.latestReceipt;
        return (
          current !== null &&
          current.requestId === receipt.requestId &&
          current.executionId === receipt.executionId &&
          current.state === receipt.state
        );
      }, "mod_receipt_not_admitted");
    };
    await operation(
      Object.freeze({
        connection: launch.connection as StardewBridgeConnection,
        state,
        setExecute: (handler) => {
          executeHandler = handler;
        },
        publishReceipt,
        publishLatestReceipt: async () => {
          const receipt = state.latestReceipt;
          if (receipt === null || receipt === undefined) throw new Error("mod_has_no_receipt_to_publish");
          await publishReceipt(receipt);
        },
      }),
    );
  } finally {
    launch?.close();
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function testDispatchAdmissionFactory(mounted: { cancel?: (...args: any[]) => any }) {
  let generation = 0;
  return () => {
    const owner = { ownerId: `worker_test_${++generation}`, epoch: 0 };
    const ledger = new ExecutionCorrelationLedger((requestId, executionId, reasonCode) =>
      mounted.cancel!(requestId, executionId, reasonCode),
    );
    return {
      owner,
      observer: ledger,
      cancelExact: (requestId: string, executionId: string, reasonCode: string) =>
        ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
      cancelPending: (reasonCode: string) => {
        void ledger.requestCancelOwner(owner, reasonCode);
      },
    };
  };
}

function fakeSession(
  tools: readonly ToolDefinition[],
  script: (tools: readonly ToolDefinition[]) => Promise<void>,
  onAbort?: () => void,
): AgentSession {
  return {
    agent: { state: { tools } },
    messages: [],
    subscribe: () => () => undefined,
    prompt: async () => script(tools),
    abort: async () => {
      onAbort?.();
    },
    dispose: () => undefined,
  } as unknown as AgentSession;
}

function liveSnapshot(capabilities: string[]) {
  return {
    revision: 7,
    location: "Farm",
    tile: { x: 1, y: 2 },
    stamina: 100,
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities,
    activeExecution: null,
  };
}

async function invoke(tools: readonly ToolDefinition[], name: string, params: Record<string, unknown>) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing_test_tool:${name}`);
  return tool.execute("test_call", params, new AbortController().signal, undefined, undefined as never);
}

test("GameplayTaskSubagent reserves before construction, binds abort to its task, and releases only after finalization", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool"],
    snapshot: liveSnapshot(["equip_tool"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let resolveConstruction!: (session: AgentSession) => void;
    let constructions = 0;
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: ({ customTools }) => {
          if (constructions++ === 0)
            return new Promise<AgentSession>((resolve) => {
              resolveConstruction = resolve;
            });
          return Promise.resolve(fakeSession(customTools, async () => undefined));
        },
      },
      undefined,
      testDispatchAdmissionFactory(mounted),
    );
    const parent = new AbortController();
    const runningA = worker.run("A", parent.signal);
    while (resolveConstruction === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(worker.run("B"), /gameplay_task_already_active/);
    parent.abort();
    resolveConstruction(fakeSession([], async () => undefined));
    const resultA = await runningA;
    assert.equal(resultA.state, "cancelled");
    const resultB = await worker.run("B");
    assert.equal(resultB.state, "blocked");
  });
});

test("GameplayTaskSubagent releases a failed workspace reservation without a CWD mutation", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: [],
    snapshot: liveSnapshot([]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let workspaceAttempts = 0;
    const worker = new GameplayTaskSubagent(paths, mounted, undefined, {
      createWorkspace: async () => {
        if (workspaceAttempts++ === 0) throw new Error("workspace_creation_failed");
        return join(paths.runtimeCwd, "allocated-workspace");
      },
      create: async ({ customTools }) => fakeSession(customTools, async () => undefined),
    });
    assert.equal((await worker.run("first")).state, "blocked");
    assert.equal(worker.activeTaskId, null);
    assert.equal((await worker.run("second")).state, "blocked");
    assert.equal(workspaceAttempts, 2);
  });
});

test("GameplayTaskSubagent releases a failed construction reservation", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: [],
    snapshot: liveSnapshot([]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let attempts = 0;
    const worker = new GameplayTaskSubagent(paths, mounted, undefined, {
      create: async ({ customTools }) => {
        if (attempts++ === 0) throw new Error("construction_failed");
        return fakeSession(customTools, async () => undefined);
      },
    });
    assert.equal((await worker.run("first")).state, "blocked");
    assert.equal((await worker.run("second")).state, "blocked");
  });
});

test("Gameplay worker hides action tools without a runtime-owned dispatch admission", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "cancel_active_execution"],
    snapshot: liveSnapshot(["equip_tool", "cancel_active_execution"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let mountedNames: readonly string[] = [];
    const worker = new GameplayTaskSubagent(paths, mounted, undefined, {
      create: async ({ customTools }) => {
        mountedNames = customTools.map((tool) => tool.name);
        return fakeSession(customTools, async () => undefined);
      },
    });
    const result = await worker.run("admission required");
    assert.equal(result.state, "blocked");
    assert.equal(mountedNames.includes("stardew_equip_tool"), false);
    assert.equal(mountedNames.includes("stardew_cancel_active_execution"), false);
    // The narrowed control is a DIFFERENT name on purpose: the shipped assertion above is about the generic cancel
    // and still holds, while `stardew_stop_action` is the one control the model gets - bound to the execution the
    // latest observation named and refused by name past its cancel point (asserted in game-tools.test.ts). A
    // blocked run mounts neither, so assert both here rather than relaxing anything.
    assert.equal(mountedNames.includes("stardew_stop_action"), false);
    assert.deepEqual(calls.execute, []);
    assert.deepEqual(calls.cancel, []);
  });
});

test("Gameplay worker fake session blocks a second action until the owned receipt is terminal, then completes only from that receipt", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "move_to_tile", "cancel_active_execution"],
    snapshot: liveSnapshot(["equip_tool", "move_to_tile", "cancel_active_execution"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(customTools, async (tools) => {
            await invoke(tools, "stardew_equip_tool", {
              tool: "axe",
              requestId: "request_01",
              idempotencyKey: "key_01",
            });
            await assert.rejects(
              invoke(tools, "stardew_move_to_tile", {
                x: 2,
                y: 2,
                requestId: "request_02",
                idempotencyKey: "key_02",
              }),
              /gameplay_task_active_execution_exists/,
            );
            state.latestReceipt = {
              requestId: "request_01",
              executionId: "execution_1",
              actionId: "equip_tool",
              state: "succeeded",
              reasonCode: "tool_equipped",
              revision: 7,
              evidence: { detail: "tool=Axe;before=none;expected=Axe;after=Axe" },
            };
            await mod.publishLatestReceipt();
            await invoke(tools, "stardew_move_to_tile", {
              x: 2,
              y: 2,
              requestId: "request_02",
              idempotencyKey: "key_02",
            });
            state.latestReceipt = {
              requestId: "request_02",
              executionId: "execution_2",
              actionId: "move_to_tile",
              state: "succeeded",
              reasonCode: "target_reached",
              revision: 7,
              evidence: {
                detail: "tile=2,2;target=2,2;arrival=exact;path=stardew_native",
              },
            };
            await mod.publishLatestReceipt();
            await invoke(tools, "report_to_parent", {
              state: "completed",
              reasonCode: "done",
              evidence: { requestId: "request_02", executionId: "execution_2" },
            });
          }),
      },
      undefined,
      testDispatchAdmissionFactory(mounted),
    );
    const result = await worker.run("test task");
    assert.equal(result.state, "completed");
    assert.deepEqual(calls.execute, ["equip_tool", "move_to_tile"]);
    assert.equal(worker.lastTaskRecord?.executions.length, 2);
    assert.equal(worker.lastTaskRecord?.executions[0]?.state, "succeeded");
    assert.deepEqual(
      worker.lastTaskSteps.map((step) => step.name),
      ["worker_finished", "worker_reported_completed", "authoritatively_completed"],
    );
  });
});

test("Gameplay worker permits repeated actions in one family after each receipt settles", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "cancel_active_execution"],
    snapshot: liveSnapshot(["equip_tool", "cancel_active_execution"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(customTools, async (tools) => {
            await invoke(tools, "stardew_equip_tool", {
              tool: "axe",
              requestId: "request_first",
              idempotencyKey: "key_first",
            });
            state.latestReceipt = {
              requestId: "request_first",
              executionId: "execution_1",
              actionId: "equip_tool",
              state: "succeeded",
              reasonCode: "tool_equipped",
              revision: 7,
              evidence: { detail: "tool=Axe;before=none;expected=Axe;after=Axe" },
            };
            await mod.publishLatestReceipt();
            await invoke(tools, "stardew_equip_tool", {
              tool: "pickaxe",
              requestId: "request_second",
              idempotencyKey: "key_second",
            });
          }),
      },
      undefined,
      testDispatchAdmissionFactory(mounted),
    );
    const result = await worker.run("repeated family task");
    assert.equal(result.state, "blocked");
    assert.deepEqual(calls.execute, ["equip_tool", "equip_tool"]);
    assert.notEqual(worker.lastTaskRecord?.terminalReasonCode, "gameplay_task_action_family_budget_exhausted");
  });
});

test("Gameplay worker parent abort cancels only its accepted execution and records an authoritative terminal receipt", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "cancel_active_execution"],
    snapshot: liveSnapshot(["equip_tool", "cancel_active_execution"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let abortSession = false;
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(
            customTools,
            async (tools) => {
              await invoke(tools, "stardew_equip_tool", {
                tool: "axe",
                requestId: "request_cancel",
                idempotencyKey: "key_cancel",
              });
              await promptGate;
              if (abortSession) throw new Error("aborted");
            },
            () => {
              abortSession = true;
              releasePrompt();
            },
          ),
      },
      undefined,
      testDispatchAdmissionFactory(mounted),
    );
    const parent = new AbortController();
    const running = worker.run("cancel task", parent.signal);
    while (calls.execute.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    parent.abort("player_stop");
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.equal(calls.cancel.length, 1);
    assert.match(calls.cancel[0]!, /^request_cancel:execution_1:parent_aborted$/);
    assert.equal(worker.lastTaskRecord?.terminalReceipt?.state, "cancelled");
  });
});

test("task-owned terminal waiter uses an exact wake only after rereading the owned receipt", async () => {
  let receipt: any = null;
  const listeners = new Set<(wake: ExecutionWake) => void>();
  const startedAt = Date.now();
  const waiting = awaitTaskOwnedTerminalReceipt({
    executions: [{ requestId: "request_01", executionId: "execution_01" }],
    deadlineMs: startedAt + 1_000,
    wakeSource: {
      onExecutionWake: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
    readReceipt: () => receipt,
  });
  receipt = {
    requestId: "request_01",
    executionId: "execution_01",
    state: "succeeded",
    reasonCode: "tool_equipped",
    revision: 7,
    evidence: { detail: "tool=Axe;before=none;expected=Axe;after=Axe" },
  };
  for (const listener of listeners)
    listener({
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "tool_equipped",
    });
  assert.deepEqual(await waiting, {
    requestId: "request_01",
    executionId: "execution_01",
    state: "succeeded",
    reasonCode: "tool_equipped",
  });
  assert.ok(Date.now() - startedAt < 200);
});

test("matching terminal wake with null or nonterminal reread remains pending through its deadline", async () => {
  let receipt: any = null;
  const listeners = new Set<(wake: ExecutionWake) => void>();
  const deadlineMs = Date.now() + 60;
  const waiting = awaitTaskOwnedTerminalReceipt({
    executions: [{ requestId: "request_01", executionId: "execution_01" }],
    deadlineMs,
    wakeSource: {
      onExecutionWake: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
    readReceipt: () => receipt,
  });
  for (const listener of listeners)
    listener({
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "done",
    });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(listeners.size, 1);
  receipt = {
    requestId: "request_01",
    executionId: "execution_01",
    state: "running",
    reasonCode: "running",
    revision: 7,
    evidence: null,
  };
  for (const listener of listeners)
    listener({
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "done",
    });
  assert.equal(await waiting, null);
  assert.equal(listeners.size, 0);
});

test("task-owned terminal waiter ignores malformed and unrelated wakes", async () => {
  let receipt: any = null;
  const listeners = new Set<(wake: ExecutionWake) => void>();
  const waiting = awaitTaskOwnedTerminalReceipt({
    executions: [{ requestId: "request_01", executionId: "execution_01" }],
    deadlineMs: Date.now() + 1_000,
    wakeSource: {
      onExecutionWake: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
    readReceipt: () => receipt,
  });
  for (const listener of listeners) {
    listener({
      kind: "terminal",
      requestId: "other",
      executionId: "other",
      state: "succeeded",
      reasonCode: "other",
    });
    listener({
      kind: "terminal",
      requestId: "",
      executionId: "",
      state: "",
      reasonCode: "",
    } as ExecutionWake);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  receipt = {
    requestId: "request_01",
    executionId: "execution_01",
    state: "cancelled",
    reasonCode: "cancelled",
    revision: 7,
    evidence: null,
  };
  for (const listener of listeners)
    listener({
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "cancelled",
      reasonCode: "cancelled",
    });
  assert.equal((await waiting)?.state, "cancelled");
});

test("task-owned terminal waiter recovers a lost wake with the bounded reconciliation poll", async () => {
  let receipt: any = null;
  const waiting = awaitTaskOwnedTerminalReceipt({
    executions: [{ requestId: "request_01", executionId: "execution_01" }],
    deadlineMs: Date.now() + 1_000,
    wakeSource: { onExecutionWake: () => () => undefined },
    readReceipt: () => receipt,
  });
  setTimeout(() => {
    receipt = {
      requestId: "request_01",
      executionId: "execution_01",
      state: "failed",
      reasonCode: "failed",
      revision: 7,
      evidence: null,
    };
  }, 10);
  assert.equal((await waiting)?.state, "failed");
});

test("task-owned terminal waiter returns null on abort or deadline", async () => {
  const controller = new AbortController();
  const aborted = awaitTaskOwnedTerminalReceipt({
    executions: [{ requestId: "request_01", executionId: "execution_01" }],
    deadlineMs: Date.now() + 1_000,
    signal: controller.signal,
    readReceipt: () => null,
  });
  controller.abort();
  assert.equal(await aborted, null);
  assert.equal(
    await awaitTaskOwnedTerminalReceipt({
      executions: [{ requestId: "request_01", executionId: "execution_01" }],
      deadlineMs: Date.now() + 20,
      readReceipt: () => null,
    }),
    null,
  );
});

test("adapter liveness freezes the active task, cancels its owned execution once, and waits for a receipt", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "move_to_tile", "cancel_active_execution"],
    snapshot: liveSnapshot(["equip_tool", "move_to_tile", "cancel_active_execution"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    const listeners = new Set<(wake: ExecutionWake) => void>();
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve));
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(
            customTools,
            async (tools) => {
              await invoke(tools, "stardew_equip_tool", {
                tool: "axe",
                requestId: "request_live",
                idempotencyKey: "key_live",
              });
              await promptGate;
              await assert.rejects(
                invoke(tools, "stardew_move_to_tile", {
                  x: 2,
                  y: 2,
                  requestId: "request_next",
                  idempotencyKey: "key_next",
                }),
                /integration_invalidated:scope_lost/,
              );
              throw new Error("aborted");
            },
            releasePrompt,
          ),
      },
      {
        onExecutionWake: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      },
      testDispatchAdmissionFactory(mounted),
    );
    const running = worker.run("liveness task");
    while (calls.execute.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    for (const listener of listeners) listener({ kind: "invalidated", reasonCode: "scope_lost" });
    for (const listener of listeners) listener({ kind: "disconnected", reasonCode: "pipe_closed" });
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.equal(calls.cancel.length, 1);
    assert.match(calls.cancel[0]!, /^request_live:execution_1:integration_invalidated:scope_lost$/);
    assert.deepEqual(calls.execute, ["equip_tool"]);
    assert.equal(worker.lastTaskRecord?.terminalReceipt?.state, "cancelled");
  });
});

test("worker arms the snapshot freshness fence from the task-owned terminal receipt and admits the next action on the projection the Mod advanced with it", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "move_to_tile"],
    snapshot: { ...liveSnapshot(["equip_tool", "move_to_tile"]), revision: 8 },
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    mod.setExecute(async (request) => {
      calls.execute.push(request.action);
      const receipt = {
        requestId: request.requestId,
        executionId: `execution_${calls.execute.length}`,
        actionId: request.action,
        state: "succeeded",
        reasonCode: "completed",
        revision: 8,
        evidence: { detail: "native" },
      };
      state.latestReceipt = receipt;
      return receipt;
    });
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(customTools, async (tools) => {
            await invoke(tools, "stardew_equip_tool", {
              tool: "axe",
              requestId: "request_01",
              idempotencyKey: "key_01",
            });
            // The Mod mints a durable receipt revision and admits the projection
            // carrying it, so the fence that receipt armed is satisfied by the
            // world the Mod now reports. An admitted projection OLDER than a
            // receipt this task observed is unreachable through an authenticated
            // connection - the client refuses a regressed revision outright - so
            // the refusal branch is asserted directly on admitGameplayAction in
            // the admission test above rather than staged here.
            assert.equal(STARDEW_GAME_INTEGRATION_ADAPTER.readState(mounted).snapshotRevision, 8);
            await invoke(tools, "stardew_move_to_tile", {
              x: 2,
              y: 2,
              requestId: "request_02",
              idempotencyKey: "key_02",
            });
          }),
      },
      undefined,
      testDispatchAdmissionFactory(mounted),
    );
    const result = await worker.run("receipt freshness");
    assert.equal(result.state, "blocked");
    assert.deepEqual(calls.execute, ["equip_tool", "move_to_tile"]);
    assert.equal(worker.lastTaskRecord?.minimumSnapshotRevision, 8);
  });
});

test("worker mints a fresh runtime-owned admission for each action invocation", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "move_to_tile"],
    snapshot: liveSnapshot(["equip_tool", "move_to_tile"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    mod.setExecute(async (request) => {
      calls.execute.push(request.action);
      const receipt = {
        requestId: request.requestId,
        executionId: `execution_${calls.execute.length}`,
        actionId: request.action,
        state: "succeeded",
        reasonCode: "completed",
        revision: request.expectedRevision,
        evidence: null,
      };
      state.latestReceipt = receipt;
      return receipt;
    });
    const admissions: string[] = [];
    const createAdmission = testDispatchAdmissionFactory(mounted);
    const factory = () => {
      const admission = createAdmission();
      admissions.push(admission.owner.ownerId);
      return admission;
    };
    let releasePrompt!: () => void;
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(
            customTools,
            async (tools) => {
              await invoke(tools, "stardew_equip_tool", {
                tool: "axe",
                requestId: "request_same_owner",
                idempotencyKey: "key_same_owner",
              });
              await invoke(tools, "stardew_move_to_tile", {
                x: 2,
                y: 2,
                requestId: "request_fresh_owner",
                idempotencyKey: "key_fresh_owner",
              });
              await new Promise<void>((resolve) => {
                releasePrompt = resolve;
              });
              throw new Error("aborted");
            },
            () => releasePrompt(),
          ),
      },
      undefined,
      factory,
    );
    const parent = new AbortController();
    const running = worker.run("same admission", parent.signal);
    while (calls.execute.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    parent.abort();
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.deepEqual(calls.cancel, []);
    assert.deepEqual(admissions, ["worker_test_1", "worker_test_2"]);
  });
});

test("latest nonterminal receipt before delayed tool resolution remains ledger-pending and cancels exactly once after bind", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "cancel_active_execution"],
    snapshot: liveSnapshot(["equip_tool", "cancel_active_execution"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let resolveDispatch!: (value: any) => void;
    const dispatch = new Promise<any>((resolve) => (resolveDispatch = resolve));
    mod.setExecute(async (request) => {
      calls.execute.push(request.action);
      return await dispatch;
    });
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve));
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(
            customTools,
            async (tools) => {
              await invoke(tools, "stardew_equip_tool", {
                tool: "axe",
                requestId: "request_pending",
                idempotencyKey: "key_pending",
              });
              await promptGate;
              throw new Error("aborted");
            },
            releasePrompt,
          ),
      },
      undefined,
      testDispatchAdmissionFactory(mounted),
    );
    const parent = new AbortController();
    const running = worker.run("pending dispatch", parent.signal);
    while (calls.execute.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // State reconciliation must not settle this dispatch from an observed
    // nonterminal receipt before game-tools binds the execute response to the ledger.
    state.latestReceipt = {
      requestId: "request_pending",
      executionId: "execution_pending",
      actionId: "equip_tool",
      state: "running",
      reasonCode: "running",
      revision: 7,
      evidence: null,
    };
    await mod.publishLatestReceipt();
    parent.abort("player_stop");
    resolveDispatch({
      requestId: "request_pending",
      executionId: "execution_pending",
      actionId: "equip_tool",
      state: "accepted",
      reasonCode: "accepted",
      revision: 7,
      evidence: null,
    });
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.deepEqual(calls.cancel, ["request_pending:execution_pending:parent_aborted"]);
    assert.equal(worker.lastTaskRecord?.pendingDispatch, null);
    assert.deepEqual(
      worker.lastTaskRecord?.executions.map(({ requestId, executionId }) => ({
        requestId,
        executionId,
      })),
      [{ requestId: "request_pending", executionId: "execution_pending" }],
    );
  });
});

test("pending post-write dispatch settles from an exact terminal wake before its delayed execute response", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool"],
    snapshot: liveSnapshot(["equip_tool"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let resolveDispatch!: (value: any) => void;
    const dispatch = new Promise<any>((resolve) => (resolveDispatch = resolve));
    mod.setExecute(async (request) => {
      calls.execute.push(request.action);
      return await dispatch;
    });
    const listeners = new Set<(wake: ExecutionWake) => void>();
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve));
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(
            customTools,
            async (tools) => {
              await invoke(tools, "stardew_equip_tool", {
                tool: "axe",
                requestId: "request_wake",
                idempotencyKey: "key_wake",
              });
              await promptGate;
              throw new Error("aborted");
            },
            releasePrompt,
          ),
      },
      {
        onExecutionWake: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      },
      testDispatchAdmissionFactory(mounted),
    );
    const parent = new AbortController();
    const running = worker.run("pending exact wake", parent.signal);
    while (calls.execute.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    state.latestReceipt = {
      requestId: "request_wake",
      executionId: "execution_wake",
      actionId: "equip_tool",
      state: "cancelled",
      reasonCode: "player_stop",
      revision: 7,
      evidence: null,
    };
    await mod.publishLatestReceipt();
    parent.abort("player_stop");
    for (const listener of listeners)
      listener({
        kind: "terminal",
        requestId: "request_wake",
        executionId: "execution_wake",
        state: "cancelled",
        reasonCode: "player_stop",
      });
    // The model-facing tool call still owns its transport Promise; the wake
    // proves the cancellation waiter will reconcile from authoritative state
    // rather than waiting for another 25ms polling-only turn after it unwinds.
    resolveDispatch(state.latestReceipt);
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.equal(worker.lastTaskRecord?.terminalReceipt?.state, "cancelled");
  });
});

test("latest terminal receipt before delayed tool resolution retires ledger correlation without cancellation", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "cancel_active_execution"],
    snapshot: liveSnapshot(["equip_tool", "cancel_active_execution"]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  await withScriptedMod(state, calls, async (mod) => {
    const mounted = mod.connection;
    let resolveDispatch!: (value: any) => void;
    const dispatch = new Promise<any>((resolve) => (resolveDispatch = resolve));
    mod.setExecute(async (request) => {
      calls.execute.push(request.action);
      return await dispatch;
    });
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve));
    const worker = new GameplayTaskSubagent(
      paths,
      mounted,
      undefined,
      {
        create: async ({ customTools }) =>
          fakeSession(
            customTools,
            async (tools) => {
              await invoke(tools, "stardew_equip_tool", {
                tool: "axe",
                requestId: "request_terminal",
                idempotencyKey: "key_terminal",
              });
              await promptGate;
              throw new Error("aborted");
            },
            releasePrompt,
          ),
      },
      undefined,
      testDispatchAdmissionFactory(mounted),
    );
    const parent = new AbortController();
    const running = worker.run("terminal pending dispatch", parent.signal);
    while (calls.execute.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // Even a matching terminal receipt is only observation until game-tools
    // invokes bindReceipt; cancellation is retained by the ledger meanwhile.
    state.latestReceipt = {
      requestId: "request_terminal",
      executionId: "execution_terminal",
      actionId: "equip_tool",
      state: "succeeded",
      reasonCode: "tool_equipped",
      revision: 7,
      evidence: { detail: "tool=Axe;before=none;expected=Axe;after=Axe" },
    };
    await mod.publishLatestReceipt();
    parent.abort("player_stop");
    resolveDispatch(state.latestReceipt);
    const result = await running;
    assert.equal(result.state, "cancelled");
    assert.deepEqual(calls.cancel, []);
    assert.equal(worker.lastTaskRecord?.terminalReceipt?.state, "succeeded");
  });
});

test("Gameplay cancellation selects only a task-owned active execution", () => {
  const taskExecutions: Array<{
    requestId: string;
    executionId: string;
    state: string;
  }> = [
    {
      requestId: "request_owned",
      executionId: "execution_owned",
      state: "accepted",
    },
    {
      requestId: "request_done",
      executionId: "execution_done",
      state: "succeeded",
    },
  ];
  assert.deepEqual(
    selectTaskOwnedCancellation(taskExecutions, {
      requestId: "request_other",
      executionId: "execution_other",
    }),
    { requestId: "request_owned", executionId: "execution_owned" },
  );
  assert.deepEqual(
    selectTaskOwnedCancellation(taskExecutions, {
      requestId: "request_owned",
      executionId: "execution_owned",
    }),
    { requestId: "request_owned", executionId: "execution_owned" },
  );
  assert.equal(
    selectTaskOwnedCancellation(
      [
        {
          requestId: "request_done",
          executionId: "execution_done",
          state: "succeeded",
        },
      ],
      {
        requestId: "request_other",
        executionId: "execution_other",
      },
    ),
    null,
  );
});
