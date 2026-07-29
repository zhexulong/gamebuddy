import { randomUUID } from "node:crypto";

export const VOICE_GATEWAY_PROTOCOL_VERSION = 1;
export const REQUIRED_PCM_FORMAT = Object.freeze({ sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" as const });
export const MAX_CAPTURE_BYTES = 960_000;
export const MAX_SPEECH_QUEUE = 3;
export const MAX_SPEECH_AUDIO_BYTES = 1_920_000;

export type PcmFormat = typeof REQUIRED_PCM_FORMAT;
export type GatewayEvent =
  | Readonly<{ type: "capture_state"; inputId: string; state: "capturing" | "finalizing" | "cancelled" | "failed"; reasonCode: string; actualFormat?: PcmFormat }>
  | Readonly<{ type: "partial_transcript"; inputId: string; text: string }>
  | Readonly<{ type: "final_transcript"; sessionId: string; inputId: string; text: string; locale: string; providerId: string; modelRevision: string; timestampMs: number; actualFormat: PcmFormat }>
  | Readonly<{ type: "asr_failure"; sessionId: string; inputId: string; locale: string; providerId: string; modelRevision: string; reasonCode: string; timestampMs: number }>
  | Readonly<{ type: "speech_state"; jobId: string; epoch: number; state: "queued" | "started" | "first_audio" | "completed" | "cancelled" | "failed"; reasonCode: string }>;

export type SpeechJob = Readonly<{ jobId: string; sessionId: string; epoch: number; sourceEventId: string; text: string; locale: string; voiceProfile: string; expiresAtMs: number; interruptible: boolean }>;
export interface AsrProvider { readonly providerId: string; readonly modelRevision: string; transcribe(pcm16: Uint8Array, locale: string, signal: AbortSignal): Promise<string>; }
export interface TtsProvider { readonly providerId: string; readonly modelRevision: string; synthesize(job: SpeechJob, signal: AbortSignal): AsyncIterable<Uint8Array>; }
export interface Mixer { play(jobId: string, epoch: number, pcm16: Uint8Array): void; stop(): void; }

type Capture = { sessionId: string; inputId: string; locale: string; chunks: Uint8Array[]; bytes: number; epoch: number; controller: AbortController; };
type ActiveSpeech = { job: SpeechJob; controller: AbortController; cancelled: boolean; };

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

  public constructor(private readonly asr: AsrProvider, private readonly tts: TtsProvider, private readonly mixer: Mixer) {}
  public get epoch(): number { return this.#epoch; }
  public get events(): readonly GatewayEvent[] { return this.#events; }

  public startPtt(sessionId: string, inputId: string = randomUUID(), locale = "zh-CN"): string {
    if (this.#capture !== undefined) throw new Error("capture_already_active");
    const capture: Capture = { sessionId, inputId, locale, chunks: [], bytes: 0, epoch: this.#epoch, controller: new AbortController() };
    this.#capture = capture;
    this.event({ type: "capture_state", inputId, state: "capturing", reasonCode: "ptt_started", actualFormat: REQUIRED_PCM_FORMAT });
    return inputId;
  }

  public pushPcm(frame: Uint8Array, format = REQUIRED_PCM_FORMAT): void {
    const capture = this.capture();
    if (format.sampleRate !== REQUIRED_PCM_FORMAT.sampleRate || format.channels !== REQUIRED_PCM_FORMAT.channels || format.encoding !== REQUIRED_PCM_FORMAT.encoding || frame.byteLength === 0) throw new Error("invalid_pcm16_frame");
    if (capture.bytes + frame.byteLength > MAX_CAPTURE_BYTES) throw new Error("capture_limit_exceeded");
    capture.chunks.push(frame.slice()); capture.bytes += frame.byteLength;
  }

  /** UI-only; consumers must never route this into Agent, todo, or game actions. */
  public partial(text: string): void { this.event({ type: "partial_transcript", inputId: this.capture().inputId, text }); }

  public async stopPtt(reasonCode = "ptt_released", timestampMs = Date.now()): Promise<string | null> {
    const capture = this.capture();
    this.#capture = undefined;
    this.#finalizing.set(capture.inputId, capture);
    this.event({ type: "capture_state", inputId: capture.inputId, state: "finalizing", reasonCode, actualFormat: REQUIRED_PCM_FORMAT });
    try {
      const text = await this.asr.transcribe(concat(capture.chunks), capture.locale, capture.controller.signal);
      if (capture.controller.signal.aborted || capture.epoch !== this.#epoch) return null;
      this.event({ type: "final_transcript", sessionId: capture.sessionId, inputId: capture.inputId, text, locale: capture.locale, providerId: this.asr.providerId, modelRevision: this.asr.modelRevision, timestampMs, actualFormat: REQUIRED_PCM_FORMAT });
      return text;
    } catch {
      if (!capture.controller.signal.aborted && capture.epoch === this.#epoch) {
        this.event({ type: "capture_state", inputId: capture.inputId, state: "failed", reasonCode: "asr_failed", actualFormat: REQUIRED_PCM_FORMAT });
        this.event({ type: "asr_failure", sessionId: capture.sessionId, inputId: capture.inputId, locale: capture.locale, providerId: this.asr.providerId, modelRevision: this.asr.modelRevision, reasonCode: "asr_failed", timestampMs });
      }
      return null;
    } finally { this.#finalizing.delete(capture.inputId); }
  }

  public cancelCapture(reasonCode = "capture_cancelled"): void {
    if (this.#capture !== undefined) {
      const capture = this.#capture; this.#capture = undefined; capture.controller.abort(reasonCode);
      this.event({ type: "capture_state", inputId: capture.inputId, state: "cancelled", reasonCode, actualFormat: REQUIRED_PCM_FORMAT });
    }
    for (const capture of this.#finalizing.values()) {
      capture.controller.abort(reasonCode);
      this.event({ type: "capture_state", inputId: capture.inputId, state: "cancelled", reasonCode, actualFormat: REQUIRED_PCM_FORMAT });
    }
  }

  public queueSpeech(job: SpeechJob, nowMs = Date.now()): boolean {
    if (job.epoch !== this.#epoch || job.expiresAtMs <= nowMs || job.text.length === 0) return this.speech(job, "cancelled", "stale_or_expired");
    if (this.#queue.length >= MAX_SPEECH_QUEUE) return this.speech(job, "failed", "speech_queue_full");
    this.#queue.push(job); return this.speech(job, "queued", "queued");
  }

  public cancelSpeech(jobId: string, reasonCode = "speech_cancelled"): void {
    const queuedIndex = this.#queue.findIndex((job) => job.jobId === jobId);
    if (queuedIndex >= 0) this.speech(this.#queue.splice(queuedIndex, 1)[0]!, "cancelled", reasonCode);
    const active = this.#activeSpeech.get(jobId);
    if (active !== undefined && active.job.interruptible) {
      active.cancelled = true; active.controller.abort(reasonCode); this.mixer.stop();
      this.speech(active.job, "cancelled", reasonCode);
    }
  }

  /** A single mixer owner; concurrent enqueue calls share this worker. */
  public drain(): Promise<void> {
    if (this.#drainPromise !== undefined) return this.#drainPromise;
    this.#drainPromise = this.drainQueue().finally(() => { this.#drainPromise = undefined; });
    return this.#drainPromise;
  }

  private async drainQueue(): Promise<void> {
    while (this.#queue.length > 0) {
      const job = this.#queue.shift()!;
      if (job.epoch !== this.#epoch) continue;
      const active: ActiveSpeech = { job, controller: new AbortController(), cancelled: false };
      this.#activeSpeech.set(job.jobId, active);
      this.speech(job, "started", "started"); let first = true; let audioBytes = 0;
      try {
        for await (const pcm16 of this.tts.synthesize(job, active.controller.signal)) {
          if (active.controller.signal.aborted || active.cancelled || job.epoch !== this.#epoch) break;
          if (pcm16.byteLength === 0) throw new Error("empty_tts_audio_chunk");
          audioBytes += pcm16.byteLength;
          if (audioBytes > MAX_SPEECH_AUDIO_BYTES) throw new Error("speech_audio_limit_exceeded");
          if (first) { first = false; this.speech(job, "first_audio", "first_audio"); }
          this.mixer.play(job.jobId, job.epoch, pcm16);
        }
        if (!active.cancelled && !active.controller.signal.aborted && job.epoch === this.#epoch) {
          if (first) this.speech(job, "failed", "tts_no_audio");
          else this.speech(job, "completed", "completed");
        }
      } catch {
        if (!active.cancelled && !active.controller.signal.aborted && job.epoch === this.#epoch) this.speech(job, "failed", "tts_failed");
      } finally { this.#activeSpeech.delete(job.jobId); }
    }
  }

  /** Idempotent and voice-only. It never waits for provider/network work or cancels Game Actions. */
  public stopAll(reasonCode = "stop_all"): void {
    this.#epoch++;
    this.cancelCapture(reasonCode);
    for (const active of this.#activeSpeech.values()) {
      active.cancelled = true; active.controller.abort(reasonCode); this.speech(active.job, "cancelled", reasonCode);
    }
    for (const job of this.#queue.splice(0)) this.speech(job, "cancelled", reasonCode);
    this.mixer.stop();
  }

  private capture(): Capture { if (this.#capture === undefined) throw new Error("capture_not_active"); return this.#capture; }
  private speech(job: SpeechJob, state: Extract<GatewayEvent, { type: "speech_state" }> ["state"], reasonCode: string): boolean { this.event({ type: "speech_state", jobId: job.jobId, epoch: job.epoch, state, reasonCode }); return state === "queued"; }
  private event(event: GatewayEvent): void { this.#events.push(Object.freeze(event)); }
}
function concat(parts: readonly Uint8Array[]): Uint8Array { const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0)); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; } return bytes; }
