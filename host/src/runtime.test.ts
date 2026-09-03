import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readdir,
  realpath,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createDeterministicBridgePair } from "./bridge.js";
import {
  DEFAULT_IDENTITY_PROFILE,
  identityProfileHash,
} from "./identity-profile.js";
import { GameConnectionTestClient } from "./test-support/game-connection-test-client.js";
import { GAMEPLAY_SUBAGENT_MODEL_CONFIG } from "./gameplay-task-subagent.js";
import {
  createIntegrationActionCatalog,
  type GameIntegrationAdapter,
} from "./game-integration-adapter.js";
import type { KnowledgeBundle } from "./knowledge.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { Scope } from "./protocol.js";
import {
  actionRegistryRevision,
  type CompanionRunManifest,
} from "./run-manifest.js";
import {
  companionStatusTool,
  createCompanionRuntime,
  createCompanionStatusTool,
  createGameCompanionRuntime,
  DEFAULT_COMPANION_MODEL_CONFIG,
  identityKey,
  MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
  MAGIC_CONTEXT_HISTORIAN_ENABLED,
  MAGIC_CONTEXT_MEMORY_DOMAIN,
  MAGIC_CONTEXT_MEMORY_ENABLED,
  MAGIC_CONTEXT_RECALL_ENABLED,
  PHASE_0B_ALLOWED_TOOL_NAMES,
  resolveMagicContextExtensionEntry,
  resolveRuntimePaths,
} from "./runtime.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { createMaterializedGameCompanionRuntime } from "./game-runtime-fixed-tools.internal.js";
import type { GameConnection } from "./game-connection.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

// The compiled test artifact is deliberately not a production artifact, so
// path-lock's default resolver rejects repository helpers. Every runtime
// bootstrap writes an identity profile through the durable path lock, so mint
// the build-only reclaimer capability once before any test runs.
before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

function canonicalStableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalStableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalStableJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA ?? tmpdir() : tmpdir();
  return realpath(root);
}

const identity = Object.freeze({
  playerId: "player_01",
  saveId: "save_01",
  worldId: "world_01",
  companionId: "companion_01",
});

test("opaque identity keys partition contexts without display names", () => {
  const first = identityKey(identity);
  const second = identityKey({ ...identity, saveId: "save_02" });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.throws(
    () => identityKey({ ...identity, playerId: "Player One" }),
    /opaque identifier/,
  );
});

test("runtime paths stay outside the repository workspace", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase0b-"));
  const paths = resolveRuntimePaths(identity, root);

  assert.equal(paths.root, root);
  assert.match(paths.runtimeCwd, /contexts/);
  assert.match(paths.agentDir, /pi-agent/);
  assert.match(paths.sessionDir, /sessions/);
});

test("continuity identity is stable across surfaces while legacy game identities stay scoped", () => {
  const chat = identityKey({
    playerId: identity.playerId,
    companionId: identity.companionId,
    continuityId: "continuity_01",
  });
  const game = identityKey({ ...identity, continuityId: "continuity_01" });
  assert.equal(chat, game);
  assert.notEqual(
    chat,
    identityKey({
      playerId: identity.playerId,
      companionId: identity.companionId,
      continuityId: "continuity_02",
    }),
  );
  assert.notEqual(
    identityKey(identity),
    identityKey({ ...identity, saveId: "save_02" }),
  );
});

test("offline runtime exposes only its deterministic Companion status tool", async () => {
  const tool = companionStatusTool;
  const result = await tool.execute(
    "test-call",
    {},
    new AbortController().signal,
    () => {},
    {} as never,
  );

  assert.deepEqual(PHASE_0B_ALLOWED_TOOL_NAMES, ["companion_status"]);
  const firstContent = result.content[0];
  assert.equal(firstContent?.type, "text");
  assert.match(
    firstContent?.type === "text" ? firstContent.text : "",
    /"connected":false/,
  );
});

test("mounted Companion status reports live integration facts without inferring success", async () => {
  const integration = {
    scope: {
      integrationId: "stardew",
      saveId: identity.saveId,
      worldId: identity.worldId,
      playerId: identity.playerId,
      companionId: identity.companionId,
    },
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["equip_tool"],
      snapshot: {
        revision: 9,
        location: "Farm",
        tile: { x: 1, y: 2 },
        stamina: 100,
        health: 100,
        actionable: true,
        capabilities: ["equip_tool"],
        catalogRevision: 1,
        enabledActionIds: ["equip_tool"],
        presentationLocale: "en-US",
        activeExecution: null,
      },
      latestReceipt: {
        executionId: "execution_01",
        requestId: "request_01",
        state: "accepted" as const,
        reasonCode: "accepted",
        revision: 9,
        evidence: null,
      },
      latestReasonCode: null,
    },
  };
  const result = await createCompanionStatusTool(integration).execute(
    "status",
    {},
    new AbortController().signal,
    () => {},
    {} as never,
  );
  assert.equal((result.details as { connected: boolean }).connected, true);
  assert.deepEqual(
    (result.details as { capabilities: readonly string[] }).capabilities,
    ["equip_tool"],
  );
  assert.equal(
    (result.details as { snapshotRevision: number }).snapshotRevision,
    9,
  );
  assert.equal(
    (result.details as { latestReceiptState: string }).latestReceiptState,
    "accepted",
  );
  assert.doesNotMatch(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    /succeeded/,
  );
});

