import assert from "node:assert/strict";
import test from "node:test";
import { connectHealthyVoiceGateway, connectHealthyVoiceGatewayWith } from "./voice-bootstrap.js";

const config = { port: 8383, token: "1234567890abcdef" };

test("Voice bootstrap closes an acquired connection when health rejects", async () => {
  let closed = false;
  await assert.rejects(
    () => connectHealthyVoiceGatewayWith(config, async () => ({
      health: async () => { throw new Error("unhealthy"); },
      close: () => { closed = true; },
    })),
    /unhealthy/,
  );
  assert.equal(closed, true);
});

test("Voice bootstrap returns only a healthy acquired connection", async () => {
  const voice = { health: async () => undefined, close: () => undefined };
  assert.equal(await connectHealthyVoiceGatewayWith(config, async () => voice), voice);
  assert.equal(await connectHealthyVoiceGateway(undefined), undefined);
});
