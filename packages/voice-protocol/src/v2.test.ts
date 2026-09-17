import { strict as assert } from "node:assert";
import test from "node:test";

import {
  encodeVoiceGatewayMessageV2,
  isSpeechJobTerminalStatus,
  isVoiceGatewayEventV2,
  isVoiceGatewayPublicState,
  isVoiceGatewayRequestV2,
  parseVoiceGatewayEventV2,
  parseVoiceGatewayRequestV2,
  VOICE_PROTOCOL_VERSION_V2,
} from "./v2.js";
import {
  encodeVoiceGatewayMessage,
  isVoiceGatewayRequest,
  parseVoiceGatewayRequest,
} from "./index.js";

const envelope = {
  protocolVersion: VOICE_PROTOCOL_VERSION_V2,
  sessionId: "session_01",
  connectionEpoch: 3,
  timestampMs: 1_700_000_000_000,
} as const;

const requestFixture = Object.freeze({
  ...envelope,
  type: "stream_speech_chunk",
  requestId: "req_01",
  speechJobId: "job_01",
  chunkIndex: 0,
  deltaText: "你好",
  isFinalChunk: false,
  deadlineMs: 1_700_000_100_000,
} as const);

test("v2: stream_speech_chunk round-trips through the strict validator and bounded encoder", () => {
  assert.ok(isVoiceGatewayRequestV2(requestFixture));
  const frame = encodeVoiceGatewayMessageV2(requestFixture);
  assert.ok(frame.endsWith("\n"));
  const parsed = parseVoiceGatewayRequestV2(frame.slice(0, -1));
  assert.deepEqual(parsed, requestFixture);
});

test("v2: cancel_speech / cancel_capture / stop_all accept only exact keys and reason codes", () => {
  const cancelSpeech = { ...envelope, type: "cancel_speech", requestId: "req_02", reason: "barge_in" } as const;
  const cancelCapture = { ...envelope, type: "cancel_capture", requestId: "req_03", reason: "player_stop" } as const;
  const stopAll = { ...envelope, type: "stop_all", requestId: "req_04", reason: "surface_close" } as const;
  assert.ok(isVoiceGatewayRequestV2(cancelSpeech));
  assert.ok(isVoiceGatewayRequestV2({ ...cancelSpeech, speechJobId: "job_02" }));
  assert.ok(isVoiceGatewayRequestV2(cancelCapture));
  assert.ok(isVoiceGatewayRequestV2(stopAll));

  assert.ok(!isVoiceGatewayRequestV2({ ...cancelSpeech, reason: "illegal reason code with spaces" }));
  assert.ok(!isVoiceGatewayRequestV2({ ...cancelSpeech, extra: true }));
  assert.ok(!isVoiceGatewayRequestV2({ ...cancelSpeech, reason: undefined }));
  // The discriminator still governs: cancel_speech requires a reason, and a
  // speechJobId must match the opaque identifier shape when present.
  assert.ok(!isVoiceGatewayRequestV2({ ...cancelSpeech, reason: null }));
  assert.ok(!isVoiceGatewayRequestV2({ ...cancelSpeech, speechJobId: "bad job id!" }));
  assert.ok(!isVoiceGatewayRequestV2({ ...cancelSpeech, type: "stop_all" as const, reason: undefined }));
});

test("v2: envelope fields are mandatory and version-gated", () => {
  for (const missing of ["protocolVersion", "sessionId", "connectionEpoch", "timestampMs"]) {
    const { [missing]: _omitted, ...withoutField } = requestFixture;
    assert.ok(!isVoiceGatewayRequestV2(withoutField), `expected rejection without ${missing}`);
  }
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, protocolVersion: 1 }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, protocolVersion: undefined }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, connectionEpoch: -1 }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, sessionId: "" }));
});

test("v2: stream_speech_chunk binds chunk math, text bounds and optional voice profile", () => {
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, chunkIndex: -1 }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, chunkIndex: 1.5 }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, deltaText: "" }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, deltaText: "x".repeat(4_001) }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, isFinalChunk: "yes" }));
  assert.ok(!isVoiceGatewayRequestV2({ ...requestFixture, voiceProfile: "not an opaque id!" }));
  assert.ok(isVoiceGatewayRequestV2({ ...requestFixture, voiceProfile: "companion.default" }));
});

