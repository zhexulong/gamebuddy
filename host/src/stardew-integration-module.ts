import {
  DEFAULT_ACTION_POLICY,
  parseActionPolicy,
  STARDEW_ACTION_REGISTRY,
  type ActionPolicy,
} from "./action-registry.js";
import {
  createIntegrationActionCatalog,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationModule,
  type IntegrationActionPolicy,
  type IntegrationExecutionReceipt,
  type IntegrationIdentityBinding,
  type IntegrationReceiptEvidence,
  type IntegrationStateView,
  type IntegrationStatusDetails,
  type IntegrationToolContext,
} from "./integration-module.js";
import { createStardewActionTools, createStardewObservationTools } from "./game-tools.js";
import { createStardewKnowledgeTools, type KnowledgeBundle } from "./knowledge.js";
import type { CompanionIntegration } from "./integration-types.js";
import type { ExecutionReceipt, Scope } from "./protocol.js";

const STARDew_ACTION_ENTRIES = STARDEW_ACTION_REGISTRY.map((entry) => ({ ...entry }));

/**
 * The first concrete adapter. Stardew-specific tool/schema/evidence behavior
 * remains here while the Host composition root only consumes this port.
 */
export function createStardewIntegrationModule(): GameIntegrationModule {
  const actionCatalog = createIntegrationActionCatalog(STARDew_ACTION_ENTRIES, hasStardewCompletionEvidence);
  return Object.freeze({
    descriptor: Object.freeze({ integrationId: "stardew", version: "bridge-v1", toolNamePrefix: "stardew_" }),
    actionCatalog,
    defaultPolicy: DEFAULT_INTEGRATION_ACTION_POLICY,
    parsePolicy: (value: unknown): IntegrationActionPolicy => parseActionPolicy(value),
    assertIdentityBinding: (connection, identity: IntegrationIdentityBinding) => {
      const scope = (connection as CompanionIntegration).scope;
      if (!sameScope(scope, connection.scope)
        || scope.playerId !== identity.playerId || scope.companionId !== identity.companionId
        || identity.saveId === undefined || identity.worldId === undefined
        || scope.saveId !== identity.saveId || scope.worldId !== identity.worldId) {
        throw new Error("integration_identity_binding_mismatch");
      }
    },
    worldScope: (connection) => {
      const scope = (connection as CompanionIntegration).scope;
      if (!sameScope(scope, connection.scope)) throw new Error("integration_scope_mismatch");
      return { integrationId: scope.integrationId, saveId: scope.saveId, worldId: scope.worldId };
    },
    createToolSet: ({ connection, knowledge: mountedKnowledge, gameVersion: mountedGameVersion, policy }: IntegrationToolContext) => {
      const mountedPolicy = (policy ?? DEFAULT_ACTION_POLICY) as ActionPolicy;
      const integration = connection as CompanionIntegration;
      if (!sameScope(integration.scope, connection.scope)) throw new Error("integration_scope_mismatch");
      // Legacy in-process test/bridge connections predate launcher fencing;
      // a launcher-created connection always supplies the gate. Only an
      // explicit revocation removes its already-mounted tool surface.
      if (connection.executionGate?.executable === false) return Object.freeze({ observation: [], actions: [], knowledge: [] });
      const knowledge = isKnowledgeBundle(mountedKnowledge) && mountedGameVersion !== undefined
        ? createStardewKnowledgeTools({ ...integration, knowledge: mountedKnowledge, gameVersion: mountedGameVersion }, mountedPolicy)
        : [] as const;
      return Object.freeze({
        observation: createStardewObservationTools(integration, mountedPolicy),
        actions: createStardewActionTools(integration, mountedPolicy),
        knowledge,
      });
    },
    knowledgeMetadata: ({ knowledge, gameVersion }) => ({
      mounted: isKnowledgeBundle(knowledge),
      gameVersion: gameVersion ?? null,
      bundleVersion: isKnowledgeBundle(knowledge) ? knowledge.bundleVersion : null,
    }),
    status: (connection): IntegrationStatusDetails => {
      const state = (connection as CompanionIntegration).state;
      return {
        connected: state.connected,
        capabilities: [...state.capabilities],
        snapshotRevision: state.snapshot?.revision ?? null,
        latestReceiptState: state.latestReceipt?.state ?? null,
        latestReasonCode: state.latestReasonCode,
      };
    },
    readState: (connection): IntegrationStateView => {
      const integration = connection as CompanionIntegration;
      if (!sameScope(integration.scope, connection.scope)) throw new Error("integration_scope_mismatch");
      const state = integration.state;
      return {
        connected: state.connected,
        sessionId: state.sessionId,
        capabilities: [...state.capabilities],
        snapshotRevision: state.snapshot?.revision ?? null,
        activeExecution: state.snapshot?.activeExecution === null || state.snapshot?.activeExecution === undefined
          ? null
          : { requestId: state.snapshot.activeExecution.requestId, executionId: state.snapshot.activeExecution.executionId, state: state.snapshot.activeExecution.state },
        latestReceipt: state.latestReceipt === null ? null : toIntegrationReceipt(state.latestReceipt),
        latestReasonCode: state.latestReasonCode,
      };
    },
    cancelExecution: (connection, requestId, executionId, reasonCode) => {
      const integration = connection as CompanionIntegration & { cancel?: (requestId: string, executionId: string, reasonCode: string) => unknown };
      if (!sameScope(integration.scope, connection.scope)) return "integration_scope_mismatch";
      if (typeof integration.cancel !== "function") return "integration_cancel_unavailable";
      return integration.cancel(requestId, executionId, reasonCode);
    },
    parseReceipt: (details: unknown) => parseStardewReceipt(details),
    actionIdForToolName: (toolName: string) => {
      if (!toolName.startsWith("stardew_")) return null;
      const actionId = toolName.slice("stardew_".length);
      return actionCatalog.isPublished(actionId) ? actionId : null;
    },
    isCancellationTool: (toolName: string) => toolName === "stardew_cancel_active_execution",
  });
}

