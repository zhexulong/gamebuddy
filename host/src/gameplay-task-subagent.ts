import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executionWakeSourceFor,
  normalizeExecutionWake,
} from "./action-execution-coordinator.internal.js";
import { finalAssistantText } from "./agent-expression.js";
import type {
  ExecutionWake,
  ExecutionWakeSource,
} from "./integration-launcher.js";
import type {
  IntegrationActionCatalog,
  IntegrationActionPolicy,
  IntegrationActionRegistration,
  IntegrationDispatchAdmission,
  IntegrationExecutionReceipt,
} from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";
import type { CompanionModelConfig, RuntimePaths } from "./runtime.js";

/** Gameplay workers are deliberately pinned independently from the dialogue model. */
export const GAMEPLAY_SUBAGENT_MODEL_CONFIG: CompanionModelConfig =
  Object.freeze({
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

export type GameplayTaskRecord = Readonly<{
  taskId: string;
  scope: GameConnection["scope"];
  cancellationEpoch: number;
  /** Highest Mod-owned terminal receipt revision observed by this task. */
  minimumSnapshotRevision: number | null;
  executions: readonly Readonly<{
    actionId: string;
    requestId: string;
    executionId: string;
    state: string;
  }>[];
  /** A request was written but its execute response has not yet been reconciled. */
  pendingDispatch: Readonly<{
    actionId: string;
    requestId: string;
    state: "dispatching" | "uncertain";
    cancelRequired: boolean;
  }> | null;
  /** Receipt reference only; evidence remains Mod-owned and is never copied into worker trace. */
  terminalReceipt: Readonly<{
    requestId: string;
    executionId: string;
    state: string;
    reasonCode: string;
  }> | null;
  terminalReasonCode: string | null;
  /** Whether terminal reconciliation had an adapter wake in addition to polling. */
  wakeMode: "polling" | "event_with_reconcile_poll";
}>;

export type GameplayTaskStep = Readonly<{
  name:
    | "worker_finished"
    | "worker_reported_completed"
    | "authoritatively_completed"
    | "blocked"
    | "cancelled";
  reasonCode: string;
}>;

/** Test-only seam: production keeps the private Pi SDK setup below. */
export type GameplayTaskSessionFactory = Readonly<{
  create(
    input: Readonly<{
      taskId: string;
      taskRoot: string;
      agentDir: string;
      allowedToolNames: readonly string[];
      customTools: readonly ToolDefinition[];
    }>,
  ): Promise<AgentSession>;
  /** Test-only workspace allocation seam; production always calls mkdtemp. */
  createWorkspace?(prefix: string): Promise<string>;
}>;

/**
 * Runtime-owned action correlation for one private worker task. The ledger is
 * the only Host cancel sender; `cancelPending` preserves P4's accepted-after-
 * cancellation race by marking the pre-write registration before a receipt is
 * available.
 */
type GameplayTaskDispatchAdmission = IntegrationDispatchAdmission &
  Readonly<{
    cancelPending(reasonCode: string): void;
  }>;

export type GameplayTaskDispatchAdmissionFactory =
  () => GameplayTaskDispatchAdmission;

type MutableTaskRecord = {
  taskId: string;
  scope: GameConnection["scope"];
  cancellationEpoch: number;
  /** Restrictive local fence; this value is copied from Mod receipt facts only. */
  minimumSnapshotRevision: number | null;
  executions: Array<{
    actionId: string;
    requestId: string;
    executionId: string;
    state: string;
  }>;
  pendingDispatch: {
    actionId: string;
    requestId: string;
    state: "dispatching" | "uncertain";
    cancelRequired: boolean;
  } | null;
  terminalReceipt: {
    requestId: string;
    executionId: string;
    state: string;
    reasonCode: string;
  } | null;
  terminalReasonCode: string | null;
  wakeMode: "polling" | "event_with_reconcile_poll";
};
type ActiveTask = {
  taskId: string;
  controller: AbortController;
  /** Undefined only while this synchronously reserved task is constructing. */
  session: AgentSession | undefined;
  record: MutableTaskRecord;
  dispatchAdmission: GameplayTaskDispatchAdmission | undefined;
  cancellationIssued: boolean;
};
type GameplayTaskReport = Readonly<{
  state: "completed" | "blocked" | "cancelled";
  reasonCode: string;
  evidence?: unknown;
}>;
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
  readonly #executionWakeSource: ExecutionWakeSource | undefined;

  public constructor(
    private readonly paths: RuntimePaths,
    private readonly integration: GameConnection,
    private readonly actionPolicy?: IntegrationActionPolicy,
    private readonly sessionFactory?: GameplayTaskSessionFactory,
    private readonly executionWakeSource?: ExecutionWakeSource,
    private readonly dispatchAdmissionFactory?: GameplayTaskDispatchAdmissionFactory,
  ) {
    this.#executionWakeSource =
      executionWakeSource ?? executionWakeSourceFor(integration);
  }

  public get modelConfig(): CompanionModelConfig {
    return GAMEPLAY_SUBAGENT_MODEL_CONFIG;
  }

  public get activeTaskId(): string | null {
    return this.#active?.taskId ?? null;
  }
  /** Immutable private-trace projection; never exposed as a player tool. */
  public get lastTaskRecord(): GameplayTaskRecord | null {
    return this.#lastTaskRecord;
  }
  public get lastTaskResult(): GameplayTaskResult | null {
    return this.#lastTaskResult;
  }
  public get lastTaskSteps(): readonly GameplayTaskStep[] {
    return this.#lastTaskSteps;
  }
  public dispose(): void {
    this.cancel("gameplay_subagent_disposed");
  }

  public createDelegateTool(): ToolDefinition {
    return defineTool({
      name: "delegate_game_task",
      label: "Delegate Gameplay Task",
      description:
        "Run one gameplay task in a private child Agent. The child cannot speak to the player or change its own permissions.",
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 2_000 }),
      }),
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
    // A request can be on the wire before execute() has returned its execution
    // id. Seal cancellation admission now; settling the response below issues
    // the exact owned cancel once the Mod correlation is known.
    if (active.record.pendingDispatch !== null)
      active.record.pendingDispatch.cancelRequired = true;
    if (active.cancellationIssued) return;
    active.cancellationIssued = true;
    this.#cancellationEpoch++;
    active.controller.abort(reasonCode);
    issueTaskOwnedCancellation(
      active.record,
      active.dispatchAdmission,
      reasonCode,
    );
    void active.session?.abort().catch(() => undefined);
  }

  public async run(
    task: string,
    parentSignal?: AbortSignal,
  ): Promise<GameplayTaskResult> {
    if (this.#active !== undefined)
      throw new Error("gameplay_task_already_active");
    return (this.#lastTaskResult = await this.runTask(task, parentSignal));
  }

  private async runTask(
    task: string,
    parentSignal?: AbortSignal,
  ): Promise<GameplayTaskResult> {
    const steps: GameplayTaskStep[] = [];
    this.#lastTaskSteps = Object.freeze([]);
    const taskId = `gameplay_${crypto.randomUUID()}`;
    const record: MutableTaskRecord = {
      taskId,
      scope: this.integration.scope,
      cancellationEpoch: this.#cancellationEpoch,
      minimumSnapshotRevision: null,
      executions: [],
      pendingDispatch: null,
      terminalReceipt: null,
      terminalReasonCode: null,
      wakeMode:
        this.#executionWakeSource === undefined
          ? "polling"
          : "event_with_reconcile_poll",
    };
    const controller = new AbortController();
    // Reserve synchronously, before the first await. This is also the exact
    // object parent abort, liveness, timeout, and finalization are bound to.
    // A constructor that yields cannot admit a second task into this worker.
    const active: ActiveTask = {
      taskId,
      controller,
      session: undefined,
      record,
      dispatchAdmission: undefined,
      cancellationIssued: false,
    };
    this.#active = active;
    const cancelThisTask = (reasonCode: string) => {
      if (this.#active !== active) return;
      this.cancel(reasonCode);
    };
    const onParentAbort = () => {
      cancelThisTask("parent_aborted");
      controller.abort(parentSignal?.reason ?? "parent_aborted");
    };
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    // Allocation is inside the reservation's cleanup boundary. In particular,
    // a rejected mkdtemp must release this exact synchronous reservation and
    // detach its parent listener before another task may be admitted.
    let taskRoot: string | undefined;
    let session: AgentSession | undefined;
    let taskReport: GameplayTaskReport | null = null;
    this.#lastReport = null;
    try {
      taskRoot = await (this.sessionFactory?.createWorkspace?.(
        join(this.paths.runtimeCwd, "gameplay-task-"),
      ) ?? mkdtemp(join(this.paths.runtimeCwd, "gameplay-task-")));
      const agentDir = join(taskRoot, "pi-agent");
      await mkdir(agentDir, { recursive: true });
      const reportTool = defineTool({
        name: "report_to_parent",
        label: "Report Gameplay Task",
        description:
          "Return a bounded structured task status to the parent Agent. This never speaks to the player.",
        parameters: Type.Object({
          state: Type.Union([
            Type.Literal("completed"),
            Type.Literal("blocked"),
            Type.Literal("cancelled"),
          ]),
          reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
          evidence: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        execute: async (_toolCallId, params) => {
          const report: GameplayTaskReport = Object.freeze({
            state: params.state,
            reasonCode: params.reasonCode,
            ...(params.evidence === undefined
              ? {}
              : { evidence: params.evidence }),
          });
          if (
            report.state === "completed" &&
            !hasAuthoritativeCompletion(
              report,
              requireIntegrationAdapter(this.integration).readState(
                this.integration,
              ).latestReceipt,
              record.executions,
              requireIntegrationAdapter(this.integration).actionCatalog,
            )
          ) {
            throw new Error("authoritative_completion_receipt_required");
          }
          taskReport = report;
          this.#lastReport = report;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(report) }],
            details: report,
          };
        },
      });
      const integrationAdapter = requireIntegrationAdapter(this.integration);
      const status = defineTool({
        name: "companion_status",
        label: "Companion Status",
        description:
          "Read the mounted integration status for this private gameplay task.",
        parameters: Type.Object({}),
        execute: async () => {
          const state = requireIntegrationAdapter(this.integration).readState(
            this.integration,
          );
          const details = {
            host: "ready",
            connected: state.connected,
            capabilities: [...state.capabilities],
            snapshotRevision: state.snapshotRevision,
            latestReceiptState: state.latestReceipt?.state ?? null,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(details) }],
            details,
          };
        },
      });
      // Action tools are absent without a runtime-minted admission. Never
      // capture one in this task's tool closure: every bridge invocation must
      // mint its own admission immediately before pre-write. Retain only the
      // latest actually-issued admission so task cancellation targets a real
      // owned pending/execution correlation rather than a synthetic owner.
      const dispatchAdmissionFactory =
        this.dispatchAdmissionFactory === undefined
          ? undefined
          : () => {
              const admission = this.dispatchAdmissionFactory!();
              active.dispatchAdmission = admission;
              return admission;
            };
      const integrationToolSet = integrationAdapter.createToolSet({
        connection: this.integration,
        knowledge: this.integration.knowledge,
        gameVersion: this.integration.gameVersion,
        policy: this.actionPolicy,
        ...(dispatchAdmissionFactory === undefined
          ? {}
          : { dispatchAdmissionFactory }),
      });
      const integrationTools = [
        ...integrationToolSet.observation,
        ...integrationToolSet.actions,
        ...integrationToolSet.knowledge,
      ];
      const cancelSettledPendingDispatch = (
        requestId: string,
        executionId: string,
      ) => {
        if (!active.cancellationIssued) return;
        const admission = active.dispatchAdmission;
        if (admission === undefined) return;
        void admission
          .cancelExact(
            requestId,
            executionId,
            record.terminalReasonCode ?? "gameplay_task_cancelled",
          )
          .catch(() => undefined);
      };
      const scopedIntegrationTools = integrationTools.map((tool) =>
        taskScopedTool(
          tool,
          record,
          controller,
          this.integration,
          integrationAdapter,
          this.actionPolicy ?? integrationAdapter.defaultPolicy,
          cancelSettledPendingDispatch,
        ),
      );
      const customTools = [
        taskScopedTool(
          status,
          record,
          controller,
          this.integration,
          integrationAdapter,
          this.actionPolicy ?? integrationAdapter.defaultPolicy,
          cancelSettledPendingDispatch,
        ),
        ...scopedIntegrationTools,
        taskScopedTool(
          reportTool,
          record,
          controller,
          this.integration,
          integrationAdapter,
          this.actionPolicy ?? integrationAdapter.defaultPolicy,
          cancelSettledPendingDispatch,
        ),
      ];
      const allowedToolNames = customTools.map((tool) => tool.name).sort();
      if (this.sessionFactory !== undefined) {
        session = await this.sessionFactory.create({
          taskId,
          taskRoot,
          agentDir,
          allowedToolNames,
          customTools,
        });
      } else {
        session = await createProductionGameplayTaskSession(
          taskRoot,
          agentDir,
          taskId,
          allowedToolNames,
          customTools,
        );
      }
      const actualToolNames = session.agent.state.tools
        .map((tool) => tool.name)
        .sort();
      if (JSON.stringify(actualToolNames) !== JSON.stringify(allowedToolNames))
        throw new Error("gameplay_subagent_tool_isolation_failed");
      active.session = session;
      // Liveness is fail-closed for this task only: stop further tool admission,
      // issue at most one owned cancellation, then let the existing bounded
      // receipt watchdog determine the terminal outcome.
      const unsubscribeLiveness = this.#executionWakeSource?.onExecutionWake(
        (candidate) => {
          const wake = normalizeExecutionWake(candidate);
          if (wake?.kind === "terminal") {
            // A bridge write can still be awaiting its response when STOP lands.
            // The adapter's terminal wake lets the task reconcile that exact
            // request immediately; polling remains only a lost-wake fallback.
            settlePendingTerminalWake(record, this.integration, wake);
          }
          if (wake?.kind === "invalidated" || wake?.kind === "disconnected")
            cancelThisTask(`integration_${wake.kind}:${wake.reasonCode}`);
        },
      );
      try {
        if (controller.signal.aborted)
          return await abortedTaskResult(
            taskId,
            record,
            taskReport,
            this.integration,
            controller.signal,
            this.#executionWakeSource,
          );
        await session.prompt(task);
        if (controller.signal.aborted)
          return await abortedTaskResult(
            taskId,
            record,
            taskReport,
            this.integration,
            controller.signal,
            this.#executionWakeSource,
          );
      } finally {
        unsubscribeLiveness?.();
      }
      const summary = finalAssistantText(session.messages);
      steps.push(
        Object.freeze({
          name: "worker_finished",
          reasonCode: "worker_prompt_finished",
        }),
      );
      // Assignment occurs inside the tool callback, which TypeScript's local
      // control-flow analysis cannot observe across await/session boundaries.
      const finalReport = taskReport as GameplayTaskReport | null;
      if (finalReport === null) {
        record.terminalReasonCode ??= "missing_terminal_report";
        steps.push(
          Object.freeze({
            name: "blocked",
            reasonCode: record.terminalReasonCode,
          }),
        );
        return {
          taskId,
          state: "blocked",
          summary: cap(summary),
          report: Object.freeze({ reasonCode: "missing_terminal_report" }),
        };
      }
      if (finalReport.state === "completed") {
        steps.push(
          Object.freeze({
            name: "worker_reported_completed",
            reasonCode: finalReport.reasonCode,
          }),
        );
        // Recheck at the Host terminal boundary. A later, unrelated receipt may
        // have displaced the one that made report_to_parent admissible.
        if (
          !hasAuthoritativeCompletion(
            finalReport,
            integrationAdapter.readState(this.integration).latestReceipt,
            record.executions,
            integrationAdapter.actionCatalog,
          )
        ) {
          record.terminalReasonCode = "authoritative_completion_receipt_lost";
          steps.push(
            Object.freeze({
              name: "blocked",
              reasonCode: record.terminalReasonCode,
            }),
          );
          return {
            taskId,
            state: "blocked",
            summary: cap(summary),
            report: Object.freeze({ reasonCode: record.terminalReasonCode }),
          };
        }
        const receipt = integrationAdapter.readState(
          this.integration,
        ).latestReceipt;
        if (receipt === null)
          throw new Error("authoritative_completion_receipt_lost");
        record.terminalReceipt = Object.freeze({
          requestId: receipt.requestId,
          executionId: receipt.executionId,
          state: receipt.state,
          reasonCode: receipt.reasonCode,
        });
      }
      record.terminalReasonCode ??= finalReport.reasonCode;
      steps.push(
        Object.freeze({
          name:
            finalReport.state === "completed"
              ? "authoritatively_completed"
              : finalReport.state,
          reasonCode: record.terminalReasonCode,
        }),
      );
      return {
        taskId,
        state: finalReport.state,
        summary: cap(summary),
        report: finalReport,
      };
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && /aborted|cancelled/i.test(error.message))
      )
        return await abortedTaskResult(
          taskId,
          record,
          taskReport,
          this.integration,
          controller.signal,
          this.#executionWakeSource,
        );
      record.terminalReasonCode ??=
        error instanceof Error ? error.message : "gameplay_subagent_failed";
      return {
        taskId,
        state: "blocked",
        summary: null,
        report: Object.freeze({ reasonCode: record.terminalReasonCode }),
      };
    } finally {
      parentSignal?.removeEventListener("abort", onParentAbort);
      this.#lastTaskRecord = freezeRecord(record);
      this.#lastTaskSteps = Object.freeze([...steps]);
      // Never let a stale task's finalizer erase a task that replaced it.
      if (this.#active === active) this.#active = undefined;
      session?.dispose();
      if (taskRoot !== undefined)
        await rm(taskRoot, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}

async function createProductionGameplayTaskSession(
  taskRoot: string,
  agentDir: string,
  taskId: string,
  allowedToolNames: readonly string[],
  customTools: readonly ToolDefinition[],
): Promise<AgentSession> {
  const modelRuntime = await createTaskModelRuntime(
    agentDir,
    GAMEPLAY_SUBAGENT_MODEL_CONFIG,
  );
  const model = modelRuntime.getModel(
    GAMEPLAY_SUBAGENT_MODEL_CONFIG.provider,
    GAMEPLAY_SUBAGENT_MODEL_CONFIG.modelId,
  );
  if (model === undefined)
    throw new Error("gameplay_subagent_model_unavailable");
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

async function createTaskModelRuntime(
  agentDir: string,
  config: CompanionModelConfig,
): Promise<ModelRuntime> {
  const modelsPath = join(agentDir, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          "cpa-oai": {
            name: "CPA OpenAI-compatible Agent",
            baseUrl: "http://127.0.0.1:8317/v1",
            api: "openai-completions",
            apiKey: "$CPA_OAI_API_KEY",
            authHeader: true,
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
            },
            models: [
              {
                id: config.modelId,
                name: config.modelId,
                reasoning: true,
                thinkingLevelMap: {
                  off: "none",
                  minimal: null,
                  low: "low",
                  medium: "medium",
                  high: "high",
                  xhigh: "xhigh",
                  max: "max",
                },
                input: ["text"],
                contextWindow: 272_000,
                maxTokens: 128_000,
                cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath,
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: true,
  });
}

function _isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function selectTaskOwnedCancellation(
  taskExecutions: readonly Readonly<{
    requestId: string;
    executionId: string;
    state: string;
  }>[],
  observed:
    Readonly<{ requestId: string; executionId: string }> | null | undefined,
): Readonly<{ requestId: string; executionId: string }> | null {
  if (
    observed !== null &&
    observed !== undefined &&
    taskExecutions.some(
      (known) =>
        known.requestId === observed.requestId &&
        known.executionId === observed.executionId,
    )
  ) {
    return Object.freeze({
      requestId: observed.requestId,
      executionId: observed.executionId,
    });
  }
  const nonterminal = taskExecutions.find(
    (known) => !isTerminalReceiptState(known.state),
  );
  return nonterminal === undefined
    ? null
    : Object.freeze({
        requestId: nonterminal.requestId,
        executionId: nonterminal.executionId,
      });
}

export type GameplayActionAdmission =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reasonCode:
        | "unknown_gameplay_action"
        | "gameplay_task_active_execution_exists"
        | "gameplay_task_snapshot_stale";
    }>;

type GameplayActionAdmissionRecord = Readonly<
  Pick<MutableTaskRecord, "executions">
> &
  Readonly<
    Partial<
      Pick<MutableTaskRecord, "pendingDispatch" | "minimumSnapshotRevision">
    >
  >;

/**
 * Pure Host admission decision used immediately before a Game Action tool call.
 * Runtime production always passes the authenticated Mod registration projection.
 */
export function admitGameplayAction(
  actionId: string,
  record: GameplayActionAdmissionRecord,
  activeExecution:
    Readonly<{ requestId: string; executionId: string }> | null | undefined,
  catalog: IntegrationActionCatalog,
  registrations: readonly IntegrationActionRegistration[],
  capabilities: readonly string[],
  policy: IntegrationActionPolicy,
  snapshotRevision?: number | null,
): GameplayActionAdmission {
  const entry = catalog
    .visibleActions(registrations, capabilities, policy)
    .find((candidate) => candidate.actionId === actionId);
  if (entry === undefined)
    return Object.freeze({ ok: false, reasonCode: "unknown_gameplay_action" });
  if (
    record.minimumSnapshotRevision != null &&
    (snapshotRevision === null ||
      snapshotRevision === undefined ||
      snapshotRevision < record.minimumSnapshotRevision)
  ) {
    return Object.freeze({
      ok: false,
      reasonCode: "gameplay_task_snapshot_stale",
    });
  }
  if (
    (activeExecution !== null && activeExecution !== undefined) ||
    record.executions.some((known) => !isTerminalReceiptState(known.state)) ||
    record.pendingDispatch != null
  ) {
    return Object.freeze({
      ok: false,
      reasonCode: "gameplay_task_active_execution_exists",
    });
  }
  return Object.freeze({ ok: true });
}

export function hasAuthoritativeCompletion(
  report: Readonly<{ state: string; evidence?: unknown }>,
  receipt: IntegrationExecutionReceipt | null,
  taskExecutions: readonly Readonly<{
    actionId: string;
    requestId: string;
    executionId: string;
  }>[],
  catalog: IntegrationActionCatalog,
): boolean {
  if (
    report.state !== "completed" ||
    receipt?.state !== "succeeded" ||
    receipt.evidence === null ||
    !isRecord(report.evidence)
  )
    return false;
  const requestId = report.evidence.requestId;
  const executionId = report.evidence.executionId;
  const execution = taskExecutions.find(
    (known) =>
      known.requestId === requestId && known.executionId === executionId,
  );
  return (
    requestId === receipt.requestId &&
    executionId === receipt.executionId &&
    execution !== undefined &&
    catalog.hasCompletionEvidence(execution.actionId, receipt)
  );
}

/**
 * This is a deliberately narrow Host-side sanity check, not a replacement for
 * the integration's authoritative postconditions. Each module maps its own
 * receipt evidence to a catalog completion validator; Host never treats a
 * generic success string as proof of completion.
 */
export function hasActionPostconditionEvidence(
  actionId: string,
  receipt: Readonly<{
    reasonCode: string;
    evidence: Readonly<Record<string, unknown>> | null;
  }>,
  catalog: IntegrationActionCatalog,
): boolean {
  return catalog.hasCompletionEvidence(actionId, {
    state: "succeeded",
    reasonCode: receipt.reasonCode,
    evidence: receipt.evidence,
  });
}

function freezeRecord(record: MutableTaskRecord): GameplayTaskRecord {
  return Object.freeze({
    ...record,
    executions: Object.freeze(
      record.executions.map((execution) => Object.freeze({ ...execution })),
    ),
    pendingDispatch:
      record.pendingDispatch === null
        ? null
        : Object.freeze({ ...record.pendingDispatch }),
    terminalReceipt:
      record.terminalReceipt === null
        ? null
        : Object.freeze({ ...record.terminalReceipt }),
  });
}

function taskScopedTool(
  tool: ToolDefinition,
  record: MutableTaskRecord,
  controller: AbortController,
  integration: GameConnection,
  integrationAdapter: ReturnType<typeof requireIntegrationAdapter>,
  mountedPolicy: import("./game-integration-adapter.js").IntegrationActionPolicy,
  cancelSettledPendingDispatch: (
    requestId: string,
    executionId: string,
  ) => void,
): ToolDefinition {
  const actionId = integrationAdapter.actionIdForToolName(tool.name);
  const isCancel = integrationAdapter.isCancellationTool(tool.name);
  return {
    ...tool,
    executionMode: "sequential",
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      if (controller.signal.aborted)
        throw new Error(record.terminalReasonCode ?? "gameplay_task_cancelled");
      if (isCancel) {
        const requestId = isRecord(params) ? params.requestId : undefined;
        const executionId = isRecord(params) ? params.executionId : undefined;
        if (
          typeof requestId !== "string" ||
          typeof executionId !== "string" ||
          !record.executions.some(
            (known) =>
              known.requestId === requestId &&
              known.executionId === executionId,
          )
        ) {
          throw new Error("gameplay_task_cancel_not_owned");
        }
      }
      if (actionId !== null) {
        reconcileKnownExecution(record, integration);
        const state = integrationAdapter.readState(integration);
        const admission = admitGameplayAction(
          actionId,
          record,
          state.activeExecution,
          integrationAdapter.actionCatalog,
          state.registrations ?? [],
          state.capabilities,
          mountedPolicy,
          state.snapshotRevision,
        );
        if (!admission.ok) {
          throw new Error(admission.reasonCode);
        }
        const requestId = isRecord(params) ? params.requestId : undefined;
        if (typeof requestId !== "string" || requestId.length === 0)
          throw new Error("gameplay_task_request_id_required");
        // Record ownership before yielding to the transport. Do not infer an
        // execution id or issue a cancel until the Mod has returned one.
        record.pendingDispatch = {
          actionId,
          requestId,
          state: "dispatching",
          cancelRequired: false,
        };
        try {
          const result = await tool.execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );
          settlePendingDispatch(
            record,
            integration,
            integrationAdapter,
            result.details,
            cancelSettledPendingDispatch,
          );
          return result;
        } catch (error) {
          // A post-write transport failure is not proof that no execution
          // exists. Retain a bounded uncertain correlation for reconciliation.
          if (record.pendingDispatch?.requestId === requestId)
            record.pendingDispatch.state = "uncertain";
          throw error;
        }
      }
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

async function abortedTaskResult(
  taskId: string,
  record: MutableTaskRecord,
  report: GameplayTaskReport | null,
  integration: GameConnection,
  _signal: AbortSignal | undefined,
  wakeSource: ExecutionWakeSource | undefined,
): Promise<GameplayTaskResult> {
  const reasonCode = record.terminalReasonCode ?? "gameplay_task_cancelled";
  // Cancellation has already triggered the signal; continue to await the Mod's
  // authoritative terminal receipt inside the bounded watchdog window.
  const cancellation =
    record.pendingDispatch !== null || record.executions.length > 0
      ? await awaitPendingDispatchAndOwnedTerminalReceipt(
          record,
          integration,
          wakeSource,
        )
      : null;
  if (cancellation !== null) record.terminalReceipt = cancellation;
  if (
    record.pendingDispatch !== null ||
    (record.executions.length > 0 && cancellation === null)
  ) {
    record.terminalReasonCode = "cancellation_receipt_missing";
    return {
      taskId,
      state: "blocked",
      summary: null,
      report: Object.freeze({ reasonCode: record.terminalReasonCode }),
    };
  }
  return {
    taskId,
    state: "cancelled",
    summary: null,
    report: report ?? Object.freeze({ reasonCode }),
  };
}

async function awaitOwnedTerminalReceipt(
  record: MutableTaskRecord,
  integration: GameConnection,
  signal: AbortSignal | undefined,
  wakeSource: ExecutionWakeSource | undefined,
): Promise<MutableTaskRecord["terminalReceipt"]> {
  const deadline = Date.now() + 5_000;
  return await awaitTaskOwnedTerminalReceipt({
    executions: record.executions,
    deadlineMs: deadline,
    signal,
    wakeSource,
    readReceipt: () =>
      requireIntegrationAdapter(integration).readState(integration)
        .latestReceipt,
  });
}

/**
 * Wait for a task-owned terminal receipt. An exact validated wake causes an
 * immediate reread; a bounded 250ms poll recovers a lost wake. Neither wake
 * payload nor unrelated receipt can itself establish a terminal result.
 */
export async function awaitTaskOwnedTerminalReceipt(
  input: Readonly<{
    executions: readonly Readonly<{ requestId: string; executionId: string }>[];
    deadlineMs: number;
    signal?: AbortSignal;
    wakeSource?: ExecutionWakeSource;
    readReceipt: () => IntegrationExecutionReceipt | null;
  }>,
): Promise<Readonly<{
  requestId: string;
  executionId: string;
  state: string;
  reasonCode: string;
}> | null> {
  const owned = (receipt: IntegrationExecutionReceipt | null) =>
    receipt !== null &&
    isTerminalReceiptState(receipt.state) &&
    input.executions.some(
      (execution) =>
        execution.requestId === receipt.requestId &&
        execution.executionId === receipt.executionId,
    )
      ? Object.freeze({
          requestId: receipt.requestId,
          executionId: receipt.executionId,
          state: receipt.state,
          reasonCode: receipt.reasonCode,
        })
      : null;
  const initial = owned(input.readReceipt());
  if (initial !== null) return initial;
  if (input.signal?.aborted || Date.now() >= input.deadlineMs) return null;

  return await new Promise((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (receipt: ReturnType<typeof owned>) => {
      if (settled) return;
      settled = true;
      if (poll !== undefined) clearInterval(poll);
      if (deadline !== undefined) clearTimeout(deadline);
      unsubscribe?.();
      input.signal?.removeEventListener("abort", onAbort);
      resolve(receipt);
    };
    // A matching wake is advisory: only an exact terminal receipt from the
    // authoritative reread may settle the waiter. Null, unrelated, and
    // nonterminal rereads keep both the subscription and watchdog alive.
    const reconcile = () => {
      const receipt = owned(input.readReceipt());
      if (receipt !== null) finish(receipt);
    };
    const onAbort = () => finish(null);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    poll = setInterval(reconcile, 250);
    deadline = setTimeout(
      () => finish(null),
      Math.max(0, input.deadlineMs - Date.now()),
    );
    if (input.wakeSource !== undefined) {
      unsubscribe = input.wakeSource.onExecutionWake((candidate) => {
        const wake = normalizeExecutionWake(candidate);
        if (wake === null) return;
        if (wake.kind === "terminal") {
          if (
            !input.executions.some(
              (execution) =>
                execution.requestId === wake.requestId &&
                execution.executionId === wake.executionId,
            )
          )
            return;
          reconcile();
          return;
        }
        // Adapter liveness wakes never manufacture a receipt; callers retain
        // their existing cancellation/freeze path and the poll/deadline fence.
      });
    }
  });
}

function isTerminalReceiptState(state: string): boolean {
  return (
    state === "blocked" ||
    state === "invalidated" ||
    state === "succeeded" ||
    state === "partially_succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "expired" ||
    state === "rejected" ||
    state === "uncertain"
  );
}

function reconcileKnownExecution(
  record: MutableTaskRecord,
  integration: GameConnection,
): void {
  const receipt =
    requireIntegrationAdapter(integration).readState(integration).latestReceipt;
  if (receipt === null) return;
  const known = record.executions.find(
    (execution) =>
      execution.requestId === receipt.requestId &&
      execution.executionId === receipt.executionId,
  );
  if (known !== undefined) {
    known.state = receipt.state;
    recordTerminalReceiptRevision(record, receipt);
  }
}

function recordTerminalReceiptRevision(
  record: MutableTaskRecord,
  receipt: IntegrationExecutionReceipt,
): void {
  if (
    !isTerminalReceiptState(receipt.state) ||
    receipt.revision === null ||
    !Number.isSafeInteger(receipt.revision)
  )
    return;
  record.minimumSnapshotRevision = Math.max(
    record.minimumSnapshotRevision ?? 0,
    receipt.revision,
  );
}

function settlePendingDispatch(
  record: MutableTaskRecord,
  integration: GameConnection,
  integrationAdapter: ReturnType<typeof requireIntegrationAdapter>,
  details: unknown,
  cancelSettledPendingDispatch: (
    requestId: string,
    executionId: string,
  ) => void,
): void {
  const receipt = parseReceipt(details, integrationAdapter);
  const pending = record.pendingDispatch;
  if (
    pending == null ||
    receipt === null ||
    receipt.requestId !== pending.requestId
  )
    return;
  const cancelRequired = pending.cancelRequired;
  settlePendingCorrelation(
    record,
    integration,
    pending.actionId,
    receipt.requestId,
    receipt.executionId,
    receipt.state,
  );
  recordTerminalReceiptRevision(record, receipt);
  const execution = record.executions.find(
    (known) =>
      known.requestId === receipt.requestId &&
      known.executionId === receipt.executionId,
  );
  if (
    cancelRequired &&
    execution !== undefined &&
    !isTerminalReceiptState(execution.state)
  )
    cancelSettledPendingDispatch(receipt.requestId, receipt.executionId);
}

function settlePendingCorrelation(
  record: MutableTaskRecord,
  integration: GameConnection,
  actionId: string,
  requestId: string,
  executionId: string,
  state: string,
): void {
  const pending = record.pendingDispatch;
  if (pending == null || pending.requestId !== requestId) return;
  record.pendingDispatch = null;
  // A receipt event may arrive before the execute response. Preserve that
  // authoritative terminal state rather than issuing a stale cancel from a
  // delayed accepted/running response.
  const latest =
    requireIntegrationAdapter(integration).readState(integration).latestReceipt;
  const resolvedState =
    latest?.requestId === requestId &&
    latest.executionId === executionId &&
    isTerminalReceiptState(latest.state)
      ? latest.state
      : state;
  const existing = record.executions.find(
    (known) =>
      known.requestId === requestId && known.executionId === executionId,
  );
  if (existing === undefined) {
    record.executions.push({
      actionId,
      requestId,
      executionId,
      state: resolvedState,
    });
  } else existing.state = resolvedState;
  if (
    latest !== null &&
    latest.requestId === requestId &&
    latest.executionId === executionId
  )
    recordTerminalReceiptRevision(record, latest);
}

function issueTaskOwnedCancellation(
  record: MutableTaskRecord,
  admission: GameplayTaskDispatchAdmission | undefined,
  reasonCode: string,
): void {
  if (admission === undefined) return;
  const execution = selectTaskOwnedCancellation(record.executions, undefined);
  if (execution === null) {
    admission.cancelPending(reasonCode);
    return;
  }
  void admission
    .cancelExact(execution.requestId, execution.executionId, reasonCode)
    .catch(() => undefined);
}

function settlePendingTerminalWake(
  record: MutableTaskRecord,
  integration: GameConnection,
  wake: Extract<ExecutionWake, { kind: "terminal" }>,
): void {
  const pending = record.pendingDispatch;
  if (pending === null || pending.requestId !== wake.requestId) return;
  const receipt =
    requireIntegrationAdapter(integration).readState(integration).latestReceipt;
  if (
    receipt !== null &&
    receipt.requestId === wake.requestId &&
    receipt.executionId === wake.executionId &&
    isTerminalReceiptState(receipt.state)
  ) {
    settlePendingCorrelation(
      record,
      integration,
      pending.actionId,
      receipt.requestId,
      receipt.executionId,
      receipt.state,
    );
    recordTerminalReceiptRevision(record, receipt);
  }
}

async function awaitPendingDispatchAndOwnedTerminalReceipt(
  record: MutableTaskRecord,
  integration: GameConnection,
  wakeSource: ExecutionWakeSource | undefined,
): Promise<MutableTaskRecord["terminalReceipt"]> {
  const deadline = Date.now() + 5_000;
  await awaitPendingDispatchSettlement(
    record,
    integration,
    wakeSource,
    deadline,
  );
  if (record.pendingDispatch !== null) return null;
  return await awaitOwnedTerminalReceipt(
    record,
    integration,
    undefined,
    wakeSource,
  );
}

/**
 * A post-write abort can precede the execute response. A matching adapter wake
 * causes an immediate authoritative reread and binds only an exact terminal
 * receipt; the 250ms poll is solely lost-wake recovery.
 */
async function awaitPendingDispatchSettlement(
  record: MutableTaskRecord,
  integration: GameConnection,
  wakeSource: ExecutionWakeSource | undefined,
  deadlineMs: number,
): Promise<void> {
  if (record.pendingDispatch === null || Date.now() >= deadlineMs) return;
  const integrationAdapter = requireIntegrationAdapter(integration);
  await new Promise<void>((resolve) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (poll !== undefined) clearInterval(poll);
      if (deadline !== undefined) clearTimeout(deadline);
      unsubscribe?.();
      resolve();
    };
    const reconcile = () => {
      const pending = record.pendingDispatch;
      if (pending === null) return finish();
      const receipt = integrationAdapter.readState(integration).latestReceipt;
      if (
        receipt !== null &&
        receipt.requestId === pending.requestId &&
        isTerminalReceiptState(receipt.state)
      ) {
        settlePendingCorrelation(
          record,
          integration,
          pending.actionId,
          receipt.requestId,
          receipt.executionId,
          receipt.state,
        );
        finish();
      }
    };
    poll = setInterval(reconcile, 250);
    deadline = setTimeout(finish, Math.max(0, deadlineMs - Date.now()));
    if (wakeSource !== undefined) {
      unsubscribe = wakeSource.onExecutionWake((candidate) => {
        const wake = normalizeExecutionWake(candidate);
        if (
          wake?.kind === "terminal" &&
          wake.requestId === record.pendingDispatch?.requestId
        )
          reconcile();
      });
    }
    reconcile();
  });
}

function parseReceipt(
  details: unknown,
  integrationAdapter: ReturnType<typeof requireIntegrationAdapter>,
): IntegrationExecutionReceipt | null {
  return integrationAdapter.parseReceipt(details);
}

function requireIntegrationAdapter(integration: GameConnection) {
  if (integration.module === undefined)
    throw new Error("integration_module_required");
  return integration.module;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cap(value: string | null): string | null {
  return value === null
    ? null
    : value.length <= 2_000
      ? value
      : `${value.slice(0, 1_997)}...`;
}
