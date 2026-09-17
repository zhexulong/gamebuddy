import { MAX_NDJSON_FRAME_BYTES } from "./index.js";

/**
 * Protocol v2 line contract — frozen Slice 1 surface.
 *
 * This module is the single authoritative definition of the Phase 2 streaming
 * wire protocol. It is additive: v1 (`./index.js`) remains the current
 * production contract and is not modified here. A peer that speaks v2 must
 * verify `VOICE_PROTOCOL_VERSION_V2` during its hello handshake; the v1
 * validator rejects v2 frames and vice versa (cross-version rejection is
 * covered by the deterministic tests in `./v2.test.ts`).
 *
 * Governance: the illustrative draft in `design/domains/voice/streaming-audio-architecture.md`
 * §7 is superseded for wire purposes by this file once frozen. These types are
 * plain records with strictly validated fields; they carry no server, queue,
 * replay-cache or quarantine machinery. Host-owned presentation admission and
 * Chat/Game authority boundaries remain unchanged: nothing in v2 mutates Chat
 * durable state or cancels Game actions.
 */
export const VOICE_PROTOCOL_VERSION_V2 = 2;

/** Every v2 message carries these envelope fields when it is a request or event. */
export type VoiceProtocolEnvelope = Readonly<{
  protocolVersion: 2;
  sessionId: string;
  connectionEpoch: number;
  timestampMs: number;
}>;

/** Public, redacted gateway state. Never leaks device names or internal diagnostics. */
export type VoiceGatewayPublicState = Readonly<{
  ready: boolean;
  capture: "ready" | "unavailable" | "denied";
  speech: "ready" | "unavailable" | "denied";
  reasonCode?: "ok" | "device_missing" | "permission_denied" | "quarantined" | "quarantined_cleanup_failed";
}>;

/** Terminal lifecycle statuses. `failed` does not collapse distinct outcomes. */
export type SpeechJobTerminalStatus =
  | "not_accepted"
  | "accepted_running"
  | "completed"
  | "cancelled"
  | "failed_before_side_effect"
  | "unknown_after_admission"
  | "quarantined";

export type VoiceGatewayRequestV2 =
  | (EnvelopeFields &
      Readonly<{
        type: "stream_speech_chunk";
        requestId: string;
        speechJobId: string;
        chunkIndex: number;
        deltaText: string;
        isFinalChunk: boolean;
        voiceProfile?: string;
        deadlineMs: number;
      }>)
  | (EnvelopeFields &
      Readonly<{ type: "cancel_speech"; requestId: string; speechJobId?: string; reason: string }>)
  | (EnvelopeFields & Readonly<{ type: "cancel_capture"; requestId: string; reason: string }>)
  | (EnvelopeFields & Readonly<{ type: "stop_all"; requestId: string; reason: string }>);

export type VoiceGatewayEventV2 =
  | (EnvelopeFields &
      Readonly<{
        type: "final_transcript";
        sourceEventId: string;
        inputId: string;
        text: string;
        locale: string;
        providerId: string;
        timestampMs: number;
        actualFormat: Readonly<{ sampleRate: number; channels: number; encoding: "pcm_s16le" }>;
      }>)
  | (EnvelopeFields &
      Readonly<{
        type: "playback_observation";
        speechJobId: string;
        audioEndMs: number;
        truncatedText?: string;
        terminalStatus: SpeechJobTerminalStatus;
      }>)
  | (EnvelopeFields & Readonly<{ type: "gateway_state"; state: VoiceGatewayPublicState }>);

type EnvelopeFields = Pick<VoiceProtocolEnvelope, "protocolVersion" | "sessionId" | "connectionEpoch" | "timestampMs">;

const TERMINAL_STATUSES: readonly SpeechJobTerminalStatus[] = [
  "not_accepted",
  "accepted_running",
  "completed",
  "cancelled",
  "failed_before_side_effect",
  "unknown_after_admission",
  "quarantined",
];
const PUBLIC_REASON_CODES: readonly NonNullable<VoiceGatewayPublicState["reasonCode"]>[] = [
  "ok",
  "device_missing",
  "permission_denied",
  "quarantined",
  "quarantined_cleanup_failed",
];

function hasEnvelope(value: Record<string, unknown>): value is EnvelopeFields & Record<string, unknown> {
  return (
    value.protocolVersion === VOICE_PROTOCOL_VERSION_V2 &&
    isOpaqueId(value.sessionId) &&
    isNonnegativeSafeInteger(value.connectionEpoch) &&
    isFiniteNumber(value.timestampMs)
  );
}

export function isVoiceGatewayPublicState(value: unknown): value is VoiceGatewayPublicState {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const hasOptionalReason = keys.includes("reasonCode");
  if (hasOptionalReason && !(PUBLIC_REASON_CODES as readonly string[]).includes(value.reasonCode as string)) return false;
  const required = ["ready", "capture", "speech"];
  return (
    keys.length === required.length + (hasOptionalReason ? 1 : 0) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    typeof value.ready === "boolean" &&
    (value.capture === "ready" || value.capture === "unavailable" || value.capture === "denied") &&
    (value.speech === "ready" || value.speech === "unavailable" || value.speech === "denied")
  );
}

