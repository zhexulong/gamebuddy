import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { VoiceGatewayProbeClient } from "./voice-gateway-probe-client.mjs";

const TOKEN = "voice_gate_token_1234";

test("voice live-gate probe authenticates and accepts fragmented strict protocol responses", async () => {
  await withServer(
    (socket) => {
      let requests = 0;
      socket.on("data", () => {
        requests++;
        const response =
          requests === 1
            ? '{"type":"hello_ack","requestId":"hello_01","protocolVersion":1}\n'
            : '{"type":"health","requestId":"health_01","status":"ready","protocolVersion":1,"capabilities":{"providerId":"mimo","modelRevision":"v1","perUtteranceDirection":false,"ready":true,"epoch":0}}\n';
        const bytes = Buffer.from(response, "utf8");
        socket.write(bytes.subarray(0, 7));
        socket.write(bytes.subarray(7));
      });
    },
    async (port) => {
      const client = await VoiceGatewayProbeClient.connect(port, TOKEN);
      try {
        const health = await client.request({ type: "health", requestId: "health_01" });
        assert.equal(health.type, "health");
        assert.equal(health.capabilities.ready, true);
      } finally {
        client.close();
      }
    },
  );
});

test("voice live-gate probe fails closed for a response that violates the strict protocol", async () => {
  await withServer(
    (socket) => {
      socket.on("data", () => {
        socket.write('{"type":"hello_ack","requestId":"hello_01","protocolVersion":1,"extra":true}\n');
      });
    },
    async (port) => {
      await assert.rejects(VoiceGatewayProbeClient.connect(port, TOKEN), /invalid_voice_gateway_response/);
    },
  );
});

test("voice live-gate runners have no raw framing or JSON wire bypass", async () => {
  for (const path of [
    "tools/run-windows-voice-output-gate.mjs",
    "tools/run-windows-sensevoice-final-transcript-gate.mjs",
  ]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /VoiceGatewayProbeClient/);
    assert.doesNotMatch(source, /node:net|createConnection|JSON\.parse\(line\)|\.split\("\\n"\)|\.indexOf\("\\n"\)/);
  }
  const helper = await readFile("tools/lib/voice-gateway-probe-client.mjs", "utf8");
  assert.match(helper, /packages\/voice-protocol\/dist\/index\.js/);
  assert.match(helper, /createBoundedUtf8NdjsonDecoder/);
  assert.match(helper, /encodeVoiceGatewayMessage/);
  assert.match(helper, /parseVoiceGatewayResponse/);
});

async function withServer(onConnection, run) {
  const server = createServer(onConnection);
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test_server_address_unavailable");
    await run(address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
