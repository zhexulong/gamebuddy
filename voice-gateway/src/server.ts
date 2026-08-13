import { createServer, type Server, type Socket } from "node:net";
import {
  type AsrProvider,
  type GatewayEvent,
  MAX_CAPTURE_BYTES,
  type Mixer,
  type PcmFormat,
  REQUIRED_PCM_FORMAT,
  type SpeechJob,
  type TtsProvider,
  VOICE_GATEWAY_PROTOCOL_VERSION,
  VoiceGatewayCore,
} from "./gateway.js";

/** Hardware PTT capture stays wholly inside Gateway; Host never receives raw PCM. */
export interface PttCaptureDevice {
  start(): Promise<void>;
  stop(): Promise<Uint8Array>;
  cancel(): Promise<void>;
}
export type VoiceGatewayServerOptions = Readonly<{
  /** Loopback only; other bind addresses are rejected. */ host?: "127.0.0.1" | "::1";
  port: number;
  token: string;
  core?: VoiceGatewayCore;
  asr?: AsrProvider;
  tts?: TtsProvider;
  mixer?: Mixer;
  /** Test-only local capture injection seam; production capture never accepts Host PCM. */
  capture?: PttCaptureDevice;
}>;
export class VoiceGatewayCleanupError extends Error {
  public readonly unresolved: readonly string[];
  public constructor(unresolved: readonly string[]) {
    super("voice_gateway_cleanup_timeout");
    this.name = "VoiceGatewayCleanupError";
    this.unresolved = Object.freeze([...unresolved]);
  }
}
export type StartedVoiceGateway = Readonly<{
  port: number;
  capabilities: VoiceGatewayCore["capabilities"];
  close(): Promise<void>;
}>;
type Request =
  | { type: "hello"; token: string; protocolVersion: number; requestId: string }
  | { type: "health"; requestId: string; voiceProfile?: string }
  | { type: "ptt_start"; requestId: string; sessionId: string; inputId?: string; locale?: string }
  | { type: "ptt_frame"; requestId: string; pcm16Base64: string; format?: PcmFormat }
  | { type: "ptt_stop"; requestId: string; reasonCode?: string }
  | { type: "capture_cancel"; requestId: string; reasonCode?: string }
  | { type: "speech_enqueue"; requestId: string; job: SpeechJob }
  | { type: "speech_cancel"; requestId: string; jobId: string; reasonCode?: string }
  | { type: "stop_all"; requestId: string; reasonCode?: string }
  | { type: "events"; requestId: string; after?: number; sessionId: string };
type Response =
  | { type: "hello_ack"; requestId: string; protocolVersion: number }
  | {
      type: "health";
      requestId: string;
      status: "ready" | "unavailable";
      protocolVersion: number;
      capabilities: {
        providerId: string;
        modelRevision: string;
        perUtteranceDirection: boolean;
        ready: boolean;
        epoch: number;
      };
    }
  | { type: "accepted"; requestId: string; value?: string | boolean }
  | { type: "events"; requestId: string; events: readonly GatewayEvent[]; next: number }
  | { type: "error"; requestId: string | null; reasonCode: string };
