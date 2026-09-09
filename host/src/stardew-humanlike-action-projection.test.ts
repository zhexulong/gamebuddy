import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";

import {
  DEFAULT_ACTION_POLICY,
  isCandidateActionId,
  isCandidateDescriptorComplete,
  STARDEW_ACTION_ADAPTERS,
  STARDEW_ACTION_TOOL_NAMES,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import {
  buildCandidateToolSchema,
  createStardewActionTools,
  createStardewObservationTools,
  type MoveCapableIntegration,
} from "./game-tools.js";
import {
  type ActionRegistration,
  type ActionRegistrationDescriptor,
  type ExecutionReceipt,
  type ExecutionRequest,
  isValidActionDescriptor,
  type Scope,
  validateExecutionRequest,
} from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_projection_test",
  worldId: "world_projection_test",
  playerId: "player_projection_test",
  companionId: "companion_projection_test",
};

const MOD_EMOTE_ENUM_22 = Object.freeze([
  "happy", "sad", "heart", "exclamation", "note", "sleep", "game", "question",
  "x", "pause", "blush", "angry", "yes", "no", "sick", "laugh", "surprised",
  "hi", "taunt", "uh", "music", "jar",
]);

const MOD_DIRECTION_ENUM_4 = Object.freeze([
  "up", "right", "down", "left",
]);

const VALID_EXPRESS_EMOTE_DESCRIPTOR: ActionRegistrationDescriptor = Object.freeze({
  arguments: Object.freeze([
    Object.freeze({
      name: "emote",
      type: "string",
      enum: MOD_EMOTE_ENUM_22,
    }),
  ]),
  outputFacts: Object.freeze({}),
  resourceTemplate: Object.freeze({
    claims: Object.freeze([{ key: "embodied_actor", value: "ScopePlayer" }]),
  }),
  effect: "write",
  postcondition: "emote_finished_or_overridden",
  nativeBinding: "Farmer.doEmote",
});

const VALID_FACE_DIRECTION_DESCRIPTOR: ActionRegistrationDescriptor = Object.freeze({
  arguments: Object.freeze([
    Object.freeze({
      name: "direction",
      type: "string",
      enum: MOD_DIRECTION_ENUM_4,
    }),
  ]),
  outputFacts: Object.freeze({}),
  resourceTemplate: Object.freeze({
    claims: Object.freeze([{ key: "embodied_actor", value: "ScopePlayer" }]),
  }),
  effect: "write",
  postcondition: "actor_facing_matches",
  nativeBinding: "Farmer.faceDirection",
});

function createTestAdmission() {
  return () => ({
    observer: {
      beforeWrite: async () => {},
      bindReceipt: async () => {},
      markUncertain: async () => {},
    },
    owner: {
      ownerId: "test_owner",
      epoch: 1,
    },
    cancelExact: async (_requestId: string, _executionId: string, _reasonCode: string) => {},
  });
}

