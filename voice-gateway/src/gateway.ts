import { randomUUID } from "node:crypto";
import {
  REQUIRED_PCM_FORMAT,
  type VoiceGatewayCapabilities,
  type VoiceGatewayEvent,
  type VoiceSpeechJob,
} from "@gamebuddy/voice-protocol";

export { REQUIRED_PCM_FORMAT } from "@gamebuddy/voice-protocol";
const MAX_CAPTURE_BYTES = 960_000;
const MAX_SPEECH_QUEUE = 3;
const MAX_SPEECH_AUDIO_BYTES = 1_920_000;
const MAX_EVENT_HISTORY = 2_048;

type GatewayEvent = VoiceGatewayEvent;
export type SpeechJob = VoiceSpeechJob;
export interface AsrProvider {
  readonly providerId: string;
  readonly modelRevision: string;
  transcribe(pcm16: Uint8Array, locale: string, signal: AbortSignal): Promise<string>;
}
export interface TtsProvider {
  readonly providerId: string;
  readonly modelRevision: string;
  /** A provider may be present but not usable until its credential/profile is ready. */
  readonly ready?: boolean;
  readonly capabilities?: Readonly<{ perUtteranceDirection?: boolean }>;
  readonly supportsVoiceProfile?: (voiceProfile: string) => boolean;
  synthesize(job: SpeechJob, signal: AbortSignal): AsyncIterable<Uint8Array>;
}
export interface Mixer {
  /** Production adapters must explicitly report a real output device. */
  readonly ready?: boolean;
  /** Resolves only after the adapter accepted the PCM frame; rejection revokes its readiness. */
  play(jobId: string, epoch: number, pcm16: Uint8Array): void | Promise<void>;
  stop(): void;
}

type Capture = {
  sessionId: string;
  inputId: string;
  sourceEventId: string;
  locale: string;
  chunks: Uint8Array[];
  bytes: number;
  epoch: number;
  controller: AbortController;
  terminalState?: "cancelled" | "final_transcript" | "failed";
};
type ActiveSpeech = { job: SpeechJob; controller: AbortController; cancelled: boolean }; // `cancelled` also guards the terminal receipt.

/**
 * Provider-neutral standalone Voice Gateway core. It owns capture/playback
 * cancellation epochs only; no raw audio is persisted and it has no Pi/game
 * imports. All providers receive an AbortSignal and stale callbacks are ignored.
 */
export class VoiceGatewayCore {
  #capture: Capture | undefined;
  #finalizing = new Map<string, Capture>();
  #activeSpeech = new Map<string, ActiveSpeech>();
  #epoch = 0;
  #queue: SpeechJob[] = [];
  #drainPromise: Promise<void> | undefined;
  readonly #events: GatewayEvent[] = [];
  #eventBase = 0;