test("v2: final_transcript carries the authenticated source event id and strict PCM format", () => {
  const event = Object.freeze({
    ...envelope,
    type: "final_transcript",
    sourceEventId: "evt_01",
    inputId: "input_01",
    text: "早上好",
    locale: "zh-CN",
    providerId: "sensevoice-local",
    timestampMs: 1_700_000_000_500,
    actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
  } as const);
  assert.ok(isVoiceGatewayEventV2(event));
  assert.deepEqual(parseVoiceGatewayEventV2(encodeVoiceGatewayMessageV2(event).slice(0, -1)), event);
  assert.ok(!isVoiceGatewayEventV2({ ...event, sourceEventId: "" }));
  assert.ok(!isVoiceGatewayEventV2({ ...event, actualFormat: { sampleRate: 48_000, channels: 2, encoding: "pcm_s16le" } }));
  assert.ok(!isVoiceGatewayEventV2({ ...event, type: "final_transcriptt" }));
});

test("v2: playback_observation is a local observation with a distinct terminal status", () => {
  const interrupted = Object.freeze({
    ...envelope,
    type: "playback_observation",
    speechJobId: "job_01",
    audioEndMs: 1_240,
    terminalStatus: "unknown_after_admission",
  } as const);
  assert.ok(isVoiceGatewayEventV2(interrupted));
  assert.ok(isVoiceGatewayEventV2({ ...interrupted, truncatedText: "早上好...[被打断]" }));
  assert.ok(!isVoiceGatewayEventV2({ ...interrupted, audioEndMs: -1 }));
  assert.ok(!isVoiceGatewayEventV2({ ...interrupted, terminalStatus: "failed" }));
  assert.ok(!isVoiceGatewayEventV2({ ...interrupted, terminalStatus: undefined }));
  assert.ok(isSpeechJobTerminalStatus("quarantined"));
  assert.ok(!isSpeechJobTerminalStatus("mystery_state"));
});

test("v2: gateway_state projects a redacted public state without device names", () => {
  const healthy = Object.freeze({
    ...envelope,
    type: "gateway_state",
    state: { ready: true, capture: "ready", speech: "ready", reasonCode: "ok" },
  } as const);
  assert.ok(isVoiceGatewayEventV2(healthy));
  assert.ok(isVoiceGatewayPublicState({ ready: false, capture: "unavailable", speech: "denied" }));
  assert.ok(!isVoiceGatewayPublicState({ ready: "yes", capture: "ready", speech: "ready" }));
  assert.ok(!isVoiceGatewayPublicState({ ready: false, capture: "ready", speech: "ready", reasonCode: "internal_boom" }));
  assert.ok(!isVoiceGatewayEventV2({ ...healthy, state: { ready: true, capture: "ready", speech: "ready", reasonCode: "internal_boom" } }));
});

test("v2: v1 and v2 validators reject each other's frames (cross-version isolation)", () => {
  // A v1 hello must not pass the v2 validator and v2 frames must not pass v1.
  assert.ok(!isVoiceGatewayRequestV2({ type: "hello", requestId: "req_x", token: "token_xxxxxxxxxxxxxxxx", protocolVersion: 1 }));
  assert.ok(!isVoiceGatewayRequest({ ...requestFixture }));
  const v1Hello = parseVoiceGatewayRequest(
    encodeVoiceGatewayMessage({ type: "hello", requestId: "req_x", token: "token_xxxxxxxxxxxxxxxx", protocolVersion: 1 }).slice(0, -1),
  );
  assert.notEqual(v1Hello, null);
  assert.ok(v1Hello!.type === "hello");
  // The v2 parser refuses a v1 frame and vice versa.
  const v2Line = encodeVoiceGatewayMessageV2(requestFixture).slice(0, -1);
  assert.equal(parseVoiceGatewayRequest(v2Line), null);
  const v1Line = encodeVoiceGatewayMessage({ type: "hello", requestId: "req_x", token: "token_xxxxxxxxxxxxxxxx", protocolVersion: 1 }).slice(0, -1);
  assert.equal(parseVoiceGatewayRequestV2(v1Line), null);
});

test("v2: bounded encoder rejects malformed payloads and every valid frame stays within the NDJSON cap", () => {
  // Text longer than the validator allows never reaches the encoder at all.
  const oversized = { ...requestFixture, deltaText: "x".repeat(2_000_000) };
  assert.throws(() => encodeVoiceGatewayMessageV2(oversized), /invalid_voice_gateway_v2_message/);
  assert.throws(() => encodeVoiceGatewayMessageV2({ ...requestFixture, type: "stop_all" as const }), /invalid_voice_gateway_v2_message/);
  // A maximum-size legal frame still fits the 64 KiB wire cap (bounded encoder invariant).
  const largestLegal = {
    ...requestFixture,
    deltaText: "x".repeat(4_000),
    voiceProfile: "companion.default",
  };
  const frame = encodeVoiceGatewayMessageV2(largestLegal);
  assert.ok(new TextEncoder().encode(frame).byteLength <= 64 * 1024);
  assert.equal(parseVoiceGatewayRequestV2("{not json"), null);
  assert.equal(parseVoiceGatewayEventV2("null"), null);
});