function createIntegration(options: {
  connected?: boolean;
  capabilities?: readonly string[];
  snapshotCapabilities?: readonly string[];
  revision?: number;
  catalogRegistrations?: readonly ActionRegistration[];
  execute?: MoveCapableIntegration["execute"];
}): MoveCapableIntegration {
  const catalogRegistrations = options.catalogRegistrations ?? TEST_MOD_REGISTRATIONS;
  const execute = options.execute ?? (async (req: ExecutionRequest): Promise<ExecutionReceipt> => ({
    executionId: "exec_test_01",
    requestId: req.requestId,
    actionId: req.action,
    state: "succeeded",
    reasonCode: req.action === "express_emote" ? "emote_finished_or_overridden" : "actor_facing_matches",
    revision: options.revision ?? 1,
    evidence: { detail: JSON.stringify({ ...req.args }) },
  }));

  return {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      const connected = options.connected ?? true;
      const capabilities = options.capabilities ?? [];
      const snapshotCapabilities = options.snapshotCapabilities ?? capabilities;
      const revision = options.revision ?? 1;
      return {
        connected,
        sessionId: connected ? "sess_test_01" : null,
        capabilities,
        catalogRevision: revision,
        enabledActionIds: capabilities,
        snapshot: connected
          ? {
              revision,
              location: "Farm",
              tile: { x: 10, y: 15 },
              stamina: 100,
              health: 100,
              actionable: true,
              capabilities: snapshotCapabilities,
              catalogRevision: revision,
              enabledActionIds: snapshotCapabilities,
              presentationLocale: "en-US",
              activeExecution: null,
            }
          : null,
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations,
      };
    },
    execute,
    cancel: async () => {
      throw new Error("unexpected_cancel");
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Candidate TypeBox schema derivation from descriptors
// ---------------------------------------------------------------------------

test("candidate action schemas are derived dynamically from Mod descriptor enums", () => {
  const emoteSchema = buildCandidateToolSchema("express_emote", VALID_EXPRESS_EMOTE_DESCRIPTOR);
  assert.equal((emoteSchema as { additionalProperties?: unknown }).additionalProperties, false);
  // Validates every one of the 22 emotes
  for (const emote of MOD_EMOTE_ENUM_22) {
    assert.equal(Value.Check(emoteSchema, { emote }), true, `Emote "${emote}" should be accepted`);
  }
  // Rejects unknown emotes
  assert.equal(Value.Check(emoteSchema, { emote: "not_a_valid_emote" }), false);
  assert.equal(Value.Check(emoteSchema, { emote: "" }), false);
  assert.equal(Value.Check(emoteSchema, {}), false);
  // Rejects extraneous properties (requestId, idempotencyKey, socialTarget)
  assert.equal(Value.Check(emoteSchema, { emote: "happy", requestId: "req_01" }), false);
  assert.equal(Value.Check(emoteSchema, { emote: "happy", target: "farmer" }), false);

  const directionSchema = buildCandidateToolSchema("face_direction", VALID_FACE_DIRECTION_DESCRIPTOR);
  assert.equal((directionSchema as { additionalProperties?: unknown }).additionalProperties, false);
  // Validates all 4 cardinal directions
  for (const direction of MOD_DIRECTION_ENUM_4) {
    assert.equal(Value.Check(directionSchema, { direction }), true, `Direction "${direction}" should be accepted`);
  }
  // Rejects invalid directions
  assert.equal(Value.Check(directionSchema, { direction: "north" }), false);
  assert.equal(Value.Check(directionSchema, { direction: "diagonal" }), false);
  assert.equal(Value.Check(directionSchema, {}), false);
  assert.equal(Value.Check(directionSchema, { direction: "up", idempotencyKey: "idem_01" }), false);
});

test("candidate schemas do NOT hardcode enums: custom Mod descriptor enums are respected", () => {
  const customEmoteDescriptor: ActionRegistrationDescriptor = {
    ...VALID_EXPRESS_EMOTE_DESCRIPTOR,
    arguments: [{ name: "emote", type: "string", enum: ["custom_sparkle", "custom_nod"] }],
  };
  const customSchema = buildCandidateToolSchema("express_emote", customEmoteDescriptor);
  assert.equal(Value.Check(customSchema, { emote: "custom_sparkle" }), true);
  assert.equal(Value.Check(customSchema, { emote: "custom_nod" }), true);
  assert.equal(Value.Check(customSchema, { emote: "happy" }), false); // Not in custom enum!
});

// ---------------------------------------------------------------------------
// 2. Strict filtering of candidate actions while Experimental
// ---------------------------------------------------------------------------

test("candidate actions with lifecycle: 'experimental' are strictly excluded from visibleActionsFromModCatalog", () => {
  const experimentalCatalog: readonly ActionRegistration[] = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "experimental",
      kind: "execution",
      descriptor: VALID_EXPRESS_EMOTE_DESCRIPTOR,
    },
    {
      actionId: "face_direction",
      familyId: "movement_navigation",
      identityVersion: 1,
      lifecycle: "experimental",
      kind: "execution",
      descriptor: VALID_FACE_DIRECTION_DESCRIPTOR,
    },
    {
      actionId: "equip_tool",
      familyId: "body_tools",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
    },
  ];

  const visible = visibleActionsFromModCatalog(
    experimentalCatalog,
    ["express_emote", "face_direction", "equip_tool"],
    DEFAULT_ACTION_POLICY,
  );

  assert.deepEqual(
    visible.map((e) => e.actionId),
    ["equip_tool"],
    "Candidate actions must be hidden from agent visible actions while experimental",
  );
});

