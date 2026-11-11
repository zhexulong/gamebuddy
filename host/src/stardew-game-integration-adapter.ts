import {
  type ActionPolicy,
  DEFAULT_ACTION_POLICY,
  parseActionPolicy,
  STARDEW_ACTION_ADAPTERS,
  searchActionsFromModCatalog,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import {
  createIntegrationActionCatalog,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationAdapter,
  type IntegrationActionCatalog,
  type IntegrationActionPolicy,
  type IntegrationActionRegistration,
  type IntegrationExecutionReceipt,
  type IntegrationIdentityBinding,
  type IntegrationReceiptEvidence,
  type IntegrationStateView,
  type IntegrationStatusDetails,
  type IntegrationToolContext,
} from "./game-integration-adapter.js";
import { createStardewActionTools, createStardewObservationTools } from "./game-tools.js";
import { createStardewKnowledgeTools, type KnowledgeBundle } from "./knowledge.js";
import type { ActionRegistration, ExecutionReceipt } from "./protocol.js";
import { requireLiveConnection } from "./stardew-integration-launcher-body-program.internal.js";
import { hasStardewCompletionEvidence } from "./stardew-completion-contracts.js";

const STARDew_ACTION_ENTRIES = STARDEW_ACTION_ADAPTERS.map(({ actionId }) => ({
  actionId,
}));

/**
 * The Stardew action surface has exactly ONE visibility definition: `visibleActionsFromModCatalog`.
 *
 * The generic predicate answers the same registration facts differently in four of the five shapes the
 * Mod can really publish. It admits an action whose descriptor is absent or drifted, so the tool that
 * would run it cannot be built; it admits an identity version this build cannot execute; and it refuses
 * an experimental action whose descriptor is complete, which the Agent surface must offer. Measured
 * 2026-10-26 against the deployed modules: `advance_day` came back visible from the generic predicate
 * and refused from the strict one for one and the same registration, and the strict one is the
 * authority (design/architecture/game-action-model.md: `live_verified` is the visibility gate).
 *
 * The port's registration type predates `descriptor` and does not declare it, while the Mod's own
 * registration object carries it. Reading it back is what lets the completeness gate answer at all:
 * without it every descriptor-derived action would look descriptor-less and disappear.
 */
function asStardewRegistrations(
  registrations: readonly IntegrationActionRegistration[],
): readonly ActionRegistration[] {
  return registrations.map((registration) => {
    const { descriptor } = registration as IntegrationActionRegistration & {
      readonly descriptor?: ActionRegistration["descriptor"];
    };
    const { actionId, familyId, identityVersion, kind, lifecycle } = registration;
    // The wire always carries both fields (`isValidActionRegistrations` refuses a registration without them),
    // so a value outside these sets never came through the authenticated hello. Name it rather than
    // projecting it as invisible: an empty surface and an unanswerable one are different facts.
    if (lifecycle !== "published" && lifecycle !== "live_verified" && lifecycle !== "experimental")
      throw new Error(`integration_registration_lifecycle_unsupported:${actionId}:${lifecycle}`);
    if (kind !== "execution" && kind !== "read_only")
      throw new Error(`integration_registration_kind_unsupported:${actionId}:${String(kind)}`);
    return {
      actionId,
      familyId,
      identityVersion,
      lifecycle,
      kind,
      ...(descriptor === undefined ? {} : { descriptor }),
    };
  });
}

function createStardewActionCatalog(
  hasCompletionEvidence: (actionId: string, receipt: IntegrationReceiptEvidence) => boolean,
): IntegrationActionCatalog {
  const catalog = createIntegrationActionCatalog(STARDew_ACTION_ENTRIES, hasCompletionEvidence);
  // No try/catch: if the shared predicate throws, the caller sees the throw instead of an empty surface.
  return Object.freeze({
    ...catalog,
    visibleActions: (registrations, capabilities, policy) =>
      visibleActionsFromModCatalog(asStardewRegistrations(registrations), capabilities, policy),
    searchVisibleActions: (registrations, capabilities, query, policy) =>
      searchActionsFromModCatalog(asStardewRegistrations(registrations), capabilities, query, policy),
  });
}

/**
 * The first concrete adapter. Stardew-specific tool/schema/evidence behavior
 * remains here while the Host composition root only consumes this port.
 */
function createStardewGameIntegrationAdapter(): GameIntegrationAdapter {
  const actionCatalog = createStardewActionCatalog(hasStardewCompletionEvidence);
  return Object.freeze({
    descriptor: Object.freeze({
      integrationId: "stardew",
      version: "bridge-v1",
      toolNamePrefix: "stardew_",
    }),
    actionCatalog,
    defaultPolicy: DEFAULT_INTEGRATION_ACTION_POLICY,
    parsePolicy: (value: unknown): IntegrationActionPolicy => parseActionPolicy(value),
    actorId: (connection) => {
      requireLiveConnection(connection);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(connection.scope.playerId)) throw new Error("integration_identity_mismatch");
      return connection.scope.playerId;
    },
    assertIdentityBinding: (connection, identity: IntegrationIdentityBinding) => {
      requireLiveConnection(connection);
      const scope = connection.scope;
      if (
        scope.companionId !== identity.companionId ||
        identity.saveId === undefined ||
        identity.worldId === undefined ||
        scope.saveId !== identity.saveId ||
        scope.worldId !== identity.worldId
      ) {
        throw new Error("integration_identity_binding_mismatch");
      }
    },
    worldScope: (connection) => {
      requireLiveConnection(connection);
      const scope = connection.scope;
      return Object.freeze({
        integrationId: scope.integrationId,
        saveId: scope.saveId,
        worldId: scope.worldId,
      });
    },
    createToolSet: ({
      connection,
      knowledge: mountedKnowledge,
      gameVersion: mountedGameVersion,
      policy,
      dispatchAdmissionFactory,
      trace,
    }: IntegrationToolContext) => {
      const mountedPolicy = (policy ?? DEFAULT_ACTION_POLICY) as ActionPolicy;
      requireLiveConnection(connection);
      const integration = connection;
      // Executable tools require the launcher-owned liveness fence. A missing
      // or revoked gate is never a legacy admission path; observations remain
      // available because they do not dispatch gameplay operations.
      const executable = connection.executionGate?.executable === true;
      const knowledge =
        isKnowledgeBundle(mountedKnowledge) && mountedGameVersion !== undefined
          ? createStardewKnowledgeTools(
              {
                ...integration,
                knowledge: mountedKnowledge,
                gameVersion: mountedGameVersion,
              },
              mountedPolicy,
            )
          : ([] as const);
      return Object.freeze({
        observation: createStardewObservationTools(integration, mountedPolicy),
        actions:
          !executable || dispatchAdmissionFactory === undefined
            ? []
            : createStardewActionTools(integration, mountedPolicy, dispatchAdmissionFactory, trace),
        knowledge,
      });
    },
    knowledgeMetadata: ({ knowledge, gameVersion }) => ({
      mounted: isKnowledgeBundle(knowledge),
      gameVersion: gameVersion ?? null,
      bundleVersion: isKnowledgeBundle(knowledge) ? knowledge.bundleVersion : null,
    }),
    status: (connection): IntegrationStatusDetails => {
      requireLiveConnection(connection);
      const state = connection.state;
      return {
        connected: state.connected,
        capabilities: [...state.capabilities],
        snapshotRevision: state.snapshot?.revision ?? null,
        latestReceiptState: state.latestReceipt?.state ?? null,
        latestReasonCode: state.latestReasonCode,
      };
    },
    readState: (connection): IntegrationStateView => {
      requireLiveConnection(connection);
      const integration = connection;
      const state = integration.state;
      return {
        connected: state.connected,
        sessionId: state.sessionId,
        capabilities: [...state.capabilities],
        ...(state.enabledActionIds === undefined ? {} : { enabledActionIds: [...state.enabledActionIds] }),
        catalogRevision: state.catalogRevision ?? null,
        capabilityRevision: state.policyIdentity?.capabilityRevision ?? null,
        policyIdentity: state.policyIdentity ?? null,
        registrations: [...(state.catalogRegistrations ?? [])],
        snapshotRevision: state.snapshot?.revision ?? null,
        activeExecution:
          state.snapshot?.activeExecution === null || state.snapshot?.activeExecution === undefined
            ? null
            : {
                actionId: state.snapshot.activeExecution.action,
                requestId: state.snapshot.activeExecution.requestId,
                executionId: state.snapshot.activeExecution.executionId,
                state: state.snapshot.activeExecution.state,
              },
        latestReceipt: state.latestReceipt === null ? null : toIntegrationReceipt(state.latestReceipt),
        latestReasonCode: state.latestReasonCode,
      };
    },
    cancelExecution: (connection, requestId, executionId, reasonCode) => {
      requireLiveConnection(connection);
      const integration = connection;
      if (typeof integration.cancel !== "function") return "integration_cancel_unavailable";
      return integration.cancel(requestId, executionId, reasonCode);
    },
    parseReceipt: (details: unknown) => parseStardewReceipt(details),
    actionIdForToolName: (toolName: string) => {
      if (!toolName.startsWith("stardew_")) return null;
      const actionId = toolName.slice("stardew_".length);
      return actionCatalog.hasAdapter(actionId) ? actionId : null;
    },
    isCancellationTool: () => false,
  });
}

