import type { WorldFact } from "./event-pump.js";
import { projectGameSnapshotContext } from "./snapshot-projection.js";
import { classifyFactListenerFailure } from "./local-stardew-bridge.js";
import { isTerminalExecutionState } from "./execution-correlation-ledger.js";
import {
  type ExecutionWake,
  type IntegrationEventSource,
  type IntegrationLaunchHandle,
  type IntegrationLifecycleEvent,
  RECEIPT_BACKED_INTEGRATION_AUTHORITY,
} from "./integration-launcher.js";
import type { ExactReceiptRecoveryPort } from "./stardew-execution-recovery-supervisor.js";
import {
  bindLocalStardewBridgeBodyNodeAdmission,
  LocalStardewBridgeClient,
  type LocalStardewBridgeFact,
} from "./local-stardew-bridge.js";
import type { GameConnection, StardewBridgeConnection } from "./game-connection.js";
import type { GameIntegrationAdapter } from "./game-integration-adapter.js";
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
  BodyNodeAdmissionChallenge,
  BodyNodeAdmissionResult,
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
const authenticatedStardewConnections = new WeakMap<object, StardewConnectionAuthentication>();

/**
 * Construction-private authenticated association. The authenticated Stardew
 * launch production registers exactly its one real connection once; adapter
 * entry points assert liveness through
 * {@link assertAuthenticatedStardewConnection}. Deliberately not exported:
 * no production or test module may mint an association outside the exact
 * launch construction.
 */
function registerAuthenticatedStardewConnection(connection: StardewBridgeConnection, isLive: () => boolean): void {
  if (authenticatedStardewConnections.has(connection)) throw new Error("duplicate_authenticated_stardew_connection");
  authenticatedStardewConnections.set(connection, { isLive });
}

/**
 * Adapter-owned authority gate, exported only as the narrow assertion the
 * Stardew adapter consumes. The connection must be the exact wrapper that an
 * authenticated launch registered, and it must still be live (not revoked or
 * bridge-closed). Structural copies, caller-state, and self-comparison never
 * appear in the association map and reject before any data is read.
 */
export function assertAuthenticatedStardewConnection(connection: GameConnection): StardewBridgeConnection {
  const authentication = authenticatedStardewConnections.get(connection);
  if (authentication === undefined || !authentication.isLive())
    throw new Error("stardew_connection_not_authenticated_or_not_live");
  return connection as StardewBridgeConnection;
}

/** Private authenticated Farmhand Body Program transport, never carried by a launch handle. */
export type StardewAuthenticatedBodyProgramPort = Readonly<{
  submit(request: BodyProgramCandidateRequest): Promise<BodyProgramSubmitResult>;
  status(request: BodyProgramStatusRequest): Promise<BodyProgramStatusResult>;
  events(request: BodyProgramEventsRequest): Promise<BodyProgramEventsResult>;
}>;

type BodyNodeAdmissionHandler = (challenge: BodyNodeAdmissionChallenge) => Promise<BodyNodeAdmissionResult>;

export type AuthenticatedStardewLaunchPorts = Readonly<{
  presentation: FarmhandPresentationBridge;
  bodyProgram: StardewAuthenticatedBodyProgramPort;
}>;

