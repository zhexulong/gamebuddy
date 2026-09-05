import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ExecutionCorrelationOwner,
  ExecutionDispatchObserver,
} from "./execution-correlation-ledger.js";
import type { GameConnection } from "./game-connection.js";

/** Host-owned companion and world facts bound to one authenticated integration connection. */
export type IntegrationIdentityBinding = Readonly<{
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

type IntegrationActionLifecycle =
  "published" | "experimental" | "diagnostic" | "planned";

/** The common deny-by-exception policy shape. Each adapter owns its parser. */
export type IntegrationActionPolicy = Readonly<{
  policyVersion: 1;
  deniedActions: readonly string[];
  deniedFamilies: readonly string[];
}>;

export const DEFAULT_INTEGRATION_ACTION_POLICY: IntegrationActionPolicy =
  Object.freeze({
    policyVersion: 1,
    deniedActions: Object.freeze([]),
    deniedFamilies: Object.freeze([]),
  });

/** A adapter-neutral terminal/non-terminal execution receipt projection. */
export type IntegrationExecutionReceipt = Readonly<{
  requestId: string;
  executionId: string;
  /** Exact integration-authored action lineage; never inferred from Host tool context. */
  actionId: string;
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
  /** Authenticated live execution availability; absent fails closed. */
  enabledActionIds?: readonly string[];
  /** Monotone integration-owned availability publication, distinct from world snapshot revision. */
  capabilityRevision: number | null;
  /** Authenticated adapter-owned registration facts for the current connection generation. Absence is an empty catalog. */
  registrations?: readonly IntegrationActionRegistration[];
  snapshotRevision: number | null;
  activeExecution: Readonly<{
    actionId: string;
    requestId: string;
    executionId: string;
    state: string;
  }> | null;
  latestReceipt: IntegrationExecutionReceipt | null;
  latestReasonCode: string | null;
}>;

/** Adapter-local implementation availability; it cannot publish an action. */
export type IntegrationActionAdapter = Readonly<{
  actionId: string;
  /** Extra fixture-only fields are discarded at the Host adapter boundary. */
  readonly [key: string]: unknown;
}>;

/** Authenticated integration-owned action registration facts. */
export type IntegrationActionRegistration = Readonly<{
  actionId: string;
  familyId: string;
  identityVersion: number;
  lifecycle: IntegrationActionLifecycle;
  /** Read-only entries are published state, not action-tool candidates. */
  kind?: "execution" | "read_only";
}>;

type IntegrationVisibleAction = IntegrationActionAdapter &
  IntegrationActionRegistration;

export type IntegrationReceiptEvidence = Readonly<{
  state: string;
  reasonCode: string;
  evidence: Readonly<Record<string, unknown>> | null;
}>;

export type IntegrationDispatchAdmission = Readonly<{
  /** Runtime-local observer and owner captured before action tool execution. */
  observer: ExecutionDispatchObserver;
  owner: ExecutionCorrelationOwner;
  /** Ledger-only exact cancel facade; it rejects unknown owner/request/execution tuples. */
  cancelExact(
    requestId: string,
    executionId: string,
    reasonCode: string,
  ): Promise<unknown>;
}>;

export type IntegrationToolContext = Readonly<{
  connection: GameConnection;
  /** Required for executable action tools. It mints a fresh runtime-owned admission for each execution invocation. */
  dispatchAdmissionFactory?: () => IntegrationDispatchAdmission;
  /** Advisory data is opaque to Host core and interpreted only by the adapter. */
  knowledge?: unknown;
  gameVersion?: string;
  policy?: IntegrationActionPolicy;
}>;

type IntegrationToolSet = Readonly<{
  observation: readonly ToolDefinition[];
  actions: readonly ToolDefinition[];
  knowledge: readonly ToolDefinition[];
}>;

export type IntegrationModuleConformance = Readonly<{
  toolNames: readonly string[];
  actionCatalogRevision: string;
}>;

type IntegrationKnowledgeMetadata = Readonly<{
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
  /** Host-local concrete adapters, never integration publication metadata. */
  entries: readonly IntegrationActionAdapter[];
  revision: string;
  hasAdapter(actionId: string): boolean;
  visibleActions(
    registrations: readonly IntegrationActionRegistration[],
    capabilities: readonly string[],
    policy?: IntegrationActionPolicy,
  ): readonly IntegrationVisibleAction[];
  searchVisibleActions(
    registrations: readonly IntegrationActionRegistration[],
    capabilities: readonly string[],
    query: string,
    policy?: IntegrationActionPolicy,
  ): readonly IntegrationVisibleAction[];
  hasCompletionEvidence(
    actionId: string,
    receipt: IntegrationReceiptEvidence,
  ): boolean;
}>;

export type GameIntegrationAdapter = Readonly<{
  descriptor: Readonly<{
    integrationId: string;
    version: string;
    /** Every adapter-owned tool must live under this stable namespace. */
    toolNamePrefix: string;
  }>;
  actionCatalog: IntegrationActionCatalog;
  defaultPolicy: IntegrationActionPolicy;
  parsePolicy(value: unknown): IntegrationActionPolicy;
  /** Return the adapter-authenticated embodied actor for this connection. */
  actorId(connection: GameConnection): string;
  /** Reject a connection that does not match the Host-owned companion/world identity. */
  assertIdentityBinding(
    connection: GameConnection,
    identity: IntegrationIdentityBinding,
  ): void;
  /** Return the optional current-world key for Host-owned WorldBook filtering. */
  worldScope(connection: GameConnection): IntegrationWorldScope | null;
  /** Materialize only tools backed by this adapter's validated connection. */
  createToolSet(context: IntegrationToolContext): IntegrationToolSet;
  /** Return immutable manifest metadata without exposing adapter state. */
  knowledgeMetadata(
    context: Readonly<{
      connection?: GameConnection;
      knowledge?: unknown;
      gameVersion?: string;
    }>,
  ): IntegrationKnowledgeMetadata;
  /** Project adapter-owned state into the small Host lifecycle view. */
  readState(connection: GameConnection): IntegrationStateView;
  /** Project only bounded status fields for the player-facing Host status tool. */
  status(connection: GameConnection): IntegrationStatusDetails;
  /** Request cancellation through the adapter; the adapter/remote game remains authoritative. */
  cancelExecution(
    connection: GameConnection,
    requestId: string,
    executionId: string,
    reasonCode: string,
  ): unknown;
  /** Parse this adapter's action-tool result into a receipt without trusting model text. */
  parseReceipt(details: unknown): IntegrationExecutionReceipt | null;
  /** Map adapter-owned tool names back to action IDs for Host budgets/receipts. */
  actionIdForToolName(toolName: string): string | null;
  /** Identify the adapter-owned exact-execution cancellation tool. */
  isCancellationTool(toolName: string): boolean;
}>;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME_PREFIX = /^[a-z][a-z0-9_-]{0,31}_$/;
const VERSION = /^[A-Za-z0-9_.-]{1,64}$/;
const LIFECYCLES = new Set<IntegrationActionLifecycle>([
  "published",
  "experimental",
  "diagnostic",
  "planned",
]);

/**
 * Build the Host-local concrete adapter inventory for one integration. It can
 * only subtract from authenticated registration facts supplied at resolution.
 */
export function createIntegrationActionCatalog(
  entries: readonly IntegrationActionAdapter[],
  hasCompletionEvidence: (
    actionId: string,
    receipt: IntegrationReceiptEvidence,
  ) => boolean = () => false,
): IntegrationActionCatalog {
  if (!Array.isArray(entries) || entries.length > 512)
    throw new Error("invalid_integration_action_catalog");
  const normalized = entries.map((entry) => {
    if (!isRecord(entry) || !isIdentifier(entry.actionId))
      throw new Error("invalid_integration_action_catalog");
    return Object.freeze({ actionId: entry.actionId });
  });
  const actionIds = new Set<string>();
  for (const entry of normalized) {
    if (actionIds.has(entry.actionId))
      throw new Error("duplicate_integration_action");
    actionIds.add(entry.actionId);
  }
  const frozenEntries = Object.freeze(normalized);
  const revision = createHash("sha256")
    .update(JSON.stringify(frozenEntries))
    .digest("hex");
  const visible = (
    registrations: readonly IntegrationActionRegistration[],
    capabilities: readonly string[],
    policy?: IntegrationActionPolicy,
  ): readonly IntegrationVisibleAction[] => {
    const capabilitySet = new Set(capabilities);
    const deniedActions = new Set(policy?.deniedActions ?? []);
    const deniedFamilies = new Set(policy?.deniedFamilies ?? []);
    const seen = new Set<string>();
    const result: IntegrationVisibleAction[] = [];
    for (const registration of registrations) {
      if (
        !isRegistration(registration) ||
        seen.has(registration.actionId) ||
        !actionIds.has(registration.actionId) ||
        registration.lifecycle !== "published" ||
        registration.kind === "read_only" ||
        !capabilitySet.has(registration.actionId) ||
        deniedActions.has(registration.actionId) ||
        deniedFamilies.has(registration.familyId)
      ) {
        continue;
      }
      seen.add(registration.actionId);
      result.push(Object.freeze({ ...registration }));
    }
    return Object.freeze(result);
  };
  const search = (
    registrations: readonly IntegrationActionRegistration[],
    capabilities: readonly string[],
    query: string,
    policy?: IntegrationActionPolicy,
  ): readonly IntegrationVisibleAction[] => {
    const available = visible(registrations, capabilities, policy);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (normalizedQuery.length === 0) return available;
    return available.filter((entry) =>
      `${entry.actionId} ${entry.familyId}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  };
  return Object.freeze({
    entries: frozenEntries,
    revision,
    hasAdapter: (actionId: string) => actionIds.has(actionId),
    visibleActions: visible,
    searchVisibleActions: search,
    hasCompletionEvidence: (
      actionId: string,
      receipt: IntegrationReceiptEvidence,
    ) => hasCompletionEvidence(actionId, receipt),
  });
}

export function assertIntegrationAdapter(
  adapter: GameIntegrationAdapter,
  integrationId: string,
): void {
  if (
    !isRecord(adapter) ||
    !isRecord(adapter.descriptor) ||
    !isIdentifier(adapter.descriptor.integrationId) ||
    !VERSION.test(adapter.descriptor.version) ||
    !isToolNamePrefix(adapter.descriptor.toolNamePrefix) ||
    adapter.descriptor.integrationId !== integrationId ||
    typeof adapter.actorId !== "function" ||
    typeof adapter.assertIdentityBinding !== "function" ||
    typeof adapter.worldScope !== "function" ||
    typeof adapter.createToolSet !== "function" ||
    typeof adapter.knowledgeMetadata !== "function" ||
    typeof adapter.status !== "function" ||
    typeof adapter.readState !== "function" ||
    typeof adapter.parsePolicy !== "function" ||
    typeof adapter.cancelExecution !== "function" ||
    typeof adapter.parseReceipt !== "function" ||
    typeof adapter.actionIdForToolName !== "function" ||
    typeof adapter.isCancellationTool !== "function" ||
    !isRecord(adapter.actionCatalog) ||
    !Array.isArray(adapter.actionCatalog.entries) ||
    typeof adapter.actionCatalog.revision !== "string" ||
    typeof adapter.actionCatalog.hasAdapter !== "function" ||
    typeof adapter.actionCatalog.visibleActions !== "function" ||
    typeof adapter.actionCatalog.searchVisibleActions !== "function" ||
    typeof adapter.actionCatalog.hasCompletionEvidence !== "function" ||
    adapter.actionCatalog.entries.some((entry) => !isIdentifier(entry.actionId))
  ) {
    throw new Error("integration_adapter_scope_mismatch");
  }
  try {
    const canonicalRevision = createIntegrationActionCatalog(
      adapter.actionCatalog.entries,
      adapter.actionCatalog.hasCompletionEvidence,
    ).revision;
    if (
      !/^[a-f0-9]{64}$/.test(adapter.actionCatalog.revision) ||
      canonicalRevision !== adapter.actionCatalog.revision
    ) {
      throw new Error("integration_adapter_catalog_revision_mismatch");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "integration_adapter_catalog_revision_mismatch"
    )
      throw error;
    throw new Error("integration_adapter_scope_mismatch");
  }
}

/**
 * Structural conformance check shared by adapter tests. It intentionally
 * validates only the Host/adapter seam; transport and game-specific behavior
 * remain owned by the integration adapter and its live gates.
 */
export function assertIntegrationAdapterConformance(
  adapter: GameIntegrationAdapter,
  connection: GameConnection,
): IntegrationModuleConformance {
  if (
    connection.module !== adapter ||
    connection.scope.integrationId !== adapter.descriptor.integrationId
  ) {
    throw new Error("integration_adapter_scope_mismatch");
  }
  assertIntegrationAdapter(adapter, connection.scope.integrationId);
  const tools = adapter.createToolSet({
    connection,
    knowledge: connection.knowledge,
    gameVersion: connection.gameVersion,
  });
  const status = adapter.status(connection);
  if (
    !Array.isArray(status.capabilities) ||
    status.capabilities.length > 512 ||
    status.capabilities.some((capability) => !isIdentifier(capability))
  ) {
    throw new Error("integration_status_view_invalid");
  }
  const toolGroups = [tools.observation, tools.actions, tools.knowledge];
  if (!toolGroups.every((group) => Array.isArray(group)))
    throw new Error("integration_tool_set_invalid");
  const names = toolGroups.flat().map((tool) => tool.name);
  const actionIds = new Set(
    adapter.actionCatalog.entries.map((entry) => entry.actionId),
  );
  for (const name of names) {
    if (
      typeof name !== "string" ||
      !name.startsWith(adapter.descriptor.toolNamePrefix) ||
      name.length > 128 ||
      name.startsWith("ctx_")
    ) {
      throw new Error("integration_tool_namespace_invalid");
    }
    const actionId = adapter.actionIdForToolName(name);
    if (
      actionId !== null &&
      (!actionIds.has(actionId) || !adapter.actionCatalog.hasAdapter(actionId))
    )
      throw new Error("integration_tool_action_unregistered");
  }
  if (new Set(names).size !== names.length)
    throw new Error("duplicate_integration_tool");
  const state = adapter.readState(connection);
  if (
    !Array.isArray(state.capabilities) ||
    (state.activeExecution !== null && !isRecord(state.activeExecution))
  ) {
    throw new Error("integration_state_view_invalid");
  }
  return Object.freeze({
    toolNames: Object.freeze([...names].sort()),
    actionCatalogRevision: adapter.actionCatalog.revision,
  });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isToolNamePrefix(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAME_PREFIX.test(value);
}

function isLifecycle(value: unknown): value is IntegrationActionLifecycle {
  return (
    typeof value === "string" &&
    LIFECYCLES.has(value as IntegrationActionLifecycle)
  );
}

function isRegistration(
  value: unknown,
): value is IntegrationActionRegistration {
  return (
    isRecord(value) &&
    isIdentifier(value.actionId) &&
    isIdentifier(value.familyId) &&
    typeof value.identityVersion === "number" &&
    Number.isSafeInteger(value.identityVersion) &&
    value.identityVersion >= 1 &&
    isLifecycle(value.lifecycle) &&
    (value.kind === undefined || value.kind === "execution" || value.kind === "read_only")
  );
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}