import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { IntegrationConnection } from "./integration-types.js";

/** Host-owned identity fields that a selected module may bind to its connection. */
export type IntegrationIdentityBinding = Readonly<{
  playerId: string;
  companionId: string;
  saveId?: string;
  worldId?: string;
}>;

/** Current-world key consumed by Host-owned WorldBook filtering, when applicable. */
export type IntegrationWorldScope = Readonly<{
  integrationId: string;
  saveId: string;
  worldId: string;
}>;

export type IntegrationActionLifecycle = "published" | "experimental" | "diagnostic" | "planned";

/** The common deny-by-exception policy shape. Each module owns its parser. */
export type IntegrationActionPolicy = Readonly<{
  policyVersion: 1;
  deniedActions: readonly string[];
  deniedFamilies: readonly string[];
}>;

export const DEFAULT_INTEGRATION_ACTION_POLICY: IntegrationActionPolicy = Object.freeze({
  policyVersion: 1,
  deniedActions: Object.freeze([]),
  deniedFamilies: Object.freeze([]),
});

/** A module-neutral terminal/non-terminal execution receipt projection. */
export type IntegrationExecutionReceipt = Readonly<{
  requestId: string;
  executionId: string;
  state: string;
  reasonCode: string;
  revision: number | null;
  evidence: Readonly<Record<string, unknown>> | null;
}>;

/** The minimum state view needed by Host lifecycle and budget code. */
export type IntegrationStateView = Readonly<{
  connected: boolean;
  sessionId: string | null;
  capabilities: readonly string[];
  snapshotRevision: number | null;
  activeExecution: Readonly<{ requestId: string; executionId: string; state: string }> | null;
  latestReceipt: IntegrationExecutionReceipt | null;
  latestReasonCode: string | null;
}>;

export type IntegrationActionDescriptor = Readonly<{
  actionId: string;
  familyId: string;
  lifecycle: IntegrationActionLifecycle;
  label: string;
  description: string;
  targetKinds: readonly string[];
  requiredCapability: string;
}>;

export type IntegrationReceiptEvidence = Readonly<{
  state: string;
  reasonCode: string;
  evidence: Readonly<Record<string, unknown>> | null;
}>;

export type IntegrationToolContext = Readonly<{
  connection: IntegrationConnection;
  /** Advisory data is opaque to Host core and interpreted only by the module. */
  knowledge?: unknown;
  gameVersion?: string;
  policy?: IntegrationActionPolicy;
}>;

export type IntegrationToolSet = Readonly<{
  observation: readonly ToolDefinition[];
  actions: readonly ToolDefinition[];
  knowledge: readonly ToolDefinition[];
}>;

export type IntegrationModuleConformance = Readonly<{
  toolNames: readonly string[];
  actionCatalogRevision: string;
}>;

export type IntegrationKnowledgeMetadata = Readonly<{
  mounted: boolean;
  gameVersion: string | null;
  bundleVersion: number | null;
}>;

/**
 * Stable adapter-owned metadata that Host may expose through companion_status.
 * The Host does not interpret game-specific facts or derive permissions here.
 */
export type IntegrationStatusDetails = Readonly<{
  connected: boolean;
  capabilities: readonly string[];
  snapshotRevision: number | null;
  latestReceiptState: string | null;
  latestReasonCode: string | null;
}>;

export type IntegrationActionCatalog = Readonly<{
  entries: readonly IntegrationActionDescriptor[];
  revision: string;
  get(actionId: string): IntegrationActionDescriptor | undefined;
  visibleActions(capabilities: readonly string[], policy?: IntegrationActionPolicy): readonly IntegrationActionDescriptor[];
  searchVisibleActions(capabilities: readonly string[], query: string, policy?: IntegrationActionPolicy): readonly IntegrationActionDescriptor[];
  familyFor(actionId: string): string | undefined;
  isPublished(actionId: string): boolean;
  hasCompletionEvidence(actionId: string, receipt: IntegrationReceiptEvidence): boolean;
}>;

