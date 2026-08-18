import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";

import { MAX_NDJSON_FRAME_BYTES } from "@gamebuddy/voice-protocol";
import { VoiceGatewayCore } from "./gateway.js";
import { startVoiceGateway } from "./server.js";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: resolvePromise,
  };
}

async function exchange(port: number, messages: readonly unknown[]): Promise<unknown[]> {
  return await new Promise<unknown[]>((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let output = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("connect", () => socket.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`));
    socket.on("data", (chunk: string) => {
      output += chunk;
      if (output.split("\n").filter(Boolean).length >= messages.length) socket.end();
    });
    socket.on("end", () =>
      resolvePromise(
        output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      ),
    );
  });
}

test("standalone Voice Gateway requires local authenticated protocol-v1 health handshake", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  try {
    const id = randomUUID();
    const [hello, health] = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: id },
      { type: "health", requestId: "health_01" },
    ]);
    assert.deepEqual(hello, { type: "hello_ack", requestId: id, protocolVersion: 1 });
    assert.deepEqual(health, {
      type: "health",
      requestId: "health_01",
      status: "unavailable",
      protocolVersion: 1,
      capabilities: {
        providerId: "fake-tts",
        modelRevision: "phase0-fake-v1",
        perUtteranceDirection: false,
        ready: false,
        epoch: 0,
      },
    });
  } finally {
    await gateway.close();
  }
});

test("gateway close stops voice work and evicts authenticated persistent sockets", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
  let received = "";
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk: string | Buffer) => {
      received += chunk.toString();
      if (received.includes("hello_ack")) resolvePromise();
    });
    socket.once("connect", () =>
      socket.write(`${JSON.stringify({ type: "hello", token, protocolVersion: 1, requestId: "hello_persistent" })}\n`),
    );
  });
  const closed = new Promise<void>((resolvePromise) => socket.once("close", () => resolvePromise()));
  await gateway.close();
  await closed;
});

test("peer socket errors are contained and do not stop the gateway", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  try {
    const peer = createConnection({ host: "127.0.0.1", port: gateway.port });
    const closed = new Promise<void>((resolvePromise, reject) => {
      peer.once("error", reject);
      peer.once("close", () => resolvePromise());
    });
    await new Promise<void>((resolvePromise, reject) => {
      peer.once("error", reject);
      peer.once("connect", () => {
        peer.write(`${JSON.stringify({ type: "hello", token, protocolVersion: 1, requestId: "peer_01" })}\n`);
        peer.destroy();
        resolvePromise();
      });
    });
    await closed;
    assert.deepEqual(
      await exchange(gateway.port, [
        { type: "hello", token, protocolVersion: 1, requestId: "health_hello_after_peer" },
        { type: "health", requestId: "health_after_peer" },
      ]),
      [
        { type: "hello_ack", requestId: "health_hello_after_peer", protocolVersion: 1 },
        {
          type: "health",
          requestId: "health_after_peer",
          status: "unavailable",
          protocolVersion: 1,
          capabilities: {
            providerId: "fake-tts",
            modelRevision: "phase0-fake-v1",
            perUtteranceDirection: false,
            ready: false,
            epoch: 0,
          },
        },
      ],
    );
  } finally {
    await gateway.close();
  }
});

test("delayed native capture start is linearized against cancel", async () => {
  const token = "voice_token_1234567890";
  const startEntered = deferred<void>();
  const startGate = deferred<void>();
  let cancelled = 0;
  const cancelEntered = deferred<void>();
  const capture = {
    async start() {
      startEntered.resolve();
      await startGate.promise;
    },
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {
      cancelled++;
      cancelEntered.resolve();
    },
  };
  const gateway = await startVoiceGateway({ port: 0, token, capture });
  const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
  socket.setEncoding("utf8");
  let output = "";
  const helloAck = deferred<void>();
  const responseLines = new Promise<unknown[]>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      output += chunk;
      const lines = output.split("\n").filter(Boolean);
      if (lines.some((line) => line.includes('"type":"hello_ack"'))) helloAck.resolve();
      if (lines.length >= 2) resolvePromise(lines.map((line) => JSON.parse(line) as unknown));
    });
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ type: "hello", token, protocolVersion: 1, requestId: "race_hello" })}\n`);
        resolvePromise();
      });
    });
    await helloAck.promise;
    socket.write(`${JSON.stringify({ type: "ptt_start", requestId: "race_start", sessionId: "race_session" })}\n`);
    await startEntered.promise;
    const cancelSocket = createConnection({ host: "127.0.0.1", port: gateway.port });
    cancelSocket.setEncoding("utf8");
    const cancelHelloAck = deferred<void>();
    const cancellation = new Promise<unknown[]>((resolvePromise, reject) => {
      let cancelOutput = "";
      cancelSocket.once("error", reject);
      cancelSocket.on("data", (chunk: string) => {
        cancelOutput += chunk;
        const lines = cancelOutput.split("\n").filter(Boolean);
        if (lines.some((line) => line.includes('"requestId":"cancel_hello"'))) cancelHelloAck.resolve();
        if (lines.length >= 2) {
          cancelSocket.end();
          resolvePromise(lines.map((line) => JSON.parse(line) as unknown));
        }
      });
      cancelSocket.once("connect", () =>
        cancelSocket.write(
          `${[
            { type: "hello", token, protocolVersion: 1, requestId: "cancel_hello" },
            { type: "stop_all", requestId: "race_cancel", reasonCode: "user_released" },
          ]
            .map((message) => JSON.stringify(message))
            .join("\n")}\n`,
        ),
      );
    });
    // hello_ack is emitted only after the parser has synchronously admitted the
    // following stop_all, so this is an observed cancellation barrier.
    await cancelHelloAck.promise;
    // The native cancel must be invoked before a non-settling start is released;
    // merely making gateway.close/stop_all await a timeout is not sufficient.
    await cancelEntered.promise;
    startGate.resolve();
    const responses = await responseLines;
    assert.deepEqual((await cancellation).at(-1), {
      type: "accepted",
      requestId: "race_cancel",
      value: true,
    });
    assert.deepEqual(
      responses.find((response) => (response as { requestId?: string }).requestId === "race_start"),
      {
        type: "error",
        requestId: "race_start",
        reasonCode: "capture_cancelled",
      },
    );
    assert.equal(cancelled >= 1, true);
  } finally {
    socket.destroy();
    await gateway.close();
  }
});

