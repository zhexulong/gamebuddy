import { randomUUID } from "node:crypto";
import type { GameIntegrationModule } from "./integration-module.js";
import type { CompanionIntegration, CompanionIntegrationState } from "./integration-types.js";
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
  newEnvelope,
  nextCancelIdentity,
  type Scope,
  type Snapshot,
  type SystemNoticeRequest,
  validateBridgeMessage,
} from "./protocol.js";
import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";
import { parseStrictBridgeJson } from "./strict-bridge-json.js";

export type LocalStardewBridgeState = CompanionIntegrationState & Readonly<{ authenticated: boolean }>;
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
  | "execution_request"
  | "execution_receipt_query"
  | "cancel_request"
  | "companion_presentation_request"
  | "system_notice_request";

/**
 * Production Windows-local bridge adapter. The Mod's advertised capabilities
 * are the only action-policy summary; this transport never creates authority.
 */
export class LocalStardewBridgeClient implements CompanionIntegration {
  readonly #pending = new Map<string, PendingRequest>();
  #authenticated = false;
  #sessionId: string | null = null;
  #capabilities: readonly string[] = [];
  #catalogRegistrations: readonly ActionRegistration[] = [];
  #snapshot: Snapshot | null = null;
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
    readonly knowledge?: KnowledgeBundle,
    readonly gameVersion?: string,
    readonly module: GameIntegrationModule = STARDEW_INTEGRATION_MODULE,
  ) {
    transport.onMessage((json) => this.receive(json));
    transport.onData(() => {
      if (!this.#initialSnapshotReceived) return;
      for (const listener of this.#diagnosticListeners)
        listener({ stage: "native_chat_pipe_data_received", reasonCode: "received" });
    });
    transport.onClose((reasonCode) => {
      this.#authenticated = false;
      this.#initialSnapshotReceived = false;
      this.#sessionId = null;
      this.#capabilities = [];
      this.#catalogRegistrations = [];
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
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error("invalid_bridge_token");
    if (knowledge !== undefined && gameVersion === undefined) throw new Error("knowledge_version_required");
    const client = new LocalStardewBridgeClient(
      scope,
      await NamedPipeTransport.connect(pipeName),
      token,
      knowledge,
      gameVersion,
    );
    await client.hello();
    return client;
  }

  public get state(): LocalStardewBridgeState {
    return Object.freeze({
      connected: this.transport.connected && this.#authenticated,
      authenticated: this.#authenticated,
      sessionId: this.#sessionId,
      capabilities: this.#capabilities,
      catalogRegistrations: this.#catalogRegistrations,
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

  private async hello(): Promise<void> {
    const response = await this.request("hello", { token: this.token });
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "hello_ack") throw new Error("unexpected_hello_response");
    this.#authenticated = true;
    this.#sessionId = response.payload.sessionId;
    this.#capabilities = [...response.payload.capabilities];
    this.#catalogRegistrations = [...response.payload.registrations];
  }

  private request(type: OutboundRequestType, payload: Record<string, unknown>): Promise<BridgeMessage> {
    if (!this.transport.connected) return Promise.reject(new Error("pipe_disconnected"));
    const correlationId = randomUUID();
    const message = newEnvelope(type, this.scope, payload as never, correlationId);
    return new Promise<BridgeMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new Error("bridge_response_timeout"));
      }, 5_000);
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
    if (message.type === "hello_ack") {
      this.#snapshot = null;
      this.#initialSnapshotReceived = false;
      this.#latestReceipt = null;
      this.#capabilities = [...message.payload.capabilities];
      this.#catalogRegistrations = [...message.payload.registrations];
      this.#latestReasonCode = null;
    } else if (message.type === "snapshot") {
      // A delayed observation response must never replace newer Mod state.
      if (this.#snapshot === null || message.payload.revision > this.#snapshot.revision)
        this.#snapshot = message.payload;
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

function isPlayerControlSemanticEvent(message: BridgeMessage): boolean {
  return (
    message.type === "semantic_event" &&
    (message.payload.kind === "player_input" || message.payload.kind === "stop_all")
  );
}