test("createStardewActionTools does NOT mount candidate tools while lifecycle is experimental", () => {
  const experimentalCatalog: readonly ActionRegistration[] = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "experimental",
      kind: "execution",
      descriptor: VALID_EXPRESS_EMOTE_DESCRIPTOR,
    },
    {
      actionId: "face_direction",
      familyId: "movement_navigation",
      identityVersion: 1,
      lifecycle: "experimental",
      kind: "execution",
      descriptor: VALID_FACE_DIRECTION_DESCRIPTOR,
    },
    {
      actionId: "equip_tool",
      familyId: "body_tools",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
    },
  ];

  const integration = createIntegration({
    capabilities: ["express_emote", "face_direction", "equip_tool"],
    catalogRegistrations: experimentalCatalog,
  });

  const tools = createStardewActionTools(integration, DEFAULT_ACTION_POLICY, createTestAdmission());
  const toolNames = tools.map((t) => t.name);

  assert.ok(toolNames.includes(STARDEW_ACTION_TOOL_NAMES.equip_tool), "equip_tool should be mounted");
  assert.ok(!toolNames.includes("stardew_express_emote"), "express_emote must NOT be mounted while experimental");
  assert.ok(!toolNames.includes("stardew_face_direction"), "face_direction must NOT be mounted while experimental");
});

test("observation catalog and search tools do not reveal experimental candidate actions", async () => {
  const experimentalCatalog: readonly ActionRegistration[] = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "experimental",
      kind: "execution",
      descriptor: VALID_EXPRESS_EMOTE_DESCRIPTOR,
    },
    {
      actionId: "equip_tool",
      familyId: "body_tools",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
    },
  ];

  const integration = createIntegration({
    capabilities: ["express_emote", "equip_tool"],
    catalogRegistrations: experimentalCatalog,
  });

  const obsTools = createStardewObservationTools(integration, DEFAULT_ACTION_POLICY);
  const catalogTool = obsTools.find((t) => t.name === "stardew_interaction_catalog")!;
  const result = await catalogTool.execute("test", {}, new AbortController().signal, () => {}, {} as never);
  const details = result.details as { actions: Array<{ actionId: string }> };

  assert.deepEqual(
    details.actions.map((a) => a.actionId),
    ["equip_tool"],
    "Observation catalog must not reveal experimental candidate actions",
  );
});

// ---------------------------------------------------------------------------
// 3. Complete descriptor requirement
// ---------------------------------------------------------------------------

test("candidate actions marked 'published' but lacking complete descriptor are excluded", () => {
  // Missing descriptor entirely
  const noDescriptor: ActionRegistration = {
    actionId: "express_emote",
    familyId: "expression",
    identityVersion: 1,
    lifecycle: "published",
    kind: "execution",
  };

  // Descriptor missing enum
  const missingEnum: ActionRegistration = {
    actionId: "express_emote",
    familyId: "expression",
    identityVersion: 1,
    lifecycle: "published",
    kind: "execution",
    descriptor: {
      ...VALID_EXPRESS_EMOTE_DESCRIPTOR,
      arguments: [{ name: "emote", type: "string" }], // No enum!
    },
  };

  // Descriptor with empty enum
  const emptyEnum: ActionRegistration = {
    actionId: "express_emote",
    familyId: "expression",
    identityVersion: 1,
    lifecycle: "published",
    kind: "execution",
    descriptor: {
      ...VALID_EXPRESS_EMOTE_DESCRIPTOR,
      arguments: [{ name: "emote", type: "string", enum: [] }],
    },
  };

  // Descriptor missing native binding
  const missingNative: ActionRegistration = {
    actionId: "express_emote",
    familyId: "expression",
    identityVersion: 1,
    lifecycle: "published",
    kind: "execution",
    descriptor: {
      ...VALID_EXPRESS_EMOTE_DESCRIPTOR,
      nativeBinding: undefined,
    },
  };

  const catalog = [noDescriptor, missingEnum, emptyEnum, missingNative];
  const visible = visibleActionsFromModCatalog(catalog, ["express_emote"], DEFAULT_ACTION_POLICY);
  assert.equal(visible.length, 0, "Incomplete candidate descriptors must be excluded from visible actions");

  assert.equal(isCandidateDescriptorComplete("express_emote", undefined), false);
  assert.equal(isCandidateDescriptorComplete("express_emote", missingEnum.descriptor), false);
  assert.equal(isCandidateDescriptorComplete("express_emote", emptyEnum.descriptor), false);
  assert.equal(isCandidateDescriptorComplete("express_emote", missingNative.descriptor), false);
  assert.equal(isCandidateDescriptorComplete("express_emote", VALID_EXPRESS_EMOTE_DESCRIPTOR), true);
  assert.equal(isCandidateDescriptorComplete("face_direction", VALID_FACE_DIRECTION_DESCRIPTOR), true);
});

