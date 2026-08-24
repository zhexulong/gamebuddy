import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";

import type { VoiceAudioEpochAdmission, VoiceEnqueueAdmission } from "./voice.js";
import { LocalVoiceGatewayClient } from "./voice-gateway-client.js";

function enqueueAdmission(
  options: Readonly<{ hostCurrent?: boolean; audioCurrent?: boolean }> = {},
): VoiceEnqueueAdmission {
  const hostBinding = Object.freeze({ kind: "host" });
  const audioBinding = Object.freeze({ kind: "audio" });
  return Object.freeze({
    hostBinding,
    assertHostCurrent: (binding) => {
      assert.equal(binding, hostBinding);
      if (options.hostCurrent === false) throw new Error("stale_host_admission");
    },
    audioBinding,
    assertAudioCurrent: (binding) => {
      assert.equal(binding, audioBinding);
      if (options.audioCurrent === false) throw new Error("stale_audio_admission");
    },
  });
}

function audioEnqueueAdmission(admission: VoiceAudioEpochAdmission, binding: object): VoiceEnqueueAdmission {
  const hostBinding = Object.freeze({ kind: "host" });
  return Object.freeze({
    hostBinding,
    assertHostCurrent: (value) => assert.equal(value, hostBinding),
    audioBinding: binding,
    assertAudioCurrent: (value) => admission.assertCurrent(value),
  });
}

function tautologicalAudioEnqueueAdmission(binding: object): VoiceEnqueueAdmission {
  const hostBinding = Object.freeze({ kind: "host" });
  return Object.freeze({
    hostBinding,
    assertHostCurrent: (value) => assert.equal(value, hostBinding),
    audioBinding: binding,
    // Deliberately forged: concrete client admission must not trust this.
    assertAudioCurrent: () => {},
  });
}

function expression() {
  return {
    expressionId: "expr_01",
    sessionId: "session_01",
    sourceEventId: "event_01",
    text: "我在。",
    locale: "zh-CN",
    voiceProfile: "default",
    epoch: 0,
    expiresAtMs: Date.now() + 10_000,
  };
}

async function listen(handler: (socket: Socket) => void): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise, reject) =>
    server.listen(0, "127.0.0.1", resolvePromise).once("error", reject),
  );
  return server;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error == null ? resolvePromise() : reject(error))),
  );
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

