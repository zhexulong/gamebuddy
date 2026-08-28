import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentSession,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";
import { ExecutionCorrelationLedger } from "./execution-correlation-ledger.js";
import {
  admitGameplayAction,
  awaitTaskOwnedTerminalReceipt,
  GameplayTaskSubagent,
  hasActionPostconditionEvidence,
  hasAuthoritativeCompletion,
  selectTaskOwnedCancellation,
} from "./gameplay-task-subagent.js";
import type { ExecutionWake } from "./integration-launcher.js";
import type { CompanionIntegration } from "./integration-types.js";
import type { RuntimePaths } from "./runtime.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

const paths: RuntimePaths = {
  root: tmpdir(),
  runtimeCwd: join(tmpdir(), "gamebuddy-gameplay-task-tests"),
  agentDir: join(tmpdir(), "gamebuddy-gameplay-task-tests", "pi-agent"),
  sessionDir: join(tmpdir(), "gamebuddy-gameplay-task-tests", "sessions"),
  identityProfilePath: join(
    tmpdir(),
    "gamebuddy-gameplay-task-tests",
    "identity-profile.json",
  ),
  identityProfileBindingPath: join(
    tmpdir(),
    "gamebuddy-gameplay-task-tests",
    "identity-profile-binding.json",
  ),
  runManifestPath: join(
    tmpdir(),
    "gamebuddy-gameplay-task-tests",
    "companion-run-manifest.json",
  ),
};

