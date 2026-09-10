import type { WorldFact } from "./event-pump.js";
import { projectGameSnapshotContext } from "./snapshot-projection.js";
import { isTerminalExecutionState } from "./execution-correlation-ledger.js";
import {
  type ExecutionWake,
  type IntegrationEventSource,
  type IntegrationLaunchHandle,
  type IntegrationLifecycleEvent,
  RECEIPT_BACKED_INTEGRATION_AUTHORITY,
} from "./integration-launcher.js";
import type { ExactReceiptRecoveryPort } from "./stardew-execution-recovery-supervisor.js";
import { LocalStardewBridgeClient, type LocalStardewBridgeFact } from "./local-stardew-bridge.js";
import type { GameConnection, StardewBridgeConnection } from "./game-connection.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { createStableGameRuntimeBindingIdentity } from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import type { GameRuntimeBindingExecution } from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.internal.js";
import {
  assertActiveS4cMaterializationAdmission,
  type OpaqueS4cMaterializationAdmission,
} from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.js";
import type { FarmhandPresentationBridge } from "./farmhand-companion-presentation.js";
import type {
  BodyProgramCandidateRequest,
  BodyProgramEventsRequest,
  BodyProgramEventsResult,
  BodyProgramStatusRequest,
  BodyProgramStatusResult,
  BodyProgramSubmitResult,
  BodyProgramVerifyResult,
} from "./protocol.js";

/** Liveness check carried by one exact authenticated connection association. */
type StardewConnectionAuthentication = Readonly<{
  isLive(): boolean;
}>;

/**
 * Exact authenticated Stardew connection registry, launcher-owned and never
 * exported as a registrar. Only the authenticated launch construction mints
 * one association for the precise frozen wrapper it returns; the Stardew
 * adapter asserts association plus current liveness through
 * {@link assertAuthenticatedStardewConnection} before reading any
 * identity/scope/state/status/tools/cancel. Structural copies, forged
 * wrappers, and caller-supplied state are distinct objects absent from this
 * map, so every adapter entry point rejects them.
 */
const authenticatedStardewConnections = new WeakMap<
  object,
  StardewConnectionAuthentication
>();

/**
 * Construction-private authenticated association. The authenticated Stardew
 * launch production registers exactly its one real connection once; adapter
 * entry points assert liveness through
 * {@link assertAuthenticatedStardewConnection}. Deliberately not exported:
 * no production or test module may mint an association outside the exact
 * launch construction.
 */
function registerAuthenticatedStardewConnection(
  connection: StardewBridgeConnection,
  isLive: () => boolean,
): void {
  if (authenticatedStardewConnections.has(connection))
    throw new Error("duplicate_authenticated_stardew_connection");
  authenticatedStardewConnections.set(connection, { isLive });
}

/**
 * Adapter-owned authority gate, exported only as the narrow assertion the
 * Stardew adapter consumes. The connection must be the exact wrapper that an
 * authenticated launch registered, and it must still be live (not revoked or
 * bridge-closed). Structural copies, caller-state, and self-comparison never
 * appear in the association map and reject before any data is read.
 */
export function assertAuthenticatedStardewConnection(
  connection: GameConnection,
): StardewBridgeConnection {
  const authentication = authenticatedStardewConnections.get(connection);
  if (authentication === undefined || !authentication.isLive())
    throw new Error(
      "stardew_connection_not_authenticated_or_not_live",
    );
  return connection as StardewBridgeConnection;
}

/** Private authenticated Farmhand Body Program transport, never carried by a launch handle. */
export type StardewAuthenticatedBodyProgramPort = Readonly<{
  verify(request: BodyProgramCandidateRequest): Promise<BodyProgramVerifyResult>;
  submit(request: BodyProgramCandidateRequest): Promise<BodyProgramSubmitResult>;
  status(request: BodyProgramStatusRequest): Promise<BodyProgramStatusResult>;
  events(request: BodyProgramEventsRequest): Promise<BodyProgramEventsResult>;
}>;

export type AuthenticatedStardewLaunchPorts = Readonly<{
  presentation: FarmhandPresentationBridge;
  bodyProgram: StardewAuthenticatedBodyProgramPort;
}>;

export type AuthenticatedStardewLaunchRecord = Readonly<{
  connection: IntegrationLaunchHandle["connection"];
  presentation: FarmhandPresentationBridge;
  bodyProgram?: StardewAuthenticatedBodyProgramPort;
  isClosed(): boolean;
}>;

/** Construction-private association; no launcher handle property exposes this record. */
const authenticatedStardewLaunchRecords = new WeakMap<object, AuthenticatedStardewLaunchRecord>();

