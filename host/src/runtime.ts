import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
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

import { createStardewActionTools, createStardewObservationTools } from "./game-tools.js";
import { type CompanionIntegration } from "./integration-types.js";

export const RUNTIME_PACKAGE_VERSIONS = Object.freeze({
  pi: "0.82.1",
  magicContext: "0.33.0",
});

/**
 * The only application-facing tool in Phase 0B. It is deterministic and has
 * no filesystem, process, network, game, or bridge access.
 */
export const companionStatusTool = defineTool({
  name: "companion_status",
  label: "Companion Status",
  description: "Return the fixed Phase 0B Companion Host status.",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: "GameBuddy Companion Host: Phase 0B runtime scaffold; no game capabilities enabled." }],
    details: { phase: "0B", gameCapabilitiesEnabled: false },
  }),
});

export const PHASE_0B_ALLOWED_TOOL_NAMES = Object.freeze(["companion_status"]);

export type CompanionIdentity = Readonly<{
  playerId: string;
  saveId: string;
  worldId: string;
  companionId: string;
}>;

export type RuntimePaths = Readonly<{
  root: string;
  runtimeCwd: string;
  agentDir: string;
  sessionDir: string;
}>;

export type CompanionModelConfig = Readonly<{
  provider: "xiaomi-mimo";
  modelId: "mimo-v2.5" | "mimo-v2.5-pro";
}>;

export type RuntimeSession = Readonly<{
  session: AgentSession;
  sessionManager: SessionManager;
  paths: RuntimePaths;
  identityKey: string;
  extensions: readonly string[];
}>;

