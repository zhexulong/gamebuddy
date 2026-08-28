import {
  type ActionPolicy,
  DEFAULT_ACTION_POLICY,
  parseActionPolicy,
  STARDEW_ACTION_ADAPTERS,
} from "./action-registry.js";
import {
  createStardewActionTools,
  createStardewObservationTools,
} from "./game-tools.js";
import {
  createIntegrationActionCatalog,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationAdapter,
  type IntegrationActionPolicy,
  type IntegrationExecutionReceipt,
  type IntegrationIdentityBinding,
  type IntegrationReceiptEvidence,
  type IntegrationStateView,
  type IntegrationStatusDetails,
  type IntegrationToolContext,
} from "./game-integration-adapter.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import {
  createStardewKnowledgeTools,
  type KnowledgeBundle,
} from "./knowledge.js";
import type { ExecutionReceipt, Scope } from "./protocol.js";

const STARDew_ACTION_ENTRIES = STARDEW_ACTION_ADAPTERS.map(({ actionId }) => ({
  actionId,
}));

/**
 * The first concrete adapter. Stardew-specific tool/schema/evidence behavior
 * remains here while the Host composition root only consumes this port.
 */
export function createStardewGameIntegrationAdapter(): GameIntegrationAdapter {
  const actionCatalog = createIntegrationActionCatalog(
    STARDew_ACTION_ENTRIES,
    hasStardewCompletionEvidence,
  );
  return Object.freeze({
    descriptor: Object.freeze({
      integrationId: "stardew",
      version: "bridge-v1",
      toolNamePrefix: "stardew_",
    }),
    actionCatalog,
    defaultPolicy: DEFAULT_INTEGRATION_ACTION_POLICY,
    parsePolicy: (value: unknown): IntegrationActionPolicy =>
      parseActionPolicy(value),
    assertIdentityBinding: (
      connection,
      identity: IntegrationIdentityBinding,
    ) => {
      const scope = (connection as StardewBridgeConnection).scope;
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
      const scope = (connection as StardewBridgeConnection).scope;
      if (!sameScope(scope, connection.scope))
        throw new Error("integration_scope_mismatch");
      return {
        integrationId: scope.integrationId,
        saveId: scope.saveId,
        worldId: scope.worldId,
      };
    },
    createToolSet: ({
      connection,
      knowledge: mountedKnowledge,
      gameVersion: mountedGameVersion,
      policy,
      dispatchAdmissionFactory,
    }: IntegrationToolContext) => {
      const mountedPolicy = (policy ?? DEFAULT_ACTION_POLICY) as ActionPolicy;
      const integration = connection as StardewBridgeConnection;
      if (!sameScope(integration.scope, connection.scope))
        throw new Error("integration_scope_mismatch");
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
        observation: createStardewObservationTools(
          integration,
          mountedPolicy,
        ),
        actions:
          !executable || dispatchAdmissionFactory === undefined
            ? []
            : createStardewActionTools(
                integration,
                mountedPolicy,
                dispatchAdmissionFactory,
              ),
        knowledge,
      });
    },
    knowledgeMetadata: ({ knowledge, gameVersion }) => ({
      mounted: isKnowledgeBundle(knowledge),
      gameVersion: gameVersion ?? null,
      bundleVersion: isKnowledgeBundle(knowledge)
        ? knowledge.bundleVersion
        : null,
    }),
    status: (connection): IntegrationStatusDetails => {
      const state = (connection as StardewBridgeConnection).state;
      return {
        connected: state.connected,
        capabilities: [...state.capabilities],
        snapshotRevision: state.snapshot?.revision ?? null,
        latestReceiptState: state.latestReceipt?.state ?? null,
        latestReasonCode: state.latestReasonCode,
      };
    },
    readState: (connection): IntegrationStateView => {
      const integration = connection as StardewBridgeConnection;
      if (!sameScope(integration.scope, connection.scope))
        throw new Error("integration_scope_mismatch");
      const state = integration.state;
      return {
        connected: state.connected,
        sessionId: state.sessionId,
        capabilities: [...state.capabilities],
        capabilityRevision: state.catalogRevision ?? null,
        registrations: [...(state.catalogRegistrations ?? [])],
        snapshotRevision: state.snapshot?.revision ?? null,
        activeExecution:
          state.snapshot?.activeExecution === null ||
          state.snapshot?.activeExecution === undefined
            ? null
            : {
                actionId: state.snapshot.activeExecution.action,
                requestId: state.snapshot.activeExecution.requestId,
                executionId: state.snapshot.activeExecution.executionId,
                state: state.snapshot.activeExecution.state,
              },
        latestReceipt:
          state.latestReceipt === null
            ? null
            : toIntegrationReceipt(state.latestReceipt),
        latestReasonCode: state.latestReasonCode,
      };
    },
    cancelExecution: (connection, requestId, executionId, reasonCode) => {
      const integration = connection as StardewBridgeConnection & {
        cancel?: (
          requestId: string,
          executionId: string,
          reasonCode: string,
        ) => unknown;
      };
      if (!sameScope(integration.scope, connection.scope))
        return "integration_scope_mismatch";
      if (typeof integration.cancel !== "function")
        return "integration_cancel_unavailable";
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

export const STARDEW_GAME_INTEGRATION_ADAPTER =
  createStardewGameIntegrationAdapter();

function hasStardewCompletionEvidence(
  actionId: string,
  receipt: IntegrationReceiptEvidence,
): boolean {
  const detail = receipt.evidence?.detail;
  if (
    receipt.state !== "succeeded" ||
    typeof detail !== "string" ||
    detail.length === 0 ||
    detail.length > 4_096
  )
    return false;
  // Each published action is explicit. Unsupported schemas fail closed rather
  // than treating a succeeded receipt or a matching substring as completion.
  switch (actionId) {
    case "equip_tool":
      return (
        receipt.reasonCode === "tool_selected" &&
        exactEvidence(
          detail,
          ["slot", "before", "expected", "after"],
          (e) =>
            validSlot(e.slot) &&
            isToolSelectionBeforeValue(e.before) &&
            hasOpaqueEvidenceValue(e.expected) &&
            e.after === e.expected,
        )
      );
    case "till_soil":
      return (
        receipt.reasonCode === "soil_tilled" &&
        hasTillSoilCompletionEvidence(detail)
      );
    case "water_crop":
      return (
        receipt.reasonCode === "crop_watered" &&
        hasWaterCropCompletionEvidence(detail)
      );
    case "refill_watering_can":
      return (
        receipt.reasonCode === "watering_can_refilled" &&
        hasRefillWateringCanCompletionEvidence(detail)
      );
    case "dig_artifact_spot":
      return (
        receipt.reasonCode === "artifact_spot_dug" &&
        hasDigArtifactSpotCompletionEvidence(detail)
      );
    case "break_rock_source":
      return (
        receipt.reasonCode === "rock_source_broken" &&
        hasBreakRockSourceCompletionEvidence(detail)
      );
    case "clear_hoedirt":
      return (
        receipt.reasonCode === "hoedirt_cleared" &&
        hasClearHoeDirtCompletionEvidence(detail)
      );
    case "chop_tree_source":
      return (
        receipt.reasonCode === "tree_source_chopped" &&
        hasChopTreeSourceCompletionEvidence(detail)
      );
    case "place_wood_fence":
      return (
        receipt.reasonCode === "wood_fence_placed" &&
        hasWoodFenceCompletionEvidence(detail)
      );
    case "bait_crab_pot":
      return (
        receipt.reasonCode === "crab_pot_baited" &&
        hasBaitCrabPotCompletionEvidence(detail)
      );
    case "plant_seed":
      return (
        receipt.reasonCode === "seed_planted" &&
        exactEvidence(
          detail,
          [
            "location",
            "target",
            "tile",
            "item",
            "crop",
            "inventory_before",
            "inventory_after",
          ],
          (e) =>
            hasBoundedNonemptyEvidenceValue(e.location) &&
            hasOpaqueIdEvidenceValue(e.target) &&
            hasTileEvidenceValue(e.tile) &&
            hasOpaqueEvidenceValue(e.item) &&
            hasOpaqueEvidenceValue(e.crop) &&
            decremented(e.inventory_before, e.inventory_after),
        )
      );
    case "move_to_tile":
      return (
        receipt.reasonCode === "target_reached" &&
        hasMoveToTileCompletionEvidence(detail)
      );
    case "travel":
      return (
        receipt.reasonCode === "travel_completed" &&
        hasDoorTransitionCompletionEvidence(detail)
      );
    case "enter_exit":
      return (
        receipt.reasonCode === "enter_exit_completed" &&
        hasDoorTransitionCompletionEvidence(detail)
      );
    case "navigate_to_destination":
      return (
        receipt.reasonCode === "navigation_completed" &&
        hasNavigationCompletionEvidence(detail)
      );
    case "pickup_forage":
      return (
        receipt.reasonCode === "forage_picked_up" &&
        hasPickupForageCompletionEvidence(detail)
      );
    case "pickup_item":
      return (
        receipt.reasonCode === "item_picked_up" &&
        hasPickupItemCompletionEvidence(detail)
      );
    case "fertilize_tile":
      return (
        receipt.reasonCode === "fertilizer_applied" &&
        hasFertilizeTileCompletionEvidence(detail)
      );
    case "place_crab_pot":
      return (
        receipt.reasonCode === "crab_pot_placed" &&
        hasPlaceCrabPotCompletionEvidence(detail)
      );
    case "machine_inspect":
      return (
        receipt.reasonCode === "machine_inspected" &&
        hasMachineInspectCompletionEvidence(detail)
      );
    case "machine_load":
      return (
        receipt.reasonCode === "machine_coffee_loaded" &&
        hasMachineLoadCompletionEvidence(detail)
      );
    case "machine_collect_output":
      return (
        receipt.reasonCode === "machine_coffee_collected" &&
        hasMachineCollectOutputCompletionEvidence(detail)
      );
    case "collect_animal_product":
      return (
        receipt.reasonCode === "animal_product_collected" &&
        hasCollectAnimalProductCompletionEvidence(detail)
      );
    case "feed_animal":
      return (
        receipt.reasonCode === "hay_placed_in_trough" &&
        hasFeedAnimalCompletionEvidence(detail)
      );
    case "use_item":
      return (
        receipt.reasonCode === "item_used" &&
        hasUseItemCompletionEvidence(detail)
      );
    case "harvest_crop":
      return (
        receipt.reasonCode === "crop_harvested" &&
        hasHarvestCropCompletionEvidence(detail)
      );
    default:
      return false;
  }
}

function exactEvidence(
  detail: string,
  expectedKeys: readonly string[],
  validate: (evidence: Readonly<Record<string, string>>) => boolean,
): boolean {
  const evidence = parseSemicolonEvidence(detail);
  return (
    evidence !== null &&
    Object.keys(evidence).length === expectedKeys.length &&
    expectedKeys.every((key) => key in evidence) &&
    validate(evidence)
  );
}
function validSlot(value: string | undefined): boolean {
  const slot = integerEvidenceValue(value);
  return slot !== null && slot <= 36;
}
function decremented(
  before: string | undefined,
  after: string | undefined,
): boolean {
  const left = integerEvidenceValue(before);
  const right = integerEvidenceValue(after);
  return left !== null && right !== null && right === left - 1;
}

function hasNavigationCompletionEvidence(detail: string): boolean {
  // The Mod emits exactly this navigation_completed evidence only from a fresh
  // post-warp coordinator re-read at the destination. It contains only the
  // canonical opaque destination identity and a fresh actual location assertion
  // together with the two Mod postcondition markers; never a route/tile/warp.
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["destination", "location", "arrived", "postcondition"];
  if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence))
    return false;
  return (
    hasOpaqueEvidenceValue(evidence.destination) &&
    hasOpaqueEvidenceValue(evidence.location) &&
    evidence.arrived === "true" &&
    evidence.postcondition === "true"
  );
}

