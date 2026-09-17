import { createServer, type Server, type Socket } from "node:net";
import {
  createBoundedUtf8NdjsonDecoder,
  encodeVoiceGatewayMessage,
  isVoiceGatewayResponse,
  MAX_NDJSON_FRAME_BYTES,
  parseVoiceGatewayRequest,
  VOICE_PROTOCOL_VERSION,
  type VoiceGatewayRequest,
  type VoiceGatewayResponse,
} from "@gamebuddy/voice-protocol";
import {
  type AsrProvider,
  type Mixer,
  REQUIRED_PCM_FORMAT,
  type SpeechJob,
  type TtsProvider,
  VoiceGatewayCore,
} from "./gateway.js";

/** Hardware PTT capture stays wholly inside Gateway; Host never receives raw PCM. */
interface PttCaptureDevice {
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
class VoiceGatewayCleanupError extends Error {
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
type Request = VoiceGatewayRequest;
type Response = VoiceGatewayResponse;
type DispatchOutcome = Readonly<{
  response: Response;
  /** False means replaying the response could hide an uncertain native outcome. */
  replayable: boolean;
  /** Cleanup failure is a gateway-wide safety boundary, not a request-local error. */
  quarantine: boolean;
}>;
const REQUEST_REPLAY_TTL_MS = 60_000;
const REQUEST_REPLAY_CAPACITY = 1_000;
const REQUEST_REPLAY_UNSAFE_REASON = "request_replay_unsafe";
const REQUEST_IN_FLIGHT_REASON = "request_in_flight";
const REQUEST_ID_REUSE_REASON = "request_id_reuse";
const GATEWAY_QUARANTINED_REASON = "gateway_quarantined";
const LIFECYCLE_OPERATION_TIMEOUT_MS = 1_000;
class VoiceGatewayRequestTimeoutError extends Error {
  public constructor() {
    super("voice_gateway_request_timeout");
    this.name = "VoiceGatewayRequestTimeoutError";
  }
}
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
/** Leaves enough envelope headroom for one valid event response. */
const MAX_EVENTS_RESPONSE_BYTES = MAX_NDJSON_FRAME_BYTES - 1;
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
  let quarantined = false;
  let closePromise: Promise<void> | undefined;
  const quarantine = (): void => {
    if (quarantined) return;
    quarantined = true;
    // Quarantine is Voice-local. Do not retry a failed native cleanup here:
    // the coordinator remains the sole owner of that operation and a second
    // call could duplicate an unknown hardware effect.
    try {
      core.stopAll("gateway_quarantined");
    } catch {
      // The gateway is already quarantined; retain the fail-closed state.
    }
  };
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
    handleSocket(socket, options.token, core, captureCoordinator, () => quarantined, quarantine);
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
        if (cleanupResult.status === "rejected") {
          quarantine();
          if (cleanupResult.reason instanceof VoiceGatewayCleanupError) throw cleanupResult.reason;
        }
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
  isQuarantined: () => boolean,
  quarantine: () => void,
): void {
  let authenticated = false;
  const framer = createBoundedUtf8NdjsonDecoder({
    maxRecordBytes: MAX_NDJSON_FRAME_BYTES,
    maxBufferedBytes: MAX_NDJSON_FRAME_BYTES,
  });
  let processing: Promise<void> = Promise.resolve();
  let requestSequence = 0;
  let cancellationFence = 0;
  const replay = new Map<string, RequestReplay>();
  socket.on("end", () => {
    try {
      framer.finish();
    } catch {
      socket.destroy();
    }
  });
  socket.on("data", (chunk: Buffer) => {
    let frames: readonly string[];
    try {
      frames = framer.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const line of frames) {
      const parsed = parseRequest(line);
      if (parsed === null) {
        send(socket, { type: "error", requestId: null, reasonCode: "malformed_request" });
        continue;
      }
      const now = Date.now();
      evictExpiredReplay(replay, now);
      const fingerprint = canonicalJson(parsed);
      const prior = replay.get(parsed.requestId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          send(socket, { type: "error", requestId: parsed.requestId, reasonCode: REQUEST_ID_REUSE_REASON });
        } else {
          void replayRequest(socket, prior);
        }
        continue;
      }
      // Authentication is a protocol admission property, not a queued work
      // item. Once a valid hello is parsed, cancellation in the same packet (or
      // on another peer) must be able to invalidate work already queued behind
      // that hello; waiting for the hello response would deadlock a gated
      // capture start. Invalid hellos never set this flag.
      if (parsed.type === "hello" && parsed.protocolVersion === VOICE_PROTOCOL_VERSION && parsed.token === token)
        authenticated = true;
      const sequence = ++requestSequence;
      const cancellable = isCancellationRequest(parsed);
      if (cancellable) cancellationFence = sequence - 1;
      const preCancelled = cancellable && authenticated;
      if (preCancelled) applyCancellation(parsed, core, captureCoordinator);
      const admittedEpoch = core.epoch;
      const admittedCaptureGeneration = captureCoordinator.generation;
      const requestReplay: RequestReplay = {
        fingerprint,
        expiresAt: now + REQUEST_REPLAY_TTL_MS,
        promise: Promise.resolve(),
      };
      replay.set(parsed.requestId, requestReplay);
      evictExpiredReplay(replay, now);
      const dispatchNow = async (): Promise<void> => {
        const outcome = await dispatch(
          socket,
          parsed,
          token,
          core,
          captureCoordinator,
          admittedEpoch,
          admittedCaptureGeneration,
          preCancelled,
          () => sequence <= cancellationFence,
          () => authenticated,
          () => {
            authenticated = true;
          },
          () => {
            requestReplay.replayable = false;
          },
          isQuarantined,
          quarantine,
        );
        requestReplay.response = outcome.response;
        requestReplay.replayable = outcome.replayable;
        if (outcome.quarantine) quarantine();
      };
      requestReplay.promise = processing.then(dispatchNow).catch((error: unknown) => {
        const response: Response = {
          type: "error",
          requestId: parsed.requestId,
          reasonCode: safeReason(error instanceof Error ? error.message : "gateway_request_failed"),
        };
        requestReplay.response = response;
        requestReplay.replayable = false;
        send(socket, response);
      });
      processing = requestReplay.promise;
    }
  });
}