test("Game voice presentation attachment is opaque, preserves the concrete gateway, and requires healthy admission", async () => {
  const server = await listen((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.length === 0) continue;
        const request = JSON.parse(line) as { type: string; requestId: string };
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "health")
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "ready",
            capabilities: {
              providerId: "fake-tts",
              modelRevision: "v1",
              perUtteranceDirection: false,
              ready: true,
              epoch: 0,
            },
          });
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await assert.rejects(
      async () => client.createGameVoicePresentationAttachment("default"),
      /voice_gateway_unavailable/,
    );
    await client.health();
    const attachment = client.createGameVoicePresentationAttachment("default");
    const { consumeGameVoicePresentationAttachment } = await import("./voice-gateway-client.js");
    const payload = consumeGameVoicePresentationAttachment(attachment);
    assert.strictEqual(payload.speechPort, client);
    assert.throws(
      () => consumeGameVoicePresentationAttachment(Object.freeze({})),
      /invalid_game_voice_presentation_attachment/,
    );
    client.close();
  } finally {
    await close(server);
  }
});

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
        const request = JSON.parse(buffer.slice(0, newline)) as { type: string; requestId: string; after?: number };
        buffer = buffer.slice(newline + 1);
        seen.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "health")
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "ready",
            capabilities: {
              providerId: "fake-tts",
              modelRevision: "fake-v1",
              perUtteranceDirection: false,
              ready: true,
              epoch: 0,
            },
          });
        else if (request.type === "events" && request.after === Number.MAX_SAFE_INTEGER)
          reply(socket, request.requestId, { type: "events", next: 3, events: [] });
        else if (request.type === "events")
          reply(socket, request.requestId, {
            type: "events",
            next: 3,
            events: [
              { type: "partial_transcript", sessionId: "session_01", inputId: "input_01", text: "partial only" },
              {
                type: "final_transcript",
                sessionId: "session_01",
                sourceEventId: "voice_source_01",
                inputId: "input_01",
                text: "看看农场",
                locale: "zh-CN",
                providerId: "fake-asr",
                modelRevision: "v1",
                timestampMs: 1,
                actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
              },
            ],
          });
        else reply(socket, request.requestId, { type: "accepted", value: true });
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    const finals: unknown[] = [];
    client.onFinalTranscript((input) => finals.push(input));
    await client.health();
    await client.bootstrapSession("session_01");
    await client.pollEvents();
    const eventsRequest = seen.find(
      (request) =>
        (request as { type?: string }).type === "events" &&
        (request as { after?: number }).after !== Number.MAX_SAFE_INTEGER,
    ) as {
      sessionId?: string;
    };
    assert.equal(eventsRequest.sessionId, "session_01");
    const audioAdmission = client.createAudioEpochAdmission();
    await client.enqueue(expression(), audioEnqueueAdmission(audioAdmission, audioAdmission.capture()));
    await client.stopAll();
    assert.deepEqual(finals, [
      {
        sessionId: "session_01",
        sourceEventId: "voice_source_01",
        inputId: "input_01",
        text: "看看农场",
        locale: "zh-CN",
        providerId: "fake-asr",
        modelRevision: "v1",
        timestampMs: 1,
        actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
        type: "final_transcript",
      },
    ]);
    assert.deepEqual(
      (seen as { type: string }[]).map((request) => request.type),
      ["hello", "health", "events", "events", "speech_enqueue", "stop_all", "health"],
    );
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Voice Gateway client fences stale Host and audio admissions before speech enqueue", async () => {
  const requests: Array<{ type: string; requestId: string }> = [];
  let peer: Socket | undefined;
  const server = await listen((socket) => {
    peer = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of chunk.trim().split("\n")) {
        const request = JSON.parse(line) as { type: string; requestId: string };
        requests.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "health")
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "ready",
            capabilities: {
              providerId: "fake-tts",
              modelRevision: "fake-v1",
              perUtteranceDirection: false,
              ready: true,
              epoch: 0,
            },
          });
        else if (request.type === "speech_enqueue") reply(socket, request.requestId, { type: "accepted", value: true });
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await assert.rejects(
      () => client.enqueue(expression(), enqueueAdmission({ hostCurrent: false })),
      /stale_host_admission/,
    );
    await assert.rejects(
      () => client.enqueue(expression(), enqueueAdmission({ audioCurrent: false })),
      /stale_audio_admission/,
    );
    assert.deepEqual(
      requests.map((request) => request.type),
      ["hello"],
    );

    await client.health();
    const audioAdmission = client.createAudioEpochAdmission();
    await client.enqueue(expression(), audioEnqueueAdmission(audioAdmission, audioAdmission.capture()));
    assert.deepEqual(
      requests.map((request) => request.type),
      ["hello", "health", "speech_enqueue"],
    );
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Voice Gateway client snapshots expressions before the final audio admission fence", async () => {
  const requests: Array<{ type: string; requestId: string }> = [];
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
        requests.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "health")
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "ready",
            capabilities: {
              providerId: "fake-tts",
              modelRevision: "fake-v1",
              perUtteranceDirection: false,
              ready: true,
              epoch: 0,
            },
          });
        else if (request.type === "speech_enqueue") reply(socket, request.requestId, { type: "accepted", value: true });
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await client.health();
    const audioAdmission = client.createAudioEpochAdmission();
    const binding = audioAdmission.capture();
    let reentrantHealth: Promise<unknown> | undefined;
    const reentrantExpression = new Proxy(expression(), {
      get(target, property, receiver) {
        if (property === "expressionId") reentrantHealth = client.health();
        return Reflect.get(target, property, receiver);
      },
    });

    await assert.rejects(
      () => client.enqueue(reentrantExpression, audioEnqueueAdmission(audioAdmission, binding)),
      /voice_audio_epoch_stale/,
    );
    await reentrantHealth;
    assert.equal(requests.filter((request) => request.type === "speech_enqueue").length, 0);

    const refreshedBinding = audioAdmission.capture();
    await client.enqueue(expression(), audioEnqueueAdmission(audioAdmission, refreshedBinding));
    assert.equal(requests.filter((request) => request.type === "speech_enqueue").length, 1);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Voice Gateway client produces opaque current audio epoch admissions for the mandatory enqueue fence", async () => {
  const requests: Array<{ type: string; requestId: string }> = [];
  let epoch = 0;
  let ready = true;
  const peers = new Set<Socket>();
  const server = await listen((socket) => {
    peers.add(socket);
    socket.setEncoding("utf8");
    socket.on("close", () => peers.delete(socket));
    socket.on("data", (chunk: string) => {
      for (const line of chunk.trim().split("\n")) {
        const request = JSON.parse(line) as { type: string; requestId: string };
        requests.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "health")
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "ready",
            capabilities: {
              providerId: "fake-tts",
              modelRevision: "fake-v1",
              perUtteranceDirection: false,
              ready,
              epoch,
            },
          });
        else if (request.type === "stop_all") {
          epoch++;
          reply(socket, request.requestId, { type: "accepted", value: true });
        } else if (request.type === "speech_enqueue")
          reply(socket, request.requestId, { type: "accepted", value: true });
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await client.health();
    const admission = client.createAudioEpochAdmission();
    const current = admission.capture();
    assert.equal(admission.epoch(current), 0);
    // A tautological caller assertion cannot replace the concrete client's
    // ownership check; an authentic current binding remains accepted.
    await client.enqueue(expression(), tautologicalAudioEnqueueAdmission(current));

    epoch = 1;
    await client.health();
    await assert.rejects(
      () => client.enqueue(expression(), tautologicalAudioEnqueueAdmission(current)),
      /voice_audio_epoch_stale/,
    );
    await assert.rejects(
      () => client.enqueue(expression(), tautologicalAudioEnqueueAdmission(Object.freeze({}))),
      /invalid_voice_audio_epoch_binding/,
    );
    await assert.rejects(
      () => client.enqueue(expression(), audioEnqueueAdmission(admission, Object.freeze({}) as object)),
      /invalid_voice_audio_epoch_binding/,
    );
    assert.throws(() => admission.assertCurrent(0 as never), /invalid_voice_audio_epoch_binding/);

    ready = false;
    await assert.rejects(() => client.health(), /voice_gateway_unavailable/);
    assert.throws(() => admission.assertCurrent(current), /voice_audio_epoch_stale/);
    await assert.rejects(
      () => client.enqueue(expression(), audioEnqueueAdmission(admission, current)),
      /voice_audio_epoch_stale/,
    );
    ready = true;
    await client.health();

    const refreshed = admission.capture();
    await client.enqueue(expression(), audioEnqueueAdmission(admission, refreshed));
    await client.stopAll();
    await assert.rejects(
      () => client.enqueue(expression(), audioEnqueueAdmission(admission, refreshed)),
      /voice_audio_epoch_stale/,
    );

    const otherClient = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await otherClient.health();
    const otherBinding = otherClient.createAudioEpochAdmission().capture();
    await assert.rejects(
      () => client.enqueue(expression(), audioEnqueueAdmission(admission, otherBinding)),
      /invalid_voice_audio_epoch_binding/,
    );
    assert.deepEqual(requests.filter((request) => request.type === "speech_enqueue").length, 2);
    otherClient.close();
    const disconnected = admission.capture();
    client.close();
    assert.throws(() => admission.epoch(disconnected), /voice_gateway_disconnected/);
  } finally {
    for (const peer of peers) peer.destroy();
    await close(server);
  }
});

