import { randomUUID } from "node:crypto";
import type { GameIntegrationAdapter } from "./game-integration-adapter.js";
import type { StardewBridgeConnection, StardewBridgeConnectionState } from "./game-connection.js";
import type { KnowledgeBundle } from "./knowledge.js";
import { NamedPipeTransport } from "./named-pipe.js";
import {
  type ActionRegistration,
  type BodyProgramCandidateRequest,
  type BodyProgramEventsRequest,
  type BodyProgramEventsResult,
  type BodyProgramStatusRequest,
  type BodyProgramStatusResult,
  type BodyProgramSubmitResult,
  type BodyNodeAdmissionChallenge,
  type BodyNodeAdmissionResult,
  type BridgeMessage,
  type CancelIdentity,
  type CompanionPresentationRequest,
  diagnoseBridgeMessage,
  type ExecutionReceipt,
  type FarmhandPolicyIdentity,
  type ExecutionReceiptQuery,
  type ExecutionRequest,
  type NavigationReadRequest,
  type NavigationReadResult,
  type ObserveSceneRequest,
  type ObserveSceneResult,
  newEnvelope,
  nextCancelIdentity,
  type Scope,
  type Snapshot,
  type SystemNoticeRequest,
  validateBridgeMessage,
} from "./protocol.js";
import { parseStrictBridgeJson } from "./strict-bridge-json.js";

export type LocalStardewBridgeState = StardewBridgeConnectionState &
    Readonly<{
      authenticated: boolean;
    /** Current authenticated Mod availability publication for this bridge generation. */
    catalogRevision?: number;
    policyIdentity?: FarmhandPolicyIdentity;
    enabledActionIds?: readonly string[];
  }>;
/** Validated Mod-originated facts forwarded to the Host event pump. */
export type LocalStardewBridgeFact = Extract<
  BridgeMessage,
  { type: "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle" | "world_fact" }
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

type BodyNodeAdmissionHandler = (
  challenge: BodyNodeAdmissionChallenge,
) => Promise<BodyNodeAdmissionResult>;
type BodyNodeAdmissionBinder = (handler: BodyNodeAdmissionHandler) => void;

const bodyNodeAdmissionBinders = new WeakMap<LocalStardewBridgeClient, BodyNodeAdmissionBinder>();

/** Construction-private launcher seam; the client exposes no public binder method. */
export function bindLocalStardewBridgeBodyNodeAdmission(
  bridge: LocalStardewBridgeClient,
  handler: BodyNodeAdmissionHandler,
): void {
  const bind = bodyNodeAdmissionBinders.get(bridge);
  if (bind === undefined) throw new Error("stardew_body_node_admission_binder_unavailable");
  bind(handler);
}