export type AuthenticatedStardewLaunchRecord = Readonly<{
  connection: IntegrationLaunchHandle["connection"];
  presentation: FarmhandPresentationBridge;
  bodyProgram?: StardewAuthenticatedBodyProgramPort;
  bindBodyNodeAdmission(handler: BodyNodeAdmissionHandler): void;
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
  identity: Readonly<{
    playerId: string;
    companionId: string;
    continuityId?: string;
    saveId?: string;
    worldId?: string;
  }>,
  options: Readonly<{
    module: GameIntegrationAdapter;
    expectedPresentationLocale?: string;
    knowledge?: import("./knowledge.js").KnowledgeBundle;
    gameVersion?: string;
  }>,
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
    bridge.close("stardew_bridge_identity_scope_mismatch");
    throw new Error("stardew_bridge_identity_scope_mismatch");
  }
  const local = options;
  const executionGate = { executable: true };
  let closed = false;
  // Liveness: an invalidated receipt closes the launcher-owned records used by
  // preview/materializer immediately (see `isLauncherClosed`), while the native
  // pipe stays open (no replay, retry, or transport close). The invalidated wake
  // and the launcher-port rejections are preserved; `executionGate` is deliberately
  // NOT closed, so ordinary action dispatch keeps working after an interruption
  // (see the invalidated branch in `bridge.onFact`). A real `disconnect` still
  // closes the gate, because that must stop everything.
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
    // The launcher's own name for this disconnect, forwarded rather than dropped: see the bridge's `close()`.
    bridge.close(reasonCode);
  };
  const revoke = (reasonCode: string) => disconnect(reasonCode);
  const deliverFact = (converted: WorldFact, fact: LocalStardewBridgeFact) => {
    try {
      for (const listener of [...factListeners]) listener(converted);
    } catch (error) {
      // WHICH listener rejected WHICH fact kind, and the error's own bounded token. Without this the disconnect is a
      // bare `fact_listener_failed`, which says nothing about whether the fault is a projection, an event pump, or a
      // serialization problem (measured 2026-10-17 twice: a multi-day run died 14s in and the artifact could not
      // say what had thrown).
      console.error(
        "STARDEW_FACT_LISTENER_FAILED",
        JSON.stringify({ factKind: converted.kind, error: classifyFactListenerFailure(error) }),
      );
      disconnect("fact_listener_failed");
      return;
    }
    if (fact.type === "semantic_event" && (fact.payload.kind === "player_input" || fact.payload.kind === "stop_all")) {
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
        // This deliberately does NOT close `executionGate`.
        //
        // The invalidated wake freezes the launcher-owned MATERIALIZATION projection through `isLauncherClosed`
        // (the preview accessor and `materializeAuthenticatedStardewLaunchPorts`), while the long-lived program
        // ports keep working through `areProgramPortsLive`, which reads only `closed` and the connection. Both
        // halves of that split were learned from a live failure:
        //
        //  - Closing `executionGate` forbade ORDINARY action dispatch, and the receipt that invalidates an
        //    execution is exactly what a native modal interruption produces - so the one tool that could clear
        //    the modal (`dismiss_modal`) was refused by the gate the modal had just closed. Observed on ladder 6:
        //    five `dismiss_modal` calls, every one `integration_not_ready`.
        //  - Closing the PROGRAM ports cut the only channel through which the Host could learn an interrupted
        //    program's state. Observed 2026-10-28 (`round2b`): one Clint cutscene interrupted one `enter_exit`, and
        //    16 `program_status` calls were refused for the rest of the run while the companion stood at the door.
        //
        // `disconnect()` still closes everything: a genuine disconnection must stop all of it.
        invalidated = true;
        publishWake(Object.freeze({ kind: "invalidated", reasonCode: receipt.reasonCode }));
      } else if (isTerminalExecutionState(receipt.state))
        publishWake(
          Object.freeze({
            kind: "terminal",
            requestId: receipt.requestId,
            executionId: receipt.executionId,
            state: receipt.state,
            reasonCode: receipt.reasonCode,
          }),
        );
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
    if (
      local.expectedPresentationLocale !== undefined &&
      snapshot.presentationLocale !== local.expectedPresentationLocale
    )
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
      module: local.module,
      get state() {
        return bridge.state;
      },
      knowledge: local.knowledge,
      gameVersion: local.gameVersion,
      executionWakeSource: {
        onExecutionWake: (listener: (wake: ExecutionWake) => void) => {
          executionWakeListeners.add(listener);
          return () => executionWakeListeners.delete(listener);
        },
      },
      executionGate,
      execute: (request: Parameters<typeof bridge.execute>[0]) =>
        executionGate.executable ? bridge.execute(request) : Promise.reject(new Error("integration_not_ready")),
      cancel: (requestId: string, executionId: string, reasonCode: string) =>
        executionGate.executable
          ? bridge.cancel(requestId, executionId, reasonCode)
          : Promise.reject(new Error("integration_not_ready")),
      observe: () => bridge.observe(),
    });
    // Mint exactly one authenticated association for the exact frozen wrapper
    // returned by this launch handle. The adapter refuses any structural copy,
    // forged wrapper, or caller state because only this exact object is bound.
    registerAuthenticatedStardewConnection(
      connection,
      () => executionGate.executable === true && bridge.state.connected,
    );
    const receiptRecovery: ExactReceiptRecoveryPort | undefined =
      identity.continuityId === undefined
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
    // Launcher-owned liveness for the MATERIALIZATION projection and the accessors that hand a whole port set out
    // of this record: an invalidated receipt, explicit close, or bridge disconnect freezes acquisition. Invalidation
    // never cancels, replays, retries, or closes the native mutation/pipe; only the launcher-owned record stops
    // being usable for NEW port acquisition.
    //
    // `assertLauncherPortsLive` is gone with the last caller that used the wider question: the long-lived program
    // ports moved to `areProgramPortsLive` below. `isLauncherClosed` remains because the record's own `isClosed()`
    // (line ~430) and `materializeAuthenticatedStardewLaunchPorts` still answer it.
    const isLauncherClosed = (): boolean => closed || invalidated || !bridge.state.connected;
    /**
     * Liveness for the ports that carry the WHOLE RUN's program work: submit, status, events.
     *
     * `invalidated` is deliberately NOT part of it. It marks ONE step's receipt - the Mod's own executor treats
     * that state as "this attempt did not finish, stay bound-Running and retry"
     * (`RouteReenteringBodyProgramExecutor.cs:301-305`), and `BodyProgramState` has no invalidated member at all
     * (`BodyProgramModels.cs:17`). Unsettled program state is protected entirely on the Mod side, by the journal
     * and the controller, which refuse by name. Nothing the Host can do to its own port protects any of it.
     *
     * Measured 2026-10-28 (`round2b`, spring day 5): Clint's furnace cutscene interrupted one `enter_exit`, the Mod
     * answered `state=invalidated; reasonCode=event_started` - correct - and the Host set `invalidated = true` and
     * never cleared it. Every later `program_status` and `program_submit` threw `stardew_launcher_ports_not_live`,
     * 16 times, and the companion stood at the farmhouse door saying "我这边有点卡住了，脚迈不出去" for the rest of the
     * run.
     *
     * The lock did not protect the unsettled program; it cut the only channel through which the Host could LEARN
     * the program's state. That is the opposite of protection.
     *
     * This is the third time this file has had to make the same distinction, and the comment on
     * `isPresentationClosed` below already states it: an execution being invalidated says nothing about whether
     * the companion may talk. `executionGate` went first (`52866c06`), presentation second, these ports now.
     *
     * A genuine disconnect still closes them: `disconnect()` clears `closed`, which this reads.
     */
    const areProgramPortsLive = (): boolean => closed || !bridge.state.connected;
    const assertProgramPortsLive = (): void => {
      if (areProgramPortsLive()) throw new Error("stardew_launcher_ports_not_live");
    };
    // The PRESENTATION projection is different, and deliberately so: the live session speaks through this same
    // object (`host-service.presentNativeAssistantContent` -> `farmhand-companion-presentation.present` ->
    // `bridge.state`), so gating it on `invalidated` silenced the companion after any interrupted execution. A
    // real ladder-6 run died exactly there (`stardew_launcher_ports_not_live` raised while the companion tried to
    // speak its closing line). An execution being invalidated says nothing about whether the companion may talk,
    // so only a close or a genuine disconnect freezes it.
    const isPresentationClosed = (): boolean => closed || !bridge.state.connected;
    const assertPresentationLive = (): void => {
      if (isPresentationClosed()) throw new Error("stardew_launcher_ports_not_live");
    };
    const presentation: FarmhandPresentationBridge = Object.freeze({
      get state() {
        assertPresentationLive();
        return Object.freeze({ snapshot: bridge.state.snapshot });
      },
      presentCompanionText: (request) => {
        assertPresentationLive();
        return bridge.presentCompanionText(request as never);
      },
      presentSystemNotice: (request) => {
        assertPresentationLive();
        return bridge.presentSystemNotice(request as never);
      },
    });
    // Body Program tools are gated by the authenticated pipe session. Runtime
    // attestation remains provenance/recovery evidence, not a second tool gate.
    const bodyProgram = bridge.state.authenticated
      ? Object.freeze({
          submit: (request: BodyProgramCandidateRequest): Promise<BodyProgramSubmitResult> => {
            assertProgramPortsLive();
            return bridge.programSubmit(request);
          },
          status: (request: BodyProgramStatusRequest): Promise<BodyProgramStatusResult> => {
            assertProgramPortsLive();
            return bridge.programStatus(request);
          },
          events: (request: BodyProgramEventsRequest): Promise<BodyProgramEventsResult> => {
            assertProgramPortsLive();
            return bridge.programEvents(request);
          },
        })
      : undefined;
    associateAuthenticatedStardewLaunch(
      handle,
      Object.freeze({
        connection,
        presentation,
        ...(bodyProgram === undefined ? {} : { bodyProgram }),
        bindBodyNodeAdmission: (handler) => bindLocalStardewBridgeBodyNodeAdmission(bridge, handler),
        isClosed: isLauncherClosed,
      }),
    );
    return handle;
  } catch (error) {
    executionGate.executable = false;
    removeFact();
    removeLifecycle();
    removeDiagnostic();
    bridge.close("stardew_launch_handle_construction_failed");
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
      return {
        source: "stardew_mod",
        kind: "execution_receipt",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.payload.executionId,
        revision: message.payload.revision,
        executionId: message.payload.executionId,
        requestId: message.payload.requestId,
        payload: message.payload,
      };
    case "semantic_event":
      return {
        source: "stardew_mod",
        kind: "semantic_event",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.correlationId,
        revision: message.payload.revision,
        ...(message.payload.activeExecution?.executionId === undefined
          ? {}
          : { executionId: message.payload.activeExecution.executionId }),
        payload: message.payload,
      };
    case "lifecycle":
      return {
        source: "stardew_mod",
        kind: "lifecycle",
        eventId: message.messageId,
        occurredAtMs: message.timestampMs,
        correlationId: message.correlationId,
        revision: 0,
        payload: message.payload,
      };
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
        // The Mod-owned semantic kind (day_started / time_milestone / …) rides
        // on the wire payload; it is the sensory identity downstream (event
        // pump → CompanionLoop) uses to decide a bounded presentation lease.
        ...(typeof message.payload.kind === "string" && message.payload.kind.length > 0
          ? { semanticKind: message.payload.kind }
          : {}),
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
  bodyNodeAdmissionHandler?: BodyNodeAdmissionHandler,
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
  if (bodyNodeAdmissionHandler !== undefined) record.bindBodyNodeAdmission(bodyNodeAdmissionHandler);
  return Object.freeze({ presentation: record.presentation, bodyProgram: record.bodyProgram });
}
