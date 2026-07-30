import { randomUUID } from "node:crypto";

import { type CompanionIntegration, type CompanionIntegrationState } from "./integration-types.js";
import { NamedPipeTransport } from "./named-pipe.js";
import {
  newEnvelope,
  type BridgeMessage,
  type ExecutionRequest,
  type Scope,
  type Snapshot,
  validateBridgeMessage,
} from "./protocol.js";

export type LocalStardewBridgeState = CompanionIntegrationState & Readonly<{ authenticated: boolean }>;
/** Validated Mod-originated facts forwarded to the Host event pump. */
export type LocalStardewBridgeFact = Extract<BridgeMessage, { type: "snapshot" | "execution_receipt" | "semantic_event" | "lifecycle" }>;
/** Local transport facts never claim a Mod/world transition. */
export type LocalStardewConnectionFact = Readonly<{ state: "disconnected"; reasonCode: string }>;
type PendingRequest = Readonly<{
  resolve: (message: BridgeMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

/**
 * Production Windows-local bridge adapter. The Mod's advertised capabilities
 * are the only action-policy summary; this transport never creates authority.
 */
export class LocalStardewBridgeClient implements CompanionIntegration {
  readonly #pending = new Map<string, PendingRequest>();
  #authenticated = false;
  #sessionId: string | null = null;
  #capabilities: readonly string[] = [];
  #snapshot: Snapshot | null = null;
  #latestReceipt: LocalStardewBridgeState["latestReceipt"] = null;
  #latestReasonCode: string | null = null;
  readonly #factListeners = new Set<(fact: LocalStardewBridgeFact) => void>();
  readonly #connectionListeners = new Set<(fact: LocalStardewConnectionFact) => void>();

  private constructor(readonly scope: Scope, readonly transport: NamedPipeTransport, readonly token: string) {
    transport.onMessage((json) => this.receive(json));
    transport.onClose((reasonCode) => {
      this.#authenticated = false;
      this.#sessionId = null;
      this.#capabilities = [];
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

  public static async connect(scope: Scope, pipeName: string, token: string): Promise<LocalStardewBridgeClient> {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error("invalid_bridge_token");
    const client = new LocalStardewBridgeClient(scope, await NamedPipeTransport.connect(pipeName), token);
    await client.hello();
    return client;
  }

  public get state(): LocalStardewBridgeState {
    return Object.freeze({
      connected: this.transport.connected && this.#authenticated,
      authenticated: this.#authenticated,
      sessionId: this.#sessionId,
      capabilities: this.#capabilities,
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

  public async cancel(requestId: string, executionId: string, reasonCode: string): Promise<NonNullable<LocalStardewBridgeState["latestReceipt"]>> {
    this.requireAuthenticated();
    const response = await this.request("cancel_request", { requestId, executionId, reasonCode });
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "execution_receipt") throw new Error("unexpected_cancel_response");
    return response.payload;
  }

  public close(): void { this.transport.close(); }
  public onFact(listener: (fact: LocalStardewBridgeFact) => void): () => void {
    this.#factListeners.add(listener);
    return () => this.#factListeners.delete(listener);
  }
  public onConnectionFact(listener: (fact: LocalStardewConnectionFact) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  private async hello(): Promise<void> {
    const response = await this.request("hello", { token: this.token });
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "hello_ack") throw new Error("unexpected_hello_response");
    this.#authenticated = true;
    this.#sessionId = response.payload.sessionId;
  }

  private request(type: "hello" | "observe_request" | "execution_request" | "cancel_request", payload: Record<string, unknown>): Promise<BridgeMessage> {
    if (!this.transport.connected) return Promise.reject(new Error("pipe_disconnected"));
    const correlationId = randomUUID();
    const message = newEnvelope(type, this.scope, payload, correlationId);
    return new Promise<BridgeMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(correlationId); reject(new Error("bridge_response_timeout")); }, 5_000);
      this.#pending.set(correlationId, { resolve: resolvePromise, reject, timer });
      try { this.transport.send(message); } catch (error) {
        clearTimeout(timer); this.#pending.delete(correlationId); reject(error);
      }
    });
  }

  private receive(json: string): void {
    let message: BridgeMessage;
    try { message = JSON.parse(json) as BridgeMessage; } catch { this.transport.close("malformed_inbound_json"); return; }
    const fault = validateBridgeMessage(message, this.scope);
    if (fault !== null || message.type === "hello" || message.type === "observe_request" || message.type === "execution_request" || message.type === "cancel_request") {
      this.transport.close(fault ?? "unexpected_inbound_request"); return;
    }
    if (message.type === "hello_ack") {
      this.#snapshot = null; this.#latestReceipt = null;
      this.#capabilities = [...message.payload.capabilities]; this.#latestReasonCode = null;
    } else if (message.type === "snapshot") {
      // A delayed observation response must never replace newer Mod state.
      if (this.#snapshot === null || message.payload.revision > this.#snapshot.revision) this.#snapshot = message.payload;
    } else if (message.type === "execution_receipt") this.#latestReceipt = message.payload;
    else this.#latestReasonCode = message.payload.reasonCode;
    if (message.type === "snapshot" || message.type === "execution_receipt" || message.type === "semantic_event" || message.type === "lifecycle") {
      for (const listener of this.#factListeners) listener(message);
    }
    const pending = this.#pending.get(message.correlationId);
    if (pending !== undefined) { this.#pending.delete(message.correlationId); clearTimeout(pending.timer); pending.resolve(message); }
  }

  private requireAuthenticated(): void {
    if (!this.transport.connected || !this.#authenticated) throw new Error("bridge_not_authenticated");
  }
}
