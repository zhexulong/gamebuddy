import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import { type FinalVoiceInput, type VoiceExpression, type VoiceSpeechPort } from "./voice.js";

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

type GatewayEvent =
  | Readonly<{ type: "final_transcript"; sessionId: string; inputId: string; text: string; locale: string; providerId: string; modelRevision: string; timestampMs: number; actualFormat: Readonly<{ sampleRate: number; channels: number; encoding: "pcm_s16le" }> }>
  | Readonly<{ type: "capture_state" | "partial_transcript" | "asr_failure" | "speech_state"; [key: string]: unknown }>;
type Response = Readonly<{ type: "hello_ack" | "health" | "accepted" | "events" | "error"; requestId: string | null; protocolVersion?: number; events?: readonly GatewayEvent[]; next?: number; reasonCode?: string }>;
type Pending = Readonly<{ resolve: (response: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;

export type VoiceGatewayConnection = Readonly<{
  host?: "127.0.0.1" | "::1";
  port: number;
  token: string;
}>;

/**
 * Authenticated, localhost-only Host adapter for the independent Voice
 * Gateway. It has no access to PCM frames, provider credentials, or game
 * authority. Callers explicitly poll final events and route only validated
 * final transcripts into the normal player-input boundary.
 */
export class LocalVoiceGatewayClient implements VoiceSpeechPort {
  readonly #pending = new Map<string, Pending>();
  readonly #finalListeners = new Set<(input: FinalVoiceInput) => void>();
  #socket: Socket | undefined;
  #buffer = "";
  #connected = false;
  #eventCursor = 0;

  private constructor(private readonly connection: Required<VoiceGatewayConnection>) {}

  public static async connect(connection: VoiceGatewayConnection): Promise<LocalVoiceGatewayClient> {
    const host = connection.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") throw new Error("voice_gateway_loopback_required");
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535) throw new Error("invalid_voice_gateway_port");
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(connection.token)) throw new Error("invalid_voice_gateway_token");
    const client = new LocalVoiceGatewayClient({ ...connection, host });
    await client.open();
    await client.hello();
    return client;
  }

  public get connected(): boolean { return this.#connected; }

  public close(): void {
    this.#socket?.destroy();
    this.handleClose("voice_gateway_closed");
  }

  public onFinalTranscript(listener: (input: FinalVoiceInput) => void): () => void {
    this.#finalListeners.add(listener);
    return () => this.#finalListeners.delete(listener);
  }

  public async health(): Promise<void> {
    const response = await this.request("health", {});
    if (response.type !== "health" || response.protocolVersion !== PROTOCOL_VERSION) throw new Error("voice_gateway_unhealthy");
  }

  /** Polling is deliberate: Voice Gateway stays independent and retains no Host callback port. */
  public async pollEvents(): Promise<void> {
    const response = await this.request("events", { after: this.#eventCursor });
    const next = response.next;
    if (response.type !== "events" || !Array.isArray(response.events) || !Number.isSafeInteger(next) || typeof next !== "number" || next < this.#eventCursor) throw new Error("invalid_voice_gateway_events");
    for (const event of response.events) {
      const final = finalVoiceInput(event);
      if (final !== null) for (const listener of this.#finalListeners) listener(final);
    }
    this.#eventCursor = next;
  }

  public async enqueue(expression: VoiceExpression): Promise<void> {
    const response = await this.request("speech_enqueue", { job: {
      jobId: expression.expressionId,
      sessionId: expression.sessionId,
      epoch: expression.epoch,
      sourceEventId: expression.sourceEventId,
      text: expression.text,
      locale: expression.locale,
      voiceProfile: expression.voiceProfile,
      expiresAtMs: expression.expiresAtMs,
      interruptible: true,
    } });
    if (response.type !== "accepted") throw new Error(response.reasonCode ?? "voice_speech_rejected");
  }

  public async stopAll(reasonCode = "player_stop_all"): Promise<void> {
    const response = await this.request("stop_all", { reasonCode });
    if (response.type !== "accepted") throw new Error(response.reasonCode ?? "voice_stop_rejected");
  }

  private async open(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const socket = createConnection({ host: this.connection.host, port: this.connection.port });
      const fail = (error: Error) => { socket.destroy(); reject(error); };
      socket.once("error", fail);
      socket.once("connect", () => {
        socket.off("error", fail);
        this.#socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.receive(chunk));
        socket.on("error", () => this.handleClose("voice_gateway_socket_error"));
        socket.on("close", () => this.handleClose("voice_gateway_closed"));
        this.#connected = true;
        resolvePromise();
      });
    });
  }

  private async hello(): Promise<void> {
    const response = await this.request("hello", { token: this.connection.token, protocolVersion: PROTOCOL_VERSION });
    if (response.type !== "hello_ack" || response.protocolVersion !== PROTOCOL_VERSION) throw new Error(response.reasonCode ?? "voice_gateway_authentication_failed");
  }

  private request(type: string, payload: Record<string, unknown>): Promise<Response> {
    if (!this.#connected || this.#socket === undefined || this.#socket.destroyed) return Promise.reject(new Error("voice_gateway_disconnected"));
    const requestId = randomUUID();
    const line = JSON.stringify({ type, requestId, ...payload });
    return new Promise<Response>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("voice_gateway_response_timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve: resolvePromise, reject, timer });
      this.#socket!.write(`${line}\n`, (error) => {
        if (error != null) {
          clearTimeout(timer);
          this.#pending.delete(requestId);
          reject(error);
        }
      });
    });
  }

  private receive(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_BUFFERED_BYTES) {
      this.close();
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      let response: Response;
      try { response = JSON.parse(line) as Response; } catch { this.close(); return; }
      if (!validResponse(response)) { this.close(); return; }
      if (response.requestId === null) continue;
      const pending = this.#pending.get(response.requestId);
      if (pending === undefined) continue;
      this.#pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  private handleClose(reasonCode: string): void {
    if (!this.#connected && this.#pending.size === 0) return;
    this.#connected = false;
    this.#socket = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reasonCode));
    }
    this.#pending.clear();
  }
}

function validResponse(value: unknown): value is Response {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string"
    && (value as { type?: unknown }).type !== "hello"
    && ((value as { requestId?: unknown }).requestId === null || typeof (value as { requestId?: unknown }).requestId === "string");
}

function finalVoiceInput(event: GatewayEvent): FinalVoiceInput | null {
  if (event.type !== "final_transcript") return null;
  const format = event.actualFormat;
  if (!isOpaque(event.sessionId) || !isOpaque(event.inputId) || typeof event.text !== "string" || event.text.length === 0 || event.text.length > 4_000
    || typeof event.locale !== "string" || event.locale.length === 0 || event.locale.length > 32 || !isOpaque(event.providerId) || !isOpaque(event.modelRevision)
    || !Number.isFinite(event.timestampMs) || format.sampleRate !== 16_000 || format.channels !== 1 || format.encoding !== "pcm_s16le") return null;
  return Object.freeze({ ...event, actualFormat: Object.freeze({ ...format }) });
}

function isOpaque(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
