import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, type TObject, Type } from "typebox";
import {
  type ActionPolicy,
  STARDEW_ACTION_TOOL_NAMES,
  type StardewActionId,
  searchActionsFromModCatalog,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import type { IntegrationDispatchAdmission } from "./game-integration-adapter.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import {
  type ActionRegistration,
  type ExecutionReceipt,
  type ExecutionRequest,
  validateExecutionRequest,
} from "./protocol.js";

type IntegrationDispatchAdmissionFactory = () => IntegrationDispatchAdmission;

/** A bridge that executes only Mod-declared player-enabled capabilities. */
export interface MoveCapableIntegration extends StardewBridgeConnection {
  execute(request: ExecutionRequest): Promise<ExecutionReceipt>;
  cancel(
    requestId: string,
    executionId: string,
    reasonCode: string,
  ): Promise<ExecutionReceipt>;
}
function isMoveCapable(
  value: StardewBridgeConnection,
): value is MoveCapableIntegration {
  return (
    "execute" in value &&
    typeof (value as { execute?: unknown }).execute === "function" &&
    "cancel" in value &&
    typeof (value as { cancel?: unknown }).cancel === "function"
  );
}

/** One published primitive action bound to its preserved concrete typed tool schema. */
type GameActionToolDefinition<TSchema extends TObject> = Readonly<{
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  action: StardewActionId;
  toArgs: (params: any) => Readonly<Record<string, unknown>>;
}>;

/**
 * Shared typed wrapper factory (Wave 1 lane A). Every materialized action tool
 * closure contributes only its action literal plus typed args; the shared
 * wrapper constructs request IDs, binds the current snapshot revision, sets the
 * deadline, rechecks connection/current capability/current restrictive policy,
 * validates the request, and acquires a fresh dispatch admission immediately
 * before the bridge write. The factory is module-private: there is no generic
 * public action/payload API.
 */
function gameActionToolFactory(
  integration: MoveCapableIntegration,
  policy: ActionPolicy | undefined,
  dispatchAdmissionFactory: IntegrationDispatchAdmissionFactory,
) {
  return function createGameActionTool<TSchema extends TObject>(
    definition: GameActionToolDefinition<TSchema>,
  ): ReturnType<typeof defineTool> {
    return defineTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (_toolCallId, params) =>
        executeGameAction(
          integration,
          policy,
          dispatchAdmissionFactory,
          definition.action,
          definition.toArgs(params as Static<TSchema>),
          callerRequestIds(params),
        ),
    });
  };
}

/** Caller-supplied identity fields read from the preserved concrete tool schema. */
function callerRequestIds(
  params: unknown,
): Readonly<{ requestId?: string; idempotencyKey?: string }> {
  if (typeof params !== "object" || params === null) return {};
  const record = params as Readonly<Record<string, unknown>>;
  return {
    requestId:
      typeof record.requestId === "string" && record.requestId.length > 0
        ? record.requestId
        : undefined,
    idempotencyKey:
      typeof record.idempotencyKey === "string" &&
      record.idempotencyKey.length > 0
        ? record.idempotencyKey
        : undefined,
  };
}

type NavigationActionId = "inspect_world_map" | "find_destination";
type NavigationReadIntegration = StardewBridgeConnection & {
  navigationRead(request: Readonly<{
    operation: NavigationActionId;
    args: Readonly<Record<string, unknown>>;
  }>): Promise<unknown>;
};

