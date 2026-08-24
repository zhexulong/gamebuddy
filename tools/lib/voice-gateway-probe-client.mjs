import { once } from "node:events";
import { createConnection } from "node:net";
import {
  createBoundedUtf8NdjsonDecoder,
  encodeVoiceGatewayMessage,
  isVoiceGatewayRequest,
  MAX_NDJSON_FRAME_BYTES,
  parseVoiceGatewayResponse,
} from "../../packages/voice-protocol/dist/index.js";

const LOOPBACK = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Minimal live-gate probe client. All wire framing and message validation is
 * owned by @gamebuddy/voice-protocol; gate runners only select requests and
 * inspect their already-validated responses.
 */
export class VoiceGatewayProbeClient {
  static async connect(port, token, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_voice_gateway_port");
    const client = new VoiceGatewayProbeClient(createConnection({ host: LOOPBACK, port }), timeoutMs);
    await client.open();
    const hello = await client.request({ type: "hello", token, protocolVersion: 1, requestId: "hello_01" });
    if (hello.type !== "hello_ack") throw new Error("voice_gateway_authentication_failed");
    return client;
  }

  constructor(socket, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.framer = createBoundedUtf8NdjsonDecoder({
      maxRecordBytes: MAX_NDJSON_FRAME_BYTES,
      maxBufferedBytes: MAX_NDJSON_FRAME_BYTES,
    });
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", () => this.fail(new Error("voice_gateway_socket_error")));
    socket.on("end", () => this.finish());
    socket.on("close", () => this.fail(new Error("voice_gateway_closed")));
  }

  async open() {
    await Promise.race([
      once(this.socket, "connect"),
      once(this.socket, "error").then(([error]) => Promise.reject(error)),
    ]);
  }

  request(message, timeoutMs = this.timeoutMs) {
    if (!isVoiceGatewayRequest(message)) throw new Error("invalid_voice_gateway_probe_request");
    if (this.socket.destroyed) return Promise.reject(new Error("voice_gateway_closed"));
    if (this.pending.has(message.requestId)) throw new Error("duplicate_voice_gateway_request_id");
    const frame = encodeVoiceGatewayMessage(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error("voice_gateway_timeout"));
      }, timeoutMs);
      this.pending.set(message.requestId, { resolve, reject, timer });
      this.socket.write(frame, (error) => {
        if (error === null || error === undefined) return;
        this.reject(message.requestId, error);
      });
    });
  }

  receive(chunk) {
    let frames;
    try {
      frames = this.framer.push(chunk);
    } catch {
      this.fail(new Error("invalid_voice_gateway_response"));
      return;
    }
    for (const frame of frames) {
      const response = parseVoiceGatewayResponse(frame);
      if (response === null || response.requestId === null || !this.pending.has(response.requestId)) {
        this.fail(new Error("invalid_voice_gateway_response"));
        return;
      }
      const pending = this.pending.get(response.requestId);
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  finish() {
    try {
      this.framer.finish();
    } catch {
      this.fail(new Error("invalid_voice_gateway_response"));
    }
  }

  reject(requestId, error) {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  fail(error) {
    if (!this.socket.destroyed) this.socket.destroy();
    for (const [requestId] of this.pending) this.reject(requestId, error);
  }

  close() {
    this.fail(new Error("voice_gateway_closed"));
  }
}