type RequestReplay = {
  readonly fingerprint: string;
  readonly expiresAt: number;
  promise: Promise<void>;
  response?: Response;
  replayable?: boolean;
};

function evictExpiredReplay(replay: Map<string, RequestReplay>, now: number): void {
  for (const [requestId, entry] of replay) {
    if (entry.expiresAt <= now) replay.delete(requestId);
  }
  while (replay.size > REQUEST_REPLAY_CAPACITY) {
    const oldest = replay.keys().next().value;
    if (typeof oldest !== "string") return;
    replay.delete(oldest);
  }
}

async function replayRequest(socket: Socket, entry: RequestReplay): Promise<void> {
  await entry.promise;
  if (socket.destroyed) return;
  if (entry.response === undefined || entry.replayable !== true) {
    send(socket, {
      type: "error",
      requestId: entry.response?.requestId ?? null,
      reasonCode: entry.response === undefined ? REQUEST_IN_FLIGHT_REASON : REQUEST_REPLAY_UNSAFE_REASON,
    });
    return;
  }
  send(socket, entry.response);
}

function isCancellationRequest(request: Request): boolean {
  return request.type === "stop_all" || request.type === "speech_cancel" || request.type === "capture_cancel";
}

function applyCancellation(request: Request, core: VoiceGatewayCore, captureCoordinator: CaptureCoordinator): void {
  if (request.type === "stop_all") {
    core.stopAll(request.reasonCode);
    captureCoordinator.invalidate(request.reasonCode);
  } else if (request.type === "capture_cancel") {
    captureCoordinator.invalidate(request.reasonCode);
  } else if (request.type === "speech_cancel") {
    core.cancelSpeech(request.jobId, request.reasonCode);
  }
}