test("accepted stop_all revokes audio admission before failed health revalidation", async () => {
  const requests: Array<{ type: string; requestId: string }> = [];
  let healthMode: "ready" | "hold-error" | "unavailable" | "malformed" = "ready";
  let releaseHeldHealth: (() => void) | undefined;
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
        requests.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "stop_all") reply(socket, request.requestId, { type: "accepted", value: true });
        else if (request.type === "speech_enqueue") reply(socket, request.requestId, { type: "accepted", value: true });
        else if (request.type === "health" && healthMode === "ready")
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "ready",
            capabilities: {
              providerId: "fake-tts",
              modelRevision: "fake-v1",
              perUtteranceDirection: false,
              ready: true,
              epoch: 0,
            },
          });
        else if (request.type === "health" && healthMode === "unavailable")
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "unavailable",
            capabilities: {
              providerId: "fake-tts",
              modelRevision: "fake-v1",
              perUtteranceDirection: false,
              ready: false,
              epoch: 1,
            },
          });
        else if (request.type === "health" && healthMode === "malformed")
          reply(socket, request.requestId, { type: "health", protocolVersion: 1, status: "ready" });
        else if (request.type === "health" && healthMode === "hold-error") {
          releaseHeldHealth = () =>
            reply(socket, request.requestId, {
              type: "error",
              reasonCode: "health_failed",
              requestId: request.requestId,
            });
        }
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await client.health();
    const admission = client.createAudioEpochAdmission();
    const binding = admission.capture();

    healthMode = "hold-error";
    const stopping = client.stopAll();
    while (releaseHeldHealth === undefined) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => client.enqueue(expression(), audioEnqueueAdmission(admission, binding)),
      /voice_audio_epoch_stale/,
    );
    releaseHeldHealth();
    await assert.rejects(() => stopping, /voice_gateway_unhealthy/);
    assert.throws(() => admission.assertCurrent(binding), /voice_audio_epoch_stale/);
    assert.equal(requests.filter((request) => request.type === "speech_enqueue").length, 0);
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("overlapping health revalidations leave only the newest request able to publish audio admission", async () => {
  const requests: Array<{ type: string; requestId: string }> = [];
  const heldHealth: Array<{ requestId: string }> = [];
  let automaticHealth:
    | Readonly<{
        providerId: string;
        modelRevision: string;
        perUtteranceDirection: boolean;
        ready: boolean;
        epoch: number;
      }>
    | undefined = {
    providerId: "fake-tts",
    modelRevision: "fake-v1",
    perUtteranceDirection: false,
    ready: true,
    epoch: 0,
  };
  let peer: Socket | undefined;
  const respondHealth = (socket: Socket, requestId: string, status: "ready" | "unavailable", epoch: number): void =>
    reply(socket, requestId, {
      type: "health",
      protocolVersion: 1,
      status,
      capabilities: {
        providerId: "fake-tts",
        modelRevision: `fake-v${epoch}`,
        perUtteranceDirection: false,
        ready: status === "ready",
        epoch,
      },
    });
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
        requests.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "speech_enqueue") reply(socket, request.requestId, { type: "accepted", value: true });
        else if (request.type === "health" && automaticHealth !== undefined)
          reply(socket, request.requestId, {
            type: "health",
            protocolVersion: 1,
            status: "ready",
            capabilities: automaticHealth,
          });
        else if (request.type === "health") heldHealth.push(request);
      }
    });
  });
  const waitForHeldHealth = async (count: number): Promise<void> => {
    while (heldHealth.length < count) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await client.health();
    const admission = client.createAudioEpochAdmission();
    const initialBinding = admission.capture();
    automaticHealth = undefined;

    const healthA = client.health();
    await waitForHeldHealth(1);
    const healthB = client.health();
    await waitForHeldHealth(2);
    respondHealth(peer!, heldHealth[0]!.requestId, "ready", 1);
    await assert.rejects(() => healthA, /voice_gateway_health_superseded/);
    await assert.rejects(
      () => client.enqueue(expression(), audioEnqueueAdmission(admission, initialBinding)),
      /voice_audio_epoch_stale/,
    );
    respondHealth(peer!, heldHealth[1]!.requestId, "unavailable", 2);
    await assert.rejects(() => healthB, /voice_gateway_unavailable/);
    assert.throws(() => admission.capture(), /voice_gateway_unavailable/);
    assert.equal(requests.filter((request) => request.type === "speech_enqueue").length, 0);

    automaticHealth = {
      providerId: "fake-tts",
      modelRevision: "fake-v3",
      perUtteranceDirection: false,
      ready: true,
      epoch: 3,
    };
    await client.health();
    automaticHealth = undefined;
    const staleA = client.health();
    await waitForHeldHealth(3);
    const currentB = client.health();
    await waitForHeldHealth(4);
    respondHealth(peer!, heldHealth[3]!.requestId, "ready", 5);
    await currentB;
    const currentBinding = admission.capture();
    respondHealth(peer!, heldHealth[2]!.requestId, "ready", 4);
    await assert.rejects(() => staleA, /voice_gateway_health_superseded/);
    assert.equal(admission.epoch(currentBinding), 5);
    await client.enqueue(expression(), audioEnqueueAdmission(admission, currentBinding));
    assert.equal(requests.filter((request) => request.type === "speech_enqueue").length, 1);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("reusable voice session bootstraps at the gateway cursor and never replays old finals", async () => {
  const requests: Array<{ type: string; after?: number }> = [];
  let peer: Socket | undefined;
  const server = await listen((socket) => {
    peer = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of chunk.trim().split("\\n")) {
        const request = JSON.parse(line) as { type: string; requestId: string; after?: number };
        requests.push(request);
        if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
        else if (request.type === "events" && request.after === Number.MAX_SAFE_INTEGER)
          reply(socket, request.requestId, { type: "events", next: 7, events: [] });
        else if (request.type === "events" && request.after === 7)
          reply(socket, request.requestId, { type: "events", next: 8, events: [] });
        else
          reply(socket, request.requestId, {
            type: "events",
            next: 8,
            events: [
              {
                type: "final_transcript",
                sessionId: "session_01",
                sourceEventId: "voice_source_old",
                inputId: "old_input",
                text: "old",
                locale: "zh-CN",
                providerId: "fake-asr",
                modelRevision: "v1",
                timestampMs: 1,
                actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
              },
            ],
          });
      }
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    const finals: unknown[] = [];
    client.onFinalTranscript((input) => finals.push(input));
    await client.bootstrapSession("session_01");
    await client.pollEvents();
    assert.deepEqual(finals, []);
    assert.deepEqual(
      requests.map((request) => request.after),
      [undefined, Number.MAX_SAFE_INTEGER, 7],
    );
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Voice Gateway client rejects non-loopback endpoints and closes on malformed event payloads", async () => {
  await assert.rejects(
    () => LocalVoiceGatewayClient.connect({ host: "0.0.0.0" as never, port: 1, token: "voice_token_1234567890" }),
    /voice_gateway_loopback_required/,
  );
  let peer: Socket | undefined;
  const server = await listen((socket) => {
    peer = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const request = JSON.parse(chunk.trim()) as { type: string; requestId: string; after?: number };
      if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
      else if (request.type === "events" && request.after === Number.MAX_SAFE_INTEGER)
        reply(socket, request.requestId, { type: "events", next: 0, events: [] });
      else
        reply(socket, request.requestId, {
          type: "events",
          next: 0,
          events: [
            {
              type: "final_transcript",
              sessionId: "bad space",
              sourceEventId: "voice_source_bad",
              inputId: "input_01",
              text: "x",
              locale: "zh-CN",
              providerId: "fake",
              modelRevision: "v1",
              timestampMs: 1,
              actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
            },
          ],
        });
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    let delivered = false;
    client.onFinalTranscript(() => {
      delivered = true;
    });
    await client.bootstrapSession("session_01");
    await assert.rejects(() => client.pollEvents(), /voice_gateway_closed/);
    assert.equal(delivered, false);
  } finally {
    peer?.destroy();
    await close(server);
  }
});

test("local Voice Gateway client fails closed without a bound session and never reaches the gateway", async () => {
  let eventRequests = 0;
  let peer: Socket | undefined;
  const server = await listen((socket) => {
    peer = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const request = JSON.parse(chunk.trim()) as { type: string; requestId: string; after?: number };
      if (request.type === "hello") reply(socket, request.requestId, { type: "hello_ack", protocolVersion: 1 });
      else if (request.type === "events") eventRequests++;
    });
  });
  try {
    const client = await LocalVoiceGatewayClient.connect({ port: port(server), token: "voice_token_1234567890" });
    await assert.rejects(() => client.pollEvents(), /voice_session_required/);
    assert.equal(eventRequests, 0);
    client.close();
  } finally {
    peer?.destroy();
    await close(server);
  }
});
