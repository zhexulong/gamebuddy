import type { BridgeFault, DeterministicBridgeEndpoint } from "./bridge.js";
import type { GameIntegrationModule } from "./integration-module.js";
import type { CompanionIntegrationState } from "./integration-types.js";
import type { KnowledgeBundle } from "./knowledge.js";
import {
  type BridgeMessage,
  type CancelIdentity,
  type ExecutionReceipt,
  type ExecutionRequest,
  newEnvelope,
  nextCancelIdentity,
  type Scope,
  type Snapshot,
} from "./protocol.js";

/**
 * Host-side, game-neutral bridge state. It only caches Mod-originated facts;
 * it does not predict movement or reinterpret a receipt as success. The
 * deterministic endpoint is a test adapter, not a production IPC choice.
 */
export class CompanionIntegrationClient {
  #sessionId: string | null = null;
  #capabilities: readonly string[] = [];
  #snapshot: Snapshot | null = null;
  #latestReceipt: ExecutionReceipt | null = null;
  #latestReasonCode: string | null = null;
  readonly #unsubscribeMessage: () => void;
  readonly #unsubscribeDisconnect: () => void;
  /** One stable cancelId per request; cancelEpoch strictly increases per distinct cancel attempt. */
  readonly #cancelIdentities = new Map<string, CancelIdentity>();

  public constructor(
    readonly scope: Scope,
    readonly endpoint: DeterministicBridgeEndpoint,
    readonly module: GameIntegrationModule,
    readonly knowledge?: KnowledgeBundle,
    readonly gameVersion?: string,
  ) {
    this.#unsubscribeMessage = endpoint.onMessage((message) => this.acceptIntegrationMessage(message));
    this.#unsubscribeDisconnect = endpoint.onDisconnect((reasonCode) => {
      this.#sessionId = null;
      this.#capabilities = [];
      this.#snapshot = null;
      this.#latestReceipt = null;
      this.#latestReasonCode = reasonCode;
    });
  }

  public dispose(): void {
    this.#unsubscribeMessage();
    this.#unsubscribeDisconnect();
  }

  public get state(): CompanionIntegrationState {
    return Object.freeze({
      connected: this.endpoint.connected && this.#sessionId !== null,
      sessionId: this.#sessionId,
      capabilities: this.#capabilities,
      snapshot: this.#snapshot,
      latestReceipt: this.#latestReceipt,
      latestReasonCode: this.#latestReasonCode,
    });
  }

  public hello(token: string, nowMs = Date.now()): BridgeFault | null {
    return this.endpoint.send(newEnvelope("hello", this.scope, { token }, undefined, nowMs), nowMs);
  }

  public observe(nowMs = Date.now()): BridgeFault | null {
    if (!this.state.connected) return "disconnected";
    return this.endpoint.send(newEnvelope("observe_request", this.scope, {}, undefined, nowMs), nowMs);
  }

  public execute(request: ExecutionRequest, nowMs = Date.now()): BridgeFault | "not_ready" | null {
    if (!this.state.connected || this.#snapshot === null) return "not_ready";
    return this.endpoint.send(newEnvelope("execution_request", this.scope, request, undefined, nowMs), nowMs);
  }

  public cancel(
    requestId: string,
    executionId: string,
    reasonCode: string,
    nowMs = Date.now(),
  ): BridgeFault | "not_ready" | null {
    if (!this.state.connected) return "not_ready";
    // The typed cancel identity is minted and remembered per request before
    // the envelope leaves the Host; a cancel without it can never be emitted.
    const identity = nextCancelIdentity(this.#cancelIdentities.get(requestId) ?? null);
    this.#cancelIdentities.set(requestId, identity);
    return this.endpoint.send(
      newEnvelope(
        "cancel_request",
        this.scope,
        {
          requestId,
          executionId,
          cancelId: identity.cancelId,
          cancelEpoch: identity.cancelEpoch,
          reasonCode,
        },
        undefined,
        nowMs,
      ),
      nowMs,
    );
  }

  /** Accept a validated Mod-to-Host fact from any transport adapter. */
  public acceptIntegrationMessage(message: BridgeMessage): void {
    switch (message.type) {
      case "hello_ack":
        this.#sessionId = message.payload.sessionId;
        this.#capabilities = [...message.payload.capabilities];
        this.#snapshot = null;
        this.#latestReceipt = null;
        this.#latestReasonCode = null;
        break;
      case "snapshot":
        // A delayed observation response must never replace newer Mod state.
        if (this.#snapshot === null || message.payload.revision > this.#snapshot.revision)
          this.#snapshot = message.payload;
        break;
      case "execution_receipt":
        this.#latestReceipt = message.payload;
        break;
      case "semantic_event":
      case "lifecycle":
        this.#latestReasonCode = message.payload.reasonCode;
        if (message.type === "lifecycle" && message.payload.state !== "connected") this.#sessionId = null;
        break;
      default:
        // The Host does not accept requests from the integration direction.
        this.#latestReasonCode = "unexpected_inbound_message";
    }
  }
}