test("descriptor with unknown keys is rejected by isValidActionDescriptor", () => {
  const unknownKeyDescriptor = {
    ...VALID_EXPRESS_EMOTE_DESCRIPTOR,
    unknownField: "malicious_payload",
  };
  assert.equal(isValidActionDescriptor(unknownKeyDescriptor), false);
  assert.equal(isCandidateDescriptorComplete("express_emote", unknownKeyDescriptor as never), false);
});

test("when published, complete descriptor and capability are present, candidate tools ARE mounted", () => {
  const publishedCatalog: readonly ActionRegistration[] = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
      descriptor: VALID_EXPRESS_EMOTE_DESCRIPTOR,
    },
    {
      actionId: "face_direction",
      familyId: "movement_navigation",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
      descriptor: VALID_FACE_DIRECTION_DESCRIPTOR,
    },
  ];

  const integration = createIntegration({
    capabilities: ["express_emote", "face_direction"],
    catalogRegistrations: publishedCatalog,
  });

  const tools = createStardewActionTools(integration, DEFAULT_ACTION_POLICY, createTestAdmission());
  const toolNames = tools.map((t) => t.name);

  assert.ok(toolNames.includes("stardew_express_emote"), "Published express_emote should be mounted");
  assert.ok(toolNames.includes("stardew_face_direction"), "Published face_direction should be mounted");

  const emoteTool = tools.find((t) => t.name === "stardew_express_emote")!;
  assert.equal(emoteTool.parameters.additionalProperties, false);
});

// ---------------------------------------------------------------------------
// 4. Execution wrapper & parameter encapsulation
// ---------------------------------------------------------------------------

test("stardew_express_emote forwards { emote } without exposing request/idempotency keys in agent schema", async () => {
  const publishedCatalog: readonly ActionRegistration[] = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
      descriptor: VALID_EXPRESS_EMOTE_DESCRIPTOR,
    },
  ];

  let executedRequest: ExecutionRequest | null = null;
  const integration = createIntegration({
    capabilities: ["express_emote"],
    catalogRegistrations: publishedCatalog,
    execute: async (req) => {
      executedRequest = req;
      return {
        executionId: "exec_e_1",
        requestId: req.requestId,
        actionId: req.action,
        state: "succeeded",
        reasonCode: "emote_finished_or_overridden",
        revision: 1,
        evidence: { detail: JSON.stringify({ emote: req.args.emote }) },
      };
    },
  });

  const tools = createStardewActionTools(integration, DEFAULT_ACTION_POLICY, createTestAdmission());
  const emoteTool = tools.find((t) => t.name === "stardew_express_emote")!;

  // The tool schema does not have requestId or idempotencyKey
  const schemaKeys = Object.keys(emoteTool.parameters.properties ?? {});
  assert.deepEqual(schemaKeys, ["emote"], "Only emote should be visible to agent");

  const result = await emoteTool.execute("call_1", { emote: "heart" }, new AbortController().signal, () => {}, {} as never);
  assert.equal(executedRequest !== null, true);
  assert.equal((executedRequest as ExecutionRequest | null)?.action, "express_emote");
  assert.deepEqual((executedRequest as ExecutionRequest | null)?.args, { emote: "heart" });
  assert.ok((executedRequest as ExecutionRequest | null)?.requestId, "Host wrapper generated requestId");
  assert.ok((executedRequest as ExecutionRequest | null)?.idempotencyKey, "Host wrapper generated idempotencyKey");
  assert.equal((result.details as any).reasonCode, null);
});