function hasMoveToTileCompletionEvidence(detail: string): boolean {
  return exactEvidence(detail, ["tile", "target", "arrival", "path"], (e) => {
    const target = parseCanonicalIntegralTile(e.target);
    const tile = parseFormatTile(e.tile);
    return (
      target !== null &&
      tile !== null &&
      canBeSerializedExactArrival(tile, target) &&
      e.arrival === "exact" &&
      e.path === "stardew_native"
    );
  });
}

/**
 * The request producer admits integral [0, 1000] target tiles and serializes
 * them with `:0.##`; preserve that canonical integer spelling in the receipt.
 */
function parseCanonicalIntegralTile(
  value: string | undefined,
): readonly [number, number] | null {
  if (value === undefined) return null;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  return x <= 1000 && y <= 1000 ? [x, y] : null;
}

/** Parses exactly the nonnegative canonical output grammar of C# `:0.##`. */
function parseFormatTile(
  value: string | undefined,
): readonly [number, number] | null {
  if (value === undefined) return null;
  // `:0.##` omits a zero fractional part and never retains a trailing zero.
  const match =
    /^(0|[1-9][0-9]*)(?:\.([0-9]{0,1}[1-9]))?,(0|[1-9][0-9]*)(?:\.([0-9]{0,1}[1-9]))?$/.exec(
      value,
    );
  if (match === null) return null;
  const x = Number(match[1]) + Number(`0.${match[2] ?? "0"}`);
  const y = Number(match[3]) + Number(`0.${match[4] ?? "0"}`);
  // A successful requested edge tile may round to 1000.2; the exact-arrival
  // relation below imposes the tighter target-relative bound.
  return x <= 1000.2 && y <= 1000.2 ? [x, y] : null;
}

