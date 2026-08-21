import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type IntegrationConnection } from "./integration-types.js";
import { type IntegrationActionCatalog, type IntegrationActionPolicy, type IntegrationExecutionReceipt, type IntegrationStateView } from "./integration-module.js";
import { finalAssistantText } from "./agent-expression.js";
import { type CompanionModelConfig, type RuntimePaths } from "./runtime-core.js";

/** Gameplay workers are deliberately pinned independently from the dialogue model. */
export const GAMEPLAY_SUBAGENT_MODEL_CONFIG: CompanionModelConfig = Object.freeze({
  provider: "cpa-oai",
  modelId: "gpt-5.6-luna",
  thinkingLevel: "medium",
});

export type GameplayTaskResult = Readonly<{
  taskId: string;
  state: "completed" | "cancelled" | "blocked";
  summary: string | null;
  report: Readonly<Record<string, unknown>> | null;
}>;

/** Host-enforced limits; prompts never grant a worker additional work. */
export type GameplayTaskBudget = Readonly<{
  maxTurns: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxModelRetries: number;
  maxAcceptedActions: number;
  maxActiveExecutions: 1;
  maxAcceptedActionsPerFamily: number;
}>;

export const DEFAULT_GAMEPLAY_TASK_BUDGET: GameplayTaskBudget = Object.freeze({
  maxTurns: 12,
  maxToolCalls: 24,
  maxWallClockMs: 120_000,
  maxModelRetries: 1,
  maxAcceptedActions: 8,
  maxActiveExecutions: 1,
  maxAcceptedActionsPerFamily: 4,
});

export type GameplayTaskRecord = Readonly<{
  taskId: string;
  scope: IntegrationConnection["scope"];
  createdAtMs: number;
  deadlineMs: number;
  cancellationEpoch: number;
  budget: GameplayTaskBudget;
  turns: number;
  toolCalls: number;
  modelRetries: number;
  acceptedActions: number;
  acceptedActionsByFamily: Readonly<Record<string, number>>;
  executions: readonly Readonly<{ actionId: string; requestId: string; executionId: string; state: string }>[];
  /** Receipt reference only; evidence remains Mod-owned and is never copied into worker trace. */
  terminalReceipt: Readonly<{ requestId: string; executionId: string; state: string; reasonCode: string }> | null;
  terminalReasonCode: string | null;
}>;

export type GameplayTaskStep = Readonly<{
  name: "worker_finished" | "worker_reported_completed" | "authoritatively_completed" | "blocked" | "cancelled";
  reasonCode: string;
}>;

/** Test-only seam: production keeps the private Pi SDK setup below. */
export type GameplayTaskSessionFactory = Readonly<{
  create(input: Readonly<{
    taskId: string;
    taskRoot: string;
    agentDir: string;
    allowedToolNames: readonly string[];
    customTools: readonly ToolDefinition[];
  }>): Promise<AgentSession>;
}>;

type MutableTaskRecord = {
  taskId: string; scope: IntegrationConnection["scope"]; createdAtMs: number; deadlineMs: number; cancellationEpoch: number; budget: GameplayTaskBudget;
  turns: number; toolCalls: number; modelRetries: number; acceptedActions: number; acceptedActionsByFamily: Record<string, number>;
  executions: Array<{ actionId: string; requestId: string; executionId: string; state: string }>; terminalReceipt: { requestId: string; executionId: string; state: string; reasonCode: string } | null; terminalReasonCode: string | null;
};
type ActiveTask = Readonly<{
  taskId: string;
  controller: AbortController;
  session: AgentSession;
  record: MutableTaskRecord;
}>;
type GameplayTaskReport = Readonly<{ state: "completed" | "blocked" | "cancelled"; reasonCode: string; evidence?: unknown }>;
/**
 * Thin, task-scoped Pi child. It has no Magic Context, identity profile,
 * presentation tool, todo writer, or persistent session. The parent remains
 * the only player-facing Companion and the only owner of redirection policy.
 */
export class GameplayTaskSubagent {
  #active: ActiveTask | undefined;
  #lastReport: GameplayTaskReport | null = null;
  #lastTaskRecord: GameplayTaskRecord | null = null;
  #lastTaskResult: GameplayTaskResult | null = null;
  #lastTaskSteps: readonly GameplayTaskStep[] = Object.freeze([]);
  #cancellationEpoch = 0;

