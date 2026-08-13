import type { WorldFact } from "./event-pump.js";
import type { CompanionIdentity } from "./runtime.js";
import { assertIntegrationModule, type GameIntegrationModule } from "./integration-module.js";
import type { IntegrationConnection } from "./integration-types.js";

/**
 * A supported GameBuddy integration has one strict evidence model: a live,
 * adapter-authenticated connection with receipt-backed game execution. The
 * transport, game schema, and receipt format all remain adapter-owned.
 */
export type ReceiptBackedIntegrationAuthority = Readonly<{
  observation: "authoritative";
  execution: "receipt_backed";
}>;

export const RECEIPT_BACKED_INTEGRATION_AUTHORITY: ReceiptBackedIntegrationAuthority = Object.freeze({
  observation: "authoritative",
  execution: "receipt_backed",
});

export type IntegrationLifecycleState = "ready" | "disconnected" | "stopped";

/** A local transport transition; unlike adapter facts it never claims a game-world transition. */
export type IntegrationLifecycleEvent = Readonly<{
  state: Exclude<IntegrationLifecycleState, "ready">;
  reasonCode: string;
}>;

/**
 * Adapter-owned event stream consumed by Host glue. Facts must already be
 * source-labelled, validated game facts; Host never parses a game wire format.
 */
export type ExecutionWake =
  | Readonly<{ kind: "terminal"; requestId: string; executionId: string; state: string; reasonCode: string }>
  | Readonly<{ kind: "invalidated"; reasonCode: string }>
  | Readonly<{ kind: "disconnected"; reasonCode: string }>;

/**
 * A narrow, adapter-validated execution transition projection. This is not a
 * game fact stream and does not grant action authority.
 */
export type ExecutionWakeSource = Readonly<{
  onExecutionWake(listener: (wake: ExecutionWake) => void): () => void;
}>;

export type WakeCapableIntegrationConnection = Readonly<{
  executionWakeSource?: ExecutionWakeSource;
}>;

/** Adapter-owned optional capability lookup; absent adapters keep polling. */
export function executionWakeSourceFor(connection: unknown): ExecutionWakeSource | undefined {
  if (!isRecord(connection) || !isRecord(connection.executionWakeSource)) return undefined;
  const source = connection.executionWakeSource;
  return typeof source.onExecutionWake === "function" ? (source as ExecutionWakeSource) : undefined;
}

export type IntegrationEventSource = Readonly<{
  onFact(listener: (fact: WorldFact) => void): () => void;
  onLifecycle(listener: (event: IntegrationLifecycleEvent) => void): () => void;
  /** Optional low-latency receipt wake; polling remains the recovery path. */
  onExecutionWake?: ExecutionWakeSource["onExecutionWake"];
}>;

/** Reject malformed adapter values before they can wake a task-owned waiter. */
export function normalizeExecutionWake(value: unknown): ExecutionWake | null {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.reasonCode !== "string" || value.reasonCode.length === 0)
    return null;
  if (value.kind === "invalidated" || value.kind === "disconnected")
    return Object.freeze({ kind: value.kind, reasonCode: value.reasonCode });
  if (
    value.kind !== "terminal" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0 ||
    typeof value.executionId !== "string" ||
    value.executionId.length === 0 ||
    typeof value.state !== "string" ||
    value.state.length === 0
  )
    return null;
  return Object.freeze({
    kind: "terminal",
    requestId: value.requestId,
    executionId: value.executionId,
    state: value.state,
    reasonCode: value.reasonCode,
  });
}

/** The result of one explicit user-requested integration launch. */
export type IntegrationLaunchHandle = Readonly<{
  connection: IntegrationConnection;
  events: IntegrationEventSource;
  authority: ReceiptBackedIntegrationAuthority;
  lifecycle: "ready";
  /** Mandatory current authoritative state admitted before any agent turn. */
  initialFacts: readonly WorldFact[];
  /** Idempotently revoke execution before closing adapter-owned resources. */
  revoke(reasonCode: string): void;
  close(): void;
}>;

/**
 * Adapter factory boundary. Config remains opaque to Host and must be supplied
 * by a local operator or adapter-owned product flow, never by the Companion.
 */
export type IntegrationLauncher = Readonly<{
  integrationId: string;
  module: GameIntegrationModule;
  launch(request: Readonly<{ identity: CompanionIdentity; config: unknown }>): Promise<IntegrationLaunchHandle>;
}>;

/**
 * Fail closed before runtime/tool mounting. GameBuddy intentionally rejects
 * telemetry-only, human-confirmed, advisory, and merely request-accepted
 * adapters: those cannot support the execution/evidence companion loop.
 */
export function assertReceiptBackedLaunch(
  launcher: IntegrationLauncher,
  handle: IntegrationLaunchHandle,
  identity: CompanionIdentity,
): void {
  if (
    !isRecord(launcher) ||
    typeof launcher.integrationId !== "string" ||
    !isRecord(handle) ||
    handle.lifecycle !== "ready" ||
    handle.authority?.observation !== "authoritative" ||
    handle.authority?.execution !== "receipt_backed" ||
    typeof handle.revoke !== "function" ||
    typeof handle.close !== "function" ||
    !isRecord(handle.events) ||
    typeof handle.events.onFact !== "function" ||
    typeof handle.events.onLifecycle !== "function" ||
    !Array.isArray(handle.initialFacts) ||
    handle.initialFacts.length === 0 ||
    handle.connection?.module !== launcher.module ||
    handle.connection.scope.integrationId !== launcher.integrationId
  ) {
    throw new Error("receipt_backed_integration_launch_required");
  }
  assertIntegrationModule(launcher.module, launcher.integrationId);
  launcher.module.assertIdentityBinding(handle.connection, {
    playerId: identity.playerId,
    companionId: identity.companionId,
    ...(identity.saveId === undefined ? {} : { saveId: identity.saveId }),
    ...(identity.worldId === undefined ? {} : { worldId: identity.worldId }),
  });
  const state = launcher.module.readState(handle.connection);
  // Launch admission must establish that a publishable action exists without
  // materializing an executable ToolDefinition. Tool materialization requires
  // the runtime-owned dispatch admission minted only after this boundary.
  const publishableActions = launcher.module.actionCatalog.visibleActions(
    state.capabilities,
    launcher.module.defaultPolicy,
  );
  if (
    !state.connected ||
    handle.connection.executionGate?.executable !== true ||
    state.snapshotRevision === null ||
    publishableActions.length === 0 ||
    !handle.initialFacts.some((fact) => fact.kind === "snapshot" && fact.revision === state.snapshotRevision)
  ) {
    throw new Error("authoritative_initial_state_required");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