test("runtime mounts a fake integration through the module port", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-fake-integration-runtime-"),
  );
  const entries = [{ actionId: "activate_console" }];
  const registrations = [
    {
      actionId: "activate_console",
      familyId: "arcade_interaction",
      identityVersion: 1,
      lifecycle: "published" as const,
      kind: "execution" as const,
    },
  ];
  const catalog = createIntegrationActionCatalog(
    entries,
    (actionId, receipt) =>
      actionId === "activate_console" &&
      receipt.state === "succeeded" &&
      receipt.reasonCode === "console_activated" &&
      receipt.evidence?.postcondition === "active",
  );
  const activateConsole = defineTool({
    name: "arcade_activate_console",
    label: "Activate arcade console",
    description: "Fake action used only to validate the module seam.",
    parameters: Type.Object({
      consoleId: Type.String({ minLength: 1, maxLength: 32 }),
    }),
    execute: async (_toolCallId, params) => ({
      content: [
        { type: "text" as const, text: `activated:${params.consoleId}` },
      ],
      details: {
        receiptJson: JSON.stringify({
          requestId: "request_01",
          executionId: "execution_01",
          state: "succeeded",
          reasonCode: "console_activated",
          revision: 1,
          evidence: { postcondition: "active" },
        }),
      },
    }),
  });
  const fake: GameIntegrationAdapter = {
    descriptor: Object.freeze({
      integrationId: "test-arcade",
      version: "fixture-v1",
      toolNamePrefix: "arcade_",
    }),
    actionCatalog: catalog,
    defaultPolicy: Object.freeze({
      policyVersion: 1 as const,
      deniedActions: [],
      deniedFamilies: [],
    }),
    parsePolicy: (value: unknown) => value as never,
    actorId: () => identity.playerId,
    assertIdentityBinding: (_connection, boundIdentity) => {
      if (
        boundIdentity.companionId !== identity.companionId
      )
        throw new Error("integration_identity_binding_mismatch");
    },
    worldScope: () => null,
    createToolSet: ({ connection, policy, dispatchAdmissionFactory }) => ({
      observation: [],
      actions:
        dispatchAdmissionFactory !== undefined &&
        catalog
          .visibleActions(
            registrations,
            (connection.state as { capabilities: readonly string[] })
              .capabilities,
            policy,
          )
          .some((entry) => entry.actionId === "activate_console")
          ? [activateConsole]
          : [],
      knowledge: [],
    }),
    knowledgeMetadata: () => ({
      mounted: false,
      gameVersion: null,
      bundleVersion: null,
    }),
    status: (connection) => ({
      connected: true,
      capabilities: (connection.state as { capabilities: readonly string[] })
        .capabilities,
      capabilityRevision: 1,
      snapshotRevision: 1,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    readState: (connection) => ({
      connected: true,
      sessionId: "arcade_session_01",
      capabilities: (connection.state as { capabilities: readonly string[] })
        .capabilities,
      registrations,
      capabilityRevision: 1,
      snapshotRevision: 1,
      presentationLocale: "en-US",
      activeExecution: null,
      latestReceipt: null,
      latestReasonCode: null,
    }),
    cancelExecution: () => "not_supported",
    parseReceipt: () => null,
    actionIdForToolName: (toolName) =>
      toolName === "arcade_activate_console" ? "activate_console" : null,
    isCancellationTool: () => false,
  };
  const integrationState = { capabilities: ["activate_console"], registrations };
  const integration = {
    scope: { integrationId: "test-arcade" },
    executionGate: { executable: true },
    module: fake,
    state: integrationState,
  } as never;
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    assert.deepEqual(
      runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
      ["arcade_activate_console", "companion_status", "todowrite"],
    );
    const manifest = JSON.parse(
      await readFile(runtime.paths.runManifestPath, "utf8"),
    ) as CompanionRunManifest;
    assert.equal(
      manifest.actionRegistryRevision,
      actionRegistryRevision(registrations),
    );
    assert.doesNotMatch(JSON.stringify(manifest.mountedTools), /stardew_/);

    // A live capability loss is consumed only after the idle barrier by the
    // private refresher. The session receives a new whole projection, not a
    // stale action closure or a second registry.
    integrationState.capabilities = [];
    await runtime.refreshIntegrationTools?.();
    assert.deepEqual(
      runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
      ["companion_status", "todowrite"],
    );
  } finally {
    runtime.session.dispose();
  }
});

