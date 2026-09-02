import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createStableGameRuntimeBindingIdentity,
  createStardewRecoveryBindingContext,
  readStardewRecoveryBindingContext,
} from "../continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { materializeAuthenticatedStardewLaunchPorts } from "../stardew-integration-launcher-body-program.internal.js";
import { StardewLogicalActionRecoveryJournal } from "../stardew-logical-action-recovery-journal.js";
import type { LiveSourceAttester } from "../companion-live-source-attestation.js";
import type { CompanionInterruption } from "../companion-interruption.js";
import { CompanionLoop } from "../companion-loop.js";
import {
  createFarmhandCompanionPresentationPort,
  createFarmhandPresentationEpochAdmission,
  type FarmhandPresentationBridge,
} from "../farmhand-companion-presentation.js";
import { createGameOperationalGateEvidenceProjection } from "../game-operational-gate-evidence.js";
import type { HostGameLifecycleSnapshot } from "../game-status/game-status.js";
import {
  CompanionHostService,
  createGamePresentationAdmissionProvider,
  GameTurnLineageTracker,
} from "../host-service.js";
import type {
  GameIntegrationAdapter,
  IntegrationActionPolicy,
  IntegrationStateView,
} from "../game-integration-adapter.js";
import type { GameConnection } from "../game-connection.js";
import type { RuntimeSession } from "../runtime.js";
import { createMaterializedGameCompanionRuntime } from "../game-runtime-fixed-tools.internal.js";
import {
  validateBodyProgramCandidateRequest,
  validateBodyProgramCommandResult,
  validateBodyProgramEventsResult,
  validateBodyProgramStatusResult,
  type BodyProgramCandidateRequest,
  type BodyProgramEventsRequest,
  type BodyProgramStatusRequest,
} from "../protocol.js";
import { ModelProfileStore, resolveModelProfileConfig } from "../settings/model-profile-store.js";
import {
  consumeGameVoicePresentationAttachment,
  type GameVoicePresentationAttachment,
} from "../voice-gateway-client.js";
import {
  type GameRuntimeMaterializer,
  type MaterializedGameRuntime,
  materializeExactEnter,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

export type {
  GameRuntimeMaterializer,
  MaterializedGameRuntime,
} from "./continuity-semantic-game-runtime-materializer.internal.js";

type BodyProgramPort = ReturnType<typeof materializeAuthenticatedStardewLaunchPorts>["bodyProgram"];
type BodyProgramConsumer = object;
type BodyProgramConsumerRecord = { port: BodyProgramPort; available: boolean; active: number; drained?: () => void };
const bodyProgramConsumers = new WeakMap<BodyProgramConsumer, BodyProgramConsumerRecord>();

/**
 * Creates the fixed production S4c materializer. This is construction-zone-only:
 * the eventual composer invokes it inside the live S4b one-shot callback after
 * durable prepare. No facade/model/Mod-wire configuration reaches this factory.
 */
function createBodyProgramTools(
  consumer: BodyProgramConsumer,
  connection: GameConnection,
  mountedPolicy: IntegrationActionPolicy,
): readonly ToolDefinition[] {
  const invoke = async <TResult>(
    request: Record<string, unknown>,
    validateRequest: (value: Record<string, unknown>) => string | null,
    validateResult: (value: Record<string, unknown>) => string | null,
    call: (port: BodyProgramPort) => Promise<TResult>,
  ) => {
    if (validateRequest(request) !== null)
      throw new Error("invalid_body_program_tool_arguments");
    const record = bodyProgramConsumers.get(consumer);
    if (record === undefined || !record.available)
      throw new Error("action_program_runtime_unavailable");
    record.active += 1;
    try {
      const result = await call(record.port);
      if (!isRecord(result) || validateResult(result) !== null)
        throw new Error("body_program_protocol_invalid");
      const details = Object.freeze(result);
      return Object.freeze({
        content: [{ type: "text" as const, text: JSON.stringify(details) }],
        details,
      });
    } finally {
      record.active -= 1;
      if (!record.available && record.active === 0) record.drained?.();
    }
  };
  const candidateTool = (
    name: "stardew_verify_action_program" | "stardew_submit_action_program",
    call: (port: BodyProgramPort, request: BodyProgramCandidateRequest) => Promise<unknown>,
  ): ToolDefinition =>
    Object.freeze(defineTool({
      name,
      label: name,
      description: name,
      parameters: bodyProgramToolParameters(name),
      execute: async (_toolCallId, params) => {
        if (!isBodyProgramCandidateRequest(params))
          throw new Error("invalid_body_program_tool_arguments");
        assertFreshBodyProgramPreflight(connection, mountedPolicy, params);
        return invoke(params, validateBodyProgramCandidateRequest, validateBodyProgramCommandResult, (port) => call(port, params));
      },
    }));
  return Object.freeze([
    candidateTool("stardew_verify_action_program", (port, request) => port.verify(request)),
    candidateTool("stardew_submit_action_program", (port, request) => port.submit(request)),
    Object.freeze(defineTool({
      name: "stardew_action_program_status",
      label: "stardew_action_program_status",
      description: "stardew_action_program_status",
      parameters: bodyProgramToolParameters("stardew_action_program_status"),
      execute: async (_toolCallId, params) => {
        if (!isBodyProgramStatusRequest(params)) throw new Error("invalid_body_program_tool_arguments");
        return invoke(params, validateStatusRequest, validateBodyProgramStatusResult, (port) => port.status(params));
      },
    })),
    Object.freeze(defineTool({
      name: "stardew_action_program_events",
      label: "stardew_action_program_events",
      description: "stardew_action_program_events",
      parameters: bodyProgramToolParameters("stardew_action_program_events"),
      execute: async (_toolCallId, params) => {
        if (!isBodyProgramEventsRequest(params)) throw new Error("invalid_body_program_tool_arguments");
        return invoke(params, validateEventsRequest, validateBodyProgramEventsResult, (port) => port.events(params));
      },
    })),
  ]);
}

function isBodyProgramCandidateRequest(value: unknown): value is BodyProgramCandidateRequest {
  return isRecord(value) && validateBodyProgramCandidateRequest(value) === null;
}
function isBodyProgramStatusRequest(value: unknown): value is BodyProgramStatusRequest {
  return isRecord(value) && validateStatusRequest(value) === null;
}
function isBodyProgramEventsRequest(value: unknown): value is BodyProgramEventsRequest {
  return isRecord(value) && validateEventsRequest(value) === null;
}

function bodyProgramToolParameters(name: string) {
  const opaque = Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" });
  const runtimeValue = Type.Object({
    type: Type.String({ minLength: 1, maxLength: 64 }),
    canonicalValue: Type.String({ maxLength: 512 }),
  }, { additionalProperties: false });
  const factReference = Type.Object({ nodeId: opaque, factName: opaque }, { additionalProperties: false });
  const node = Type.Object({
    nodeId: opaque,
    actionId: opaque,
    arguments: Type.Record(opaque, runtimeValue, { maxProperties: 32 }),
    dependsOn: Type.Array(opaque, { maxItems: 8 }),
    bindings: Type.Record(opaque, factReference, { maxProperties: 32 }),
    deadlineMs: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false });
  if (name === "stardew_verify_action_program" || name === "stardew_submit_action_program")
    return Type.Object({ programId: opaque, nodes: Type.Array(node, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false });
  if (name === "stardew_action_program_status")
    return Type.Object({ programId: opaque }, { additionalProperties: false });
  return Type.Object({
    programId: opaque,
    cursor: Type.Integer({ minimum: 0 }),
    pageSize: Type.Integer({ minimum: 1, maximum: 32 }),
  }, { additionalProperties: false });
}

function createBodyProgramToolCloser(consumer: BodyProgramConsumer): () => Promise<void> {
  return async () => {
    const record = bodyProgramConsumers.get(consumer);
    if (record === undefined) return;
    record.available = false;
    if (record.active > 0)
      await new Promise<void>((resolve) => { record.drained = resolve; });
    bodyProgramConsumers.delete(consumer);
  };
}

function assertFreshBodyProgramPreflight(
  connection: GameConnection,
  mountedPolicy: IntegrationActionPolicy,
  request: Record<string, unknown>,
): void {
  if (connection.executionGate?.executable !== true) throw new Error("integration_not_ready");
  const state = connection.module.readState(connection);
  if (!state.connected || state.registrations === undefined) throw new Error("integration_not_ready");
   const visible = connection.module.actionCatalog.visibleActions(
     state.registrations,
     state.enabledActionIds ?? [],
     mountedPolicy,
   );
  const allowed = new Set(visible.map((registration) => registration.actionId));
  if (Array.isArray(request.nodes) && request.nodes.some((node) =>
    !isRecord(node) || typeof node.actionId !== "string" || !allowed.has(node.actionId)
  )) throw new Error("body_program_preflight_rejected");
}

function validateStatusRequest(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["programId"]) && isOpaque(value.programId)
    ? null : "invalid_body_program_request";
}
function validateEventsRequest(value: Record<string, unknown>): string | null {
  return hasExactKeys(value, ["programId", "cursor", "pageSize"]) &&
    isOpaque(value.programId) && Number.isSafeInteger(value.cursor) &&
    (value.cursor as number) >= 0 && Number.isSafeInteger(value.pageSize) &&
    (value.pageSize as number) >= 1 && (value.pageSize as number) <= 32
    ? null : "invalid_body_program_request";
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
export type HostGameRuntimeMaterializerOptions = Readonly<{
  gameOperationalGateNonceSha256?: string;
  /**
   * Opaque capability minted only by the healthy local Voice Gateway client.
   * The materializer alone supplies the receipt-backed session id and Host
   * interruption admission; absent means no presentation tools.
   */
  gameVoicePresentation?: GameVoicePresentationAttachment;
  /** Preview-only parent IPC attestation; absent for every ordinary production launch. */
  liveSourceAttester?: LiveSourceAttester;
}>;

export function createHostGameRuntimeMaterializer(
  options: HostGameRuntimeMaterializerOptions = {},
): GameRuntimeMaterializer {
  return Object.freeze({
    async materializeEnter(
      reservation,
      permit,
    ): Promise<MaterializedGameRuntime> {
      return await materializeExactEnter(reservation, permit, async (execution, admission) => {
        const ports = materializeAuthenticatedStardewLaunchPorts(execution, admission);
        const recoveryIdentity = createStableGameRuntimeBindingIdentity(execution);
        const recoveryJournal = await StardewLogicalActionRecoveryJournal.open(
          Object.freeze({
            directory: join(
              execution.runtimeRoot,
              "stardew-recovery",
              recoveryIdentity.continuityId,
              recoveryIdentity.saveId,
              recoveryIdentity.worldId,
            ),
            scope: recoveryIdentity,
          }),
        );
         const recoveryContext = createStardewRecoveryBindingContext(execution, recoveryJournal);
         const bodyProgramConsumer = Object.freeze(Object.create(null)) as BodyProgramConsumer;
         bodyProgramConsumers.set(bodyProgramConsumer, { port: ports.bodyProgram, available: true, active: 0 });
          const closeFixedTools = createBodyProgramToolCloser(bodyProgramConsumer);
          // Resolve exactly once for this construction; closures and adapter tools
          // share this same object while live state remains freshly read per call.
          const mountedPolicy = execution.connection.module.parsePolicy(
            execution.connection.module.defaultPolicy,
          );
          const fixedTools = createBodyProgramTools(
            bodyProgramConsumer,
            execution.connection,
            mountedPolicy,
          );
        const recovery = readStardewRecoveryBindingContext(recoveryContext);
        let constructed: Readonly<{ runtime: RuntimeSession; turnTracker: GameTurnLineageTracker }>;
        try {
          constructed = await createMaterializedGameRuntime(
          execution.principal,
          execution.world,
          execution.runtimeRoot,
          execution.connection,
          ports.presentation,
          permit.gameSessionId,
          options.gameOperationalGateNonceSha256,
           options.gameVoicePresentation,
           fixedTools,
            Object.freeze({
              resolvedPolicy: mountedPolicy,
              recoveryJournal,
            recoveryBinding: Object.freeze({ scope: recovery.identity, bindingIdentity: recovery.identity }),
            recoveryPort: Object.freeze({
              scope: recovery.identity,
              bindingIdentity: recovery.identity,
              queryExecutionReceipt: recovery.queryExecutionReceipt,
            }),
          }),
        );
         } catch (error) {
            await closeFixedTools();
           await recoveryJournal.close();
           throw error;
          }
          const runtime = constructed.runtime;
          await runtime.recoverStardewExecutionReceipts?.(Object.freeze({
            scope: recovery.identity,
            bindingIdentity: recovery.identity,
            queryExecutionReceipt: recovery.queryExecutionReceipt,
          }));
        const liveSourceAttester = options.liveSourceAttester;
        const loop = new CompanionLoop(
          runtime.session,
          undefined,
          liveSourceAttester,
        );
        const lifecycle = new IntegrationLifecycleSnapshot(
          execution.connection.module,
          execution.connection,
        );
        const host = new CompanionHostService(
          loop,
          execution.launch.events,
          (reasonCode) => {
            lifecycle.markConnectionUnavailable();
            // Loss containment must retain cancellation rejection: seal adapter
            // authority first, then contain every remaining async teardown path.
            execution.launch.revoke(reasonCode);
            void (async () => {
              try {
                await runtime.interruptIntegrationExecutions?.(
                  `integration_${reasonCode}`,
                );
              } catch {
                // The revoked runtime cannot reopen. The rejected cancellation
                // has been observed and contained rather than discarded.
              }
              try {
                runtime.gameplaySubagent?.cancel(`integration_${reasonCode}`);
              } catch {
                // Cancellation is best-effort only after authority revocation.
              }
            })();
          },
          runtime.interruption,
          async (epoch, reasonCode) => {
            if (runtime.cancelIntegrationEpoch === undefined)
              throw new Error("stop_ledger_cancellation_unavailable");
            await runtime.cancelIntegrationEpoch(epoch, reasonCode);
          },
          async (reasonCode) => {
            if (runtime.gameplaySubagent === undefined) return;
            await runtime.gameplaySubagent.cancel(reasonCode);
          },
          constructed.turnTracker,
          runtime.bindIntegrationReceipt,
          liveSourceAttester,
          runtime.refreshIntegrationTools,
        );
        const operationalGateEvidence =
          options.gameOperationalGateNonceSha256 === undefined
            ? undefined
            : createGameOperationalGateEvidenceProjection(
                execution.connection.module,
                execution.connection,
                execution.launch.events,
                host,
              );
        loop.attachTurnObserver(host);
        if (
          runtime.presentation?.surface === "game" &&
          runtime.presentation.textPort !== undefined &&
          runtime.presentation.admissionProvider !== undefined
        ) {
          loop.attachNativeGameContentPresenter(
            host.createNativeAssistantContentPresenter({
              sessionId: runtime.presentation.sessionId,
              locale: runtime.presentation.profile.locale,
              admissionProvider: runtime.presentation.admissionProvider,
              textPort: runtime.presentation.textPort,
            }),
          );
        }
        if (options.gameVoicePresentation !== undefined)
          host.attachVoiceStopper(
            consumeGameVoicePresentationAttachment(
              options.gameVoicePresentation,
            ).stopVoice,
          );
        let ingressActivated = false;
        const activateIngress = (): void => {
          if (ingressActivated) return;
          ingressActivated = true;
          // These launch-owned facts are intentionally withheld until the
          // semantic enter receipt commits. Their first Pi turn therefore
          // cannot speak before both durable admission and STOP authority.
          host.acceptInitialFacts(execution.launch.initialFacts);
        };
          return Object.freeze({
            session: runtime.session,
           piSessionId: runtime.piSessionId,
          ...(runtime.gameplaySubagent === undefined
            ? {}
            : { gameplaySubagent: runtime.gameplaySubagent }),
          ...(runtime.clearGameOperationalGateMarker === undefined
            ? {}
            : {
                clearGameOperationalGateMarker:
                  runtime.clearGameOperationalGateMarker,
              }),
          ...(operationalGateEvidence === undefined
            ? {}
            : { operationalGateEvidence }),
           closeRecoveryJournal: () => recoveryJournal.close(),
           closeFixedTools,
          connected: Object.freeze({
            host,
            lifecycleSnapshot: () => lifecycle.snapshot(),
            ...(operationalGateEvidence === undefined
              ? {}
              : { nextOperationalGateEvidence: operationalGateEvidence.next }),
            markClosing: () => lifecycle.markClosing(),
            activateIngress,
          }),
        });
      });
    },
  });
}

/**
 * Private, read-only reduction of the live integration connection for the Host
 * game-status projection. It owns no lifecycle authority and reads no Chat or
 * origin data.
 */
class IntegrationLifecycleSnapshot {
  #connectionAvailable = true;
  #closing = false;

  public constructor(
    private readonly module: GameIntegrationAdapter,
    private readonly connection: GameConnection,
    private readonly policy?: IntegrationActionPolicy,
  ) {}

  public markConnectionUnavailable(): void {
    this.#connectionAvailable = false;
  }

  public markClosing(): void {
    this.#closing = true;
  }

  public snapshot(): HostGameLifecycleSnapshot {
    const surface = this.#closing ? "returning" : "active";
    if (!this.#connectionAvailable) return unavailable(surface, "absent");
    let state: IntegrationStateView;
    try {
      state = this.module.readState(this.connection);
    } catch {
      return unavailable(surface, "mismatch");
    }
    if (!isStateView(state)) return unavailable(surface, "mismatch");
    if (
      !state.connected ||
      state.sessionId === null ||
      state.snapshotRevision === null
    )
      return unavailable(surface, "absent");
    if (this.#closing) return unavailable(surface, "current");

    let count: number;
    try {
      count = this.module.actionCatalog.visibleActions(
        state.registrations ?? [],
        state.capabilities,
        this.policy,
      ).length;
    } catch {
      return unavailable("active", "mismatch");
    }
    if (!Number.isSafeInteger(count) || count < 0 || count > 512)
      return unavailable("active", "mismatch");
    return Object.freeze({
      availability: "available",
      surface: "active",
      freshness: "current",
      availableCapabilities: Object.freeze({
        category: count === 0 ? "none" : "available",
        count,
      }),
      activeExecution: state.activeExecution === null ? "none" : "active",
      latestAuthoritativeReceipt:
        state.latestReceipt === null
          ? "none"
          : state.latestReceipt.state === "succeeded"
            ? "succeeded"
            : "not_succeeded",
    });
  }
}

function unavailable(
  surface: HostGameLifecycleSnapshot["surface"],
  freshness: HostGameLifecycleSnapshot["freshness"],
): HostGameLifecycleSnapshot {
  return Object.freeze({
    availability: "unavailable",
    surface,
    freshness,
    availableCapabilities: Object.freeze({ category: "none", count: 0 }),
    activeExecution: "none",
    latestAuthoritativeReceipt: "none",
  });
}

function isStateView(value: unknown): value is IntegrationStateView {
  return (
    isRecord(value) &&
    typeof value.connected === "boolean" &&
    (value.sessionId === null || isOpaque(value.sessionId)) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length <= 512 &&
    value.capabilities.every(isOpaque) &&
    (value.snapshotRevision === null ||
      (typeof value.snapshotRevision === "number" &&
        Number.isSafeInteger(value.snapshotRevision) &&
        value.snapshotRevision >= 0)) &&
    (value.activeExecution === null || isRecord(value.activeExecution)) &&
    (value.latestReceipt === null || isRecord(value.latestReceipt))
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

type MaterializedGameRuntimeInput = Readonly<{
  principal: Readonly<{
    continuityId: string;
    companionId: string;
    playerId: string;
  }>;
  world: Readonly<{ saveId: string; worldId: string }>;
  runtimeRoot: string;
  connection: GameConnection;
  gameSessionId: string;
}>;

/**
 * The only named Game runtime constructor lives in the construction-zone
 * materializer. It has no public export: an actual runtime becomes durable
 * Game authority only after this module validates an S4b execution and S4c
 * permit, then the later composer terminalizes an exact receipt.
 */
async function createMaterializedGameRuntime(
  principal: MaterializedGameRuntimeInput["principal"],
  world: MaterializedGameRuntimeInput["world"],
  runtimeRoot: string,
  connection: GameConnection,
  presentation: FarmhandPresentationBridge,
  gameSessionId: string,
  gameOperationalGateNonceSha256: string | undefined,
  gameVoicePresentation: GameVoicePresentationAttachment | undefined,
  fixedTools: readonly ToolDefinition[],
    recoveryAttachment?: Pick<import("../runtime.js").GameCompanionRuntimeAttachment, "recoveryJournal" | "recoveryBinding" | "recoveryPort"> & Readonly<{ resolvedPolicy: IntegrationActionPolicy }>,
): Promise<
  Readonly<{ runtime: RuntimeSession; turnTracker: GameTurnLineageTracker }>
> {
  const identity = Object.freeze({
    continuityId: principal.continuityId,
    companionId: principal.companionId,
    playerId: principal.playerId,
    saveId: world.saveId,
    worldId: world.worldId,
  });
  const turnTracker = new GameTurnLineageTracker();
  const presentationLocale = "zh-CN";
  const hostBindingFactory = (handle: Readonly<{ interruption: CompanionInterruption }>) => {
    if (!isFarmhandPresentationBridge(presentation))
      throw new Error("game_presentation_bridge_unavailable");
    return Object.freeze({
      surface: "game" as const,
      profile: Object.freeze({ locale: presentationLocale, text: true, speech: null }),
      sessionId: gameSessionId,
      textPort: createFarmhandCompanionPresentationPort(
        presentation,
        createFarmhandPresentationEpochAdmission(handle.interruption),
      ),
      admissionProvider: createGamePresentationAdmissionProvider(
        turnTracker,
        handle.interruption,
      ),
    });
  };
  const gameplayWorkerEnabled = gameOperationalGateNonceSha256 !== undefined;
  const workerAttachment = gameplayWorkerEnabled
    ? await (async () => {
        const modelConfig = resolveModelProfileConfig(
          await new ModelProfileStore(
            join(runtimeRoot, "settings", "model-profiles.json"),
          ).read("game"),
        );
        if (modelConfig === null)
          throw new Error("game_runtime_model_configuration_unavailable");
        return Object.freeze({
          modelConfig,
          gameplaySubagentEnabled: true as const,
          hostBindingFactory,
        });
      })()
    : undefined;
  const runtime = await createMaterializedGameCompanionRuntime(
    identity,
    runtimeRoot,
    connection,
    gameSessionId,
    gameOperationalGateNonceSha256 === undefined
      ? undefined
      : Object.freeze({ nonceSha256: gameOperationalGateNonceSha256 }),
    workerAttachment === undefined && recoveryAttachment === undefined ? hostBindingFactory : undefined,
    recoveryAttachment === undefined
      ? workerAttachment
      : workerAttachment === undefined
        ? Object.freeze({
            modelConfig: undefined,
            gameplaySubagentEnabled: false,
            hostBindingFactory,
            recoveryJournal: recoveryAttachment.recoveryJournal,
            recoveryBinding: recoveryAttachment.recoveryBinding,
            recoveryPort: recoveryAttachment.recoveryPort,
          })
        : Object.freeze({ ...workerAttachment, ...recoveryAttachment }),
    Object.freeze({ fixedTools, resolvedPolicy: recoveryAttachment?.resolvedPolicy ?? connection.module.parsePolicy(connection.module.defaultPolicy) }),
  );
  return Object.freeze({ runtime, turnTracker });
}

function isFarmhandPresentationBridge(value: unknown): value is FarmhandPresentationBridge {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FarmhandPresentationBridge).presentCompanionText === "function" &&
    typeof (value as FarmhandPresentationBridge).presentSystemNotice === "function" &&
    typeof (value as FarmhandPresentationBridge).state?.snapshot === "object"
  );
}
