export const VOICE_PROTOCOL_VERSION = 1;
/** Maximum encoded NDJSON record size, including its trailing LF. */
export const MAX_NDJSON_FRAME_BYTES = 64 * 1024;
export const MAX_VOICE_TEXT_LENGTH = 4_000;
export const MAX_VOICE_DIRECTION_LENGTH = 1_000;

export const REQUIRED_PCM_FORMAT = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  encoding: "pcm_s16le" as const,
});
export type PcmFormat = typeof REQUIRED_PCM_FORMAT;

export type VoiceGatewayEvent =
  | Readonly<{ type: "capture_state"; sessionId: string; inputId: string; state: "capturing" | "finalizing" | "cancelled" | "failed"; reasonCode: string; actualFormat?: PcmFormat }>
  | Readonly<{ type: "partial_transcript"; sessionId: string; inputId: string; text: string }>
  | FinalTranscriptEvent
  | Readonly<{ type: "asr_failure"; sessionId: string; inputId: string; locale: string; providerId: string; modelRevision: string; reasonCode: string; timestampMs: number }>
  | Readonly<{ type: "speech_state"; sessionId: string; jobId: string; epoch: number; state: "queued" | "started" | "first_audio" | "completed" | "cancelled" | "failed"; reasonCode: string }>;
export type FinalTranscriptEvent = Readonly<{ type: "final_transcript"; sessionId: string; sourceEventId: string; inputId: string; text: string; locale: string; providerId: string; modelRevision: string; timestampMs: number; actualFormat: PcmFormat }>;
export type VoiceSpeechJob = Readonly<{ jobId: string; sessionId: string; epoch: number; sourceEventId: string; text: string; locale: string; voiceProfile: string; expiresAtMs: number; interruptible: boolean; direction?: string }>;
export type VoiceGatewayCapabilities = Readonly<{ providerId: string; modelRevision: string; perUtteranceDirection: boolean; ready: boolean; epoch: number }>;

export type VoiceGatewayRequest =
  | Readonly<{ type: "hello"; requestId: string; token: string; protocolVersion: number }>
  | Readonly<{ type: "health"; requestId: string; voiceProfile?: string }>
  | Readonly<{ type: "ptt_start"; requestId: string; sessionId: string; inputId?: string; locale?: string }>
  | Readonly<{ type: "ptt_frame"; requestId: string; pcm16Base64: string; format?: PcmFormat }>
  | Readonly<{ type: "ptt_stop"; requestId: string; reasonCode?: string }>
  | Readonly<{ type: "capture_cancel"; requestId: string; reasonCode?: string }>
  | Readonly<{ type: "speech_enqueue"; requestId: string; job: VoiceSpeechJob }>
  | Readonly<{ type: "speech_cancel"; requestId: string; jobId: string; reasonCode?: string }>
  | Readonly<{ type: "stop_all"; requestId: string; reasonCode?: string }>
  | Readonly<{ type: "events"; requestId: string; after?: number; sessionId: string }>;
export type VoiceGatewayResponse =
  | Readonly<{ type: "hello_ack"; requestId: string; protocolVersion: number }>
  | Readonly<{ type: "health"; requestId: string; status: "ready" | "unavailable"; protocolVersion: number; capabilities: VoiceGatewayCapabilities }>
  | Readonly<{ type: "accepted"; requestId: string; value?: string | boolean }>
  | Readonly<{ type: "events"; requestId: string; events: readonly VoiceGatewayEvent[]; next: number }>
  | Readonly<{ type: "error"; requestId: string | null; reasonCode: string }>;

export function isOpaqueId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value); }
export function isSourceEventId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
export function isVoiceGatewayToken(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(value); }
export function isLocale(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value); }
export function isReasonCode(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_:-]{1,96}$/.test(value); }
export function isNonnegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function isRequiredPcmFormat(value: unknown): value is PcmFormat { return hasExactKeys(value, ["sampleRate", "channels", "encoding"]) && value.sampleRate === 16_000 && value.channels === 1 && value.encoding === "pcm_s16le"; }
export function isFinalTranscriptEvent(value: unknown): value is FinalTranscriptEvent { return isEvent(value) && value.type === "final_transcript"; }
export function isVoiceGatewayEvent(value: unknown): value is VoiceGatewayEvent { return isEvent(value); }
export function isVoiceSpeechJob(value: unknown): value is VoiceSpeechJob {
  return hasExactKeys(value, ["jobId", "sessionId", "epoch", "sourceEventId", "text", "locale", "voiceProfile", "expiresAtMs", "interruptible"], ["direction"])
    && isOpaqueId(value.jobId) && isOpaqueId(value.sessionId) && isNonnegativeSafeInteger(value.epoch) && isSourceEventId(value.sourceEventId)
    && isText(value.text) && isLocale(value.locale) && isOpaqueId(value.voiceProfile) && isFiniteNumber(value.expiresAtMs)
    && typeof value.interruptible === "boolean" && (value.direction === undefined || isDirection(value.direction));
}
export function isVoiceGatewayCapabilities(value: unknown): value is VoiceGatewayCapabilities {
  return hasExactKeys(value, ["providerId", "modelRevision", "perUtteranceDirection", "ready", "epoch"])
    && isOpaqueId(value.providerId) && isOpaqueId(value.modelRevision) && typeof value.perUtteranceDirection === "boolean"
    && typeof value.ready === "boolean" && isNonnegativeSafeInteger(value.epoch);
}

