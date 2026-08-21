import { type IntegrationLauncher } from "./integration-launcher.js";
import type { GameCompanionIdentity } from "./runtime-core.js";

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/** Adapter-derived opaque identity scope. The Host never parses game fields. */
export type IntegrationIdentityScope = Readonly<{
  saveId: string;
  worldId: string;
}>;

/**
 * A launcher validates its own operator config and returns only the game scope
 * Host needs for path partitioning and continuity binding. `launchConfig`
 * remains opaque after this point.
 */
export type PreparedIntegrationLaunch = Readonly<{
  launchConfig: unknown;
  /** Every executable game surface is save/world scoped, even under continuity. */
  identityScope: Readonly<{ saveId: string; worldId: string }>;
}>;

export type ConfigurableIntegrationLauncher = IntegrationLauncher & Readonly<{
  prepare(config: unknown, context: Readonly<{ configDirectory: string }>): Promise<PreparedIntegrationLaunch>;
}>;

export type IntegrationCatalog = Readonly<{
  ids: readonly string[];
  get(integrationId: string): ConfigurableIntegrationLauncher | undefined;
  select(integrationId: string, config: unknown, context: Readonly<{ configDirectory: string }>): Promise<Readonly<{
    launcher: ConfigurableIntegrationLauncher;
    prepared: PreparedIntegrationLaunch;
  }>>;
}>;

/**
 * Product composition registry. Only explicitly compiled, receipt-backed
 * adapters can be selected; fixture adapters are never registered here.
 */
export function createIntegrationCatalog(launchers: readonly ConfigurableIntegrationLauncher[]): IntegrationCatalog {
  if (!Array.isArray(launchers) || launchers.length === 0 || launchers.length > 32) {
    throw new Error("invalid_integration_catalog");
  }
  const byId = new Map<string, ConfigurableIntegrationLauncher>();
  for (const launcher of launchers) {
    if (!isLauncher(launcher) || byId.has(launcher.integrationId)) {
      throw new Error("invalid_integration_catalog");
    }
    byId.set(launcher.integrationId, launcher);
  }
  const ids = Object.freeze([...byId.keys()].sort());
  return Object.freeze({
    ids,
    get: (integrationId) => byId.get(integrationId),
    async select(integrationId, config, context) {
      if (!IDENTIFIER.test(integrationId) || !isDirectory(context.configDirectory)) {
        throw new Error("invalid_integration_selection");
      }
      const launcher = byId.get(integrationId);
      if (launcher === undefined) throw new Error("integration_not_registered");
      const prepared = await launcher.prepare(config, context);
      assertPreparedLaunch(prepared);
      return Object.freeze({ launcher, prepared });
    },
  });
}

/** Merge Host-owned player/companion/continuity identity with validated adapter scope. */
export function bindIntegrationIdentity(
  identity: Readonly<{ playerId: string; companionId: string; continuityId?: string }>,
  scope: IntegrationIdentityScope,
): GameCompanionIdentity {
  if (!isOpaque(identity.playerId) || !isOpaque(identity.companionId)
    || (identity.continuityId !== undefined && !isOpaque(identity.continuityId))
    || !isOpaque(scope.saveId)
    || !isOpaque(scope.worldId)) {
    throw new Error("invalid_integration_identity_scope");
  }
  const scoped: GameCompanionIdentity = {
    playerId: identity.playerId,
    companionId: identity.companionId,
    saveId: scope.saveId,
    worldId: scope.worldId,
    ...(identity.continuityId === undefined ? {} : { continuityId: identity.continuityId }),
  };
  return Object.freeze(scoped);
}

function assertPreparedLaunch(value: unknown): asserts value is PreparedIntegrationLaunch {
  if (!isRecord(value) || !("launchConfig" in value) || !isRecord(value.identityScope)) {
    throw new Error("invalid_integration_selection");
  }
  const scope = value.identityScope;
  if (!isOpaque(scope.saveId) || !isOpaque(scope.worldId)) {
    throw new Error("invalid_integration_identity_scope");
  }
}

function isLauncher(value: unknown): value is ConfigurableIntegrationLauncher {
  return isRecord(value)
    && typeof value.integrationId === "string" && IDENTIFIER.test(value.integrationId)
    && typeof value.launch === "function" && typeof value.prepare === "function";
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isDirectory(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