/** Read-only tools always expose facts exactly as supplied by the Mod. */
export function createStardewObservationTools(
  integration: StardewBridgeConnection & Partial<NavigationReadIntegration>,
  policy?: ActionPolicy,
) {
  const observe = defineTool({
    name: "stardew_observe",
    label: "Observe Stardew",
    description:
      "Read the latest authoritative Stardew Farmhand snapshot. This never changes the game.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state;
      const available = state.connected && state.snapshot !== null;
      return {
        content: [
          {
            type: "text" as const,
            text: available
              ? JSON.stringify(state.snapshot)
              : "No authoritative Stardew snapshot is available.",
          },
        ],
        details: {
          available,
          reasonCode: available
            ? "available"
            : (state.latestReasonCode ?? "integration_not_ready"),
          snapshotJson: available ? JSON.stringify(state.snapshot) : null,
        },
      };
    },
  });
  const execution = defineTool({
    name: "stardew_execution_status",
    label: "Stardew Execution Status",
    description:
      "Read the latest authoritative Stardew execution receipt; accepted or running is not success.",
    parameters: Type.Object({}),
    execute: async () => {
      const receipt = integration.state.latestReceipt;
      return {
        content: [
          {
            type: "text" as const,
            text:
              receipt === null
                ? "No authoritative Stardew execution receipt is available."
                : JSON.stringify(receipt),
          },
        ],
        details: {
          receiptJson: receipt === null ? null : JSON.stringify(receipt),
        },
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
      const modRegistrations = state.catalogRegistrations ?? [];
      const currentCapabilities =
        state.connected && state.snapshot !== null
          ? state.capabilities.filter((capability) =>
              state.snapshot!.capabilities.includes(capability),
            )
          : [];
      const actions = visibleActionsFromModCatalog(
        modRegistrations,
        currentCapabilities,
        policy,
      ).map((entry) => ({
        actionId: entry.actionId,
        familyId: entry.familyId,
        label: entry.label,
        description: entry.description,
        targetKinds: entry.targetKinds,
        availableNow: true,
        snapshotRevision: state.snapshot?.revision ?? null,
        location: state.snapshot?.location ?? null,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(actions) }],
        details: { actions },
      };
    },
  });
  const search = defineTool({
    name: "stardew_search_interactions",
    label: "Search Stardew Interactions",
    description:
      "Search the currently published and live Stardew interaction surface without revealing denied or unpublished actions.",
    parameters: Type.Object({
      query: Type.String({ minLength: 0, maxLength: 128 }),
    }),
    execute: async (_toolCallId, params) => {
      const state = integration.state;
      const modRegistrations = state.catalogRegistrations ?? [];
      const currentCapabilities =
        state.connected && state.snapshot !== null
          ? state.capabilities.filter((capability) =>
              state.snapshot!.capabilities.includes(capability),
            )
          : [];
      const actions = searchActionsFromModCatalog(
        modRegistrations,
        currentCapabilities,
        params.query,
        policy,
      ).map((entry) => ({
        actionId: entry.actionId,
        familyId: entry.familyId,
        label: entry.label,
        targetKinds: entry.targetKinds,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(actions) }],
        details: { actions },
      };
    },
  });

  const navigationCapabilityReady = (actionId: NavigationActionId): boolean => {
    const state = integration.state as typeof integration.state & {
      catalogRevision?: number;
    };
    const snapshot = state.snapshot;
    const deniedActions = new Set(policy?.deniedActions ?? []);
    const deniedFamilies = new Set(policy?.deniedFamilies ?? []);
    return (
      state.connected &&
      snapshot !== null &&
      typeof (integration as { navigationRead?: unknown }).navigationRead ===
        "function" &&
      state.catalogRevision === snapshot.catalogRevision &&
      state.capabilities.includes(actionId) &&
      snapshot.capabilities.includes(actionId) &&
      !deniedActions.has(actionId) &&
      !deniedFamilies.has("world_navigation") &&
      (state.catalogRegistrations ?? []).some(
        (registration) =>
          registration.actionId === actionId &&
          registration.familyId === "world_navigation" &&
          registration.lifecycle === "published" &&
          registration.kind === "read_only" &&
          registration.identityVersion === 1,
      )
    );
  };
  const requireStrictObject = (
    params: unknown,
  ): Readonly<Record<string, unknown>> => {
    if (typeof params !== "object" || params === null || Array.isArray(params))
      throw new Error("invalid_tool_parameters");
    return params as Readonly<Record<string, unknown>>;
  };
  const navigationResult = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: { result },
  });

  const tools: Array<ReturnType<typeof defineTool>> = [
    observe,
    execution,
    catalog,
    search,
  ];
  if (navigationCapabilityReady("inspect_world_map")) {
    tools.push(
      defineTool({
        name: "stardew_inspect_world_map",
        label: "Inspect Stardew World Map",
        description:
          "Read the authoritative Stardew navigation map without changing the game.",
        parameters: Type.Object(
          {
            nodeRef: Type.Optional(
              Type.String({ minLength: 1, maxLength: 128 }),
            ),
            cursor: Type.Optional(
              Type.String({ minLength: 1, maxLength: 128 }),
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (_toolCallId, params) => {
          const args = requireStrictObject(params);
          const keys = Object.keys(args);
          if (
            keys.length > 1 ||
            keys.some((key) => key !== "nodeRef" && key !== "cursor") ||
            (keys.length === 1 &&
              (typeof args[keys[0]!] !== "string" ||
                (args[keys[0]!] as string).length < 1 ||
                (args[keys[0]!] as string).length > 128))
          )
            throw new Error("invalid_tool_parameters");
          if (!navigationCapabilityReady("inspect_world_map"))
            throw new Error("bridge_capability_not_ready");
          return navigationResult(
            await (integration as NavigationReadIntegration).navigationRead({
              operation: "inspect_world_map",
              args:
                keys.length === 0
                  ? {}
                  : { [keys[0]!]: args[keys[0]!] },
            }),
          );
        },
      }),
    );
  }
  if (navigationCapabilityReady("find_destination")) {
    tools.push(
      defineTool({
        name: "stardew_find_destination",
        label: "Find Stardew Destination",
        description:
          "Resolve a destination query from the authoritative Stardew world map without choosing or changing a destination.",
        parameters: Type.Object(
          { query: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
        execute: async (_toolCallId, params) => {
          const args = requireStrictObject(params);
          const keys = Object.keys(args);
          if (
            keys.length !== 1 ||
            keys[0] !== "query" ||
            typeof args.query !== "string" ||
            args.query.length < 1 ||
            args.query.length > 128
          )
            throw new Error("invalid_tool_parameters");
          if (!navigationCapabilityReady("find_destination"))
            throw new Error("bridge_capability_not_ready");
          return navigationResult(
            await (integration as NavigationReadIntegration).navigationRead({
              operation: "find_destination",
              args: { query: args.query },
            }),
          );
        },
      }),
    );
  }
  return tools;
}

/**
 * Mount Game Actions only when the Mod's live snapshot declares the player-
 * configured capability. The Host never mints per-turn permission or treats
 * model prose as an authorization source.
 */
export function createStardewActionTools(
  integration: StardewBridgeConnection,
  policy: ActionPolicy | undefined,
  dispatchAdmissionFactory?: IntegrationDispatchAdmissionFactory,
) {
  if (!isMoveCapable(integration) || dispatchAdmissionFactory === undefined)
    return [] as const;
  const state = integration.state;
  if (!state.connected || state.snapshot === null) return [] as const;
  const currentCapabilities = state.capabilities.filter((capability) =>
    state.snapshot!.capabilities.includes(capability),
  );
  const modRegistrations = state.catalogRegistrations ?? [];
  const visibleActionIds = new Set(
    visibleActionsFromModCatalog(
      modRegistrations,
      currentCapabilities,
      policy,
    ).map((entry) => entry.actionId),
  );
  const isVisible = (actionId: StardewActionId) =>
    visibleActionIds.has(actionId);
  const tools: Array<ReturnType<typeof defineTool>> = [];
  const makeGameActionTool = gameActionToolFactory(
    integration,
    policy,
    dispatchAdmissionFactory,
  );
  if (isVisible("navigate_to_destination")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.navigate_to_destination,
        label: "Navigate Farmhand to Destination",
        description:
          "Navigate to exactly one destination selected by a label or canonical destination reference. Only the authoritative Mod receipt can report completion.",
        parameters: Type.Object(
          {
            destination: Type.Union([
              Type.Object(
                {
                  kind: Type.Literal("label"),
                  label: Type.String({ minLength: 1, maxLength: 128 }),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  kind: Type.Literal("ref"),
                  ref: Type.String({ pattern: "^dr1_[A-Za-z0-9_-]{21}[AQgw]$" }),
                },
                { additionalProperties: false },
              ),
            ]),
            requestId: Type.Optional(
              Type.String({ minLength: 1, maxLength: 128 }),
            ),
            idempotencyKey: Type.Optional(
              Type.String({ minLength: 1, maxLength: 128 }),
            ),
          },
          { additionalProperties: false },
        ),
        action: "navigate_to_destination",
        toArgs: (params) => ({ destination: params.destination }),
      }),
    );
  }
  if (isVisible("move_to_tile")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.move_to_tile,
        label: "Move Farmhand to Tile",
        description:
          "Request the player-enabled move_to_tile capability. Inspect its authoritative receipt before saying movement succeeded.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "move_to_tile",
        toArgs: (params) => ({ x: params.x, y: params.y }),
      }),
    );
  }
  if (isVisible("travel")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.travel,
        label: "Travel Through Stardew Warp",
        description:
          "Use a live native warp at the supplied source tile. The Mod resolves the destination and only a Warped postcondition can report success.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "travel",
        toArgs: (params) => ({ x: params.x, y: params.y }),
      }),
    );
  }
  if (isVisible("enter_exit")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.enter_exit,
        label: "Enter or Exit Stardew Location",
        description:
          "Use a live native door target. The Mod resolves the destination and only the Warped postcondition can report success.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "enter_exit",
        toArgs: (params) => ({ x: params.x, y: params.y }),
      }),
    );
  }
  if (isVisible("till_soil")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.till_soil,
        label: "Till Stardew Soil",
        description:
          "Use a live native Hoe on a soil tile. Only a Mod receipt with soil_tilled evidence reports completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "till_soil",
        toArgs: (params) => ({ x: params.x, y: params.y }),
      }),
    );
  }
  if (isVisible("pickup_forage")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.pickup_forage,
        label: "Pick Up Stardew Forage",
        description:
          "Pick up a live native forage target. Only the authoritative native receipt and target disappearance can report completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({
            minLength: 1,
            maxLength: 128,
          }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "pickup_forage",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("pickup_item")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.pickup_item,
        label: "Pick Up Stardew Item Drop",
        description:
          "Approach a live native Debris target. Only the native magnetic-collection receipt and exact inventory evidence can report completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({
            minLength: 1,
            maxLength: 128,
          }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "pickup_item",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("refill_watering_can")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.refill_watering_can,
        label: "Refill Stardew Watering Can",
        description:
          "Refill one selected, partially filled Watering Can from a live adjacent native water source.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "refill_watering_can",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("water_crop")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.water_crop,
        label: "Water Stardew Crop",
        description:
          "Water a live unwatered crop target. Only the authoritative native receipt can report completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "water_crop",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("plant_seed")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.plant_seed,
        label: "Plant Stardew Seed",
        description:
          "Plant a live ordinary seed into a live empty ground HoeDirt target. Native crop creation and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({
            minLength: 1,
            maxLength: 128,
          }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "plant_seed",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("place_wood_fence")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.place_wood_fence,
        label: "Place Stardew Wood Fence",
        description:
          "Place only a qualified (O)322 Wood Fence on a fresh empty Farm tile; native Fence evidence determines completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)322"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "place_wood_fence",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("place_crab_pot")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.place_crab_pot,
        label: "Place Stardew Crab Pot",
        description:
          "Place only a qualified (O)710 Crab Pot on a fresh valid Farm water tile; native Crab Pot evidence determines completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)710"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "place_crab_pot",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("bait_crab_pot")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.bait_crab_pot,
        label: "Bait Stardew Crab Pot",
        description:
          "Attach exactly one live owned (O)685 Bait to a fresh adjacent unbaited current-player-owned (O)710 Crab Pot. The native interaction and authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)685"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "bait_crab_pot",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("fertilize_tile")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.fertilize_tile,
        label: "Fertilize Stardew Soil",
        description:
          "Apply one live owned fertilizer item to a live eligible ground HoeDirt target. Native placement and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({
            minLength: 1,
            maxLength: 128,
          }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "fertilize_tile",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("machine_inspect")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_inspect,
        label: "Inspect Stardew Machine",
        description:
          "Read a live native machine state without opening a menu or changing the machine.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "machine_inspect",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("machine_load")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_load,
        label: "Load Coffee Beans into Keg",
        description:
          "Load exactly five Coffee Beans into a live idle Keg through the normal native machine interaction. A receipt proves native input consumption and Coffee processing start.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.Literal("(O)433"),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "machine_load",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("machine_collect_output")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_collect_output,
        label: "Collect Coffee from Keg",
        description:
          "Collect ready Coffee from the exact live Keg through the normal native machine interaction. A receipt proves native inventory delivery and cleared ready output.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "machine_collect_output",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("collect_animal_product")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.collect_animal_product,
        label: "Collect Stardew Animal Product",
        description:
          "Use the live compatible Farmhand-owned tool on a live ready animal-product target. Native animation and receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "collect_animal_product",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("feed_animal")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.feed_animal,
        label: "Place Hay in Stardew Trough",
        description:
          "Place one live owned Hay item in a live empty AnimalHouse trough. This does not claim an animal has eaten.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "feed_animal",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("use_item")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.use_item,
        label: "Use Stardew Food Item",
        description:
          "Use a live ordinary edible Farmhand inventory item. Native eating animation and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          expectedQualifiedItemId: Type.String({
            minLength: 1,
            maxLength: 128,
          }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "use_item",
        toArgs: (params) => ({
          slot: params.slot,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
        }),
      }),
    );
  }
  if (isVisible("harvest_crop")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.harvest_crop,
        label: "Harvest Stardew Crop",
        description:
          "Harvest a live ready ordinary crop. Only the native harvest receipt and inventory/regrow postcondition determine completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({
            minLength: 1,
            maxLength: 128,
          }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "harvest_crop",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("chop_tree_source")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chop_tree_source,
        label: "Chop Stardew Tree Source",
        description:
          "Use one equipped Axe terminal strike on a live ordinary mature one-hit tree source. Only source transformation in the authoritative receipt determines completion.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "chop_tree_source",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("dig_artifact_spot")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.dig_artifact_spot,
        label: "Dig Stardew Artifact Spot",
        description:
          "Use one equipped Basic Hoe on a live adjacent (O)590 artifact spot. Source removal and native HoeDirt creation are required; rewards are excluded.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "dig_artifact_spot",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("clear_hoedirt")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.clear_hoedirt,
        label: "Clear Stardew HoeDirt",
        description:
          "Use one equipped Basic Pickaxe hit on live adjacent empty ground HoeDirt. Crops, IndoorPots, drops, and pickup are excluded.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "clear_hoedirt",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("break_rock_source")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.break_rock_source,
        label: "Break Stardew Rock Source",
        description:
          "Use one equipped basic Pickaxe hit on a live one-hit ordinary stone source. Drops and pickup are separate actions.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "break_rock_source",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  if (isVisible("equip_tool")) {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.equip_tool,
        label: "Equip Stardew Tool",
        description:
          "Select a Tool already owned by the AI Farmhand. The Mod receipt reports the authoritative before/after CurrentTool state.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "equip_tool",
        toArgs: (params) => ({ slot: params.slot }),
      }),
    );
  }
  return tools;
}
async function executeGameAction(
  integration: MoveCapableIntegration,
  policy: ActionPolicy | undefined,
  dispatchAdmissionFactory: IntegrationDispatchAdmissionFactory,
  action: StardewActionId,
  args: Readonly<Record<string, unknown>>,
  callerIds: Readonly<{ requestId?: string; idempotencyKey?: string }>,
) {
  const snapshot = integration.state.snapshot;
  if (!integration.state.connected || snapshot === null)
    return receiptResult(null, "integration_not_ready");
  const currentCapabilities = integration.state.capabilities.filter(
    (capability) => snapshot.capabilities.includes(capability),
  );
  if (!currentCapabilities.includes(action))
    return receiptResult(null, "capability_not_declared");
  if (
    !visibleActionsFromModCatalog(
      integration.state.catalogRegistrations ?? [],
      currentCapabilities,
      policy,
    ).some((entry) => entry.actionId === action)
  )
    return receiptResult(null, "action_policy_denied");

  // The shared wrapper owns identity, revision, and deadline construction;
  // tool closures contribute only an action literal plus typed args.
  const request: ExecutionRequest = {
    requestId: callerIds.requestId ?? randomUUID(),
    idempotencyKey: callerIds.idempotencyKey ?? randomUUID(),
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  };
  const invalid = validateExecutionRequest(request, snapshot);
  if (invalid !== null) return receiptResult(null, invalid);
  try {
    return receiptResult(
      await executeBridge(integration, dispatchAdmissionFactory, request),
      null,
    );
  } catch (error) {
    return receiptResult(
      null,
      error instanceof Error
        ? error.message.replace(/^bridge_rejected:/, "")
        : "bridge_execute_failed",
    );
  }
}
async function executeBridge(
  integration: MoveCapableIntegration,
  dispatchAdmissionFactory: IntegrationDispatchAdmissionFactory,
  request: ExecutionRequest,
): Promise<ExecutionReceipt> {
  /* Never retain an admission in the tool closure: STOP fences the final pre-write boundary. */
  const admission = dispatchAdmissionFactory();
  // Register the immutable tuple before the write so a lost first receipt can
  // be queried after a fresh authenticated binding without reissuing action.
  const dispatch = {
    ...admission.owner,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    recoveryMaterial: {
      logicalActionId: request.requestId,
      request,
    },
  };
  await admission.observer.beforeWrite(dispatch);
  try {
    const receipt = await integration.execute(request);
    await admission.observer.bindReceipt(receipt);
    return receipt;
  } catch (error) {
    await admission.observer.markUncertain(dispatch);
    throw error;
  }
}

function receiptResult(
  receipt: ExecutionReceipt | null,
  reasonCode: string | null,
) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          receipt === null
            ? `Game action was not created: ${reasonCode}.`
            : JSON.stringify(receipt),
      },
    ],
    details: {
      receiptJson: receipt === null ? null : JSON.stringify(receipt),
      reasonCode,
    },
  };
}
