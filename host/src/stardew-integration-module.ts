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
      if (
        !sameScope(scope, connection.scope) ||
        scope.playerId !== identity.playerId ||
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
      const scope = (connection as CompanionIntegration).scope;
      if (!sameScope(scope, connection.scope)) throw new Error("integration_scope_mismatch");
      return { integrationId: scope.integrationId, saveId: scope.saveId, worldId: scope.worldId };
    },
    createToolSet: ({
      connection,
      knowledge: mountedKnowledge,
      gameVersion: mountedGameVersion,
      policy,
      dispatchAdmission,
    }: IntegrationToolContext) => {
      const mountedPolicy = (policy ?? DEFAULT_ACTION_POLICY) as ActionPolicy;
      const integration = connection as CompanionIntegration;
      if (!sameScope(integration.scope, connection.scope)) throw new Error("integration_scope_mismatch");
      // Legacy in-process test/bridge connections predate launcher fencing;
      // a launcher-created connection always supplies the gate. Only an
      // explicit revocation removes its already-mounted tool surface.
      if (connection.executionGate?.executable === false)
        return Object.freeze({ observation: [], actions: [], knowledge: [] });
      const knowledge =
        isKnowledgeBundle(mountedKnowledge) && mountedGameVersion !== undefined
          ? createStardewKnowledgeTools(
              { ...integration, knowledge: mountedKnowledge, gameVersion: mountedGameVersion },
              mountedPolicy,
            )
          : ([] as const);
      return Object.freeze({
        observation: createStardewObservationTools(integration, mountedPolicy),
        actions:
          dispatchAdmission === undefined
            ? []
            : createStardewActionTools(integration, mountedPolicy, dispatchAdmission),
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
        activeExecution:
          state.snapshot?.activeExecution === null || state.snapshot?.activeExecution === undefined
            ? null
            : {
                requestId: state.snapshot.activeExecution.requestId,
                executionId: state.snapshot.activeExecution.executionId,
                state: state.snapshot.activeExecution.state,
              },
        latestReceipt: state.latestReceipt === null ? null : toIntegrationReceipt(state.latestReceipt),
        latestReasonCode: state.latestReasonCode,
      };
    },
    cancelExecution: (connection, requestId, executionId, reasonCode) => {
      const integration = connection as CompanionIntegration & {
        cancel?: (requestId: string, executionId: string, reasonCode: string) => unknown;
      };
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
    refill_watering_can: { reasonCode: "watering_can_refilled", keys: [] },
    harvest_crop: { reasonCode: "crop_harvested", keys: ["target=", "inventory_"] },
    plant_seed: {
      reasonCode: "seed_planted",
      keys: ["target=", "item=", "crop=", "inventory_before=", "inventory_after="],
    },
    fertilize_tile: { reasonCode: "fertilizer_applied", keys: ["target=", "inventory_"] },
    place_wood_fence: {
      reasonCode: "wood_fence_placed",
      keys: [
        "target=",
        "item=(O)322",
        "is_fence=true",
        "is_gate=false",
        "health=",
        "max_health=",
        "inventory_before=",
        "inventory_after=",
      ],
    },
    place_crab_pot: {
      reasonCode: "crab_pot_placed",
      keys: [
        "target=",
        "item=(O)710",
        "is_crab_pot=true",
        "owner=",
        "offset_x=",
        "offset_y=",
        "overlay_tiles=",
        "inventory_before=",
        "inventory_after=",
      ],
    },
    bait_crab_pot: {
      reasonCode: "crab_pot_baited",
      keys: [
        "target=",
        "pot=(O)710",
        "owner=",
        "bait_before=none",
        "bait_after=(O)685",
        "inventory_before=",
        "inventory_after=",
      ],
    },
    machine_inspect: { reasonCode: "machine_inspected", keys: ["target=", "machine="] },
    collect_animal_product: { reasonCode: "animal_product_collected", keys: ["target=", "inventory_"] },
    feed_animal: { reasonCode: "hay_placed_in_trough", keys: ["target=", "hay_"] },
    use_item: { reasonCode: "item_used", keys: ["slot=", "stack_before=", "stack_after="] },
    clear_hoedirt: { reasonCode: "hoedirt_cleared", keys: [] },
    dig_artifact_spot: { reasonCode: "artifact_spot_dug", keys: [] },
    break_rock_source: {
      reasonCode: "rock_source_broken",
      keys: [
        "target=",
        "tool=pickaxe",
        "slot=",
        "qualified_item_id=(O)2",
        "durability_before=1",
        "durability_after=removed",
        "removed=true",
      ],
    },
    chop_tree_source: {
      reasonCode: "tree_source_chopped",
      keys: [
        "target=",
        "tool=axe",
        "slot=",
        "tree=",
        "health_before=1",
        "health_after=5",
        "stump_before=false",
        "stump_after=true",
        "source_transformed=true",
      ],
    },
  };
  const requirement = requirements[actionId];
  if (
    requirement === undefined ||
    receipt.state !== "succeeded" ||
    receipt.reasonCode !== requirement.reasonCode ||
    !requirement.keys.every((key) => detail.includes(key))
  )
    return false;

  if (actionId === "till_soil") return hasTillSoilCompletionEvidence(detail);
  if (actionId === "water_crop") return hasWaterCropCompletionEvidence(detail);
  if (actionId === "dig_artifact_spot") return hasDigArtifactSpotCompletionEvidence(detail);
  if (actionId === "refill_watering_can") return hasRefillWateringCanCompletionEvidence(detail);
  if (actionId === "break_rock_source") return hasBreakRockSourceCompletionEvidence(detail);
  if (actionId === "clear_hoedirt") return hasClearHoeDirtCompletionEvidence(detail);
  if (actionId === "chop_tree_source") return hasChopTreeSourceCompletionEvidence(detail);
  if (actionId === "place_wood_fence") return hasWoodFenceCompletionEvidence(detail);
  if (actionId === "bait_crab_pot") return hasBaitCrabPotCompletionEvidence(detail);
  if (actionId !== "plant_seed") return true;
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasOpaqueEvidenceValue(evidence.target) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    hasOpaqueEvidenceValue(evidence.crop) &&
    before !== null &&
    after === before - 1
  );
}

function hasTillSoilCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["location", "target", "before", "after"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    evidence.location !== "none" &&
    hasTileEvidenceValue(evidence.target) &&
    evidence.before === "none" &&
    evidence.after === "HoeDirt"
  );
}

function hasWaterCropCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "before_watered",
    "after_watered",
    "water_before",
    "water_after",
    "water_consumed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    evidence.location !== "none" &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.before_watered === "false" &&
    evidence.after_watered === "true" &&
    before !== null &&
    after !== null &&
    before - after === 1 &&
    evidence.water_consumed === "true"
  );
}

/** Parses bounded key/value evidence without accepting duplicate fields. */
function parseSemicolonEvidence(detail: string): Readonly<Record<string, string>> | null {
  const result: Record<string, string> = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) return null;
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!(key in result) && /^[a-z][a-z0-9_]{0,63}$/.test(key) && value.length <= 512) {
      result[key] = value;
      continue;
    }
    return null;
  }
  return result;
}

// Evidence values are serialized with up to four decimal places; allow rounding plus binary floating-point noise.
const DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON = 0.011;

function hasDigArtifactSpotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "result_target",
    "tile",
    "tool",
    "slot",
    "stamina_before",
    "stamina_after",
    "stamina_delta",
    "expected_stamina_cost",
    "qualified_item_id",
    "source_present_before",
    "source_present_after",
    "hoedirt_present_before",
    "hoedirt_present_after",
    "source_removed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const staminaBefore = finiteEvidenceValue(evidence.stamina_before);
  const staminaAfter = finiteEvidenceValue(evidence.stamina_after);
  const staminaDelta = finiteEvidenceValue(evidence.stamina_delta);
  const expectedStaminaCost = finiteEvidenceValue(evidence.expected_stamina_cost);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasOpaqueIdEvidenceValue(evidence.result_target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.tool === "hoe" &&
    slot !== null &&
    slot >= 0 &&
    slot <= 36 &&
    staminaBefore !== null &&
    staminaAfter !== null &&
    staminaDelta !== null &&
    expectedStaminaCost !== null &&
    Math.abs(staminaAfter - staminaBefore - staminaDelta) <= 0.001 &&
    Math.abs(-staminaDelta - expectedStaminaCost) <= DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON &&
    staminaDelta <= 0 &&
    expectedStaminaCost >= 0 &&
    evidence.qualified_item_id === "(O)590" &&
    evidence.source_present_before === "true" &&
    evidence.source_present_after === "false" &&
    evidence.hoedirt_present_before === "false" &&
    evidence.hoedirt_present_after === "true" &&
    evidence.source_removed === "true"
  );
}

function hasRefillWateringCanCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["target", "slot", "can", "water_before", "water_after", "water_max"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  const max = integerEvidenceValue(evidence.water_max);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasOpaqueEvidenceValue(evidence.can) &&
    slot !== null &&
    before !== null &&
    after !== null &&
    max !== null &&
    before < max &&
    after === max
  );
}

function hasBreakRockSourceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "tool",
    "slot",
    "qualified_item_id",
    "durability_before",
    "durability_after",
    "removed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "pickaxe" &&
    slot !== null &&
    evidence.qualified_item_id === "(O)2" &&
    evidence.durability_before === "1" &&
    evidence.durability_after === "removed" &&
    evidence.removed === "true"
  );
}

function hasClearHoeDirtCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "tool",
    "slot",
    "crop_before",
    "hoedirt_present_before",
    "hoedirt_present_after",
    "removed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.tool === "pickaxe" &&
    slot !== null &&
    slot >= 0 &&
    slot <= 36 &&
    evidence.crop_before === "false" &&
    evidence.hoedirt_present_before === "true" &&
    evidence.hoedirt_present_after === "false" &&
    evidence.removed === "true"
  );
}

function hasWoodFenceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "item",
    "slot",
    "source_empty_before",
    "is_fence",
    "is_gate",
    "health",
    "max_health",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const health = finiteEvidenceValue(evidence.health);
  const maxHealth = finiteEvidenceValue(evidence.max_health);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)322" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.item === "(O)322" &&
    slot !== null &&
    slot <= 36 &&
    evidence.source_empty_before === "true" &&
    evidence.is_fence === "true" &&
    evidence.is_gate === "false" &&
    health !== null &&
    health > 0 &&
    maxHealth !== null &&
    maxHealth >= health &&
    before === 1 &&
    after === 0
  );
}

function hasBaitCrabPotCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "pot",
    "slot",
    "owner",
    "bait_before",
    "bait_after",
    "inventory_before",
    "inventory_after",
    "actionable",
    "active_execution",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)685" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    evidence.location !== "none" &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.pot === "(O)710" &&
    slot !== null &&
    slot <= 36 &&
    hasDecimalOwnerIdEvidenceValue(evidence.owner) &&
    evidence.bait_before === "none" &&
    evidence.bait_after === "(O)685" &&
    before === 1 &&
    after === 0 &&
    evidence.actionable === "true" &&
    evidence.active_execution === "null"
  );
}

function hasChopTreeSourceCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "target",
    "tool",
    "slot",
    "tree",
    "health_before",
    "health_after",
    "stump_before",
    "stump_after",
    "source_transformed",
  ];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "axe" &&
    slot !== null &&
    hasBoundedNonemptyEvidenceValue(evidence.tree) &&
    evidence.health_before === "1" &&
    evidence.health_after === "5" &&
    evidence.stump_before === "false" &&
    evidence.stump_after === "true" &&
    evidence.source_transformed === "true"
  );
}

function integerEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function finiteEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasBoundedNonemptyEvidenceValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function hasTileEvidenceValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  return match !== null && Number(match[1]) <= 1000 && Number(match[2]) <= 1000;
}

function hasOpaqueEvidenceValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value !== "none";
}

function hasOpaqueIdEvidenceValue(value: string | undefined): value is string {
  return typeof value === "string" && value !== "none" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Stardew multiplayer IDs can exceed JavaScript's safe integer range. */
function hasDecimalOwnerIdEvidenceValue(value: string | undefined): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value);
}

function parseStardewReceipt(details: unknown): IntegrationExecutionReceipt | null {
  if (!isRecord(details) || typeof details.receiptJson !== "string") return null;
  try {
    const value = JSON.parse(details.receiptJson) as unknown;
    if (
      !isRecord(value) ||
      typeof value.requestId !== "string" ||
      typeof value.executionId !== "string" ||
      typeof value.state !== "string" ||
      typeof value.reasonCode !== "string"
    )
      return null;
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