test("queued ptt_stop is cancelled before entry and never reaches native stop", async () => {
  const token = "voice_token_1234567890";
  const startEntered = deferred<void>();
  const startGate = deferred<void>();
  let stopped = 0;
  const capture = {
    async start() {
      startEntered.resolve();
      await startGate.promise;
    },
    async stop() {
      stopped++;
      return new Uint8Array([0, 0]);
    },
    async cancel() {},
  };
  const gateway = await startVoiceGateway({ port: 0, token, capture });
  const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
  socket.setEncoding("utf8");
  let output = "";
  const responses = new Promise<unknown[]>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      output += chunk;
      const lines = output.split("\n").filter(Boolean);
      if (lines.length >= 4) resolvePromise(lines.map((line) => JSON.parse(line) as unknown));
    });
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          `${[
            { type: "hello", token, protocolVersion: 1, requestId: "stale_hello" },
            { type: "ptt_start", requestId: "stale_start", sessionId: "stale_session" },
          ]
            .map((message) => JSON.stringify(message))
            .join("\n")}\n`,
        );
        resolvePromise();
      });
    });
    await startEntered.promise;
    socket.write(
      `${[
        { type: "ptt_stop", requestId: "stale_ptt_stop" },
        { type: "capture_cancel", requestId: "stale_cancel", reasonCode: "user_released" },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n")}\n`,
    );
    startGate.resolve();
    const result = await responses;
    assert.deepEqual(
      result.find((response) => (response as { requestId?: string }).requestId === "stale_ptt_stop"),
      { type: "error", requestId: "stale_ptt_stop", reasonCode: "capture_cancelled" },
    );
    assert.deepEqual(
      result.find((response) => (response as { requestId?: string }).requestId === "stale_cancel"),
      { type: "accepted", requestId: "stale_cancel", value: true },
    );
    assert.equal(stopped, 0);
  } finally {
    socket.destroy();
    await gateway.close();
  }
});

