import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import {
  PORTFOLIO_MAX_MESSAGE_BYTES,
  PORTFOLIO_TOPOLOGY,
  type PortfolioMessage,
  type PortfolioScope,
  type PortfolioSnapshot,
  newPortfolioEnvelope,
  serializePortfolioBounded,
  validatePortfolioMessage,
  validatePortfolioSnapshot,
} from "./portfolio-protocol.js";

export type PortfolioBridgeState = Readonly<{
  connected: boolean;
  authenticated: boolean;
  snapshot: PortfolioSnapshot | null;
  latestReasonCode: string | null;
}>;

type Pending = Readonly<{ resolve: (message: PortfolioMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;

/** Host adapter for the independent Portfolio observe-only protocol. */
export class PortfolioStardewBridgeClient {
  readonly #pending = new Map<string, Pending>();
  readonly #events = new EventEmitter();
  #buffer = Buffer.alloc(0);
  #lastRevision = -1;
  #closed = false;
  #authenticated = false;
  #snapshot: PortfolioSnapshot | null = null;
  #latestReasonCode: string | null = null;
  #socket: Socket;

  private constructor(readonly scope: PortfolioScope, socket: Socket, readonly token: string) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => this.close("pipe_closed"));
    socket.on("error", (error: NodeJS.ErrnoException) => this.close(`pipe_error:${error.code ?? "unknown"}`));
  }

  public static async connect(scope: PortfolioScope, pipeName: string, token: string): Promise<PortfolioStardewBridgeClient> {
    if (scope.topology !== PORTFOLIO_TOPOLOGY || !/^[A-Za-z0-9_-]{1,128}$/.test(pipeName) || !/^gamebuddy-stardew-portfolio[A-Za-z0-9_-]{0,96}$/.test(pipeName) || !/^[A-Za-z0-9_-]{16,256}$/.test(token)) throw new Error("invalid_portfolio_bridge_config");
    const socket = createConnection(`\\\\.\\pipe\\${pipeName}`);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const client = new PortfolioStardewBridgeClient(scope, socket, token);
    await client.hello();
    return client;
  }

  public get state(): PortfolioBridgeState { return { connected: !this.#closed && !this.#socket.destroyed, authenticated: this.#authenticated, snapshot: this.#snapshot, latestReasonCode: this.#latestReasonCode }; }

  public async observe(): Promise<PortfolioSnapshot> {
    if (!this.#authenticated) throw new Error("portfolio_bridge_not_authenticated");
    const response = await this.request("observe_request", {});
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "snapshot" || validatePortfolioSnapshot(response.payload) !== null) throw new Error("invalid_portfolio_snapshot");
    this.#snapshot = response.payload;
    return response.payload;
  }

  public onSnapshot(listener: (snapshot: PortfolioSnapshot) => void): () => void { this.#events.on("snapshot", listener); return () => this.#events.off("snapshot", listener); }
  public onClose(listener: (reasonCode: string) => void): () => void { this.#events.on("close", listener); return () => this.#events.off("close", listener); }
  public close(reasonCode = "local_close"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#authenticated = false;
    this.#snapshot = this.#snapshot?.state === "invalidated" ? this.#snapshot : null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`portfolio_bridge_closed:${reasonCode}`)); }
    this.#pending.clear();
    this.#socket.destroy();
    this.#events.emit("close", reasonCode);
  }

  private async hello(): Promise<void> {
    const response = await this.request("hello", { token: this.token });
    if (response.type === "error") throw new Error(`portfolio_bridge_rejected:${response.payload.reasonCode}`);
    if (response.type !== "hello_ack") throw new Error("unexpected_portfolio_hello_response");
    this.#authenticated = true;
  }

  private request(type: "hello" | "observe_request", payload: Record<string, unknown>): Promise<PortfolioMessage> {
    if (this.#closed || this.#socket.destroyed) return Promise.reject(new Error("portfolio_pipe_disconnected"));
    const correlationId = randomUUID();
    const message = newPortfolioEnvelope(type, this.scope, payload, correlationId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(correlationId); reject(new Error("portfolio_bridge_response_timeout")); }, 5_000);
      this.#pending.set(correlationId, { resolve, reject, timer });
      try {
        const json = serializePortfolioBounded(message);
        const payloadBytes = Buffer.from(json, "utf8");
        const header = Buffer.allocUnsafe(4);
        header.writeInt32LE(payloadBytes.byteLength, 0);
        this.#socket.write(Buffer.concat([header, payloadBytes]));
      } catch (error) {
        clearTimeout(timer); this.#pending.delete(correlationId); reject(error);
      }
    });
  }

  private receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readInt32LE(0);
      if (length <= 0 || length > PORTFOLIO_MAX_MESSAGE_BYTES) { this.close("portfolio_frame_length_invalid"); return; }
      if (this.#buffer.byteLength < length + 4) return;
      const json = this.#buffer.subarray(4, length + 4).toString("utf8");
      this.#buffer = this.#buffer.subarray(length + 4);
      let value: unknown;
      try { value = JSON.parse(json); } catch { this.close("portfolio_invalid_json"); return; }
      const message = value as PortfolioMessage;
      const fault = validatePortfolioMessage(message, this.scope);
      if (fault !== null || message.type === "hello" || message.type === "observe_request") { this.close(fault ?? "portfolio_unexpected_inbound_request"); return; }
      if (message.type === "snapshot") {
        if (message.payload.revision < this.#lastRevision) { this.close("portfolio_snapshot_revision_regressed"); return; }
        this.#lastRevision = message.payload.revision;
        this.#snapshot = message.payload;
        this.#events.emit("snapshot", message.payload);
        if (message.payload.state === "invalidated") {
          this.#latestReasonCode = message.payload.reasonCode;
          this.close(`native_invalidation:${message.payload.reasonCode}`);
          return;
        }
      } else if (message.type === "error") this.#latestReasonCode = message.payload.reasonCode;
      const pending = this.#pending.get(message.correlationId);
      if (pending !== undefined) { this.#pending.delete(message.correlationId); clearTimeout(pending.timer); pending.resolve(message); }
    }
  }
}
