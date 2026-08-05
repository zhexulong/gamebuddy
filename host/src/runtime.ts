import { existsSync } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createCompanionPresentationTools, type PresentationRuntime } from "./presentation.js";
import { assertIntegrationModule, DEFAULT_INTEGRATION_ACTION_POLICY, type GameIntegrationModule, type IntegrationActionPolicy } from "./integration-module.js";
import { GameplayTaskSubagent } from "./gameplay-task-subagent.js";
import { actionRegistryRevision, writeOrVerifyRunManifest } from "./run-manifest.js";
import { type IntegrationConnection } from "./integration-types.js";
import { createWorldBookTools, type WorldBookBinding } from "./worldbook.js";
import {
  assertProfileMatchesBinding,
  buildChatCompanionSystemPrompt,
  buildCompanionSystemPrompt,
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
  pi: "0.82.1",
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
export const MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED = true;
/**
 * Magic Context's native trigger may now run the embedded-SDK, no-tool
 * Historian when its own context-pressure policy requires organization.
 */
export const MAGIC_CONTEXT_HISTORIAN_ENABLED = true;

// Magic Context currently discovers its config and SQLite root through Node
// process globals. Serialize only that extension bootstrap critical section so
// simultaneous Chat/Game runtimes cannot inherit one another's cwd/data root.
let magicContextReloadTail: Promise<void> = Promise.resolve();

async function reloadMagicContextInRuntimeRoot(loader: DefaultResourceLoader, runtimeCwd: string): Promise<void> {
  const previous = magicContextReloadTail;
  let release: () => void = () => undefined;
  magicContextReloadTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
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
    description: "Report the local Companion Host and mounted game integration status.",
    parameters: Type.Object({}),
    execute: async () => {
      const details = integration === undefined ? undefined : integration.module.status(integration);
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

export type GameCompanionIdentity = CompanionIdentity & Readonly<{
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

export type CompanionModelConfig = Readonly<{
  /** CPA is the configured local provider boundary for both approved models. */
  provider: "cpa-oai";
  modelId: "deepseek-v4-flash" | "gpt-5.6-luna";
  thinkingLevel: CompanionThinkingLevel;
}>;

/** The player-facing Dialogue Director uses DeepSeek; gameplay children never inherit it. */
export const DEFAULT_COMPANION_MODEL_CONFIG: CompanionModelConfig = Object.freeze({
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
  memoryEnabled?: boolean;
  historianEnabled?: boolean;
  /** Test-only trigger compression; never comes from operator/browser config. */
  historianExecuteThresholdTokens?: number;
  historianExecuteThresholdPercentage?: number;
}>;

export type RuntimeSession = Readonly<{
  session: AgentSession;
  sessionManager: SessionManager;
  paths: RuntimePaths;
  identityKey: string;
  identityProfile: IdentityProfileMetadata;
  profile: IdentityProfile;
  extensions: readonly string[];
  gameplaySubagent?: GameplayTaskSubagent;
}>;

function requireOpaqueSegment(label: string, value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${label} must be a 1–128 character opaque identifier using only letters, digits, _ and -.`);
  }
  return value;
}

/** Stable, non-display-name partition for one logical Companion continuity. */
export function identityKey(identity: CompanionIdentity): string {
  const canonical = identity.continuityId === undefined
    ? [
      requireOpaqueSegment("playerId", identity.playerId),
      requireOpaqueSegment("saveId", requiredGameId("saveId", identity.saveId)),
      requireOpaqueSegment("worldId", requiredGameId("worldId", identity.worldId)),
      requireOpaqueSegment("companionId", identity.companionId),
    ]
    : [
      requireOpaqueSegment("playerId", identity.playerId),
      requireOpaqueSegment("companionId", identity.companionId),
      requireOpaqueSegment("continuityId", identity.continuityId),
    ];
  return createHash("sha256").update(canonical.join("\u001f")).digest("hex");
}

function requiredGameId(label: "saveId" | "worldId", value: string | undefined): string {
  if (value === undefined) throw new Error(`${label} is required when continuityId is absent.`);
  return value;
}

export function resolveRuntimePaths(identity: CompanionIdentity, root = join(homedir(), ".gamebuddy"), surfaceSessionId?: string): RuntimePaths {
  const key = identityKey(identity);
  const resolvedRoot = resolve(root);
  const runtimeCwd = join(resolvedRoot, "contexts", key);
  if (surfaceSessionId !== undefined) requireOpaqueSegment("surfaceSessionId", surfaceSessionId);
  const sessionRoot = surfaceSessionId === undefined ? runtimeCwd : join(runtimeCwd, "surface-sessions", surfaceSessionId);

  return {
    root: resolvedRoot,
    runtimeCwd,
    agentDir: join(runtimeCwd, "pi-agent"),
    sessionDir: join(sessionRoot, "sessions"),
    identityProfilePath: join(runtimeCwd, "identity-profile.json"),
    identityProfileBindingPath: surfaceSessionId === undefined ? join(runtimeCwd, "identity-profile-binding.json") : join(sessionRoot, "identity-profile-binding.json"),
    runManifestPath: surfaceSessionId === undefined ? join(runtimeCwd, "companion-run-manifest.json") : join(sessionRoot, "companion-run-manifest.json"),
    ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
  };
}

/**
 * Create a Pi SDK session without coding-agent discovery. Only the installed,
 * pinned Magic Context extension can load; built-ins, project/user extensions,
 * skills, templates, context files, and coding prompts are excluded.
 */
export async function createCompanionRuntime(identity: CompanionIdentity, root?: string, integration?: IntegrationConnection, modelConfig?: CompanionModelConfig, actionPolicy?: IntegrationActionPolicy, presentation?: PresentationRuntime, gameplaySubagentEnabled = false, initialProfile?: IdentityProfile, surfaceSessionId?: string, worldBook?: WorldBookBinding, surface?: "chat" | "game", internalMagicContextFeatureTestOverride?: MagicContextFeatureTestOverride): Promise<RuntimeSession> {
  // A surface session ID identifies a persistent session; it must never be
  // used to infer the product surface because both Chat and Game have them.
  const runtimeSurface = surface ?? presentation?.surface ?? "game";
  const integrationModule: GameIntegrationModule | undefined = integration?.module;
  if (integration !== undefined && integrationModule === undefined) throw new Error("integration_module_required");
  if (integration !== undefined) {
    assertIntegrationModule(integration.module, integration.scope.integrationId);
    // The current Host-owned identity binding includes these opaque scope keys;
    // the module independently validates its transport/world facts.
    if (identity.saveId === undefined || identity.worldId === undefined
      || integration.scope.saveId !== identity.saveId || integration.scope.worldId !== identity.worldId
      || integration.scope.playerId !== identity.playerId || integration.scope.companionId !== identity.companionId) {
      throw new Error("Integration scope must exactly match the Companion runtime identity.");
    }
  }
  const mountedPolicy = actionPolicy === undefined
    ? integrationModule?.defaultPolicy ?? DEFAULT_INTEGRATION_ACTION_POLICY
    : integrationModule === undefined
      ? actionPolicy
      : integrationModule.parsePolicy(actionPolicy);
  const paths = resolveRuntimePaths(identity, root, surfaceSessionId);
  const identityProfileAlreadyExists = await pathExists(paths.identityProfilePath);
  await Promise.all([
    mkdir(paths.runtimeCwd, { recursive: true }),
    mkdir(paths.agentDir, { recursive: true }),
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(dirname(paths.identityProfileBindingPath), { recursive: true }),
    mkdir(join(paths.runtimeCwd, ".cortexkit"), { recursive: true }),
  ]);

  const profile = initialProfile !== undefined && !identityProfileAlreadyExists
    ? (await writeIdentityProfile(paths.identityProfilePath, initialProfile), initialProfile)
    : await readOrCreateIdentityProfile(paths.identityProfilePath);
  const profileMetadata = identityProfileMetadata(profile);
  const existingBinding = await readIdentityProfileBinding(paths.identityProfileBindingPath);
  const existingSessionFiles = await listSessionFiles(paths.sessionDir);
  if (existingBinding === null) {
    // A continuity owns one profile, while every explicit user-visible surface
    // session owns its own session binding. A new surface may therefore see an
    // existing profile but must never adopt pre-existing Pi JSONL without its
    // own binding.
    if (existingSessionFiles.length > 0 || (surfaceSessionId === undefined && identityProfileAlreadyExists)) throw new Error("identity_profile_mismatch");
  } else {
    assertProfileMatchesBinding(identityKey(identity), profile, existingBinding);
    if (existingBinding.sessionFile !== null && !existingSessionFiles.includes(existingBinding.sessionFile)) {
      throw new Error("identity_profile_mismatch");
    }
    if (existingBinding.sessionFile === null && existingSessionFiles.length > 1) {
      throw new Error("identity_profile_mismatch");
    }
  }

  // Magic Context's project config is intentionally generated in the opaque
  // runtime directory, never in the game repository. The approved v0.33.0-
  // gamebuddy.2 gates are native same-scope SEMANTIC_MEMORY injection and
  // automatic embedded Historian authoring restricted
  // to this Host-owned opaque continuity runtime; auto_search remains off and
  // Host never gains project-memory/SQLite authority.
  await writeFile(
    join(paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"),
    JSON.stringify({
      enabled: true,
      embedding: { provider: "off" },
      // Production selects the embedded-SDK, no-tool Historian. The internal
      // override can still disable it for A/B fixtures without changing any
      // Memory authority or exposing an authoring API.
      historian: internalMagicContextFeatureTestOverride?.historianEnabled === false
        ? { disable: true }
        : {
            model: `${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).provider}/${(modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).modelId}`,
            thinking_level: (modelConfig ?? DEFAULT_COMPANION_MODEL_CONFIG).thinkingLevel,
            disallowed_tools: ["*"],
          },
      ...(internalMagicContextFeatureTestOverride?.historianExecuteThresholdTokens === undefined
        ? {}
        : { execute_threshold_tokens: { default: internalMagicContextFeatureTestOverride.historianExecuteThresholdTokens } }),
      ...(internalMagicContextFeatureTestOverride?.historianExecuteThresholdPercentage === undefined
        ? {}
        : { execute_threshold_percentage: internalMagicContextFeatureTestOverride.historianExecuteThresholdPercentage }),
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
        enabled: internalMagicContextFeatureTestOverride?.memoryEnabled ?? MAGIC_CONTEXT_MEMORY_ENABLED,
        auto_promote: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
        // Keep explicit to prevent an upstream default flip from silently
        // enabling a current-session hint and being mistaken for continuity recall.
        auto_search: { enabled: MAGIC_CONTEXT_RECALL_ENABLED },
      },
      todowrite: { enabled: true, overlay: false },
      smart_drops: false,
      temporal_awareness: false,
    }, null, 2),
    "utf8",
  );

  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  // A pnpm `file:` dependency materializes only package.json/README when its
  // `files` whitelist excludes an unbuilt dist directory. Load the canonical
  // versioned vendor artifact instead, so a clean checkout never accidentally
  // relies on a stale pnpm-store copy. CI and product packaging build this
  // source-owned artifact before a Host runtime is started.
  const magicContextEntry = fileURLToPath(new URL("../../vendor/magic-context/packages/pi-plugin/dist/index.js", import.meta.url));
  if (!existsSync(magicContextEntry)) throw new Error("magic_context_extension_build_required");
  const loader = new DefaultResourceLoader({
    cwd: paths.runtimeCwd,
    agentDir: paths.agentDir,
    settingsManager: settings,
    noExtensions: true,
    additionalExtensionPaths: [magicContextEntry],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: runtimeSurface === "chat" ? buildChatCompanionSystemPrompt(profile) : buildCompanionSystemPrompt(profile),
    appendSystemPrompt: [],
  });
  // The fork must never spawn the external `pi` CLI from a GameBuddy runtime.
  // Mark the whole extension/bootstrap window so it selects the embedded
  // historian runner; its ModelRegistry is bound by the context pass before
  // any Historian work can be scheduled.
  const previousEmbeddedRuntimeMarker = process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
  process.env.GAMEBUDDY_EMBEDDED_RUNTIME = "1";
  try {
    // The extension discovers config/data through Node process globals. The
    // helper scopes and serializes that bootstrap so opaque partitions cannot
    // race each other during loader.reload().
    await reloadMagicContextInRuntimeRoot(loader, paths.runtimeCwd);

    if (loader.getExtensions().errors.length > 0) {
      throw new Error(`Magic Context extension failed to load: ${loader.getExtensions().errors.map((error) => error.error).join("; ")}`);
    }
  } finally {
    if (previousEmbeddedRuntimeMarker === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
    else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = previousEmbeddedRuntimeMarker;
  }

  const sessionManager = SessionManager.continueRecent(paths.runtimeCwd, paths.sessionDir);
  const modelRuntime = await createCompanionModelRuntime(paths, modelConfig);
  const model = modelConfig === undefined ? undefined : modelRuntime.getModel(modelConfig.provider, modelConfig.modelId);
  if (modelConfig !== undefined && model === undefined) throw new Error("companion_model_not_available");

  const companionStatus = createCompanionStatusTool(integration);
  const integrationToolSet = integration !== undefined && integrationModule !== undefined
    ? integrationModule.createToolSet({ connection: integration, knowledge: integration.knowledge, gameVersion: integration.gameVersion, policy: mountedPolicy })
    : undefined;
  const integrationTools = integrationToolSet === undefined ? [] : [
    ...integrationToolSet.observation,
    ...integrationToolSet.actions,
    ...integrationToolSet.knowledge,
  ];
  const presentationTools = presentation === undefined ? [] : createCompanionPresentationTools(presentation);
  const worldBookTools = worldBook === undefined ? [] : createWorldBookTools(worldBook, integration === undefined ? undefined : { integrationId: integration.scope.integrationId, saveId: integration.scope.saveId, worldId: integration.scope.worldId });
  const gameplaySubagent = gameplaySubagentEnabled
    ? integration !== undefined && modelConfig !== undefined
      ? new GameplayTaskSubagent(paths, integration, mountedPolicy)
      : (() => { throw new Error("gameplay_subagent_requires_model_and_integration"); })()
    : undefined;
  const gameplayTools = gameplaySubagent === undefined ? [] : [gameplaySubagent.createDelegateTool()];
  const allowedToolNames = [...PHASE_0B_ALLOWED_TOOL_NAMES, "todowrite", ...integrationTools.map((tool) => tool.name), ...worldBookTools.map((tool) => tool.name), ...presentationTools.map((tool) => tool.name), ...gameplayTools.map((tool) => tool.name)].sort();
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
      customTools: [companionStatus, ...integrationTools, ...worldBookTools, ...presentationTools, ...gameplayTools],
      thinkingLevel: modelConfig?.thinkingLevel ?? "off",
    }));
  } finally {
    if (previousEmbeddedRuntimeMarker === undefined) delete process.env.GAMEBUDDY_EMBEDDED_RUNTIME;
    else process.env.GAMEBUDDY_EMBEDDED_RUNTIME = previousEmbeddedRuntimeMarker;
  }

  const activeTools = session.agent.state.tools.map((tool) => tool.name).sort();
  const expectedTools = allowedToolNames;
  if (JSON.stringify(activeTools) !== JSON.stringify(expectedTools)) {
    session.dispose();
    throw new Error(`Companion tool isolation failed: expected ${expectedTools.join(", ")}, got ${activeTools.join(", ") || "(none)"}.`);
  }

  const sessionFile = session.sessionFile === undefined || !(await pathExists(session.sessionFile)) ? null : basename(session.sessionFile);
  const expectedSessionFile = existingBinding?.sessionFile ?? (existingSessionFiles.length === 1 ? existingSessionFiles[0] : null);
  if (existingBinding !== null && expectedSessionFile !== null && expectedSessionFile !== sessionFile) {
    session.dispose();
    throw new Error("identity_profile_mismatch");
  }
  await writeIdentityProfileBinding(
    paths.identityProfileBindingPath,
    createIdentityProfileBinding(identityKey(identity), profile, sessionFile),
  );
  await writeOrVerifyRunManifest(paths, {
    schemaVersion: 1,
    identity,
    runtime: RUNTIME_PACKAGE_VERSIONS,
    model: { provider: modelConfig?.provider ?? null, modelId: modelConfig?.modelId ?? null, thinkingLevel: modelConfig?.thinkingLevel ?? null },
    gameplaySubagentModel: gameplaySubagent === undefined ? null : gameplaySubagent.modelConfig,
    actionRegistryRevision: actionRegistryRevision(integrationModule?.actionCatalog.entries ?? []),
    actionPolicy: mountedPolicy,
    mountedTools: activeTools,
    knowledge: integrationModule === undefined
      ? { mounted: false, gameVersion: null, bundleVersion: null }
      : integrationModule.knowledgeMetadata({ connection: integration, knowledge: integration?.knowledge, gameVersion: integration?.gameVersion }),
    identityProfile: profileMetadata,
    worldBook: worldBook === undefined ? null : worldBook.metadata,
    presentation: presentation?.profile ?? null,
    featureFlags: {
      gameplaySubagent: gameplaySubagent !== undefined,
      magicContextMemoryDomain: MAGIC_CONTEXT_MEMORY_DOMAIN,
      magicContextMemoryEnabled: MAGIC_CONTEXT_MEMORY_ENABLED,
      magicContextAutoPromoteEnabled: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
      magicContextAutoSearchEnabled: MAGIC_CONTEXT_RECALL_ENABLED,
    },
  });

  return {
    session,
    sessionManager,
    paths,
    identityKey: identityKey(identity),
    identityProfile: profileMetadata,
    profile,
    extensions: loader.getExtensions().extensions.map((extension) => extension.path),
    ...(gameplaySubagent === undefined ? {} : { gameplaySubagent }),
  };
}

/**
 * Creates an opaque-runtime-only Pi registry for the locked Companion Agent.
 * Credentials are resolved from CPA_OAI_API_KEY by Pi at request time and are
 * never written into the identity partition.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  return (await readdir(sessionDir)).filter((entry) => /^[A-Za-z0-9._-]{1,256}\.jsonl$/.test(entry)).sort();
}

async function createCompanionModelRuntime(paths: RuntimePaths, config: CompanionModelConfig | undefined): Promise<ModelRuntime> {
  const modelsPath = join(paths.agentDir, "models.json");
  const providers = config === undefined ? {} : {
    "cpa-oai": {
      name: "CPA OpenAI-compatible Agent",
      baseUrl: "http://127.0.0.1:8317/v1",
      api: "openai-completions",
      apiKey: "$CPA_OAI_API_KEY",
      authHeader: true,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [{
        id: config.modelId,
        name: config.modelId,
        reasoning: true,
        // CPA's DeepSeek V4 Flash route was live-verified with thinking enabled
        // and ordinary `tools`; it rejects forced OpenAI `tool_choice` in
        // thinking mode, which Pi does not emit for this surface.
        thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max" },
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          maxTokensField: "max_tokens",
          thinkingFormat: "deepseek",
          requiresReasoningContentOnAssistantMessages: true,
          supportsStrictMode: true,
        },
      }],
    },
  };
  await writeFile(modelsPath, JSON.stringify({ providers }, null, 2), "utf8");
  // Offline by default. Selecting the explicitly configured Agent model is the
  // operator's opt-in to provider networking; no request occurs merely while
  // creating or resuming the session.
  return ModelRuntime.create({ authPath: join(paths.agentDir, "auth.json"), modelsPath, modelsStorePath: join(paths.agentDir, "models-store.json"), allowModelNetwork: config !== undefined });
}