test("ptt_stop cannot be accepted after cross-socket cancellation aborts ASR", async () => {
  const token = "voice_token_1234567890";
  const asrEntered = deferred<void>();
  const asrGate = deferred<void>();
  const core = new VoiceGatewayCore(
    {
      providerId: "test-asr",
      modelRevision: "test-asr-v1",
      async transcribe(_pcm16, _locale, _signal) {
        asrEntered.resolve();
        await asrGate.promise;
        return "stale transcript";
      },
    },
    {
      providerId: "test-tts",
      modelRevision: "test-tts-v1",
      ready: true,
      async *synthesize() {
        yield new Uint8Array([0, 0]);
      },
    },
    { ready: true, play() {}, stop() {} },
  );
  const capture = {
    async start() {},
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {},
  };
  const gateway = await startVoiceGateway({ port: 0, token, core, capture });
  try {
    const start = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "asr_race_hello" },
      { type: "ptt_start", requestId: "asr_race_start", sessionId: "asr_race_session" },
    ]);
    assert.equal(start.at(-1) && (start.at(-1) as { type?: string }).type, "accepted");
    const stopping = exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "asr_race_stop_hello" },
      { type: "ptt_stop", requestId: "asr_race_ptt_stop" },
    ]);
    await asrEntered.promise;
    const cancellation = exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "asr_race_cancel_hello" },
      { type: "stop_all", requestId: "asr_race_cancel", reasonCode: "user_released" },
    ]);
    const cancellationResponses = await cancellation;
    assert.deepEqual(cancellationResponses.at(-1), {
      type: "accepted",
      requestId: "asr_race_cancel",
      value: true,
    });
    asrGate.resolve();
    const stopResponses = await stopping;
    assert.deepEqual(
      stopResponses.find((response) => (response as { requestId?: string }).requestId === "asr_race_ptt_stop"),
      {
        type: "error",
        requestId: "asr_race_ptt_stop",
        reasonCode: "capture_cancelled",
      },
    );
  } finally {
    asrGate.resolve();
    await gateway.close();
  }
});

test("speech enqueue admitted before cross-socket stop_all is rejected by its admission epoch", async () => {
  const token = "voice_token_1234567890";
  const startEntered = deferred<void>();
  const startGate = deferred<void>();
  const core = new VoiceGatewayCore(
    {
      providerId: "test-asr",
      modelRevision: "test-asr-v1",
      async transcribe() {
        return "";
      },
    },
    {
      providerId: "test-tts",
      modelRevision: "test-tts-v1",
      ready: true,
      async *synthesize() {
        yield new Uint8Array([0, 0]);
      },
    },
    { ready: true, play() {}, stop() {} },
  );
  const capture = {
    async start() {
      startEntered.resolve();
      await startGate.promise;
    },
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {},
  };
  const gateway = await startVoiceGateway({ port: 0, token, core, capture });
  try {
    const admitted = exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "speech_epoch_hello" },
      { type: "ptt_start", requestId: "speech_epoch_start", sessionId: "speech_epoch_session" },
      {
        type: "speech_enqueue",
        requestId: "speech_epoch_enqueue",
        job: {
          jobId: "speech_epoch_job",
          sessionId: "speech_epoch_session",
          // Deliberately use the post-stop epoch. Acceptance must use the
          // request's admission epoch, not this caller-controlled field.
          epoch: 1,
          sourceEventId: "speech_epoch_event",
          text: "hello",
          locale: "zh-CN",
          voiceProfile: "companion.default",
          expiresAtMs: Date.now() + 60_000,
          interruptible: true,
        },
      },
    ]);
    await startEntered.promise;
    const cancellation = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "speech_epoch_cancel_hello" },
      { type: "stop_all", requestId: "speech_epoch_cancel", reasonCode: "user_released" },
    ]);
    assert.deepEqual(cancellation.at(-1), {
      type: "accepted",
      requestId: "speech_epoch_cancel",
      value: true,
    });
    startGate.resolve();
    const responses = await admitted;
    assert.deepEqual(
      responses.find((response) => (response as { requestId?: string }).requestId === "speech_epoch_enqueue"),
      {
        type: "error",
        requestId: "speech_epoch_enqueue",
        reasonCode: "speech_cancelled",
      },
    );
  } finally {
    startGate.resolve();
    await gateway.close();
  }
});