test("runtime refresh waits for Pi idle and coalesces to the current adapter projection", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-runtime-refresh-idle-"));
  const registrations = [
    {
      actionId: "activate_console",
      familyId: "arcade_interaction",
      identityVersion: 1,
      lifecycle: "published" as const,
      kind: "execution" as const,
    },
  ];
  let capabilities: string[] = ["activate_console"];
  let refreshMaterializations = 0;
  let releaseIdle: (() => void) | undefined;
  const idle = new Promise<void>((resolvePromise) => {
    releaseIdle = resolvePromise;
  });
  const module: GameIntegrationAdapter = {
    descriptor: { integrationId: "test-arcade", version: "fixture-v1", toolNamePrefix: "arcade_" },
    actionCatalog: createIntegrationActionCatalog([{ actionId: "activate_console" }]),
    defaultPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] },
    parsePolicy: (value) => value as never,
    actorId: () => "fixture_actor",
    assertIdentityBinding: () => undefined,
    worldScope: () => null,
    createToolSet: ({ connection }) => {
      const materialization = ++refreshMaterializations;
      return {
        observation: [],
        actions:
          (connection.state as { capabilities: readonly string[] }).capabilities.length === 0
            ? []
            : [
                defineTool({
                  name: "arcade_activate_console",
                  label: "Activate arcade console",
                  description: "Fixture action.",
                  parameters: Type.Object({}),
                  execute: async () => ({
                    content: [{ type: "text", text: `materialization=${materialization}` }],
                    details: {},
                  }),
                }),
              ],
        knowledge: [],
      };
    },
    knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
    status: () => ({
      connected: true,
      capabilities,
      capabilityRevision: 1,
      snapshotRevision: 1,
      latestReceiptState: null,
      latestReasonCode: null,
    }),
    readState: () => ({
      connected: true,
      sessionId: "arcade_session_01",
      capabilities,
      registrations,
      capabilityRevision: 1,
      snapshotRevision: 1,
      activeExecution: null,
      latestReceipt: null,
      latestReasonCode: null,
    }),
    cancelExecution: () => "not_supported",
    parseReceipt: () => null,
    actionIdForToolName: (toolName) => toolName === "arcade_activate_console" ? "activate_console" : null,
    isCancellationTool: () => false,
  };
  const integration = {
    scope: { integrationId: "test-arcade" },
    executionGate: { executable: true },
    module,
    get state() {
      return { capabilities, registrations };
    },
  } as never;
  const runtime = await createCompanionRuntime(identity, root, integration);
  const originalWaitForIdle = runtime.session.agent.waitForIdle.bind(runtime.session.agent);
  runtime.session.agent.waitForIdle = () => idle;
  try {
    capabilities = [];
    const withdrawal = runtime.refreshIntegrationTools?.();
    assert.deepEqual(
      runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
      ["arcade_activate_console", "companion_status", "todowrite"],
    );
    // Two updates during the same in-flight idle barrier must not install the
    // withdrawn surface transiently: the current Mod projection wins.
    capabilities = ["activate_console"];
    const reenablement = runtime.refreshIntegrationTools?.();
    releaseIdle?.();
    await Promise.all([withdrawal, reenablement]);
    assert.ok(refreshMaterializations > 1);
    assert.deepEqual(
      runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
      ["arcade_activate_console", "companion_status", "todowrite"],
    );
    const reenabled = runtime.session.agent.state.tools.find(
      (tool) => tool.name === "arcade_activate_console",
    );
    assert.ok(reenabled);
    const result = await reenabled.execute(
      "refresh_reenabled_call",
      {},
      new AbortController().signal,
    );
    assert.deepEqual(result, {
      content: [{ type: "text", text: `materialization=${refreshMaterializations}` }],
      details: {},
    });
  } finally {
    runtime.session.agent.waitForIdle = originalWaitForIdle;
    runtime.session.dispose();
  }
});

test("runtime rejects a mounted integration whose save identity does not match", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase3-scope-"));
  const wrongScope: Scope = {
    integrationId: "stardew",
    saveId: "other_save",
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const [hostEndpoint] = createDeterministicBridgePair(wrongScope);
  const integration = new GameConnectionTestClient(
    wrongScope,
    hostEndpoint,
    STARDEW_GAME_INTEGRATION_ADAPTER,
  );
  await assert.rejects(
    () => createCompanionRuntime(identity, root, integration),
    /integration_identity_binding_mismatch/,
  );
  integration.dispose();
});

test("generic runtime keeps an explicit game surface when the Host construction zone supplies it", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-game-surface-runtime-"));
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new GameConnectionTestClient(
    scope,
    hostEndpoint,
    STARDEW_GAME_INTEGRATION_ADAPTER,
  );
  const runtime = await createCompanionRuntime(
    { ...identity, continuityId: "continuity_01" },
    root,
    integration,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    "game_surface_01",
    undefined,
    "game",
  );
  try {
    assert.doesNotMatch(runtime.session.systemPrompt, /companion_text/);
    assert.doesNotMatch(runtime.session.systemPrompt, /private/);
    assert.match(runtime.session.systemPrompt, /<gamebuddy_companion_identity/);
    assert.equal(
      runtime.session.agent.state.tools.some(
        (tool) =>
          tool.name === "companion_text" || tool.name === "companion_speak",
      ),
      false,
    );
    assert.equal(runtime.paths.surfaceSessionId, "game_surface_01");
  } finally {
    runtime.session.dispose();
    integration.dispose();
  }
});

test("Chat surface runtime is a pure native-content dialogue surface with no mounted tools", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-chat-surface-runtime-"));
  const runtime = await createCompanionRuntime(
    { ...identity, continuityId: "continuity_chat_01" },
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    "chat_surface_01",
    undefined,
    "chat",
  );
  try {
    assert.doesNotMatch(runtime.session.systemPrompt, /companion_text/);
    assert.doesNotMatch(runtime.session.systemPrompt, /private/);
    assert.match(runtime.session.systemPrompt, /<gamebuddy_companion_identity/);
    assert.deepEqual(runtime.session.agent.state.tools, []);
    assert.equal(runtime.paths.surfaceSessionId, "chat_surface_01");
  } finally {
    runtime.session.dispose();
  }
});

