import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { type CompanionIntegration } from "./integration-types.js";
import { type ExecutionReceipt, type ExecutionRequest, validateExecutionRequest } from "./protocol.js";
import { searchVisibleActions, visiblePublishedActions, type ActionPolicy } from "./action-registry.js";

/** A bridge that executes only Mod-declared player-enabled capabilities. */
export interface MoveCapableIntegration extends CompanionIntegration {
  execute(request: ExecutionRequest): Promise<ExecutionReceipt>;
  cancel(requestId: string, executionId: string, reasonCode: string): Promise<ExecutionReceipt>;
}
function isMoveCapable(value: CompanionIntegration): value is MoveCapableIntegration {
  return "execute" in value && typeof (value as { execute?: unknown }).execute === "function"
    && "cancel" in value && typeof (value as { cancel?: unknown }).cancel === "function";
}

/** Read-only tools always expose facts exactly as supplied by the Mod. */
export function createStardewObservationTools(integration: CompanionIntegration, policy?: ActionPolicy) {
  const observe = defineTool({
    name: "stardew_observe", label: "Observe Stardew",
    description: "Read the latest authoritative Stardew Farmhand snapshot. This never changes the game.", parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state; const available = state.connected && state.snapshot !== null;
      return { content: [{ type: "text" as const, text: available ? JSON.stringify(state.snapshot) : "No authoritative Stardew snapshot is available." }], details: { available, reasonCode: available ? "available" : state.latestReasonCode ?? "integration_not_ready", snapshotJson: available ? JSON.stringify(state.snapshot) : null } };
    },
  });
  const execution = defineTool({
    name: "stardew_execution_status", label: "Stardew Execution Status",
    description: "Read the latest authoritative Stardew execution receipt; accepted or running is not success.", parameters: Type.Object({}),
    execute: async () => {
      const receipt = integration.state.latestReceipt;
      return { content: [{ type: "text" as const, text: receipt === null ? "No authoritative Stardew execution receipt is available." : JSON.stringify(receipt) }], details: { receiptJson: receipt === null ? null : JSON.stringify(receipt) } };
    },
  });
  const catalog = defineTool({
    name: "stardew_interaction_catalog", label: "Stardew Interaction Catalog",
    description: "List published Stardew actions currently declared by the live Mod. Denied and unpublished actions are not represented.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state;
      const actions = state.connected && state.snapshot !== null
        ? visiblePublishedActions(state.capabilities, policy).map((entry) => ({
          actionId: entry.actionId,
          familyId: entry.familyId,
          label: entry.label,
          description: entry.description,
          targetKinds: entry.targetKinds,
          availableNow: state.snapshot?.capabilities.includes(entry.requiredCapability) === true,
          snapshotRevision: state.snapshot?.revision ?? null,
          location: state.snapshot?.location ?? null,
        }))
        : [];
      return { content: [{ type: "text" as const, text: JSON.stringify(actions) }], details: { actions } };
    },
  });
  const search = defineTool({
    name: "stardew_search_interactions", label: "Search Stardew Interactions",
    description: "Search the currently published and live Stardew interaction surface without revealing denied or unpublished actions.",
    parameters: Type.Object({ query: Type.String({ minLength: 0, maxLength: 128 }) }),
    execute: async (_toolCallId, params) => {
      const state = integration.state;
      const actions = state.connected && state.snapshot !== null
        ? searchVisibleActions(state.capabilities, params.query, policy).map((entry) => ({ actionId: entry.actionId, familyId: entry.familyId, label: entry.label, targetKinds: entry.targetKinds }))
        : [];
      return { content: [{ type: "text" as const, text: JSON.stringify(actions) }], details: { actions } };
    },
  });
  return [observe, execution, catalog, search] as const;
}

/**
 * Mount Game Actions only when the Mod's live snapshot declares the player-
 * configured capability. The Host never mints per-turn permission or treats
 * model prose as an authorization source.
 */
