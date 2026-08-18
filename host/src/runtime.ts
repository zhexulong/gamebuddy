import { existsSync } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  createCompanionPresentationTools,
  type PresentationRuntime,
} from "./presentation.js";
import {
  assertIntegrationModule,
  DEFAULT_INTEGRATION_ACTION_POLICY,
  type GameIntegrationModule,
  type IntegrationActionPolicy,
} from "./integration-module.js";
import { GameplayTaskSubagent } from "./gameplay-task-subagent.js";
import {
  createActionExecutionCoordinator,
  type ActionExecutionCoordinator,
} from "./action-execution-coordinator.internal.js";
import type { ExecutionReceipt } from "./protocol.js";
import {
  StardewExecutionRecoverySupervisor,
  type ExactReceiptRecoveryPort,
  type ReceiptRecoveryOutcome,
} from "./stardew-execution-recovery-supervisor.js";
import { type CompanionInterruption } from "./companion-interruption.js";
import {
  actionRegistryRevision,
  writeOrVerifyRunManifest,
} from "./run-manifest.js";
import { type IntegrationConnection } from "./integration-types.js";
import { createWorldBookTools, type WorldBookBinding } from "./worldbook.js";
import {
  assertProfileMatchesBinding,
  buildChatCompanionSystemPrompt,
  buildGameCompanionSystemPrompt,
  createIdentityProfileBinding,
  identityProfileMetadata,
  readIdentityProfileBinding,
  readOrCreateIdentityProfile,
  writeIdentityProfile,
  type IdentityProfile,
  type IdentityProfileMetadata,
  writeIdentityProfileBinding,
} from "./identity-profile.js";

export const RUNTIME_PACKAGE_VERSIONS = Object.freeze({
  pi: "0.84.1",
  magicContext: "0.33.0-gamebuddy.2",
});

/** The selected fork domain; activation gates remain independently fail-closed. */
export const MAGIC_CONTEXT_MEMORY_DOMAIN = "ongoing-interaction" as const;

/**
 * Magic Context v0.33.0 auto-search searches raw history by the current Pi
 * session ID, not by GameBuddy's continuity ID. Its only cross-session path is
 * project memory, which deliberately remains outside the approved product
 * scope. Do not enable it as a Chat/Game recall substitute.
 */
export const MAGIC_CONTEXT_RECALL_ENABLED = false;

/**
 * First approved ongoing-interaction gate: native read-only rendering of
 * existing same-opaque-runtime Semantic Memory. This does not grant Host
 * write/read access. Magic Context's native promotion and automatic embedded
 * Historian authoring gates are selected below; auto-search, embedding,
 * Dreamer, and Sidekick stay off.
 */
export const MAGIC_CONTEXT_MEMORY_ENABLED = true;
// Magic Context's own ongoing-interaction Historian can publish eligible
// Semantic facts when it is enabled. The Host never classifies or writes them.
export const MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED = false;
/**
 * Magic Context's native trigger may now run the embedded-SDK, no-tool
 * Historian when its own context-pressure policy requires organization.
 */
export const MAGIC_CONTEXT_HISTORIAN_ENABLED = true;

// Magic Context currently discovers its config and SQLite root through Node
// process globals. Serialize only that extension bootstrap critical section so
// simultaneous Chat/Game runtimes cannot inherit one another's cwd/data root.
let magicContextReloadTail: Promise<void> = Promise.resolve();

async function reloadMagicContextInRuntimeRoot(
  loader: DefaultResourceLoader,
  runtimeCwd: string,
): Promise<void> {
  const previous = magicContextReloadTail;
  let release: () => void = () => undefined;
  magicContextReloadTail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  try {
    const previousCwd = process.cwd();
    const previousDataDir = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = join(runtimeCwd, "data");
      process.chdir(runtimeCwd);
      await loader.reload();
    } finally {
      process.chdir(previousCwd);
      if (previousDataDir === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataDir;
    }
  } finally {
    release();
  }
}

/**
 * The base Companion tool is read-only and never creates game authority. Its
 * status is sourced from the mounted integration when one exists.
 */
export function createCompanionStatusTool(integration?: IntegrationConnection) {
  return defineTool({
    name: "companion_status",
    label: "Companion Status",
    description:
      "Report the local Companion Host and mounted game integration status.",
    parameters: Type.Object({}),
    execute: async () => {
      const details =
        integration === undefined
          ? undefined
          : integration.module.status(integration);
      const fullDetails = {
        host: "ready",
        integrationId: integration?.scope.integrationId ?? null,
        connected: details?.connected ?? false,
        capabilities: details === undefined ? [] : [...details.capabilities],
        snapshotRevision: details?.snapshotRevision ?? null,
        latestReceiptState: details?.latestReceiptState ?? null,
        latestReasonCode: details?.latestReasonCode ?? null,
      } as const;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(fullDetails) }],
        details: fullDetails,
      };
    },
  });
}

/** Backward-compatible offline base tool for callers that do not mount an integration. */
export const companionStatusTool = createCompanionStatusTool();
export const PHASE_0B_ALLOWED_TOOL_NAMES = Object.freeze(["companion_status"]);

