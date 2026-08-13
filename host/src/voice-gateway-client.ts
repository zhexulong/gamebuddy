import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import {
  type FinalVoiceInput,
  type VoiceAudioEpochAdmission,
  type VoiceAudioEpochBinding,
  type VoiceEnqueueAdmission,
  type VoiceExpression,
  type VoiceSpeechPort,
} from "./voice.js";

const PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

type GatewayEvent =
  | Readonly<{
      type: "final_transcript";
      sessionId: string;
      inputId: string;
      text: string;
      locale: string;
      providerId: string;
      modelRevision: string;
      timestampMs: number;
      actualFormat: Readonly<{ sampleRate: number; channels: number; encoding: "pcm_s16le" }>;
    }>
  | Readonly<{ type: "capture_state" | "partial_transcript" | "asr_failure" | "speech_state"; [key: string]: unknown }>;
type Response = Readonly<
  | { type: "hello_ack"; requestId: string; protocolVersion?: number; reasonCode?: string }
  | {
      type: "health";
      requestId: string;
      protocolVersion?: number;
      status?: "ready" | "unavailable";
      capabilities?: Readonly<{
        providerId: string;
        modelRevision: string;
        perUtteranceDirection: boolean;
        ready: boolean;
        epoch: number;
      }>;
      reasonCode?: string;
    }
  | { type: "accepted"; requestId: string; value?: string | boolean; reasonCode?: string }
  | { type: "events"; requestId: string; events?: readonly GatewayEvent[]; next?: number; reasonCode?: string }
  | { type: "error"; requestId: string | null; reasonCode?: string }
