import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";

import { encodeVoiceGatewayMessageV2, type VoiceGatewayRequestV2 } from "@gamebuddy/voice-protocol";

import { RecordingMixer } from "./unattended-playback.js";
import { synthSpeechLikePcm16 } from "./synth-audio.js";
import { startVoiceGateway } from "./server.js";

const TOKEN = "voice_token_1234567890";

function v1Hello(requestId = "hello_v2"): string {
  return `${JSON.stringify({ type: "hello", token: TOKEN, protocolVersion: 1, requestId })}\n`;
}

function v2Frame(request: VoiceGatewayRequestV2): string {
  return `${encodeVoiceGatewayMessageV2(request).slice(0, -1)}\n`;
}

const FIXED_DEADLINE_MS = Date.now() + 60_000;

function makeChunk(overrides: Partial<VoiceGatewayRequestV2>): VoiceGatewayRequestV2 {
  return {
    protocolVersion: 2,
    sessionId: "session_v2",
    connectionEpoch: 0,
    timestampMs: Date.now(),
    type: "stream_speech_chunk",
    requestId: "v2_req_001",
    speechJobId: "v2_job_001",
    chunkIndex: 0,
    deltaText: "你好，这是一条完整的语音测试。",
    isFinalChunk: true,
    deadlineMs: FIXED_DEADLINE_MS,
    ...overrides,
  } as VoiceGatewayRequestV2;
}

const readyTts = {
  providerId: "fake-tts-ready",
  modelRevision: "phase2-fake-v1",
  ready: true,
  async *synthesize(job: { text: string }, signal: AbortSignal) {
    if (signal.aborted) return;
    const durationMs = Math.max(120, job.text.length * 60);
    yield synthSpeechLikePcm16(durationMs / 1_000, { amplitude: 4_000 });
  },
};

type Peer = {
  socket: ReturnType<typeof createConnection>;
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
};

function connect(port: number): Promise<Peer> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    const waiters: ((record: Record<string, unknown>) => void)[] = [];
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const record = JSON.parse(line) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter !== undefined) waiter(record);
      }
    });
    const next = (timeoutMs = 5_000): Promise<Record<string, unknown>> =>
      new Promise((resolveNext, rejectNext) => {
        const timer = setTimeout(() => rejectNext(new Error("peer_read_timeout")), timeoutMs);
        waiters.push((record) => {
          clearTimeout(timer);
          resolveNext(record);
        });
      });
    socket.once("connect", () => resolvePromise({ socket, next }));
  });
}

async function startGateway(): Promise<{ port: number; mixer: RecordingMixer; close(): Promise<void> }> {
  const mixer = new RecordingMixer();
  const gateway = await startVoiceGateway({ port: 0, token: TOKEN, tts: readyTts, mixer });
  return { port: gateway.port, mixer, close: () => gateway.close() };
}

test("v2 peer authenticates via v1 hello and receives pushed playback events for streamed chunks", async () => {
  const { port, mixer, close } = await startGateway();
  try {
    const { socket, next } = await connect(port);
    socket.write(v1Hello());
    const helloAck = await next();
    assert.equal(helloAck.type, "hello_ack");

    socket.write(v2Frame(makeChunk({})));
    let sawPlayback = false;
    for (let index = 0; index < 50 && !sawPlayback; index += 1) {
      const record = await next();
      if (record.type === "playback_observation") {
        sawPlayback = true;
        assert.equal(record.terminalStatus, "completed");
        assert.equal(record.speechJobId, "v2_job_001");
      }
    }
    assert.ok(sawPlayback, "expected a pushed completed playback observation");
    assert.ok(
      mixer.plays.length > 0,
      "the streamed chunk must have reached the real mixer through the pipeline",
    );
    socket.destroy();
  } finally {
    await close();
  }
});

test("v2 stale connection epoch is rejected with a pushed not_accepted observation", async () => {
  const { port, close } = await startGateway();
  try {
    const { socket, next } = await connect(port);
    socket.write(v1Hello("hello_epoch"));
    const helloAck = await next();
    assert.equal(helloAck.type, "hello_ack");

    socket.write(v2Frame(makeChunk({ connectionEpoch: 999 })));
    const record = await next();
    assert.equal(record.type, "playback_observation");
    assert.equal(record.terminalStatus, "not_accepted");
    socket.destroy();
  } finally {
    await close();
  }
});

test("unauthenticated v2 frames are not routed to the streaming runtime", async () => {
  const { port, close } = await startGateway();
  try {
    const { socket, next } = await connect(port);
    socket.write(v2Frame(makeChunk({})));
    const record = await next();
    // Without a v1 hello the socket is not authenticated: the v2 frame is a
    // malformed v1 request and receives the protocol error, not a playback.
    assert.equal(record.type, "error");
    assert.equal(record.reasonCode, "malformed_request");
    socket.destroy();
  } finally {
    await close();
  }
});