test("ptt_start without a mounted capture device fails closed without core capture state", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  try {
    const responses = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "no_capture_hello" },
      { type: "ptt_start", requestId: "no_capture_start", sessionId: "no_capture_session" },
      { type: "events", requestId: "no_capture_events", sessionId: "no_capture_session" },
    ]);
    assert.deepEqual(responses, [
      { type: "hello_ack", requestId: "no_capture_hello", protocolVersion: 1 },
      { type: "error", requestId: "no_capture_start", reasonCode: "capture_device_unavailable" },
      { type: "events", requestId: "no_capture_events", events: [], next: 0 },
    ]);
  } finally {
    await gateway.close();
  }
});

test("protocol ptt_frame is rejected as external PCM after hello", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  try {
    assert.deepEqual(
      await exchange(gateway.port, [
        { type: "hello", token, protocolVersion: 1, requestId: "external_pcm_hello" },
        { type: "ptt_frame", requestId: "external_pcm_frame", pcm16Base64: "AA==" },
      ]),
      [
        { type: "hello_ack", requestId: "external_pcm_hello", protocolVersion: 1 },
        { type: "error", requestId: "external_pcm_frame", reasonCode: "external_pcm_not_allowed" },
      ],
    );
  } finally {
    await gateway.close();
  }
});

test("same-socket queued start is invalidated by stop_all before it can resurrect capture", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  try {
    const responses = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "queued_hello" },
      { type: "ptt_start", requestId: "queued_start", sessionId: "queued_session" },
      { type: "stop_all", requestId: "queued_stop", reasonCode: "user_released" },
    ]);
    assert.deepEqual(responses[0], { type: "hello_ack", requestId: "queued_hello", protocolVersion: 1 });
    assert.deepEqual(
      responses.find((response) => (response as { requestId?: string }).requestId === "queued_start"),
      {
        type: "error",
        requestId: "queued_start",
        reasonCode: "capture_device_unavailable",
      },
    );
    assert.deepEqual(
      responses.find((response) => (response as { requestId?: string }).requestId === "queued_stop"),
      {
        type: "accepted",
        requestId: "queued_stop",
        value: true,
      },
    );
  } finally {
    await gateway.close();
  }
});

test("capture stop consumes PCM before a concurrent cancel can clean it up", async () => {
  const token = "voice_token_1234567890";
  const stopEntered = deferred<void>();
  const stopGate = deferred<void>();
  let consumed = false;
  let cancelledBeforeConsumed = false;
  const capture = {
    async start() {},
    async stop() {
      stopEntered.resolve();
      await stopGate.promise;
      consumed = true;
      return new Uint8Array([0, 0]);
    },
    async cancel() {
      if (!consumed) cancelledBeforeConsumed = true;
    },
  };
  const gateway = await startVoiceGateway({ port: 0, token, capture });
  try {
    const startResponse = (
      await exchange(gateway.port, [
        { type: "hello", token, protocolVersion: 1, requestId: "serialize_hello" },
        { type: "ptt_start", requestId: "serialize_start", sessionId: "serialize_session" },
      ])
    ).at(-1) as { type?: string; requestId?: string; value?: unknown };
    assert.equal(startResponse.type, "accepted");
    assert.equal(startResponse.requestId, "serialize_start");
    const stopping = exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "serialize_stop_hello" },
      { type: "ptt_stop", requestId: "serialize_stop" },
    ]);
    await stopEntered.promise;
    const cancellation = exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "serialize_cancel_hello" },
      { type: "capture_cancel", requestId: "serialize_cancel", reasonCode: "user_released" },
    ]);
    stopGate.resolve();
    await stopping;
    await cancellation;
    assert.equal(consumed, true);
    assert.equal(cancelledBeforeConsumed, false);
  } finally {
    await gateway.close();
  }
});

test("concurrent cancellation coalesces native device cancel per capture generation", async () => {
  const token = "voice_token_1234567890";
  let cancelCalls = 0;
  let concurrentCancels = 0;
  let maximumConcurrentCancels = 0;
  const cancelEntered = deferred<void>();
  const cancelGate = deferred<void>();
  const capture = {
    async start() {},
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {
      cancelEntered.resolve();
      cancelCalls++;
      concurrentCancels++;
      maximumConcurrentCancels = Math.max(maximumConcurrentCancels, concurrentCancels);
      await cancelGate.promise;
      concurrentCancels--;
    },
  };
  const gateway = await startVoiceGateway({ port: 0, token, capture });
  try {
    const responsesPromise = exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "coalesce_hello" },
      { type: "stop_all", requestId: "coalesce_stop_1", reasonCode: "user_released" },
      { type: "stop_all", requestId: "coalesce_stop_2", reasonCode: "user_released" },
    ]);
    await cancelEntered.promise;
    assert.equal(cancelCalls, 1);
    assert.equal(maximumConcurrentCancels, 1);
    cancelGate.resolve();
    await responsesPromise;
  } finally {
    await gateway.close();
  }
});