test("stardew_face_direction forwards { direction } without exposing request/idempotency keys in agent schema", async () => {
  const publishedCatalog: readonly ActionRegistration[] = [
    {
      actionId: "face_direction",
      familyId: "movement_navigation",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
      descriptor: VALID_FACE_DIRECTION_DESCRIPTOR,
    },
  ];

  let executedRequest: ExecutionRequest | null = null;
  const integration = createIntegration({
    capabilities: ["face_direction"],
    catalogRegistrations: publishedCatalog,
    execute: async (req) => {
      executedRequest = req;
      return {
        executionId: "exec_f_1",
        requestId: req.requestId,
        actionId: req.action,
        state: "succeeded",
        reasonCode: "actor_facing_matches",
        revision: 1,
        evidence: { detail: JSON.stringify({ direction: req.args.direction }) },
      };
    },
  });

  const tools = createStardewActionTools(integration, DEFAULT_ACTION_POLICY, createTestAdmission());
  const faceTool = tools.find((t) => t.name === "stardew_face_direction")!;

  const schemaKeys = Object.keys(faceTool.parameters.properties ?? {});
  assert.deepEqual(schemaKeys, ["direction"], "Only direction should be visible to agent");

  await faceTool.execute("call_2", { direction: "right" }, new AbortController().signal, () => {}, {} as never);
  assert.equal(executedRequest !== null, true);
  assert.equal((executedRequest as ExecutionRequest | null)?.action, "face_direction");
  assert.deepEqual((executedRequest as ExecutionRequest | null)?.args, { direction: "right" });
});

// ---------------------------------------------------------------------------
// 5. Pre-dispatch rechecks (connection, capability, policy, revision, deadline)
// ---------------------------------------------------------------------------

test("pre-dispatch recheck: withdrawn capability fails closed at execution time", async () => {
  const publishedCatalog: readonly ActionRegistration[] = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
      descriptor: VALID_EXPRESS_EMOTE_DESCRIPTOR,
    },
  ];

  let currentCaps = ["express_emote"];
  const integration = createIntegration({
    get capabilities() {
      return currentCaps;
    },
    catalogRegistrations: publishedCatalog,
  });

  const tools = createStardewActionTools(integration, DEFAULT_ACTION_POLICY, createTestAdmission());
  const emoteTool = tools.find((t) => t.name === "stardew_express_emote")!;

  // Withdraw capability dynamically before invocation
  currentCaps = [];
  const result = await emoteTool.execute("call_3", { emote: "happy" }, new AbortController().signal, () => {}, {} as never);
  assert.equal((result.details as any).reasonCode, "capability_not_declared");
});

test("pre-dispatch recheck: disconnected integration fails closed at execution time", async () => {
  const publishedCatalog: readonly ActionRegistration[] = [
    {
      actionId: "express_emote",
      familyId: "expression",
      identityVersion: 1,
      lifecycle: "published",
      kind: "execution",
      descriptor: VALID_EXPRESS_EMOTE_DESCRIPTOR,
    },
  ];

  let connected = true;
  const integration: MoveCapableIntegration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    get state() {
      return {
        connected,
        sessionId: connected ? "sess_01" : null,
        capabilities: ["express_emote"],
        catalogRevision: 1,
        enabledActionIds: ["express_emote"],
        snapshot: connected
          ? {
              revision: 1,
              location: "Farm",
              tile: { x: 10, y: 15 },
              stamina: 100,
              health: 100,
              actionable: true,
              capabilities: ["express_emote"],
              catalogRevision: 1,
              enabledActionIds: ["express_emote"],
              presentationLocale: "en-US",
              activeExecution: null,
            }
          : null,
        latestReceipt: null,
        latestReasonCode: null,
        catalogRegistrations: publishedCatalog,
      };
    },
    execute: async () => {
      throw new Error("should_not_reach_bridge");
    },
    cancel: async () => {
      throw new Error("unexpected");
    },
  };

  const tools = createStardewActionTools(integration, DEFAULT_ACTION_POLICY, createTestAdmission());
  const emoteTool = tools.find((t) => t.name === "stardew_express_emote")!;

  // Disconnect before execute
  connected = false;
  const result = await emoteTool.execute("call_4", { emote: "happy" }, new AbortController().signal, () => {}, {} as never);
  assert.equal((result.details as any).reasonCode, "integration_not_ready");
});

