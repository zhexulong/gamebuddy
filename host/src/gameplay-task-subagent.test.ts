import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admitGameplayAction,
  DEFAULT_GAMEPLAY_TASK_BUDGET,
  GameplayTaskSubagent,
  hasActionPostconditionEvidence,
  hasAuthoritativeCompletion,
  selectTaskOwnedCancellation,
  type GameplayTaskBudget,
} from "./gameplay-task-subagent.js";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CompanionIntegration } from "./integration-types.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";
import type { RuntimePaths } from "./runtime-core.js";

const paths: RuntimePaths = {
  root: tmpdir(),
  runtimeCwd: join(tmpdir(), "gamebuddy-gameplay-task-tests"),
  agentDir: join(tmpdir(), "gamebuddy-gameplay-task-tests", "pi-agent"),
  sessionDir: join(tmpdir(), "gamebuddy-gameplay-task-tests", "sessions"),
  identityProfilePath: join(tmpdir(), "gamebuddy-gameplay-task-tests", "identity-profile.json"),
  identityProfileBindingPath: join(tmpdir(), "gamebuddy-gameplay-task-tests", "identity-profile-binding.json"),
  runManifestPath: join(tmpdir(), "gamebuddy-gameplay-task-tests", "companion-run-manifest.json"),
};

const integration: CompanionIntegration = {
  scope: { integrationId: "stardew", saveId: "save_01", worldId: "world_01", playerId: "player_01", companionId: "companion_01" },
  state: { connected: false, sessionId: null, capabilities: [], snapshot: null, latestReceipt: null, latestReasonCode: null },
  module: STARDEW_INTEGRATION_MODULE,
};

function withBudget(patch: Partial<GameplayTaskBudget>): GameplayTaskBudget {
  return { ...DEFAULT_GAMEPLAY_TASK_BUDGET, ...patch };
}

test("GameplayTaskSubagent rejects invalid Host-enforced budgets before any model runtime is created", () => {
  assert.throws(() => new GameplayTaskSubagent(paths, integration, undefined, withBudget({ maxTurns: 0 })), /invalid_gameplay_task_budget:maxTurns/);
  assert.throws(() => new GameplayTaskSubagent(paths, integration, undefined, withBudget({ maxToolCalls: 1.5 })), /invalid_gameplay_task_budget:maxToolCalls/);
  assert.throws(() => new GameplayTaskSubagent(paths, integration, undefined, withBudget({ maxActiveExecutions: 2 as 1 })), /invalid_gameplay_task_budget:maxActiveExecutions/);
});

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
    executionId: "execution_01", requestId: "request_01", state: "succeeded" as const, reasonCode: "soil_tilled", revision: 1,
    evidence: { detail: "location=Farm;target=3,4;before=none;after=HoeDirt" },
  };
  const report = { state: "completed", evidence: { requestId: "request_01", executionId: "execution_01" } };
  const owned = [{ actionId: "till_soil", requestId: "request_01", executionId: "execution_01" }];
  assert.equal(hasAuthoritativeCompletion(report, succeeded, owned, STARDEW_INTEGRATION_MODULE.actionCatalog), true);
  assert.equal(hasAuthoritativeCompletion(report, { ...succeeded, evidence: null }, owned, STARDEW_INTEGRATION_MODULE.actionCatalog), false);
  assert.equal(hasAuthoritativeCompletion(report, { ...succeeded, state: "running" }, owned, STARDEW_INTEGRATION_MODULE.actionCatalog), false);
  assert.equal(hasAuthoritativeCompletion({ ...report, evidence: { requestId: "other", executionId: "execution_01" } }, succeeded, owned, STARDEW_INTEGRATION_MODULE.actionCatalog), false);
  assert.equal(hasAuthoritativeCompletion(report, succeeded, [], STARDEW_INTEGRATION_MODULE.actionCatalog), false);
});