test("stop_all exposes hardware cleanup failure instead of acknowledging success", async () => {
  const token = "voice_token_1234567890";
  let cancellations = 0;
  const capture = {
    async start() {},
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {
      cancellations++;
      if (cancellations === 1) throw new Error("hardware_cleanup_failed");
    },
  };
  const gateway = await startVoiceGateway({ port: 0, token, capture });
  try {
    assert.deepEqual(
      await exchange(gateway.port, [
        { type: "hello", token, protocolVersion: 1, requestId: "cleanup_hello" },
        { type: "stop_all", requestId: "cleanup_stop", reasonCode: "user_stop" },
      ]),
      [
        { type: "hello_ack", requestId: "cleanup_hello", protocolVersion: 1 },
        { type: "error", requestId: "cleanup_stop", reasonCode: "hardware_cleanup_failed" },
      ],
    );
  } finally {
    await gateway.close();
  }
});

test("nonsettling cancel blocks a later ptt_start without overlapping native device operations", async () => {
  const token = "voice_token_1234567890";
  const cancelEntered = deferred<void>();
  const cancelGate = deferred<void>();
  const cancelSettled = deferred<void>();
  let starts = 0;
  const capture = {
    async start() {
      starts++;
    },
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {
      cancelEntered.resolve();
      await cancelGate.promise;
      cancelSettled.resolve();
    },
  };
  const gateway = await startVoiceGateway({ port: 0, token, capture });
  try {
    const stopResponses = exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "pending_cancel_hello" },
      { type: "stop_all", requestId: "pending_cancel_stop", reasonCode: "user_released" },
    ]);
    await cancelEntered.promise;

    // The cancel is deliberately unsettled while the retry is admitted. This
    // exercises the native cleanup fence without using a phase-control timer.
    const failedStart = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "pending_start_hello" },
      { type: "ptt_start", requestId: "pending_start", sessionId: "pending_session" },
    ]);
    assert.deepEqual(failedStart.at(-1), {
      type: "error",
      requestId: "pending_start",
      reasonCode: "capture_cleanup_pending",
    });
    assert.equal(starts, 0);

    // Once the previously nonsettling cancel settles, the failed admission
    // must not leave core.startPtt's logical capture behind and poison retry.
    cancelGate.resolve();
    await cancelSettled.promise;
    assert.deepEqual((await stopResponses).at(-1), {
      type: "accepted",
      requestId: "pending_cancel_stop",
      value: true,
    });
    const validStart = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "valid_start_hello" },
      {
        type: "ptt_start",
        requestId: "valid_start",
        sessionId: "valid_session",
        inputId: "valid_start",
      },
    ]);
    assert.deepEqual(validStart.at(-1), {
      type: "accepted",
      requestId: "valid_start",
      value: "valid_start",
    });
    assert.equal(starts, 1);
  } finally {
    cancelGate.resolve();
    await gateway.close().catch(() => undefined);
  }
});

test("gateway close bounds a nonsettling capture cleanup and reports unresolved cleanup", async () => {
  const token = "voice_token_1234567890";
  const capture = {
    async start() {},
    async stop() {
      return new Uint8Array([0, 0]);
    },
    async cancel() {
      await new Promise<void>(() => undefined);
    },
  };
  const gateway = await startVoiceGateway({ port: 0, token, capture });
  const socket = createConnection({ host: "127.0.0.1", port: gateway.port });
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => resolvePromise());
  });
  const closed = new Promise<void>((resolvePromise) => socket.once("close", () => resolvePromise()));
  const startedAt = Date.now();
  await assert.rejects(gateway.close(), (error: unknown) => {
    assert.equal(error instanceof Error && error.message, "voice_gateway_cleanup_timeout");
    assert.deepEqual((error as { unresolved?: readonly string[] }).unresolved, ["capture_device_cancel"]);
    return true;
  });
  await closed;
  assert.ok(Date.now() - startedAt < 2_000);
});

