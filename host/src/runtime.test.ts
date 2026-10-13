import assert from "node:assert/strict";
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
import { dirname, join } from "node:path";
import test, { before } from "node:test";
import { createServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import {
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_IDENTITY_PROFILE,
  identityProfileHash,
} from "./identity-profile.js";
import { GAMEPLAY_SUBAGENT_MODEL_CONFIG } from "./gameplay-task-subagent.js";
import {
  createIntegrationActionCatalog,
  type GameIntegrationAdapter,
} from "./game-integration-adapter.js";
import type { KnowledgeBundle } from "./knowledge.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { ActionRegistration, ExecutionReceipt, Scope, Snapshot } from "./protocol.js";
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
  RUNTIME_PACKAGE_VERSIONS,
} from "./runtime.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { createMaterializedGameCompanionRuntime } from "./game-runtime-fixed-tools.internal.js";
import type { GameConnection, StardewBridgeConnection } from "./game-connection.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import { createStardewIntegrationLaunchHandleFromAuthenticatedBridge } from "./stardew-integration-launcher.js";
import type { IntegrationLaunchHandle } from "./integration-launcher.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

// The compiled test artifact is deliberately not a production artifact, so
// path-lock's default resolver rejects repository helpers. Every runtime
// bootstrap writes an identity profile through the durable path lock, so mint
// the build-only reclaimer capability once before any test runs.
before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

const identity = Object.freeze({
  playerId: "player_01",
  saveId: "save_01",
  worldId: "world_01",
  companionId: "companion_01",
});

const BRIDGE_SCOPE: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: identity.saveId,
  worldId: identity.worldId,
  playerId: identity.playerId,
  companionId: identity.companionId,
});
const BRIDGE_TOKEN = "runtime_suite_bridge_token_0123456789";
const BRIDGE_GENERATION = "runtime_suite_generation_01";
const BRIDGE_CATALOG_REVISION = 1;
const BRIDGE_POLICY_IDENTITY = Object.freeze({
  value: "0123456789abcdef0123456789abcdef",
  capabilityRevision: 1,
});

/** The Mod always publishes at least one registration; hello_ack rejects an empty catalog. */
const MINIMAL_REGISTRATIONS: readonly ActionRegistration[] = Object.freeze([
  Object.freeze({
    actionId: "move_to_tile",
    familyId: "movement_navigation",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
  }),
]);

type StardewFixtureState = {
  sessionId: string;
  capabilities: string[];
  /** Defaults to every capability that carries a published execution registration. */
  enabledActionIds?: readonly string[];
  catalogRegistrations: readonly ActionRegistration[];
  snapshot: Snapshot;
  latestReceipt?: ExecutionReceipt | null;
  latestReasonCode?: string | null;
};

type ScriptedStardewMod = Readonly<{
  connection: StardewBridgeConnection;
  state: StardewFixtureState;
  setExecute(handler: (request: any) => Promise<ExecutionReceipt>): void;
  /** Publish a durable receipt the Mod mints outside an execute response. */
  publishReceipt(receipt: ExecutionReceipt): Promise<void>;
  revoke(reasonCode: string): void;
}>;

function bridgeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

async function bridgeUntil(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await delay(5);
  }
  throw new Error(message);
}

/** The world projection every fixture shares; only the fields a case asserts vary. */
function fixtureSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    revision: 1,
    location: "Farm",
    tile: { x: 1, y: 2 },
    stamina: 100,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 1,
    enabledActionIds: [],
    exhausted: false,
    presentationLocale: "en-US",
    timeOfDay: 600,
    dayOfMonth: 1,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    activeExecution: null,
    ...overrides,
  } as Snapshot;
}

/**
 * The Stardew adapter reaches identity/scope/state/status/tool surfaces only
 * through the exact connection an authenticated launch minted, so a caller-built
 * object or a GameConnectionTestClient dies with
 * `stardew_connection_not_authenticated_or_not_live` before any assertion runs.
 * This harness stands up the narrow Mod side of the named pipe, drives the real
 * LocalStardewBridgeClient handshake, and mints the connection through the same
 * launch production runtime-core consumes (the pattern local-stardew-bridge-
 * attestation.test.ts and gameplay-task-subagent.test.ts use).
 */