test("completion evidence must contain action-specific postcondition keys", () => {
  assert.equal(hasActionPostconditionEvidence("equip_tool", { reasonCode: "tool_selected", evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" } }, STARDEW_INTEGRATION_MODULE.actionCatalog), true);
  assert.equal(hasActionPostconditionEvidence("equip_tool", { reasonCode: "tool_selected", evidence: { detail: "slot=1;after=Axe" } }, STARDEW_INTEGRATION_MODULE.actionCatalog), false);
  assert.equal(hasActionPostconditionEvidence("equip_tool", { reasonCode: "unexpected_success", evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" } }, STARDEW_INTEGRATION_MODULE.actionCatalog), false);
  assert.equal(hasActionPostconditionEvidence("unknown_action", { reasonCode: "succeeded", evidence: { detail: "anything" } }, STARDEW_INTEGRATION_MODULE.actionCatalog), false);
  assert.equal(hasActionPostconditionEvidence("till_soil", { reasonCode: "soil_tilled", evidence: { detail: "before=none;after=Stone" } }, STARDEW_INTEGRATION_MODULE.actionCatalog), false);
});

test("Gameplay action admission enforces active execution, total, and family limits before dispatch", () => {
  const record = {
    acceptedActions: 1,
    acceptedActionsByFamily: { farming_crops: 1 },
    executions: [],
    budget: withBudget({ maxAcceptedActions: 2, maxAcceptedActionsPerFamily: 1 }),
  };
  assert.deepEqual(admitGameplayAction("till_soil", record, null, STARDEW_INTEGRATION_MODULE.actionCatalog), { ok: false, reasonCode: "gameplay_task_action_family_budget_exhausted" });
  assert.deepEqual(admitGameplayAction("equip_tool", record, null, STARDEW_INTEGRATION_MODULE.actionCatalog), { ok: true, familyId: "body_tools" });
  assert.deepEqual(admitGameplayAction("equip_tool", { ...record, acceptedActions: 2 }, null, STARDEW_INTEGRATION_MODULE.actionCatalog), { ok: false, reasonCode: "gameplay_task_action_budget_exhausted" });
  assert.deepEqual(admitGameplayAction("equip_tool", record, { requestId: "request_01", executionId: "execution_01" }, STARDEW_INTEGRATION_MODULE.actionCatalog), { ok: false, reasonCode: "gameplay_task_active_execution_exists" });
  assert.deepEqual(admitGameplayAction("not_published", record, null, STARDEW_INTEGRATION_MODULE.actionCatalog), { ok: false, reasonCode: "unknown_gameplay_action" });
  assert.deepEqual(admitGameplayAction("equip_tool", { ...record, executions: [{ actionId: "move_to_tile", requestId: "request_01", executionId: "execution_01", state: "running" }] }, null, STARDEW_INTEGRATION_MODULE.actionCatalog), { ok: false, reasonCode: "gameplay_task_active_execution_exists" });
});

type MutableIntegrationState = {
  connected: boolean; sessionId: string | null; capabilities: string[]; snapshot: any; latestReceipt: any; latestReasonCode: string | null;
};

function scriptedIntegration(state: MutableIntegrationState, calls: { execute: string[]; cancel: string[] }): CompanionIntegration & { execute(request: any): Promise<any>; cancel(requestId: string, executionId: string, reasonCode: string): Promise<any> } {
  return {
    scope: integration.scope,
    module: STARDEW_INTEGRATION_MODULE,
    get state() { return state; },
    async execute(request) {
      calls.execute.push(request.action);
      return { requestId: request.requestId, executionId: `execution_${calls.execute.length}`, state: "accepted", reasonCode: "accepted", revision: request.expectedRevision, evidence: null };
    },
    async cancel(requestId, executionId, reasonCode) {
      calls.cancel.push(`${requestId}:${executionId}:${reasonCode}`);
      state.latestReceipt = { requestId, executionId, state: "cancelled", reasonCode, revision: state.snapshot.revision, evidence: null };
      return state.latestReceipt;
    },
  };
}

function fakeSession(tools: readonly ToolDefinition[], script: (tools: readonly ToolDefinition[]) => Promise<void>, onAbort?: () => void): AgentSession {
  return {
    agent: { state: { tools } },
    messages: [],
    subscribe: () => () => undefined,
    prompt: async () => script(tools),
    abort: async () => { onAbort?.(); },
    dispose: () => undefined,
  } as unknown as AgentSession;
}

function liveSnapshot(capabilities: string[]) {
  return { revision: 7, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities, activeExecution: null };
}

async function invoke(tools: readonly ToolDefinition[], name: string, params: Record<string, unknown>) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing_test_tool:${name}`);
  return tool.execute("test_call", params, new AbortController().signal, undefined, undefined as never);
}

test("Gameplay worker fake session blocks a second action until the owned receipt is terminal, then completes only from that receipt", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = { connected: true, sessionId: "session_01", capabilities: ["equip_tool", "move_to_tile", "cancel_active_execution"], snapshot: liveSnapshot(["equip_tool", "move_to_tile", "cancel_active_execution"]), latestReceipt: null, latestReasonCode: null };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  const mounted = scriptedIntegration(state, calls);
  const worker = new GameplayTaskSubagent(paths, mounted, undefined, withBudget({ maxAcceptedActions: 2, maxAcceptedActionsPerFamily: 2 }), {
    create: async ({ customTools }) => fakeSession(customTools, async (tools) => {
      await invoke(tools, "stardew_equip_tool", { slot: 1, requestId: "request_01", idempotencyKey: "key_01" });
      await assert.rejects(invoke(tools, "stardew_move_to_tile", { x: 2, y: 2, requestId: "request_02", idempotencyKey: "key_02" }), /gameplay_task_active_execution_exists/);
      state.latestReceipt = { requestId: "request_01", executionId: "execution_1", state: "succeeded", reasonCode: "tool_selected", revision: 7, evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" } };
      await invoke(tools, "stardew_move_to_tile", { x: 2, y: 2, requestId: "request_02", idempotencyKey: "key_02" });
      state.latestReceipt = { requestId: "request_02", executionId: "execution_2", state: "succeeded", reasonCode: "target_reached", revision: 7, evidence: { detail: "tile=2,2;target=2,2;arrival=exact" } };
      await invoke(tools, "report_to_parent", { state: "completed", reasonCode: "done", evidence: { requestId: "request_02", executionId: "execution_2" } });
    }),
  });
  const result = await worker.run("test task");
  assert.equal(result.state, "completed");
  assert.deepEqual(calls.execute, ["equip_tool", "move_to_tile"]);
  assert.equal(worker.lastTaskRecord?.acceptedActions, 2);
  assert.equal(worker.lastTaskRecord?.executions[0]?.state, "succeeded");
  assert.deepEqual(worker.lastTaskSteps.map((step) => step.name), ["worker_finished", "worker_reported_completed", "authoritatively_completed"]);
});

test("Gameplay worker action-family budget cancels before dispatching an over-budget sibling action", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = { connected: true, sessionId: "session_01", capabilities: ["equip_tool", "cancel_active_execution"], snapshot: liveSnapshot(["equip_tool", "cancel_active_execution"]), latestReceipt: null, latestReasonCode: null };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  const mounted = scriptedIntegration(state, calls);
  const worker = new GameplayTaskSubagent(paths, mounted, undefined, withBudget({ maxAcceptedActions: 3, maxAcceptedActionsPerFamily: 1 }), {
    create: async ({ customTools }) => fakeSession(customTools, async (tools) => {
      await invoke(tools, "stardew_equip_tool", { slot: 1, requestId: "request_first", idempotencyKey: "key_first" });
      state.latestReceipt = { requestId: "request_first", executionId: "execution_1", state: "succeeded", reasonCode: "tool_selected", revision: 7, evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" } };
      await assert.rejects(invoke(tools, "stardew_equip_tool", { slot: 2, requestId: "request_second", idempotencyKey: "key_second" }), /gameplay_task_action_family_budget_exhausted/);
    }),
  });
  const result = await worker.run("family budget task");
  assert.equal(result.state, "blocked");
  assert.deepEqual(calls.execute, ["equip_tool"]);
  assert.equal(worker.lastTaskRecord?.terminalReasonCode, "gameplay_task_action_family_budget_exhausted");
});

test("Gameplay worker parent abort cancels only its accepted execution and records an authoritative terminal receipt", async () => {
  await mkdir(paths.runtimeCwd, { recursive: true });
  const state: MutableIntegrationState = { connected: true, sessionId: "session_01", capabilities: ["equip_tool", "cancel_active_execution"], snapshot: liveSnapshot(["equip_tool", "cancel_active_execution"]), latestReceipt: null, latestReasonCode: null };
  const calls = { execute: [] as string[], cancel: [] as string[] };
  const mounted = scriptedIntegration(state, calls);
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let abortSession = false;
  const worker = new GameplayTaskSubagent(paths, mounted, undefined, DEFAULT_GAMEPLAY_TASK_BUDGET, {
    create: async ({ customTools }) => fakeSession(customTools, async (tools) => {
      await invoke(tools, "stardew_equip_tool", { slot: 1, requestId: "request_cancel", idempotencyKey: "key_cancel" });
      await promptGate;
      if (abortSession) throw new Error("aborted");
    }, () => { abortSession = true; releasePrompt(); }),
  });
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

test("Gameplay cancellation selects only a task-owned active execution", () => {
  const taskExecutions: Array<{ requestId: string; executionId: string; state: string }> = [
    { requestId: "request_owned", executionId: "execution_owned", state: "accepted" },
    { requestId: "request_done", executionId: "execution_done", state: "succeeded" },
  ];
  assert.deepEqual(selectTaskOwnedCancellation(taskExecutions, { requestId: "request_other", executionId: "execution_other" }), { requestId: "request_owned", executionId: "execution_owned" });
  assert.deepEqual(selectTaskOwnedCancellation(taskExecutions, { requestId: "request_owned", executionId: "execution_owned" }), { requestId: "request_owned", executionId: "execution_owned" });
  assert.equal(selectTaskOwnedCancellation([{ requestId: "request_done", executionId: "execution_done", state: "succeeded" }], { requestId: "request_other", executionId: "execution_other" }), null);
});