function associateAuthenticatedStardewLaunch(
  handle: IntegrationLaunchHandle,
  record: AuthenticatedStardewLaunchRecord,
): void {
  authenticatedStardewLaunchRecords.set(handle, record);
}

/**
 * Converts one exact authenticated Stardew client into the adapter-owned
 * receipt-backed launch handle and privately associates its narrow ports.
 */
export async function createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
  bridge: LocalStardewBridgeClient,
  identity: Readonly<{ playerId: string; companionId: string; continuityId?: string; saveId?: string; worldId?: string }>,
  options: Readonly<{ expectedPresentationLocale?: string; knowledge?: import("./knowledge.js").KnowledgeBundle; gameVersion?: string }> = {},
): Promise<IntegrationLaunchHandle> {
  if (!(bridge instanceof LocalStardewBridgeClient)) throw new Error("authenticated_stardew_bridge_required");
  if (identity.saveId === undefined || identity.worldId === undefined)
    throw new Error("stardew_identity_scope_required");
  const scope = bridge.scope;
  if (
    scope.integrationId !== "stardew" ||
    scope.saveId !== identity.saveId ||
    scope.worldId !== identity.worldId ||
    scope.companionId !== identity.companionId
  ) {
    bridge.close();
    throw new Error("stardew_bridge_identity_scope_mismatch");
  }
  const local = options;
  const executionGate = { executable: true };
  let closed = false;
  // Liveness: an invalidated receipt closes the launcher-owned record used by
  // preview/materializer immediately, while the native pipe stays open (no
  // replay, retry, or transport close). The invalidated wake, gate freeze, and
  // rejection behavior are preserved.
  let invalidated = false;
  const bootstrapFacts: WorldFact[] = [];
  const bufferedFacts: Array<readonly [WorldFact, LocalStardewBridgeFact]> = [];
  const bufferedLifecycle: IntegrationLifecycleEvent[] = [];
  const factListeners = new Set<(fact: WorldFact) => void>();
  const lifecycleListeners = new Set<(event: IntegrationLifecycleEvent) => void>();
  let factDeliveryReady = false;
  const executionWakeListeners = new Set<(wake: ExecutionWake) => void>();
  const publishWake = (wake: ExecutionWake) => {
    for (const listener of executionWakeListeners) listener(wake);
  };
  const disconnect = (reasonCode: string) => {
    if (closed) return;
    executionGate.executable = false;
    closed = true;
    publishWake(Object.freeze({ kind: "disconnected", reasonCode }));
    const event = Object.freeze({ state: "disconnected" as const, reasonCode });
    bufferedLifecycle.push(event);
    for (const listener of lifecycleListeners) listener(event);
    bridge.close();
  };
  const revoke = (reasonCode: string) => disconnect(reasonCode);
  const deliverFact = (converted: WorldFact, fact: LocalStardewBridgeFact) => {
    try {
      for (const listener of [...factListeners]) listener(converted);
    } catch {
      disconnect("fact_listener_failed");
      return;
    }
    if (
      fact.type === "semantic_event" &&
      (fact.payload.kind === "player_input" || fact.payload.kind === "stop_all")
    ) {
      console.debug("GameBuddy native chat ingress stage=native_chat_adapter_fact_forwarded");
      try {
        bridge.acknowledgePlayerControl(
          fact.payload.playerControl!.controlId,
          fact.payload.playerControl!.sourceEventId,
        );
      } catch {
        disconnect("player_control_receipt_write_failed");
      }
    }
  };
  const removeFact = bridge.onFact((fact) => {
    const converted = toWorldFact(fact);
    if (fact.type === "execution_receipt") {
      const receipt = fact.payload;
      if (receipt.state === "invalidated") {
        executionGate.executable = false;
        invalidated = true;
        publishWake(Object.freeze({ kind: "invalidated", reasonCode: receipt.reasonCode }));
      } else if (isTerminalExecutionState(receipt.state))
        publishWake(Object.freeze({
          kind: "terminal",
          requestId: receipt.requestId,
          executionId: receipt.executionId,
          state: receipt.state,
          reasonCode: receipt.reasonCode,
        }));
    }
    if (!factDeliveryReady) {
      if (fact.type === "snapshot") bootstrapFacts.push(converted);
      else bufferedFacts.push([converted, fact]);
      return;
    }
    deliverFact(converted, fact);
  });
  const removeLifecycle = bridge.onConnectionFact((fact) => revoke(fact.reasonCode));
  const removeDiagnostic = bridge.onDiagnostic((diagnostic) => {
    console.debug(`GameBuddy native chat ingress stage=${diagnostic.stage}:${diagnostic.reasonCode}`);
  });
  try {
    const snapshot = await bridge.observe();
    if (!executionGate.executable) throw new Error("stardew_launch_disconnected");
    if (local.expectedPresentationLocale !== undefined && snapshot.presentationLocale !== local.expectedPresentationLocale)
      throw new Error("stardew_presentation_locale_mismatch");
    const initialFacts = Object.freeze(bootstrapFacts.splice(0));
    if (!initialFacts.some((fact) => fact.kind === "snapshot" && fact.revision === snapshot.revision))
      throw new Error("stardew_initial_snapshot_not_observed");
    const events: IntegrationEventSource = Object.freeze({
      onFact: (listener) => {
        factListeners.add(listener);
        factDeliveryReady = true;
        const initial = bufferedFacts.splice(0);
        for (const [fact, rawFact] of initial) deliverFact(fact, rawFact);
        return () => {
          factListeners.delete(listener);
          if (factListeners.size === 0) factDeliveryReady = false;
        };
      },
      onLifecycle: (listener) => {
        for (const event of bufferedLifecycle) listener(event);
        bufferedLifecycle.length = 0;
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      },
      onExecutionWake: (listener) => {
        executionWakeListeners.add(listener);
        return () => executionWakeListeners.delete(listener);
      },
    });
    const connection: StardewBridgeConnection = Object.freeze({
      scope,
      module: STARDEW_GAME_INTEGRATION_ADAPTER,
      get state() { return bridge.state; },
      knowledge: local.knowledge,
      gameVersion: local.gameVersion,
      executionWakeSource: { onExecutionWake: (listener: (wake: ExecutionWake) => void) => {
        executionWakeListeners.add(listener);
        return () => executionWakeListeners.delete(listener);
      } },
      executionGate,
      execute: (request: Parameters<typeof bridge.execute>[0]) =>
        executionGate.executable ? bridge.execute(request) : Promise.reject(new Error("integration_not_ready")),
      cancel: (requestId: string, executionId: string, reasonCode: string) =>
        executionGate.executable ? bridge.cancel(requestId, executionId, reasonCode) : Promise.reject(new Error("integration_not_ready")),
    });
    // Mint exactly one authenticated association for the exact frozen wrapper
    // returned by this launch handle. The adapter refuses any structural copy,
    // forged wrapper, or caller state because only this exact object is bound.
    registerAuthenticatedStardewConnection(
      connection,
      () => executionGate.executable === true && bridge.state.connected,
    );
    const receiptRecovery: ExactReceiptRecoveryPort | undefined = identity.continuityId === undefined
      ? undefined
      : Object.freeze({
          scope: Object.freeze({
            product: "stardew" as const,
            continuityId: identity.continuityId,
            integrationId: "stardew" as const,
            saveId: scope.saveId,
            worldId: scope.worldId,
          }),
          bindingIdentity: Object.freeze({
            product: "stardew" as const,
            continuityId: identity.continuityId,
            integrationId: "stardew" as const,
            saveId: scope.saveId,
            worldId: scope.worldId,
          }),
          queryExecutionReceipt: (query) => bridge.queryExecutionReceipt(query),
        });
    const handle: IntegrationLaunchHandle = Object.freeze({
      connection,
      ...(receiptRecovery === undefined ? {} : { receiptRecovery }),
      events,
      authority: RECEIPT_BACKED_INTEGRATION_AUTHORITY,
      lifecycle: "ready" as const,
      initialFacts,
      revoke,
      close: () => {
        disconnect("integration_closed");
        removeFact();
        removeLifecycle();
        removeDiagnostic();
      },
    });
    const presentation: FarmhandPresentationBridge = Object.freeze({
      get state() { return Object.freeze({ snapshot: bridge.state.snapshot }); },
      presentCompanionText: (request) => bridge.presentCompanionText(request as never),
      presentSystemNotice: (request) => bridge.presentSystemNotice(request as never),
    });
    const bodyProgram = bridge.hasExactFarmhandRuntimeAttestation
      ? Object.freeze({
          verify: (request: BodyProgramCandidateRequest): Promise<BodyProgramVerifyResult> => bridge.programVerify(request),
          submit: (request: BodyProgramCandidateRequest): Promise<BodyProgramSubmitResult> => bridge.programSubmit(request),
          status: (request: BodyProgramStatusRequest): Promise<BodyProgramStatusResult> => bridge.programStatus(request),
          events: (request: BodyProgramEventsRequest): Promise<BodyProgramEventsResult> => bridge.programEvents(request),
        })
      : undefined;
    associateAuthenticatedStardewLaunch(handle, Object.freeze({
      connection,
      presentation,
      ...(bodyProgram === undefined ? {} : { bodyProgram }),
      isClosed: () => closed || invalidated || !bridge.state.connected,
    }));
    return handle;
  } catch (error) {
    executionGate.executable = false;
    removeFact();
    removeLifecycle();
    removeDiagnostic();
    bridge.close();
    throw error;
  }
}