export type GameIntegrationModule = Readonly<{
  descriptor: Readonly<{
    integrationId: string;
    version: string;
    /** Every module-owned tool must live under this stable namespace. */
    toolNamePrefix: string;
  }>;
  actionCatalog: IntegrationActionCatalog;
  defaultPolicy: IntegrationActionPolicy;
  parsePolicy(value: unknown): IntegrationActionPolicy;
  /** Reject a connection that does not match the Host-owned Companion identity. */
  assertIdentityBinding(connection: IntegrationConnection, identity: IntegrationIdentityBinding): void;
  /** Return the optional current-world key for Host-owned WorldBook filtering. */
  worldScope(connection: IntegrationConnection): IntegrationWorldScope | null;
  /** Materialize only tools backed by this module's validated connection. */
  createToolSet(context: IntegrationToolContext): IntegrationToolSet;
  /** Return immutable manifest metadata without exposing adapter state. */
  knowledgeMetadata(context: Readonly<{ connection?: IntegrationConnection; knowledge?: unknown; gameVersion?: string }>): IntegrationKnowledgeMetadata;
  /** Project adapter-owned state into the small Host lifecycle view. */
  readState(connection: IntegrationConnection): IntegrationStateView;
  /** Project only bounded status fields for the player-facing Host status tool. */
  status(connection: IntegrationConnection): IntegrationStatusDetails;
  /** Request cancellation through the adapter; the adapter/remote game remains authoritative. */
  cancelExecution(connection: IntegrationConnection, requestId: string, executionId: string, reasonCode: string): unknown;
  /** Parse this module's action-tool result into a receipt without trusting model text. */
  parseReceipt(details: unknown): IntegrationExecutionReceipt | null;
  /** Map module-owned tool names back to action IDs for Host budgets/receipts. */
  actionIdForToolName(toolName: string): string | null;
  /** Identify the module-owned exact-execution cancellation tool. */
  isCancellationTool(toolName: string): boolean;
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME_PREFIX = /^[a-z][a-z0-9_-]{0,31}_$/;
const VERSION = /^[A-Za-z0-9_.-]{1,64}$/;
const LIFECYCLES = new Set<IntegrationActionLifecycle>(["published", "experimental", "diagnostic", "planned"]);

/**
 * Build a deterministic catalog for one integration. The catalog owns
 * visibility and action-family lookup so Host core never needs a Stardew- or
 * game-specific registry import.
 */
export function createIntegrationActionCatalog(
  entries: readonly IntegrationActionDescriptor[],
  hasCompletionEvidence: (actionId: string, receipt: IntegrationReceiptEvidence) => boolean = () => false,
): IntegrationActionCatalog {
  if (!Array.isArray(entries) || entries.length > 512) throw new Error("invalid_integration_action_catalog");
  const normalized = entries.map((entry) => {
    if (!isRecord(entry)) throw new Error("invalid_integration_action_catalog");
    const { actionId, familyId, lifecycle, label, description, targetKinds, requiredCapability } = entry;
    if (!isIdentifier(actionId)
      || !isIdentifier(familyId)
      || !isIdentifier(requiredCapability)
      || !isLifecycle(lifecycle)
      || !boundedText(label, 256)
      || !boundedText(description, 4_096)
      || !Array.isArray(targetKinds)
      || targetKinds.length > 32
      || !targetKinds.every(isIdentifier)) {
      throw new Error("invalid_integration_action_catalog");
    }
    return Object.freeze({
      actionId,
      familyId,
      lifecycle,
      label,
      description,
      targetKinds: Object.freeze([...targetKinds]),
      requiredCapability,
    });
  });
  const actionIds = new Set<string>();
  for (const entry of normalized) {
    if (actionIds.has(entry.actionId)) throw new Error("duplicate_integration_action");
    actionIds.add(entry.actionId);
  }
  const frozenEntries = Object.freeze(normalized);
  const byId = new Map(frozenEntries.map((entry) => [entry.actionId, entry]));
  const revision = createHash("sha256").update(JSON.stringify(frozenEntries)).digest("hex");
  const visible = (capabilities: readonly string[], policy?: IntegrationActionPolicy): readonly IntegrationActionDescriptor[] => {
    const capabilitySet = new Set(capabilities);
    const deniedActions = new Set(policy?.deniedActions ?? []);
    const deniedFamilies = new Set(policy?.deniedFamilies ?? []);
    return frozenEntries.filter((entry) => entry.lifecycle === "published"
      && capabilitySet.has(entry.requiredCapability)
      && !deniedActions.has(entry.actionId)
      && !deniedFamilies.has(entry.familyId));
  };
  const search = (capabilities: readonly string[], query: string, policy?: IntegrationActionPolicy): readonly IntegrationActionDescriptor[] => {
    const available = visible(capabilities, policy);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return available;
    return available.filter((entry) => `${entry.actionId} ${entry.familyId} ${entry.label} ${entry.description}`.toLocaleLowerCase().includes(normalizedQuery));
  };
  return Object.freeze({
    entries: frozenEntries,
    revision,
    get: (actionId: string) => byId.get(actionId),
    visibleActions: visible,
    searchVisibleActions: search,
    familyFor: (actionId: string) => byId.get(actionId)?.familyId,
    isPublished: (actionId: string) => byId.get(actionId)?.lifecycle === "published",
    hasCompletionEvidence: (actionId: string, receipt: IntegrationReceiptEvidence) => hasCompletionEvidence(actionId, receipt),
  });
}

export function assertIntegrationModule(module: GameIntegrationModule, integrationId: string): void {
  if (!isRecord(module)
    || !isRecord(module.descriptor)
    || !isIdentifier(module.descriptor.integrationId)
    || !VERSION.test(module.descriptor.version)
    || !isToolNamePrefix(module.descriptor.toolNamePrefix)
    || module.descriptor.integrationId !== integrationId
    || typeof module.assertIdentityBinding !== "function"
    || typeof module.worldScope !== "function"
    || typeof module.createToolSet !== "function"
    || typeof module.knowledgeMetadata !== "function"
    || typeof module.status !== "function"
    || typeof module.readState !== "function"
    || typeof module.parsePolicy !== "function"
    || typeof module.cancelExecution !== "function"
    || typeof module.parseReceipt !== "function"
    || typeof module.actionIdForToolName !== "function"
    || typeof module.isCancellationTool !== "function"
    || !isRecord(module.actionCatalog)
    || !Array.isArray(module.actionCatalog.entries)
    || typeof module.actionCatalog.revision !== "string"
    || typeof module.actionCatalog.get !== "function"
    || typeof module.actionCatalog.visibleActions !== "function"
    || typeof module.actionCatalog.searchVisibleActions !== "function"
    || typeof module.actionCatalog.familyFor !== "function"
    || typeof module.actionCatalog.isPublished !== "function"
    || typeof module.actionCatalog.hasCompletionEvidence !== "function"
    || module.actionCatalog.entries.some((entry) => !isIdentifier(entry.actionId) || !isIdentifier(entry.familyId))) {
    throw new Error("integration_module_scope_mismatch");
  }
  try {
    const canonicalRevision = createIntegrationActionCatalog(module.actionCatalog.entries, module.actionCatalog.hasCompletionEvidence).revision;
    if (!/^[a-f0-9]{64}$/.test(module.actionCatalog.revision) || canonicalRevision !== module.actionCatalog.revision) {
      throw new Error("integration_module_catalog_revision_mismatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "integration_module_catalog_revision_mismatch") throw error;
    throw new Error("integration_module_scope_mismatch");
  }
}

/**
 * Structural conformance check shared by adapter tests. It intentionally
 * validates only the Host/module seam; transport and game-specific behavior
 * remain owned by the integration adapter and its live gates.
 */
export function assertIntegrationModuleConformance(
  module: GameIntegrationModule,
  connection: IntegrationConnection,
): IntegrationModuleConformance {
  if (connection.module !== module || connection.scope.integrationId !== module.descriptor.integrationId) {
    throw new Error("integration_module_scope_mismatch");
  }
  assertIntegrationModule(module, connection.scope.integrationId);
  const tools = module.createToolSet({ connection, knowledge: connection.knowledge, gameVersion: connection.gameVersion });
  const status = module.status(connection);
  if (!Array.isArray(status.capabilities) || status.capabilities.length > 512 || status.capabilities.some((capability) => !isIdentifier(capability))) {
    throw new Error("integration_status_view_invalid");
  }
  const toolGroups = [tools.observation, tools.actions, tools.knowledge];
  if (!toolGroups.every((group) => Array.isArray(group))) throw new Error("integration_tool_set_invalid");
  const names = toolGroups.flat().map((tool) => tool.name);
  const actionIds = new Set(module.actionCatalog.entries.map((entry) => entry.actionId));
  for (const name of names) {
    if (typeof name !== "string" || !name.startsWith(module.descriptor.toolNamePrefix) || name.length > 128 || name.startsWith("ctx_")) {
      throw new Error("integration_tool_namespace_invalid");
    }
    const actionId = module.actionIdForToolName(name);
    if (actionId !== null && !actionIds.has(actionId)) throw new Error("integration_tool_action_unregistered");
  }
  if (new Set(names).size !== names.length) throw new Error("duplicate_integration_tool");
  const state = module.readState(connection);
  if (!Array.isArray(state.capabilities) || (state.activeExecution !== null && !isRecord(state.activeExecution))) {
    throw new Error("integration_state_view_invalid");
  }
  return Object.freeze({ toolNames: Object.freeze([...names].sort()), actionCatalogRevision: module.actionCatalog.revision });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isToolNamePrefix(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAME_PREFIX.test(value);
}

function isLifecycle(value: unknown): value is IntegrationActionLifecycle {
  return typeof value === "string" && LIFECYCLES.has(value as IntegrationActionLifecycle);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