test("public Game runtime cannot mount Body Program tools while the internal materialized path mounts exactly its frozen closure set", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-fixed-tools-"));
  const registrations = [{ actionId: "activate_console", familyId: "arcade", identityVersion: 1, lifecycle: "published" as const, kind: "execution" as const }];
  const policy = Object.freeze({ policyVersion: 1 as const, deniedActions: [], deniedFamilies: [] });
  const fixedTools = Object.freeze([
    "stardew_verify_action_program",
    "stardew_submit_action_program",
    "stardew_action_program_status",
    "stardew_action_program_events",
  ].map((name) => Object.freeze(defineTool({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }))));
  const connection = {
    scope: Object.freeze({ integrationId: "test-arcade" }),
    executionGate: { executable: true },
    state: Object.freeze({}),
    module: {
      descriptor: Object.freeze({ integrationId: "test-arcade", version: "fixture-v1", toolNamePrefix: "arcade_" }),
      actionCatalog: createIntegrationActionCatalog([{ actionId: "activate_console" }]),
      defaultPolicy: policy,
      parsePolicy: (value: unknown) => value as typeof policy,
      actorId: () => identity.playerId,
      assertIdentityBinding: () => undefined,
      worldScope: () => null,
      createToolSet: () => ({ observation: [], actions: [], knowledge: [] }),
      knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }),
      status: () => ({ connected: true, capabilities: [], capabilityRevision: 1, snapshotRevision: 1, latestReceiptState: null, latestReasonCode: null }),
      readState: () => ({ connected: true, sessionId: "session_01", capabilities: [], registrations, capabilityRevision: 1, snapshotRevision: 1, activeExecution: null, latestReceipt: null, latestReasonCode: null }),
      cancelExecution: () => "not_supported",
      parseReceipt: () => null,
      actionIdForToolName: () => null,
      isCancellationTool: () => false,
    },
  } as unknown as GameConnection;
  const publicRuntime = await createGameCompanionRuntime(identity, join(root, "public"), connection, "game_public_01", undefined, undefined, {
    gameplaySubagentEnabled: false,
    disableMagicContextMemory: true,
    hostBindingFactory: () => undefined,
  });
  const materializedRuntime = await createMaterializedGameCompanionRuntime(identity, join(root, "internal"), connection, "game_internal_01", undefined, undefined, {
    gameplaySubagentEnabled: false,
    disableMagicContextMemory: true,
    hostBindingFactory: () => undefined,
  }, Object.freeze({ fixedTools, resolvedPolicy: policy }));
  try {
    assert.deepEqual(publicRuntime.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status"]);
    assert.deepEqual(materializedRuntime.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", ...fixedTools.map((tool) => tool.name)].sort());
    assert.deepEqual(fixedTools.map((tool) => tool.name), ["stardew_verify_action_program", "stardew_submit_action_program", "stardew_action_program_status", "stardew_action_program_events"]);
  } finally {
    publicRuntime.session.dispose();
    materializedRuntime.session.dispose();
  }
});

test("fixed Game tools fail closed unless frozen, unique, and non-colliding", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-fixed-tool-rejections-"));
  const tool = defineTool({ name: "stardew_verify_action_program", label: "x", description: "x", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
  const connection = { scope: { integrationId: "test-arcade" }, executionGate: { executable: true }, state: {}, module: { descriptor: { integrationId: "test-arcade", version: "fixture-v1", toolNamePrefix: "arcade_" }, actionCatalog: createIntegrationActionCatalog([]), defaultPolicy: { policyVersion: 1, deniedActions: [], deniedFamilies: [] }, parsePolicy: (value: unknown) => value as never, actorId: () => identity.playerId, assertIdentityBinding: () => undefined, worldScope: () => null, createToolSet: () => ({ observation: [], actions: [], knowledge: [] }), knowledgeMetadata: () => ({ mounted: false, gameVersion: null, bundleVersion: null }), status: () => ({ connected: true, capabilities: [], capabilityRevision: 1, snapshotRevision: 1, latestReceiptState: null, latestReasonCode: null }), readState: () => ({ connected: true, sessionId: "session_01", capabilities: [], registrations: [], capabilityRevision: 1, snapshotRevision: 1, activeExecution: null, latestReceipt: null, latestReasonCode: null }), cancelExecution: () => "not_supported", parseReceipt: () => null, actionIdForToolName: () => null, isCancellationTool: () => false } } as unknown as GameConnection;
  const options = { gameplaySubagentEnabled: false, disableMagicContextMemory: true as const, hostBindingFactory: () => undefined };
  await assert.rejects(() => createMaterializedGameCompanionRuntime(identity, join(root, "mutable"), connection, "game_mutable_01", undefined, undefined, options, { fixedTools: [tool], resolvedPolicy: connection.module.defaultPolicy }), /fixed_runtime_tools_must_be_frozen/);
  const duplicate = Object.freeze([Object.freeze(tool), Object.freeze({ ...tool })]);
  await assert.rejects(() => createMaterializedGameCompanionRuntime(identity, join(root, "duplicate"), connection, "game_duplicate_01", undefined, undefined, options, { fixedTools: duplicate, resolvedPolicy: connection.module.defaultPolicy }), /fixed_runtime_tool_name_collision/);
  const collision = Object.freeze([Object.freeze(defineTool({ name: "companion_status", label: "x", description: "x", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }))]);
  await assert.rejects(() => createMaterializedGameCompanionRuntime(identity, join(root, "collision"), connection, "game_collision_01", undefined, undefined, options, { fixedTools: collision, resolvedPolicy: connection.module.defaultPolicy }), /runtime_tool_name_collision/);
});

test("formal Preview Game composition does not load Magic Context", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-preview-no-magic-context-"),
  );
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new GameConnectionTestClient(
    scope,
    hostEndpoint,
    STARDEW_GAME_INTEGRATION_ADAPTER,
  );
  const runtime = await createGameCompanionRuntime(
    identity,
    root,
    integration,
    "preview_session_01",
    undefined,
    undefined,
    {
      modelConfig: DEFAULT_COMPANION_MODEL_CONFIG,
      gameplaySubagentEnabled: false,
      disableMagicContextMemory: true,
      hostBindingFactory: () => undefined,
    },
  );
  try {
    assert.deepEqual(runtime.extensions, []);
    await assert.rejects(
      access(
        join(runtime.paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"),
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );
    const manifest = JSON.parse(
      await readFile(runtime.paths.runManifestPath, "utf8"),
    ) as CompanionRunManifest;
    assert.equal(manifest.featureFlags.magicContextMemoryEnabled, false);
    assert.equal(
      typeof runtime.recoverStardewExecutionReceipts,
      "function",
      "the game runtime must expose the explicit relaunch-only recovery closure",
    );
  } finally {
    runtime.session.dispose();
    integration.dispose();
  }
});

test("Stardew action tools fail closed when a connection lacks the launcher execution gate", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-runtime-no-execution-gate-"),
  );
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const integration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["equip_tool"],
      snapshot: {
        revision: 1,
        location: "Farm",
        tile: { x: 1, y: 2 },
        stamina: 100,
        health: 100,
        actionable: true,
        capabilities: ["equip_tool"],
        catalogRevision: 1,
        enabledActionIds: ["equip_tool"],
        presentationLocale: "en-US",
        activeExecution: null,
      },
      latestReceipt: null,
      latestReasonCode: null,
    },
    async execute() {
      throw new Error("must_not_execute");
    },
  };
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    assert.equal(
      runtime.session.agent.state.tools.some(
        (tool) => tool.name === "stardew_equip_tool",
      ),
      false,
    );
    assert.equal(
      runtime.session.agent.state.tools.some(
        (tool) => tool.name === "stardew_observe",
      ),
      true,
    );
  } finally {
    runtime.session.dispose();
  }
});