export function createStardewActionTools(integration: CompanionIntegration, policy?: ActionPolicy) {
  if (!isMoveCapable(integration)) return [] as const;
  const visibleActions = new Set(visiblePublishedActions(integration.state.capabilities, policy));
  const isVisible = (actionId: string) => [...visibleActions].some((entry) => entry.actionId === actionId);
  const tools: Array<ReturnType<typeof defineTool>> = [];
  const cancel = defineTool({
    name: "stardew_cancel_active_execution", label: "Cancel Active Stardew Execution",
    description: "Request cancellation of the exact active execution. The authoritative Mod receipt determines whether it stopped.",
    parameters: Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 128 }), executionId: Type.String({ minLength: 1, maxLength: 128 }), reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
    execute: async (_toolCallId, params) => {
      if (!integration.state.connected || !integration.state.capabilities.includes("cancel_active_execution")) return receiptResult(null, "capability_not_declared");
      try { return receiptResult(await integration.cancel(params.requestId, params.executionId, params.reasonCode ?? "agent_requested_cancel"), null); }
      catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_cancel_failed"); }
    },
  });
  const move = defineTool({
    name: "stardew_move_to_tile", label: "Move Farmhand to Tile",
    description: "Request the player-enabled move_to_tile capability. Inspect its authoritative receipt before saying movement succeeded.",
    parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
    execute: async (_toolCallId, params) => {
      const snapshot = integration.state.snapshot;
      if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
      if (!integration.state.capabilities.includes("move_to_tile") || !snapshot.capabilities.includes("move_to_tile")) return receiptResult(null, "capability_not_declared");
      const request: ExecutionRequest = { requestId: params.requestId ?? randomUUID(), idempotencyKey: params.idempotencyKey ?? randomUUID(), action: "move_to_tile", args: { x: params.x, y: params.y }, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 };
      const invalid = validateExecutionRequest(request, snapshot);
      if (invalid !== null) return receiptResult(null, invalid);
      try { return receiptResult(await integration.execute(request), null); }
      catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed"); }
    },
  });
  if (isVisible("move_to_tile")) tools.push(move);
  if (isVisible("travel")) {
    tools.push(defineTool({
      name: "stardew_travel", label: "Travel Through Stardew Warp",
      description: "Use a live native warp at the supplied source tile. The Mod resolves the destination and only a Warped postcondition can report success.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => {
        const snapshot = integration.state.snapshot;
        if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
        if (!integration.state.capabilities.includes("travel") || !snapshot.capabilities.includes("travel")) return receiptResult(null, "capability_not_declared");
        const request: ExecutionRequest = { requestId: params.requestId ?? randomUUID(), idempotencyKey: params.idempotencyKey ?? randomUUID(), action: "travel", args: { x: params.x, y: params.y }, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 };
        const invalid = validateExecutionRequest(request, snapshot);
        if (invalid !== null) return receiptResult(null, invalid);
        try { return receiptResult(await integration.execute(request), null); }
        catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed"); }
      },
    }));
  }
  if (isVisible("enter_exit")) {
    tools.push(defineTool({
      name: "stardew_enter_exit", label: "Enter or Exit Stardew Location",
      description: "Use a live native door target. The Mod resolves the destination and only the Warped postcondition can report success.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => {
        const snapshot = integration.state.snapshot;
        if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
        if (!integration.state.capabilities.includes("enter_exit") || !snapshot.capabilities.includes("enter_exit")) return receiptResult(null, "capability_not_declared");
        const request: ExecutionRequest = { requestId: params.requestId ?? randomUUID(), idempotencyKey: params.idempotencyKey ?? randomUUID(), action: "enter_exit", args: { x: params.x, y: params.y }, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 };
        const invalid = validateExecutionRequest(request, snapshot);
        if (invalid !== null) return receiptResult(null, invalid);
        try { return receiptResult(await integration.execute(request), null); }
        catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed"); }
      },
    }));
  }
  if (isVisible("till_soil")) {
    tools.push(defineTool({
      name: "stardew_till_soil", label: "Till Stardew Soil",
      description: "Use a live native Hoe on a soil tile. Only a Mod receipt with soil_tilled evidence reports completion.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => {
        const snapshot = integration.state.snapshot;
        if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
        if (!integration.state.capabilities.includes("till_soil") || !snapshot.capabilities.includes("till_soil")) return receiptResult(null, "capability_not_declared");
        const request: ExecutionRequest = { requestId: params.requestId ?? randomUUID(), idempotencyKey: params.idempotencyKey ?? randomUUID(), action: "till_soil", args: { x: params.x, y: params.y }, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 };
        const invalid = validateExecutionRequest(request, snapshot);
        if (invalid !== null) return receiptResult(null, invalid);
        try { return receiptResult(await integration.execute(request), null); }
        catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed"); }
      },
    }));
  }
  if (isVisible("pickup_forage")) {
    tools.push(defineTool({
      name: "stardew_pickup_forage", label: "Pick Up Stardew Forage",
      description: "Pick up a live native forage target. Only the authoritative native receipt and target disappearance can report completion.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "pickup_forage", { x: params.x, y: params.y, expectedQualifiedItemId: params.expectedQualifiedItemId, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("pickup_item")) {
    tools.push(defineTool({
      name: "stardew_pickup_item", label: "Pick Up Stardew Item Drop",
      description: "Approach a live native Debris target. Only the native magnetic-collection receipt and exact inventory evidence can report completion.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "pickup_item", { x: params.x, y: params.y, expectedQualifiedItemId: params.expectedQualifiedItemId, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("water_crop")) {
    tools.push(defineTool({
      name: "stardew_water_crop", label: "Water Stardew Crop",
      description: "Water a live unwatered crop target. Only the authoritative native receipt can report completion.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "water_crop", { x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("plant_seed")) {
    tools.push(defineTool({
      name: "stardew_plant_seed", label: "Plant Stardew Seed",
      description: "Plant a live ordinary seed into a live empty ground HoeDirt target. Native crop creation and the authoritative receipt determine completion.",
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "plant_seed", { slot: params.slot, x: params.x, y: params.y, expectedQualifiedItemId: params.expectedQualifiedItemId, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("fertilize_tile")) {
    tools.push(defineTool({
      name: "stardew_fertilize_tile", label: "Fertilize Stardew Soil",
      description: "Apply one live owned fertilizer item to a live eligible ground HoeDirt target. Native placement and the authoritative receipt determine completion.",
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "fertilize_tile", { slot: params.slot, x: params.x, y: params.y, expectedQualifiedItemId: params.expectedQualifiedItemId, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("machine_inspect")) {
    tools.push(defineTool({
      name: "stardew_machine_inspect", label: "Inspect Stardew Machine",
      description: "Read a live native machine state without opening a menu or changing the machine.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "machine_inspect", { x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("collect_animal_product")) {
    tools.push(defineTool({
      name: "stardew_collect_animal_product", label: "Collect Stardew Animal Product",
      description: "Use the live compatible Farmhand-owned tool on a live ready animal-product target. Native animation and receipt determine completion.",
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "collect_animal_product", { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("feed_animal")) {
    tools.push(defineTool({
      name: "stardew_feed_animal", label: "Place Hay in Stardew Trough",
      description: "Place one live owned Hay item in a live empty AnimalHouse trough. This does not claim an animal has eaten.",
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "feed_animal", { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("use_item")) {
    tools.push(defineTool({
      name: "stardew_use_item", label: "Use Stardew Food Item",
      description: "Use a live ordinary edible Farmhand inventory item. Native eating animation and the authoritative receipt determine completion.",
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "use_item", { slot: params.slot, expectedQualifiedItemId: params.expectedQualifiedItemId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("harvest_crop")) {
    tools.push(defineTool({
      name: "stardew_harvest_crop", label: "Harvest Stardew Crop",
      description: "Harvest a live ready ordinary crop. Only the native harvest receipt and inventory/regrow postcondition determine completion.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => executeAction(integration, "harvest_crop", { x: params.x, y: params.y, expectedQualifiedItemId: params.expectedQualifiedItemId, expectedTargetId: params.expectedTargetId }, params.requestId, params.idempotencyKey),
    }));
  }
  if (isVisible("equip_tool")) {
    tools.push(defineTool({
      name: "stardew_equip_tool", label: "Equip Stardew Tool",
      description: "Select a Tool already owned by the AI Farmhand. The Mod receipt reports the authoritative before/after CurrentTool state.",
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      execute: async (_toolCallId, params) => {
        const snapshot = integration.state.snapshot;
        if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
        if (!integration.state.capabilities.includes("equip_tool") || !snapshot.capabilities.includes("equip_tool")) return receiptResult(null, "capability_not_declared");
        const request: ExecutionRequest = { requestId: params.requestId ?? randomUUID(), idempotencyKey: params.idempotencyKey ?? randomUUID(), action: "equip_tool", args: { slot: params.slot }, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 };
        const invalid = validateExecutionRequest(request, snapshot);
        if (invalid !== null) return receiptResult(null, invalid);
        try { return receiptResult(await integration.execute(request), null); }
        catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed"); }
      },
    }));
  }
  if (integration.state.capabilities.includes("cancel_active_execution")) tools.push(cancel);
  return tools;
}
async function executeAction(integration: MoveCapableIntegration, action: ExecutionRequest["action"], args: Record<string, unknown>, requestId?: string, idempotencyKey?: string) {
  const snapshot = integration.state.snapshot;
  if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
  if (!integration.state.capabilities.includes(action) || !snapshot.capabilities.includes(action)) return receiptResult(null, "capability_not_declared");
  const request: ExecutionRequest = { requestId: requestId ?? randomUUID(), idempotencyKey: idempotencyKey ?? randomUUID(), action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 };
  const invalid = validateExecutionRequest(request, snapshot);
  if (invalid !== null) return receiptResult(null, invalid);
  try { return receiptResult(await integration.execute(request), null); }
  catch (error) { return receiptResult(null, error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed"); }
}
function receiptResult(receipt: ExecutionReceipt | null, reasonCode: string | null) {
  return { content: [{ type: "text" as const, text: receipt === null ? `Game action was not created: ${reasonCode}.` : JSON.stringify(receipt) }], details: { receiptJson: receipt === null ? null : JSON.stringify(receipt), reasonCode } };
}