/** Preview consumes only the narrow presentation projection from its exact launcher handle. */
export function getAuthenticatedStardewPresentationPortForPreview(
  launch: IntegrationLaunchHandle,
): FarmhandPresentationBridge {
  const record = authenticatedStardewLaunchRecords.get(launch);
  if (record === undefined || record.isClosed() || launch.connection !== record.connection)
    throw new Error("authenticated_stardew_presentation_port_required");
  return record.presentation;
}

export function toWorldFact(message: LocalStardewBridgeFact): WorldFact {
  switch (message.type) {
    case "snapshot":
      return {
        source: "stardew_mod",
        kind: "snapshot",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.correlationId,
        revision: message.payload.revision,
        payload: message.payload,
        contextProjection: projectGameSnapshotContext(message.payload, message.timestampMs, Date.now()),
      };
    case "execution_receipt":
      return { source: "stardew_mod", kind: "execution_receipt", eventId: message.messageId, occurredAtMs: message.timestampMs, correlationId: message.payload.executionId, revision: message.payload.revision, executionId: message.payload.executionId, requestId: message.payload.requestId, payload: message.payload };
    case "semantic_event":
      return { source: "stardew_mod", kind: "semantic_event", eventId: message.messageId, occurredAtMs: message.timestampMs, correlationId: message.correlationId, revision: message.payload.revision, executionId: message.payload.activeExecution?.executionId, payload: message.payload };
    case "lifecycle":
      return { source: "stardew_mod", kind: "lifecycle", eventId: message.messageId, occurredAtMs: message.timestampMs, correlationId: message.correlationId, revision: 0, payload: message.payload };
    case "world_fact": {
      if (!message.payload.eventId || typeof message.payload.eventId !== "string") {
        throw new Error("invalid_world_fact_event_id");
      }
      if (!message.payload.sourceEventId || typeof message.payload.sourceEventId !== "string") {
        throw new Error("invalid_world_fact_source_event_id");
      }
      let payload: Readonly<Record<string, unknown>>;
      if (message.payload.payload !== undefined && message.payload.payload !== null) {
        if (typeof message.payload.payload !== "object" || Array.isArray(message.payload.payload))
          throw new Error("invalid_world_fact_payload");
        payload = message.payload.payload as Readonly<Record<string, unknown>>;
      } else if (typeof message.payload.payloadJson === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.payload.payloadJson);
        } catch {
          throw new Error("invalid_world_fact_payload_json");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          throw new Error("invalid_world_fact_payload_json");
        payload = parsed as Readonly<Record<string, unknown>>;
      } else {
        throw new Error("invalid_world_fact_payload");
      }
      return {
        source: "stardew_mod",
        kind: "world_fact",
        eventId: message.payload.eventId,
        sourceEventId: message.payload.sourceEventId,
        correlationId: message.payload.eventId,
        revision: message.payload.revision,
        observedTick: message.payload.observedTick,
        ...(message.payload.gameTime !== undefined && message.payload.gameTime !== null
          ? { gameTime: message.payload.gameTime }
          : {}),
        occurredAtMs: message.timestampMs,
        payload,
      };
    }
  }
}

/**
 * Materializes launcher-owned narrow ports only from an existing receipt-backed
 * Stardew execution. The binding identity check remains the sole execution
 * provenance validator; this seam only verifies its exact launch association.
 */
export function materializeAuthenticatedStardewLaunchPorts(
  execution: GameRuntimeBindingExecution,
  admission: OpaqueS4cMaterializationAdmission,
): AuthenticatedStardewLaunchPorts {
  assertActiveS4cMaterializationAdmission(execution, admission);
  const identity = createStableGameRuntimeBindingIdentity(execution);
  const record = authenticatedStardewLaunchRecords.get(execution.launch);
  if (
    record === undefined ||
    record.isClosed() ||
    execution.connection !== record.connection ||
    execution.launch.connection !== record.connection ||
    execution.world.integrationId !== identity.integrationId ||
    execution.world.saveId !== identity.saveId ||
    execution.world.worldId !== identity.worldId ||
    record.bodyProgram === undefined
  ) {
    throw new Error("authenticated_stardew_launch_ports_required");
  }
  return Object.freeze({ presentation: record.presentation, bodyProgram: record.bodyProgram });
}