function createCompanionMemoryTool(
  memory: CompanionMemoryFacade,
): ToolDefinition {
  return defineTool({
    name: "companion_memory",
    label: "Companion Memory",
    description:
      "Read GameBuddy Companion memories, or save one inferred semantic memory only when the Host has granted the current player turn that authority.",
    parameters: Type.Union([
      Type.Object({ operation: Type.Literal("list") }),
      Type.Object({
        operation: Type.Literal("get"),
        stateToken: Type.String({ minLength: 1, maxLength: 2048 }),
      }),
      // Authorization is deliberately not an input. The Host independently
      // binds this operation to a player-granted active turn.
      Type.Object({
        operation: Type.Literal("create_inferred_semantic"),
        content: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
    ]),
    execute: async (toolCallId, params) => {
      const result = await memory.execute(
        params as CompanionMemoryCommand,
        toolCallId,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}

/**
 * A Host-owned companion identity. `continuityId` is the logical shared
 * experience key; legacy game-only callers may omit it and remain partitioned
 * by their exact save/world pair. A dialogue surface has no live world.
 */
export type CompanionIdentity = Readonly<{
  playerId: string;
  companionId: string;
  continuityId?: string;
  saveId?: string;
  worldId?: string;
}>;

export type GameCompanionIdentity = CompanionIdentity &
  Readonly<{
    saveId: string;
    worldId: string;
  }>;

export type RuntimePaths = Readonly<{
  root: string;
  runtimeCwd: string;
  agentDir: string;
  sessionDir: string;
  identityProfilePath: string;
  identityProfileBindingPath: string;
  runManifestPath: string;
  /** Explicit user-visible surface session ID when the continuity ledger selects one. */
  surfaceSessionId?: string;
}>;

export type CompanionThinkingLevel = "low" | "medium" | "high";

/**
 * Narrow Host injection boundary for Companion memory. The facade owns the
 * already-bound continuity and storage; the runtime never receives a browser,
 * project path, database handle, or Magic Context command API.
 */
export type CompanionMemoryCommand =
  | Readonly<{ operation: "list" }>
  | Readonly<{ operation: "get"; stateToken: string }>
  | Readonly<{ operation: "create_inferred_semantic"; content: string }>;

export type CompanionMemoryFacade = Readonly<{
  /** `operationId` is Host/Pi-issued tool-call identity, never a model field. */
  execute(
    command: CompanionMemoryCommand,
    operationId?: string,
  ): Promise<unknown>;
}>;

export type CompanionModelConfig = Readonly<{
  /** CPA is the configured local provider boundary for approved Agent models. */
  provider: "cpa-oai";
  modelId: "deepseek-v4-flash" | "gpt-5.6-luna";
  thinkingLevel: CompanionThinkingLevel;
}>;

/** The player-facing Dialogue Director uses DeepSeek V4 Flash; gameplay children never inherit it. */
export const DEFAULT_COMPANION_MODEL_CONFIG: CompanionModelConfig =
  Object.freeze({
    provider: "cpa-oai",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "high",
  });

/**
 * Internal-only test seam for bounded Magic Context gates. It is deliberately
 * absent from every operator config/CLI/browser protocol; Host production uses
 * the fail-closed constants above.
 */
type MagicContextFeatureTestOverride = Readonly<{
  /** Preview-only composition may disable the extension itself, not merely its features. */
  loadExtension?: boolean;
  memoryEnabled?: boolean;
  historianEnabled?: boolean;
  /** Test-only trigger compression; never comes from operator/browser config. */
  historianExecuteThresholdTokens?: number;
  historianExecuteThresholdPercentage?: number;
}>;

/** Private composition constant; Preview JSON and every external Host protocol are unable to select it. */
const PREVIEW_MAGIC_CONTEXT_DISABLED: MagicContextFeatureTestOverride =
  Object.freeze({
    loadExtension: false,
    memoryEnabled: false,
    historianEnabled: false,
  });

export type RuntimeSession = Readonly<{
  session: AgentSession;
  /** Opaque Pi session identity, minted by the SessionManager. */
  piSessionId: string;
  sessionManager: SessionManager;
  paths: RuntimePaths;
  identityKey: string;
  identityProfile: IdentityProfileMetadata;
  profile: IdentityProfile;
  extensions: readonly string[];
  gameplaySubagent?: GameplayTaskSubagent;
  /** Runtime-local STOP authority; never durable or adapter-owned. */
  interruption?: CompanionInterruption;
  /** Requests exact ledger cancellation for a synchronously sealed old epoch. */
  cancelIntegrationEpoch?: (epoch: number, reasonCode: string) => Promise<void>;
  /** Closes runtime action admission and awaits cancellation of every owned request. */
  interruptIntegrationExecutions?: (reasonCode: string) => Promise<void>;
  /** Binds a validated integration receipt to a pre-write correlation, including late receipts after write rejection. */
  bindIntegrationReceipt?: (receipt: ExecutionReceipt) => void;
  /**
   * Explicit relaunch-only recovery: queries a fresh authenticated read-only
   * port and admits receipts into the private coordinator. This is never
   * invoked by a disconnect and never reissues an action request.
   */
  recoverStardewExecutionReceipts?: (port: ExactReceiptRecoveryPort) => Promise<readonly ReceiptRecoveryOutcome[]>;
  /** Tavern-only, session-bound publication seam. It never writes Pi messages or Magic Context storage. */
  publishTavernStableContext?: (snapshot: unknown) => Promise<void>;
  /** Removes the in-process session publication before Pi disposal. */
  clearTavernStableContext?: () => Promise<void>;
  /** Removes the one-shot Tavern provider marker binding before Pi disposal. */
  clearTavernNarrativeGateMarker?: () => void;
  /**
   * Installs a source-owned one-shot provider-start observer on this exact
   * session through the loaded Magic Context extension entry. Returns the
   * explicit unregister; the caller owns one-shot lifecycle and retains no
   * payload, header, or prompt bytes.
   */
  installTavernProviderStartObserver?: (
    onStart: (observation: Readonly<{ sessionId: string; statusClass: "success" | "error" }>) => void,
  ) => () => void;
  /** Removes the Chat-only exact-next Memory marker binding before Pi disposal. */
  clearPlayerMemoryNextRoundMarker?: () => void;
  /** Removes the source-owned generic operational marker before Pi disposal. */
  clearGameOperationalGateMarker?: () => void;
}>;

function requireOpaqueSegment(label: string, value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(
      `${label} must be a 1–128 character opaque identifier using only letters, digits, _ and -.`,
    );
  }
  return value;
}

/** Stable, non-display-name partition for one logical Companion continuity. */
export function identityKey(identity: CompanionIdentity): string {
  const canonical =
    identity.continuityId === undefined
      ? [
          requireOpaqueSegment("playerId", identity.playerId),
          requireOpaqueSegment(
            "saveId",
            requiredGameId("saveId", identity.saveId),
          ),
          requireOpaqueSegment(
            "worldId",
            requiredGameId("worldId", identity.worldId),
          ),
          requireOpaqueSegment("companionId", identity.companionId),
        ]
      : [
          requireOpaqueSegment("playerId", identity.playerId),
          requireOpaqueSegment("companionId", identity.companionId),
          requireOpaqueSegment("continuityId", identity.continuityId),
        ];
  return createHash("sha256").update(canonical.join("\u001f")).digest("hex");
}

/**
 * One private action-agnostic coordinator backs every action surface: typed
 * Route A tool closures, Route B gameplay subagent dispatches, and Host STOP
 * epoch cancellation. It owns admission minting, request/execution correlation,
 * the deterministic receipt-order audit, exact-once cancel, and wake
 * normalization; it never routes an action and never interprets postconditions.
 */
function createRuntimeDispatchController(
  connection: IntegrationConnection,
): ActionExecutionCoordinator {
  return createActionExecutionCoordinator(connection);
}

function gateIntegrationTool(
  tool: ToolDefinition,
  connection: IntegrationConnection,
): ToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Only action tools are executable operations. Their tool surface is
      // mounted only with a live launcher gate, then rechecked at invocation.
      if (
        connection.module.actionIdForToolName(tool.name) !== null &&
        connection.executionGate?.executable !== true
      )
        throw new Error("integration_not_ready");
      return tool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

function requiredGameId(
  label: "saveId" | "worldId",
  value: string | undefined,
): string {
  if (value === undefined)
    throw new Error(`${label} is required when continuityId is absent.`);
  return value;
}

export function resolveRuntimePaths(
  identity: CompanionIdentity,
  root = join(homedir(), ".gamebuddy"),
  surfaceSessionId?: string,
): RuntimePaths {
  const key = identityKey(identity);
  const resolvedRoot = resolve(root);
  const runtimeCwd = join(resolvedRoot, "contexts", key);
  if (surfaceSessionId !== undefined)
    requireOpaqueSegment("surfaceSessionId", surfaceSessionId);
  const sessionRoot =
    surfaceSessionId === undefined
      ? runtimeCwd
      : join(runtimeCwd, "surface-sessions", surfaceSessionId);

  return {
    root: resolvedRoot,
    runtimeCwd,
    agentDir: join(runtimeCwd, "pi-agent"),
    sessionDir: join(sessionRoot, "sessions"),
    identityProfilePath: join(runtimeCwd, "identity-profile.json"),
    identityProfileBindingPath:
      surfaceSessionId === undefined
        ? join(runtimeCwd, "identity-profile-binding.json")
        : join(sessionRoot, "identity-profile-binding.json"),
    runManifestPath:
      surfaceSessionId === undefined
        ? join(runtimeCwd, "companion-run-manifest.json")
        : join(sessionRoot, "companion-run-manifest.json"),
    ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
  };
}

/** Game-only marker configuration. It cannot describe or authorize a Chat runtime. */
export type GameOperationalGateConfig = Readonly<{
  nonceSha256: string;
}>;

/** Construction-zone-only Game binding. It is consumed before Pi mounts tools. */
export type GameHostBindingFactory = (
  handle: Readonly<{ interruption: CompanionInterruption }>,
) => PresentationRuntime | undefined;

/** Construction-owned attachment for a bounded Game runtime surface. */
export type GameCompanionRuntimeAttachment = Readonly<{
  modelConfig: CompanionModelConfig;
  gameplaySubagentEnabled: boolean;
  hostBindingFactory: GameHostBindingFactory;
  /** Formal Preview-only composition mode; it has no JSON/operator/CLI representation. */
  disableMagicContextMemory?: true;
}>;

/** Chat-only exact-next Memory evidence configuration; raw marker facts never leave its callback. */
export type PlayerMemoryNextRoundEvidenceConfig = Readonly<{
  nonceSha256: string;
  onSourceMarker(marker: unknown): void;
}>;

/**
 * Generic Companion runtime construction. This Chat-callable path intentionally
 * has no Game Operational Gate marker parameter.
 */
export async function createCompanionRuntime(
  identity: CompanionIdentity,
  root?: string,
  integration?: IntegrationConnection,
  modelConfig?: CompanionModelConfig,
  actionPolicy?: IntegrationActionPolicy,
  presentation?: PresentationRuntime,
  gameplaySubagentEnabled = false,
  initialProfile?: IdentityProfile,
  surfaceSessionId?: string,
  worldBook?: WorldBookBinding,
  surface?: "chat" | "game",
  internalMagicContextFeatureTestOverride?: MagicContextFeatureTestOverride,
  tavernStableContextSnapshot?: unknown,
  companionMemory?: CompanionMemoryFacade,
  tavernNarrativeGateNonceSha256?: string,
  playerMemoryNextRoundEvidence?: PlayerMemoryNextRoundEvidenceConfig,
): Promise<RuntimeSession> {
  return await createRuntime(
    identity,
    root,
    integration,
    modelConfig,
    actionPolicy,
    presentation,
    gameplaySubagentEnabled,
    initialProfile,
    surfaceSessionId,
    worldBook,
    surface,
    internalMagicContextFeatureTestOverride,
    tavernStableContextSnapshot,
    companionMemory,
    tavernNarrativeGateNonceSha256,
    playerMemoryNextRoundEvidence,
  );
}

/**
 * The sole marker-capable runtime construction path. It fixes the surface to
 * Game both in its TypeScript API and in the private runtime configuration.
 */
export async function createGameCompanionRuntime(
  identity: GameCompanionIdentity,
  root: string,
  integration: IntegrationConnection,
  gameSessionId: string,
  gameOperationalGate: GameOperationalGateConfig | undefined,
  gameHostBindingFactory?: GameHostBindingFactory,
  attachment?: GameCompanionRuntimeAttachment,
): Promise<RuntimeSession> {
  if (attachment !== undefined && gameHostBindingFactory !== undefined)
    throw new Error("duplicate_game_host_binding_factory");
  return await createRuntime(
    identity,
    root,
    integration,
    attachment?.modelConfig,
    undefined,
    undefined,
    attachment?.gameplaySubagentEnabled ?? false,
    undefined,
    gameSessionId,
    undefined,
    "game",
    attachment?.disableMagicContextMemory === true
      ? PREVIEW_MAGIC_CONTEXT_DISABLED
      : undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gameOperationalGate,
    attachment?.hostBindingFactory ?? gameHostBindingFactory,
  );
}

/**
 * Create a Pi SDK session without coding-agent discovery. Only the installed,
 * pinned Magic Context extension can load; built-ins, project/user extensions,
 * skills, templates, context files, and coding prompts are excluded.
 */
async function createRuntime(
  identity: CompanionIdentity,
  root?: string,
  integration?: IntegrationConnection,
  modelConfig?: CompanionModelConfig,
  actionPolicy?: IntegrationActionPolicy,
  presentation?: PresentationRuntime,
  gameplaySubagentEnabled = false,
  initialProfile?: IdentityProfile,
  surfaceSessionId?: string,
  worldBook?: WorldBookBinding,
  surface?: "chat" | "game",
  internalMagicContextFeatureTestOverride?: MagicContextFeatureTestOverride,
  tavernStableContextSnapshot?: unknown,
  companionMemory?: CompanionMemoryFacade,
  tavernNarrativeGateNonceSha256?: string,
  playerMemoryNextRoundEvidence?: PlayerMemoryNextRoundEvidenceConfig,
  gameOperationalGate?: GameOperationalGateConfig,
  gameHostBindingFactory?: GameHostBindingFactory,
): Promise<RuntimeSession> {
  // A surface session ID identifies a persistent session; it must never be
  // used to infer the product surface because both Chat and Game have them.
  const runtimeSurface = surface ?? presentation?.surface ?? "game";
  if (
    tavernStableContextSnapshot !== undefined &&
    (runtimeSurface !== "chat" || identity.continuityId === undefined)
  ) {
    throw new Error("tavern_stable_context_requires_chat_continuity");
  }
  if (
    tavernNarrativeGateNonceSha256 !== undefined &&
    !/^[a-f0-9]{64}$/.test(tavernNarrativeGateNonceSha256)
  ) {
    throw new Error("invalid_tavern_marker_config");
  }
  if (gameOperationalGate !== undefined && runtimeSurface !== "game") {
    throw new Error("game_operational_marker_requires_game_surface");
  }
  if (
    playerMemoryNextRoundEvidence !== undefined &&
    (runtimeSurface !== "chat" ||
      !/^[a-f0-9]{64}$/.test(playerMemoryNextRoundEvidence.nonceSha256) ||
      typeof playerMemoryNextRoundEvidence.onSourceMarker !== "function")
  ) {
    throw new Error("player_memory_next_round_marker_requires_chat_surface");
  }
  if (
    gameOperationalGate !== undefined &&
    !/^[a-f0-9]{64}$/.test(gameOperationalGate.nonceSha256)
  ) {
    throw new Error("invalid_game_operational_marker_config");
  }
  const loadMagicContextExtension =
    internalMagicContextFeatureTestOverride?.loadExtension !== false;
  if (!loadMagicContextExtension && gameOperationalGate !== undefined) {
    throw new Error("game_operational_marker_requires_magic_context");
  }
  const integrationModule: GameIntegrationModule | undefined =
    integration?.module;
  if (integration !== undefined && integrationModule === undefined)
    throw new Error("integration_module_required");
  if (integration !== undefined) {
    assertIntegrationModule(
      integration.module,
      integration.scope.integrationId,
    );
    integration.module.assertIdentityBinding(integration, identity);
  }
  const mountedPolicy =
    actionPolicy === undefined
      ? (integrationModule?.defaultPolicy ?? DEFAULT_INTEGRATION_ACTION_POLICY)
      : integrationModule === undefined
        ? actionPolicy
        : integrationModule.parsePolicy(actionPolicy);
  const paths = resolveRuntimePaths(identity, root, surfaceSessionId);
  const identityProfileAlreadyExists = await pathExists(
    paths.identityProfilePath,
  );
  await Promise.all([
    mkdir(paths.runtimeCwd, { recursive: true }),
    mkdir(paths.agentDir, { recursive: true }),
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(dirname(paths.identityProfileBindingPath), { recursive: true }),
    ...(loadMagicContextExtension
      ? [mkdir(join(paths.runtimeCwd, ".cortexkit"), { recursive: true })]
      : []),
  ]);

  const profile =
    initialProfile !== undefined && !identityProfileAlreadyExists
      ? (await writeIdentityProfile(paths.identityProfilePath, initialProfile),
        initialProfile)
      : await readOrCreateIdentityProfile(paths.identityProfilePath);
  const profileMetadata = identityProfileMetadata(profile);
  const existingBinding = await readIdentityProfileBinding(
    paths.identityProfileBindingPath,
  );
  const existingSessionFiles = await listSessionFiles(paths.sessionDir);
  if (existingBinding === null) {
    // A continuity owns one profile, while every explicit user-visible surface
    // session owns its own session binding. A new surface may therefore see an
    // existing profile but must never adopt pre-existing Pi JSONL without its
    // own binding.
    if (
      existingSessionFiles.length > 0 ||
      (surfaceSessionId === undefined && identityProfileAlreadyExists)
    )
      throw new Error("identity_profile_mismatch");
  } else {
    assertProfileMatchesBinding(
      identityKey(identity),
      profile,
      existingBinding,
    );
    if (
      existingBinding.sessionFile !== null &&
      !existingSessionFiles.includes(existingBinding.sessionFile)
    ) {
      throw new Error("identity_profile_mismatch");
    }
    if (
      existingBinding.sessionFile === null &&
      existingSessionFiles.length > 1
    ) {
      throw new Error("identity_profile_mismatch");
    }
  }

  // Magic Context's project config is intentionally generated in the opaque
  // runtime directory, never in the game repository. The approved v0.33.0-
  // gamebuddy.2 gates are native same-scope SEMANTIC_MEMORY injection and
  // automatic embedded Historian authoring restricted
  // to this Host-owned opaque continuity runtime; auto_search remains off and
  // Host never gains project-memory/SQLite authority.
  const magicContextMemoryEnabled =
    internalMagicContextFeatureTestOverride?.memoryEnabled ??
    MAGIC_CONTEXT_MEMORY_ENABLED;
  const magicContextHistorianEnabled =
    internalMagicContextFeatureTestOverride?.historianEnabled ??
    MAGIC_CONTEXT_HISTORIAN_ENABLED;
  if (loadMagicContextExtension) await writeFile(
    join(paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"),
    JSON.stringify(
      {
        enabled: true,
        embedding: { provider: "off" },
        // Production selects the embedded-SDK, no-tool Historian. The internal
        // override can still disable it for A/B fixtures without changing any
        // Memory authority or exposing an authoring API.
        historian: !magicContextHistorianEnabled
          ? { disable: true }
          : {
              model: `${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).provider}/${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).modelId}`,
              thinking_level: (modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG)
                .thinkingLevel,
              disallowed_tools: ["*"],
            },
        ...(internalMagicContextFeatureTestOverride?.historianExecuteThresholdTokens ===
        undefined
          ? {}
          : {
              execute_threshold_tokens: {
                default:
                  internalMagicContextFeatureTestOverride.historianExecuteThresholdTokens,
              },
            }),
        ...(internalMagicContextFeatureTestOverride?.historianExecuteThresholdPercentage ===
        undefined
          ? {}
          : {
              execute_threshold_percentage:
                internalMagicContextFeatureTestOverride.historianExecuteThresholdPercentage,
            }),
        dreamer: { disable: true, inject_docs: false },
        sidekick: { disable: true },
        // The upstream generic system block is a coding-agent instruction set
        // (ctx_memory/ctx_search/Git/project guidance). Chat intentionally keeps
        // it out of the Companion prompt; m[0]/m[1] remains the sole native
        // read-only Semantic Memory injection path.
        system_prompt_injection: { enabled: false },
        memory: {
          // GameBuddy selects the domain; the vendored Magic Context fork owns
          // historian interpretation, promotion, retrieval, and injection.
          // The Host never gains an SQLite API or writer. Magic Context itself
          // owns any domain-valid promotion triggered by the embedded Historian.
          // Chat/Game retain separate Pi surface sessions. The only approved
          // cross-surface material is Magic Context's native same-continuity
          // read-only Semantic Memory gate; Host does not synthesize recall.
          domain: MAGIC_CONTEXT_MEMORY_DOMAIN,
          enabled: magicContextMemoryEnabled,
          auto_promote: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
          // Keep explicit to prevent an upstream default flip from silently
          // enabling a current-session hint and being mistaken for continuity recall.
          auto_search: { enabled: MAGIC_CONTEXT_RECALL_ENABLED },
        },
        todowrite: { enabled: true, overlay: false },
        smart_drops: false,
        temporal_awareness: false,
      },
      null,
      2,
    ),
    "utf8",
  );

  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  // Resolve the declared runtime dependency rather than a source-relative
  // vendor path. Production artifacts are immutable generations outside the
  // repository, while the package manager binds this file dependency to the
  // same source-owned, prebuilt Magic Context extension in development and CI.
  // The resolver is anchored at `host/` (not the emitted generation) so it
  // cannot accidentally acquire an extension from a user Pi installation.
  const magicContextEntry = resolveMagicContextExtensionEntry();
  const loader = new DefaultResourceLoader({
    cwd: paths.runtimeCwd,
    agentDir: paths.agentDir,
    settingsManager: settings,
    noExtensions: true,
    additionalExtensionPaths: loadMagicContextExtension
      ? [magicContextEntry]
      : [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt:
      runtimeSurface === "chat"
        ? buildChatCompanionSystemPrompt(profile)
        : buildGameCompanionSystemPrompt(profile),
    appendSystemPrompt: [],
  });
  // The fork must never spawn the external `pi` CLI from a GameBuddy runtime.
  // Preview has no approved Magic Context capability, so it does not mount or
  // bootstrap the extension at all.
  const previousEmbeddedRuntimeMarker = loadMagicContextExtension
    ? process.env.GAMEBUDDY_EMBEDDED_RUNTIME
    : undefined;
  if (loadMagicContextExtension) {
    process.env.GAMEBUDDY_EMBEDDED_RUNTIME = "1";
    try {
      // The extension discovers config/data through Node process globals. The
      // helper scopes and serializes that bootstrap so opaque partitions cannot
      // race each other during loader.reload().
      await reloadMagicContextInRuntimeRoot(loader, paths.runtimeCwd);

      if (loader.getExtensions().errors.length > 0) {
        throw new Error(
          `Magic Context extension failed to load: ${loader
            .getExtensions()
            .errors.map((error) => error.error)
            .join("; ")}`,
        );
      }
    } catch (error) {
      if (previousEmbeddedRuntimeMarker === undefined)
        delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
      else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = previousEmbeddedRuntimeMarker;
      throw error;
    }
  } else {
    await loader.reload();
  }

  const sessionManager = SessionManager.continueRecent(
    paths.runtimeCwd,
    paths.sessionDir,
  );
  const modelRuntime = await createCompanionModelRuntime(paths, modelConfig);
  const model =
    modelConfig === undefined
      ? undefined
      : modelRuntime.getModel(modelConfig.provider, modelConfig.modelId);
  if (modelConfig !== undefined && model === undefined)
    throw new Error("companion_model_not_available");

  const companionStatus = createCompanionStatusTool(integration);
  const dispatchController =
    integration === undefined
      ? undefined
      : createRuntimeDispatchController(integration);
  // One private supervisor per game runtime. It is retained by closure so an
  // explicit relaunch can run exactly one bounded pass over the same
  // coordinator without ever exporting the coordinator itself.
  const receiptRecoverySupervisor =
    dispatchController === undefined
      ? undefined
      : new StardewExecutionRecoverySupervisor(dispatchController);
  if (
    gameHostBindingFactory !== undefined &&
    (runtimeSurface !== "game" || dispatchController === undefined)
  )
    throw new Error("invalid_game_host_binding_factory");
  const boundPresentation =
    gameHostBindingFactory === undefined
      ? presentation
      : gameHostBindingFactory(
          Object.freeze({ interruption: dispatchController!.interruption }),
        );
  const integrationToolSet =
    integration !== undefined && integrationModule !== undefined
      ? integrationModule.createToolSet({
          connection: integration,
          knowledge: integration.knowledge,
          gameVersion: integration.gameVersion,
          policy: mountedPolicy,
          dispatchAdmissionFactory:
            dispatchController === undefined
              ? undefined
              : () => dispatchController.createAdmission(),
        })
      : undefined;
  const rawIntegrationTools =
    integrationToolSet === undefined
      ? []
      : [
          ...integrationToolSet.observation,
          ...integrationToolSet.actions,
          ...integrationToolSet.knowledge,
        ];
  // Tool definitions remain mounted for the lifetime of a Pi session. Every
  // adapter tool therefore receives a Host-owned execution fence so a later
  // lifecycle loss revokes stale closures rather than trusting the adapter to
  // remember to check its own disconnected state.
  const integrationTools =
    integration === undefined
      ? rawIntegrationTools
      : rawIntegrationTools.map((tool) =>
          gateIntegrationTool(tool, integration),
        );
  const presentationTools =
    boundPresentation === undefined
      ? []
      : createCompanionPresentationTools(boundPresentation);
  // Memory is a Chat-only product adapter. Absence of an injected facade is
  // fail-closed: no memory tool is mounted and no storage is opened.
  const companionMemoryTools =
    runtimeSurface === "chat" && companionMemory !== undefined
      ? [createCompanionMemoryTool(companionMemory)]
      : [];
  const worldBookScope =
    integration === undefined
      ? null
      : integration.module.worldScope(integration);
  const worldBookTools =
    worldBook === undefined
      ? []
      : createWorldBookTools(worldBook, worldBookScope ?? undefined);
  const gameplaySubagent = gameplaySubagentEnabled
    ? integration !== undefined && modelConfig !== undefined
      ? new GameplayTaskSubagent(
          paths,
          integration,
          mountedPolicy,
          undefined,
          undefined,
          undefined,
          () => dispatchController!.createAdmission(),
        )
      : (() => {
          throw new Error("gameplay_subagent_requires_model_and_integration");
        })()
    : undefined;
  const rawGameplayTools =
    gameplaySubagent === undefined
      ? []
      : [gameplaySubagent.createDelegateTool()];
  // The delegate itself is an execution entry point. Fence it as well as the
  // module-owned action tools so a terminal adapter lifecycle cannot start a
  // new worker task through an already-mounted Pi session.
  const gameplayTools =
    integration === undefined
      ? rawGameplayTools
      : rawGameplayTools.map((tool) => gateIntegrationTool(tool, integration));
  const allowedToolNames = [
    ...PHASE_0B_ALLOWED_TOOL_NAMES,
    ...(loadMagicContextExtension ? ["todowrite"] : []),
    ...companionMemoryTools.map((tool) => tool.name),
    ...integrationTools.map((tool) => tool.name),
    ...worldBookTools.map((tool) => tool.name),
    ...presentationTools.map((tool) => tool.name),
    ...gameplayTools.map((tool) => tool.name),
  ].sort();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  try {
    ({ session } = await createAgentSession({
      cwd: paths.runtimeCwd,
      agentDir: paths.agentDir,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager,
      modelRuntime,
      model,
      noTools: "all",
      tools: allowedToolNames,
      customTools: [
        companionStatus,
        ...companionMemoryTools,
        ...integrationTools,
        ...worldBookTools,
        ...presentationTools,
        ...gameplayTools,
      ],
      thinkingLevel: modelConfig?.thinkingLevel ?? "off",
    }));
  } finally {
    if (loadMagicContextExtension) {
      if (previousEmbeddedRuntimeMarker === undefined)
        delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
      else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = previousEmbeddedRuntimeMarker;
    }
  }

  // Once Pi has returned a session, every subsequent initialization step owns
  // one deterministic reverse path. In particular, publication is cleared
  // before Pi disposal so a reused session id cannot retain stale context.
  let clearTavernStableContext: (() => Promise<void>) | undefined;
  let clearTavernNarrativeGateMarker: (() => void) | undefined;
  let clearPlayerMemoryNextRoundMarker: (() => void) | undefined;
  let clearGameOperationalGateMarker: (() => void) | undefined;
  let installTavernProviderStartObserver: ((
    onStart: (observation: Readonly<{ sessionId: string; statusClass: "success" | "error" }>) => void,
  ) => () => void) | undefined;
  try {
    const activeTools = session.agent.state.tools
      .map((tool) => tool.name)
      .sort();
    const expectedTools = allowedToolNames;
    if (JSON.stringify(activeTools) !== JSON.stringify(expectedTools)) {
      throw new Error(
        `Companion tool isolation failed: expected ${expectedTools.join(", ")}, got ${activeTools.join(", ") || "(none)"}.`,
      );
    }

    const sessionFile =
      session.sessionFile === undefined ||
      !(await pathExists(session.sessionFile))
        ? null
        : basename(session.sessionFile);
    const expectedSessionFile =
      existingBinding?.sessionFile ??
      (existingSessionFiles.length === 1 ? existingSessionFiles[0] : null);
    if (
      existingBinding !== null &&
      expectedSessionFile !== null &&
      expectedSessionFile !== sessionFile
    ) {
      throw new Error("identity_profile_mismatch");
    }
    await writeIdentityProfileBinding(
      paths.identityProfileBindingPath,
      createIdentityProfileBinding(identityKey(identity), profile, sessionFile),
    );
    const piSessionId = sessionManager.getSessionId();
    if (typeof piSessionId !== "string" || piSessionId.length === 0) {
      throw new Error("pi_session_binding_unavailable");
    }
    const tavernStableContextBinding:
      | Readonly<{ continuityId: string; sessionId: string; surface: "tavern" }>
      | undefined =
      runtimeSurface === "chat" && identity.continuityId !== undefined
        ? Object.freeze({
            continuityId: identity.continuityId,
            sessionId: piSessionId,
            surface: "tavern",
          })
        : undefined;
    const publishTavernStableContext =
      tavernStableContextBinding === undefined
        ? undefined
        : async (snapshot: unknown): Promise<void> => {
            // The exact source-owned module is also the extension entry loaded above,
            // so this reaches its process-local per-Pi-session registry rather than a
            // pnpm package copy. No SQLite, raw message, or cwd-derived binding path.
            const bridge = (await import(
              pathToFileURL(magicContextEntry).href
            )) as {
              publishGameBuddyStableContextSnapshot: (
                binding: typeof tavernStableContextBinding,
                value: unknown,
              ) => unknown;
            };
            bridge.publishGameBuddyStableContextSnapshot(
              tavernStableContextBinding,
              snapshot,
            );
          };
    clearTavernStableContext =
      tavernStableContextBinding === undefined
        ? undefined
        : async (): Promise<void> => {
            const bridge = (await import(
              pathToFileURL(magicContextEntry).href
            )) as {
              clearPublishedGameBuddyStableContext: (sessionId: string) => void;
            };
            bridge.clearPublishedGameBuddyStableContext(
              tavernStableContextBinding.sessionId,
            );
          };
    if (tavernNarrativeGateNonceSha256 !== undefined) {
      const bridge = (await import(pathToFileURL(magicContextEntry).href)) as {
        registerTavernNarrativeGateMarker: (
          value: Readonly<{ sessionId: string; nonceSha256: string }>,
        ) => () => void;
      };
      clearTavernNarrativeGateMarker = bridge.registerTavernNarrativeGateMarker(
        {
          sessionId: piSessionId,
          nonceSha256: tavernNarrativeGateNonceSha256,
        },
      );
    }
    if (playerMemoryNextRoundEvidence !== undefined) {
      const bridge = (await import(pathToFileURL(magicContextEntry).href)) as {
        registerPlayerMemoryNextRoundMarker: (
          value: Readonly<{
            sessionId: string;
            nonceSha256: string;
            surface: "chat";
          }>,
          onSourceMarker: (marker: unknown) => void,
        ) => () => void;
      };
      if (typeof bridge.registerPlayerMemoryNextRoundMarker !== "function")
        throw new Error("player_memory_next_round_marker_bridge_unavailable");
      clearPlayerMemoryNextRoundMarker =
        bridge.registerPlayerMemoryNextRoundMarker(
          {
            sessionId: piSessionId,
            nonceSha256: playerMemoryNextRoundEvidence.nonceSha256,
            surface: "chat",
          },
          playerMemoryNextRoundEvidence.onSourceMarker,
        );
    }
    if (gameOperationalGate !== undefined) {
      const bridge = (await import(pathToFileURL(magicContextEntry).href)) as {
        registerGameOperationalGateMarker: (
          value: Readonly<{
            sessionId: string;
            nonceSha256: string;
            surface: "game";
          }>,
        ) => () => void;
      };
      clearGameOperationalGateMarker = bridge.registerGameOperationalGateMarker(
        {
          sessionId: piSessionId,
          nonceSha256: gameOperationalGate.nonceSha256,
          surface: "game",
        },
      );
    }
    if (loadMagicContextExtension) {
      const bridge = (await import(pathToFileURL(magicContextEntry).href)) as {
        registerTavernProviderStartObserver: (
          sessionId: string,
          onStart: (observation: Readonly<{ sessionId: string; statusClass: "success" | "error" }>) => void,
        ) => () => void;
      };
      if (typeof bridge.registerTavernProviderStartObserver !== "function")
        throw new Error("tavern_provider_start_observer_bridge_unavailable");
      installTavernProviderStartObserver = (onStart) =>
        bridge.registerTavernProviderStartObserver(piSessionId, onStart);
    }
    if (tavernStableContextSnapshot !== undefined)
      await publishTavernStableContext!(tavernStableContextSnapshot);

    await writeOrVerifyRunManifest(paths, {
      schemaVersion: 1,
      identity,
      runtime: RUNTIME_PACKAGE_VERSIONS,
      model: {
        provider: modelConfig?.provider ?? null,
        modelId: modelConfig?.modelId ?? null,
        thinkingLevel: modelConfig?.thinkingLevel ?? null,
      },
      gameplaySubagentModel:
        gameplaySubagent === undefined ? null : gameplaySubagent.modelConfig,
      actionRegistryRevision: actionRegistryRevision(
        integrationModule?.actionCatalog.entries ?? [],
      ),
      actionPolicy: mountedPolicy,
      mountedTools: activeTools,
      knowledge:
        integrationModule === undefined
          ? { mounted: false, gameVersion: null, bundleVersion: null }
          : integrationModule.knowledgeMetadata({
              connection: integration,
              knowledge: integration?.knowledge,
              gameVersion: integration?.gameVersion,
            }),
      identityProfile: profileMetadata,
      worldBook: worldBook === undefined ? null : worldBook.metadata,
      presentation: boundPresentation?.profile ?? null,
      featureFlags: {
        gameplaySubagent: gameplaySubagent !== undefined,
        magicContextMemoryDomain: MAGIC_CONTEXT_MEMORY_DOMAIN,
        magicContextMemoryEnabled,
        magicContextAutoPromoteEnabled: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
        magicContextAutoSearchEnabled: MAGIC_CONTEXT_RECALL_ENABLED,
      },
    });

    return {
      session,
      piSessionId,
      sessionManager,
      paths,
      identityKey: identityKey(identity),
      identityProfile: profileMetadata,
      profile,
      extensions: loader
        .getExtensions()
        .extensions.map((extension) => extension.path),
      ...(gameplaySubagent === undefined ? {} : { gameplaySubagent }),
      ...(dispatchController === undefined
        ? {}
        : {
            interruption: dispatchController.interruption,
            cancelIntegrationEpoch: (epoch: number, reasonCode: string) =>
              dispatchController.cancelEpoch(epoch, reasonCode),
            interruptIntegrationExecutions: (reasonCode: string) =>
              dispatchController.interrupt(reasonCode),
            bindIntegrationReceipt: (receipt: ExecutionReceipt) =>
              dispatchController.receiveReceipt(receipt),
            recoverStardewExecutionReceipts: (port) =>
              receiptRecoverySupervisor!.recoverFromFreshBinding(port),
          }),
      ...(publishTavernStableContext === undefined
        ? {}
        : { publishTavernStableContext }),
      ...(clearTavernStableContext === undefined
        ? {}
        : { clearTavernStableContext }),
      ...(clearTavernNarrativeGateMarker === undefined
        ? {}
        : { clearTavernNarrativeGateMarker }),
      ...(clearPlayerMemoryNextRoundMarker === undefined
        ? {}
        : { clearPlayerMemoryNextRoundMarker }),
      ...(clearGameOperationalGateMarker === undefined
        ? {}
        : { clearGameOperationalGateMarker }),
      ...(installTavernProviderStartObserver === undefined
        ? {}
        : { installTavernProviderStartObserver }),
    };
  } catch (error) {
    throw await cleanupRuntimeInitializationFailure(
      session,
      clearTavernStableContext,
      clearTavernNarrativeGateMarker,
      clearPlayerMemoryNextRoundMarker,
      clearGameOperationalGateMarker,
      error,
    );
  }
}

/**
 * Creates an opaque-runtime-only Pi registry for the locked Companion Agent.
 * Credentials are resolved from CPA_OAI_API_KEY by Pi at request time and are
 * never written into the identity partition.
 */
/** Resolve only the Host-declared Magic Context package entry, never user Pi state. */
export function resolveMagicContextExtensionEntry(): string {
  try {
    // `import.meta.url` is inside Host source or a Host production generation;
    // Node therefore walks only Host's declared dependency ancestry. Resolve
    // using ESM conditions: this extension deliberately exports only `import`,
    // so `createRequire(...).resolve()` would incorrectly reject it.
    const entry = fileURLToPath(
      import.meta.resolve("@cortexkit/pi-magic-context"),
    );
    if (!existsSync(entry)) throw new Error("missing");
    return entry;
  } catch {
    throw new Error("magic_context_extension_build_required");
  }
}

type RuntimeSessionResource = Awaited<
  ReturnType<typeof createAgentSession>
>["session"];

async function cleanupRuntimeInitializationFailure(
  session: RuntimeSessionResource,
  clearPublishedStableContext: (() => Promise<void>) | undefined,
  clearNarrativeGateMarker: (() => void) | undefined,
  clearPlayerMemoryNextRoundMarker: (() => void) | undefined,
  clearOperationalGateMarker: (() => void) | undefined,
  primary: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    await clearPublishedStableContext?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    clearNarrativeGateMarker?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    clearPlayerMemoryNextRoundMarker?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    clearOperationalGateMarker?.();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    session.dispose();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      [primary, ...cleanupErrors],
      "runtime_initialization_failed",
    );
  throw primary;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return false;
    throw error;
  }
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  return (await readdir(sessionDir))
    .filter((entry) => /^[A-Za-z0-9._-]{1,256}\.jsonl$/.test(entry))
    .sort();
}

async function createCompanionModelRuntime(
  paths: RuntimePaths,
  config: CompanionModelConfig | undefined,
): Promise<ModelRuntime> {
  const modelsPath = join(paths.agentDir, "models.json");
  const deepSeekCompat = config?.modelId === "deepseek-v4-flash";
  const providers =
    config === undefined
      ? {}
      : {
          "cpa-oai": {
            name: "CPA OpenAI-compatible Agent",
            baseUrl: "http://127.0.0.1:8317/v1",
            api: "openai-completions",
            apiKey: "$CPA_OAI_API_KEY",
            authHeader: true,
            compat: {
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
            },
            models: [
              {
                id: config.modelId,
                name: config.modelId,
                reasoning: true,
                // The configured CPA route is used with ordinary native `tools`; Pi
                // does not emit forced OpenAI `tool_choice` for this surface.
                thinkingLevelMap: deepSeekCompat
                  ? {
                      off: "none",
                      minimal: "low",
                      low: "low",
                      medium: "high",
                      high: "high",
                      xhigh: "high",
                      max: "max",
                    }
                  : {
                      off: "none",
                      minimal: "low",
                      low: "low",
                      medium: "medium",
                      high: "high",
                      xhigh: "xhigh",
                      max: "max",
                    },
                input: ["text"],
                contextWindow: 1_000_000,
                maxTokens: 384_000,
                cost: {
                  input: 0.14,
                  output: 0.28,
                  cacheRead: 0.0028,
                  cacheWrite: 0.14,
                },
                compat: {
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: true,
                  maxTokensField: "max_tokens",
                  supportsStrictMode: true,
                  ...(deepSeekCompat
                    ? {
                        thinkingFormat: "deepseek",
                        requiresReasoningContentOnAssistantMessages: true,
                      }
                    : {}),
                },
              },
            ],
          },
        };
  await writeFile(modelsPath, JSON.stringify({ providers }, null, 2), "utf8");
  // Offline by default. Selecting the explicitly configured Agent model is the
  // operator's opt-in to provider networking; no request occurs merely while
  // creating or resuming the session.
  return ModelRuntime.create({
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath,
    modelsStorePath: join(paths.agentDir, "models-store.json"),
    allowModelNetwork: config !== undefined,
  });
}