async function withAuthenticatedStardew(
  initial: StardewFixtureState,
  operation: (mod: ScriptedStardewMod) => Promise<void>,
  options: Readonly<{
    knowledge?: KnowledgeBundle;
    gameVersion?: string;
    continuityId?: string;
  }> = {},
): Promise<void> {
  const state = initial;
  const enabledActionIds =
    state.enabledActionIds ??
    state.capabilities.filter((capability) =>
      state.catalogRegistrations.some(
        (registration) =>
          registration.actionId === capability && registration.kind === "execution",
      ),
    );
  const pipeName = `gamebuddy_runtime_suite_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let socket: Socket | undefined;
  let executeHandler: (request: any) => Promise<ExecutionReceipt> = async (request) => ({
    requestId: request.requestId,
    executionId: "execution_01",
    actionId: request.action,
    state: "accepted",
    reasonCode: "accepted",
    revision: request.expectedRevision,
    evidence: null,
  });
  const write = (value: unknown): void => {
    socket?.write(bridgeFrame(value));
  };
  const snapshotPayload = () => ({
    ...state.snapshot,
    capabilities: [...state.capabilities],
    catalogRevision: BRIDGE_CATALOG_REVISION,
    enabledActionIds: [...enabledActionIds],
    presentationLocale: "en-US",
  });
  const respond = async (request: any): Promise<void> => {
    if (request.type === "hello") {
      write({
        ...request,
        messageId: "mod_hello",
        type: "hello_ack",
        payload: {
          sessionId: state.sessionId,
          capabilities: [...state.capabilities],
          catalogRevision: BRIDGE_CATALOG_REVISION,
          policyIdentity: BRIDGE_POLICY_IDENTITY,
          enabledActionIds: [...enabledActionIds],
          presentationLocale: "en-US",
          registrations: [...state.catalogRegistrations],
          runtimeRole: "farmhand_client",
          launchGeneration: BRIDGE_GENERATION,
        },
      });
      if (state.latestReceipt !== undefined && state.latestReceipt !== null)
        write({
          protocolVersion: 1,
          messageId: "mod_initial_receipt",
          correlationId: "mod_initial_receipt",
          timestampMs: Date.now(),
          scope: BRIDGE_SCOPE,
          type: "execution_receipt",
          payload: state.latestReceipt,
        });
      return;
    }
    if (request.type === "observe_request") {
      write({ ...request, messageId: "mod_snapshot", type: "snapshot", payload: snapshotPayload() });
      return;
    }
    if (request.type === "execution_request") {
      const receipt = await executeHandler(request.payload);
      state.latestReceipt = receipt;
      write({ ...request, messageId: "mod_execution_receipt", type: "execution_receipt", payload: receipt });
      return;
    }
    if (request.type === "cancel_request") {
      write({
        ...request,
        messageId: "mod_cancel_receipt",
        type: "execution_receipt",
        payload: {
          requestId: request.payload.requestId,
          executionId: request.payload.executionId,
          actionId: "cancel_active_execution",
          state: "cancelled",
          reasonCode: request.payload.reasonCode,
          revision: state.snapshot.revision,
          evidence: null,
        },
      });
      return;
    }
    write({ ...request, messageId: "mod_error", type: "error", payload: { reasonCode: "unexpected_request" } });
  };
  const server: Server = createServer((peer) => {
    socket = peer;
    peer.once("close", () => {
      if (socket === peer) socket = undefined;
    });
    let buffer = Buffer.alloc(0);
    peer.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= 4) {
        const length = buffer.readInt32LE(0);
        if (buffer.byteLength < 4 + length) return;
        const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
        buffer = buffer.subarray(4 + length);
        void respond(request);
      }
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve()).once("error", reject),
  );
  let launch: IntegrationLaunchHandle | undefined;
  try {
    const client = await LocalStardewBridgeClient.connectFarmhand(
      BRIDGE_SCOPE,
      pipeName,
      BRIDGE_TOKEN,
      BRIDGE_GENERATION,
      Date.now() + 5_000,
      STARDEW_GAME_INTEGRATION_ADAPTER,
      options.knowledge,
      options.gameVersion,
    );
    launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
      client,
      Object.freeze({
        playerId: BRIDGE_SCOPE.playerId,
        companionId: BRIDGE_SCOPE.companionId,
        continuityId: options.continuityId ?? "continuity_runtime_suite",
        saveId: BRIDGE_SCOPE.saveId,
        worldId: BRIDGE_SCOPE.worldId,
      }),
      {
        module: STARDEW_GAME_INTEGRATION_ADAPTER,
        ...(options.knowledge === undefined ? {} : { knowledge: options.knowledge }),
        ...(options.gameVersion === undefined ? {} : { gameVersion: options.gameVersion }),
      },
    );
    const connection = launch.connection as StardewBridgeConnection;
    const mod: ScriptedStardewMod = Object.freeze({
      connection,
      state,
      setExecute: (handler) => {
        executeHandler = handler;
      },
      publishReceipt: async (receipt) => {
        state.latestReceipt = receipt;
        write({
          protocolVersion: 1,
          messageId: "mod_receipt",
          correlationId: "mod_receipt",
          timestampMs: Date.now(),
          scope: BRIDGE_SCOPE,
          type: "execution_receipt",
          payload: receipt,
        });
        await bridgeUntil(
          () => connection.state.latestReceipt?.executionId === receipt.executionId,
          "mod_receipt_not_admitted",
        );
      },
      revoke: (reasonCode) => launch!.revoke(reasonCode),
    });
    await operation(mod);
  } finally {
    launch?.close();
    socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

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
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: ["equip_tool"],
      catalogRegistrations: [
        {
          actionId: "equip_tool",
          familyId: "body_tools",
          identityVersion: 1,
          lifecycle: "published" as const,
          kind: "execution" as const,
        },
      ],
      snapshot: fixtureSnapshot({
        revision: 9,
        capabilities: ["equip_tool"],
        enabledActionIds: ["equip_tool"],
      }),
      latestReceipt: {
        executionId: "execution_01",
        requestId: "request_01",
        actionId: "equip_tool",
        state: "accepted",
        reasonCode: "accepted",
        revision: 9,
        evidence: null,
      },
    },
    async (mod) => {
      const result = await createCompanionStatusTool(mod.connection).execute(
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
    },
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
    execute: async (_toolCallId, params) => {
      // Model of execution-time admission (the real executeGameAction): the
      // mounted tool stays mounted when the capability leaves, and the call
      // returns a structured rejected receipt instead of the tool vanishing.
      if (
        !(
          integrationState as { capabilities: readonly string[] }
        ).capabilities.includes("activate_console")
      )
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                outcome: "rejected",
                reasonCode: "capability_not_declared",
              }),
            },
          ],
          details: { receiptJson: "" },
        };
      return {
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
      };
    },
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
    createToolSet: ({ dispatchAdmissionFactory }) => ({
      // Constant mount: the tool NAME set must not change with live
      // capability snapshots (that would bust the provider prefix cache).
      // Per-action admission is modeled inside execute above.
      observation: [],
      actions: dispatchAdmissionFactory !== undefined ? [activateConsole] : [],
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

    // A live capability loss no longer withdraws the mounted surface: the
    // tool NAME set stays constant so the provider prefix cache survives
    // snapshot churn. Admission moves to execution time, which rejects the
    // call with a structured receipt instead of hiding the tool.
    integrationState.capabilities = [];
    assert.deepEqual(
      runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
      ["arcade_activate_console", "companion_status", "todowrite"],
    );
    const withdrawn = runtime.session.agent.state.tools.find(
      (tool) => tool.name === "arcade_activate_console",
    );
    assert.ok(withdrawn);
    const withdrawnResult = await withdrawn.execute(
      "withdrawal_check",
      { consoleId: "console_02" },
      new AbortController().signal,
      () => undefined,
    );
    assert.match(
      withdrawnResult.content[0]?.type === "text"
        ? withdrawnResult.content[0].text
        : "",
      /capability_not_declared/,
    );
  } finally {
    runtime.session.dispose();
  }
});
// The mismatched-save fixture can no longer be built directly: the
// authenticated launch refuses a scope that disagrees with its own identity
// before the adapter is reached (stardew_bridge_identity_scope_mismatch), and a
// hand-built connection is rejected by the authentication gate. The
// runtime-construction layer still enforces the same binding, so the case mints
// a live connection for save_01 and mounts it under a save_02 runtime: the
// adapter's assertIdentityBinding must refuse it.
test("runtime rejects a mounted integration whose save identity does not match", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase3-scope-"));
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: MINIMAL_REGISTRATIONS,
      snapshot: fixtureSnapshot(),
    },
    async (mod) => {
      await assert.rejects(
        () =>
          createCompanionRuntime(
            { ...identity, saveId: "save_02" },
            root,
            mod.connection,
          ),
        /integration_identity_binding_mismatch/,
      );
    },
  );
});

test("generic runtime keeps an explicit game surface when the Host construction zone supplies it", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-game-surface-runtime-"));
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: MINIMAL_REGISTRATIONS,
      snapshot: fixtureSnapshot(),
    },
    async (mod) => {
      const runtime = await createCompanionRuntime(
        { ...identity, continuityId: "continuity_01" },
        root,
        mod.connection,
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
        assert.match(runtime.session.systemPrompt, /\[Character: GameBuddy Companion\]/);
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
      }
    },
  );
});

test("Chat surface never creates a gameplay subagent even when enabled with integration and model config", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-chat-no-gameplay-subagent-"));
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: MINIMAL_REGISTRATIONS,
      snapshot: fixtureSnapshot(),
    },
    async (mod) => {
      // A Chat surface has no live world, so it does not carry a continuityId:
      // the Magic Context runtime-environment-facts provider is process-global
      // and may be registered only once, and the Game-surface case above already
      // registers it. The "never creates a gameplay subagent" invariant needs
      // only an integration, a model config, and an explicit chat surface.
      const runtime = await createCompanionRuntime(
        identity, root, mod.connection,
        GAMEPLAY_SUBAGENT_MODEL_CONFIG, undefined, undefined, true, undefined,
        "chat_surface_subagent_01", undefined, "chat",
      );
      try {
        assert.equal(runtime.gameplaySubagent, undefined);
        assert.deepEqual(runtime.session.agent.state.tools, []);
      } finally {
        runtime.session.dispose();
      }
    },
  );
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
    assert.match(runtime.session.systemPrompt, /\[Character: GameBuddy Companion\]/);
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
    assert.deepEqual(fixedTools.map((tool) => tool.name), ["stardew_submit_action_program", "stardew_action_program_status", "stardew_action_program_events"]);
  } finally {
    publicRuntime.session.dispose();
    materializedRuntime.session.dispose();
  }
});

test("fixed Game tools fail closed unless frozen, unique, and non-colliding", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-fixed-tool-rejections-"));
  const tool = defineTool({ name: "stardew_external_probe", label: "x", description: "x", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
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
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: MINIMAL_REGISTRATIONS,
      snapshot: fixtureSnapshot(),
    },
    async (mod) => {
      const runtime = await createGameCompanionRuntime(
        identity,
        root,
        mod.connection,
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
      }
    },
  );
});

test("a Game runtime attachment without a model configuration gets only the unknown placeholder model", async () => {
  // The materializer never constructs a Game runtime this way: it supplies the
  // player's own Game profile model to every Game runtime and refuses the whole
  // materialization when the store cannot yield one. This case states exactly
  // why, so that a silent regression to a model-less Game surface cannot hide:
  // the embedded runtime substitutes its `unknown` placeholder model — no
  // provider, no context window, no tokens — keeps the thinking level at `off`,
  // records nulls in the durable run manifest, and writes no provider entry.
  // `allowModelNetwork` is exactly `modelConfig !== undefined`, and the provider
  // entry is merged under that same condition, so a missing `models.json` is
  // the observable proof that provider networking stays off. A model
  // configuration is therefore not an enhancement of a Game session: without
  // one the session exists but can never reach a provider.
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-game-model-configuration-"),
  );
  const registrations = [
    {
      actionId: "activate_console",
      familyId: "arcade",
      identityVersion: 1,
      lifecycle: "published" as const,
      kind: "execution" as const,
    },
  ];
  const policy = Object.freeze({
    policyVersion: 1 as const,
    deniedActions: [],
    deniedFamilies: [],
  });
  const connection = {
    scope: Object.freeze({ integrationId: "test-arcade" }),
    executionGate: { executable: true },
    state: Object.freeze({}),
    module: {
      descriptor: Object.freeze({
        integrationId: "test-arcade",
        version: "fixture-v1",
        toolNamePrefix: "arcade_",
      }),
      actionCatalog: createIntegrationActionCatalog([
        { actionId: "activate_console" },
      ]),
      defaultPolicy: policy,
      parsePolicy: (value: unknown) => value as typeof policy,
      actorId: () => identity.playerId,
      assertIdentityBinding: () => undefined,
      worldScope: () => null,
      createToolSet: () => ({ observation: [], actions: [], knowledge: [] }),
      knowledgeMetadata: () => ({
        mounted: false,
        gameVersion: null,
        bundleVersion: null,
      }),
      status: () => ({
        connected: true,
        capabilities: [],
        capabilityRevision: 1,
        snapshotRevision: 1,
        latestReceiptState: null,
        latestReasonCode: null,
      }),
      readState: () => ({
        connected: true,
        sessionId: "session_01",
        capabilities: [],
        registrations,
        capabilityRevision: 1,
        snapshotRevision: 1,
        activeExecution: null,
        latestReceipt: null,
        latestReasonCode: null,
      }),
      cancelExecution: () => "not_supported",
      parseReceipt: () => null,
      actionIdForToolName: () => null,
      isCancellationTool: () => false,
    },
  } as unknown as GameConnection;
  const attachmentFields = {
    gameplaySubagentEnabled: false,
    disableMagicContextMemory: true as const,
    hostBindingFactory: () => undefined,
  };
  const withoutModel = await createGameCompanionRuntime(
    identity,
    join(root, "absent"),
    connection,
    "game_model_absent_01",
    undefined,
    undefined,
    attachmentFields,
  );
  const withModel = await createGameCompanionRuntime(
    identity,
    join(root, "present"),
    connection,
    "game_model_present_01",
    undefined,
    undefined,
    { ...attachmentFields, modelConfig: DEFAULT_COMPANION_MODEL_CONFIG },
  );
  try {
    assert.deepEqual(
      {
        provider: withoutModel.session.agent.state.model?.provider,
        id: withoutModel.session.agent.state.model?.id,
        contextWindow: withoutModel.session.agent.state.model?.contextWindow,
        maxTokens: withoutModel.session.agent.state.model?.maxTokens,
      },
      {
        provider: "unknown",
        id: "unknown",
        contextWindow: 0,
        maxTokens: 0,
      },
    );
    assert.equal(withoutModel.session.agent.state.thinkingLevel, "off");
    const absentManifest = JSON.parse(
      await readFile(withoutModel.paths.runManifestPath, "utf8"),
    ) as CompanionRunManifest;
    assert.deepEqual(absentManifest.model, {
      provider: null,
      modelId: null,
      thinkingLevel: null,
    });
    // No provider entry, therefore `allowModelNetwork: false`.
    await assert.rejects(
      access(join(withoutModel.paths.agentDir, "models.json")),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT",
    );

    assert.equal(
      withModel.session.agent.state.model?.provider,
      DEFAULT_COMPANION_MODEL_CONFIG.provider,
    );
    assert.equal(
      withModel.session.agent.state.model?.id,
      DEFAULT_COMPANION_MODEL_CONFIG.modelId,
    );
    assert.equal(
      withModel.session.agent.state.thinkingLevel,
      DEFAULT_COMPANION_MODEL_CONFIG.thinkingLevel,
    );
    const presentManifest = JSON.parse(
      await readFile(withModel.paths.runManifestPath, "utf8"),
    ) as CompanionRunManifest;
    assert.deepEqual(presentManifest.model, DEFAULT_COMPANION_MODEL_CONFIG);
    assert.match(
      await readFile(join(withModel.paths.agentDir, "models.json"), "utf8"),
      /cpa-oai/,
    );
  } finally {
    withoutModel.session.dispose();
    withModel.session.dispose();
  }
});

// The "connection without a launcher execution gate" fixture is unreachable
// through the authenticated launch: the launch mints the gate as executable and
// the adapter refuses any connection whose gate is absent or revoked before a
// tool set is built. The fail-closed guard moved to invocation time
// (gateIntegrationTool), so the case mounts with the live gate and then revokes
// it: the mounted action closure must refuse rather than trust itself.
test("Stardew action tools fail closed when the launcher execution gate is revoked", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-runtime-no-execution-gate-"),
  );
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: ["equip_tool"],
      catalogRegistrations: [
        {
          actionId: "equip_tool",
          familyId: "body_tools",
          identityVersion: 1,
          lifecycle: "published" as const,
          kind: "execution" as const,
        },
      ],
      snapshot: fixtureSnapshot({
        capabilities: ["equip_tool"],
        enabledActionIds: ["equip_tool"],
      }),
    },
    async (mod) => {
      const runtime = await createCompanionRuntime(identity, root, mod.connection);
      try {
        const equip = runtime.session.agent.state.tools.find(
          (tool) => tool.name === "stardew_equip_tool",
        );
        assert.ok(equip, "the action tool mounts while the launcher gate is live");
        assert.equal(
          runtime.session.agent.state.tools.some(
            (tool) => tool.name === "stardew_observe",
          ),
          true,
        );
        // A revoked launcher gate is never a legacy admission path.
        mod.revoke("execution_gate_revoked");
        await assert.rejects(
          () => equip.execute("gate-revoked", {}, new AbortController().signal),
          /integration_not_ready/,
        );
      } finally {
        runtime.session.dispose();
      }
    },
  );
});

test("runtime composes a ledger admission before mounting and executing a live Stardew action", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-runtime-admission-"));
  let executeWrites = 0;
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: ["equip_tool", "cancel_active_execution"],
      enabledActionIds: ["equip_tool"],
      catalogRegistrations: [
        {
          actionId: "equip_tool",
          familyId: "body_tools",
          identityVersion: 1,
          lifecycle: "published" as const,
          kind: "execution" as const,
        },
      ],
      snapshot: fixtureSnapshot({
        capabilities: ["equip_tool", "cancel_active_execution"],
        enabledActionIds: ["equip_tool"],
      }),
    },
    async (mod) => {
      mod.setExecute(async (request) => {
        executeWrites++;
        return {
          requestId: request.requestId,
          executionId: "execution_equip_01",
          actionId: "equip_tool",
          state: "succeeded" as const,
          reasonCode: "tool_selected",
          revision: 1,
          evidence: { detail: "slot=1;before=none;expected=Axe;after=Axe" },
        };
      });
      const runtime = await createCompanionRuntime(identity, root, mod.connection);
      try {
        const equip = runtime.session.agent.state.tools.find(
          (tool) => tool.name === "stardew_equip_tool",
        );
        assert.ok(equip);
        const result = await equip.execute(
          "runtime-admission-equip",
          {
            tool: "axe",
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
    },
  );
});

test("runtime mounts only the explicitly verified Stardew product tools", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase3-tools-"));
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: MINIMAL_REGISTRATIONS,
      snapshot: fixtureSnapshot(),
    },
    async (mod) => {
      const runtime = await createCompanionRuntime(identity, root, mod.connection);
      try {
        // The mounted name set is the adapter's frozen constant surface; live
        // capability snapshots no longer add or withdraw a tool (admission moved
        // to execution time), so a disconnected or empty snapshot mounts the
        // same names a fully capable one does.
        assert.deepEqual(
          runtime.session.agent.state.tools.map((tool) => tool.name).sort(),
          [
            "companion_status",
            "stardew_bait_crab_pot",
            "stardew_break_rock_source",
            "stardew_chest_retrieve",
            "stardew_chest_store",
            "stardew_chop_stump",
            "stardew_chop_tree_source",
            "stardew_clear_cask",
            "stardew_clear_debris",
            "stardew_clear_hoedirt",
            "stardew_collect_animal_product",
            "stardew_collect_crab_pot_output",
            "stardew_cook_recipe",
            "stardew_craft_item",
            "stardew_cut_grass",
            "stardew_cut_weeds",
            "stardew_deposit_silo_hay",
            "stardew_dig_artifact_spot",
            "stardew_dress_mannequin",
            "stardew_enter_exit",
            "stardew_enter_mine",
            "stardew_equip_tool",
            "stardew_execution_status",
            "stardew_feed_animal",
            "stardew_fertilize_tile",
            "stardew_find_destination",
            "stardew_harvest_bush",
            "stardew_harvest_crop",
            "stardew_harvest_fruit_tree",
            "stardew_inspect_world_map",
            "stardew_interaction_catalog",
            "stardew_machine_collect_output",
            "stardew_machine_inspect",
            "stardew_machine_load",
            "stardew_mount_transport",
            "stardew_move_to_tile",
            "stardew_navigate_to_destination",
            "stardew_npc_relationship",
            "stardew_observe",
            "stardew_pickup_forage",
            "stardew_pickup_item",
            "stardew_place_crab_pot",
            "stardew_place_wood_fence",
            "stardew_plant_sapling",
            "stardew_plant_seed",
            "stardew_read_scene",
            "stardew_refill_watering_can",
            "stardew_scythe_crop",
            "stardew_search_interactions",
            "stardew_set_sign_display",
            "stardew_shake_tree",
            "stardew_ship_item",
            "stardew_stop_action",
            "stardew_take_pedestal_item",
            "stardew_till_soil",
            "stardew_toggle_fence_gate",
            "stardew_toggle_tool_light",
            "stardew_travel",
            "stardew_use_item",
            "stardew_use_raft",
            "stardew_water_crop",
            "stardew_water_pet_bowl",
            "stardew_water_slime_hutch_trough",
            "todowrite",
          ],
        );
      } finally {
        runtime.session.dispose();
      }
    },
  );
});

test("runtime materializes the optional gameplay subagent without exposing its tools to the parent by default", async () => {
  const offlineRoot = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-gameplay-subagent-offline-"),
  );
  const delegatedRoot = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-gameplay-subagent-enabled-"),
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
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: MINIMAL_REGISTRATIONS,
      snapshot: fixtureSnapshot(),
    },
    async (mod) => {
      const delegated = await createCompanionRuntime(
        identity,
        delegatedRoot,
        mod.connection,
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
      }
    },
  );
});

test("gameplay subagent composition fails closed without a mounted game model config", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-gameplay-subagent-no-model-"),
  );
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: [],
      catalogRegistrations: MINIMAL_REGISTRATIONS,
      snapshot: fixtureSnapshot(),
    },
    async (mod) => {
      await assert.rejects(
        () =>
          createCompanionRuntime(
            identity,
            root,
            mod.connection,
            undefined,
            undefined,
            undefined,
            true,
          ),
        /gameplay_subagent_requires_model_and_integration/,
      );
    },
  );
});

test("runtime mounts Host-owned version-bound knowledge only when explicitly configured", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-phase3-knowledge-"));
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
  await withAuthenticatedStardew(
    {
      sessionId: "session_01",
      capabilities: ["move_to_tile"],
      catalogRegistrations: [
        {
          actionId: "move_to_tile",
          familyId: "movement_navigation",
          identityVersion: 1,
          lifecycle: "published" as const,
          kind: "execution" as const,
        },
      ],
      snapshot: fixtureSnapshot({
        capabilities: ["move_to_tile"],
        enabledActionIds: ["move_to_tile"],
      }),
    },
    async (mod) => {
      const runtime = await createCompanionRuntime(identity, root, mod.connection);
      try {
        assert.ok(
          runtime.session.agent.state.tools.some(
            (tool) => tool.name === "stardew_game_knowledge",
          ),
        );
      } finally {
        runtime.session.dispose();
      }
    },
    { knowledge: bundle, gameVersion: "1.6.15" },
  );
});

test("runtime resolves Magic Context from the Host-declared package dependency", () => {
  const entry = resolveMagicContextExtensionEntry();
  assert.match(
    entry,
    /@cortexkit[\\/]pi-magic-context[\\/]dist[\\/]index\.js$/,
  );
  assert.doesNotMatch(entry, /(?:^|[\\/])vendor(?:[\\/]|$)/);
});

test("the recorded Magic Context runtime identity is the loaded artifact's own version", async () => {
  // The run manifest is provenance evidence, so it must never record an
  // identity no artifact carries. The package declares no `package.json`
  // subpath, so derive the package root from the exact entry the runtime loads
  // (`.../pi-magic-context/dist/index.js`, workspace-real or pnpm-linked) and
  // read its own version there.
  const entry = resolveMagicContextExtensionEntry();
  const packageRoot = join(dirname(entry), "..");
  const artifact = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as { name: string; version: string };
  assert.equal(artifact.name, "@cortexkit/pi-magic-context");
  assert.equal(RUNTIME_PACKAGE_VERSIONS.magicContext, artifact.version);
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
    // Owner ruling D: narrow-open Dreamer (memory hygiene only).
    assert.equal(config.dreamer.disable, false);
    assert.equal(config.dreamer.inject_docs, false);
    assert.equal(
      config.dreamer.model,
      `${DEFAULT_COMPANION_MODEL_CONFIG.provider}/${DEFAULT_COMPANION_MODEL_CONFIG.modelId}`,
    );
    assert.equal(
      config.dreamer.thinking_level,
      DEFAULT_COMPANION_MODEL_CONFIG.thinkingLevel,
    );
    const dreamerSchedules = Object.fromEntries(
      Object.entries(
        config.dreamer.tasks as Record<string, { schedule: string }>,
      ).map(([task, value]) => [task, value.schedule]),
    );
    assert.deepEqual(dreamerSchedules, {
      "classify-memories": "0 6 * * *",
      curate: "0 4 * * 0",
      "map-memories": "",
      verify: "",
      "verify-broad": "",
      "compress-cues": "",
      retrospective: "",
      "maintain-docs": "",
      "evaluate-smart-notes": "",
      "review-user-memories": "",
      "promote-primers": "",
      "refresh-primers": "",
    });
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

test("public Chat runtime exposes no authored-context publication or capability API", async () => {
  const root = await mkdtemp(
    join(await canonicalTemporaryRoot(), "gamebuddy-tavern-authored-context-public-api-"),
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
    assert.equal("publishTavernStableContext" in runtime, false);
    assert.equal("clearTavernStableContext" in runtime, false);
    assert.equal("prepareAuthoredContext" in runtime, false);
    assert.equal("assertAuthoredContextInstall" in runtime, false);
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
  assert.doesNotMatch(wrapper, /registerGameOperationalGateMarker|fixedTools/);
  assert.match(core, /registerGameOperationalGateMarker/);
  assert.match(core, /sessionId: piSessionId/);
  assert.match(core, /surface: "game"/);
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
    assert.match(runtime.session.systemPrompt, /\[Character: GameBuddy Companion\]/);
    assert.doesNotMatch(
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
