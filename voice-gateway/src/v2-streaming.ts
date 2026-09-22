/**
 * v2 wire runtime — the streaming face of the Voice Gateway.
 *
 * The frozen v2 contract has no request/response envelope: four request
 * types, three event types, all carrying the envelope fields
 * (protocolVersion 2, sessionId, connectionEpoch, timestampMs). This runtime
 * treats the socket as an authenticated streaming lane: v1 `hello`
 * authenticates the connection, v2 frames are the media/control flow, and
 * every v2 event (playback_observation / gateway_state) is pushed by the
 * server — there is no v2 `events` poll, so nothing here invents one.
 *
 * Voice authority stays unchanged: this runtime never touches
 * ChatThreadStore, never advances a Chat cancel epoch, and never cancels a
 * Game action. `stream_speech_chunk` feeds delta text into the same verified
 * Phase 2 pipeline (StreamingSentenceChunker + parallel pre-synthesis +
 * resident-stream mixer). One physical speaker = one pipeline + one pump
 * loop, mirroring the v1 core's single drain worker.
 */
import {
  isVoiceGatewayRequestV2,
  VOICE_PROTOCOL_VERSION_V2,
  type VoiceGatewayEventV2,
  type VoiceGatewayPublicState,
  type VoiceGatewayRequestV2,
} from "@gamebuddy/voice-protocol";

import type { Mixer, TtsProvider } from "./gateway.js";
import { createStreamingSpeechPipeline, type StreamingSpeechPipeline } from "./streaming-pipeline.js";

const MAX_ACTIVE_SPEECH_JOBS = 8;
const MAX_JOB_TEXT_LENGTH = 16_000;
const DELTA_TEXT_LIMIT = 4_000;
const PUMP_IDLE_DELAY_MS = 10;
/** Initial device headroom handed to the render child before pacing kicks in. */
const PREBUFFER_MS = 320;

type JobState = Readonly<{
  sessionId: string;
  connectionEpoch: number;
  speechJobId: string;
  voiceProfile?: string;
  text: string;
  nextChunkIndex: number;
  finalCommitted: boolean;
  deadlineMs: number;
}> & {
  text: string;
  nextChunkIndex: number;
  finalCommitted: boolean;
};

export type V2RuntimeOptions = Readonly<{
  tts: TtsProvider;
  mixer: Mixer;
  /** Initial connection epoch; every request must carry this exact value. */
  connectionEpoch: number;
  /** Push receiver: v2 has no polls, so events leave through this callback. */
  onEvent(event: VoiceGatewayEventV2): void;
  sampleRate?: number;
  locale?: string;
}>;

/**
 * Admitted v2 stream session. One pipeline serves every job in FIFO order;
 * job bookkeeping (chunk order, deadline, final marker) lives in `#jobs`.
 */
export class V2StreamingRuntime {
  readonly #tts: TtsProvider;
  readonly #mixer: Mixer;
  readonly #epoch: number;
  readonly #onEvent: (event: VoiceGatewayEventV2) => void;
  readonly #sampleRate: number;
  readonly #locale: string;
  readonly #jobs = new Map<string, JobState>();
  #pipeline: StreamingSpeechPipeline | undefined;
  #pumpPromise: Promise<void> | undefined;
  #closed = false;
  #quarantined = false;
  #cancelling = false;

  public constructor(options: V2RuntimeOptions) {
    this.#tts = options.tts;
    this.#mixer = options.mixer;
    this.#epoch = options.connectionEpoch;
    this.#onEvent = options.onEvent;
    this.#sampleRate = options.sampleRate ?? 16_000;
    this.#locale = options.locale ?? "zh-CN";
  }

  public get connectionEpoch(): number {
    return this.#epoch;
  }

  public get ready(): boolean {
    return !this.#quarantined && this.#tts.ready !== false && this.#mixer.ready !== false;
  }