async function dispatch(
  socket: Socket,
  request: Request,
  token: string,
  core: VoiceGatewayCore,
  captureCoordinator: CaptureCoordinator,
  admittedEpoch: number,
  admittedCaptureGeneration: number,
  preCancelled: boolean,
  isInvalidated: () => boolean,
  isAuthenticated: () => boolean,
  authenticate: () => void,
  markReplayUnsafe: () => void,
  isQuarantined: () => boolean,
  quarantine: () => void,
): Promise<DispatchOutcome> {
  if (request.type === "hello") {
    if (request.protocolVersion !== VOICE_PROTOCOL_VERSION || request.token !== token) {
      return sendOutcome(socket, { type: "error", requestId: request.requestId, reasonCode: "authentication_failed" }, true);
    }
    authenticate();
    return sendOutcome(socket, { type: "hello_ack", requestId: request.requestId, protocolVersion: VOICE_PROTOCOL_VERSION }, true);
  }
  if (!isAuthenticated())
    return sendOutcome(socket, { type: "error", requestId: request.requestId, reasonCode: "unauthenticated" }, true);
  if (isQuarantined() && isMutatingRequest(request))
    return sendOutcome(socket, { type: "error", requestId: request.requestId, reasonCode: GATEWAY_QUARANTINED_REASON }, true);
  try {
    switch (request.type) {
      case "health": {
        const capabilities = core.capabilities;
        const profileReady = request.voiceProfile === undefined || core.supportsVoiceProfile(request.voiceProfile);
        const effective = !isQuarantined() && profileReady ? capabilities : { ...capabilities, ready: false };
        return sendOutcome(socket, {
          type: "health",
          requestId: request.requestId,
          status: effective.ready ? "ready" : "unavailable",
          protocolVersion: VOICE_PROTOCOL_VERSION,
          capabilities: effective,
        }, true);
      }
      case "ptt_start": {
        if (!captureCoordinator.hasDevice) throw new Error("capture_device_unavailable");
        if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
          throw new Error("capture_cancelled");
        const inputId = await captureCoordinator.start(() =>
          core.startPtt(request.sessionId, request.inputId, request.locale),
        );
        return sendOutcome(socket, { type: "accepted", requestId: request.requestId, value: inputId }, true);
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
          const pcm16 = await withTimeout(
            captureCoordinator.stopDevice(),
            LIFECYCLE_OPERATION_TIMEOUT_MS,
            () => new VoiceGatewayRequestTimeoutError(),
          );
          if (pcm16 !== undefined) core.pushPcm(pcm16, REQUIRED_PCM_FORMAT);
          if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
            throw new Error("capture_cancelled");
          const text = await withTimeout(
            core.stopPtt(request.reasonCode),
            LIFECYCLE_OPERATION_TIMEOUT_MS,
            () => new VoiceGatewayRequestTimeoutError(),
          );
          // stopPtt may remain in ASR while a cross-socket STOP/CANCEL aborts
          // the capture. Never acknowledge the stale request as accepted after
          // that invalidation, even when the provider resolves with null.
          if (isStaleCaptureRequest(isInvalidated, core, captureCoordinator, admittedEpoch, admittedCaptureGeneration))
            throw new Error("capture_cancelled");
          return sendOutcome(socket, { type: "accepted", requestId: request.requestId, value: text ?? "" }, true);
        } catch (error) {
          core.cancelCapture(error instanceof VoiceGatewayRequestTimeoutError ? "voice_gateway_request_timeout" : "capture_device_failed");
          if (error instanceof VoiceGatewayRequestTimeoutError) {
            captureCoordinator.invalidate("voice_gateway_request_timeout");
            void captureCoordinator.finishCancel("voice_gateway_request_timeout").catch(() => {
              quarantine();
            });
            markReplayUnsafe();
            quarantine();
          }
          throw error;
        }
      }
      case "capture_cancel":
        if (!preCancelled) captureCoordinator.invalidate(request.reasonCode);
        await captureCoordinator.finishCancel(request.reasonCode);
        return sendOutcome(socket, { type: "accepted", requestId: request.requestId, value: true }, true);
      case "speech_enqueue": {
        // The epoch is captured when the request is admitted, rather than
        // trusting the caller-provided job epoch. A STOP_ALL on another socket
        // must invalidate work that was already admitted but is still queued
        // behind a slow request on this socket.
        if (isInvalidated() || core.epoch !== admittedEpoch) throw new Error("speech_cancelled");
        const accepted = core.queueSpeech(request.job);
        const response: Response = accepted
          ? { type: "accepted", requestId: request.requestId, value: true }
          : { type: "error", requestId: request.requestId, reasonCode: latestSpeechFailure(core, request.job.jobId) };
        if (accepted) {
          void withTimeout(
            core.drain(),
            LIFECYCLE_OPERATION_TIMEOUT_MS,
            () => new VoiceGatewayRequestTimeoutError(),
          ).catch((error: unknown) => {
            if (!(error instanceof VoiceGatewayRequestTimeoutError)) return;
            markReplayUnsafe();
            quarantine();
          });
        }
        return sendOutcome(socket, response, true);
      }
      case "speech_cancel":
        if (!preCancelled) core.cancelSpeech(request.jobId, request.reasonCode);
        return sendOutcome(socket, { type: "accepted", requestId: request.requestId, value: true }, true);
      case "stop_all":
        if (!preCancelled) {
          core.stopAll(request.reasonCode);
          captureCoordinator.invalidate(request.reasonCode);
        }
        await captureCoordinator.finishCancel(request.reasonCode);
        return sendOutcome(socket, { type: "accepted", requestId: request.requestId, value: true }, true);
      case "events": {
        const result = core.eventsAfterPage(
          request.after ?? 0,
          request.sessionId,
          (events) =>
            Buffer.byteLength(
              JSON.stringify({ type: "events", requestId: request.requestId, events, next: Number.MAX_SAFE_INTEGER }),
              "utf8",
            ) + 1 <= MAX_EVENTS_RESPONSE_BYTES,
        );
        if (result.expired)
          return sendOutcome(socket, { type: "error", requestId: request.requestId, reasonCode: "voice_event_cursor_expired" }, true);
        return sendOutcome(socket, { type: "events", requestId: request.requestId, events: result.events, next: result.next }, true);
      }
    }
  } catch (error) {
    const response: Response = {
      type: "error",
      requestId: request.requestId,
      reasonCode: error instanceof Error ? safeReason(error.message) : "gateway_request_failed",
    };
    // A failed capture cleanup leaves the native boundary uncertain. The
    // request response is intentionally not replayable, and the gateway is
    // quarantined before another mutating request can be admitted.
    const cleanupFailure = request.type === "capture_cancel" || request.type === "stop_all" ||
      request.type === "ptt_stop" && error instanceof VoiceGatewayRequestTimeoutError;
    return sendOutcome(socket, response, isErrorReplayable(request, error), cleanupFailure);
  }
}

