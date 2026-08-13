import assert from "node:assert/strict";
import test from "node:test";
import { connectHealthyVoiceGateway, connectHealthyVoiceGatewayWith } from "./voice-bootstrap.js";

const config = { port: 8383, token: "1234567890abcdef" };

test("Voice bootstrap awaits close before rethrowing a health failure", async () => {
  let closeStarted = false;
  let closeSettled = false;
  let resolveCloseStarted!: () => void;
  const closeStartedPromise = new Promise<void>((resolve) => {
    resolveCloseStarted = resolve;
  });
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const healthError = new Error("unhealthy");
  const outcome = connectHealthyVoiceGatewayWith(config, async () => ({
    health: async () => {
      throw healthError;
    },
    close: async () => {
      closeStarted = true;
      resolveCloseStarted();
      await closeReleased;
      closeSettled = true;
    },
  }));

  await closeStartedPromise;
  assert.equal(closeStarted, true);
  assert.equal(closeSettled, false);

  releaseClose();
  await assert.rejects(outcome, (error) => error === healthError);
  assert.equal(closeSettled, true);
});

test("Voice bootstrap preserves health and close failures in an aggregate", async () => {
  const healthError = new Error("unhealthy");
  const closeError = new Error("close failed");
  await assert.rejects(
    connectHealthyVoiceGatewayWith(config, async () => ({
      health: async () => {
        throw healthError;
      },
      close: async () => {
        throw closeError;
      },
    })),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [healthError, closeError]);
      return true;
    },
  );
});

test("Voice bootstrap probes the configured voice profile before accepting the connection", async () => {
  let probedProfile: string | undefined;
  const voice = {
    health: async (voiceProfile?: string) => {
      probedProfile = voiceProfile;
      return {
        providerId: "fixture",
        modelRevision: "v1",
        perUtteranceDirection: true,
        ready: true,
        epoch: 1,
      };
    },
    close: () => undefined,
  };
  assert.equal(
    await connectHealthyVoiceGatewayWith(config, async () => voice, "companion.default"),
    voice,
  );
  assert.equal(probedProfile, "companion.default");
});

test("Voice bootstrap returns only a healthy acquired connection", async () => {
  const voice = {
    health: async () => ({
      providerId: "fixture",
      modelRevision: "v1",
      perUtteranceDirection: true,
      ready: true,
      epoch: 1,
    }),
    close: () => undefined,
  };
  assert.equal(await connectHealthyVoiceGatewayWith(config, async () => voice), voice);
  assert.equal(await connectHealthyVoiceGateway(undefined), undefined);
});