test("runtime composes a ledger admission before mounting and executing a live Stardew action", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-runtime-admission-"));
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  let executeWrites = 0;
  const integration = {
    scope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    executionGate: { executable: true },
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["equip_tool", "cancel_active_execution"],
      catalogRegistrations: [
        { actionId: "equip_tool", familyId: "body_tools", identityVersion: 1, lifecycle: "published", kind: "execution" },
      ],
      catalogRevision: 1,
      enabledActionIds: ["equip_tool"],
      snapshot: {
        revision: 1,
        location: "Farm",
        tile: { x: 1, y: 2 },
        stamina: 100,
        health: 100,
        actionable: true,
        capabilities: ["equip_tool", "cancel_active_execution"],
        catalogRevision: 1,
        enabledActionIds: ["equip_tool"],
        presentationLocale: "en-US",
        activeExecution: null,
      },
      latestReceipt: null,
      latestReasonCode: null,
    },
    async execute(request: { requestId: string }) {
      executeWrites++;
      return {
        requestId: request.requestId,
        executionId: "execution_equip_01",
        state: "succeeded" as const,
        reasonCode: "tool_selected",
        revision: 1,
        evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
      };
    },
    async cancel() {
      throw new Error("direct_adapter_cancel_must_not_be_reached");
    },
  };
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    const equip = runtime.session.agent.state.tools.find(
      (tool) => tool.name === "stardew_equip_tool",
    );
    assert.ok(equip);
    const result = await equip.execute(
      "runtime-admission-equip",
      {
        slot: 1,
        requestId: "runtime_request_01",
        idempotencyKey: "runtime_key_01",
      },
      new AbortController().signal,
    );
    assert.equal(executeWrites, 1);
    assert.match(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      /execution_equip_01/,
    );
    assert.equal(
      runtime.session.agent.state.tools.some(
        (tool) => tool.name === "stardew_cancel_active_execution",
      ),
      false,
    );
  } finally {
    runtime.interruptIntegrationExecutions?.("runtime_test_end");
    runtime.session.dispose();
  }
});

test("runtime mounts only the explicitly verified Stardew product tools", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase3-tools-"));
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new GameConnectionTestClient(
    scope,
    hostEndpoint,
    STARDEW_GAME_INTEGRATION_ADAPTER,
  );
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    // The executable action is absent until the Mod declares it in the
    // player-controlled capability snapshot. Observations remain factual.
    assert.deepEqual(
      runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
      [
        "companion_status",
        "stardew_execution_status",
        "stardew_interaction_catalog",
        "stardew_observe",
        "stardew_search_interactions",
        "todowrite",
      ],
    );
  } finally {
    runtime.session.dispose();
    integration.dispose();
  }
});