// ---------------------------------------------------------------------------
// 6. Existing tools (especially equip_tool) remain unimpacted
// ---------------------------------------------------------------------------

test("equip_tool and existing published actions remain completely unimpacted", async () => {
  const integration = createIntegration({
    capabilities: ["equip_tool", "move_to_tile"],
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
  });

  const tools = createStardewActionTools(integration, DEFAULT_ACTION_POLICY, createTestAdmission());
  const equipTool = tools.find((t) => t.name === "stardew_equip_tool");
  assert.ok(equipTool !== undefined, "equip_tool must remain mounted");
  assert.equal(equipTool?.parameters.properties?.slot !== undefined, true);

  const moveTool = tools.find((t) => t.name === "stardew_move_to_tile");
  assert.ok(moveTool !== undefined, "move_to_tile must remain mounted");
});

test("validateExecutionRequest validates candidate actions and preserves equip_tool semantics", () => {
  const snapshot = {
    revision: 5,
    location: "Farm",
    tile: { x: 1, y: 1 },
    stamina: 100,
    health: 100,
    actionable: true,
    capabilities: ["equip_tool", "express_emote", "face_direction"],
    catalogRevision: 1,
    enabledActionIds: ["equip_tool", "express_emote", "face_direction"],
    presentationLocale: "en-US",
    activeExecution: null,
  };

  const now = 1000;

  // equip_tool continues to validate exactly
  assert.equal(
    validateExecutionRequest(
      {
        requestId: "req_eq_1",
        idempotencyKey: "idem_eq_1",
        action: "equip_tool",
        args: { slot: 3 },
        expectedRevision: 5,
        deadlineMs: now + 5000,
      },
      snapshot as any,
      now,
    ),
    null,
  );

  // express_emote validates with valid args
  assert.equal(
    validateExecutionRequest(
      {
        requestId: "req_em_1",
        idempotencyKey: "idem_em_1",
        action: "express_emote",
        args: { emote: "happy" },
        expectedRevision: 5,
        deadlineMs: now + 5000,
      },
      snapshot as any,
      now,
    ),
    null,
  );

  // express_emote rejects invalid args
  assert.equal(
    validateExecutionRequest(
      {
        requestId: "req_em_2",
        idempotencyKey: "idem_em_2",
        action: "express_emote",
        args: { emote: "" },
        expectedRevision: 5,
        deadlineMs: now + 5000,
      },
      snapshot as any,
      now,
    ),
    "invalid_emote",
  );

  // face_direction validates with valid args
  assert.equal(
    validateExecutionRequest(
      {
        requestId: "req_fd_1",
        idempotencyKey: "idem_fd_1",
        action: "face_direction",
        args: { direction: "up" },
        expectedRevision: 5,
        deadlineMs: now + 5000,
      },
      snapshot as any,
      now,
    ),
    null,
  );

  // face_direction rejects invalid args
  assert.equal(
    validateExecutionRequest(
      {
        requestId: "req_fd_2",
        idempotencyKey: "idem_fd_2",
        action: "face_direction",
        args: { direction: "" },
        expectedRevision: 5,
        deadlineMs: now + 5000,
      },
      snapshot as any,
      now,
    ),
    "invalid_direction",
  );
});
