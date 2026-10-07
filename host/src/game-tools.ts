import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, type TObject, Type } from "typebox";
import {
  type ActionPolicy,
  getArgumentEnum,
  getDescriptorArgument,
  isModDescriptorComplete,
  STARDEW_ACTION_TOOL_NAMES,
  type StardewActionId,
  type StardewDescriptorDerivedActionId,
  searchActionsFromModCatalog,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import type { IntegrationDispatchAdmission } from "./game-integration-adapter.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import {
  type ActionRegistrationDescriptor,
  type ExecutionReceipt,
  type ExecutionRequest,
  TOOL_SELECTOR_VALUES,
  isValidObserveSceneResult,
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
  const requestId = typeof record.requestId === "string" && record.requestId.length > 0 ? record.requestId : undefined;
  const idempotencyKey = typeof record.idempotencyKey === "string" && record.idempotencyKey.length > 0 ? record.idempotencyKey : undefined;
  return Object.freeze({
    ...(requestId === undefined ? {} : { requestId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
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
      "Read the latest authoritative Stardew Farmhand snapshot by asking the Mod for a fresh observation. This never changes the game. Always call this again after any action that changes location or world state; the previous result may describe a location you have already left.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state;
      // A fresh solicited observe is the only way the Agent can see the world
      // after its own navigate/execute advanced the Mod revision; the Host
      // cache alone would still describe the pre-action location. The observed
      // snapshot is admitted into the connection state by the receive path, so
      // re-read the cache afterwards (works for both the Promise-returning
      // production client and the synchronous test client).
      let refresh: "fresh" | "cached" = "cached";
      let refreshError: string | null = null;
      if (typeof integration.observe === "function") {
        try {
          await integration.observe();
          refresh = "fresh";
        } catch (error) {
          refreshError = String(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      const snapshot = integration.state.snapshot;
      const available = state.connected && snapshot !== null;
      // The model-facing text carries the actionable cause, not one opaque
      // sentence. A trace shows the Agent polling this tool 32 times with the
      // same uninformative reply after the bridge had gone away, because the
      // reason code was present but only in `details`.
      const unavailableReason = state.latestReasonCode ?? "integration_not_ready";
      const disconnected = !state.connected;
      const unavailableText = disconnected
        ? `No live Stardew connection: ${unavailableReason}. The bridge is not attached, so the world cannot be observed and actions cannot be issued — do not keep retrying; report the state to the player instead.`
        : `No authoritative Stardew snapshot is available: ${unavailableReason}. The connection is up but the world is not observable yet${refreshError === null ? "" : ` (last refresh failed: ${refreshError})`}; retry only after the world state changes, not in a tight loop.`;
      return {
        content: [
          {
            type: "text" as const,
            text: available ? JSON.stringify(snapshot) : unavailableText,
          },
        ],
        details: {
          available,
          refresh,
          refreshError,
          reasonCode: available
            ? refresh === "fresh"
              ? "available_fresh"
              : "available_cached"
            : unavailableReason,
          snapshotJson: available ? JSON.stringify(snapshot) : null,
        },
      };
    },
  });
  const execution = defineTool({
    name: "stardew_execution_status",
    label: "Stardew Execution Status",
    description:
      "Read the latest diagnostic Stardew execution receipt snapshot. This is an inspection-only view for debugging; it is not authoritative completion proof for any task and must not be used to confirm an action finished.",
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
  const sceneCapabilityReady = (): boolean => {
    const state = integration.state;
    const snapshot = state.snapshot;
    return state.connected && snapshot !== null &&
      state.catalogRevision === snapshot.catalogRevision &&
      state.capabilities.includes("observe_scene") && snapshot.capabilities.includes("observe_scene") &&
      (state.catalogRegistrations ?? []).some((registration) =>
        registration.actionId === "observe_scene" && registration.familyId === "world_perception" &&
        registration.identityVersion === 1 && registration.lifecycle === "published" && registration.kind === "read_only") &&
      typeof (integration as { observeScene?: unknown }).observeScene === "function" &&
      !new Set(policy?.deniedActions ?? []).has("observe_scene") &&
      !new Set(policy?.deniedFamilies ?? []).has("world_perception");
  };

  const tools: Array<ReturnType<typeof defineTool>> = [
    observe,
    execution,
    catalog,
    search,
  ];
  { // constant mount; readiness re-checked at execution
    tools.push(
      defineTool({
        // Renamed from stardew_observe_scene: sharing the stardew_observe prefix with the per-turn
        // context tool made two different observations look like one family at selection time. The
        // wire action id is unchanged.
        name: "stardew_read_scene",
        label: "Observe Stardew Scene",
        description: "Read the Mod-advertised live Stardew scene projection. Scene references are observational only and never authorize mutation.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async (_toolCallId, params) => {
          if (!requireStrictObject(params) || Object.keys(params).length !== 0)
            throw new Error("invalid_tool_parameters");
          if (!sceneCapabilityReady()) throw new Error("bridge_capability_not_ready");
          const result = await (integration as StardewBridgeConnection & { observeScene: (request: {}) => Promise<unknown> }).observeScene({});
          if (!isValidObserveSceneResult(result)) throw new Error("invalid_observe_scene_result");
          return navigationResult(result);
        },
      }),
    );
  }
  { // constant mount; readiness re-checked at execution
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
  { // constant mount; readiness re-checked at execution
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
 * Dynamically builds a restrictive TypeBox schema from an authenticated candidate action descriptor.
 * Validates strictly with additionalProperties: false and enforces Mod-provided enums.
 */
export function buildCandidateToolSchema(
  actionId: StardewDescriptorDerivedActionId,
  descriptor: ActionRegistrationDescriptor,
): TObject {
  if (actionId === "express_emote") {
    const arg = getDescriptorArgument(descriptor, "emote");
    const enumVals = getArgumentEnum(arg);
    if (!enumVals || enumVals.length === 0) {
      throw new Error(
        "Invalid or incomplete descriptor for express_emote: missing emote enum",
      );
    }
    const literals = enumVals.map((v) => Type.Literal(v));
    const emoteSchema =
      literals.length === 1 ? literals[0]! : Type.Union(literals);
    return Type.Object(
      {
        emote: emoteSchema,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "face_direction") {
    const arg = getDescriptorArgument(descriptor, "direction");
    const enumVals = getArgumentEnum(arg);
    if (!enumVals || enumVals.length === 0) {
      throw new Error(
        "Invalid or incomplete descriptor for face_direction: missing direction enum",
      );
    }
    const literals = enumVals.map((v) => Type.Literal(v));
    const directionSchema =
      literals.length === 1 ? literals[0]! : Type.Union(literals);
    return Type.Object(
      {
        direction: directionSchema,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "interact_npc_with_item") {
    // Exact five-argument shape derived from the frozen descriptor; the
    // opaque NPC target and qualified item must be copied verbatim from the
    // most recent observation and are never synthesized by the tool.
    return Type.Object(
      {
        slot: Type.Integer({ minimum: 0, maximum: 36 }),
        x: Type.Integer({ minimum: 0, maximum: 1000 }),
        y: Type.Integer({ minimum: 0, maximum: 1000 }),
        expectedQualifiedItemId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "talk_to_npc") {
    // The NPC family's shape: the opaque NPC target id and the tile it was published at,
    // both copied verbatim from the most recent npcRelationshipTargets observation and
    // never synthesized by the tool.
    return Type.Object(
      {
        x: Type.Integer({ minimum: 0, maximum: 1000 }),
        y: Type.Integer({ minimum: 0, maximum: 1000 }),
        expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "pet_animal") {
    // Identity-locked target: the opaque pet target id is copied verbatim from
    // the most recent observation, while x/y are the observed geometry.
    return Type.Object(
      {
        x: Type.Integer({ minimum: 0, maximum: 1000 }),
        y: Type.Integer({ minimum: 0, maximum: 1000 }),
        expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "advance_day") {
    // No client-supplied target: the Farmhand's own bed and its native ready
    // state are the whole input, so there is nothing to synthesize or spoof.
    return Type.Object({}, { additionalProperties: false });
  }

  if (actionId === "ride_bus") {
    // No client-supplied target: the ticket machine of the current location is
    // the whole input, so there is nothing to synthesize or spoof.
    return Type.Object({}, { additionalProperties: false });
  }

  if (actionId === "ride_minecart") {
    // Station tile plus the opaque ride selector: both are copied verbatim from
    // the minecartTargets entries of the most recent observation.
    return Type.Object(
      {
        x: Type.Integer({ minimum: 0, maximum: 1000 }),
        y: Type.Integer({ minimum: 0, maximum: 1000 }),
        expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    );
  }

  if (
    actionId === "withdraw_silo_hay" ||
    actionId === "use_obelisk" ||
    actionId === "toggle_animal_door"
  ) {
    // Same shape as ride_minecart: the tile plus the opaque target from the most
    // recent observation, both copied verbatim.
    return Type.Object(
      {
        x: Type.Integer({ minimum: 0, maximum: 1000 }),
        y: Type.Integer({ minimum: 0, maximum: 1000 }),
        expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
      },
      { additionalProperties: false },
    );
  }

  throw new Error(`Unsupported candidate action: ${actionId}`);
}

/**
 * Mounts the complete Game Action tool surface for the life of a connected
 * session. The mounted tool NAME set is constant: per-action eligibility is
 * decided at execution time by executeGameAction against the Mod's live
 * capability snapshot and restrictive policy, which returns a structured
 * rejected receipt (capability_not_declared / action_policy_denied) instead
 * of withdrawing the tool. A constant name set preserves the provider prefix
 * cache, which a per-snapshot tool add/remove would otherwise bust. The Host
 * never mints per-turn permission or treats model prose as an authorization
 * source.
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
  // Frozen Manifest content only: descriptor-complete blocks (express_emote,
  // face_direction) mount from published registrations, never from live
  // capability snapshots or per-turn permission.
  const modRegistrations = state.catalogRegistrations ?? [];
  const tools: Array<ReturnType<typeof defineTool>> = [];
  const makeGameActionTool = gameActionToolFactory(
    integration,
    policy,
    dispatchAdmissionFactory,
  );
  { // constant mount; per-action admission at execution
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.move_to_tile,
        label: "Move Farmhand to Tile",
        description:
          "Request the player-enabled move_to_tile capability. Inspect its authoritative receipt before saying movement succeeded. " +
          "A tile that holds an object (crop, weed, chest, machine) is approached from a standable neighbouring tile: the receipt then reports target_reached with adjacent_arrival=true and names the requested tile. " +
          "If the actor is already at the destination (or already within the approach ring of a substituted one), the receipt reports target_reached with already_at_target=true — nothing moved because nothing needed to. " +
          "A refusal (no_native_path) names the cause: blocked_by=<item>@x,y, target_standable, and probe_says_reachable.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.travel,
        label: "Travel Through Stardew Warp or Minecart",
        description:
          "Use a live native warp at the supplied source tile, or ride an advertised minecart objective from that station tile. The Mod resolves the destination and only a Warped postcondition can report success.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 128,
              description:
                "A minecart targetId published in minecartTargets for this station tile. Omit for an ordinary warp.",
            }),
          ),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "travel",
        toArgs: (params) =>
          params.expectedTargetId === undefined
            ? { x: params.x, y: params.y }
            : { x: params.x, y: params.y, expectedTargetId: params.expectedTargetId },
      }),
    );
  }
  { // constant mount; per-action admission at execution
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
  { // constant mount; per-action admission at execution
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.pickup_forage,
        label: "Pick Up Stardew Forage",
        description:
          "Pick up a live native forage target. x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the forageTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the authoritative native receipt and target disappearance can report completion.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedQualifiedItemId: Type.String({
            minLength: 1,
            maxLength: 128,
          }),
           expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
           sceneTarget: Type.Object(
             {
               observationId: Type.String({ minLength: 1, maxLength: 128 }),
               ref: Type.String({ pattern: "^sr1_[A-Za-z0-9_-]{16}$" }),
             },
             { additionalProperties: false },
           ),
           requestId: Type.Optional(
             Type.String({ minLength: 1, maxLength: 128 }),
           ),
           idempotencyKey: Type.Optional(
             Type.String({ minLength: 1, maxLength: 128 }),
           ),
         }, { additionalProperties: false }),
         action: "pickup_forage",
         toArgs: (params) => ({
           x: params.x,
           y: params.y,
           expectedQualifiedItemId: params.expectedQualifiedItemId,
           expectedTargetId: params.expectedTargetId,
           sceneTarget: params.sceneTarget,
         }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.pickup_item,
        label: "Pick Up Stardew Item Drop",
        description:
          "Approach a live native Debris target. x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the itemTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the native magnetic-collection receipt and exact inventory evidence can report completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.refill_watering_can,
        label: "Refill Stardew Watering Can",
        description:
          "Refill one selected, partially filled Watering Can from a live adjacent native water source. slot, x, y and expectedTargetId must be copied exactly from the refillWateringCanTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates).",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.water_crop,
        label: "Water Stardew Crop",
        description:
          "Water a live unwatered crop target. x, y and expectedTargetId must be copied exactly from the cropTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the authoritative native receipt can report completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.plant_seed,
        label: "Plant Stardew Seed",
        description:
          "Plant a live ordinary seed into a live empty ground HoeDirt target. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the seedTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native crop creation and the authoritative receipt determine completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.place_wood_fence,
        label: "Place Stardew Wood Fence",
        description:
          "Place only a qualified (O)322 Wood Fence on a fresh empty Farm tile. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the woodFenceTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native Fence evidence determines completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.place_crab_pot,
        label: "Place Stardew Crab Pot",
        description:
          "Place only a qualified (O)710 Crab Pot on a fresh valid Farm water tile. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the crabPotTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native Crab Pot evidence determines completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.bait_crab_pot,
        label: "Bait Stardew Crab Pot",
        description:
          "Attach exactly one live owned (O)685 Bait to a fresh adjacent unbaited current-player-owned (O)710 Crab Pot. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the baitCrabPotTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The native interaction and authoritative receipt determine completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.harvest_bush,
        label: "Harvest Stardew Berry Bush",
        description:
          "Harvest a live in-bloom berry bush using its native interaction. x, y and expectedTargetId must come from the bushTargets entries of the most recent observe result for the current location.",
        parameters: Type.Object({
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        action: "harvest_bush",
        toArgs: (params) => ({ x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }),
      }),
    );
  }
  for (const action of ["harvest_fruit_tree", "shake_tree", "take_pedestal_item", "toggle_fence_gate"] as const) {
    const labels = ({
      harvest_fruit_tree: ["Harvest Stardew Fruit Tree", "fruitTreeTargets", "Harvest fruit from a live fruit tree through its native interaction."],
      shake_tree: ["Shake Stardew Tree", "shakeTreeTargets", "Shake a live tree that has not been shaken today through its native interaction."],
      take_pedestal_item: ["Take Stardew Pedestal Item", "pedestalTargets", "Take the displayed item through the native pedestal inventory transaction."],
      toggle_fence_gate: ["Toggle Stardew Fence Gate", "fenceGateTargets", "Toggle a live fence gate through its native gate state transition."],
    } as const)[action];
    tools.push(makeGameActionTool({
      name: STARDEW_ACTION_TOOL_NAMES[action],
      label: labels[0],
      description: `${labels[2]} x, y and expectedTargetId must be copied exactly from ${labels[1]} in the most recent observe result.`,
      parameters: Type.Object({
        x: Type.Integer({ minimum: 0, maximum: 1000 }),
        y: Type.Integer({ minimum: 0, maximum: 1000 }),
        expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
        requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      }),
      action,
      toArgs: (params) => ({ x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }),
    }));
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.fertilize_tile,
        label: "Fertilize Stardew Soil",
        description:
          "Apply one live owned fertilizer item to a live eligible ground HoeDirt target. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the fertilizerTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native placement and the authoritative receipt determine completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_inspect,
        label: "Inspect Stardew Machine",
        description:
          "Read a live native machine state without opening a menu or changing the machine. x, y and expectedTargetId must be copied exactly from the machineTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates, never reuse coordinates observed in a different location). requestId/idempotencyKey are optional request metadata, not ActionProgram node arguments; execution deadlines are absolute Unix epoch milliseconds, not durations.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_load,
        label: "Load Coffee Beans into Keg",
        description:
          "Load exactly five Coffee Beans into a live idle Keg through the normal native machine interaction. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the machineTargets entry of the MOST RECENT observe result for the current location (use the loadInputSlot/loadInputQualifiedItemId fields, never invent or guess coordinates, never reuse coordinates observed in a different location). A receipt proves native input consumption and Coffee processing start. requestId/idempotencyKey are optional request metadata, not ActionProgram node arguments; execution deadlines are absolute Unix epoch milliseconds, not durations.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_collect_output,
        label: "Collect Coffee from Keg",
        description:
          "Collect ready Coffee from the exact live Keg through the normal native machine interaction. x, y and expectedTargetId must be copied exactly from the machineTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). A receipt proves native inventory delivery and cleared ready output.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.collect_animal_product,
        label: "Collect Stardew Animal Product",
        description:
          "Use the live compatible Farmhand-owned tool on a live ready animal-product target. slot, x, y and expectedTargetId must be copied exactly from the animalProductTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native animation and receipt determine completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.feed_animal,
        label: "Place Hay in Stardew Trough",
        description:
          "Place one live owned Hay item in a live empty AnimalHouse trough. slot, x, y and expectedTargetId must be copied exactly from the feedTroughTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). This does not claim an animal has eaten.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.use_item,
        label: "Use Stardew Food Item",
        description:
          "Use a live ordinary edible Farmhand inventory item. slot and expectedQualifiedItemId must be copied exactly from the foodTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native eating animation and the authoritative receipt determine completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.harvest_crop,
        label: "Harvest Stardew Crop",
        description:
          "Harvest a live ready ordinary crop. x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the harvestTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the native harvest receipt and inventory/regrow postcondition determine completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chop_tree_source,
        label: "Chop Stardew Tree Source",
        description:
          "Use one equipped Axe terminal strike on a live ordinary mature one-hit tree source. slot, x, y and expectedTargetId must be copied exactly from the treeChopSourceTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only source transformation in the authoritative receipt determines completion.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.dig_artifact_spot,
        label: "Dig Stardew Artifact Spot",
        description:
          "Use one equipped Basic Hoe on a live adjacent diggable artifact spot. slot, x, y and expectedTargetId must be copied exactly from the artifactSpotTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Source removal and native HoeDirt creation are required; rewards are excluded.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.clear_hoedirt,
        label: "Clear Stardew HoeDirt",
        description:
          "Use one equipped Basic Pickaxe hit on live adjacent empty ground HoeDirt. slot, x, y and expectedTargetId must be copied exactly from the clearHoeDirtTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Crops, IndoorPots, drops, and pickup are excluded.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.break_rock_source,
        label: "Break Stardew Rock Source",
        description:
          "Use one equipped basic Pickaxe hit on a live one-hit ordinary stone source. slot, x, y and expectedTargetId must be copied exactly from the rockSourceTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Drops and pickup are separate actions.",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.equip_tool,
        label: "Equip Stardew Tool",
        description: `Select a Tool already owned by the AI Farmhand by semantic category (${[...TOOL_SELECTOR_VALUES].join(", ")}). The Mod receipt reports the authoritative before/after CurrentTool state.`,
        parameters: Type.Object({
          tool: Type.Union(
            [...TOOL_SELECTOR_VALUES].map((selector) =>
              Type.Literal(selector),
            ),
          ),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "equip_tool",
        toArgs: (params) => ({ tool: params.tool }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "express_emote",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("express_emote", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema(
        "express_emote",
        registration.descriptor,
      );
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.express_emote,
          label: "Express Stardew Emote",
          description:
            "Show a native overhead emote balloon for the companion actor.",
          parameters: schema,
          action: "express_emote",
          toArgs: (params) => ({ emote: params.emote }),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "face_direction",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("face_direction", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema(
        "face_direction",
        registration.descriptor,
      );
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.face_direction,
          label: "Face Stardew Direction",
          description:
            "Turn the companion actor to face a cardinal direction (up, right, down, left).",
          parameters: schema,
          action: "face_direction",
          toArgs: (params) => ({ direction: params.direction }),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "interact_npc_with_item",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete(
        "interact_npc_with_item",
        registration.descriptor,
      )
    ) {
      const schema = buildCandidateToolSchema(
        "interact_npc_with_item",
        registration.descriptor,
      );
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.interact_npc_with_item,
          label: "Offer Item to NPC",
          description:
            "Offer one carried inventory item to an adjacent villager. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). A matching native quest delivery completes first and returns quest_item_delivered; the ordinary gift path returns gift_given.",
          parameters: schema,
          action: "interact_npc_with_item",
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
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "talk_to_npc",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("talk_to_npc", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("talk_to_npc", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.talk_to_npc,
          label: "Talk to Villager",
          description:
            "Talk to an adjacent villager: the Mod drives the game's own NPC.checkAction talk branch, so the villager's real dialogue is what appears. x, y and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Empty your hands first: with an item in hand the game takes the gift path instead and the action refuses with hands_not_empty, and a villager who is asleep or out of reach is refused too. Returns talk_to_npc_talked when the dialogue is open; the actor stays inside that dialogue until it is closed (dismiss_modal, or answer_dialogue for a question).",
          parameters: schema,
          action: "talk_to_npc",
          toArgs: (params) => ({
            x: params.x,
            y: params.y,
            expectedTargetId: params.expectedTargetId,
          }),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "pet_animal",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("pet_animal", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("pet_animal", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.pet_animal,
          label: "Pet Animal",
          description:
            "Pet a nearby pet. x, y and expectedTargetId must be copied exactly from the petTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The pet target is bound by identity: if it has moved away, the native interaction returns a rejection instead of petting a different pet. A pet that is stationary right now is the reliable target; a moving one may leave before dispatch returns. Returns pet_completed.",
          parameters: schema,
          action: "pet_animal",
          toArgs: (params) => ({
            x: params.x,
            y: params.y,
            expectedTargetId: params.expectedTargetId,
          }),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "advance_day",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("advance_day", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("advance_day", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.advance_day,
          label: "Sleep and Advance the Day",
          description:
            "End the day the way the player does: the Farmhand walks to its own bed, lets the native sleep path run, declares sleep-ready through that same native path, and then observes the native save and new-day transition. In a shared world the night completes only when every required player is ready; the Farmhand never marks another player ready and never forces the day. Takes no arguments. Returns day_advanced when the native save and day transition are observed, blocked with requires_other_player when the ready barrier is still waiting on someone else.",
          parameters: schema,
          action: "advance_day",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "dismiss_modal",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("dismiss_modal", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("dismiss_modal", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.dismiss_modal,
          label: "Dismiss a Dialog",
          description:
            "Close the informational native dialogue currently on screen (a DialogueBox with no pending question) through the native closeDialogue path. The dialog must have been opened by the world (a villager, a door gate, an event) and must not be a question that requires choosing an answer.",
          parameters: schema,
          action: "dismiss_modal",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "ride_bus",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("ride_bus", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("ride_bus", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.ride_bus,
          label: "Ride the Bus",
          description:
            "Ride the native bus from the Bus Stop ticket machine to the desert. Stand next to the ticket machine first (otherwise the action refuses with bus_ticket_machine_out_of_reach). The Mod verifies the vault, the driver and the fare itself, then drives the game's own ticket interaction: the receipt arrives as bus_arrived when the actor is in the desert, or bus_arrival_unconfirmed if the ride never completes.",
          parameters: schema,
          action: "ride_bus",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "withdraw_silo_hay",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("withdraw_silo_hay", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("withdraw_silo_hay", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.withdraw_silo_hay,
          label: "Take hay from a silo",
          description:
            "Withdraw one hay from a discovered silo. Stand within reach of the silo first. Read the opaque target id, its tile and the stored `hay` count from the `siloTargets` entries of the most recent observation (the same list `deposit_silo_hay` reads). The Mod re-resolves the silo from the opaque target id and asserts BOTH halves of the move (the silo store drops by one and the carried hay rises by one), so a one-sided change is never reported as success.",
          parameters: schema,
          action: "withdraw_silo_hay",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "toggle_animal_door",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("toggle_animal_door", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("toggle_animal_door", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.toggle_animal_door,
          label: "Toggle an animal door",
          description:
            "Open or close a barn or coop animal door. Stand within reach of the building first. Read the opaque target id, its tile and the current `isOpen` state from the `animalDoorTargets` entries of the most recent observation. The Mod re-resolves the building from the opaque target id and asserts the door state flipped; the receipt carries the observed before/after state.",
          parameters: schema,
          action: "toggle_animal_door",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "use_obelisk",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("use_obelisk", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("use_obelisk", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.use_obelisk,
          label: "Use a warp obelisk",
          description:
            "Activate a discovered warp obelisk. Stand within reach of it first. Read the opaque target id, `route`, tile and `destination` from the `obeliskTargets` entries of the most recent observation. The Mod chooses the destination from the target itself (a Data/Buildings obelisk building, or the island farm obelisk tile), so name the structure and never a destination; the arrival is the terminal, not the dispatch.",
          parameters: schema,
          action: "use_obelisk",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "shop_purchase",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("shop_purchase", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("shop_purchase", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.shop_purchase,
          label: "Buy from a shop",
          description:
            "Buy goods from a shop whose owner is standing within reach. Read the opaque target id, `shopId`, the owner tile and `stockItemIds` from the `shopTargets` entries of the most recent observation. The Mod reads the shop, its owner eligibility and its stock from the game's own content data, and the purchase runs through the game's shop menu. Move into reach first; the action does not walk.",
          parameters: schema,
          action: "shop_purchase",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "select_mine_elevator_floor",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("select_mine_elevator_floor", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("select_mine_elevator_floor", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.select_mine_elevator_floor,
          label: "Use the Mine Elevator",
          description:
            "Select an already-reached floor on the mine elevator. Read the opaque target id, `floor` and `isCurrentFloor` from the `mineElevatorFloorTargets` entries of the most recent observation. The offered floors come from the Mod reading the live lowest level reached, so a level the player has not unlocked cannot be requested. Floor 0 returns to the mine entrance and is only valid from inside the mine.",
          parameters: schema,
          action: "select_mine_elevator_floor",
          toArgs: () => ({}),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "answer_dialogue",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("answer_dialogue", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("answer_dialogue", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.answer_dialogue,
          label: "Answer a Dialogue",
          description:
            "Choose one response from the currently displayed native question dialogue. responseKey must exactly match a response offered by the live DialogueBox.",
          parameters: schema,
          action: "answer_dialogue",
          toArgs: (params) => ({ responseKey: params.responseKey }),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    const registration = modRegistrations.find(
      (entry) => entry.actionId === "ride_minecart",
    );
    if (
      registration?.descriptor &&
      isModDescriptorComplete("ride_minecart", registration.descriptor)
    ) {
      const schema = buildCandidateToolSchema("ride_minecart", registration.descriptor);
      tools.push(
        makeGameActionTool({
          name: STARDEW_ACTION_TOOL_NAMES.ride_minecart,
          label: "Ride a Native Minecart",
          description:
            "Ride one advertised native minecart objective from a live station tile. x, y and expectedTargetId must be copied exactly from the minecartTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates); x,y is the STATION tile, not the destination. The Mod re-derives the network, its unlock, the destination condition and the ticket price on the game thread from the live map tile and Data/Minecarts, then performs the native ride. Only the minecart_ride_completed receipt, which names the ridden objective and the exact arrival tile, reports success.",
          parameters: schema,
          action: "ride_minecart",
          toArgs: (params) => ({
            x: params.x,
            y: params.y,
            expectedTargetId: params.expectedTargetId,
          }),
        }),
      );
    }
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.clear_debris,
        label: "Clear Stardew Debris",
        description:
          "Clear one live adjacent ResourceClump with the equipped Axe or Pickaxe. slot, x, y and expectedTargetId must be copied exactly from the debrisTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). A clump that needs several hits returns partially_succeeded/debris_hit per hit until the final hit returns succeeded/debris_cleared; drops and pickup are separate actions.",
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
        action: "clear_debris",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.npc_relationship,
        label: "Inspect NPC Relationship",
        description:
          "Read the live relationship facts of one adjacent villager. x, y and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). This never changes friendship, gifts or dialogue; it returns npc_relationship_inspected.",
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
        action: "npc_relationship",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.water_pet_bowl,
        label: "Water the Pet Bowl",
        description:
          "Water the current location's completed, unwatered native Pet Bowl with the equipped Watering Can. x, y and expectedTargetId must be copied exactly from the petBowlTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Returns pet_bowl_watered with the exact water and stamina delta.",
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
        action: "water_pet_bowl",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.water_slime_hutch_trough,
        label: "Water a Slime Hutch Trough",
        description:
          "Water one unwatered trough tile inside the current Slime Hutch with the equipped Watering Can. x, y and expectedTargetId must be copied exactly from the slimeHutchTroughTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Farmhand must already be inside the hutch. Returns slime_hutch_trough_watered.",
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
        action: "water_slime_hutch_trough",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chest_store,
        label: "Store Item in Chest",
        description:
          "Move one carried inventory stack into a live adjacent chest. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from one chestStoreTargets entry of the MOST RECENT observe result for the current location (never invent or guess coordinates). No ItemGrabMenu is opened. Returns chest_stored with the exact stack conservation evidence.",
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
        action: "chest_store",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chest_retrieve,
        label: "Take Item From Chest",
        description:
          "Move one observed chest slot's item into the Farmhand inventory. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the chestRetrieveTargets entries of the MOST RECENT observe result (never invent or guess coordinates). expectedQualifiedItemId pins the observed slot item so a changed slot is rejected rather than taken. No ItemGrabMenu is opened. Returns chest_retrieved.",
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
        action: "chest_retrieve",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chop_stump,
        label: "Chop Tree Stump",
        description:
          "Chop one live ordinary tree that is already a stump with the equipped Axe. slot, x, y and expectedTargetId must be copied exactly from the treeStumpTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod swings the native axe until the stump is cleared. Returns stump_cleared. A mature standing tree is chop_tree_source, not this action.",
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
        action: "chop_stump",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.plant_sapling,
        label: "Plant Tree Sapling",
        description:
          "Plant one observed tree sapling on a live lawful tile through the native wild-tree-seed placement path. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the treeSaplingTargets entries of the MOST RECENT observe result (never invent or guess coordinates). Returns sapling_planted with the seed consumed exactly once.",
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
        action: "plant_sapling",
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
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.cut_weeds,
        label: "Cut Weeds",
        description:
          "Cut one live adjacent Weed with the equipped scythe. slot, x, y and expectedTargetId must be copied exactly from the weedTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod swings the native scythe until the weed is removed; the family is free, so the stamina cost is an explicit zero. Returns weeds_cut. Standing crops are scythe_crop, not this action.",
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
        action: "cut_weeds",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.cut_grass,
        label: "Cut Grass",
        description:
          "Cut one live adjacent Grass tuft (a TerrainFeature, distinct from weeds) with the equipped scythe. slot, x, y and expectedTargetId must be copied exactly from the grassTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod swings the native scythe until the tuft is removed; grassType 1/7 feeds Hay into a silo (hay_unstored 0 = all stored) and grassType 6 drops rare items. Returns grass_cut.",
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
        action: "cut_grass",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.clear_cask,
        label: "Clear Cask",
        description: "Use the equipped Axe, Pickaxe, or Hoe on one live adjacent Cask. slot, x, y and expectedTargetId must be copied exactly from the toolSlots and caskTargets in the MOST RECENT observe result. A filled Cask drops its contents and remains; an empty Cask is removed. Returns cask_cleared.",
        parameters: Type.Object({
          slot: Type.Integer({ minimum: 0, maximum: 36 }),
          x: Type.Integer({ minimum: 0, maximum: 1000 }),
          y: Type.Integer({ minimum: 0, maximum: 1000 }),
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        }),
        action: "clear_cask",
        toArgs: (params) => ({ slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }),
      }),
    );
  }
  for (const action of ["dress_mannequin", "set_sign_display", "deposit_silo_hay"] as const) {
    const isMannequin = action === "dress_mannequin";
    const isSign = action === "set_sign_display";
    const targetKey = isMannequin ? "mannequinTargets" : isSign ? "signTargets" : "siloTargets";
    const label = isMannequin ? "Dress Mannequin" : isSign ? "Set Sign Display" : "Deposit Silo Hay";
    tools.push(makeGameActionTool({
      name: STARDEW_ACTION_TOOL_NAMES[action], label,
      description: `${label} using the held inventory item. slot, x, y and expectedTargetId must be copied exactly from the toolSlots and ${targetKey} in the MOST RECENT observe result.`,
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      action, toArgs: (params) => ({ slot: params.slot, x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }),
    }));
  }
  {
    tools.push(makeGameActionTool({
      name: STARDEW_ACTION_TOOL_NAMES.toggle_tool_light, label: "Toggle Tool Light",
      description: "Toggle the Lantern light; slot must identify the Lantern currently equipped, copied from lanternSlots in the most recent observe result. The light toggles on the tool itself, not on a world object.",
      parameters: Type.Object({ slot: Type.Integer({ minimum: 0, maximum: 36 }), x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }),
      action: "toggle_tool_light", toArgs: (params) => ({ slot: params.slot, x: params.x, y: params.y }),
    }));
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.scythe_crop,
        label: "Scythe Crop",
        description:
          "Scythe one live ready Scythe-method crop. slot, x, y and expectedTargetId must be copied exactly from the scytheCropTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The native scythe harvest removes the crop and leaves the produce on the ground; the produce is not added to the inventory by this action, so expect ground debris rather than an inventory increase. Returns scythe_crops_harvested.",
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
        action: "scythe_crop",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.craft_item,
        label: "Craft Item",
        description:
          "Craft one learned recipe from the Farmhand's own inventory. expectedTargetId must be copied exactly from the craftingRecipeTargets entries of the MOST RECENT observe result (never invent or guess a recipe). A targetId is the canonical recipe identity, not its display name. An unknown or unlearned recipe fails closed. Items that do not fit are dropped on the ground rather than lost, and the receipt reports the exact conservation evidence. Returns crafted_item_created.",
        parameters: Type.Object({
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "craft_item",
        toArgs: (params) => ({
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.cook_recipe,
        label: "Cook Recipe",
        description:
          "Cook one learned cooking recipe at a live adjacent cooking station. expectedTargetId must be copied exactly from the cookingRecipeTargets entries of the MOST RECENT observe result (never invent or guess a recipe). A targetId is the canonical recipe identity, not its display name. The station adjacency is re-derived and re-checked Mod-side from the live world rather than trusted from the client. Items that do not fit are dropped on the ground rather than lost. Returns dish_cooked.",
        parameters: Type.Object({
          expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }),
          requestId: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
          idempotencyKey: Type.Optional(
            Type.String({ minLength: 1, maxLength: 128 }),
          ),
        }),
        action: "cook_recipe",
        toArgs: (params) => ({
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.collect_crab_pot_output,
        label: "Collect Crab Pot Output",
        description:
          "Collect the ready output of one live adjacent baited Crab Pot. x, y and expectedTargetId must be copied exactly from the crabPotCollectTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod re-checks that the pot is really harvest-ready and visually ready before calling the native interaction, so an immature or unbaited pot is rejected rather than torn down. Returns crab_pot_output_collected.",
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
        action: "collect_crab_pot_output",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  { // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.ship_item,
        label: "Ship Item",
        description:
          "Move one shippable carried stack into the Farmhand's own live shipping bin. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the shippingBinTargets entries of the MOST RECENT observe result (never invent or guess coordinates). Non-shippable items such as tools are rejected before any native settlement. In a shared world the destination bin depends on the world's separate-wallets setting. Returns item_shipped.",
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
        action: "ship_item",
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
  { // constant mount; per-action admission at execution
    tools.push(makeGameActionTool({
      name: STARDEW_ACTION_TOOL_NAMES.mount_transport,
      label: "Mount a Native Horse",
      description: "Mount an advertised named horse in range; x, y and expectedTargetId must be copied exactly from horseTargets in the most recent observe result. The Mod waits for the native mounting animation to finish before reporting success.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
      action: "mount_transport",
      toArgs: params => ({ x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }),
    }));
    tools.push(makeGameActionTool({
      name: STARDEW_ACTION_TOOL_NAMES.enter_mine,
      label: "Enter the Mine",
      description: "Enter the live mine entrance tile; x, y and expectedTargetId must be copied exactly from mineEntranceTargets in the most recent observe result. This uses normal game progression and does not accept a level selector.",
      parameters: Type.Object({ x: Type.Integer({ minimum: 0, maximum: 1000 }), y: Type.Integer({ minimum: 0, maximum: 1000 }), expectedTargetId: Type.String({ minLength: 1, maxLength: 128 }), requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false }),
      action: "enter_mine",
      toArgs: params => ({ x: params.x, y: params.y, expectedTargetId: params.expectedTargetId }),
    }));
    tools.push(makeGameActionTool({
      name: STARDEW_ACTION_TOOL_NAMES.use_raft,
      label: "Launch Stardew Raft",
      description: "Launch the equipped Raft from an adjacent native water tile listed in raftTargets. This begins rafting; it does not steer to shore.",
      parameters: Type.Object({
        slot: Type.Integer({ minimum: 0, maximum: 36 }),
        x: Type.Integer({ minimum: 0, maximum: 1000 }),
        y: Type.Integer({ minimum: 0, maximum: 1000 }),
        requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      }, { additionalProperties: false }),
      action: "use_raft",
      toArgs: params => ({ slot: params.slot, x: params.x, y: params.y }),
    }));
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
    const reasonCode =
      error instanceof Error
        ? error.message.replace(/^bridge_rejected:/, "")
        : "bridge_execute_failed";
    // Whether the native write happened is the one fact the caller needs and
    // cannot infer from a flat "not created". executeBridge tags the failure
    // with the phase it failed in, so the message can say which it was: a
    // refusal before any write, or a write whose outcome is unknown. The audit
    // that motivated this saw the Agent read "not created" for an action the
    // world had already performed, invent a cause, and re-dispatch it.
    return receiptResult(
      null,
      reasonCode,
      error instanceof Error ? writePhaseOf(error) : "write_unknown",
    );
  }
}

/** How far a failed dispatch got, read from the tag executeBridge attached. */
function writePhaseOf(error: Error): "not_written" | "write_unknown" {
  return error.message.startsWith("write_unknown:") ? "write_unknown" : "not_written";
}
async function executeBridge(
  integration: MoveCapableIntegration,
  dispatchAdmissionFactory: IntegrationDispatchAdmissionFactory,
  request: ExecutionRequest,
): Promise<ExecutionReceipt> {
  if (!integration.state.connected) {
    throw new Error("bridge_rejected:integration_not_ready");
  }
  if (Date.now() > request.deadlineMs) {
    throw new Error("bridge_rejected:expired_deadline");
  }
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
    // An explicit Mod rejection is authoritative proof that no native write
    // happened (the Mod returns it before routing, e.g. stale_snapshot or an
    // invalid envelope). Marking such a dispatch uncertain would turn a
    // provably-unstarted action into a recovery obligation and invite a replay
    // the authority never asked for. Only a failure that leaves the write
    // outcome genuinely unknown becomes uncertain.
    if (!isAuthoritativeRejection(error)) {
      await admission.observer.markUncertain(dispatch);
    } else {
      await admission.observer.markAuthoritativelyRejected(dispatch);
    }
    // Tag the failure with the phase so the caller can say which it was. A
    // refusal carries bridge_rejected:* and proves no write; anything else
    // happened after the request reached the bridge and its outcome is unknown.
    const reason = error instanceof Error ? error.message : "bridge_execute_failed";
    throw new Error(isAuthoritativeRejection(error) ? reason : `write_unknown:${reason}`);
  }
}

/**
 * The bridge answers a refusal with `bridge_rejected:<reasonCode>`; that is the
 * authoritative "not accepted" signal produced before any native dispatch.
 * Transport faults, timeouts, and unexpected shapes stay unknown on purpose.
 */
function isAuthoritativeRejection(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("bridge_rejected:");
}

function receiptResult(
  receipt: ExecutionReceipt | null,
  reasonCode: string | null,
  writePhase: "not_written" | "write_unknown" = "not_written",
) {
  // The failure text states whether the world changed. "Not created" is only
  // true when the refusal happened before any write; otherwise the caller is
  // told the outcome is unknown and must not assume nothing happened.
  const failureText =
    writePhase === "write_unknown"
      ? `Game action outcome is unknown: ${reasonCode}. The request reached the bridge, so the world may have changed - do not re-issue it; observe the world to determine what happened.`
      : `Game action was not created: ${reasonCode}. Nothing was written; the world is unchanged.`;
  return {
    content: [
      {
        type: "text" as const,
        text: receipt === null ? failureText : JSON.stringify(receipt),
      },
    ],
    details: {
      receiptJson: receipt === null ? null : JSON.stringify(receipt),
      reasonCode,
      writePhase,
    },
  };
}