test("standalone Voice Gateway rejects non-loopback bind addresses", async () => {
  await assert.rejects(
    () => startVoiceGateway({ port: 0, token: "voice_token_1234567890", host: "0.0.0.0" as never }),
    /voice_gateway_loopback_required/,
  );
});

test("events responses paginate before a valid poll can exceed the NDJSON frame cap", async () => {
  const token = "voice_token_1234567890";
  const core = new VoiceGatewayCore(
    {
      providerId: "fake_asr",
      modelRevision: "v1",
      async transcribe() {
        return "x".repeat(4_000);
      },
    },
    { providerId: "fake_tts", modelRevision: "v1", ready: true, async *synthesize() {} },
    { ready: true, play() {}, stop() {} },
  );
  for (let index = 0; index < 24; index += 1) {
    core.startPtt("page_session", `page_input_${index}`);
    core.pushPcm(new Uint8Array([0, 0]));
    await core.stopPtt();
  }
  const gateway = await startVoiceGateway({ port: 0, token, core });
  try {
    const first = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "page_hello" },
      { type: "events", requestId: "page_first", sessionId: "page_session" },
    ]);
    const firstPage = first[1] as { type: string; events: unknown[]; next: number };
    assert.equal(firstPage.type, "events");
    assert.ok(firstPage.events.length > 0);
    assert.ok(firstPage.events.length < core.events.length);
    assert.ok(Buffer.byteLength(`${JSON.stringify(firstPage)}\n`, "utf8") <= MAX_NDJSON_FRAME_BYTES);
    const second = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "page_hello_2" },
      { type: "events", requestId: "page_second", sessionId: "page_session", after: firstPage.next },
    ]);
    const secondPage = second[1] as { type: string; events: unknown[]; next: number };
    assert.equal(secondPage.type, "events");
    assert.ok(secondPage.events.length > 0);
    assert.ok(Buffer.byteLength(`${JSON.stringify(secondPage)}\n`, "utf8") <= MAX_NDJSON_FRAME_BYTES);
  } finally {
    await gateway.close();
  }
});

test("standalone Voice Gateway validates media, speech and event request shapes before dispatch", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  try {
    const responses = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: "hello_shape_01" },
      { type: "ptt_frame", requestId: "bad_base64_01", pcm16Base64: "not-base64" },
      {
        type: "ptt_frame",
        requestId: "bad_format_01",
        pcm16Base64: "AAE=",
        format: { sampleRate: 8_000, channels: 1, encoding: "pcm_s16le" },
      },
      { type: "speech_enqueue", requestId: "bad_job_01", job: { jobId: "job_01" } },
      { type: "events", requestId: "bad_cursor_01", after: -1 },
    ]);
    assert.equal(responses.length, 5);
    assert.equal(responses.filter((response) => (response as { type?: unknown }).type === "hello_ack").length, 1);
    assert.equal(
      responses.filter(
        (response) =>
          (response as { type?: unknown }).type === "error" &&
          (response as { reasonCode?: unknown }).reasonCode === "malformed_request",
      ).length,
      4,
    );
  } finally {
    await gateway.close();
  }
});

test("standalone Voice Gateway fails closed before authentication and survives malformed peers", async () => {
  const token = "voice_token_1234567890";
  const gateway = await startVoiceGateway({ port: 0, token });
  try {
    assert.deepEqual(await exchange(gateway.port, [{ type: "health", requestId: "health_02" }]), [
      { type: "error", requestId: "health_02", reasonCode: "unauthenticated" },
    ]);
    assert.deepEqual(await exchange(gateway.port, [null, [], 1]), [
      { type: "error", requestId: null, reasonCode: "malformed_request" },
      { type: "error", requestId: null, reasonCode: "malformed_request" },
      { type: "error", requestId: null, reasonCode: "malformed_request" },
    ]);
    assert.deepEqual(
      (
        await exchange(gateway.port, [
          { type: "hello", token, protocolVersion: 1, requestId: "hello_03" },
          { type: "ptt_start", requestId: "ptt_01", sessionId: "session_01" },
          { type: "ptt_frame", requestId: "frame_01", pcm16Base64: "AAE=" },
          { type: "ptt_stop", requestId: "stop_01" },
          { type: "events", requestId: "events_01", sessionId: "session_01" },
        ])
      )[0],
      { type: "hello_ack", requestId: "hello_03", protocolVersion: 1 },
    );
  } finally {
    await gateway.close();
  }
});