test("runtime materializes the optional gameplay subagent without exposing its tools to the parent by default", async () => {
  const offlineRoot = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-gameplay-subagent-offline-"),
  );
  const delegatedRoot = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-gameplay-subagent-enabled-"),
  );
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new GameConnectionTestClient(
    scope,
    hostEndpoint,
    STARDEW_GAME_INTEGRATION_ADAPTER,
  );
  const config = GAMEPLAY_SUBAGENT_MODEL_CONFIG;
  const offline = await createCompanionRuntime(identity, offlineRoot);
  try {
    assert.equal(
      offline.session.agent.state.tools.some(
        (tool) => tool.name === "delegate_game_task",
      ),
      false,
    );
  } finally {
    offline.session.dispose();
  }
  const delegated = await createCompanionRuntime(
    identity,
    delegatedRoot,
    integration,
    config,
    undefined,
    undefined,
    true,
  );
  try {
    assert.ok(delegated.gameplaySubagent);
    assert.deepEqual(delegated.gameplaySubagent.modelConfig, config);
    const manifest = JSON.parse(
      await readFile(delegated.paths.runManifestPath, "utf8"),
    );
    assert.deepEqual(manifest.model, GAMEPLAY_SUBAGENT_MODEL_CONFIG);
    assert.deepEqual(manifest.gameplaySubagentModel, config);
    assert.equal(
      delegated.session.agent.state.tools.some(
        (tool) => tool.name === "delegate_game_task",
      ),
      true,
    );
    assert.deepEqual(
      delegated.session.agent.state.tools
        .filter(
          (tool) => tool.name.includes("speak") || tool.name.includes("text"),
        )
        .map((tool) => tool.name),
      [],
    );
    delegated.gameplaySubagent?.cancel("test_cancel");
  } finally {
    delegated.gameplaySubagent?.dispose();
    delegated.session.dispose();
    integration.dispose();
  }
});

test("gameplay subagent composition fails closed without a mounted game model config", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-gameplay-subagent-no-model-"),
  );
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new GameConnectionTestClient(
    scope,
    hostEndpoint,
    STARDEW_GAME_INTEGRATION_ADAPTER,
  );
  try {
    await assert.rejects(
      () =>
        createCompanionRuntime(
          identity,
          root,
          integration,
          undefined,
          undefined,
          undefined,
          true,
        ),
      /gameplay_subagent_requires_model_and_integration/,
    );
  } finally {
    integration.dispose();
  }
});

test("runtime mounts Host-owned version-bound knowledge only when explicitly configured", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase3-knowledge-"));
  const scope: Scope = {
    integrationId: "stardew",
    saveId: identity.saveId,
    worldId: identity.worldId,
    playerId: identity.playerId,
    companionId: identity.companionId,
  };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const bundle: KnowledgeBundle = {
    bundleVersion: 1,
    integrationId: "stardew",
    gameVersion: "1.6.15",
    rules: [
      {
        id: "move-v1",
        integrationId: "stardew",
        gameVersion: "1.6.15",
        capability: "move_to_tile",
        text: "Use a fresh actionable snapshot.",
      },
    ],
  };
  const integration = new GameConnectionTestClient(
    scope,
    hostEndpoint,
    STARDEW_GAME_INTEGRATION_ADAPTER,
    bundle,
    "1.6.15",
  );
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    assert.ok(
      runtime.session.agent.state.tools.some(
        (tool) => tool.name === "stardew_game_knowledge",
      ),
    );
  } finally {
    runtime.session.dispose();
    integration.dispose();
  }
});

test("runtime resolves Magic Context from the Host-declared package dependency", () => {
  const entry = resolveMagicContextExtensionEntry();
  assert.match(
    entry,
    /@cortexkit[\\/]pi-magic-context[\\/]dist[\\/]index\.js$/,
  );
  assert.doesNotMatch(entry, /(?:^|[\\/])vendor(?:[\\/]|$)/);
});

