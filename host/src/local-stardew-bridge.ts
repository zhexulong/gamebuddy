import { randomUUID } from "node:crypto";
import type { GameIntegrationAdapter } from "./game-integration-adapter.js";
import type { StardewBridgeConnection, StardewBridgeConnectionState } from "./game-connection.js";
import type { KnowledgeBundle } from "./knowledge.js";
import { NamedPipeTransport } from "./named-pipe.js";
import {
  type ActionRegistration,
  type BridgeMessage,
  type CancelIdentity,
  type CompanionPresentationRequest,
  diagnoseBridgeMessage,
  type ExecutionReceipt,
  type ExecutionReceiptQuery,
  type ExecutionRequest,
  type NavigationReadRequest,
  type NavigationReadResult,
  newEnvelope,
  nextCancelIdentity,
  type Scope,
  type Snapshot,
  type SystemNoticeRequest,
  validateBridgeMessage,
} from "./protocol.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";
import { parseStrictBridgeJson } from "./strict-bridge-json.js";

export type LocalStardewBridgeState = StardewBridgeConnectionState &
  Readonly<{
    authenticated: boolean;
    /** Current authenticated Mod availability publication for this bridge generation. */
    catalogRevision?: number;
    enabledActionIds?: readonly string[];
  }>;
/** Validated Mod-originated facts forwarded to the Host event pump. */
export type LocalStardewBridgeFact = Extract<
  BridgeMessage,
  { type: "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle" }