export function isVoiceGatewayRequest(value: unknown): value is VoiceGatewayRequest {
  if (!isRecord(value) || !isOpaqueId(value.requestId) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello": return hasExactKeys(value, ["type", "requestId", "token", "protocolVersion"]) && isVoiceGatewayToken(value.token) && value.protocolVersion === VOICE_PROTOCOL_VERSION;
    case "health": return hasExactKeys(value, ["type", "requestId"], ["voiceProfile"]) && (value.voiceProfile === undefined || isOpaqueId(value.voiceProfile));
    case "ptt_start": return hasExactKeys(value, ["type", "requestId", "sessionId"], ["inputId", "locale"]) && isOpaqueId(value.sessionId) && (value.inputId === undefined || isOpaqueId(value.inputId)) && (value.locale === undefined || isLocale(value.locale));
    case "ptt_frame": return hasExactKeys(value, ["type", "requestId", "pcm16Base64"], ["format"]) && isBase64(value.pcm16Base64) && value.pcm16Base64.length > 0 && (value.format === undefined || isRequiredPcmFormat(value.format));
    case "ptt_stop": case "capture_cancel": case "stop_all": return hasExactKeys(value, ["type", "requestId"], ["reasonCode"]) && (value.reasonCode === undefined || isReasonCode(value.reasonCode));
    case "speech_cancel": return hasExactKeys(value, ["type", "requestId", "jobId"], ["reasonCode"]) && isOpaqueId(value.jobId) && (value.reasonCode === undefined || isReasonCode(value.reasonCode));
    case "speech_enqueue": return hasExactKeys(value, ["type", "requestId", "job"]) && isVoiceSpeechJob(value.job);
    case "events": return hasExactKeys(value, ["type", "requestId", "sessionId"], ["after"]) && isOpaqueId(value.sessionId) && (value.after === undefined || isNonnegativeSafeInteger(value.after));
    default: return false;
  }
}
export function parseVoiceGatewayRequest(line: string): VoiceGatewayRequest | null {
  const value = parseRecord(line); return isVoiceGatewayRequest(value) ? value : null;
}
export function isVoiceGatewayResponse(value: unknown): value is VoiceGatewayResponse {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello_ack": return hasExactKeys(value, ["type", "requestId", "protocolVersion"]) && isOpaqueId(value.requestId) && value.protocolVersion === VOICE_PROTOCOL_VERSION;
    case "health": return hasExactKeys(value, ["type", "requestId", "status", "protocolVersion", "capabilities"]) && isOpaqueId(value.requestId) && (value.status === "ready" || value.status === "unavailable") && value.protocolVersion === VOICE_PROTOCOL_VERSION && isVoiceGatewayCapabilities(value.capabilities);
    case "accepted": return hasExactKeys(value, ["type", "requestId"], ["value"]) && isOpaqueId(value.requestId) && (value.value === undefined || typeof value.value === "boolean" || typeof value.value === "string");
    case "events": return hasExactKeys(value, ["type", "requestId", "events", "next"]) && isOpaqueId(value.requestId) && Array.isArray(value.events) && value.events.every(isVoiceGatewayEvent) && isNonnegativeSafeInteger(value.next);
    case "error": return hasExactKeys(value, ["type", "requestId", "reasonCode"]) && (value.requestId === null || isOpaqueId(value.requestId)) && isReasonCode(value.reasonCode);
    default: return false;
  }
}
export function parseVoiceGatewayResponse(line: string): VoiceGatewayResponse | null {
  const value = parseRecord(line); return isVoiceGatewayResponse(value) ? value : null;
}