const integration: CompanionIntegration = {
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
  module: STARDEW_INTEGRATION_MODULE,
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
    requestId: "request_01",
    state: "succeeded" as const,
    reasonCode: "soil_tilled",
    revision: 1,
    evidence: { detail: "location=Farm;target=3,4;before=none;after=HoeDirt" },
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
    hasAuthoritativeCompletion(
      report,
      succeeded,
      owned,
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    true,
  );
  assert.equal(
    hasAuthoritativeCompletion(
      report,
      { ...succeeded, evidence: null },
      owned,
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasAuthoritativeCompletion(
      report,
      { ...succeeded, state: "running" },
      owned,
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasAuthoritativeCompletion(
      report,
      succeeded,
      [],
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    false,
  );
});

test("completion evidence must contain action-specific postcondition keys", () => {
  assert.equal(
    hasActionPostconditionEvidence(
      "equip_tool",
      {
        reasonCode: "tool_selected",
        evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
      },
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    true,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "equip_tool",
      { reasonCode: "tool_selected", evidence: { detail: "slot=1;after=Axe" } },
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "equip_tool",
      {
        reasonCode: "unexpected_success",
        evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
      },
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    false,
  );
  assert.equal(
    hasActionPostconditionEvidence(
      "unknown_action",
      { reasonCode: "succeeded", evidence: { detail: "anything" } },
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    false,
  );
  const planted = {
    reasonCode: "seed_planted",
    evidence: {
      detail:
        "location=Farm;target=seed_target_01;tile=3,4;item=(O)479;crop=479;inventory_before=2;inventory_after=1",
    },
  };
  assert.equal(
    hasActionPostconditionEvidence(
      "plant_seed",
      planted,
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
    ),
    false,
  );
});

test("Gameplay action admission enforces only the single embodied actor mutation serialization before dispatch", () => {
  const record = { executions: [] };
  const liveCapabilities = TEST_MOD_REGISTRATIONS.map(
    (entry) => entry.actionId,
  );
  const policy = STARDEW_INTEGRATION_MODULE.defaultPolicy;
  assert.deepEqual(
    admitGameplayAction(
      "till_soil",
      record,
      null,
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
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
      STARDEW_INTEGRATION_MODULE.actionCatalog,
      TEST_MOD_REGISTRATIONS,
      liveCapabilities,
      policy,
    ),
    { ok: false, reasonCode: "gameplay_task_active_execution_exists" },
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

function scriptedIntegration(
  state: MutableIntegrationState,
  calls: { execute: string[]; cancel: string[] },
): CompanionIntegration & {
  execute(request: any): Promise<any>;
  cancel(
    requestId: string,
    executionId: string,
    reasonCode: string,
  ): Promise<any>;
} {
  return {
    scope: integration.scope,
    module: STARDEW_INTEGRATION_MODULE,
    executionGate: { executable: true } as never,
    get state() {
      return state;
    },
    async execute(request) {
      calls.execute.push(request.action);
      return {
        requestId: request.requestId,
        executionId: `execution_${calls.execute.length}`,
        state: "accepted",
        reasonCode: "accepted",
        revision: request.expectedRevision,
        evidence: null,
      };
    },
    async cancel(requestId, executionId, reasonCode) {
      calls.cancel.push(`${requestId}:${executionId}:${reasonCode}`);
      state.latestReceipt = {
        requestId,
        executionId,
        state: "cancelled",
        reasonCode,
        revision: state.snapshot.revision,
        evidence: null,
      };
      return state.latestReceipt;
    },
  };
}

function testDispatchAdmissionFactory(
  mounted: Pick<ReturnType<typeof scriptedIntegration>, "cancel">,
) {
  let generation = 0;
  return () => {
    const owner = { ownerId: `worker_test_${++generation}`, epoch: 0 };
    const ledger = new ExecutionCorrelationLedger(
      (requestId, executionId, reasonCode) =>
        mounted.cancel(requestId, executionId, reasonCode),
    );
    return {
      owner,
      observer: ledger,
      cancelExact: (
        requestId: string,
        executionId: string,
        reasonCode: string,
      ) => ledger.requestCancelExact(owner, requestId, executionId, reasonCode),
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
    health: 100,
    actionable: true,
    capabilities,
    activeExecution: null,
  };
}

async function invoke(
  tools: readonly ToolDefinition[],
  name: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing_test_tool:${name}`);
  return tool.execute(
    "test_call",
    params,
    new AbortController().signal,
    undefined,
    undefined as never,
  );
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
  const mounted = scriptedIntegration(state, calls);
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
  while (resolveConstruction === undefined)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(worker.run("B"), /gameplay_task_already_active/);
  parent.abort();
  resolveConstruction(fakeSession([], async () => undefined));
  const resultA = await runningA;
  assert.equal(resultA.state, "cancelled");
  const resultB = await worker.run("B");
  assert.equal(resultB.state, "blocked");
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
  const mounted = scriptedIntegration(state, calls);
  let workspaceAttempts = 0;
  const worker = new GameplayTaskSubagent(
    paths,
    mounted,
    undefined,
    {
      createWorkspace: async () => {
        if (workspaceAttempts++ === 0)
          throw new Error("workspace_creation_failed");
        return join(paths.runtimeCwd, "allocated-workspace");
      },
      create: async ({ customTools }) =>
        fakeSession(customTools, async () => undefined),
    },
  );
  assert.equal((await worker.run("first")).state, "blocked");
  assert.equal(worker.activeTaskId, null);
  assert.equal((await worker.run("second")).state, "blocked");
  assert.equal(workspaceAttempts, 2);
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
  const mounted = scriptedIntegration(state, calls);
  let attempts = 0;
  const worker = new GameplayTaskSubagent(
    paths,
    mounted,
    undefined,
    {
      create: async ({ customTools }) => {
        if (attempts++ === 0) throw new Error("construction_failed");
        return fakeSession(customTools, async () => undefined);
      },
    },
  );
  assert.equal((await worker.run("first")).state, "blocked");
  assert.equal((await worker.run("second")).state, "blocked");
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
  const mounted = scriptedIntegration(state, calls);
  let mountedNames: readonly string[] = [];
  const worker = new GameplayTaskSubagent(
    paths,
    mounted,
    undefined,
    {
      create: async ({ customTools }) => {
        mountedNames = customTools.map((tool) => tool.name);
        return fakeSession(customTools, async () => undefined);
      },
    },
  );
  const result = await worker.run("admission required");
  assert.equal(result.state, "blocked");
  assert.equal(mountedNames.includes("stardew_equip_tool"), false);
  assert.equal(mountedNames.includes("stardew_cancel_active_execution"), false);
  assert.deepEqual(calls.execute, []);
  assert.deepEqual(calls.cancel, []);
});

test("Gameplay worker fake session blocks a second action until the owned receipt is terminal, then completes only from that receipt", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = {
    connected: true,
    sessionId: "session_01",
    capabilities: ["equip_tool", "move_to_tile", "cancel_active_execution"],
    snapshot: liveSnapshot([
      "equip_tool",
      "move_to_tile",
      "cancel_active_execution",
    ]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  const mounted = scriptedIntegration(state, calls);
  const worker = new GameplayTaskSubagent(
    paths,
    mounted,
    undefined,
    {
      create: async ({ customTools }) =>
        fakeSession(customTools, async (tools) => {
          await invoke(tools, "stardew_equip_tool", {
            slot: 1,
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
            state: "succeeded",
            reasonCode: "tool_selected",
            revision: 7,
            evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
          };
          await invoke(tools, "stardew_move_to_tile", {
            x: 2,
            y: 2,
            requestId: "request_02",
            idempotencyKey: "key_02",
          });
          state.latestReceipt = {
            requestId: "request_02",
            executionId: "execution_2",
            state: "succeeded",
            reasonCode: "target_reached",
            revision: 7,
            evidence: {
              detail: "tile=2,2;target=2,2;arrival=exact;path=stardew_native",
            },
          };
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
    [
      "worker_finished",
      "worker_reported_completed",
      "authoritatively_completed",
    ],
  );
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
  const mounted = scriptedIntegration(state, calls);
  const worker = new GameplayTaskSubagent(
    paths,
    mounted,
    undefined,
    {
      create: async ({ customTools }) =>
        fakeSession(customTools, async (tools) => {
          await invoke(tools, "stardew_equip_tool", {
            slot: 1,
            requestId: "request_first",
            idempotencyKey: "key_first",
          });
          state.latestReceipt = {
            requestId: "request_first",
            executionId: "execution_1",
            state: "succeeded",
            reasonCode: "tool_selected",
            revision: 7,
            evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
          };
             await invoke(tools, "stardew_equip_tool", {
               slot: 2,
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
  const mounted = scriptedIntegration(state, calls);
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
              slot: 1,
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
  while (calls.execute.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  parent.abort("player_stop");
  const result = await running;
  assert.equal(result.state, "cancelled");
  assert.equal(calls.cancel.length, 1);
  assert.match(calls.cancel[0]!, /^request_cancel:execution_1:parent_aborted$/);
  assert.equal(worker.lastTaskRecord?.terminalReceipt?.state, "cancelled");
});

test("task-owned terminal waiter uses an exact wake only after rereading the owned receipt", async () => {
  let receipt: any = null;
  const listeners = new Set<(wake: ExecutionWake) => void>();
  const startedAt = Date.now();
  const waiting = awaitTaskOwnedTerminalReceipt({
    executions: [{ requestId: "request_01", executionId: "execution_01" }],
    deadlineMs: startedAt + 1_000,
    wakeSource: {
      onExecutionWake: (listener) => (
        listeners.add(listener),
        () => listeners.delete(listener)
      ),
    },
    readReceipt: () => receipt,
  });
  receipt = {
    requestId: "request_01",
    executionId: "execution_01",
    state: "succeeded",
    reasonCode: "tool_selected",
    revision: 7,
    evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
  };
  for (const listener of listeners)
    listener({
      kind: "terminal",
      requestId: "request_01",
      executionId: "execution_01",
      state: "succeeded",
      reasonCode: "tool_selected",
    });
  assert.deepEqual(await waiting, {
    requestId: "request_01",
    executionId: "execution_01",
    state: "succeeded",
    reasonCode: "tool_selected",
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
      onExecutionWake: (listener) => (
        listeners.add(listener),
        () => listeners.delete(listener)
      ),
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
      onExecutionWake: (listener) => (
        listeners.add(listener),
        () => listeners.delete(listener)
      ),
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
    snapshot: liveSnapshot([
      "equip_tool",
      "move_to_tile",
      "cancel_active_execution",
    ]),
    latestReceipt: null,
    latestReasonCode: null,
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  const mounted = scriptedIntegration(state, calls);
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
              slot: 1,
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
      onExecutionWake: (listener) => (
        listeners.add(listener),
        () => listeners.delete(listener)
      ),
    },
    testDispatchAdmissionFactory(mounted),
  );
  const running = worker.run("liveness task");
  while (calls.execute.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  for (const listener of listeners)
    listener({ kind: "invalidated", reasonCode: "scope_lost" });
  for (const listener of listeners)
    listener({ kind: "disconnected", reasonCode: "pipe_closed" });
  const result = await running;
  assert.equal(result.state, "cancelled");
  assert.equal(calls.cancel.length, 1);
  assert.match(
    calls.cancel[0]!,
    /^request_live:execution_1:integration_invalidated:scope_lost$/,
  );
  assert.deepEqual(calls.execute, ["equip_tool"]);
  assert.equal(worker.lastTaskRecord?.terminalReceipt?.state, "cancelled");
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
  const mounted = scriptedIntegration(state, calls);
  mounted.execute = async (request) => {
    calls.execute.push(request.action);
    const receipt = {
      requestId: request.requestId,
      executionId: `execution_${calls.execute.length}`,
      state: "succeeded",
      reasonCode: "completed",
      revision: request.expectedRevision,
      evidence: null,
    };
    state.latestReceipt = receipt;
    return receipt;
  };
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
              slot: 1,
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
  while (calls.execute.length < 2)
    await new Promise((resolve) => setTimeout(resolve, 1));
  parent.abort();
  const result = await running;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(calls.cancel, []);
  assert.deepEqual(admissions, ["worker_test_1", "worker_test_2"]);
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
  let resolveDispatch!: (value: any) => void;
  const dispatch = new Promise<any>((resolve) => (resolveDispatch = resolve));
  const mounted = scriptedIntegration(state, calls);
  mounted.execute = async (request) => {
    calls.execute.push(request.action);
    return await dispatch;
  };
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
              slot: 1,
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
  while (calls.execute.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  // State reconciliation must not settle this dispatch from an observed
  // nonterminal receipt before game-tools binds the execute response to the ledger.
  state.latestReceipt = {
    requestId: "request_pending",
    executionId: "execution_pending",
    state: "running",
    reasonCode: "running",
    revision: 7,
    evidence: null,
  };
  parent.abort("player_stop");
  resolveDispatch({
    requestId: "request_pending",
    executionId: "execution_pending",
    state: "accepted",
    reasonCode: "accepted",
    revision: 7,
    evidence: null,
  });
  const result = await running;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(calls.cancel, [
    "request_pending:execution_pending:parent_aborted",
  ]);
  assert.equal(worker.lastTaskRecord?.pendingDispatch, null);
  assert.deepEqual(
    worker.lastTaskRecord?.executions.map(({ requestId, executionId }) => ({
      requestId,
      executionId,
    })),
    [{ requestId: "request_pending", executionId: "execution_pending" }],
  );
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
  const mounted = scriptedIntegration(state, calls);
  let resolveDispatch!: (value: any) => void;
  const dispatch = new Promise<any>((resolve) => (resolveDispatch = resolve));
  mounted.execute = async (request) => {
    calls.execute.push(request.action);
    return await dispatch;
  };
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
              slot: 1,
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
      onExecutionWake: (listener) => (
        listeners.add(listener),
        () => listeners.delete(listener)
      ),
    },
    testDispatchAdmissionFactory(mounted),
  );
  const parent = new AbortController();
  const running = worker.run("pending exact wake", parent.signal);
  while (calls.execute.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  state.latestReceipt = {
    requestId: "request_wake",
    executionId: "execution_wake",
    state: "cancelled",
    reasonCode: "player_stop",
    revision: 7,
    evidence: null,
  };
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
  let resolveDispatch!: (value: any) => void;
  const dispatch = new Promise<any>((resolve) => (resolveDispatch = resolve));
  const mounted = scriptedIntegration(state, calls);
  mounted.execute = async (request) => {
    calls.execute.push(request.action);
    return await dispatch;
  };
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
              slot: 1,
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
  while (calls.execute.length === 0)
    await new Promise((resolve) => setTimeout(resolve, 1));
  // Even a matching terminal receipt is only observation until game-tools
  // invokes bindReceipt; cancellation is retained by the ledger meanwhile.
  state.latestReceipt = {
    requestId: "request_terminal",
    executionId: "execution_terminal",
    state: "succeeded",
    reasonCode: "tool_selected",
    revision: 7,
    evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
  };
  parent.abort("player_stop");
  resolveDispatch(state.latestReceipt);
  const result = await running;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(calls.cancel, []);
  assert.equal(worker.lastTaskRecord?.terminalReceipt?.state, "succeeded");
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