>;
/** Local transport facts never claim a Mod/world transition. */
export type LocalStardewConnectionFact = Readonly<{ state: "disconnected"; reasonCode: string }>;
/** Fixed, content-free local diagnostic emitted immediately before a fail-closed inbound rejection. */
export type LocalStardewBridgeDiagnostic = Readonly<{
  stage:
  | "pipe_bytes_received"
  | "pipe_frame_header_accepted"
  | "pipe_frame_payload_complete"
  | "pipe_frame_dispatched"
  | "pipe_write_completed"
  | "pipe_write_failed"
  | "native_chat_pipe_data_received"
  | "native_chat_bridge_inbound_frame_received"
    | "native_chat_bridge_player_control_validated"
    | "native_chat_bridge_inbound_rejected";
  reasonCode: string;
}>;
type PendingRequest = Readonly<{
  type: OutboundRequestType;
  resolve: (message: BridgeMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

type OutboundRequestType =
  | "hello"
  | "observe_request"
  | "navigation_read_request"
  | "execution_request"
  | "execution_receipt_query"
  | "cancel_request"
  | "companion_presentation_request"
  | "system_notice_request";

/**
 * Production Windows-local bridge adapter. The Mod's advertised capabilities
 * are the only action-policy summary; this transport never creates authority.
 */
export class LocalStardewBridgeClient implements StardewBridgeConnection {
  readonly #pending = new Map<string, PendingRequest>();
  #authenticated = false;
  #sessionId: string | null = null;
  #capabilities: readonly string[] = [];
  #catalogRegistrations: readonly ActionRegistration[] = [];
  #snapshot: Snapshot | null = null;
  #catalogRevision: number | undefined;
  #enabledActionIds: readonly string[] | undefined;
  #catalogRefresh: Promise<Snapshot> | undefined;
  #catalogRefreshGeneration = 0;
  #latestReceipt: LocalStardewBridgeState["latestReceipt"] = null;
  #latestReasonCode: string | null = null;
  #initialSnapshotReceived = false;
  readonly #factListeners = new Set<(fact: LocalStardewBridgeFact) => void>();
  readonly #connectionListeners = new Set<(fact: LocalStardewConnectionFact) => void>();
  readonly #diagnosticListeners = new Set<(diagnostic: LocalStardewBridgeDiagnostic) => void>();
  /** One stable cancelId per request; cancelEpoch strictly increases per distinct cancel attempt. */
  readonly #cancelIdentities = new Map<string, CancelIdentity>();

  private constructor(
    readonly scope: Scope,
    readonly transport: NamedPipeTransport,
    readonly token: string,
    readonly expectedRuntimeAttestation: Readonly<{
      runtimeRole: "farmhand_client";
      launchGeneration: string;
    }> | undefined,
    readonly knowledge?: KnowledgeBundle,
    readonly gameVersion?: string,
    readonly module: GameIntegrationAdapter = STARDEW_GAME_INTEGRATION_ADAPTER,
  ) {
    transport.onMessage((json) => this.receive(json));
    transport.onFrameStage((stage) => {
      for (const listener of this.#diagnosticListeners) listener({ stage, reasonCode: "observed" });
    });
    transport.onData(() => {
      if (!this.#initialSnapshotReceived) return;
      for (const listener of this.#diagnosticListeners)
        listener({ stage: "native_chat_pipe_data_received", reasonCode: "received" });
    });
    transport.onClose((reasonCode) => {
      this.#authenticated = false;
      this.#initialSnapshotReceived = false;
      this.#sessionId = null;
      this.#capabilities = Object.freeze([]);
      this.#catalogRegistrations = Object.freeze([]);
      this.#catalogRevision = undefined;
      this.#enabledActionIds = undefined;
      this.#catalogRefresh = undefined;
      this.#catalogRefreshGeneration++;
      this.#snapshot = null;
      this.#latestReceipt = null;
      this.#latestReasonCode = reasonCode;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`bridge_disconnected:${reasonCode}`));
      }
      this.#pending.clear();
      for (const listener of this.#connectionListeners) listener({ state: "disconnected", reasonCode });
    });
  }

  public static async connect(
    scope: Scope,
    pipeName: string,
    token: string,
    knowledge?: KnowledgeBundle,
    gameVersion?: string,
  ): Promise<LocalStardewBridgeClient> {
    return LocalStardewBridgeClient.connectWithRuntimeAttestation(
      scope,
      pipeName,
      token,
      undefined,
      knowledge,
      gameVersion,
    );
  }

  public static async connectFarmhand(
    scope: Scope,
    pipeName: string,
    token: string,
    launchGeneration: string,
    deadlineMs: number,
    knowledge?: KnowledgeBundle,
    gameVersion?: string,
  ): Promise<LocalStardewBridgeClient> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(launchGeneration))
      throw new Error("invalid_bridge_launch_generation");
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now())
      throw new Error("bridge_connect_deadline_exceeded");
    return LocalStardewBridgeClient.connectWithRuntimeAttestation(
      scope,
      pipeName,
      token,
      Object.freeze({ runtimeRole: "farmhand_client", launchGeneration }),
      knowledge,
      gameVersion,
      deadlineMs,
    );
  }

  private static async connectWithRuntimeAttestation(
    scope: Scope,
    pipeName: string,
    token: string,
    expectedRuntimeAttestation: Readonly<{
      runtimeRole: "farmhand_client";
      launchGeneration: string;
    }> | undefined,
    knowledge?: KnowledgeBundle,
    gameVersion?: string,
    deadlineMs?: number,
  ): Promise<LocalStardewBridgeClient> {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error("invalid_bridge_token");
    if (knowledge !== undefined && gameVersion === undefined) throw new Error("knowledge_version_required");
    const client = new LocalStardewBridgeClient(
      scope,
      await NamedPipeTransport.connect(pipeName, deadlineMs),
      token,
      expectedRuntimeAttestation,
      knowledge,
      gameVersion,
    );
    try {
      await client.hello(deadlineMs);
      return client;
    } catch (error) {
      client.transport.close("bridge_handshake_failed");
      throw error;
    }
  }

  public get state(): LocalStardewBridgeState {
    return Object.freeze({
      connected: this.transport.connected && this.#authenticated,
      authenticated: this.#authenticated,
      sessionId: this.#sessionId,
      capabilities: this.#capabilities,
      catalogRegistrations: this.#catalogRegistrations,
      ...(this.#catalogRevision === undefined ? {} : { catalogRevision: this.#catalogRevision }),
      ...(this.#enabledActionIds === undefined ? {} : { enabledActionIds: this.#enabledActionIds }),
      snapshot: this.#snapshot,
      latestReceipt: this.#latestReceipt,
      latestReasonCode: this.#latestReasonCode,
    });
  }

  public async observe(): Promise<Snapshot> {
    this.requireAuthenticated();
    const response = await this.request("observe_request", {});
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "snapshot") throw new Error("unexpected_observe_response");
    this.acceptSnapshot(response.payload);
    return response.payload;
  }

  /**
   * Refresh the world projection once after a catalog publication changes.
   * Concurrent callers share one exact observe request, while the response is
   * admitted only if it still binds the current authenticated publication.
   */
  public refreshAfterCatalogUpdate(): Promise<Snapshot> {
    this.requireAuthenticated();
    if (this.#catalogRefresh !== undefined) return this.#catalogRefresh;
    const refresh = this.chaseCatalogRefresh();
    this.#catalogRefresh = refresh;
    const clear = () => {
      if (this.#catalogRefresh === refresh) this.#catalogRefresh = undefined;
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  private async chaseCatalogRefresh(): Promise<Snapshot> {
    while (true) {
      const generation = this.#catalogRefreshGeneration;
      const targetRevision = this.#catalogRevision;
      if (targetRevision === undefined) throw new Error("catalog_revision_unavailable");
      const snapshot = await this.observe();
      if (!this.transport.connected || !this.#authenticated) throw new Error("bridge_not_authenticated");
      if (generation !== this.#catalogRefreshGeneration || targetRevision !== this.#catalogRevision) continue;
      if (snapshot.catalogRevision !== targetRevision) throw new Error("catalog_refresh_stale_snapshot");
      return snapshot;
    }
  }

  public async navigationRead(request: NavigationReadRequest): Promise<NavigationReadResult> {
    this.requireAuthenticated();
    const response = await this.request("navigation_read_request", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "navigation_read_result") throw new Error("unexpected_navigation_read_response");
    return response.payload;
  }

  public async execute(request: ExecutionRequest): Promise<NonNullable<LocalStardewBridgeState["latestReceipt"]>> {
    this.requireAuthenticated();
    const response = await this.request("execution_request", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "execution_receipt") throw new Error("unexpected_execution_response");
    return response.payload;
  }

  /** Bounded companion text presentation; it is not a game action or capability. */
  public async presentCompanionText(request: CompanionPresentationRequest): Promise<void> {
    this.requireAuthenticated();
    const response = await this.request("companion_presentation_request", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (
      response.type !== "companion_presentation_receipt" ||
      response.payload.expressionId !== request.expressionId ||
      response.payload.revision !== request.expectedRevision ||
      response.payload.presentationEpoch !== request.presentationEpoch
    )
      throw new Error("unexpected_companion_presentation_response");
  }

  /** Fixed Host-owned system copy; it is never a Pi/model presentation. */
  public async presentSystemNotice(request: SystemNoticeRequest): Promise<void> {
    this.requireAuthenticated();
    const response = await this.request("system_notice_request", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "system_notice_receipt" || response.payload.noticeId !== request.noticeId)
      throw new Error("unexpected_system_notice_response");
  }

  /**
   * Read one Mod-owned receipt by the immutable original dispatch tuple.
   * This is never an action replay: the query has no action, args, revision,
   * deadline, or cancel identity and its correlated response is deliberately
   * withheld from the unsolicited fact route.
   */
  public async queryExecutionReceipt(query: ExecutionReceiptQuery): Promise<ExecutionReceipt> {
    this.requireAuthenticated();
    const response = await this.request("execution_receipt_query", query);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "execution_receipt") throw new Error("unexpected_execution_receipt_query_response");
    if (response.payload.requestId !== query.requestId) throw new Error("execution_receipt_query_request_mismatch");
    return response.payload;
  }

  public async cancel(
    requestId: string,
    executionId: string,
    reasonCode: string,
  ): Promise<NonNullable<LocalStardewBridgeState["latestReceipt"]>> {
    this.requireAuthenticated();
    // The typed cancel identity is minted and remembered per request before
    // the envelope leaves the Host; a cancel without it can never be emitted.
    const identity = nextCancelIdentity(this.#cancelIdentities.get(requestId) ?? null);
    this.#cancelIdentities.set(requestId, identity);
    const response = await this.request("cancel_request", {
      requestId,
      executionId,
      cancelId: identity.cancelId,
      cancelEpoch: identity.cancelEpoch,
      reasonCode,
    });
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "execution_receipt") throw new Error("unexpected_cancel_response");
    return response.payload;
  }

  /**
   * Confirms only that a validated Mod-originated control fact was synchronously
   * delivered to the Host listener. It is not a model, action, or presentation receipt.
   */
  public acknowledgePlayerControl(controlId: string, sourceEventId: string): void {
    this.requireAuthenticated();
    this.transport.send(
      newEnvelope("player_control_receipt", this.scope, { controlId, sourceEventId, status: "accepted" }, controlId),
    );
  }

  public close(): void {
    this.transport.close();
  }
  public onFact(listener: (fact: LocalStardewBridgeFact) => void): () => void {
    this.#factListeners.add(listener);
    return () => this.#factListeners.delete(listener);
  }
  public onConnectionFact(listener: (fact: LocalStardewConnectionFact) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }
  public onDiagnostic(listener: (diagnostic: LocalStardewBridgeDiagnostic) => void): () => void {
    this.#diagnosticListeners.add(listener);
    return () => this.#diagnosticListeners.delete(listener);
  }

  private async hello(deadlineMs?: number): Promise<void> {
    const response = await this.request("hello", { token: this.token }, deadlineMs);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "hello_ack") throw new Error("unexpected_hello_response");
    if (
      this.expectedRuntimeAttestation !== undefined &&
      (response.payload.runtimeRole !== this.expectedRuntimeAttestation.runtimeRole ||
        response.payload.launchGeneration !== this.expectedRuntimeAttestation.launchGeneration)
    ) {
      throw new Error("bridge_runtime_attestation_mismatch");
    }
    this.#authenticated = true;
    this.#sessionId = response.payload.sessionId;
    this.#capabilities = Object.freeze([...response.payload.capabilities]);
    this.#catalogRegistrations = Object.freeze([...response.payload.registrations]);
    this.#catalogRevision = response.payload.catalogRevision;
    this.#enabledActionIds = Object.freeze([...response.payload.enabledActionIds]);
  }

  private request(
    type: OutboundRequestType,
    payload: Record<string, unknown>,
    deadlineMs?: number,
  ): Promise<BridgeMessage> {
    if (!this.transport.connected) return Promise.reject(new Error("pipe_disconnected"));
    const timeoutMs = deadlineMs === undefined ? 5_000 : deadlineMs - Date.now();
    if (timeoutMs <= 0) return Promise.reject(new Error("bridge_connect_deadline_exceeded"));
    const correlationId = randomUUID();
    const message = newEnvelope(type, this.scope, payload as never, correlationId);
    return new Promise<BridgeMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new Error(deadlineMs === undefined ? "bridge_response_timeout" : "bridge_connect_deadline_exceeded"));
      }, timeoutMs);
      this.#pending.set(correlationId, { type, resolve: resolvePromise, reject, timer });
      try {
        this.transport.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(correlationId);
        reject(error);
      }
    });
  }

  private receive(json: string): void {
    let message: BridgeMessage;
    try {
      message = parseStrictBridgeJson(json) as BridgeMessage;
    } catch {
      this.transport.close("malformed_inbound_json");
      return;
    }
    // A narrow pre-validation discriminator adds observability only for a
    // purported native control event. It proves the frame reached Node but
    // grants no authority; validateBridgeMessage below still decides whether
    // the adapter may use it.
    if (isPurportedPlayerControlSemanticEvent(message)) {
      for (const listener of this.#diagnosticListeners)
        listener({ stage: "native_chat_bridge_inbound_frame_received", reasonCode: "received" });
    }
    const fault = validateBridgeMessage(message, this.scope);
    if (
      fault !== null ||
      message.type === "hello" ||
      message.type === "observe_request" ||
      message.type === "navigation_read_request" ||
      message.type === "execution_request" ||
      message.type === "execution_receipt_query" ||
      message.type === "cancel_request" ||
      message.type === "companion_presentation_request" ||
      message.type === "system_notice_request" ||
      message.type === "player_control_receipt"
    ) {
      const reasonCode =
        fault === "invalid_snapshot"
          ? (diagnoseBridgeMessage(message, this.scope) ?? fault)
          : (fault ?? "unexpected_inbound_request");
      // The externally visible diagnostic taxonomy is deliberately narrower
      // than protocol internals. It never includes a frame, player text,
      // identity, scope, credential, or an implementation type name.
      const diagnosticReasonCode = reasonCode === "invalid_semantic_event" ? "malformed_player_control" : reasonCode;
      for (const listener of this.#diagnosticListeners)
        listener({ stage: "native_chat_bridge_inbound_rejected", reasonCode: diagnosticReasonCode });
      this.transport.close(reasonCode);
      return;
    }
    if (message.type === "semantic_event" && isPlayerControlSemanticEvent(message)) {
      for (const listener of this.#diagnosticListeners)
        listener({ stage: "native_chat_bridge_player_control_validated", reasonCode: "accepted" });
    }
    const pending = this.#pending.get(message.correlationId);
    // A query response is a solicited recovery result. Its only consumer is
    // the caller (the reconnect supervisor), which then routes it through the
    // coordinator's normal receipt admission. Never race that authority with
    // an unsolicited fact listener or mutable adapter receipt state for the
    // same exact frame.
    const isSolicitedReceiptQueryResponse =
      pending?.type === "execution_receipt_query" && message.type === "execution_receipt";
    const isSolicitedNavigationResponse =
      pending?.type === "navigation_read_request" && message.type === "navigation_read_result";
    if (message.type === "navigation_read_result" && !isSolicitedNavigationResponse) {
      this.transport.close("unexpected_navigation_read_result");
      return;
    }
    if (pending !== undefined && !isExpectedResponse(pending.type, message.type)) {
      this.#pending.delete(message.correlationId);
      clearTimeout(pending.timer);
      pending.reject(
        new Error(pending.type === "navigation_read_request" ? "unexpected_navigation_read_response" : "unexpected_bridge_response"),
      );
      return;
    }
    if (message.type === "hello_ack") {
      this.#snapshot = null;
      this.#initialSnapshotReceived = false;
      this.#latestReceipt = null;
      this.#catalogRevision = message.payload.catalogRevision;
      this.#enabledActionIds = Object.freeze([...message.payload.enabledActionIds]);
      this.#capabilities = Object.freeze([...message.payload.capabilities]);
      this.#catalogRegistrations = Object.freeze([...message.payload.registrations]);
      this.#latestReasonCode = null;
    } else if (message.type === "catalog_update") {
      const registeredIds = new Set(
        this.#catalogRegistrations
          .filter((registration) => registration.kind === "execution")
          .map((registration) => registration.actionId),
      );
      if (
        this.#catalogRevision === undefined ||
        message.payload.catalogRevision <= this.#catalogRevision ||
        message.payload.enabledActionIds.some((actionId) => !registeredIds.has(actionId))
      ) {
        this.transport.close("invalid_catalog_update_authority");
        return;
      }
      this.#catalogRevision = message.payload.catalogRevision;
      this.#enabledActionIds = Object.freeze([...message.payload.enabledActionIds]);
      this.#catalogRefreshGeneration++;
      // Catalog availability is immutable per publication. Do not rewrite an
      // old snapshot into the new revision; the next fresh observe must bind it.
      this.#snapshot = null;
      void this.refreshAfterCatalogUpdate().catch(() => undefined);
    } else if (message.type === "snapshot") {
      this.acceptSnapshot(message.payload);
      this.#initialSnapshotReceived = true;
    } else if (message.type === "execution_receipt" && !isSolicitedReceiptQueryResponse) {
      this.#latestReceipt = message.payload;
    } else if (message.type === "semantic_event" || message.type === "lifecycle" || message.type === "error") {
      this.#latestReasonCode = message.payload.reasonCode;
    }
    if (
      !isSolicitedReceiptQueryResponse &&
      (message.type === "snapshot" ||
        message.type === "execution_receipt" ||
        message.type === "semantic_event" ||
        message.type === "lifecycle")
    ) {
      for (const listener of this.#factListeners) listener(message);
    }
    if (pending !== undefined) {
      this.#pending.delete(message.correlationId);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  private acceptSnapshot(snapshot: Snapshot): void {
    if (
      snapshot.catalogRevision !== this.#catalogRevision ||
      !sameActionIds(snapshot.enabledActionIds, this.#enabledActionIds ?? []) ||
      (this.#snapshot !== null && snapshot.revision <= this.#snapshot.revision)
    )
      return;
    this.#snapshot = Object.freeze({
      ...snapshot,
      capabilities: Object.freeze([...snapshot.capabilities]),
      enabledActionIds: Object.freeze([...snapshot.enabledActionIds]),
    });
  }

  private requireAuthenticated(): void {
    if (!this.transport.connected || !this.#authenticated) throw new Error("bridge_not_authenticated");
  }
}

/** Safe discriminator used only for a content-free inbound-stage label. */
function isPurportedPlayerControlSemanticEvent(message: unknown): boolean {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const record = message as Record<string, unknown>;
  if (
    record.type !== "semantic_event" ||
    !record.payload ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  )
    return false;
  const kind = (record.payload as Record<string, unknown>).kind;
  return kind === "player_input" || kind === "stop_all";
}

function isExpectedResponse(requestType: OutboundRequestType, responseType: BridgeMessage["type"]): boolean {
  if (responseType === "error") return true;
  switch (requestType) {
    case "hello":
      return responseType === "hello_ack";
    case "observe_request":
      return responseType === "snapshot";
    case "navigation_read_request":
      return responseType === "navigation_read_result";
    case "execution_request":
    case "execution_receipt_query":
    case "cancel_request":
      return responseType === "execution_receipt";
    case "companion_presentation_request":
      return responseType === "companion_presentation_receipt";
    case "system_notice_request":
      return responseType === "system_notice_receipt";
  }
}

function sameActionIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((actionId, index) => actionId === right[index]);
}

function isPlayerControlSemanticEvent(message: BridgeMessage): boolean {
  return (
    message.type === "semantic_event" &&
    (message.payload.kind === "player_input" || message.payload.kind === "stop_all")
  );
}
