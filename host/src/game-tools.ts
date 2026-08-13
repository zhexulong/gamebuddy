import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { type CompanionIntegration } from "./integration-types.js";
import { type ExecutionReceipt, type ExecutionRequest, validateExecutionRequest } from "./protocol.js";
import { searchVisibleActions, visiblePublishedActions, type ActionPolicy } from "./action-registry.js";
import type { IntegrationDispatchAdmission } from "./integration-module.js";

/** A bridge that executes only Mod-declared player-enabled capabilities. */
export interface MoveCapableIntegration extends CompanionIntegration {
  execute(request: ExecutionRequest): Promise<ExecutionReceipt>;
  cancel(requestId: string, executionId: string, reasonCode: string): Promise<ExecutionReceipt>;
}
function isMoveCapable(value: CompanionIntegration): value is MoveCapableIntegration {
  return (
    "execute" in value &&
    typeof (value as { execute?: unknown }).execute === "function" &&
    "cancel" in value &&
    typeof (value as { cancel?: unknown }).cancel === "function"
  );
}

/** Read-only tools always expose facts exactly as supplied by the Mod. */
export function createStardewObservationTools(integration: CompanionIntegration, policy?: ActionPolicy) {
  const observe = defineTool({
    name: "stardew_observe",
    label: "Observe Stardew",
    description: "Read the latest authoritative Stardew Farmhand snapshot. This never changes the game.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state;
      const available = state.connected && state.snapshot !== null;
      return {
        content: [
          {
            type: "text" as const,
            text: available ? JSON.stringify(state.snapshot) : "No authoritative Stardew snapshot is available.",
          },
        ],
        details: {
          available,
          reasonCode: available ? "available" : (state.latestReasonCode ?? "integration_not_ready"),
          snapshotJson: available ? JSON.stringify(state.snapshot) : null,
        },
      };
    },
  });
  const execution = defineTool({
    name: "stardew_execution_status",
    label: "Stardew Execution Status",
    description: "Read the latest authoritative Stardew execution receipt; accepted or running is not success.",
    parameters: Type.Object({}),
    execute: async () => {
      const receipt = integration.state.latestReceipt;
      return {
        content: [
          {
            type: "text" as const,
            text:
              receipt === null ? "No authoritative Stardew execution receipt is available." : JSON.stringify(receipt),
          },
        ],
        details: { receiptJson: receipt === null ? null : JSON.stringify(receipt) },
      };
    },
  });
  const catalog = defineTool({
    name: "stardew_interaction_catalog",
    label: "Stardew Interaction Catalog",
    description:
      "List published Stardew actions currently declared by the live Mod. Denied and unpublished actions are not represented.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state;
      const actions =
        state.connected && state.snapshot !== null
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
    name: "stardew_search_interactions",
    label: "Search Stardew Interactions",
    description:
      "Search the currently published and live Stardew interaction surface without revealing denied or unpublished actions.",
    parameters: Type.Object({ query: Type.String({ minLength: 0, maxLength: 128 }) }),
    execute: async (_toolCallId, params) => {
      const state = integration.state;
      const actions =
        state.connected && state.snapshot !== null
          ? searchVisibleActions(state.capabilities, params.query, policy).map((entry) => ({
              actionId: entry.actionId,
              familyId: entry.familyId,
              label: entry.label,
              targetKinds: entry.targetKinds,
            }))
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
export function createStardewActionTools(
  integration: CompanionIntegration,
  policy: ActionPolicy | undefined,
  admission?: IntegrationDispatchAdmission,
) {
  if (!isMoveCapable(integration) || admission === undefined) return [] as const;
  const visibleActions = new Set(visiblePublishedActions(integration.state.capabilities, policy));
  const isVisible = (actionId: string) => [...visibleActions].some((entry) => entry.actionId === actionId);
  const tools: Array<ReturnType<typeof defineTool>> = [];
  const cancel = defineTool({
    name: "stardew_cancel_active_execution",
    label: "Cancel Active Stardew Execution",
    description:
      "Request cancellation of the exact active execution. The authoritative Mod receipt determines whether it stopped.",
    parameters: Type.Object({
      requestId: Type.String({ minLength: 1, maxLength: 128 }),
      executionId: Type.String({ minLength: 1, maxLength: 128 }),
      reasonCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
    execute: async (_toolCallId, params) => {
      if (!integration.state.connected || !integration.state.capabilities.includes("cancel_active_execution"))
        return receiptResult(null, "capability_not_declared");
      try {
        return receiptResult(
          (await admission.cancelExact(
            params.requestId,
            params.executionId,
            params.reasonCode ?? "agent_requested_cancel",
          )) as ExecutionReceipt,
          null,
        );
      } catch (error) {
        return receiptResult(
          null,
          error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_cancel_failed",
        );
      }
    },
  });
  const move = defineTool({
    name: "stardew_move_to_tile",
    label: "Move Farmhand to Tile",
    description:
      "Request the player-enabled move_to_tile capability. Inspect its authoritative receipt before saying movement succeeded.",
    parameters: Type.Object({
      x: Type.Integer({ minimum: 0, maximum: 1000 }),
      y: Type.Integer({ minimum: 0, maximum: 1000 }),
      requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
    execute: async (_toolCallId, params) => {
      const snapshot = integration.state.snapshot;
      if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
      if (!integration.state.capabilities.includes("move_to_tile") || !snapshot.capabilities.includes("move_to_tile"))
        return receiptResult(null, "capability_not_declared");
      const request: ExecutionRequest = {
        requestId: params.requestId ?? randomUUID(),
        idempotencyKey: params.idempotencyKey ?? randomUUID(),
        action: "move_to_tile",
        args: { x: params.x, y: params.y },
        expectedRevision: snapshot.revision,
        deadlineMs: Date.now() + 30_000,
      };
      const invalid = validateExecutionRequest(request, snapshot);
      if (invalid !== null) return receiptResult(null, invalid);
      try {
        return receiptResult(await executeBridge(integration, admission, request), null);
      } catch (error) {
        return receiptResult(
          null,
          error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed",
        );
      }
    },
  });
  if (isVisible("move_to_tile")) tools.push(move);
  if (isVisible("travel")) {
    tools.push(
      defineTool({
        name: "stardew_travel",
        label: "Travel Through Stardew Warp",
        description:
          "Use a live native warp at the supplied source tile. The Mod resolves the destination and only a Warped postcondition can report success.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) => {
          const snapshot = integration.state.snapshot;
          if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
          if (!integration.state.capabilities.includes("travel") || !snapshot.capabilities.includes("travel"))
            return receiptResult(null, "capability_not_declared");
          const request: ExecutionRequest = {
            requestId: params.requestId ?? randomUUID(),
            idempotencyKey: params.idempotencyKey ?? randomUUID(),
            action: "travel",
            args: { x: params.x, y: params.y },
            expectedRevision: snapshot.revision,
            deadlineMs: Date.now() + 30_000,
          };
          const invalid = validateExecutionRequest(request, snapshot);
          if (invalid !== null) return receiptResult(null, invalid);
          try {
            return receiptResult(await executeBridge(integration, admission, request), null);
          } catch (error) {
            return receiptResult(
              null,
              error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed",
            );
          }
        },
      }),
    );
  }
  if (isVisible("enter_exit")) {
    tools.push(
      defineTool({
        name: "stardew_enter_exit",
        label: "Enter or Exit Stardew Location",
        description:
          "Use a live native door target. The Mod resolves the destination and only the Warped postcondition can report success.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) => {
          const snapshot = integration.state.snapshot;
          if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
          if (!integration.state.capabilities.includes("enter_exit") || !snapshot.capabilities.includes("enter_exit"))
            return receiptResult(null, "capability_not_declared");
          const request: ExecutionRequest = {
            requestId: params.requestId ?? randomUUID(),
            idempotencyKey: params.idempotencyKey ?? randomUUID(),
            action: "enter_exit",
            args: { x: params.x, y: params.y },
            expectedRevision: snapshot.revision,
            deadlineMs: Date.now() + 30_000,
          };
          const invalid = validateExecutionRequest(request, snapshot);
          if (invalid !== null) return receiptResult(null, invalid);
          try {
            return receiptResult(await executeBridge(integration, admission, request), null);
          } catch (error) {
            return receiptResult(
              null,
              error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed",
            );
          }
        },
      }),
    );
  }
  if (isVisible("till_soil")) {
    tools.push(
      defineTool({
        name: "stardew_till_soil",
        label: "Till Stardew Soil",
        description:
          "Use a live native Hoe on a soil tile. Only a Mod receipt with soil_tilled evidence reports completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) => {
          const snapshot = integration.state.snapshot;
          if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
          if (!integration.state.capabilities.includes("till_soil") || !snapshot.capabilities.includes("till_soil"))
            return receiptResult(null, "capability_not_declared");
          const request: ExecutionRequest = {
            requestId: params.requestId ?? randomUUID(),
            idempotencyKey: params.idempotencyKey ?? randomUUID(),
            action: "till_soil",
            args: { x: params.x, y: params.y },
            expectedRevision: snapshot.revision,
            deadlineMs: Date.now() + 30_000,
          };
          const invalid = validateExecutionRequest(request, snapshot);
          if (invalid !== null) return receiptResult(null, invalid);
          try {
            return receiptResult(await executeBridge(integration, admission, request), null);
          } catch (error) {
            return receiptResult(
              null,
              error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed",
            );
          }
        },
      }),
    );
  }
  if (isVisible("pickup_forage")) {
    tools.push(
      defineTool({
        name: "stardew_pickup_forage",
        label: "Pick Up Stardew Forage",
        description:
          "Pick up a live native forage target. Only the authoritative native receipt and target disappearance can report completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "pickup_forage",
            {
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("pickup_item")) {
    tools.push(
      defineTool({
        name: "stardew_pickup_item",
        label: "Pick Up Stardew Item Drop",
        description:
          "Approach a live native Debris target. Only the native magnetic-collection receipt and exact inventory evidence can report completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "pickup_item",
            {
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("refill_watering_can")) {
    tools.push(
      defineTool({
        name: "stardew_refill_watering_can",
        label: "Refill Stardew Watering Can",
        description: "Refill one selected, partially filled Watering Can from a live adjacent native water source.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "refill_watering_can",
            { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("water_crop")) {
    tools.push(
      defineTool({
        name: "stardew_water_crop",
        label: "Water Stardew Crop",
        description: "Water a live unwatered crop target. Only the authoritative native receipt can report completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "water_crop",
            { x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("plant_seed")) {
    tools.push(
      defineTool({
        name: "stardew_plant_seed",
        label: "Plant Stardew Seed",
        description:
          "Plant a live ordinary seed into a live empty ground HoeDirt target. Native crop creation and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "plant_seed",
            {
              slot: params.slot,
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("place_wood_fence")) {
    tools.push(
      defineTool({
        name: "stardew_place_wood_fence",
        label: "Place Stardew Wood Fence",
        description:
          "Place only a qualified (O)322 Wood Fence on a fresh empty Farm tile; native Fence evidence determines completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)322"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "place_wood_fence",
            {
              slot: params.slot,
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("place_crab_pot")) {
    tools.push(
      defineTool({
        name: "stardew_place_crab_pot",
        label: "Place Stardew Crab Pot",
        description:
          "Place only a qualified (O)710 Crab Pot on a fresh valid Farm water tile; native Crab Pot evidence determines completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)710"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "place_crab_pot",
            {
              slot: params.slot,
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("bait_crab_pot")) {
    tools.push(
      defineTool({
        name: "stardew_bait_crab_pot",
        label: "Bait Stardew Crab Pot",
        description:
          "Attach exactly one live owned (O)685 Bait to a fresh adjacent unbaited current-player-owned (O)710 Crab Pot. The native interaction and authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)685"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "bait_crab_pot",
            {
              slot: params.slot,
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("fertilize_tile")) {
    tools.push(
      defineTool({
        name: "stardew_fertilize_tile",
        label: "Fertilize Stardew Soil",
        description:
          "Apply one live owned fertilizer item to a live eligible ground HoeDirt target. Native placement and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "fertilize_tile",
            {
              slot: params.slot,
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("machine_inspect")) {
    tools.push(
      defineTool({
        name: "stardew_machine_inspect",
        label: "Inspect Stardew Machine",
        description: "Read a live native machine state without opening a menu or changing the machine.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "machine_inspect",
            { x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("machine_load")) {
    tools.push(
      defineTool({
        name: "stardew_machine_load",
        label: "Load Coffee Beans into Keg",
        description:
          "Load exactly five Coffee Beans into a live idle Keg through the normal native machine interaction. A receipt proves native input consumption and Coffee processing start.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)433"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "machine_load",
            {
              slot: params.slot,
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("machine_collect_output")) {
    tools.push(
      defineTool({
        name: "stardew_machine_collect_output",
        label: "Collect Coffee from Keg",
        description:
          "Collect ready Coffee from the exact live Keg through the normal native machine interaction. A receipt proves native inventory delivery and cleared ready output.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "machine_collect_output",
            { x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("collect_animal_product")) {
    tools.push(
      defineTool({
        name: "stardew_collect_animal_product",
        label: "Collect Stardew Animal Product",
        description:
          "Use the live compatible Farmhand-owned tool on a live ready animal-product target. Native animation and receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "collect_animal_product",
            { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("feed_animal")) {
    tools.push(
      defineTool({
        name: "stardew_feed_animal",
        label: "Place Hay in Stardew Trough",
        description:
          "Place one live owned Hay item in a live empty AnimalHouse trough. This does not claim an animal has eaten.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "feed_animal",
            { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("use_item")) {
    tools.push(
      defineTool({
        name: "stardew_use_item",
        label: "Use Stardew Food Item",
        description:
          "Use a live ordinary edible Farmhand inventory item. Native eating animation and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "use_item",
            { slot: params.slot, expectedQualifiedItemId: params.expectedQualifiedItemId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("harvest_crop")) {
    tools.push(
      defineTool({
        name: "stardew_harvest_crop",
        label: "Harvest Stardew Crop",
        description:
          "Harvest a live ready ordinary crop. Only the native harvest receipt and inventory/regrow postcondition determine completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "harvest_crop",
            {
              x: params.x,
              y: params.y,
              expectedQualifiedItemId: params.expectedQualifiedItemId,
              expectedTargetId: params.expectedTargetId,
            },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("chop_tree_source")) {
    tools.push(
      defineTool({
        name: "stardew_chop_tree_source",
        label: "Chop Stardew Tree Source",
        description:
          "Use one equipped Axe terminal strike on a live ordinary mature one-hit tree source. Only source transformation in the authoritative receipt determines completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "chop_tree_source",
            { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("dig_artifact_spot")) {
    tools.push(
      defineTool({
        name: "stardew_dig_artifact_spot",
        label: "Dig Stardew Artifact Spot",
        description:
          "Use one equipped Basic Hoe on a live adjacent (O)590 artifact spot. Source removal and native HoeDirt creation are required; rewards are excluded.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "dig_artifact_spot",
            { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("clear_hoedirt")) {
    tools.push(
      defineTool({
        name: "stardew_clear_hoedirt",
        label: "Clear Stardew HoeDirt",
        description:
          "Use one equipped Basic Pickaxe hit on live adjacent empty ground HoeDirt. Crops, IndoorPots, drops, and pickup are excluded.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "clear_hoedirt",
            { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("break_rock_source")) {
    tools.push(
      defineTool({
        name: "stardew_break_rock_source",
        label: "Break Stardew Rock Source",
        description:
          "Use one equipped basic Pickaxe hit on a live one-hit ordinary stone source. Drops and pickup are separate actions.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) =>
          executeAction(
            integration,
            admission,
            "break_rock_source",
            { slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
            params.requestId,
            params.idempotencyKey,
          ),
      }),
    );
  }
  if (isVisible("equip_tool")) {
    tools.push(
      defineTool({
        name: "stardew_equip_tool",
        label: "Equip Stardew Tool",
        description:
          "Select a Tool already owned by the AI Farmhand. The Mod receipt reports the authoritative before/after CurrentTool state.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        execute: async (_toolCallId, params) => {
          const snapshot = integration.state.snapshot;
          if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
          if (!integration.state.capabilities.includes("equip_tool") || !snapshot.capabilities.includes("equip_tool"))
            return receiptResult(null, "capability_not_declared");
          const request: ExecutionRequest = {
            requestId: params.requestId ?? randomUUID(),
            idempotencyKey: params.idempotencyKey ?? randomUUID(),
            action: "equip_tool",
            args: { slot: params.slot },
            expectedRevision: snapshot.revision,
            deadlineMs: Date.now() + 30_000,
          };
          const invalid = validateExecutionRequest(request, snapshot);
          if (invalid !== null) return receiptResult(null, invalid);
          try {
            return receiptResult(await executeBridge(integration, admission, request), null);
          } catch (error) {
            return receiptResult(
              null,
              error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed",
            );
          }
        },
      }),
    );
  }
  if (integration.state.capabilities.includes("cancel_active_execution")) tools.push(cancel);
  return tools;
}
async function executeAction(
  integration: MoveCapableIntegration,
  admission: IntegrationDispatchAdmission,
  action: ExecutionRequest["action"],
  args: Record<string, unknown>,
  requestId?: string,
  idempotencyKey?: string,
) {
  const snapshot = integration.state.snapshot;
  if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
  if (!integration.state.capabilities.includes(action) || !snapshot.capabilities.includes(action))
    return receiptResult(null, "capability_not_declared");
  const request: ExecutionRequest = {
    requestId: requestId ?? randomUUID(),
    idempotencyKey: idempotencyKey ?? randomUUID(),
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  };
  const invalid = validateExecutionRequest(request, snapshot);
  if (invalid !== null) return receiptResult(null, invalid);
  try {
    return receiptResult(await executeBridge(integration, admission, request), null);
  } catch (error) {
    return receiptResult(
      null,
      error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed",
    );
  }
}
async function executeBridge(
  integration: MoveCapableIntegration,
  admission: IntegrationDispatchAdmission,
  request: ExecutionRequest,
): Promise<ExecutionReceipt> {
  const dispatch = { ...admission.owner, requestId: request.requestId };
  admission.observer.beforeWrite(dispatch);
  try {
    const receipt = await integration.execute(request);
    admission.observer.bindReceipt(receipt);
    return receipt;
  } catch (error) {
    admission.observer.markUncertain(dispatch);
    throw error;
  }
}

function receiptResult(receipt: ExecutionReceipt | null, reasonCode: string | null) {
  return {
    content: [
      {
        type: "text" as const,
        text: receipt === null ? `Game action was not created: ${reasonCode}.` : JSON.stringify(receipt),
      },
    ],
    details: { receiptJson: receipt === null ? null : JSON.stringify(receipt), reasonCode },
  };
}