test("runtime loads only Magic Context and preserves a session partition", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase0b-runtime-"));
  const runtime = await createCompanionRuntime(identity, root);

  try {
    assert.deepEqual(
      runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
      ["companion_status", "todowrite"],
    );
    assert.equal(runtime.extensions.length, 1);
    assert.equal(
      runtime.extensions[0] ?? "",
      resolveMagicContextExtensionEntry(),
    );

    const config = JSON.parse(
      await readFile(
        join(runtime.paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"),
        "utf8",
      ),
    );
    assert.equal(config.embedding.provider, "off");
    assert.equal(MAGIC_CONTEXT_HISTORIAN_ENABLED, true);
    assert.equal(config.historian.disable, undefined);
    assert.equal(
      config.historian.model,
      `${DEFAULT_COMPANION_MODEL_CONFIG.provider}/${DEFAULT_COMPANION_MODEL_CONFIG.modelId}`,
    );
    assert.equal(
      config.historian.thinking_level,
      DEFAULT_COMPANION_MODEL_CONFIG.thinkingLevel,
    );
    assert.deepEqual(config.historian.disallowed_tools, ["*"]);
    assert.deepEqual(config.todowrite, { enabled: true, overlay: false });
    assert.equal(config.dreamer.disable, true);
    assert.equal(config.system_prompt_injection.enabled, false);
    assert.equal(
      runtime.session.systemPrompt.includes("## Magic Context"),
      false,
    );
    assert.equal(runtime.session.systemPrompt.includes("ctx_memory"), false);
    assert.equal(config.memory.domain, MAGIC_CONTEXT_MEMORY_DOMAIN);
    assert.equal(config.memory.enabled, MAGIC_CONTEXT_MEMORY_ENABLED);
    assert.equal(config.memory.auto_promote, false);
    assert.equal(MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED, false);
    assert.equal(
      config.memory.auto_search.enabled,
      MAGIC_CONTEXT_RECALL_ENABLED,
    );
    assert.equal(MAGIC_CONTEXT_RECALL_ENABLED, false);
    const manifest = JSON.parse(
      await readFile(runtime.paths.runManifestPath, "utf8"),
    ) as CompanionRunManifest;
    assert.deepEqual(manifest.featureFlags, {
      gameplaySubagent: false,
      magicContextMemoryDomain: MAGIC_CONTEXT_MEMORY_DOMAIN,
      magicContextMemoryEnabled: MAGIC_CONTEXT_MEMORY_ENABLED,
      magicContextAutoPromoteEnabled: false,
      magicContextAutoSearchEnabled: false,
    });
    await access(
      join(
        runtime.paths.runtimeCwd,
        "data",
        "cortexkit",
        "magic-context",
        "context.db",
      ),
    );

    const sessionFile = runtime.session.sessionFile;
    assert.match(sessionFile ?? "", /\.jsonl$/);
    assert.ok(sessionFile);
    runtime.sessionManager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "Player conversation persistence sentinel." },
      ],
      timestamp: Date.now(),
    });
    runtime.sessionManager.appendCustomMessageEntry(
      "gamebuddy_test_event",
      '{"kind":"test_event","source":"runtime_test"}',
      false,
      { kind: "test_event", source: "runtime_test" },
    );
    runtime.sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Phase 0B todo/session persistence sentinel." },
      ],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    assert.equal((await stat(sessionFile)).isFile(), true);
    const sessionFiles = await readdir(runtime.paths.sessionDir);
    assert.equal(sessionFiles.length, 1);
  } finally {
    runtime.session.dispose();
  }

  const resumed = await createCompanionRuntime(identity, root);
  try {
    assert.equal(resumed.session.sessionFile, runtime.session.sessionFile);
    const resumedEntries = JSON.stringify(resumed.session.messages);
    assert.match(resumedEntries, /Player conversation persistence sentinel\./);
    assert.match(
      resumedEntries,
      /Phase 0B todo\/session persistence sentinel\./,
    );
    assert.match(resumedEntries, /gamebuddy_test_event/);
    assert.deepEqual(
      resumed.session.agent.state.tools.map((tool) => tool.name).sort(),
      ["companion_status", "todowrite"],
    );
  } finally {
    resumed.session.dispose();
  }

  const otherSave = await createCompanionRuntime(
    { ...identity, saveId: "save_02" },
    root,
  );
  try {
    assert.notEqual(otherSave.session.sessionFile, runtime.session.sessionFile);
    assert.equal(
      JSON.stringify(otherSave.session.messages).includes(
        "Player conversation persistence sentinel.",
      ),
      false,
    );
    assert.notEqual(otherSave.paths.runtimeCwd, runtime.paths.runtimeCwd);
  } finally {
    otherSave.session.dispose();
  }
});

test("concurrent runtime bootstraps retain separate Magic Context data roots", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-runtime-concurrency-"));
  const cwdBefore = process.cwd();
  const firstIdentity = { ...identity, saveId: "save_concurrent_01" };
  const secondIdentity = { ...identity, saveId: "save_concurrent_02" };
  const [first, second] = await Promise.all([
    createCompanionRuntime(firstIdentity, root),
    createCompanionRuntime(secondIdentity, root),
  ]);
  try {
    assert.notEqual(first.paths.runtimeCwd, second.paths.runtimeCwd);
    await access(
      join(
        first.paths.runtimeCwd,
        "data",
        "cortexkit",
        "magic-context",
        "context.db",
      ),
    );
    await access(
      join(
        second.paths.runtimeCwd,
        "data",
        "cortexkit",
        "magic-context",
        "context.db",
      ),
    );
    assert.equal(process.cwd(), cwdBefore);
  } finally {
    first.session.dispose();
    second.session.dispose();
  }
});

test("internal Historian fixture override can disable automatic authoring without changing Memory gates", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-historian-off-fixture-"),
  );
  const runtime = await createCompanionRuntime(
    identity,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    "historian_off_fixture",
    undefined,
    "chat",
    { historianEnabled: false },
  );
  try {
    const config = JSON.parse(
      await readFile(
        join(runtime.paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"),
        "utf8",
      ),
    );
    assert.deepEqual(config.historian, { disable: true });
    assert.equal(config.memory.enabled, MAGIC_CONTEXT_MEMORY_ENABLED);
    assert.equal(
      config.memory.auto_promote,
      MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
    );
    assert.equal(config.memory.auto_search.enabled, false);
  } finally {
    runtime.session.dispose();
  }
});

test("Tavern stable context is available only through the exact live chat Pi binding", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-tavern-stable-context-"),
  );
  const tavernIdentity = { ...identity, continuityId: "continuity_01" };
  const runtime = await createCompanionRuntime(
    tavernIdentity,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    "tavern_session_01",
    undefined,
    "chat",
  );
  try {
    assert.equal(typeof runtime.publishTavernStableContext, "function");
    const sessionId = runtime.sessionManager.getSessionId();
    const content = "A quiet tavern premise.";
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    const body = {
      version: "gamebuddy-stable-context-source/v1",
      continuityId: tavernIdentity.continuityId,
      sessionId,
      surface: "tavern",
      sources: [
        {
          sourceId: "scenario",
          kind: "scenario",
          revision: "1",
          canonicalHash: hash,
          content,
          budgetTokens: 32,
          totalOrderKey: "0001",
          provenance: "runtime-test",
        },
      ],
    };
    const snapshot = {
      ...body,
      canonicalHash: createHash("sha256")
        .update(canonicalStableJson(body), "utf8")
        .digest("hex"),
    };
    await assert.doesNotReject(() =>
      runtime.publishTavernStableContext!(snapshot),
    );
    // The SDK session id is the explicit binding; a mismatched snapshot fails before publication.
    await assert.rejects(
      () =>
        runtime.publishTavernStableContext!({
          ...snapshot,
          sessionId: "other",
        }),
      /does not match active binding/,
    );
    await runtime.clearTavernStableContext?.();
  } finally {
    runtime.session.dispose();
  }
});

