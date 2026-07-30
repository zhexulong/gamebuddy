import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import { LocalVoiceGatewayClient } from "./voice-gateway-client.js";

async function listen(handler: (socket: Socket) => void): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise, reject) => server.listen(0, "127.0.0.1", resolvePromise).once("error", reject));
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error == null ? resolvePromise() : reject(error)));
}

function port(server: Server): number {
  const address = server.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  return (address as { port: number }).port;
}

function reply(socket: Socket, requestId: string, value: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ requestId, ...value })}\n`);
}

test("local Voice Gateway client authenticates, accepts only final voice facts, and keeps speech/stop separate", async () => {
  const seen: unknown[] = [];
  let peer: Socket | undefined;
  const server = await listen((socket) => {
    peer = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { type: string; requestId: string };
        buffer = buffer.slice(newline + 1);
        seen.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "health") reply(socket, request.requestId, { type: "health", protocolVersion: 1 });
        else if (request.type === "events") reply(socket, request.requestId, { type: "events", next: 3, events: [
          { type: "partial_transcript", inputId: "input_01", text: "partial only" },
          { type: "final_transcript", sessionId: "session_01", inputId: "input_01", text: "看看农场", locale: "zh-CN", providerId: "fake-asr", modelRevision: "v1", timestampMs: 1, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } },
          { type: "final_transcript", sessionId: "session_01", inputId: "invalid", text: "", locale: "zh-CN", providerId: "fake-asr", modelRevision: "v1", timestampMs: 1, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } },
        ] });
        else reply(socket, request.requestId, { type: "accepted", value: true });
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    const finals: unknown[] = [];
    client.onFinalTranscript((input) => finals.push(input));
    await client.health();
    await client.pollEvents();
    await client.enqueue({ expressionId: "expr_01", sessionId: "session_01", sourceEventId: "event_01", text: "我在。", locale: "zh-CN", voiceProfile: "default", epoch: 0, expiresAtMs: Date.now() + 10_000 });
    await client.stopAll();
    assert.deepEqual(finals, [{ sessionId: "session_01", inputId: "input_01", text: "看看农场", locale: "zh-CN", providerId: "fake-asr", modelRevision: "v1", timestampMs: 1, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" }, type: "final_transcript" }]);
    assert.deepEqual((seen as { type: string }[]).map((request) => request.type), ["hello", "health", "events", "speech_enqueue", "stop_all"]);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Voice Gateway client rejects non-loopback endpoints and malformed event payloads", async () => {
  await assert.rejects(() => LocalVoiceGatewayClient.connect({ host: "0.0.0.0" as never, port: 1, token: "voice_token_1234567890" }), /voice_gateway_loopback_required/);
  let peer: Socket | undefined;
  const server = await listen((socket) => {
    peer = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const request = JSON.parse(chunk.trim()) as { type: string; requestId: string };
      if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
      else reply(socket, request.requestId, { type: "events", next: 0, events: [{ type: "final_transcript", sessionId: "bad space", inputId: "input_01", text: "x", locale: "zh-CN", providerId: "fake", modelRevision: "v1", timestampMs: 1, actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" } }] });
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    let delivered = false;
    client.onFinalTranscript(() => { delivered = true; });
    await client.pollEvents();
    assert.equal(delivered, false);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});