type OutboundRequestType =
  | "hello"
  | "observe_request"
  | "navigation_read_request"
  | "observe_scene_request"
  | "execution_request"
  | "execution_receipt_query"
  | "cancel_request"
  | "companion_presentation_request"
  | "system_notice_request"
  | "program_submit"
  | "program_status"
  | "program_events";

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
  #policyIdentity: FarmhandPolicyIdentity | undefined;
  readonly #acceptedPolicyIdentityValues = new Set<string>();
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
  #bodyNodeAdmissionHandler: BodyNodeAdmissionHandler | undefined;
  readonly #bodyNodeAdmissionCorrelations = new Set<string>();

  private constructor(
    readonly scope: Scope,
    readonly transport: NamedPipeTransport,
    readonly token: string,
    readonly expectedRuntimeAttestation: Readonly<{
      runtimeRole: "farmhand_client";
      launchGeneration: string;
    }> | undefined,
    readonly module: GameIntegrationAdapter,
    readonly knowledge?: KnowledgeBundle,
    readonly gameVersion?: string,
  ) {
    bodyNodeAdmissionBinders.set(this, (handler) => {
      this.requireAuthenticated();
      if (this.#bodyNodeAdmissionHandler !== undefined)
        throw new Error("body_node_admission_handler_already_bound");
      this.#bodyNodeAdmissionHandler = handler;
    });
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
       this.#policyIdentity = undefined;
       this.#acceptedPolicyIdentityValues.clear();
       this.#enabledActionIds = undefined;
        this.#bodyNodeAdmissionHandler = undefined;
        this.#bodyNodeAdmissionCorrelations.clear();
        bodyNodeAdmissionBinders.delete(this);
        this.#catalogRefresh = undefined;
      this.#catalogRefreshGeneration++;
      this.#snapshot = null;
      this.#latestReceipt = null;
      this.#latestReasonCode = reasonCode;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(isBodyProgramRequest(pending.type) ? "body_program_protocol_invalid" : `bridge_disconnected:${reasonCode}`));
      }
      this.#pending.clear();
      for (const listener of this.#connectionListeners) listener({ state: "disconnected", reasonCode });
    });
  }

  public static async connect(
    scope: Scope,
    pipeName: string,
    token: string,
    module: GameIntegrationAdapter,
    knowledge?: KnowledgeBundle,
    gameVersion?: string,
  ): Promise<LocalStardewBridgeClient> {
    return LocalStardewBridgeClient.connectWithRuntimeAttestation(
      scope,
      pipeName,
      token,
      undefined,
      module,
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
    module: GameIntegrationAdapter,
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
      module,
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
    module: GameIntegrationAdapter,
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
      module,
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
      ...(this.#policyIdentity === undefined ? {} : { policyIdentity: this.#policyIdentity }),
      ...(this.#enabledActionIds === undefined ? {} : { enabledActionIds: this.#enabledActionIds }),
      snapshot: this.#snapshot,
      latestReceipt: this.#latestReceipt,
      latestReasonCode: this.#latestReasonCode,
    });
  }

  /** True only after this client verified the exact Farmhand launch attestation in hello_ack. */
  public get hasExactFarmhandRuntimeAttestation(): boolean {
    return this.#authenticated && this.expectedRuntimeAttestation !== undefined;
  }

  public async observe(): Promise<Snapshot> {
    this.requireAuthenticated();
    const response = await this.request("observe_request", {});
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "snapshot") throw new Error("unexpected_observe_response");
    // `receive()` admits the solicited snapshot before resolving this request.
    // A snapshot that fails admission (publication-stale or unauthorized) is
    // fail-closed and never resolved here; only an admitted current world is
    // returned to the caller. Do not admit it a second time: that second pass
    // would reject the same revision as stale and break every normal observe.
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
      let snapshot: Snapshot;
      try {
        snapshot = await this.observe();
      } catch {
        // observe() rejects a stale solicited snapshot fail-closed. Never fall
        // through to an un-admitted payload: only a current-generation response
        // may resolve the refresh, so retry the current generation.
        if (!this.transport.connected || !this.#authenticated) throw new Error("bridge_not_authenticated");
        continue;
      }
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

  /** Read the Mod-advertised scene projection; this route cannot dispatch or create a receipt. */
  public async observeScene(request: ObserveSceneRequest = {}): Promise<ObserveSceneResult> {
    this.requireAuthenticated();
    if (!this.hasPublishedReadOnlyCapability("observe_scene"))
      throw new Error("bridge_capability_not_ready");
    const response = await this.request("observe_scene_request", request as Record<string, unknown>);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "observe_scene_result") throw new Error("unexpected_observe_scene_response");
    return response.payload;
  }

  private hasPublishedReadOnlyCapability(actionId: string): boolean {
    const state = this.state;
    return state.connected && state.snapshot !== null &&
      state.catalogRevision === state.snapshot.catalogRevision &&
      state.capabilities.includes(actionId) && state.snapshot.capabilities.includes(actionId) &&
      (state.catalogRegistrations ?? []).some((registration) => registration.actionId === actionId &&
        registration.familyId === "world_perception" && registration.identityVersion === 1 &&
        registration.lifecycle === "published" && registration.kind === "read_only");
  }

  /**
   * Dispatch one game action.
   *
   * Two things happen here that the raw request path cannot decide on its own:
   *
   * 1. `stale_snapshot` is the Mod's revision CAS refusing the request **before any side effect**
   *    (`BridgeSession.IsFreshExecutionRequest`), and it means exactly one thing: the caller's view of
   *    the action-transaction revision is behind. The Mod mints a fresh revision for every durable
   *    receipt — including ones this Host may not have carried — so a well-formed request can still
   *    arrive one revision late (live evidence: a play session lost three `harvest_crop` dispatches
   *    to this while neighbouring actions succeeded). It is answered the way it is meant to be:
   *    re-observe ONCE, then re-dispatch the same envelope with the refreshed revision.
   *
   * 2. A TRANSPORT TIMEOUT is not a refusal and not a failure: the request may be executing right
   *    now. Re-dispatching it would be a second native action (the caller's next attempt carries a
   *    new requestId, so nothing would dedupe it), so the only honest move is to read the action's
   *    own receipt back by its immutable dispatch tuple and report what actually happened.
   *
   * The action's own `deadlineMs` is the transport budget, not the client's 5 s default: a native
   * action that walks and swings legitimately outlives a short client timer, and timing out such a
   * request reported `bridge_response_timeout` for actions that completed moments later.
   */
  public async execute(
    request: ExecutionRequest,
    options: { reobserveOnStaleSnapshot?: boolean; recoverOnTimeout?: boolean } = {},
  ): Promise<NonNullable<LocalStardewBridgeState["latestReceipt"]>> {
    this.requireAuthenticated();
    let response: BridgeMessage;
    try {
      response = await this.request("execution_request", request, request.deadlineMs);
    } catch (error) {
      const message = String((error as Error).message);
      if (message !== "bridge_response_timeout" || options.recoverOnTimeout === false) throw error;
      const recovered = await this.queryExecutionReceipt({
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
      });
      // The query is authoritative about this exact dispatch tuple; whatever it reports is the
      // action's real state. Surfacing the timeout instead would tell the caller an action failed
      // when it is running or already done.
      return recovered;
    }
    if (response.type === "error") {
      if (response.payload.reasonCode === "stale_snapshot" && options.reobserveOnStaleSnapshot !== false) {
        const refreshed = await this.observe();
        if (refreshed.revision !== request.expectedRevision) {
          const retried = await this.request("execution_request", {
            ...request,
            expectedRevision: refreshed.revision,
          }, request.deadlineMs);
          if (retried.type === "error") throw new Error(`bridge_rejected:${retried.payload.reasonCode}`);
          if (retried.type !== "execution_receipt") throw new Error("unexpected_execution_response");
          return retried.payload;
        }
      }
      throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    }
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

  public async programSubmit(request: BodyProgramCandidateRequest): Promise<BodyProgramSubmitResult> {
    this.requireAuthenticated();
    const response = await this.request("program_submit", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "program_submit_result" ||
      (response.payload.snapshot !== null && response.payload.snapshot.programId !== request.programId))
      return this.rejectBodyProgramProtocol();
    return response.payload;
  }

  public async programStatus(request: BodyProgramStatusRequest): Promise<BodyProgramStatusResult> {
    this.requireAuthenticated();
    const response = await this.request("program_status", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "program_status_result" ||
      (response.payload.snapshot !== null && response.payload.snapshot.programId !== request.programId))
      return this.rejectBodyProgramProtocol();
    return response.payload;
  }

  public async programEvents(request: BodyProgramEventsRequest): Promise<BodyProgramEventsResult> {
    this.requireAuthenticated();
    const response = await this.request("program_events", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "program_events_result" || response.payload.programId !== request.programId)
      return this.rejectBodyProgramProtocol();
    const result = response.payload;
    if (
      result.events.length > request.pageSize ||
      result.nextCursor < request.cursor ||
      result.events.some((event, index) => event.programId !== request.programId ||
        event.cursor <= request.cursor || event.cursor > result.nextCursor ||
        event.cursor > result.highWater ||
        (index > 0 && event.cursor <= result.events[index - 1]!.cursor)) ||
      (result.events.length === 0
        ? result.nextCursor !== request.cursor
        : (result.highWater < request.cursor ||
          result.nextCursor !== result.events[result.events.length - 1]!.cursor))
    )
      return this.rejectBodyProgramProtocol();
    return result;
  }

  private rejectBodyProgramProtocol(): never {
    this.transport.close("body_program_protocol_invalid");
    throw new Error("body_program_protocol_invalid");
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
    if (response.payload.policyIdentity === undefined) throw new Error("invalid_policy_identity");
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
     this.#policyIdentity = Object.freeze({ ...response.payload.policyIdentity });
     this.#acceptedPolicyIdentityValues.add(response.payload.policyIdentity.value);
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
    // A transport that already closed this generation must never accept a
    // later inbound frame, including one buffered in the same pipe chunk.
    if (!this.transport.connected) return;
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
    const bodyProgramPending = this.#pending.get(message.correlationId);
    if (fault !== null && bodyProgramPending !== undefined && isBodyProgramRequest(bodyProgramPending.type)) {
      this.#pending.delete(message.correlationId);
      clearTimeout(bodyProgramPending.timer);
      bodyProgramPending.reject(new Error("body_program_protocol_invalid"));
      this.transport.close("body_program_protocol_invalid");
      return;
    }
    if (
      fault !== null ||
      message.type === "hello" ||
      message.type === "observe_request" ||
       message.type === "navigation_read_request" ||
       message.type === "observe_scene_request" ||
       message.type === "execution_request" ||
      message.type === "execution_receipt_query" ||
      message.type === "cancel_request" ||
      message.type === "companion_presentation_request" ||
      message.type === "system_notice_request" ||
      message.type === "program_submit" ||
      message.type === "program_status" ||
      message.type === "program_events" ||
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
     if (message.type === "hello_ack" && pending?.type !== "hello") {
       this.transport.close("unexpected_hello_ack");
       return;
     }
     // A query response is a solicited recovery result. Its only consumer is
    // the caller (the reconnect supervisor), which then routes it through the
    // coordinator's normal receipt admission. Never race that authority with
    // an unsolicited fact listener or mutable adapter receipt state for the
    // same exact frame.
    const isSolicitedReceiptQueryResponse =
      pending?.type === "execution_receipt_query" && message.type === "execution_receipt";
    const isSolicitedNavigationResponse =
      pending?.type === "navigation_read_request" && message.type === "navigation_read_result";
    const isSolicitedObserveSceneResponse =
      pending?.type === "observe_scene_request" && message.type === "observe_scene_result";
    let snapshotAdmitted = true;
     if (message.type === "navigation_read_result" && !isSolicitedNavigationResponse) {
       this.transport.close("unexpected_navigation_read_result");
       return;
     }
     if (message.type === "observe_scene_result" && !isSolicitedObserveSceneResponse) {
       this.transport.close("unexpected_observe_scene_result");
       return;
     }
    if (isBodyProgramResponse(message.type) && (pending === undefined || !isBodyProgramRequest(pending.type))) {
      this.transport.close("body_program_protocol_invalid");
      return;
    }
    if (pending !== undefined && !isExpectedResponse(pending.type, message.type)) {
      this.#pending.delete(message.correlationId);
      clearTimeout(pending.timer);
      pending.reject(
        new Error(
          isBodyProgramRequest(pending.type)
            ? "body_program_protocol_invalid"
            : pending.type === "navigation_read_request"
              ? "unexpected_navigation_read_response"
              : "unexpected_bridge_response",
        ),
      );
      if (isBodyProgramRequest(pending.type)) this.transport.close("body_program_protocol_invalid");
      return;
    }
    if (message.type === "hello_ack") {
      if (message.payload.policyIdentity === undefined) {
        this.transport.close("invalid_hello_ack");
        return;
      }
    this.#snapshot = null;
    this.#initialSnapshotReceived = false;
      this.#latestReceipt = null;
       this.#catalogRevision = message.payload.catalogRevision;
       this.#policyIdentity = Object.freeze({ ...message.payload.policyIdentity });
       this.#acceptedPolicyIdentityValues.add(message.payload.policyIdentity.value);
       this.#enabledActionIds = Object.freeze([...message.payload.enabledActionIds]);
       this.#capabilities = Object.freeze([...message.payload.capabilities]);
      this.#catalogRegistrations = Object.freeze([...message.payload.registrations]);
      this.#latestReasonCode = null;
    } else if (message.type === "body_node_admission_challenge") {
      const bodyNodeAdmissionHandler = this.#bodyNodeAdmissionHandler;
      if (!this.#authenticated || bodyNodeAdmissionHandler === undefined) {
        this.transport.close("body_node_admission_unavailable");
        return;
      }
      if (this.#bodyNodeAdmissionCorrelations.has(message.correlationId)) {
        this.transport.close("body_node_admission_duplicate");
        return;
      }
      this.#bodyNodeAdmissionCorrelations.add(message.correlationId);
      void bodyNodeAdmissionHandler(message.payload).then((result) => {
        if (!this.transport.connected || !this.#authenticated) return;
        if (!this.#bodyNodeAdmissionCorrelations.has(message.correlationId)) return;
        const response = newEnvelope("body_node_admission_result", this.scope, result, message.correlationId);
        try { this.transport.send(response); } catch { this.transport.close("body_node_admission_result_write_failed"); }
      }, () => {
        this.#bodyNodeAdmissionCorrelations.delete(message.correlationId);
        if (this.transport.connected) this.transport.close("body_node_admission_unavailable");
      });
    } else if (message.type === "catalog_update") {
      if (message.payload.policyIdentity === undefined) {
        this.transport.close("invalid_catalog_update");
        return;
      }
      const registeredIds = new Set(
        this.#catalogRegistrations
          .filter((registration) => registration.kind === "execution")
          .map((registration) => registration.actionId),
      );
      if (
         !this.#authenticated ||
         this.#catalogRevision === undefined ||
         this.#policyIdentity === undefined ||
         message.payload.catalogRevision !== this.#catalogRevision ||
         message.payload.policyIdentity.capabilityRevision <= this.#policyIdentity.capabilityRevision ||
         this.#acceptedPolicyIdentityValues.has(message.payload.policyIdentity.value) ||
         message.payload.enabledActionIds.some((actionId) => !registeredIds.has(actionId))
      ) {
        this.transport.close("invalid_catalog_update_authority");
        return;
      }
       this.#catalogRevision = message.payload.catalogRevision;
       this.#policyIdentity = Object.freeze({ ...message.payload.policyIdentity });
       this.#acceptedPolicyIdentityValues.add(message.payload.policyIdentity.value);
       this.#enabledActionIds = Object.freeze([...message.payload.enabledActionIds]);
       this.#catalogRefreshGeneration++;
      // Catalog availability is immutable per publication. Do not rewrite an
      // old snapshot into the new revision; the next fresh observe must bind it.
      this.#snapshot = null;
      void this.refreshAfterCatalogUpdate().catch(() => undefined);
    } else if (message.type === "snapshot") {
      // A delayed or publication-stale snapshot is still the response to its
      // exact observe correlation. Never let a stale payload replace the last
      // admitted state or tear down the bridge; a solicited one is rejected
      // fail-closed below so its caller can only chase the current generation.
      snapshotAdmitted = this.acceptSnapshot(message.payload);
      if (snapshotAdmitted) this.#initialSnapshotReceived = true;
    } else if (message.type === "execution_receipt" && !isSolicitedReceiptQueryResponse) {
      this.#latestReceipt = message.payload;
      // The Mod mints a fresh revision for every durable execution receipt and
      // the presentation gate requires expectedRevision == executions.Revision.
      // Synchronize the admitted snapshot's monotonic revision (nothing else)
      // so an Agent turn that drove a native action can still present its
      // companion text without an extra observe race. Never rewrite world
      // fields; a later fresh observe reconciles the full projection.
      const currentSnapshot = this.#snapshot;
      if (currentSnapshot !== null && message.payload.revision > currentSnapshot.revision) {
        this.#snapshot = Object.freeze({
          ...currentSnapshot,
          revision: message.payload.revision,
        });
        // The revision advanced but the world fields are still from before the
        // action; the next solicited snapshot replaces them. That snapshot may
        // legitimately carry the same revision (see acceptSnapshot), which is
        // exactly how the real post-action location reaches the Agent.
      }
    } else if (message.type === "semantic_event" || message.type === "lifecycle" || message.type === "error") {
      this.#latestReasonCode = message.payload.reasonCode;
    }
    if (
      !isSolicitedReceiptQueryResponse &&
      ((message.type === "snapshot" && snapshotAdmitted) ||
        message.type === "execution_receipt" ||
        message.type === "semantic_event" ||
        message.type === "lifecycle" ||
        message.type === "world_fact")
    ) {
      try {
        for (const listener of this.#factListeners) listener(message);
      } catch (error) {
        // A downstream fact listener (e.g. the CompanionEventPump) is not part
        // of the authenticated transport and cannot keep the bridge
        // authenticated after failure. Fail closed on a bounded reason through
        // the existing close/state cleanup path: pending requests are rejected
        // by onClose and no later inbound fact is accepted on this generation.
        const reasonCode =
          error instanceof Error && error.message === "event_pump_event_overflow"
            ? "event_pump_event_overflow"
            : "fact_listener_failed";
        this.transport.close(reasonCode);
        return;
      }
    }
    if (pending !== undefined) {
      this.#pending.delete(message.correlationId);
      clearTimeout(pending.timer);
      if (message.type === "snapshot" && !snapshotAdmitted) {
        // A solicited observe whose snapshot failed admission is fail-closed:
        // it must never surface an un-admitted projection to the caller.
        pending.reject(new Error("observe_snapshot_not_admitted"));
      } else {
        pending.resolve(message);
      }
    }
  }

  private acceptSnapshot(snapshot: Snapshot): boolean {
    // A snapshot is always the response to a solicited observe: the protocol has
    // no unsolicited snapshot push, so the caller asked for the world as it is
    // now and is entitled to receive it.
    //
    // `revision` is the ACTION-TRANSACTION version, not a world frame counter. The
    // Mod mints a new one when a handler is dispatched or a receipt is published,
    // and mutates nothing else -- so in a live world it stays put while the world
    // does not: time advances, villagers walk their schedules, a Pet wanders. The
    // earlier rule treated "same revision" as "duplicate frame" and refused it,
    // which reads a static-sandbox assumption (world changes only when the
    // companion acts) into a 60Hz simulation.
    //
    // That misfiled a READ as a STALE WRITE. A solicited observe whose payload
    // carried real world fields was rejected before the caller ever saw it, and
    // the caller could not recover: nothing generates a new revision while the
    // companion stands still, so there was no newer revision to chase, and the
    // client fell back to a cached projection that described a place the world had
    // already left. Concretely, a driver watching a Pet could only ever see the
    // instant of its first observation, so it could never notice the Pet settle.
    //
    // Authorisation is unaffected and stays exactly as strict. Isolation is scope
    // (integration/save/world/player/companion), authority is policyIdentity, and
    // both capability checks below -- catalogRevision and enabledActionIds -- are
    // untouched. Action CAS is untouched too: it compares the request's
    // expectedRevision to the admitted revision, and this only decides whether a
    // projection may be shown, never what revision a request may claim against.
    // Replaying an OLDER revision is still refused. That is the property the
    // receipt path relies on: a receipt may advance the cached revision while the
    // world fields still describe the pre-action moment, and the next solicited
    // observe must be able to fill them in without an older frame ever replacing a
    // newer one. Out-of-order substitution is not a hazard here: pending requests
    // are matched by correlationId on a single ordered pipe, so each response
    // resolves its own call.
    if (
      snapshot.catalogRevision !== this.#catalogRevision ||
      !sameActionIds(snapshot.enabledActionIds, this.#enabledActionIds ?? []) ||
      (this.#snapshot !== null && snapshot.revision < this.#snapshot.revision)
    )
      return false;
    this.#snapshot = Object.freeze({
      ...snapshot,
      capabilities: Object.freeze([...snapshot.capabilities]),
      enabledActionIds: Object.freeze([...snapshot.enabledActionIds]),
    });
    return true;
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
     case "observe_scene_request":
       return responseType === "observe_scene_result";
     case "execution_request":
    case "execution_receipt_query":
    case "cancel_request":
      return responseType === "execution_receipt";
    case "companion_presentation_request":
      return responseType === "companion_presentation_receipt";
    case "system_notice_request":
      return responseType === "system_notice_receipt";
    case "program_submit":
      return responseType === "program_submit_result";
    case "program_status":
      return responseType === "program_status_result";
    case "program_events":
      return responseType === "program_events_result";
  }
}

function isBodyProgramRequest(type: OutboundRequestType): boolean {
  return type === "program_submit" || type === "program_status" || type === "program_events";
}
function isBodyProgramResponse(type: BridgeMessage["type"]): boolean {
  return type === "program_submit_result" ||
    type === "program_status_result" || type === "program_events_result";
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
