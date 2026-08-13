import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

import { MAX_MESSAGE_BYTES, serializeBounded } from "./protocol.js";

/** Windows local named-pipe framing shared with LocalPipeBridge.cs. */
export class NamedPipeTransport {
  readonly #events = new EventEmitter();
  #socket: Socket | undefined;
  #buffer = Buffer.alloc(0);
  #closed = false;

  private constructor() {}

  public static async connect(pipeName: string): Promise<NamedPipeTransport> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(pipeName)) throw new Error("invalid_pipe_name");
    const transport = new NamedPipeTransport();
    const path = `\\\\.\\pipe\\${pipeName}`;
    const socket = createConnection(path);
    transport.#socket = socket;
    socket.on("data", (chunk: Buffer) => transport.receive(chunk));
    socket.on("close", () => transport.close("pipe_closed"));
    socket.on("error", (error: NodeJS.ErrnoException) => transport.close(`pipe_error:${error.code ?? "unknown"}`));
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("connect", resolvePromise);
      socket.once("error", reject);
    });
    return transport;
  }

  public get connected(): boolean {
    return !this.#closed && this.#socket?.destroyed === false;
  }

  public onMessage(listener: (json: string) => void): () => void {
    this.#events.on("message", listener);
    return () => this.#events.off("message", listener);
  }

  public onClose(listener: (reasonCode: string) => void): () => void {
    this.#events.on("close", listener);
    return () => this.#events.off("close", listener);
  }

  public send(value: unknown): void {
    if (!this.connected || this.#socket === undefined) throw new Error("pipe_disconnected");
    const json = serializeBounded(value);
    const payload = Buffer.from(json, "utf8");
    if (payload.byteLength > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
    const header = Buffer.allocUnsafe(4);
    header.writeInt32LE(payload.byteLength, 0);
    this.#socket.write(Buffer.concat([header, payload]));
  }

  public close(reasonCode = "local_close"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.destroy();
    this.#events.emit("close", reasonCode);
  }

  private receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readInt32LE(0);
      if (length <= 0 || length > MAX_MESSAGE_BYTES) {
        this.close("invalid_frame_length");
        return;
      }
      if (this.#buffer.byteLength < 4 + length) return;
      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      this.#events.emit("message", payload.toString("utf8"));
    }
  }
}