  public publicState(): VoiceGatewayPublicState {
    return {
      ready: this.ready,
      capture: this.#mixer.ready !== false ? "ready" : "unavailable",
      speech: this.#tts.ready !== false ? "ready" : "unavailable",
      ...(this.#quarantined
        ? { reasonCode: "quarantined" as const }
        : this.#mixer.ready === false
          ? { reasonCode: "device_missing" as const }
          : this.#tts.ready === false
            ? { reasonCode: "permission_denied" as const }
            : {}),
    };
  }

  /** A hardware cleanup failure is Voice-local and fail-closed: no new jobs. */
  public markQuarantined(): void {
    this.#quarantined = true;
    this.emitGatewayState("gateway");
  }

  public handleRequest(line: string, nowMs = Date.now()): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return false;
    }
    if (!isVoiceGatewayRequestV2(value)) return false;
    const request = value;
    if (request.connectionEpoch !== this.#epoch) {
      this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "stale_connection_epoch");
      return true;
    }
    if (Math.abs(request.timestampMs - nowMs) > 30_000) {
      this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "timestamp_out_of_window");
      return true;
    }
    switch (request.type) {
      case "stream_speech_chunk":
        this.acceptChunk(request, nowMs);
        return true;
      case "cancel_speech":
        this.cancelSpeech(request);
        return true;
      case "cancel_capture":
        // There is no Host PCM ingress on this lane; the stop is Voice-local.
        this.emitGatewayState(request.sessionId);
        return true;
      case "stop_all":
        this.stopAll(request.sessionId, "stop_all");
        this.emitGatewayState(request.sessionId);
        return true;
      default:
        return false;
    }
  }

  /** Close every admitted stream; power of the owning gateway, not a request. */
  public async close(reasonCode = "gateway_shutdown"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const job of [...this.#jobs.values()]) {
      this.#jobs.delete(job.speechJobId);
      this.pushPlayback(job.sessionId, job.connectionEpoch, null, "cancelled", reasonCode, job.speechJobId, job.voiceProfile);
    }
    if (this.#pipeline !== undefined) {
      await this.#pipeline.close();
      this.#pipeline = undefined;
    }
  }

  /** Test/transport helper: resolve when the pump is idle and jobs settle. */
  public async drainIdle(timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idle =
        this.#jobs.size === 0 &&
        (this.#pipeline === undefined || !this.#pipeline.pendingWork);
      if (idle) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, PUMP_IDLE_DELAY_MS));
    }
    throw new Error("v2_runtime_drain_timeout");
  }

  private acceptChunk(request: Extract<VoiceGatewayRequestV2, { type: "stream_speech_chunk" }>, nowMs: number): void {
    if (this.#quarantined || this.#closed) {
      this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "quarantined");
      return;
    }
    const existing = this.#jobs.get(request.speechJobId);
    if (existing !== undefined) {
      if (existing.finalCommitted) {
        this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "already_final");
        return;
      }
      if (request.chunkIndex !== existing.nextChunkIndex) {
        this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "chunk_index_out_of_order");
        return;
      }
      if (request.deadlineMs !== existing.deadlineMs) {
        this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "deadline_mutation");
        return;
      }
      if (existing.text.length + request.deltaText.length > MAX_JOB_TEXT_LENGTH) {
        this.pushPlayback(request.sessionId, request.connectionEpoch, request, "failed_before_side_effect", "text_too_long");
        this.#jobs.delete(request.speechJobId);
        return;
      }
      existing.text += request.deltaText;
      existing.nextChunkIndex += 1;
      if (request.isFinalChunk) existing.finalCommitted = true;
      void this.voiceAndMaybeFinalize(existing, request.deltaText, request.isFinalChunk, nowMs);
      return;
    }
    // Fresh job admission: bounded concurrency, deadline, chunk bounds.
    if (this.#jobs.size >= MAX_ACTIVE_SPEECH_JOBS) {
      this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "speech_job_limit");
      return;
    }
    if (request.chunkIndex !== 0) {
      this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "first_chunk_index");
      return;
    }
    if (request.deadlineMs <= nowMs) {
      this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "deadline_expired");
      return;
    }
    if (request.deltaText.length > DELTA_TEXT_LIMIT) {
      this.pushPlayback(request.sessionId, request.connectionEpoch, request, "not_accepted", "chunk_too_large");
      return;
    }
    const job: JobState = {
      sessionId: request.sessionId,
      connectionEpoch: request.connectionEpoch,
      speechJobId: request.speechJobId,
      voiceProfile: request.voiceProfile,
      text: request.deltaText,
      nextChunkIndex: 1,
      finalCommitted: request.isFinalChunk,
      deadlineMs: request.deadlineMs,
    };
    this.#jobs.set(request.speechJobId, job);
    void this.voiceAndMaybeFinalize(job, request.deltaText, request.isFinalChunk, nowMs);
  }

  /** Ensure the single pipeline exists, feed the delta, then settle if final. */
  private async voiceAndMaybeFinalize(
    job: JobState,
    delta: string,
    isFinal: boolean,
    nowMs: number,
  ): Promise<void> {
    if (this.#pipeline === undefined) {
      this.#pipeline = await createStreamingSpeechPipeline({
        tts: this.#tts,
        mixer: this.#mixer,
        sampleRate: this.#sampleRate,
        locale: this.#locale,
      });
    }
    await this.#pipeline.pushText(delta, nowMs);
    this.startPump();
    if (isFinal) await this.finalize(job, nowMs);
  }

  /**
   * One pump loop for the whole runtime (single speaker). It monotonically
   * drains micro-chunks paced to the device: one 20ms micro-chunk per 20ms
   * wall tick (with a bounded prebuffer so the device never underruns). Keep
   * the sync at this layer so the final playout tick lands on the device the
   * moment the last frame is handed over — otherwise `completed` would be
   * observed before the speaker physically finished (the close-then-drain
   * stall seen in the three-turn live gate).
   */
  private startPump(): void {
    if (this.#pumpPromise !== undefined) return;
    this.#pumpPromise = (async () => {
      const FRAME_MS = 20;
      // Prebuffer: hand the first frames immediately so the device queue
      // fills ~320ms deep before pacing kicks in (same headroom the render
      // child reserves).
      let nextFrameAt = Date.now() + PREBUFFER_MS;
      for (;;) {
        if (this.#closed || this.#pipeline === undefined) return;
        if (await this.#pipeline.pumpAwait()) {
          nextFrameAt += FRAME_MS;
          const waitMs = nextFrameAt - Date.now();
          if (waitMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
          continue;
        }
        const hasPending = [...this.#jobs.values()].some((job) => !job.finalCommitted);
        if (!hasPending && !this.#pipeline.pendingWork) {
          // Nothing to voice: the device already consumed the queue, so the
          // next batch may start with fresh prebuffer headroom instead of a
          // stale pacing offset.
          nextFrameAt = Date.now() + PREBUFFER_MS;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, PUMP_IDLE_DELAY_MS));
          continue;
        }
        // Queue momentarily empty but more text is still expected: keep the
        // pacing offset (the speaker is still draining the prebuffer).
        await new Promise((resolvePromise) => setTimeout(resolvePromise, PUMP_IDLE_DELAY_MS));
      }
    })().finally(() => {
      this.#pumpPromise = undefined;
    });
  }

  private async finalize(job: JobState, nowMs: number): Promise<void> {
    if (this.#closed) return;
    if (nowMs > job.deadlineMs) {
      this.#jobs.delete(job.speechJobId);
      this.pushPlayback(
        job.sessionId,
        job.connectionEpoch,
        null,
        "unknown_after_admission",
        "deadline_expired",
        job.speechJobId,
        job.voiceProfile,
      );
      return;
    }
    // The terminal flush enqueues the accumulator tail; the pump loop voices
    // it, then we settle the outcome once the pipeline is clean.
    await this.#pipeline?.flush();
    await new Promise<void>((resolvePromise) => {
      const watch = (): void => {
        if (this.#closed || this.#pipeline === undefined || !this.#pipeline.pendingWork) resolvePromise();
        else setTimeout(watch, PUMP_IDLE_DELAY_MS);
      };
      watch();
    });
    const playedBytes = this.#pipeline?.playedBytes ?? 0;
    this.#jobs.delete(job.speechJobId);
    // A hardware/output failure during playback must not look like a clean
    // completion: settle the job as failed-before-side-effect when nothing
    // played yet, otherwise unknown-after-admission (side effect may exist
    // but its extent is unknowable). The gateway itself stays alive so Chat
    // keeps working and the Host can re-probe.
    if (this.#pipeline?.outputFailed === true) {
      this.pushPlayback(
        job.sessionId,
        job.connectionEpoch,
        null,
        playedBytes > 0 ? "unknown_after_admission" : "failed_before_side_effect",
        "output_failed",
        job.speechJobId,
        job.voiceProfile,
      );
      return;
    }
    this.pushPlayback(
      job.sessionId,
      job.connectionEpoch,
      null,
      "completed",
      "completed",
      job.speechJobId,
      job.voiceProfile,
      playedBytes,
    );
  }

  private cancelSpeech(request: Extract<VoiceGatewayRequestV2, { type: "cancel_speech" }>): void {
    if (request.speechJobId !== undefined) {
      const job = this.#jobs.get(request.speechJobId);
      if (job !== undefined && job.sessionId === request.sessionId) void this.cancelJob(job, request.reason);
      return;
    }
    for (const job of [...this.#jobs.values()]) {
      if (job.sessionId === request.sessionId) void this.cancelJob(job, request.reason);
    }
  }

  private async cancelJob(job: JobState, reason: string): Promise<void> {
    if (this.#cancelling || this.#closed) return;
    this.#cancelling = true;
    try {
      this.#jobs.delete(job.speechJobId);
      if (this.#pipeline !== undefined) await this.#pipeline.cancelSpeech();
      const playedBytes = this.#pipeline?.playedBytes ?? 0;
      this.pushPlayback(job.sessionId, job.connectionEpoch, null, "cancelled", reason, job.speechJobId, job.voiceProfile, playedBytes);
    } finally {
      this.#cancelling = false;
    }
  }

  private stopAll(sessionId: string, reason: string): void {
    for (const job of [...this.#jobs.values()]) {
      if (job.sessionId === sessionId) void this.cancelJob(job, reason);
    }
  }

  /** Emit a push-only playback_observation; `playedBytes` maps to audioEndMs. */
  private pushPlayback(
    sessionId: string,
    connectionEpoch: number,
    request: VoiceGatewayRequestV2 | null,
    terminalStatus: Extract<VoiceGatewayEventV2, { type: "playback_observation" }>["terminalStatus"],
    reasonCode: string,
    speechJobId?: string,
    voiceProfile?: string,
    playedBytes = 0,
  ): void {
    const event = this.makeEvent(sessionId, connectionEpoch, {
      type: "playback_observation",
      speechJobId: request?.type === "stream_speech_chunk" ? request.speechJobId : (speechJobId ?? "voice_gateway"),
      audioEndMs: Math.floor(((playedBytes / 2) / this.#sampleRate) * 1_000),
      terminalStatus,
    });
    void voiceProfile;
    void reasonCode;
    if (event !== null) this.#onEvent(event);
  }

  private emitGatewayState(sessionId = "gateway"): void {
    const event = this.makeEvent(sessionId, this.#epoch, {
      type: "gateway_state",
      state: this.publicState(),
    });
    if (event !== null) this.#onEvent(event);
  }

  /** Envelope + payload assembled exactly as the frozen contract validates them. */
  private makeEvent<P extends object>(
    sessionId: string,
    connectionEpoch: number,
    payload: P,
  ): (VoiceGatewayEventV2 & P) | null {
    return Object.freeze({
      ...payload,
      protocolVersion: VOICE_PROTOCOL_VERSION_V2,
      sessionId,
      connectionEpoch,
      timestampMs: Date.now(),
    }) as VoiceGatewayEventV2 & P;
  }
}