function canBeSerializedExactArrival(
  tile: readonly [number, number],
  target: readonly [number, number],
): boolean {
  // The producer succeeds when |actual - target|² <= 0.04 (radius 0.2).
  // `:0.##` quantizes each displayed coordinate by at most 0.005, so an
  // emitted coordinate q is possible iff max(|q-target|-0.005, 0) per axis
  // can still lie within that radius. This rejects tiles definitely outside
  // every successful producer value without inventing a looser tolerance.
  const x = Math.max(Math.abs(tile[0] - target[0]) - 0.005, 0);
  const y = Math.max(Math.abs(tile[1] - target[1]) - 0.005, 0);
  return x * x + y * y <= 0.04;
}

function hasTillSoilCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = ["location", "target", "before", "after"];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
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
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
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
    // FarmhandExecutionController emits only waterConsumed plus before/after
    // quantities: bottomless cans and watering-can enchantments legitimately
    // report a consumed watering operation without decrementing WaterLeft.
    // Therefore accept exactly the producer-observable relation, 0 or 1 used,
    // rather than inventing an unavailable branch discriminator.
    after <= before &&
    before - after <= 1 &&
    evidence.water_consumed === "true"
  );
}

/** Parses bounded key/value evidence without accepting duplicate fields. */
function parseSemicolonEvidence(
  detail: string,
): Readonly<Record<string, string>> | null {
  const result: Record<string, string> = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) return null;
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (
      !(key in result) &&
      /^[a-z][a-z0-9_]{0,63}$/.test(key) &&
      value.length <= 512
    ) {
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
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const staminaBefore = finiteEvidenceValue(evidence.stamina_before);
  const staminaAfter = finiteEvidenceValue(evidence.stamina_after);
  const staminaDelta = finiteEvidenceValue(evidence.stamina_delta);
  const expectedStaminaCost = finiteEvidenceValue(
    evidence.expected_stamina_cost,
  );
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
    Math.abs(-staminaDelta - expectedStaminaCost) <=
      DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON &&
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
  const expectedKeys = [
    "target",
    "slot",
    "can",
    "water_before",
    "water_after",
    "water_max",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const _slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.water_before);
  const after = integerEvidenceValue(evidence.water_after);
  const max = integerEvidenceValue(evidence.water_max);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasOpaqueEvidenceValue(evidence.can) &&
    validSlot(evidence.slot) &&
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
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const _slot = integerEvidenceValue(evidence.slot);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "pickaxe" &&
    validSlot(evidence.slot) &&
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
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
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
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
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
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
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
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const _slot = integerEvidenceValue(evidence.slot);
  return (
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.tool === "axe" &&
    validSlot(evidence.slot) &&
    hasBoundedNonemptyEvidenceValue(evidence.tree) &&
    evidence.health_before === "1" &&
    evidence.health_after === "5" &&
    evidence.stump_before === "false" &&
    evidence.stump_after === "true" &&
    evidence.source_transformed === "true"
  );
}

