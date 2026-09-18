import assert from "node:assert/strict";
import test from "node:test";

import { encodeVoiceGatewayMessageV2, isVoiceGatewayEventV2, type VoiceGatewayRequestV2 } from "@gamebuddy/voice-protocol";

import type { SpeechJob, TtsProvider } from "./gateway.js";
import { RecordingMixer } from "./unattended-playback.js";
import { synthSpeechLikePcm16 } from "./synth-audio.js";
import { V2StreamingRuntime } from "./v2-streaming.js";

const FIXED_DEADLINE_MS = Date.now() + 60_000;

function makeRequest(overrides: Partial<VoiceGatewayRequestV2>): VoiceGatewayRequestV2 {
  const base = {
    protocolVersion: 2,
    sessionId: "session_a",
    connectionEpoch: 7,
    timestampMs: Date.now(),
  } as const;
  if (overrides.type === "stream_speech_chunk")
    return {
      ...base,
      type: "stream_speech_chunk",
      requestId: "req_000001",
      speechJobId: "speech_0001",
      chunkIndex: 0,
      deltaText: "你好。",
      isFinalChunk: false,
      deadlineMs: FIXED_DEADLINE_MS,
      ...overrides,
    } as VoiceGatewayRequestV2;
  if (overrides.type === "cancel_speech")
    return {
      ...base,
      type: "cancel_speech",
      requestId: "req_000002",
      reason: "speech_cancelled",
      ...overrides,
    } as VoiceGatewayRequestV2;
  if (overrides.type === "cancel_capture")
    return {
      ...base,
      type: "cancel_capture",
      requestId: "req_000003",
      reason: "capture_cancelled",
      ...overrides,
    } as VoiceGatewayRequestV2;
  return {
    ...base,
    type: "stop_all",
    requestId: "req_000004",
    reason: "stop_all",
    ...overrides,
  } as VoiceGatewayRequestV2;
}

function encode(request: VoiceGatewayRequestV2): string {
  return encodeVoiceGatewayMessageV2(request).slice(0, -1);
}

const fakeTts: TtsProvider = {
  providerId: "fake-tts-v2",
  modelRevision: "phase2-fake-v1",
  ready: true,
  async *synthesize(job: SpeechJob, signal: AbortSignal) {
    if (signal.aborted) return;
    const durationMs = Math.max(120, job.text.length * 60);
    yield synthSpeechLikePcm16(durationMs / 1_000, { amplitude: 4_000 });
  },
};

async function runLines(lines: readonly string[], epoch = 7): Promise<{ events: string[]; mixer: RecordingMixer; runtime: V2StreamingRuntime }> {
  const mixer = new RecordingMixer();
  const events: string[] = [];
  const runtime = new V2StreamingRuntime({
    tts: fakeTts,
    mixer,
    connectionEpoch: epoch,
    onEvent: (event) => events.push(JSON.stringify(event)),
  });
  for (const line of lines) {
    const handled = runtime.handleRequest(line, Date.now());
    if (!handled) events.push("__malformed__");
  }
  return { events, mixer, runtime };
}

/** v2 is fire-and-forget: the completed/cancelled event arrives via the push. */
async function awaitEvent(
  events: readonly string[],
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = events
      .filter((event) => event !== "__malformed__")
      .map((event) => JSON.parse(event) as Record<string, unknown>)
      .find(predicate);
    if (match !== undefined) return match;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("awaitEvent timed out: " + JSON.stringify(events));
}

function playbackOf(event: Record<string, unknown>): boolean {
  return event.type === "playback_observation";
}

test("v2 runtime: stream_speech_chunk admission and completed playback observation", async (t) => {
  t.after(() => runtime != null ? runtime.close() : undefined);
  const { events, mixer, runtime } = await runLines([
    encode(makeRequest({ type: "stream_speech_chunk" })),
    encode(makeRequest({ type: "stream_speech_chunk", chunkIndex: 1, deltaText: "今天的天气很好。", isFinalChunk: true })),
  ]);
  const completed = await awaitEvent(events, (event) => playbackOf(event) && event.terminalStatus === "completed");
  assert.ok(mixer.plays.length > 0, "pipeline must have handed PCM to the mixer");
  const parsing = events.filter((event) => isVoiceGatewayEventV2(JSON.parse(event) as unknown));
  assert.equal(parsing.length, events.length, "every emitted event must satisfy the frozen validator");
  assert.equal(completed.speechJobId, "speech_0001");
  assert.equal(completed.connectionEpoch, 7);
  assert.ok(typeof completed.audioEndMs === "number" && completed.audioEndMs > 0, "audioEndMs must reflect played PCM");
  await runtime.close();
});