test("Game operational marker is absent from the generic Chat-callable public runtime API and isolated to core Game construction", async () => {
  const [wrapper, core] = await Promise.all([
    readFile(new URL("../src/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/runtime-core.internal.ts", import.meta.url), "utf8"),
  ]);
  const genericApi = wrapper.slice(
    wrapper.indexOf("export async function createCompanionRuntime"),
    wrapper.indexOf("export async function createGameCompanionRuntime"),
  );
  const gameApi = wrapper.slice(wrapper.indexOf("export async function createGameCompanionRuntime"));
  assert.equal(genericApi.includes("GameOperationalGate"), false);
  assert.equal(genericApi.includes("gameOperational"), false);
  assert.match(gameApi, /gameOperationalGate: GameOperationalGateConfig/);
  assert.doesNotMatch(wrapper, /fixedTools|createRuntimeWithFixedToolsCore/);
  assert.match(core, /"game"/);
  assert.match(core, /game_operational_marker_requires_game_surface/);
});

test("Game operational marker registration is Game-only and initialization cleanup clears it", async () => {
  const [wrapper, core] = await Promise.all([
    readFile(new URL("../src/runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/runtime-core.internal.ts", import.meta.url), "utf8"),
  ]);
  const registration = core.slice(
    core.indexOf("if (gameOperationalGate !== undefined)"),
    core.indexOf("if (tavernStableContextSnapshot !== undefined)"),
  );
  assert.doesNotMatch(wrapper, /registerGameOperationalGateMarker|fixedTools/);
  assert.match(registration, /registerGameOperationalGateMarker/);
  assert.match(registration, /sessionId: piSessionId/);
  assert.match(registration, /surface: "game"/);
  assert.match(core, /clearOperationalGateMarker\?\.\(\)/);
  const manifestBlock = core.slice(
    core.indexOf("await writeOrVerifyRunManifest"),
    core.indexOf("return {", core.indexOf("await writeOrVerifyRunManifest")),
  );
  assert.equal(manifestBlock.includes("gameOperationalGate"), false);
});

test("runtime construction failure disposes the Pi session and clears stable publication", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-runtime-cleanup-"));
  const chatIdentity = { ...identity, continuityId: "cleanup_continuity_01" };
  const first = await createCompanionRuntime(
    chatIdentity,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    "cleanup_chat_01",
    undefined,
    "chat",
  );
  const sessionFile = first.session.sessionFile;
  try {
    assert.ok(sessionFile);
    await writeFile(
      first.paths.runManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        identity: { ...chatIdentity, companionId: "different" },
      }),
      "utf8",
    );
  } finally {
    first.session.dispose();
  }

  await assert.rejects(
    () =>
      createCompanionRuntime(
        chatIdentity,
        root,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        "cleanup_chat_01",
        undefined,
        "chat",
      ),
    /run_manifest_mismatch/,
  );
  assert.equal(
    await stat(sessionFile).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    await stat(first.paths.identityProfileBindingPath).then(
      () => true,
      () => false,
    ),
    true,
  );
});

test("runtime binds the Host-owned IdentityProfile to Pi system prompt and fails closed on mismatch", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-identity-profile-runtime-"),
  );
  const runtime = await createCompanionRuntime(identity, root);
  try {
    assert.match(runtime.session.systemPrompt, /<gamebuddy_companion_identity/);
    assert.match(
      runtime.session.systemPrompt,
      new RegExp(runtime.identityProfile.canonicalHash),
    );
    assert.equal(
      JSON.stringify(runtime.session.messages).includes(
        "gamebuddy_companion_identity",
      ),
      false,
    );
    const storedProfile = JSON.parse(
      await readFile(runtime.paths.identityProfilePath, "utf8"),
    ) as typeof DEFAULT_IDENTITY_PROFILE & { canonicalHash: string };
    assert.equal(
      storedProfile.canonicalHash,
      identityProfileHash(DEFAULT_IDENTITY_PROFILE),
    );
  } finally {
    runtime.session.dispose();
  }

  const modifiedProfile = {
    ...DEFAULT_IDENTITY_PROFILE,
    identity: {
      ...DEFAULT_IDENTITY_PROFILE.identity,
      name: "Modified Companion",
    },
  };
  await writeFile(
    runtime.paths.identityProfilePath,
    JSON.stringify({
      ...modifiedProfile,
      canonicalHash: identityProfileHash(modifiedProfile),
    }),
    "utf8",
  );
  await assert.rejects(
    () => createCompanionRuntime(identity, root),
    /identity_profile_mismatch/,
  );

  const secondRoot = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-identity-profile-binding-"),
  );
  const first = await createCompanionRuntime(identity, secondRoot);
  const bindingPath = first.paths.identityProfileBindingPath;
  first.session.dispose();
  await unlink(bindingPath);
  await assert.rejects(
    () => createCompanionRuntime(identity, secondRoot),
    /identity_profile_mismatch/,
  );
});
