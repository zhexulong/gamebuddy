import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";

import { startVoiceGateway } from "./server.js";

async function exchange(port: number, messages: readonly unknown[]): Promise<unknown[]> {
  return await new Promise<unknown[]>((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }); let output = "";
    socket.setEncoding("utf8"); socket.once("error", reject);
    socket.on("connect", () => socket.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`));
    socket.on("data", (chunk: string) => { output += chunk; if (output.split("\n").filter(Boolean).length >= messages.length) socket.end(); });
    socket.on("end", () => resolvePromise(output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown)));
  });
}

test("standalone Voice Gateway requires local authenticated protocol-v1 health handshake", async () => {
  const token = "voice_token_1234567890"; const gateway = await startVoiceGateway({ port: 0, token });
  try {
    const id = randomUUID(); const [hello, health] = await exchange(gateway.port, [
      { type: "hello", token, protocolVersion: 1, requestId: id }, { type: "health", requestId: "health_01" },
    ]);
    assert.deepEqual(hello, { type: "hello_ack", requestId: id, protocolVersion: 1 });
    assert.deepEqual(health, { type: "health", requestId: "health_01", status: "ready", protocolVersion: 1 });
  } finally { await gateway.close(); }
});

test("standalone Voice Gateway rejects non-loopback bind addresses", async () => {
  await assert.rejects(() => startVoiceGateway({ port: 0, token: "voice_token_1234567890", host: "0.0.0.0" as never }), /voice_gateway_loopback_required/);
});

test("standalone Voice Gateway fails closed before authentication and survives malformed peers", async () => {
  const token = "voice_token_1234567890"; const gateway = await startVoiceGateway({ port: 0, token });
  try {
    assert.deepEqual(await exchange(gateway.port, [{ type: "health", requestId: "health_02" }]), [{ type: "error", requestId: "health_02", reasonCode: "unauthenticated" }]);
    assert.deepEqual(await exchange(gateway.port, [null, [], 1]), [
      { type: "error", requestId: null, reasonCode: "malformed_request" },
      { type: "error", requestId: null, reasonCode: "malformed_request" },
      { type: "error", requestId: null, reasonCode: "malformed_request" },
    ]);
    assert.deepEqual((await exchange(gateway.port, [{ type: "hello", token, protocolVersion: 1, requestId: "hello_03" }, { type: "ptt_start", requestId: "ptt_01", sessionId: "session_01" }, { type: "ptt_frame", requestId: "frame_01", pcm16Base64: "AAE=" }, { type: "ptt_stop", requestId: "stop_01" }, { type: "events", requestId: "events_01" }]))[0], { type: "hello_ack", requestId: "hello_03", protocolVersion: 1 });
  } finally { await gateway.close(); }
});