export const STARDEW_INTEGRATION_MODULE = createStardewIntegrationModule();

function hasStardewCompletionEvidence(actionId: string, receipt: IntegrationReceiptEvidence): boolean {
  const detail = receipt.evidence?.detail;
  if (typeof detail !== "string" || detail.length === 0 || detail.length > 4_096) return false;
  const requirements: Readonly<Record<string, Readonly<{ reasonCode: string; keys: readonly string[] }>>> = {
    move_to_tile: { reasonCode: "target_reached", keys: ["tile=", "target=", "arrival=exact"] },
    travel: { reasonCode: "travel_completed", keys: ["expected=", "actual="] },
    enter_exit: { reasonCode: "enter_exit_completed", keys: ["expected=", "actual="] },
    equip_tool: { reasonCode: "tool_selected", keys: ["slot=", "before=", "expected=", "after="] },
    till_soil: { reasonCode: "soil_tilled", keys: ["before=", "after=HoeDirt"] },
    pickup_forage: { reasonCode: "forage_picked_up", keys: ["target=", "inventory_"] },
    pickup_item: { reasonCode: "item_picked_up", keys: ["target=", "inventory_"] },
    water_crop: { reasonCode: "crop_watered", keys: ["before_watered=", "after_watered="] },
    harvest_crop: { reasonCode: "crop_harvested", keys: ["target=", "inventory_"] },
    plant_seed: { reasonCode: "seed_planted", keys: ["target=", "inventory_"] },
    fertilize_tile: { reasonCode: "fertilizer_applied", keys: ["target=", "inventory_"] },
    machine_inspect: { reasonCode: "machine_inspected", keys: ["target=", "machine="] },
    collect_animal_product: { reasonCode: "animal_product_collected", keys: ["target=", "inventory_"] },
    feed_animal: { reasonCode: "hay_placed_in_trough", keys: ["target=", "hay_"] },
    use_item: { reasonCode: "item_used", keys: ["slot=", "stack_before=", "stack_after="] },
  };
  const requirement = requirements[actionId];
  return requirement !== undefined
    && receipt.state === "succeeded"
    && receipt.reasonCode === requirement.reasonCode
    && requirement.keys.every((key) => detail.includes(key));
}

function parseStardewReceipt(details: unknown): IntegrationExecutionReceipt | null {
  if (!isRecord(details) || typeof details.receiptJson !== "string") return null;
  try {
    const value = JSON.parse(details.receiptJson) as unknown;
    if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.executionId !== "string" || typeof value.state !== "string" || typeof value.reasonCode !== "string") return null;
    return {
      requestId: value.requestId,
      executionId: value.executionId,
      state: value.state,
      reasonCode: value.reasonCode,
      revision: typeof value.revision === "number" ? value.revision : null,
      evidence: isRecord(value.evidence) ? value.evidence : null,
    };
  } catch {
    return null;
  }
}

function toIntegrationReceipt(receipt: ExecutionReceipt): IntegrationExecutionReceipt {
  return {
    requestId: receipt.requestId,
    executionId: receipt.executionId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence,
  };
}

function isKnowledgeBundle(value: unknown): value is KnowledgeBundle {
  return typeof value === "object" && value !== null && (value as { bundleVersion?: unknown }).bundleVersion === 1;
}

function sameScope(left: Scope, right: Readonly<{ integrationId: string }>): boolean {
  return left.integrationId === right.integrationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
