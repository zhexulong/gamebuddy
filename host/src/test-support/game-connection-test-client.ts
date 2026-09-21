import type { BridgeFault, DeterministicBridgeEndpoint } from "../bridge.js";
import type { GameIntegrationAdapter } from "../game-integration-adapter.js";
import type { StardewBridgeConnectionState } from "../game-connection.js";
import type { KnowledgeBundle } from "../knowledge.js";
import {
  type ActionRegistration,
  type BridgeMessage,
  type CancelIdentity,
  type ExecutionReceipt,
  type ExecutionRequest,
  type FarmhandPolicyIdentity,
  newEnvelope,
  nextCancelIdentity,
  type Scope,
  type Snapshot,
} from "../protocol.js";

/**
 * Host-side, game-neutral bridge state. It only caches Mod-originated facts;
 * it does not predict movement or reinterpret a receipt as success. The
 * deterministic endpoint is a test adapter, not a production IPC choice.
 */
export class GameConnectionTestClient {
  #sessionId: string | null = null;
  #capabilities: readonly string[] = [];
  #registrations: readonly ActionRegistration[] = [];
  #catalogRevision: number | null = null;
  #policyIdentity: FarmhandPolicyIdentity | null = null;
  readonly #acceptedPolicyIdentityValues = new Set<string>();
  #enabledActionIds: readonly string[] = [];
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
    readonly module: GameIntegrationAdapter,
    readonly knowledge?: KnowledgeBundle,
    readonly gameVersion?: string,
  ) {
    this.#unsubscribeMessage = endpoint.onMessage((message) => this.acceptIntegrationMessage(message));
    this.#unsubscribeDisconnect = endpoint.onDisconnect((reasonCode) => {
      this.#sessionId = null;
      this.#capabilities = [];
      this.#registrations = [];
       this.#catalogRevision = null;
       this.#policyIdentity = null;
       this.#acceptedPolicyIdentityValues.clear();
       this.#enabledActionIds = [];
      this.#snapshot = null;
      this.#latestReceipt = null;
      this.#latestReasonCode = reasonCode;
    });
  }

  public dispose(): void {
    this.#unsubscribeMessage();
    this.#unsubscribeDisconnect();
  }

  public get state(): StardewBridgeConnectionState {
    return Object.freeze({
      connected: this.endpoint.connected && this.#sessionId !== null,
      sessionId: this.#sessionId,
      capabilities: this.#capabilities,
      catalogRegistrations: this.#registrations,
      ...(this.#catalogRevision !== null ? { catalogRevision: this.#catalogRevision } : {}),
      ...(this.#policyIdentity !== null ? { policyIdentity: this.#policyIdentity } : {}),
      enabledActionIds: this.#enabledActionIds,
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
    if (
      !this.state.connected ||
      this.#snapshot === null ||
      this.#catalogRevision === null ||
      this.#snapshot.catalogRevision !== this.#catalogRevision ||
      !sameActionIds(this.#snapshot.enabledActionIds, this.#enabledActionIds) ||
      !this.#enabledActionIds.includes(request.action) ||
      !this.#snapshot.capabilities.includes(request.action)
    )
      return "not_ready";
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
        if (message.payload.policyIdentity === undefined) {
          this.endpoint.disconnect("invalid_hello_ack");
          break;
        }
        this.#sessionId = message.payload.sessionId;
        this.#capabilities = [...message.payload.capabilities];
         this.#registrations = [...message.payload.registrations];
         this.#catalogRevision = message.payload.catalogRevision;
         this.#policyIdentity = Object.freeze({ ...message.payload.policyIdentity });
         this.#acceptedPolicyIdentityValues.add(message.payload.policyIdentity.value);
         this.#enabledActionIds = [...message.payload.enabledActionIds];
        this.#snapshot = null;
        this.#latestReceipt = null;
        this.#latestReasonCode = null;
        break;
      case "catalog_update":
        if (
           message.payload.policyIdentity === undefined ||
           !/^[0-9a-f]{32}$/iu.test(message.payload.policyIdentity.value) ||
           !Number.isSafeInteger(message.payload.policyIdentity.capabilityRevision) ||
           message.payload.policyIdentity.capabilityRevision <= 0 ||
           this.#sessionId === null ||
           this.#catalogRevision === null ||
           this.#policyIdentity === null ||
           message.payload.catalogRevision !== this.#catalogRevision ||
           message.payload.policyIdentity.capabilityRevision <= this.#policyIdentity.capabilityRevision ||
           this.#acceptedPolicyIdentityValues.has(message.payload.policyIdentity.value) ||
           !message.payload.enabledActionIds.every((actionId) =>
            this.#registrations.some(
              (registration) => registration.actionId === actionId && registration.kind === "execution",
            ),
          )
        ) {
          // Mirror the production client's fail-closed behavior for stale or
          // malformed availability publications.
          this.endpoint.disconnect("invalid_catalog_update");
          break;
        }
         this.#catalogRevision = message.payload.catalogRevision;
         this.#policyIdentity = Object.freeze({ ...message.payload.policyIdentity });
         this.#acceptedPolicyIdentityValues.add(message.payload.policyIdentity.value);
         this.#enabledActionIds = [...message.payload.enabledActionIds];
         this.#snapshot = null;
        break;
      case "snapshot":
        // A delayed observation response must never replace newer Mod state;
        // snapshots must also bind exactly to the current availability.
        if (
          message.payload.catalogRevision === this.#catalogRevision &&
          sameActionIds(message.payload.enabledActionIds, this.#enabledActionIds) &&
          (this.#snapshot === null || message.payload.revision > this.#snapshot.revision)
        )
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

function sameActionIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((actionId, index) => actionId === right[index]);
}