export class BoundedUtf8NdjsonDecoder {
  #pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  public constructor(private readonly policy: Readonly<{ maxRecordBytes: number; maxBufferedBytes: number }>) {
    if (!isPositiveSafeInteger(policy.maxRecordBytes) || !isPositiveSafeInteger(policy.maxBufferedBytes) || policy.maxBufferedBytes < policy.maxRecordBytes) throw new Error("invalid_ndjson_policy");
  }
  public push(chunk: Uint8Array): readonly string[] {
    const merged = concat(this.#pending, chunk); const frames: string[] = []; let start = 0;
    try {
      for (;;) {
        const newline = merged.indexOf(0x0a, start); if (newline < 0) break;
        const frame = merged.subarray(start, newline);
        if (frame.byteLength === 0) throw new Error("voice_ndjson_empty_record");
        if (frame[frame.byteLength - 1] === 0x0d) throw new Error("voice_ndjson_crlf_not_allowed");
        if (frame.byteLength + 1 > this.policy.maxRecordBytes) throw new Error("voice_ndjson_record_too_large");
        frames.push(this.#decoder.decode(frame)); start = newline + 1;
      }
      this.#pending = merged.subarray(start);
      if (this.#pending.byteLength >= this.policy.maxRecordBytes || this.#pending.byteLength > this.policy.maxBufferedBytes) throw new Error("voice_ndjson_buffer_too_large");
      return frames;
    } catch (error) { this.#pending = new Uint8Array(0); throw error; }
  }
  public finish(): void {
    try { if (this.#pending.byteLength !== 0) throw new Error("voice_ndjson_incomplete_trailing_data"); }
    finally { this.#pending = new Uint8Array(0); }
  }
}
export function createBoundedUtf8NdjsonDecoder(policy: Readonly<{ maxRecordBytes: number; maxBufferedBytes: number }>): BoundedUtf8NdjsonDecoder { return new BoundedUtf8NdjsonDecoder(policy); }
export function encodeVoiceGatewayMessage(message: VoiceGatewayRequest | VoiceGatewayResponse): string {
  if (!isVoiceGatewayRequest(message) && !isVoiceGatewayResponse(message)) throw new Error("invalid_voice_gateway_message");
  const frame = `${JSON.stringify(message)}\n`; if (new TextEncoder().encode(frame).byteLength > MAX_NDJSON_FRAME_BYTES) throw new Error("voice_ndjson_frame_too_large"); return frame;
}

function isEvent(value: unknown): value is VoiceGatewayEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "capture_state": return hasExactKeys(value, ["type", "sessionId", "inputId", "state", "reasonCode"], ["actualFormat"]) && isOpaqueId(value.sessionId) && isOpaqueId(value.inputId) && isOneOf(value.state, ["capturing", "finalizing", "cancelled", "failed"]) && isReasonCode(value.reasonCode) && (value.actualFormat === undefined || isRequiredPcmFormat(value.actualFormat));
    case "partial_transcript": return hasExactKeys(value, ["type", "sessionId", "inputId", "text"]) && isOpaqueId(value.sessionId) && isOpaqueId(value.inputId) && isText(value.text);
    case "final_transcript": return hasExactKeys(value, ["type", "sessionId", "sourceEventId", "inputId", "text", "locale", "providerId", "modelRevision", "timestampMs", "actualFormat"]) && isOpaqueId(value.sessionId) && isSourceEventId(value.sourceEventId) && isOpaqueId(value.inputId) && isText(value.text) && isLocale(value.locale) && isOpaqueId(value.providerId) && isOpaqueId(value.modelRevision) && isFiniteNumber(value.timestampMs) && isRequiredPcmFormat(value.actualFormat);
    case "asr_failure": return hasExactKeys(value, ["type", "sessionId", "inputId", "locale", "providerId", "modelRevision", "reasonCode", "timestampMs"]) && isOpaqueId(value.sessionId) && isOpaqueId(value.inputId) && isLocale(value.locale) && isOpaqueId(value.providerId) && isOpaqueId(value.modelRevision) && isReasonCode(value.reasonCode) && isFiniteNumber(value.timestampMs);
    case "speech_state": return hasExactKeys(value, ["type", "sessionId", "jobId", "epoch", "state", "reasonCode"]) && isOpaqueId(value.sessionId) && isOpaqueId(value.jobId) && isNonnegativeSafeInteger(value.epoch) && isOneOf(value.state, ["queued", "started", "first_audio", "completed", "cancelled", "failed"]) && isReasonCode(value.reasonCode);
    default: return false;
  }
}
function parseRecord(line: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(line); return isRecord(value) ? value : null; } catch { return null; } }
function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> { if (!isRecord(value)) return false; const keys = Object.keys(value); return keys.length >= required.length && required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_VOICE_TEXT_LENGTH; }
function isDirection(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_VOICE_DIRECTION_LENGTH; }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isOneOf(value: unknown, values: readonly string[]): boolean { return typeof value === "string" && values.includes(value); }
function isBase64(value: unknown): value is string { return typeof value === "string" && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value); }
function isPositiveSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBufferLike> { const result = new Uint8Array(left.byteLength + right.byteLength); result.set(left); result.set(right, left.byteLength); return result; }