function hasDoorTransitionCompletionEvidence(detail: string): boolean {
  return exactEvidence(detail, ["expected", "actual"], (e) => {
    const expected = parseWarpDestination(e.expected);
    const actual = parseWarpDestination(e.actual);
    return (
      expected !== null &&
      actual !== null &&
      actual.location === expected.location &&
      actual.x === expected.x &&
      actual.y === expected.y
    );
  });
}

/**
 * Parses the producer's `location:x,y` destination grammar. The location is
 * greedy up to the final colon so native names that themselves contain a
 * colon still round-trip; the trailing coordinates are canonical integers.
 */
function parseWarpDestination(
  value: string | undefined,
): { location: string; x: number; y: number } | null {
  if (value === undefined) return null;
  const match = /^(.*):(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return null;
  const location = match[1];
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!hasBoundedNonemptyEvidenceValue(location) || x > 1000 || y > 1000)
    return null;
  return { location, x, y };
}

function hasPickupForageCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "item",
    "removed",
    "inventory_before",
    "inventory_after",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasTileEvidenceValue(evidence.target) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    evidence.removed === "true" &&
    before !== null &&
    after !== null &&
    after > before
  );
}

function hasPickupItemCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "item",
    "stack",
    "native_auto_collect",
    "chunk_removed",
    "inventory_before",
    "inventory_after",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const stack = integerEvidenceValue(evidence.stack);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    stack !== null &&
    stack >= 1 &&
    evidence.native_auto_collect === "true" &&
    evidence.chunk_removed === "true" &&
    before !== null &&
    after !== null &&
    after >= before + stack
  );
}

function hasHarvestCropCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "crop",
    "item",
    "native_path_return",
    "native_accepted",
    "regrows",
    "phase_before",
    "phase_after",
    "day_of_phase_before",
    "day_of_phase_after",
    "regrow_advanced",
    "inventory_before",
    "inventory_after",
    "inventory_gained",
    "crop_present_after",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const phaseBefore = integerEvidenceValue(evidence.phase_before);
  const dayOfPhaseBefore = integerEvidenceValue(evidence.day_of_phase_before);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  if (
    !hasBoundedNonemptyEvidenceValue(evidence.location) ||
    !hasOpaqueIdEvidenceValue(evidence.target) ||
    !hasTileEvidenceValue(evidence.tile) ||
    !hasOpaqueEvidenceValue(evidence.crop) ||
    !hasOpaqueEvidenceValue(evidence.item) ||
    evidence.native_accepted !== "true" ||
    evidence.inventory_gained !== "true" ||
    before === null ||
    after === null ||
    after <= before ||
    phaseBefore === null ||
    dayOfPhaseBefore === null
  )
    return false;
  if (evidence.regrows === "true") {
    // A regrowing harvest keeps the crop and advances its phase/day; the
    // native path return is deliberately unconstrained because the producer
    // documents that a successful regrow harvest normally falls through.
    const phaseAfter = integerEvidenceValue(evidence.phase_after);
    const dayOfPhaseAfter = integerEvidenceValue(evidence.day_of_phase_after);
    return (
      evidence.crop_present_after === "true" &&
      evidence.regrow_advanced === "true" &&
      phaseAfter !== null &&
      phaseAfter >= phaseBefore &&
      dayOfPhaseAfter !== null &&
      dayOfPhaseAfter > dayOfPhaseBefore
    );
  }
  if (evidence.regrows === "false") {
    // A non-regrowing harvest destroys the crop through the native path.
    return (
      evidence.crop_present_after === "false" &&
      evidence.phase_after === "none" &&
      evidence.day_of_phase_after === "none" &&
      evidence.native_path_return === "true"
    );
  }
  return false;
}

function hasFertilizeTileCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "item",
    "fertilizer_before",
    "fertilizer_after",
    "inventory_before",
    "inventory_after",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.item) &&
    isNoneOrOpaqueEvidenceValue(evidence.fertilizer_before) &&
    evidence.fertilizer_after === evidence.item &&
    before !== null &&
    after !== null &&
    after === before - 1
  );
}

function hasPlaceCrabPotCompletionEvidence(detail: string): boolean {
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
    "is_crab_pot",
    "owner",
    "offset_x",
    "offset_y",
    "overlay_tiles",
    "inventory_before",
    "inventory_after",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const x = integerEvidenceValue(evidence.x);
  const y = integerEvidenceValue(evidence.y);
  const slot = integerEvidenceValue(evidence.slot);
  const offsetX = finiteEvidenceValue(evidence.offset_x);
  const offsetY = finiteEvidenceValue(evidence.offset_y);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    evidence.source === "(O)710" &&
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    x !== null &&
    x <= 1000 &&
    y !== null &&
    y <= 1000 &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    evidence.item === "(O)710" &&
    slot !== null &&
    slot <= 36 &&
    evidence.source_empty_before === "true" &&
    evidence.is_crab_pot === "true" &&
    hasDecimalOwnerIdEvidenceValue(evidence.owner) &&
    offsetX !== null &&
    offsetY !== null &&
    hasCrabPotOverlayEvidence(evidence.overlay_tiles) &&
    before !== null &&
    after !== null &&
    after === before - 1
  );
}

