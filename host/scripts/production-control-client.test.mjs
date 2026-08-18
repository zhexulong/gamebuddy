import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createProductionControlClient } from "./production-control-client.mjs";

class FakePipe extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.requests = [];
    queueMicrotask(() => this.emit("connect"));
  }

  write(line, callback) {
    try {
      const request = JSON.parse(line.trim());
      this.requests.push(request);
      const reply = this.handler(request, this.requests.length);
      if (reply !== undefined) queueMicrotask(() => this.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`, "utf8")));
      callback?.();
    } catch (error) {
      callback?.(error);
    }
    return true;
  }

  destroy() { queueMicrotask(() => this.emit("close")); }
}

const capability = { pipeName: "pipe_one", launchToken: "a".repeat(32) };

test("production control client sends a single authenticated sequence and keeps the launch material outside requests after hello", async () => {
  let pipe;
  const client = createProductionControlClient({
    ...capability,
    connectPipe: () => {
      pipe = new FakePipe((request) => {
        if (request.type === "hello") return { ok: true, runtimeInstanceId: "runtime_one", protocolVersion: 1 };
        if (request.type === "player_input") return { ok: true, accepted: "player_input" };
        if (request.type === "stop_all") return { ok: true, accepted: "duplicate_stop" };
        throw new Error("unexpected_control_request");
      });
      return pipe;
    },
  });
  assert.deepEqual(await client.hello(), { runtimeInstanceId: "runtime_one" });
  await client.playerInput({ requestId: "input_one", sourceEventId: "source_one", text: "安全测试", locale: "zh-CN" });
  assert.deepEqual(await client.stopAll({ requestId: "stop_one", stopId: "stop_one", sourceEventId: "source_stop" }), { accepted: "duplicate_stop" });
  await client.close();
  assert.deepEqual(pipe.requests.map((request) => request.type), ["hello", "player_input", "stop_all"]);
  assert.equal(JSON.stringify(pipe.requests.slice(1)).includes(capability.launchToken), false);
});

test("production control client preserves active, queued, and idle STOP outcomes", async () => {
  let index = 0;
  const outcomes = ["active_turn_cancelled", "queued_turn_cancelled", "no_active_turn"];
  const client = createProductionControlClient({
    ...capability,
    connectPipe: () =>
      new FakePipe((request) => {
        if (request.type === "hello") return { ok: true, runtimeInstanceId: "runtime_one", protocolVersion: 1 };
        if (request.type === "stop_all") return { ok: true, accepted: outcomes[index++] };
        throw new Error("unexpected_control_request");
      }),
  });
  await client.hello();
  assert.deepEqual(await client.stopAll({ requestId: "stop_active", stopId: "stop_active", sourceEventId: "source_active" }), {
    accepted: "active_turn_cancelled",
  });
  assert.deepEqual(await client.stopAll({ requestId: "stop_queued", stopId: "stop_queued", sourceEventId: "source_queued" }), {
    accepted: "queued_turn_cancelled",
  });
  assert.deepEqual(await client.stopAll({ requestId: "stop_idle", stopId: "stop_idle", sourceEventId: "source_idle" }), {
    accepted: "no_active_turn",
  });
  await client.close();
});

test("production control client rejects a bad hello, unsolicited reply, and invalid request before it can cross the pipe", async () => {
  let pipe;
  const client = createProductionControlClient({
    ...capability,
    connectPipe: () => {
      pipe = new FakePipe(() => ({ ok: true, accepted: "player_input" }));
      return pipe;
    },
  });
  await assert.rejects(client.hello(), /control_client_hello_rejected/);
  await assert.rejects(client.playerInput({ requestId: "input_one", sourceEventId: "source_one", text: "x", locale: "zh-CN" }), /control_client_hello_required/);
  assert.equal(pipe.requests.length, 1);
  await client.close();
});

test("production control client rejects invalid capability and never uses the platform pipe through its test-only connector", () => {
  assert.throws(() => createProductionControlClient({ pipeName: "invalid pipe", launchToken: "a".repeat(32), connectPipe: () => undefined }), /invalid_product_control_capability/);
  assert.throws(() => createProductionControlClient({ ...capability, requestTimeoutMs: 2, connectPipe: () => undefined }), /invalid_product_control_client_options/);
});
