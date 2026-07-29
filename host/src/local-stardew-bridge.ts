import { randomUUID } from "node:crypto";

import { type CompanionIntegration, type CompanionIntegrationState } from "./integration-types.js";
import { NamedPipeTransport } from "./named-pipe.js";
import {
  type ActionGrant,
  newEnvelope,
  type BridgeMessage,
  type ExecutionRequest,
  type Scope,
  type Snapshot,
  validateBridgeMessage,
} from "./protocol.js";

export type LocalStardewBridgeState = CompanionIntegrationState & Readonly<{ authenticated: boolean; actionGrants: readonly ActionGrant[] }>;

/**
 * Production Windows-local bridge adapter. It owns only pipe/session facts and
 * rejects unvalidated input; it never predicts a game result. It is separate
 * from the deterministic test transport because it has no mock peer.
 */
export class LocalStardewBridgeClient implements CompanionIntegration {
  readonly #pending = new Map<string, (message: BridgeMessage) => void>();
  #authenticated = false;
  #sessionId: string | null = null;
  #capabilities: readonly string[] = [];
  #actionGrants: readonly ActionGrant[] = [];
  #snapshot: Snapshot | null = null;
  #latestReceipt: LocalStardewBridgeState["latestReceipt"] = null;
  #latestReasonCode: string | null = null;

  private constructor(readonly scope: Scope, readonly transport: NamedPipeTransport, readonly token: string) {
    transport.onMessage((json) => this.receive(json));
    transport.onClose((reasonCode) => {
      this.#authenticated = false;
      this.#sessionId = null;
      this.#capabilities = [];
      this.#actionGrants = [];
      this.#snapshot = null;
      this.#latestReceipt = null;
      this.#latestReasonCode = reasonCode;
      this.#pending.clear();
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
      actionGrants: this.#actionGrants,
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

  /** Select one fresh Mod-issued move grant; the Agent never receives token material. */
  public nextMoveGrant(): string | null {
    const now = Date.now();
    const grant = this.#actionGrants.find((candidate) => candidate.action === "move_to_tile" && candidate.expiresAtMs > now);
    return grant?.token ?? null;
  }

  public async execute(request: ExecutionRequest): Promise<NonNullable<LocalStardewBridgeState["latestReceipt"]>> {
    this.requireAuthenticated();
    if (!this.#actionGrants.some((grant) => grant.token === request.permissionToken && grant.action === request.action && grant.expiresAtMs > Date.now())) throw new Error("action_grant_unavailable_or_expired");
    const response = await this.request("execution_request", request);
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "execution_receipt") throw new Error("unexpected_execution_response");
    this.#actionGrants = this.#actionGrants.filter((grant) => grant.token !== request.permissionToken);
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

  private async hello(): Promise<void> {
    const response = await this.request("hello", { token: this.token });
    if (response.type === "error") throw new Error(`bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "hello_ack") throw new Error("unexpected_hello_response");
    this.#authenticated = true;
    this.#sessionId = response.payload.sessionId;
  }

  private request(
    type: "hello" | "observe_request" | "execution_request" | "cancel_request",
    payload: Record<string, unknown>,
  ): Promise<BridgeMessage> {
    if (!this.transport.connected) return Promise.reject(new Error("pipe_disconnected"));
    const correlationId = randomUUID();
    const message = newEnvelope(type, this.scope, payload, correlationId);
    return new Promise<BridgeMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(new Error("bridge_response_timeout"));
      }, 5_000);
      this.#pending.set(correlationId, (response) => {
        clearTimeout(timer);
        resolvePromise(response);
      });
      try { this.transport.send(message); } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(correlationId);
        reject(error);
      }
    });
  }

  private receive(json: string): void {
    let message: BridgeMessage;
    try { message = JSON.parse(json) as BridgeMessage; } catch {
      this.transport.close("malformed_inbound_json");
      return;
    }
    const fault = validateBridgeMessage(message, this.scope);
    if (fault !== null || message.type === "hello" || message.type === "observe_request" || message.type === "execution_request" || message.type === "cancel_request") {
      this.transport.close(fault ?? "unexpected_inbound_request");
      return;
    }
    if (message.type === "hello_ack") {
      this.#snapshot = null;
      this.#latestReceipt = null;
      this.#capabilities = [...message.payload.capabilities];
      this.#actionGrants = [...message.payload.actionGrants];
      this.#latestReasonCode = null;
    } else if (message.type === "snapshot") this.#snapshot = message.payload;
    else if (message.type === "execution_receipt") this.#latestReceipt = message.payload;
    else this.#latestReasonCode = message.payload.reasonCode;

    const pending = this.#pending.get(message.correlationId);
    if (pending !== undefined) {
      this.#pending.delete(message.correlationId);
      pending(message);
    }
  }

  private requireAuthenticated(): void {
    if (!this.transport.connected || !this.#authenticated) throw new Error("bridge_not_authenticated");
  }
}
