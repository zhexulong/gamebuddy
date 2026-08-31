import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

import { MAX_MESSAGE_BYTES, serializeBounded } from "./protocol.js";

export type NamedPipeFrameStage =
  | "pipe_bytes_received"
  | "pipe_frame_header_accepted"
  | "pipe_frame_payload_complete"
  | "pipe_frame_dispatched"
  | "pipe_write_completed"
  | "pipe_write_failed";

/** Windows local named-pipe framing shared with LocalPipeBridge.cs. */
export class NamedPipeTransport {
  readonly #events = new EventEmitter();
  #socket: Socket | undefined;
  #buffer = Buffer.alloc(0);
  #closed = false;

  private constructor() {}

  public static async connect(pipeName: string, deadlineMs?: number): Promise<NamedPipeTransport> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(pipeName)) throw new Error("invalid_pipe_name");
    if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now()))
      throw new Error("bridge_connect_deadline_exceeded");
    const transport = new NamedPipeTransport();
    const path = `\\\\.\\pipe\\${pipeName}`;
    const socket = createConnection(path);
    transport.#socket = socket;
    socket.on("data", (chunk: Buffer) => transport.receive(chunk));
    socket.on("close", () => transport.close("pipe_closed"));
    socket.on("error", (error: NodeJS.ErrnoException) => transport.close(`pipe_error:${error.code ?? "unknown"}`));
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        if (error === undefined) resolvePromise();
        else reject(error);
      };
      const onConnect = (): void => finish();
      const onError = (error: Error): void => finish(error);
      const timer = deadlineMs === undefined
        ? undefined
        : setTimeout(() => {
          transport.close("bridge_connect_deadline_exceeded");
          finish(new Error("bridge_connect_deadline_exceeded"));
        }, deadlineMs - Date.now());
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    return transport;
  }

  public get connected(): boolean {
    return !this.#closed && this.#socket?.destroyed === false;
  }

  /** Content-free signal that the underlying socket delivered an inbound chunk. */
  public onData(listener: () => void): () => void {
    this.#events.on("data", listener);
    return () => this.#events.off("data", listener);
  }

  public onMessage(listener: (json: string) => void): () => void {
    this.#events.on("message", listener);
    return () => this.#events.off("message", listener);
  }

  /** Content-free framing stages; never includes pipe names, lengths, or payload data. */
  public onFrameStage(listener: (stage: NamedPipeFrameStage) => void): () => void {
    this.#events.on("frameStage", listener);
    return () => this.#events.off("frameStage", listener);
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
    try {
      this.#socket.write(Buffer.concat([header, payload]), (error) => {
        this.#events.emit("frameStage", error == null ? "pipe_write_completed" : "pipe_write_failed");
      });
    } catch (error) {
      this.#events.emit("frameStage", "pipe_write_failed");
      throw error;
    }
  }

  public close(reasonCode = "local_close"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket?.destroy();
    this.#events.emit("close", reasonCode);
  }

  private receive(chunk: Buffer): void {
    this.#events.emit("data");
    this.#events.emit("frameStage", "pipe_bytes_received");
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.byteLength >= 4) {
      const length = this.#buffer.readInt32LE(0);
      if (length <= 0 || length > MAX_MESSAGE_BYTES) {
        this.close("invalid_frame_length");
        return;
      }
      this.#events.emit("frameStage", "pipe_frame_header_accepted");
      if (this.#buffer.byteLength < 4 + length) return;
      this.#events.emit("frameStage", "pipe_frame_payload_complete");
      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      this.#events.emit("message", payload.toString("utf8"));
      this.#events.emit("frameStage", "pipe_frame_dispatched");
    }
  }
}