const fakeAsr: AsrProvider = {
  providerId: "fake-asr",
  modelRevision: "phase0-fake-v1",
  async transcribe(_audio, _locale, signal) {
    if (signal.aborted) throw new Error("aborted");
    return "";
  },
};
const fakeTts: TtsProvider = {
  providerId: "fake-tts",
  modelRevision: "phase0-fake-v1",
  ready: false,
  async *synthesize(_job: SpeechJob, signal) {
    if (!signal.aborted) yield new Uint8Array([0, 0]);
  },
};
const silentMixer: Mixer = { ready: false, play() {}, stop() {} };
const CAPTURE_CLEANUP_TIMEOUT_MS = 250;
/** Versioned localhost-only authenticated control/media gateway. Raw frames are transient and never persisted. */
export async function startVoiceGateway(options: VoiceGatewayServerOptions): Promise<StartedVoiceGateway> {
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(options.token)) throw new Error("invalid_voice_gateway_token");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("voice_gateway_loopback_required");
  if (
    options.core !== undefined &&
    (options.asr !== undefined || options.tts !== undefined || options.mixer !== undefined)
  )
    throw new Error("voice_gateway_core_adapter_conflict");
  const core =
    options.core ?? new VoiceGatewayCore(options.asr ?? fakeAsr, options.tts ?? fakeTts, options.mixer ?? silentMixer);
  const capture = options.capture;
  const captureCoordinator = new CaptureCoordinator(capture, core);
  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // A peer may reset a persistent connection while a response is queued.
    // Always consume that socket error locally; one bad peer must not tear down
    // the gateway process or leave an unhandled EventEmitter exception.
    socket.on("error", () => socket.destroy());
    handleSocket(socket, options.token, core, captureCoordinator);
  });
  await new Promise<void>((resolvePromise, reject) =>
    server.once("error", reject).listen(options.port, host, resolvePromise),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("voice_gateway_address_unavailable");
  return Object.freeze({
    port: address.port,
    capabilities: core.capabilities,
    close() {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = (async () => {
        // Gateway closure is a voice STOP_ALL: immediately invalidate every
        // capture/speech epoch before evicting persistent Host sockets.
        core.stopAll("gateway_shutdown");
        captureCoordinator.invalidate("gateway_shutdown");
        // Listener and peer sockets are closed first. Native cleanup is bounded
        // independently, so a wedged driver/provider cannot keep close() open.
        for (const socket of sockets) socket.destroy();
        const listenerPromise = closeServer(server);
        const cleanupPromise = captureCoordinator.finishCancel("gateway_shutdown");
        const [listenerResult, cleanupResult] = await Promise.allSettled([listenerPromise, cleanupPromise]);
        if (listenerResult.status === "rejected") throw listenerResult.reason;
        if (cleanupResult.status === "rejected" && cleanupResult.reason instanceof VoiceGatewayCleanupError)
          throw cleanupResult.reason;
      })();
      return closePromise;
    },
  });
}
function handleSocket(
  socket: Socket,
  token: string,
  core: VoiceGatewayCore,
  captureCoordinator: CaptureCoordinator,
): void {
  let authenticated = false;
  let buffered = "";
  let processing: Promise<void> = Promise.resolve();
  let requestSequence = 0;
  let cancellationFence = 0;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    if (buffered.length > 16_384) {
      socket.destroy();
      return;
    }
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const parsed = parseRequest(line);
      if (parsed === null) {
        send(socket, { type: "error", requestId: null, reasonCode: "malformed_request" });
        continue;
      }
      // STOP/CANCEL must bypass a slow ASR/TTS request. Other media commands
      // remain ordered so frames cannot race capture start/stop.
      const sequence = ++requestSequence;
      // Authentication is a protocol admission property, not a queued work
      // item. Once a valid hello is parsed, cancellation in the same packet (or
      // on another peer) must be able to invalidate work already queued behind
      // that hello; waiting for the hello response would deadlock a gated
      // capture start. Invalid hellos never set this flag.
      if (
        parsed.type === "hello" &&
        parsed.protocolVersion === VOICE_GATEWAY_PROTOCOL_VERSION &&
        parsed.token === token
      ) {
        authenticated = true;
      }
      const cancellable =
        parsed.type === "stop_all" || parsed.type === "speech_cancel" || parsed.type === "capture_cancel";
      if (cancellable) cancellationFence = sequence - 1;
      const preCancelled = cancellable && authenticated;
      if (preCancelled) {
        if (parsed.type === "stop_all") {
          core.stopAll(parsed.reasonCode);
          captureCoordinator.invalidate(parsed.reasonCode);
        } else if (parsed.type === "capture_cancel") {
          captureCoordinator.invalidate(parsed.reasonCode);
        } else {
          core.cancelSpeech(parsed.jobId, parsed.reasonCode);
        }
      }
      const admittedEpoch = core.epoch;
      const admittedCaptureGeneration = captureCoordinator.generation;
      const dispatchNow = () =>
        dispatch(
          socket,
          parsed,
          token,
          core,
          captureCoordinator,
          admittedEpoch,
          admittedCaptureGeneration,
          sequence,
          preCancelled,
          () => sequence <= cancellationFence,
          () => authenticated,
          () => {
            authenticated = true;
          },
        );
      // Every request is serialized on its socket. Cancellation is still
      // pre-applied above so another socket cannot wait behind this queue.
      processing = processing.then(dispatchNow).catch(() => {
        if (!socket.destroyed)
          send(socket, { type: "error", requestId: parsed.requestId, reasonCode: "gateway_request_failed" });
      });
    }
  });
}
async function dispatch(
  socket: Socket,
  request: Request,
  token: string,
  core: VoiceGatewayCore,
  captureCoordinator: CaptureCoordinator,
  admittedEpoch: number,
  admittedCaptureGeneration: number,
  sequence: number,
  preCancelled: boolean,
  isInvalidated: () => boolean,
  isAuthenticated: () => boolean,
  authenticate: () => void,
): Promise<void> {
  if (request.type === "hello") {
    if (request.protocolVersion !== VOICE_GATEWAY_PROTOCOL_VERSION || request.token !== token) {
      send(socket, { type: "error", requestId: request.requestId, reasonCode: "authentication_failed" });
      socket.end();
      return;
    }
    authenticate();
    send(socket, { type: "hello_ack", requestId: request.requestId, protocolVersion: VOICE_GATEWAY_PROTOCOL_VERSION });
    return;
  }
  if (!isAuthenticated()) {
    send(socket, { type: "error", requestId: request.requestId, reasonCode: "unauthenticated" });
    return;
  }
  try {
    switch (request.type) {
      case "health": {
        const capabilities = core.capabilities;
        const profileReady = request.voiceProfile === undefined || core.supportsVoiceProfile(request.voiceProfile);
        const effective = profileReady ? capabilities : { ...capabilities, ready: false };
        send(socket, {
          type: "health",
          requestId: request.requestId,
          status: effective.ready ? "ready" : "unavailable",
          protocolVersion: VOICE_GATEWAY_PROTOCOL_VERSION,
          capabilities: effective,
        });
        return;
      }
      case "ptt_start": {
        if (!captureCoordinator.hasDevice) throw new Error("capture_device_unavailable");
        if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
          throw new Error("capture_cancelled");
        const inputId = await captureCoordinator.start(() =>
          core.startPtt(request.sessionId, request.inputId, request.locale),
        );
        send(socket, { type: "accepted", requestId: request.requestId, value: inputId });
        return;
      }
      case "ptt_frame":
        if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
          throw new Error("capture_cancelled");
        // Raw PCM is deliberately not a production gateway input. The local
        // capture adapter owns PCM acquisition; tests exercise VoiceGatewayCore
        // directly when they need deterministic frames.
        throw new Error("external_pcm_not_allowed");
      case "ptt_stop": {
        if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
          throw new Error("capture_cancelled");
        try {
          const pcm16 = await captureCoordinator.stopDevice();
          if (pcm16 !== undefined) core.pushPcm(pcm16, REQUIRED_PCM_FORMAT);
          if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
            throw new Error("capture_cancelled");
          const text = await core.stopPtt(request.reasonCode);
          // stopPtt may remain in ASR while a cross-socket STOP/CANCEL aborts
          // the capture. Never acknowledge the stale request as accepted after
          // that invalidation, even when the provider resolves with null.
          if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
            throw new Error("capture_cancelled");
          send(socket, { type: "accepted", requestId: request.requestId, value: text ?? "" });
        } catch (error) {
          core.cancelCapture("capture_device_failed");
          throw error;
        }
        return;
      }
      case "capture_cancel": {
        if (!preCancelled) captureCoordinator.invalidate(request.reasonCode);
        await captureCoordinator.finishCancel(request.reasonCode);
        send(socket, { type: "accepted", requestId: request.requestId, value: true });
        return;
      }
      case "speech_enqueue": {
        // The epoch is captured when the request is admitted, rather than
        // trusting the caller-provided job epoch. A STOP_ALL on another socket
        // must invalidate work that was already admitted but is still queued
        // behind a slow request on this socket.
        if (isInvalidated() || core.epoch !== admittedEpoch) throw new Error("speech_cancelled");
        const accepted = core.queueSpeech(request.job);
        send(
          socket,
          accepted
            ? { type: "accepted", requestId: request.requestId, value: true }
            : { type: "error", requestId: request.requestId, reasonCode: latestSpeechFailure(core, request.job.jobId) },
        );
        if (accepted) void core.drain();
        return;
      }
      case "speech_cancel":
        if (!preCancelled) core.cancelSpeech(request.jobId, request.reasonCode);
        send(socket, { type: "accepted", requestId: request.requestId, value: true });
        return;
      case "stop_all":
        if (!preCancelled) {
          core.stopAll(request.reasonCode);
          captureCoordinator.invalidate(request.reasonCode);
        }
        await captureCoordinator.finishCancel(request.reasonCode);
        send(socket, { type: "accepted", requestId: request.requestId, value: true });
        return;
      case "events": {
        const result = core.eventsAfter(request.after ?? 0, request.sessionId);
        if (result.expired) {
          send(socket, { type: "error", requestId: request.requestId, reasonCode: "voice_event_cursor_expired" });
          return;
        }
        send(socket, { type: "events", requestId: request.requestId, events: result.events, next: result.next });
        return;
      }
    }
  } catch (error) {
    send(socket, {
      type: "error",
      requestId: request.requestId,
      reasonCode: error instanceof Error ? safeReason(error.message) : "gateway_request_failed",
    });
  }
}
class CaptureCoordinator {
  #tail: Promise<void> = Promise.resolve();
  #generation = 0;
  #invalidated = false;
  #cancelPromise: Promise<void> | undefined;
  #cancelGeneration = -1;
  #nativeCancelPromise: Promise<void> | undefined;
  #inFlight: "start" | "stop" | "cancel" | undefined;
  public constructor(
    private readonly device: PttCaptureDevice | undefined,
    private readonly core: VoiceGatewayCore,
  ) {}
  public get hasDevice(): boolean {
    return this.device !== undefined;
  }
  public get generation(): number {
    return this.#generation;
  }
  public start<T>(startCore: () => T): Promise<T> {
    const generation = this.#generation;
    this.#invalidated = false;
    return this.enqueue("start", async () => {
      if (generation !== this.#generation) throw new Error("capture_cancelled");
      // Cancellation may interrupt the prior native operation so STOP/CANCEL
      // stays timely, but it remains an exclusive sequencing fence afterward.
      // The bounded cleanup response is not that fence: once it times out, the
      // native cancel can still be in flight. Fail closed before calling start
      // rather than allowing a second native operation to overlap it.
      if (this.#nativeCancelPromise !== undefined) throw new Error("capture_cleanup_pending");
      if (generation !== this.#generation) throw new Error("capture_cancelled");
      if (this.device === undefined) throw new Error("capture_device_unavailable");
      let logicalCaptureStarted = false;
      try {
        // The coordinator's generation and native-cancel fence are the
        // admission boundary. Only after they pass may the core create its
        // logical capture, making this start transactional if native start
        // fails or cancellation wins the race.
        const value = startCore();
        logicalCaptureStarted = true;
        if (generation !== this.#generation) throw new Error("capture_cancelled");
        await this.device.start();
        if (generation !== this.#generation) throw new Error("capture_cancelled");
        return value;
      } catch (error) {
        if (logicalCaptureStarted)
          this.core.cancelCapture(generation === this.#generation ? "capture_device_unavailable" : "capture_cancelled");
        throw error;
      }
    });
  }
  public stopDevice(): Promise<Uint8Array | undefined> {
    const generation = this.#generation;
    return this.enqueue("stop", async () => {
      if (generation !== this.#generation) throw new Error("capture_cancelled");
      // A timed-out cancel still owns the native device until its underlying
      // promise settles. Never issue stop while that cancellation is pending.
      if (this.#nativeCancelPromise !== undefined) throw new Error("capture_cleanup_pending");
      if (this.device === undefined) return undefined;
      const pcm16 = await this.device.stop();
      if (generation !== this.#generation) throw new Error("capture_cancelled");
      return pcm16;
    });
  }
  public cancel(reasonCode = "capture_cancelled"): Promise<void> {
    this.invalidate(reasonCode);
    return this.finishCancel(reasonCode);
  }
  public invalidate(reasonCode = "capture_cancelled"): void {
    if (!this.#invalidated) {
      this.#generation++;
      this.#invalidated = true;
    }
    // Invalidate the core immediately. Native cancel is deliberately started
    // outside the serialized start/stop tail only when a start is actively
    // running, since waiting for a non-settling driver start would make
    // STOP_ALL ineffective. With no active start, queue cancellation behind
    // already-admitted native work so it cannot overlap a queued stop/start.
    this.core.cancelCapture(reasonCode);
    if (this.#inFlight === "start") void this.beginCancel(true).catch(() => undefined);
    else if (this.#inFlight === undefined) void this.beginCancel().catch(() => undefined);
  }
  public finishCancel(_reasonCode = "capture_cancelled"): Promise<void> {
    if (this.device === undefined) return Promise.resolve();
    // A native cancel remains exclusive even after the bounded gateway wait has
    // timed out. Never retry it while its underlying promise is unsettled.
    if (this.#cancelGeneration === this.#generation && this.#cancelPromise !== undefined) return this.#cancelPromise;
    if (this.#nativeCancelPromise !== undefined) {
      this.#cancelGeneration = this.#generation;
      return this.#cancelPromise!;
    }
    if (this.#inFlight === "stop") {
      // A native stop is the one operation that must not overlap cancel. The
      // stale generation check in stopDevice prevents it from committing PCM;
      // cancel follows it in the same operation tail.
      const operation = this.enqueue("cancel", async () => this.device!.cancel());
      return this.scheduleCancel(operation);
    }
    return this.beginCancel();
  }
  private beginCancel(_interruptActiveStart = false): Promise<void> {
    if (this.device === undefined) return Promise.resolve();
    if (this.#cancelGeneration === this.#generation && this.#cancelPromise !== undefined) return this.#cancelPromise;
    if (this.#nativeCancelPromise !== undefined) {
      this.#cancelGeneration = this.#generation;
      return this.#cancelPromise!;
    }
    // The caller only reaches this path when no stop is active. Starting the
    // cancel directly preserves timely cancellation while start/stop check the
    // native promise fence before issuing their next operation.
    return this.scheduleCancel(Promise.resolve().then(() => this.device!.cancel()));
  }
  private scheduleCancel(operation: Promise<void>): Promise<void> {
    this.#cancelGeneration = this.#generation;
    this.#nativeCancelPromise = operation;
    const bounded = withTimeout(
      operation,
      CAPTURE_CLEANUP_TIMEOUT_MS,
      () => new VoiceGatewayCleanupError(["capture_device_cancel"]),
    );
    this.#cancelPromise = bounded;
    // Observe both promises immediately. The bounded wait may reject first,
    // but the native operation remains the sequencing fence until it settles.
    void bounded.catch(() => undefined);
    void operation.then(
      () => this.clearCancel(operation),
      () => this.clearCancel(operation),
    );
    return bounded;
  }
  private clearCancel(operation: Promise<void>): void {
    if (this.#nativeCancelPromise !== operation) return;
    this.#nativeCancelPromise = undefined;
  }
  private enqueue<T>(kind: "start" | "stop" | "cancel", operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      this.#inFlight = kind;
      try {
        return await operation();
      } finally {
        this.#inFlight = undefined;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
function isStaleCaptureRequest(
  isInvalidated: () => boolean,
  core: VoiceGatewayCore,
  captureCoordinator: CaptureCoordinator,
  admittedEpoch: number,
  admittedCaptureGeneration: number,
): boolean {
  return isInvalidated() || core.epoch !== admittedEpoch || captureCoordinator.generation !== admittedCaptureGeneration;
}
function parseRequest(line: string): Request | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || !isOpaque(value.requestId) || typeof value.type !== "string") return null;
    switch (value.type) {
      case "hello":
        return isOpaqueToken(value.token) && value.protocolVersion === VOICE_GATEWAY_PROTOCOL_VERSION
          ? (value as unknown as Request)
          : null;
      case "health":
        return value.voiceProfile === undefined || isOpaque(value.voiceProfile) ? (value as unknown as Request) : null;
      case "ptt_start":
        return isOpaque(value.sessionId) &&
          (value.inputId === undefined || isOpaque(value.inputId)) &&
          (value.locale === undefined || isLocale(value.locale))
          ? (value as unknown as Request)
          : null;
      case "ptt_frame":
        return isBase64(value.pcm16Base64) &&
          value.pcm16Base64.length > 0 &&
          value.pcm16Base64.length <= Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 + 4 &&
          (value.format === undefined || isPcmFormat(value.format))
          ? (value as unknown as Request)
          : null;
      case "ptt_stop":
        return value.reasonCode === undefined || isReasonCode(value.reasonCode) ? (value as unknown as Request) : null;
      case "capture_cancel":
      case "speech_cancel":
      case "stop_all":
        return value.reasonCode === undefined || isReasonCode(value.reasonCode)
          ? (value.type === "speech_cancel" ? isOpaque(value.jobId) : true)
            ? (value as unknown as Request)
            : null
          : null;
      case "speech_enqueue":
        return isSpeechJob(value.job) ? (value as unknown as Request) : null;
      case "events":
        return isOpaque(value.sessionId) && (value.after === undefined || isNonnegativeSafeInteger(value.after))
          ? (value as unknown as Request)
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
function safeReason(reason: string): string {
  return /^[a-z0-9_:-]{1,96}$/i.test(reason) ? reason : "gateway_request_failed";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaque(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}
function isOpaqueToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}
function isLocale(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);
}
function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,96}$/.test(value);
}
function isBase64(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  );
}
function isPcmFormat(value: unknown): value is PcmFormat {
  return (
    isRecord(value) &&
    value.sampleRate === REQUIRED_PCM_FORMAT.sampleRate &&
    value.channels === REQUIRED_PCM_FORMAT.channels &&
    value.encoding === REQUIRED_PCM_FORMAT.encoding
  );
}
function isSpeechJob(value: unknown): value is SpeechJob {
  if (!isRecord(value)) return false;
  return (
    isOpaque(value.jobId) &&
    isOpaque(value.sessionId) &&
    isNonnegativeSafeInteger(value.epoch) &&
    isOpaque(value.sourceEventId) &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= 4_000 &&
    isLocale(value.locale) &&
    isOpaque(value.voiceProfile) &&
    isFiniteNumber(value.expiresAtMs) &&
    typeof value.interruptible === "boolean" &&
    (value.direction === undefined ||
      (typeof value.direction === "string" && value.direction.length > 0 && value.direction.length <= 1_000))
  );
}
function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function latestSpeechFailure(core: VoiceGatewayCore, jobId: string): string {
  const event = [...core.events]
    .reverse()
    .find((candidate) => candidate.type === "speech_state" && candidate.jobId === jobId);
  return event?.type === "speech_state" && event.state !== "queued" ? event.reasonCode : "speech_rejected";
}
function send(socket: Socket, response: Response): void {
  socket.write(`${JSON.stringify(response)}\n`);
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error === undefined ? resolvePromise() : reject(error))),
  );
}
