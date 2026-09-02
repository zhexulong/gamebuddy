/** Public Companion runtime surface. Construction-only extensions live in non-barrel internal modules. */
import {
  createCompanionRuntime as createCompanionRuntimeInternal,
  createGameCompanionRuntime as createGameCompanionRuntimeInternal,
} from "./runtime-core.internal.js";
import type {
  CompanionIdentity,
  CompanionModelConfig,
  GameCompanionIdentity,
  GameCompanionRuntimeAttachment,
  GameHostBindingFactory,
  GameOperationalGateConfig,
  RuntimeSession,
} from "./runtime-core.internal.js";
import type { IdentityProfile } from "./identity-profile.js";
import type { IntegrationActionPolicy } from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";
import type { PresentationRuntime } from "./presentation.js";
import type { WorldBookBinding } from "./worldbook.js";

export {
  RUNTIME_PACKAGE_VERSIONS,
  MAGIC_CONTEXT_MEMORY_DOMAIN,
  MAGIC_CONTEXT_RECALL_ENABLED,
  MAGIC_CONTEXT_MEMORY_ENABLED,
  MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
  MAGIC_CONTEXT_HISTORIAN_ENABLED,
  createCompanionStatusTool,
  companionStatusTool,
  PHASE_0B_ALLOWED_TOOL_NAMES,
  assertFrozenFixedTools,
  identityKey,
  resolveRuntimePaths,
  DEFAULT_COMPANION_MODEL_CONFIG,
  resolveMagicContextExtensionEntry,
} from "./runtime-core.internal.js";
export type {
  CompanionIdentity,
  GameCompanionIdentity,
  RuntimePaths,
  CompanionThinkingLevel,
  CompanionModelConfig,
  RuntimeSession,
  GameOperationalGateConfig,
  GameHostBindingFactory,
  GameCompanionRuntimeAttachment,
} from "./runtime-core.internal.js";

/** Public construction never admits fixed Pi tools. */
export async function createCompanionRuntime(
  identity: CompanionIdentity,
  root?: string,
  integration?: GameConnection,
  modelConfig?: CompanionModelConfig,
  actionPolicy?: IntegrationActionPolicy,
  presentation?: PresentationRuntime,
  gameplaySubagentEnabled = false,
  initialProfile?: IdentityProfile,
  surfaceSessionId?: string,
  worldBook?: WorldBookBinding,
  surface?: "chat" | "game",
  internalMagicContextFeatureTestOverride?: Parameters<typeof createCompanionRuntimeInternal>[11],
  tavernStableContextSnapshot?: unknown,
  tavernNarrativeGateNonceSha256?: string,
): Promise<RuntimeSession> {
  return await createCompanionRuntimeInternal(identity, root, integration, modelConfig, actionPolicy, presentation, gameplaySubagentEnabled, initialProfile, surfaceSessionId, worldBook, surface, internalMagicContextFeatureTestOverride, tavernStableContextSnapshot, tavernNarrativeGateNonceSha256);
}

/** Public construction never admits fixed Pi tools. */
export async function createGameCompanionRuntime(
  identity: GameCompanionIdentity,
  root: string,
  integration: GameConnection,
  gameSessionId: string,
  gameOperationalGate: GameOperationalGateConfig | undefined,
  gameHostBindingFactory?: GameHostBindingFactory,
  attachment?: GameCompanionRuntimeAttachment,
): Promise<RuntimeSession> {
  return await createGameCompanionRuntimeInternal(identity, root, integration, gameSessionId, gameOperationalGate, gameHostBindingFactory, attachment);
}