function requireOpaqueSegment(label: string, value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${label} must be a 1–128 character opaque identifier using only letters, digits, _ and -.`);
  }
  return value;
}

/** Stable, non-display-name identity partition for a single player/save/world/companion. */
export function identityKey(identity: CompanionIdentity): string {
  const canonical = [
    requireOpaqueSegment("playerId", identity.playerId),
    requireOpaqueSegment("saveId", identity.saveId),
    requireOpaqueSegment("worldId", identity.worldId),
    requireOpaqueSegment("companionId", identity.companionId),
  ].join("\u001f");

  return createHash("sha256").update(canonical).digest("hex");
}

export function resolveRuntimePaths(identity: CompanionIdentity, root = join(homedir(), ".gamebuddy")): RuntimePaths {
  const key = identityKey(identity);
  const resolvedRoot = resolve(root);
  const runtimeCwd = join(resolvedRoot, "contexts", key);

  return {
    root: resolvedRoot,
    runtimeCwd,
    agentDir: join(runtimeCwd, "pi-agent"),
    sessionDir: join(runtimeCwd, "sessions"),
  };
}

/**
 * Create a Pi SDK session without coding-agent discovery. Only the installed,
 * pinned Magic Context extension can load; built-ins, project/user extensions,
 * skills, templates, context files, and coding prompts are excluded.
 */
export async function createCompanionRuntime(identity: CompanionIdentity, root?: string, integration?: CompanionIntegration, modelConfig?: CompanionModelConfig): Promise<RuntimeSession> {
  if (integration !== undefined && (
    integration.scope.saveId !== identity.saveId || integration.scope.worldId !== identity.worldId
    || integration.scope.playerId !== identity.playerId || integration.scope.companionId !== identity.companionId
  )) {
    throw new Error("Integration scope must exactly match the Companion runtime identity.");
  }
  const paths = resolveRuntimePaths(identity, root);
  await Promise.all([
    mkdir(paths.runtimeCwd, { recursive: true }),
    mkdir(paths.agentDir, { recursive: true }),
    mkdir(paths.sessionDir, { recursive: true }),
    mkdir(join(paths.runtimeCwd, ".cortexkit"), { recursive: true }),
  ]);

  // Magic Context's project config is intentionally generated in the opaque
  // runtime directory, never in the game repository. Disable autonomous/cross-
  // context features until their separate product gates are passed.
  await writeFile(
    join(paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"),
    JSON.stringify({
      enabled: true,
      embedding: { provider: "off" },
      // Historian may render the Companion's session history but must never
      // gain tools. Tool isolation is enforced again by createAgentSession.
      historian: { enabled: true, disallowed_tools: ["*"] },
      dreamer: { disable: true, inject_docs: false },
      sidekick: { disable: true },
      memory: { enabled: false, auto_promote: false, auto_search: { enabled: false } },
      todowrite: { enabled: true, overlay: false },
      smart_drops: false,
      temporal_awareness: false,
    }, null, 2),
    "utf8",
  );

  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const magicContextEntry = import.meta.resolve("@cortexkit/pi-magic-context");
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
    systemPrompt: "You are GameBuddy Companion Host. You are not a coding agent. Use only explicitly enabled Companion tools. Do not claim a game action occurred unless an authoritative game receipt is supplied.",
    appendSystemPrompt: [],
  });
  // The Magic Context extension resolves its boot configuration from
  // process.cwd(). Scope that one-time initialization to the opaque runtime
  // directory; restore it immediately so the embedding app remains stable.
  const previousCwd = process.cwd();
  const previousDataDir = process.env.XDG_DATA_HOME;
  try {
    // Magic Context resolves its SQLite root from XDG_DATA_HOME. Keep the
    // database inside this exact opaque context partition, not its normal
    // cross-harness global location, until cross-context Memory is approved.
    process.env.XDG_DATA_HOME = join(paths.runtimeCwd, "data");
    process.chdir(paths.runtimeCwd);
    await loader.reload();
  } finally {
    process.chdir(previousCwd);
    if (previousDataDir === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataDir;
  }

  if (loader.getExtensions().errors.length > 0) {
    throw new Error(`Magic Context extension failed to load: ${loader.getExtensions().errors.map((error) => error.error).join("; ")}`);
  }

  const sessionManager = SessionManager.continueRecent(paths.runtimeCwd, paths.sessionDir);
  const modelRuntime = await createCompanionModelRuntime(paths, modelConfig);
  const model = modelConfig === undefined ? undefined : modelRuntime.getModel(modelConfig.provider, modelConfig.modelId);
  if (modelConfig !== undefined && model === undefined) throw new Error("companion_model_not_available");

  const integrationTools = integration === undefined ? [] : [...createStardewObservationTools(integration), ...createStardewActionTools(integration)];
  const allowedToolNames = [...PHASE_0B_ALLOWED_TOOL_NAMES, "todowrite", ...integrationTools.map((tool) => tool.name)].sort();
  const { session } = await createAgentSession({
    cwd: paths.runtimeCwd,
    agentDir: paths.agentDir,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager,
    modelRuntime,
    model,
    noTools: "all",
    tools: allowedToolNames,
    customTools: [companionStatusTool, ...integrationTools],
    thinkingLevel: "off",
  });

  const activeTools = session.agent.state.tools.map((tool) => tool.name).sort();
  const expectedTools = allowedToolNames;
  if (JSON.stringify(activeTools) !== JSON.stringify(expectedTools)) {
    session.dispose();
    throw new Error(`Phase 0B tool isolation failed: expected ${expectedTools.join(", ")}, got ${activeTools.join(", ") || "(none)"}.`);
  }

  return {
    session,
    sessionManager,
    paths,
    identityKey: identityKey(identity),
    extensions: loader.getExtensions().extensions.map((extension) => extension.path),
  };
}

/**
 * Creates an opaque-runtime-only OpenAI-compatible MiMo registry. The key is
 * resolved from MIMO_API_KEY only at request time and is never written here.
 */
async function createCompanionModelRuntime(paths: RuntimePaths, config: CompanionModelConfig | undefined): Promise<ModelRuntime> {
  const modelsPath = join(paths.agentDir, "models.json");
  const providers = config === undefined ? {} : {
    "xiaomi-mimo": {
      name: "Xiaomi MiMo",
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
      apiKey: "$MIMO_API_KEY",
      headers: { "api-key": "$MIMO_API_KEY" },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false, maxTokensField: "max_tokens" },
      models: [{ id: config.modelId, name: config.modelId, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  };
  await writeFile(modelsPath, JSON.stringify({ providers }, null, 2), "utf8");
  // Offline by default. Selecting the explicitly configured MiMo model is the
  // operator's opt-in to provider networking; no request occurs merely while
  // creating or resuming the session.
  return ModelRuntime.create({ authPath: join(paths.agentDir, "auth.json"), modelsPath, modelsStorePath: join(paths.agentDir, "models-store.json"), allowModelNetwork: config !== undefined });
}