function sendOutcome(
  socket: Socket,
  response: Response,
  replayable: boolean,
  quarantine = false,
): DispatchOutcome {
  send(socket, response);
  return { response, replayable, quarantine };
}

function isMutatingRequest(request: Request): boolean {
  return request.type === "ptt_start" || request.type === "ptt_frame" || request.type === "ptt_stop" ||
    request.type === "capture_cancel" || request.type === "speech_enqueue" || request.type === "speech_cancel" ||
    request.type === "stop_all";
}

function isErrorReplayable(request: Request, error: unknown): boolean {
  if (request.type === "ptt_stop" || request.type === "capture_cancel" || request.type === "stop_all") return false;
  // A start failure is transactional inside CaptureCoordinator and a speech
  // cancellation has no asynchronous native boundary. Their exact rejection
  // can safely be replayed without issuing a second operation.
  return !(error instanceof VoiceGatewayCleanupError);
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
  return parseVoiceGatewayRequest(line);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function safeReason(reason: string): string {
  return /^[a-z0-9_:-]{1,96}$/i.test(reason) ? reason : "gateway_request_failed";
}
function latestSpeechFailure(core: VoiceGatewayCore, jobId: string): string {
  const event = [...core.events]
    .reverse()
    .find((candidate) => candidate.type === "speech_state" && candidate.jobId === jobId);
  return event?.type === "speech_state" && event.state !== "queued" ? event.reasonCode : "speech_rejected";
}
function send(socket: Socket, response: Response): void {
  if (!isVoiceGatewayResponse(response)) {
    socket.destroy();
    return;
  }
  socket.write(encodeVoiceGatewayMessage(response));
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