export function isSpeechJobTerminalStatus(value: unknown): value is SpeechJobTerminalStatus {
  return typeof value === "string" && (TERMINAL_STATUSES as readonly string[]).includes(value);
}

export function isVoiceGatewayEventV2(value: unknown): value is VoiceGatewayEventV2 {
  if (!isRecord(value) || !hasEnvelope(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "final_transcript":
      return (
        hasExactKeys(value, [
          "protocolVersion",
          "sessionId",
          "connectionEpoch",
          "timestampMs",
          "type",
          "sourceEventId",
          "inputId",
          "text",
          "locale",
          "providerId",
          "actualFormat",
        ]) &&
        isSourceEventId(value.sourceEventId) &&
        isOpaqueId(value.inputId) &&
        isText(value.text) &&
        isLocale(value.locale) &&
        isOpaqueId(value.providerId) &&
        isRequiredPcmFormat(value.actualFormat)
      );
    case "playback_observation":
      return (
        hasExactKeys(value, [
          "protocolVersion",
          "sessionId",
          "connectionEpoch",
          "timestampMs",
          "type",
          "speechJobId",
          "audioEndMs",
          "terminalStatus",
        ], ["truncatedText"]) &&
        isOpaqueId(value.speechJobId) &&
        isNonnegativeSafeInteger(value.audioEndMs) &&
        isSpeechJobTerminalStatus(value.terminalStatus) &&
        (value.truncatedText === undefined || isText(value.truncatedText))
      );
    case "gateway_state":
      return (
        hasExactKeys(value, [
          "protocolVersion",
          "sessionId",
          "connectionEpoch",
          "timestampMs",
          "type",
          "state",
        ]) && isVoiceGatewayPublicState(value.state)
      );
    default:
      return false;
  }
}

export function isVoiceGatewayRequestV2(value: unknown): value is VoiceGatewayRequestV2 {
  if (!isRecord(value) || !hasEnvelope(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "stream_speech_chunk":
      return (
        hasExactKeys(value, [
          "protocolVersion",
          "sessionId",
          "connectionEpoch",
          "timestampMs",
          "type",
          "requestId",
          "speechJobId",
          "chunkIndex",
          "deltaText",
          "isFinalChunk",
          "deadlineMs",
        ], ["voiceProfile"]) &&
        isOpaqueId(value.requestId) &&
        isOpaqueId(value.speechJobId) &&
        isNonnegativeSafeInteger(value.chunkIndex) &&
        isText(value.deltaText) &&
        typeof value.isFinalChunk === "boolean" &&
        (value.voiceProfile === undefined || isOpaqueId(value.voiceProfile)) &&
        isNonnegativeSafeInteger(value.deadlineMs)
      );
    case "cancel_speech":
      return (
        hasExactKeys(value, [
          "protocolVersion",
          "sessionId",
          "connectionEpoch",
          "timestampMs",
          "type",
          "requestId",
          "reason",
        ], ["speechJobId"]) &&
        isOpaqueId(value.requestId) &&
        (value.speechJobId === undefined || isOpaqueId(value.speechJobId)) &&
        isReasonCode(value.reason)
      );
    case "cancel_capture":
      return (
        hasExactKeys(value, [
          "protocolVersion",
          "sessionId",
          "connectionEpoch",
          "timestampMs",
          "type",
          "requestId",
          "reason",
        ]) &&
        isOpaqueId(value.requestId) &&
        isReasonCode(value.reason)
      );
    case "stop_all":
      return (
        hasExactKeys(value, [
          "protocolVersion",
          "sessionId",
          "connectionEpoch",
          "timestampMs",
          "type",
          "requestId",
          "reason",
        ]) &&
        isOpaqueId(value.requestId) &&
        isReasonCode(value.reason)
      );
    default:
      return false;
  }
}

export function parseVoiceGatewayRequestV2(line: string): VoiceGatewayRequestV2 | null {
  const value = parseRecord(line);
  return isVoiceGatewayRequestV2(value) ? value : null;
}

export function parseVoiceGatewayEventV2(line: string): VoiceGatewayEventV2 | null {
  const value = parseRecord(line);
  return isVoiceGatewayEventV2(value) ? value : null;
}

/** Encode a v2 message as one bounded NDJSON frame. */
export function encodeVoiceGatewayMessageV2(message: VoiceGatewayRequestV2 | VoiceGatewayEventV2): string {
  if (!isVoiceGatewayRequestV2(message) && !isVoiceGatewayEventV2(message)) throw new Error("invalid_voice_gateway_v2_message");
  const frame = `${JSON.stringify(message)}\n`;
  if (new TextEncoder().encode(frame).byteLength > MAX_NDJSON_FRAME_BYTES) throw new Error("voice_ndjson_frame_too_large");
  return frame;
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length >= required.length &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}
function isSourceEventId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function isLocale(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);
}
function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,96}$/.test(value);
}
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_000;
}
function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isRequiredPcmFormat(value: unknown): value is Readonly<{ sampleRate: number; channels: number; encoding: "pcm_s16le" }> {
  return (
    isRecord(value) &&
    value.sampleRate === 16_000 &&
    value.channels === 1 &&
    value.encoding === "pcm_s16le"
  );
}