/**
 * The producer joins only count>0 overlay tiles as `x,y:count|...`; the
 * shared evidence grammar rejects empty values, so a completed receipt must
 * carry at least one overlay tile.
 */
function hasCrabPotOverlayEvidence(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*):[1-9][0-9]*(?:\|(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*):[1-9][0-9]*)*$/.test(
    value,
  );
}

function hasMachineInspectCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "ready_for_harvest",
    "minutes_until_ready",
    "held",
    "last_input",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const minutes = signedIntegerEvidenceValue(evidence.minutes_until_ready);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    hasOpaqueEvidenceValue(evidence.machine) &&
    (evidence.ready_for_harvest === "true" ||
      evidence.ready_for_harvest === "false") &&
    minutes !== null &&
    isNoneOrOpaqueEvidenceValue(evidence.held) &&
    isNoneOrOpaqueEvidenceValue(evidence.last_input)
  );
}

function hasMachineLoadCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "slot",
    "input",
    "input_stack_before",
    "input_stack_after",
    "last_input",
    "held",
    "ready_for_harvest",
    "minutes_until_ready",
    "native_check_action",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.machine === "(BC)12" &&
    slot !== null &&
    slot <= 36 &&
    evidence.input === "(O)433" &&
    evidence.input_stack_before === "5" &&
    evidence.input_stack_after === "removed" &&
    evidence.last_input === "(O)433" &&
    evidence.held === "(O)395" &&
    evidence.ready_for_harvest === "false" &&
    evidence.minutes_until_ready === "120" &&
    evidence.native_check_action === "true"
  );
}

function hasMachineCollectOutputCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "machine",
    "output",
    "input",
    "ready_before",
    "minutes_until_ready_before",
    "inventory_coffee_before",
    "inventory_coffee_after",
    "held_after",
    "ready_after",
    "native_check_action",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const before = integerEvidenceValue(evidence.inventory_coffee_before);
  const after = integerEvidenceValue(evidence.inventory_coffee_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    evidence.machine === "(BC)12" &&
    evidence.output === "(O)395" &&
    evidence.input === "(O)433" &&
    evidence.ready_before === "true" &&
    evidence.minutes_until_ready_before === "0" &&
    before !== null &&
    after !== null &&
    after === before + 1 &&
    evidence.held_after === "none" &&
    evidence.ready_after === "false" &&
    evidence.native_check_action === "true"
  );
}

function hasUseItemCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "slot",
    "item",
    "stack_before",
    "stack_after",
    "edibility",
    "drink",
    "stamina_before",
    "stamina_after",
    "health_before",
    "health_after",
    "animation_complete",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const stackBefore = integerEvidenceValue(evidence.stack_before);
  const stackAfter = integerEvidenceValue(evidence.stack_after);
  const edibility = signedIntegerEvidenceValue(evidence.edibility);
  const staminaBefore = finiteEvidenceValue(evidence.stamina_before);
  const staminaAfter = finiteEvidenceValue(evidence.stamina_after);
  const healthBefore = integerEvidenceValue(evidence.health_before);
  const healthAfter = integerEvidenceValue(evidence.health_after);
  return (
    slot !== null &&
    slot <= 36 &&
    hasOpaqueEvidenceValue(evidence.item) &&
    stackBefore !== null &&
    stackBefore >= 1 &&
    stackAfter !== null &&
    stackAfter === stackBefore - 1 &&
    edibility !== null &&
    (evidence.drink === "true" || evidence.drink === "false") &&
    staminaBefore !== null &&
    staminaAfter !== null &&
    healthBefore !== null &&
    healthBefore >= 0 &&
    healthAfter !== null &&
    healthAfter >= 0 &&
    evidence.animation_complete === "true"
  );
}

function hasFeedAnimalCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "tile",
    "slot",
    "native_handled",
    "trough_filled",
    "hay_before",
    "hay_after",
    "hay_consumed",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const slot = integerEvidenceValue(evidence.slot);
  const before = integerEvidenceValue(evidence.hay_before);
  const after = integerEvidenceValue(evidence.hay_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasTileEvidenceValue(evidence.tile) &&
    slot !== null &&
    slot <= 36 &&
    evidence.native_handled === "true" &&
    evidence.trough_filled === "true" &&
    before !== null &&
    before >= 1 &&
    after !== null &&
    after === before - 1 &&
    evidence.hay_consumed === "true"
  );
}

function hasCollectAnimalProductCompletionEvidence(detail: string): boolean {
  const evidence = parseSemicolonEvidence(detail);
  if (evidence === null) return false;
  const expectedKeys = [
    "location",
    "target",
    "animal",
    "tool",
    "produce",
    "produce_stack",
    "produce_cleared",
    "inventory_before",
    "inventory_after",
    "inventory_gained",
    "animation_complete",
  ];
  if (
    Object.keys(evidence).length !== expectedKeys.length ||
    !expectedKeys.every((key) => key in evidence)
  )
    return false;
  const produceStack = integerEvidenceValue(evidence.produce_stack);
  const before = integerEvidenceValue(evidence.inventory_before);
  const after = integerEvidenceValue(evidence.inventory_after);
  return (
    hasBoundedNonemptyEvidenceValue(evidence.location) &&
    hasOpaqueIdEvidenceValue(evidence.target) &&
    hasDecimalOwnerIdEvidenceValue(evidence.animal) &&
    (evidence.tool === "milk_pail" || evidence.tool === "shears") &&
    hasOpaqueEvidenceValue(evidence.produce) &&
    produceStack !== null &&
    produceStack >= 1 &&
    produceStack <= 2 &&
    evidence.produce_cleared === "true" &&
    before !== null &&
    after !== null &&
    after >= before + produceStack &&
    evidence.inventory_gained === "true" &&
    evidence.animation_complete === "true"
  );
}

function integerEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function finiteEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isNoneOrOpaqueEvidenceValue(
  value: string | undefined,
): value is string {
  return value === "none" || hasOpaqueEvidenceValue(value);
}

function signedIntegerEvidenceValue(value: string | undefined): number | null {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function hasBoundedNonemptyEvidenceValue(
  value: string | undefined,
): value is string {
  return hasOpaqueEvidenceValue(value);
}

/** `none` is an explicit producer literal only for the absent equipped tool. */
function isToolSelectionBeforeValue(
  value: string | undefined,
): value is string {
  return value === "none" || hasOpaqueEvidenceValue(value);
}

function hasTileEvidenceValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const match = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.exec(value);
  return match !== null && Number(match[1]) <= 1000 && Number(match[2]) <= 1000;
}

function hasOpaqueEvidenceValue(value: string | undefined): value is string {
  // Opaque native values may have game-specific grammar, but protocol scalar
  // sentinels are never meaningful evidence of a materialized object.
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !["none", "null", "undefined", "true", "false", "nan", "infinity"].includes(
      value.toLowerCase(),
    )
  );
}

function hasOpaqueIdEvidenceValue(value: string | undefined): value is string {
  // Preserve the stricter identity grammar, while rejecting every protocol
  // scalar/sentinel spelling already rejected for opaque non-ID evidence.
  return hasOpaqueEvidenceValue(value) && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Stardew multiplayer IDs can exceed JavaScript's safe integer range. */
function hasDecimalOwnerIdEvidenceValue(
  value: string | undefined,
): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(value);
}

function parseStardewReceipt(
  details: unknown,
): IntegrationExecutionReceipt | null {
  if (!isRecord(details) || typeof details.receiptJson !== "string")
    return null;
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
    };
  } catch {
    return null;
  }
}

function toIntegrationReceipt(
  receipt: ExecutionReceipt,
): IntegrationExecutionReceipt {
  return {
    requestId: receipt.requestId,
    executionId: receipt.executionId,
    actionId: receipt.actionId,
    state: receipt.state,
    reasonCode: receipt.reasonCode,
    revision: receipt.revision,
    evidence: receipt.evidence,
  };
}

function isKnowledgeBundle(value: unknown): value is KnowledgeBundle {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { bundleVersion?: unknown }).bundleVersion === 1
  );
}

function sameScope(
  left: Scope,
  right: Readonly<{ integrationId: string }>,
): boolean {
  return left.integrationId === right.integrationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}