>;
type Pending = Readonly<{
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

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
  #pollPromise: Promise<void> | undefined;
  readonly #deliveredInputs = new Set<string>();
  #eventSessionId: string | undefined;
  #sessionBootstrapped = false;
  readonly #audioEpochBindings = new WeakSet<VoiceAudioEpochBinding>();
  readonly #audioEpochGenerations = new WeakMap<VoiceAudioEpochBinding, number>();
  #audioAdmissionGeneration = 0;

  private constructor(private readonly connection: Required<VoiceGatewayConnection>) {}

  public static async connect(connection: VoiceGatewayConnection): Promise<LocalVoiceGatewayClient> {
    const host = connection.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "::1") throw new Error("voice_gateway_loopback_required");
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535)
      throw new Error("invalid_voice_gateway_port");
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(connection.token)) throw new Error("invalid_voice_gateway_token");
    const client = new LocalVoiceGatewayClient({ ...connection, host });
    await client.open();
    await client.hello();
    return client;
  }

  public get connected(): boolean {
    return this.#connected;
  }
  #capabilities:
    | Readonly<{
        providerId: string;
        modelRevision: string;
        perUtteranceDirection: boolean;
        ready: boolean;
        epoch: number;
      }>
    | undefined;
  public get capabilities() {
    return this.#capabilities;
  }
  public get epoch(): number {
    return this.#capabilities?.epoch ?? 0;
  }

  /**
   * Produces opaque bindings for the gateway-authenticated ready capability
   * epoch. This is deliberately client-owned: no caller can construct a
   * numeric epoch binding that the enqueue fence will accept.
   */
  public createAudioEpochAdmission(): VoiceAudioEpochAdmission {
    return Object.freeze({
      capture: () => this.captureAudioEpochBinding(),
      assertCurrent: (binding: VoiceAudioEpochBinding) => this.assertCurrentAudioEpochBinding(binding),
      epoch: (binding: VoiceAudioEpochBinding) => this.audioEpoch(binding),
    });
  }

  public close(): void {
    this.#socket?.destroy();
    this.handleClose("voice_gateway_closed");
  }

  public onFinalTranscript(listener: (input: FinalVoiceInput) => void): () => void {
    this.#finalListeners.add(listener);
    return () => this.#finalListeners.delete(listener);
  }

  public async health(voiceProfile?: string): Promise<
    Readonly<{
      providerId: string;
      modelRevision: string;
      perUtteranceDirection: boolean;
      ready: boolean;
      epoch: number;
    }>
  > {
    // A health refresh is a revalidation boundary. Revoke first so a timeout,
    // protocol failure, or unavailable result cannot retain prior admission.
    const revalidationGeneration = this.invalidateAudioAdmission();
    const response = await this.request("health", voiceProfile === undefined ? {} : { voiceProfile });
    if (
      response.type !== "health" ||
      response.protocolVersion !== PROTOCOL_VERSION ||
      response.capabilities === undefined ||
      !isCapabilityProfile(response.capabilities)
    )
      throw new Error("voice_gateway_unhealthy");
    const capabilities = Object.freeze({ ...response.capabilities });
    if (!capabilities.ready || response.status !== "ready") throw new Error("voice_gateway_unavailable");
    // A newer revalidation owns admission from its synchronous revocation.
    // A stale success must not recreate a ready enqueue route.
    if (revalidationGeneration !== this.#audioAdmissionGeneration)
      throw new Error("voice_gateway_health_superseded");
    this.#capabilities = capabilities;
    return capabilities;
  }

  /**
   * Establish a fresh cursor for a reusable Host-owned session binding. The
   * gateway protocol has no separate cursor query, so an after=MAX_SAFE_INTEGER
   * events request is used as a bounded freshness probe: the gateway returns no
   * events and its current next cursor. Only events committed after that probe
   * can be delivered by subsequent polling.
   */
  public async bootstrapSession(sessionId: string): Promise<void> {
    if (!isOpaque(sessionId) || this.#pollPromise !== undefined) throw new Error("invalid_voice_session");
    this.#eventSessionId = sessionId;
    this.#eventCursor = 0;
    this.#deliveredInputs.clear();
    this.#sessionBootstrapped = false;
    const response = await this.request("events", {
      after: Number.MAX_SAFE_INTEGER,
      sessionId,
    });
    if (response.type !== "events" || !Array.isArray(response.events) || response.events.length !== 0)
      throw new Error("invalid_voice_gateway_session_bootstrap");
    const next = response.type === "events" ? response.next : undefined;
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 0)
      throw new Error("invalid_voice_gateway_session_bootstrap");
    this.#eventCursor = next as number;
    this.#sessionBootstrapped = true;
  }

  /** Polling is deliberate: Voice Gateway stays independent and retains no Host callback port. */
  public pollEvents(sessionId = this.#eventSessionId): Promise<void> {
    if (!this.#sessionBootstrapped || !isOpaque(sessionId) || sessionId !== this.#eventSessionId)
      return Promise.reject(new Error("voice_session_required"));
    if (this.#pollPromise !== undefined) return this.#pollPromise;
    this.#pollPromise = this.pollEventsOnce(sessionId).finally(() => {
      this.#pollPromise = undefined;
    });
    return this.#pollPromise;
  }

  private async pollEventsOnce(sessionId: string): Promise<void> {
    const response = await this.request("events", { after: this.#eventCursor, sessionId });
    if (response.type === "error" && response.reasonCode === "voice_event_cursor_expired")
      throw new Error("voice_event_cursor_expired");
    if (
      response.type !== "events" ||
      !Array.isArray(response.events) ||
      !Number.isSafeInteger(response.next) ||
      (response.next as number) < this.#eventCursor
    )
      throw new Error("invalid_voice_gateway_events");
    const next = response.next as number;
    for (const event of response.events) {
      const final = finalVoiceInput(event);
      if (final !== null && final.sessionId === sessionId && !this.#deliveredInputs.has(final.inputId)) {
        this.#deliveredInputs.add(final.inputId);
        if (this.#deliveredInputs.size > 4_096)
          this.#deliveredInputs.delete(this.#deliveredInputs.values().next().value!);
        for (const listener of this.#finalListeners) listener(final);
      }
    }
    this.#eventCursor = next;
  }

  public async enqueue(expression: VoiceExpression, admission: VoiceEnqueueAdmission): Promise<void> {
    // Reading an expression can invoke a caller-controlled getter or Proxy.
    // Materialize its primitive protocol payload before the admission fence so
    // no caller-controlled value can reenter between the final assertions and
    // the socket write.
    const job = snapshotSpeechEnqueueJob(expression);
    // This is the final synchronous fence before request construction and the
    // socket write below. Do not move either assertion before asynchronous work.
    admission.assertHostCurrent(admission.hostBinding);
    admission.assertAudioCurrent(admission.audioBinding);
    // The Host assertion is a distinct final fence, but it cannot establish
    // this client's gateway epoch authority. Validate the opaque binding in
    // the concrete client as the last synchronous step before the write.
    this.assertCurrentAudioEpochBinding(admission.audioBinding);
    const response = await this.request("speech_enqueue", { job });
    if (response.type !== "accepted" || response.value !== true)
      throw new Error(response.reasonCode ?? "voice_speech_rejected");
  }

  public async stopAll(reasonCode = "player_stop_all"): Promise<void> {
    const response = await this.request("stop_all", { reasonCode });
    if (response.type !== "accepted" || response.value !== true)
      throw new Error(response.reasonCode ?? "voice_stop_rejected");
    // Stop acceptance changes the remote mixer state. Revoke synchronously,
    // before the asynchronous authenticated revalidation below.
    const revalidate = this.#capabilities !== undefined;
    this.invalidateAudioAdmission();
    if (revalidate) await this.health();
  }

  private invalidateAudioAdmission(): number {
    this.#capabilities = undefined;
    this.#audioAdmissionGeneration++;
    return this.#audioAdmissionGeneration;
  }

  private captureAudioEpochBinding(): VoiceAudioEpochBinding {
    const capabilities = this.currentReadyCapabilities();
    const binding = Object.freeze({});
    this.#audioEpochBindings.add(binding);
    this.#audioEpochGenerations.set(binding, this.#audioAdmissionGeneration);
    return binding;
  }

  private assertCurrentAudioEpochBinding(binding: VoiceAudioEpochBinding): void {
    const generation = this.bindingGeneration(binding);
    if (generation !== this.#audioAdmissionGeneration) throw new Error("voice_audio_epoch_stale");
    this.currentReadyCapabilities();
  }

  private audioEpoch(binding: VoiceAudioEpochBinding): number {
    this.assertCurrentAudioEpochBinding(binding);
    return this.currentReadyCapabilities().epoch;
  }

  private bindingGeneration(binding: VoiceAudioEpochBinding): number {
    if (typeof binding !== "object" || binding === null || !this.#audioEpochBindings.has(binding))
      throw new Error("invalid_voice_audio_epoch_binding");
    const generation = this.#audioEpochGenerations.get(binding);
    if (generation === undefined) throw new Error("invalid_voice_audio_epoch_binding");
    return generation;
  }

  private currentReadyCapabilities(): Readonly<{
    providerId: string;
    modelRevision: string;
    perUtteranceDirection: boolean;
    ready: boolean;
    epoch: number;
  }> {
    if (!this.#connected) throw new Error("voice_gateway_disconnected");
    if (this.#capabilities === undefined || !this.#capabilities.ready) throw new Error("voice_gateway_unavailable");
    return this.#capabilities;
  }

  private async open(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const socket = createConnection({ host: this.connection.host, port: this.connection.port });
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
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
    if (response.type !== "hello_ack" || response.protocolVersion !== PROTOCOL_VERSION)
      throw new Error(response.reasonCode ?? "voice_gateway_authentication_failed");
  }

  private request(type: string, payload: Record<string, unknown>): Promise<Response> {
    if (!this.#connected || this.#socket === undefined || this.#socket.destroyed)
      return Promise.reject(new Error("voice_gateway_disconnected"));
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
      try {
        response = JSON.parse(line) as Response;
      } catch {
        this.close();
        return;
      }
      if (!validResponse(response)) {
        this.close();
        return;
      }
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

function snapshotSpeechEnqueueJob(expression: VoiceExpression): Readonly<{
  jobId: string;
  sessionId: string;
  epoch: number;
  sourceEventId: string;
  text: string;
  locale: string;
  voiceProfile: string;
  expiresAtMs: number;
  interruptible: true;
  direction?: string;
}> {
  // Explicit property reads make the caller-controlled boundary visible and
  // ensure the request/JSON serialization receives only this plain object.
  const jobId = expression.expressionId;
  const sessionId = expression.sessionId;
  const epoch = expression.epoch;
  const sourceEventId = expression.sourceEventId;
  const text = expression.text;
  const locale = expression.locale;
  const voiceProfile = expression.voiceProfile;
  const expiresAtMs = expression.expiresAtMs;
  const direction = expression.direction;
  return Object.freeze({
    jobId,
    sessionId,
    epoch,
    sourceEventId,
    text,
    locale,
    voiceProfile,
    expiresAtMs,
    interruptible: true,
    ...(direction === undefined ? {} : { direction }),
  });
}

function isCapabilityProfile(value: unknown): value is {
  providerId: string;
  modelRevision: string;
  perUtteranceDirection: boolean;
  ready: boolean;
  epoch: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isOpaque((value as { providerId?: unknown }).providerId) &&
    isOpaque((value as { modelRevision?: unknown }).modelRevision) &&
    typeof (value as { perUtteranceDirection?: unknown }).perUtteranceDirection === "boolean" &&
    typeof (value as { ready?: unknown }).ready === "boolean" &&
    Number.isSafeInteger((value as { epoch?: unknown }).epoch) &&
    (value as { epoch: number }).epoch >= 0
  );
}

function validResponse(value: unknown): value is Response {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type?: unknown }).type !== "hello" &&
    ((value as { requestId?: unknown }).requestId === null ||
      typeof (value as { requestId?: unknown }).requestId === "string")
  );
}

function finalVoiceInput(event: GatewayEvent): FinalVoiceInput | null {
  if (event.type !== "final_transcript") return null;
  const format = event.actualFormat;
  if (
    !isOpaque(event.sessionId) ||
    !isOpaque(event.inputId) ||
    typeof event.text !== "string" ||
    event.text.length === 0 ||
    event.text.length > 4_000 ||
    typeof event.locale !== "string" ||
    event.locale.length === 0 ||
    event.locale.length > 32 ||
    !isOpaque(event.providerId) ||
    !isOpaque(event.modelRevision) ||
    !Number.isFinite(event.timestampMs) ||
    format.sampleRate !== 16_000 ||
    format.channels !== 1 ||
    format.encoding !== "pcm_s16le"
  )
    return null;
  return Object.freeze({ ...event, actualFormat: Object.freeze({ ...format }) });
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}