  public constructor(
    private readonly paths: RuntimePaths,
    private readonly integration: IntegrationConnection,
    private readonly actionPolicy?: IntegrationActionPolicy,
    private readonly budget: GameplayTaskBudget = DEFAULT_GAMEPLAY_TASK_BUDGET,
    private readonly sessionFactory?: GameplayTaskSessionFactory,
  ) {
    assertBudget(budget);
  }

  public get modelConfig(): CompanionModelConfig { return GAMEPLAY_SUBAGENT_MODEL_CONFIG; }

  public get activeTaskId(): string | null { return this.#active?.taskId ?? null; }
  /** Immutable private-trace projection; never exposed as a player tool. */
  public get lastTaskRecord(): GameplayTaskRecord | null { return this.#lastTaskRecord; }
  public get lastTaskResult(): GameplayTaskResult | null { return this.#lastTaskResult; }
  public get lastTaskSteps(): readonly GameplayTaskStep[] { return this.#lastTaskSteps; }
  public dispose(): void { this.cancel("gameplay_subagent_disposed"); }

  public createDelegateTool(): ToolDefinition {
    return defineTool({
      name: "delegate_game_task",
      label: "Delegate Gameplay Task",
      description: "Run one bounded gameplay task in a private child Agent. The child cannot speak to the player or change its own permissions.",
      parameters: Type.Object({ task: Type.String({ minLength: 1, maxLength: 2_000 }) }),
      execute: async (_toolCallId, params, signal) => {
        const result = await this.run(params.task, signal);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
  }

  /** Abort the child and request cancellation of the currently authoritative Mod execution when one exists. */
  public cancel(reasonCode = "gameplay_task_cancelled"): void {
    const active = this.#active;
    if (active === undefined) return;
    active.record.terminalReasonCode ??= reasonCode;
    this.#cancellationEpoch++;
    active.controller.abort(reasonCode);
    // Never cancel an execution the task did not itself receive: another
    // product actor may own the currently active Mod execution. A just-accepted
    // request may not yet be present in the next snapshot, so fall back to this
    // task's sole nonterminal owned execution rather than silently abandoning it.
    const module = requireIntegrationModule(this.integration);
    const execution = selectTaskOwnedCancellation(active.record.executions, module.readState(this.integration).activeExecution);
    if (execution !== null) {
      const cancelled = module.cancelExecution(this.integration, execution.requestId, execution.executionId, reasonCode);
      if (isPromiseLike(cancelled)) void cancelled.catch(() => undefined);
    }
    void active.session.abort().catch(() => undefined);
  }

  public async run(task: string, parentSignal?: AbortSignal): Promise<GameplayTaskResult> {
    if (this.#active !== undefined) throw new Error("gameplay_task_already_active");
    return this.#lastTaskResult = await this.runTask(task, parentSignal);
  }

  private async runTask(task: string, parentSignal?: AbortSignal): Promise<GameplayTaskResult> {
    const steps: GameplayTaskStep[] = [];
    this.#lastTaskSteps = Object.freeze([]);
    const taskId = `gameplay_${crypto.randomUUID()}`;
    const createdAtMs = Date.now();
    const record: MutableTaskRecord = {
      taskId,
      scope: this.integration.scope,
      createdAtMs,
      deadlineMs: createdAtMs + this.budget.maxWallClockMs,
      cancellationEpoch: this.#cancellationEpoch,
      budget: this.budget,
      turns: 0,
      toolCalls: 0,
      modelRetries: 0,
      acceptedActions: 0,
      acceptedActionsByFamily: {},
      executions: [],
      terminalReceipt: null,
      terminalReasonCode: null,
    };
    const controller = new AbortController();
    const onParentAbort = () => {
      this.cancel("parent_aborted");
      controller.abort(parentSignal?.reason ?? "parent_aborted");
    };
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    const taskRoot = await mkdtemp(join(this.paths.runtimeCwd, "gameplay-task-"));
    let session: AgentSession | undefined;
    this.#lastReport = null;
    try {
      const agentDir = join(taskRoot, "pi-agent");
      await mkdir(agentDir, { recursive: true });
      const reportTool = defineTool({
        name: "report_to_parent",
        label: "Report Gameplay Task",
        description: "Return a bounded structured task status to the parent Agent. This never speaks to the player.",
        parameters: Type.Object({
          state: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("cancelled")]),
          reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
          evidence: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        execute: async (_toolCallId, params) => {
          const report: GameplayTaskReport = Object.freeze({ state: params.state, reasonCode: params.reasonCode, ...(params.evidence === undefined ? {} : { evidence: params.evidence }) });
          if (report.state === "completed" && !hasAuthoritativeCompletion(report, requireIntegrationModule(this.integration).readState(this.integration).latestReceipt, record.executions, requireIntegrationModule(this.integration).actionCatalog)) {
            throw new Error("authoritative_completion_receipt_required");
          }
          this.#lastReport = report;
          return { content: [{ type: "text" as const, text: JSON.stringify(report) }], details: report };
        },
      });
      const integrationModule = requireIntegrationModule(this.integration);
      const status = defineTool({
        name: "companion_status",
        label: "Companion Status",
        description: "Read the mounted integration status for this private gameplay task.",
        parameters: Type.Object({}),
        execute: async () => {
          const state = requireIntegrationModule(this.integration).readState(this.integration);
          const details = { host: "ready", connected: state.connected, capabilities: [...state.capabilities], snapshotRevision: state.snapshotRevision, latestReceiptState: state.latestReceipt?.state ?? null };
          return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
        },
      });
      const integrationToolSet = integrationModule.createToolSet({ connection: this.integration, knowledge: this.integration.knowledge, gameVersion: this.integration.gameVersion, policy: this.actionPolicy });
      const integrationTools = [
        ...integrationToolSet.observation,
        ...integrationToolSet.actions,
        ...integrationToolSet.knowledge,
      ];
      const budgetedIntegrationTools = integrationTools.map((tool) => budgetTool(tool, record, controller, this.integration, integrationModule, (reasonCode) => this.cancel(reasonCode)));
      const customTools = [
        budgetTool(status, record, controller, this.integration, integrationModule, (reasonCode) => this.cancel(reasonCode)),
        ...budgetedIntegrationTools,
        budgetTool(reportTool, record, controller, this.integration, integrationModule, (reasonCode) => this.cancel(reasonCode)),
      ];
      const allowedToolNames = customTools.map((tool) => tool.name).sort();
      if (this.sessionFactory !== undefined) {
        session = await this.sessionFactory.create({ taskId, taskRoot, agentDir, allowedToolNames, customTools });
      } else {
        session = await createProductionGameplayTaskSession(taskRoot, agentDir, taskId, allowedToolNames, customTools);
      }
      const actualToolNames = session.agent.state.tools.map((tool) => tool.name).sort();
      if (JSON.stringify(actualToolNames) !== JSON.stringify(allowedToolNames)) throw new Error("gameplay_subagent_tool_isolation_failed");
      this.#active = { taskId, controller, session, record };
      const timeout = setTimeout(() => this.cancel("gameplay_task_wall_clock_budget_exhausted"), record.budget.maxWallClockMs);
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_end") {
          record.turns++;
          if (event.willRetry) record.modelRetries++;
          if (record.turns >= record.budget.maxTurns) this.cancel("gameplay_task_turn_budget_exhausted");
          else if (record.modelRetries > record.budget.maxModelRetries) this.cancel("gameplay_task_retry_budget_exhausted");
        }
      });
      try {
        if (controller.signal.aborted) return await abortedTaskResult(taskId, record, this.#lastReport, this.integration);
        await session.prompt(task);
        if (controller.signal.aborted) return await abortedTaskResult(taskId, record, this.#lastReport, this.integration);
      } finally {
        clearTimeout(timeout);
        unsubscribe();
      }
      const summary = finalAssistantText(session.messages);
      steps.push(Object.freeze({ name: "worker_finished", reasonCode: "worker_prompt_finished" }));
      const finalReport: GameplayTaskReport | null = this.#lastReport as GameplayTaskReport | null;
      if (finalReport === null) {
        record.terminalReasonCode ??= "missing_terminal_report";
        steps.push(Object.freeze({ name: "blocked", reasonCode: record.terminalReasonCode }));
        return { taskId, state: "blocked", summary: cap(summary), report: Object.freeze({ reasonCode: "missing_terminal_report" }) };
      }
      if (finalReport.state === "completed") {
        steps.push(Object.freeze({ name: "worker_reported_completed", reasonCode: finalReport.reasonCode }));
        // Recheck at the Host terminal boundary. A later, unrelated receipt may
        // have displaced the one that made report_to_parent admissible.
        if (!hasAuthoritativeCompletion(finalReport, integrationModule.readState(this.integration).latestReceipt, record.executions, integrationModule.actionCatalog)) {
          record.terminalReasonCode = "authoritative_completion_receipt_lost";
          steps.push(Object.freeze({ name: "blocked", reasonCode: record.terminalReasonCode }));
          return { taskId, state: "blocked", summary: cap(summary), report: Object.freeze({ reasonCode: record.terminalReasonCode }) };
        }
        const receipt = integrationModule.readState(this.integration).latestReceipt;
        if (receipt === null) throw new Error("authoritative_completion_receipt_lost");
        record.terminalReceipt = Object.freeze({ requestId: receipt.requestId, executionId: receipt.executionId, state: receipt.state, reasonCode: receipt.reasonCode });
      }
      record.terminalReasonCode ??= finalReport.reasonCode;
      steps.push(Object.freeze({ name: finalReport.state === "completed" ? "authoritatively_completed" : finalReport.state, reasonCode: record.terminalReasonCode }));
      return { taskId, state: finalReport.state, summary: cap(summary), report: finalReport };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && /aborted|cancelled/i.test(error.message))) return await abortedTaskResult(taskId, record, this.#lastReport, this.integration);
      record.terminalReasonCode ??= error instanceof Error ? error.message : "gameplay_subagent_failed";
      return { taskId, state: "blocked", summary: null, report: Object.freeze({ reasonCode: record.terminalReasonCode }) };
    } finally {
      parentSignal?.removeEventListener("abort", onParentAbort);
      this.#lastTaskRecord = freezeRecord(record);
      this.#lastTaskSteps = Object.freeze([...steps]);
      this.#active = undefined;
      session?.dispose();
      await rm(taskRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function createProductionGameplayTaskSession(taskRoot: string, agentDir: string, taskId: string, allowedToolNames: readonly string[], customTools: readonly ToolDefinition[]): Promise<AgentSession> {
  const modelRuntime = await createTaskModelRuntime(agentDir, GAMEPLAY_SUBAGENT_MODEL_CONFIG);
  const model = modelRuntime.getModel(GAMEPLAY_SUBAGENT_MODEL_CONFIG.provider, GAMEPLAY_SUBAGENT_MODEL_CONFIG.modelId);
  if (model === undefined) throw new Error("gameplay_subagent_model_unavailable");
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: taskRoot,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: [
      "You are a private GameBuddy gameplay task worker.",
      "You do not speak to the player. Do not claim completion without an authoritative receipt and postcondition.",
      "Use the current observation first. Use only the tools provided in this task session.",
      "If the task is blocked or cannot be safely corrected, call report_to_parent and stop.",
      `Task id: ${taskId}`,
    ].join("\n"),
    appendSystemPrompt: [],
  });
  const sessionManager = SessionManager.inMemory(taskRoot);
  const { session } = await createAgentSession({
    cwd: taskRoot,
    agentDir,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager,
    modelRuntime,
    model,
    noTools: "all",
    tools: [...allowedToolNames],
    customTools: [...customTools],
    thinkingLevel: GAMEPLAY_SUBAGENT_MODEL_CONFIG.thinkingLevel,
  });
  return session;
}

async function createTaskModelRuntime(agentDir: string, config: CompanionModelConfig): Promise<ModelRuntime> {
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: {
    "cpa-oai": {
      name: "CPA OpenAI-compatible Agent",
      baseUrl: "http://127.0.0.1:8317/v1",
      api: "openai-completions",
      apiKey: "$CPA_OAI_API_KEY",
      authHeader: true,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [{ id: config.modelId, name: config.modelId, reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }, input: ["text"], contextWindow: 272_000, maxTokens: 128_000, cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 } }],
    },
  } }, null, 2), "utf8");
  return ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: true });
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof (value as { then?: unknown }).then === "function";
}

export function selectTaskOwnedCancellation(
  taskExecutions: readonly Readonly<{ requestId: string; executionId: string; state: string }>[],
  observed: Readonly<{ requestId: string; executionId: string }> | null | undefined,
): Readonly<{ requestId: string; executionId: string }> | null {
  if (observed !== null && observed !== undefined
    && taskExecutions.some((known) => known.requestId === observed.requestId && known.executionId === observed.executionId)) {
    return Object.freeze({ requestId: observed.requestId, executionId: observed.executionId });
  }
  const nonterminal = taskExecutions.find((known) => !isTerminalReceiptState(known.state));
  return nonterminal === undefined ? null : Object.freeze({ requestId: nonterminal.requestId, executionId: nonterminal.executionId });
}

export type GameplayActionAdmission =
  | Readonly<{ ok: true; familyId: string }>
  | Readonly<{ ok: false; reasonCode: "unknown_gameplay_action" | "gameplay_task_active_execution_exists" | "gameplay_task_action_budget_exhausted" | "gameplay_task_action_family_budget_exhausted" }>;

/** Pure Host admission decision used immediately before a Game Action tool call. */
export function admitGameplayAction(
  actionId: string,
  record: Readonly<Pick<MutableTaskRecord, "acceptedActions" | "acceptedActionsByFamily" | "executions" | "budget">>,
  activeExecution: Readonly<{ requestId: string; executionId: string }> | null | undefined,
  catalog: IntegrationActionCatalog,
): GameplayActionAdmission {
  const entry = catalog.get(actionId);
  const familyId = entry?.familyId;
  if (familyId === undefined || !catalog.isPublished(actionId)) return Object.freeze({ ok: false, reasonCode: "unknown_gameplay_action" });
  if (activeExecution !== null && activeExecution !== undefined
    || record.executions.some((known) => !isTerminalReceiptState(known.state))) {
    return Object.freeze({ ok: false, reasonCode: "gameplay_task_active_execution_exists" });
  }
  if (record.acceptedActions >= record.budget.maxAcceptedActions) {
    return Object.freeze({ ok: false, reasonCode: "gameplay_task_action_budget_exhausted" });
  }
  if ((record.acceptedActionsByFamily[familyId] ?? 0) >= record.budget.maxAcceptedActionsPerFamily) {
    return Object.freeze({ ok: false, reasonCode: "gameplay_task_action_family_budget_exhausted" });
  }
  return Object.freeze({ ok: true, familyId });
}

export function hasAuthoritativeCompletion(
  report: Readonly<{ state: string; evidence?: unknown }>,
  receipt: IntegrationExecutionReceipt | null,
  taskExecutions: readonly Readonly<{ actionId: string; requestId: string; executionId: string }>[],
  catalog: IntegrationActionCatalog,
): boolean {
  if (report.state !== "completed" || receipt?.state !== "succeeded" || receipt.evidence === null || !isRecord(report.evidence)) return false;
  const requestId = report.evidence.requestId;
  const executionId = report.evidence.executionId;
  const execution = taskExecutions.find((known) => known.requestId === requestId && known.executionId === executionId);
  return requestId === receipt.requestId && executionId === receipt.executionId
    && execution !== undefined && catalog.hasCompletionEvidence(execution.actionId, receipt);
}

/**
 * This is a deliberately narrow Host-side sanity check, not a replacement for
 * the integration's authoritative postconditions. Each module maps its own
 * receipt evidence to a catalog completion validator; Host never treats a
 * generic success string as proof of completion.
 */
export function hasActionPostconditionEvidence(actionId: string, receipt: Readonly<{ reasonCode: string; evidence: Readonly<Record<string, unknown>> | null }>, catalog: IntegrationActionCatalog): boolean {
  return catalog.hasCompletionEvidence(actionId, { state: "succeeded", reasonCode: receipt.reasonCode, evidence: receipt.evidence });
}

function assertBudget(budget: GameplayTaskBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid_gameplay_task_budget:${key}`);
  }
  if (budget.maxActiveExecutions !== 1) throw new Error("invalid_gameplay_task_budget:maxActiveExecutions");
}

function freezeRecord(record: MutableTaskRecord): GameplayTaskRecord {
  return Object.freeze({
    ...record,
    budget: Object.freeze({ ...record.budget }),
    acceptedActionsByFamily: Object.freeze({ ...record.acceptedActionsByFamily }),
    executions: Object.freeze(record.executions.map((execution) => Object.freeze({ ...execution }))),
    terminalReceipt: record.terminalReceipt === null ? null : Object.freeze({ ...record.terminalReceipt }),
  });
}

function budgetTool(tool: ToolDefinition, record: MutableTaskRecord, controller: AbortController, integration: IntegrationConnection, integrationModule: ReturnType<typeof requireIntegrationModule>, cancelTask: (reasonCode: string) => void): ToolDefinition {
  const actionId = integrationModule.actionIdForToolName(tool.name);
  const isCancel = integrationModule.isCancellationTool(tool.name);
  return {
    ...tool,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (controller.signal.aborted) throw new Error(record.terminalReasonCode ?? "gameplay_task_cancelled");
      if (++record.toolCalls > record.budget.maxToolCalls) {
        record.terminalReasonCode ??= "gameplay_task_tool_budget_exhausted";
        cancelTask(record.terminalReasonCode);
        throw new Error(record.terminalReasonCode);
      }
      if (isCancel) {
        const requestId = isRecord(params) ? params.requestId : undefined;
        const executionId = isRecord(params) ? params.executionId : undefined;
        if (typeof requestId !== "string" || typeof executionId !== "string"
          || !record.executions.some((known) => known.requestId === requestId && known.executionId === executionId)) {
          throw new Error("gameplay_task_cancel_not_owned");
        }
      }
      if (actionId !== null) {
        reconcileKnownExecution(record, integration);
        const admission = admitGameplayAction(actionId, record, integrationModule.readState(integration).activeExecution, integrationModule.actionCatalog);
        if (!admission.ok) {
          if (admission.reasonCode.includes("budget_exhausted")) {
            record.terminalReasonCode ??= admission.reasonCode;
            cancelTask(record.terminalReasonCode);
          }
          throw new Error(admission.reasonCode);
        }
        const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
        const receipt = parseReceipt(result.details, integrationModule);
        if (receipt !== null && (receipt.state === "accepted" || receipt.state === "running" || receipt.state === "succeeded")) {
          record.acceptedActions++;
          record.acceptedActionsByFamily[admission.familyId] = (record.acceptedActionsByFamily[admission.familyId] ?? 0) + 1;
          record.executions.push({ actionId, requestId: receipt.requestId, executionId: receipt.executionId, state: receipt.state });
        }
        return result;
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

async function abortedTaskResult(taskId: string, record: MutableTaskRecord, report: GameplayTaskReport | null, integration: IntegrationConnection): Promise<GameplayTaskResult> {
  const integrationModule = requireIntegrationModule(integration);
  const reasonCode = record.terminalReasonCode ?? "gameplay_task_cancelled";
  const budgetExhausted = reasonCode.includes("budget_exhausted");
  const cancellation = await awaitOwnedTerminalReceipt(record, integration);
  if (cancellation !== null) record.terminalReceipt = cancellation;
  if (record.executions.length > 0 && cancellation === null) {
    record.terminalReasonCode = "cancellation_receipt_missing";
    return { taskId, state: "blocked", summary: null, report: Object.freeze({ reasonCode: record.terminalReasonCode }) };
  }
  return {
    taskId,
    state: budgetExhausted ? "blocked" : "cancelled",
    summary: null,
    report: report ?? Object.freeze({ reasonCode }),
  };
}

async function awaitOwnedTerminalReceipt(record: MutableTaskRecord, integration: IntegrationConnection): Promise<MutableTaskRecord["terminalReceipt"]> {
  const integrationModule = requireIntegrationModule(integration);
  const deadline = Math.min(record.deadlineMs, Date.now() + 5_000);
  while (Date.now() < deadline) {
    const receipt = requireIntegrationModule(integration).readState(integration).latestReceipt;
    if (receipt !== null && isTerminalReceiptState(receipt.state)
      && record.executions.some((known) => known.requestId === receipt.requestId && known.executionId === receipt.executionId)) {
      return Object.freeze({ requestId: receipt.requestId, executionId: receipt.executionId, state: receipt.state, reasonCode: receipt.reasonCode });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function isTerminalReceiptState(state: string): boolean {
  return state === "blocked" || state === "invalidated" || state === "succeeded" || state === "partially_succeeded"
    || state === "failed" || state === "cancelled" || state === "expired" || state === "rejected" || state === "uncertain";
}

function reconcileKnownExecution(record: MutableTaskRecord, integration: IntegrationConnection): void {
  const receipt = requireIntegrationModule(integration).readState(integration).latestReceipt;
  if (receipt === null) return;
  const known = record.executions.find((execution) => execution.requestId === receipt.requestId && execution.executionId === receipt.executionId);
  if (known !== undefined) known.state = receipt.state;
}

function parseReceipt(details: unknown, integrationModule: ReturnType<typeof requireIntegrationModule>): IntegrationExecutionReceipt | null {
  return integrationModule.parseReceipt(details);
}

function requireIntegrationModule(integration: IntegrationConnection) {
  if (integration.module === undefined) throw new Error("integration_module_required");
  return integration.module;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cap(value: string | null): string | null {
  return value === null ? null : value.length <= 2_000 ? value : `${value.slice(0, 1_997)}...`;
}