  public constructor(
    private readonly asr: AsrProvider,
    private readonly tts: TtsProvider,
    private readonly mixer: Mixer,
  ) {}
  public get epoch(): number {
    return this.#epoch;
  }
  public get events(): readonly GatewayEvent[] {
    return this.#events;
  }
  public get eventBase(): number {
    return this.#eventBase;
  }
  public eventsAfter(
    after: number,
    sessionId?: string,
  ): Readonly<{ events: readonly GatewayEvent[]; next: number; base: number; expired: boolean }> {
    const next = this.#eventBase + this.#events.length;
    if (!Number.isSafeInteger(after) || after < this.#eventBase)
      return { events: [], next, base: this.#eventBase, expired: true };
    const start = after - this.#eventBase;
    const events =
      sessionId === undefined
        ? this.#events.slice(start)
        : this.#events.slice(start).filter((event) => event.sessionId === sessionId);
    return { events, next, base: this.#eventBase, expired: false };
  }
  /**
   * Returns a session-filtered page without advancing beyond an event that the
   * caller cannot encode. The accepted predicate receives the complete next
   * page, so the transport can enforce its frame bound exactly.
   */
  public eventsAfterPage(
    after: number,
    sessionId: string,
    accept: (events: readonly GatewayEvent[]) => boolean,
  ): Readonly<{ events: readonly GatewayEvent[]; next: number; base: number; expired: boolean }> {
    const next = this.#eventBase + this.#events.length;
    if (!Number.isSafeInteger(after) || after < this.#eventBase)
      return { events: [], next, base: this.#eventBase, expired: true };
    const page: GatewayEvent[] = [];
    for (let index = Math.max(0, after - this.#eventBase); index < this.#events.length; index += 1) {
      const event = this.#events[index]!;
      if (event.sessionId !== sessionId) continue;
      const candidate = [...page, event];
      if (!accept(candidate)) {
        if (page.length === 0) throw new Error("voice_event_too_large");
        return { events: page, next: this.#eventBase + index, base: this.#eventBase, expired: false };
      }
      page.push(event);
    }
    return { events: page, next, base: this.#eventBase, expired: false };
  }
  public supportsVoiceProfile(voiceProfile: string): boolean {
    return (
      voiceProfile.length > 0 &&
      (this.tts.supportsVoiceProfile === undefined || this.tts.supportsVoiceProfile(voiceProfile))
    );
  }

  public get capabilities(): VoiceGatewayCapabilities {
    return Object.freeze({
      providerId: this.tts.providerId,
      modelRevision: this.tts.modelRevision,
      perUtteranceDirection: this.tts.capabilities?.perUtteranceDirection === true,
      // Readiness is affirmative: omitted provider/device state is not a
      // usable player-facing audio surface.
      ready: this.tts.ready === true && this.mixer.ready === true,
      epoch: this.#epoch,
    });
  }

  public startPtt(sessionId: string, inputId: string = randomUUID(), locale = "zh-CN"): string {
    if (this.#capture !== undefined) throw new Error("capture_already_active");
    if (this.#finalizing.has(inputId)) throw new Error("input_id_collision");
    const capture: Capture = {
      sessionId,
      inputId,
      sourceEventId: randomUUID(),
      locale,
      chunks: [],
      bytes: 0,
      epoch: this.#epoch,
      controller: new AbortController(),
    };
    this.#capture = capture;
    this.event({
      type: "capture_state",
      sessionId,
      inputId,
      state: "capturing",
      reasonCode: "ptt_started",
      actualFormat: REQUIRED_PCM_FORMAT,
    });
    return inputId;
  }

  public pushPcm(frame: Uint8Array, format = REQUIRED_PCM_FORMAT): void {
    const capture = this.capture();
    if (
      format.sampleRate !== REQUIRED_PCM_FORMAT.sampleRate ||
      format.channels !== REQUIRED_PCM_FORMAT.channels ||
      format.encoding !== REQUIRED_PCM_FORMAT.encoding ||
      frame.byteLength === 0
    )
      throw new Error("invalid_pcm16_frame");
    if (capture.bytes + frame.byteLength > MAX_CAPTURE_BYTES) throw new Error("capture_limit_exceeded");
    capture.chunks.push(frame.slice());
    capture.bytes += frame.byteLength;
  }

  /** UI-only; consumers must never route this into Agent, todo, or game actions. */
  public partial(text: string): void {
    const capture = this.capture();
    this.event({ type: "partial_transcript", sessionId: capture.sessionId, inputId: capture.inputId, text });
  }

  public async stopPtt(reasonCode = "ptt_released", timestampMs = Date.now()): Promise<string | null> {
    const capture = this.capture();
    this.#capture = undefined;
    this.#finalizing.set(capture.inputId, capture);
    this.event({
      type: "capture_state",
      sessionId: capture.sessionId,
      inputId: capture.inputId,
      state: "finalizing",
      reasonCode,
      actualFormat: REQUIRED_PCM_FORMAT,
    });
    try {
      const text = await this.asr.transcribe(concat(capture.chunks), capture.locale, capture.controller.signal);
      if (capture.controller.signal.aborted || capture.epoch !== this.#epoch) return null;
      if (capture.terminalState !== undefined) return null;
      capture.terminalState = "final_transcript";
      this.event({
        type: "final_transcript",
        sessionId: capture.sessionId,
        sourceEventId: capture.sourceEventId,
        inputId: capture.inputId,
        text,
        locale: capture.locale,
        providerId: this.asr.providerId,
        modelRevision: this.asr.modelRevision,
        timestampMs,
        actualFormat: REQUIRED_PCM_FORMAT,
      });
      return text;
    } catch (error) {
      if (!capture.controller.signal.aborted && capture.epoch === this.#epoch) {
        if (capture.terminalState !== undefined) return null;
        const reasonCode = asrFailureReason(error);
        capture.terminalState = "failed";
        this.event({
          type: "capture_state",
          sessionId: capture.sessionId,
          inputId: capture.inputId,
          state: "failed",
          reasonCode,
          actualFormat: REQUIRED_PCM_FORMAT,
        });
        this.event({
          type: "asr_failure",
          sessionId: capture.sessionId,
          inputId: capture.inputId,
          locale: capture.locale,
          providerId: this.asr.providerId,
          modelRevision: this.asr.modelRevision,
          reasonCode,
          timestampMs,
        });
      }
      return null;
    } finally {
      this.#finalizing.delete(capture.inputId);
    }
  }

  public cancelCapture(reasonCode = "capture_cancelled"): void {
    if (this.#capture !== undefined) {
      const capture = this.#capture;
      this.#capture = undefined;
      capture.controller.abort(reasonCode);
      this.emitCaptureCancelled(capture, reasonCode);
    }
    for (const capture of this.#finalizing.values()) {
      capture.controller.abort(reasonCode);
      this.emitCaptureCancelled(capture, reasonCode);
    }
  }

  public queueSpeech(job: SpeechJob, nowMs = Date.now()): boolean {
    if (job.direction !== undefined && !this.capabilities.perUtteranceDirection)
      return this.speech(job, "failed", "speech_direction_not_supported");
    if (!this.capabilities.ready) return this.speech(job, "failed", "speech_not_ready");
    if (!this.supportsVoiceProfile(job.voiceProfile)) return this.speech(job, "failed", "voice_profile_not_configured");
    if (job.epoch !== this.#epoch || job.expiresAtMs <= nowMs || job.text.length === 0)
      return this.speech(job, "cancelled", "stale_or_expired");
    if (this.#queue.length >= MAX_SPEECH_QUEUE) return this.speech(job, "failed", "speech_queue_full");
    this.#queue.push(job);
    return this.speech(job, "queued", "queued");
  }

  public cancelSpeech(jobId: string, reasonCode = "speech_cancelled"): void {
    const queuedIndex = this.#queue.findIndex((job) => job.jobId === jobId);
    if (queuedIndex >= 0) this.speech(this.#queue.splice(queuedIndex, 1)[0]!, "cancelled", reasonCode);
    const active = this.#activeSpeech.get(jobId);
    if (active?.job.interruptible && !active.cancelled) {
      active.cancelled = true;
      active.controller.abort(reasonCode);
      this.mixer.stop();
      this.speech(active.job, "cancelled", reasonCode);
    }
  }

  /** A single mixer owner; concurrent enqueue calls share this worker. */
  public drain(): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;
    this.#drainPromise = this.drainQueue().finally(() => {
      this.#drainPromise = undefined;
    });
    return this.#drainPromise;
  }

  private async drainQueue(): Promise<void> {
    while (this.#queue.length > 0) {
      const job = this.#queue.shift()!;
      if (job.epoch !== this.#epoch) continue;
      const active: ActiveSpeech = { job, controller: new AbortController(), cancelled: false };
      this.#activeSpeech.set(job.jobId, active);
      this.speech(job, "started", "started");
      let first = true;
      let audioBytes = 0;
      try {
        for await (const pcm16 of this.tts.synthesize(job, active.controller.signal)) {
          if (active.controller.signal.aborted || active.cancelled || job.epoch !== this.#epoch) break;
          if (pcm16.byteLength === 0) throw new Error("empty_tts_audio_chunk");
          audioBytes += pcm16.byteLength;
          if (audioBytes > MAX_SPEECH_AUDIO_BYTES) throw new Error("speech_audio_limit_exceeded");
          if (first) {
            first = false;
            this.speech(job, "first_audio", "first_audio");
          }
          await this.mixer.play(job.jobId, job.epoch, pcm16);
        }
        if (!active.cancelled && !active.controller.signal.aborted && job.epoch === this.#epoch) {
          if (first) this.speech(job, "failed", "tts_no_audio");
          else this.speech(job, "completed", "completed");
        }
      } catch {
        if (!active.cancelled && !active.controller.signal.aborted && job.epoch === this.#epoch)
          this.speech(job, "failed", "tts_failed");
      } finally {
        this.#activeSpeech.delete(job.jobId);
      }
    }
  }

  /** Idempotent and voice-only. It never waits for provider/network work or cancels Game Actions. */
  public stopAll(reasonCode = "stop_all"): void {
    this.#epoch++;
    this.cancelCapture(reasonCode);
    for (const active of this.#activeSpeech.values()) {
      if (active.cancelled) continue;
      active.cancelled = true;
      active.controller.abort(reasonCode);
      this.speech(active.job, "cancelled", reasonCode);
    }
    for (const job of this.#queue.splice(0)) this.speech(job, "cancelled", reasonCode);
    this.mixer.stop();
  }

  private capture(): Capture {
    if (this.#capture === undefined) throw new Error("capture_not_active");
    return this.#capture;
  }
  private emitCaptureCancelled(capture: Capture, reasonCode: string): void {
    if (capture.terminalState !== undefined) return;
    capture.terminalState = "cancelled";
    this.event({
      type: "capture_state",
      sessionId: capture.sessionId,
      inputId: capture.inputId,
      state: "cancelled",
      reasonCode,
      actualFormat: REQUIRED_PCM_FORMAT,
    });
  }
  private speech(
    job: SpeechJob,
    state: Extract<GatewayEvent, { type: "speech_state" }>["state"],
    reasonCode: string,
  ): boolean {
    this.event({
      type: "speech_state",
      sessionId: job.sessionId,
      jobId: job.jobId,
      epoch: job.epoch,
      state,
      reasonCode,
    });
    return state === "queued";
  }
  private event(event: GatewayEvent): void {
    this.#events.push(Object.freeze(event));
    const excess = this.#events.length - MAX_EVENT_HISTORY;
    if (excess > 0) {
      this.#events.splice(0, excess);
      this.#eventBase += excess;
    }
  }
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
/** Preserve a bounded local runtime diagnostic without exposing audio/text/path data. */
function asrFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "asr_failed";
  if (error.message === "sensevoice_no_speech") return "asr_no_speech";
  if (error.message.startsWith("sensevoice_runtime_failed:")) return "asr_runtime_failed";
  return "asr_failed";
}