export const STARDEW_GAME_INTEGRATION_ADAPTER = createStardewGameIntegrationAdapter();

function parseStardewReceipt(details: unknown): IntegrationExecutionReceipt | null {
  if (!isRecord(details) || typeof details.receiptJson !== "string") return null;
  try {
    const value = JSON.parse(details.receiptJson) as unknown;
    if (
      !isRecord(value) ||
      typeof value.requestId !== "string" ||
      typeof value.executionId !== "string" ||
      typeof value.actionId !== "string" ||
      typeof value.state !== "string" ||
      typeof value.reasonCode !== "string"
    )
      return null;
    return {
      requestId: value.requestId,
      executionId: value.executionId,
      actionId: value.actionId,
      state: value.state,
      reasonCode: value.reasonCode,
      revision: typeof value.revision === "number" ? value.revision : null,
      evidence: isRecord(value.evidence) ? value.evidence : null,
      // A recovered receipt carries the same notices the live one did, validated
      // with the wire's bound so a malformed journal entry is dropped rather than
      // forwarded to the Agent.
      ...(isNativeNoticeList(value.nativeNotices) ? { nativeNotices: value.nativeNotices } : {}),
    };
  } catch {
    return null;
  }
}

/** The wire bound for notice lists, mirrored so a recovered receipt is validated too. */
function isNativeNoticeList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 8 &&
    value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 512)
  );
}

function toIntegrationReceipt(receipt: ExecutionReceipt): IntegrationExecutionReceipt {
  return {
    requestId: receipt.requestId,
    executionId: receipt.executionId,
    actionId: receipt.actionId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence,
    // Forwarded only when present: an absent field means the window captured no
    // notice, which is a different fact from an empty one.
    ...(receipt.nativeNotices == null ? {} : { nativeNotices: receipt.nativeNotices }),
  };
}

function isKnowledgeBundle(value: unknown): value is KnowledgeBundle {
  return typeof value === "object" && value !== null && (value as { bundleVersion?: unknown }).bundleVersion === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