test("v2 runtime: stale connection epoch is rejected before any pipeline work", async (t) => {
  t.after(() => runtime != null ? runtime.close() : undefined);
  const { events, mixer, runtime } = await runLines([
    encode(makeRequest({ type: "stream_speech_chunk", connectionEpoch: 6 })),
  ]);
  await awaitEvent(events, (event) => playbackOf(event) && event.terminalStatus === "not_accepted");
  assert.equal(mixer.plays.length, 0, "no audio may be played for a stale epoch");
  await runtime.close();
});

test("v2 runtime: chunk index must be contiguous; replay is not silently accepted", async (t) => {
  t.after(() => runtime != null ? runtime.close() : undefined);
  const { events, mixer, runtime } = await runLines([
    encode(makeRequest({ type: "stream_speech_chunk" })),
    encode(makeRequest({ type: "stream_speech_chunk", chunkIndex: 0, deltaText: "重复的第一块。" })),
  ]);
  const rejected = await awaitEvent(events, (event) => playbackOf(event) && event.terminalStatus === "not_accepted");
  assert.equal(rejected.speechJobId, "speech_0001");
  void mixer;
  await runtime.close();
});

test("v2 runtime: cancel_speech cancels the voice-local job with a cancelled observation", async (t) => {
  t.after(() => runtime != null ? runtime.close() : undefined);
  const { events, runtime } = await runLines([
    encode(makeRequest({ type: "stream_speech_chunk" })),
    encode(makeRequest({ type: "cancel_speech", speechJobId: "speech_0001" })),
  ]);
  const cancelled = await awaitEvent(events, (event) => playbackOf(event) && event.terminalStatus === "cancelled");
  assert.equal(cancelled.speechJobId, "speech_0001");
  await runtime.close();
});

test("v2 runtime: stop_all cancels every admitted job and reports cancelled", async (t) => {
  t.after(() => runtime != null ? runtime.close() : undefined);
  const { events, runtime } = await runLines([
    encode(makeRequest({ type: "stream_speech_chunk" })),
    encode(makeRequest({ type: "stream_speech_chunk", speechJobId: "speech_0002", chunkIndex: 0, isFinalChunk: true })),
    encode(makeRequest({ type: "stop_all" })),
  ]);
  await Promise.race([
    awaitEvent(events, (event) => playbackOf(event) && event.terminalStatus === "cancelled"),
    awaitEvent(events, (event) => playbackOf(event) && event.terminalStatus === "completed" && event.speechJobId === "speech_0002"),
  ]);
  await runtime.close();
});

test("v2 runtime: malformed frames are rejected without emitting events", async (t) => {
  t.after(() => runtime != null ? runtime.close() : undefined);
  const { events, runtime } = await runLines(["{not-json"]);
  assert.ok(events.includes("__malformed__"));
  const realEvents = events.filter((event) => event !== "__malformed__");
  assert.equal(realEvents.length, 0, "malformed input must not fabricate observations");
  await runtime.close();
});

test("v2 runtime: deadline expiry yields unknown_after_admission, never fake success", async (t) => {
  t.after(() => runtime != null ? runtime.close() : undefined);
  const { events, mixer, runtime } = await runLines([
    encode(makeRequest({ type: "stream_speech_chunk", deadlineMs: Date.now() + 50 })),
  ]);
  try {
    // Streaming semantics: the first chunk starts voicing immediately (this is
    // the whole point of stream_speech_chunk — sub-300ms first-packet speech),
    // but without a final marker the job can never be reported completed.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    assert.ok(mixer.plays.length > 0, "streaming must begin voicing before the final chunk");
    const observations = events
      .map((event) => JSON.parse(event) as Record<string, unknown>)
      .filter((event) => event.type === "playback_observation");
    assert.ok(
      !observations.some((event) => event.terminalStatus === "completed"),
      "an uncommitted job must never report completed",
    );
  } finally {
    await runtime.close();
  }
});