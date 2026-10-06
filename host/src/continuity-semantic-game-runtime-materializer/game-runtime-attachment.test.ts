import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  createGameRuntimeAttachment,
  type GameRuntimeRecoveryAttachment,
} from "./game-runtime-attachment.js";

const hostBindingFactory = () => undefined;

async function runtimeRootWithProfiles(
  prefix: string,
  profiles: unknown,
): Promise<string> {
  const runtimeRoot = join(await canonicalTestRoot(prefix), "runtime");
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  await writeFile(
    join(runtimeRoot, "settings", "model-profiles.json"),
    JSON.stringify(profiles),
  );
  return runtimeRoot;
}

test("an unarmed Game runtime attachment still carries the player's own Game profile model", async () => {
  // The operational gate nonce arms the gameplay worker; it must never decide
  // whether the Game surface has a model. Before this invariant held, an
  // unarmed Game runtime was constructed with no model configuration at all.
  const runtimeRoot = await runtimeRootWithProfiles("game-runtime-attachment-", {
    schemaVersion: 1,
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
    game: { revision: 7, modelId: "player-game-model", thinkingLevel: "medium" },
  });
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot,
    gameplayWorkerEnabled: false,
    hostBindingFactory,
  });
  // The Game profile decides, never the Chat profile and never a shipped
  // default the player did not choose.
  assert.deepEqual(attachment.modelConfig, {
    provider: "cpa-oai",
    modelId: "player-game-model",
    thinkingLevel: "medium",
  });
  assert.equal(attachment.gameplaySubagentEnabled, false);
  assert.equal(attachment.hostBindingFactory, hostBindingFactory);
});

test("a Game runtime root without a saved profile takes the store's shipped Game profile", async () => {
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot: join(await canonicalTestRoot("game-runtime-attachment-default-"), "runtime"),
    gameplayWorkerEnabled: true,
    hostBindingFactory,
  });
  // A root with no saved profile is not a refusal: the store itself ships the
  // recommendation both surfaces start from, and the worker arming flag
  // travels with the model rather than replacing it.
  assert.deepEqual(attachment.modelConfig, {
    provider: "cpa-oai",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "high",
  });
  assert.equal(attachment.gameplaySubagentEnabled, true);
});

test("a store that cannot yield a Game profile refuses the attachment instead of building a model-less runtime", async () => {
  const runtimeRoot = await runtimeRootWithProfiles("game-runtime-attachment-refusal-", {
    schemaVersion: 1,
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
  });
  await assert.rejects(
    () =>
      createGameRuntimeAttachment({
        runtimeRoot,
        gameplayWorkerEnabled: false,
        hostBindingFactory,
      }),
    /invalid_model_profile_store/,
  );
});

test("the construction zone's recovery composition reaches the attachment unchanged", async () => {
  const recoveryJournal = Object.freeze({});
  const recoveryBinding = Object.freeze({
    scope: Object.freeze({}),
    bindingIdentity: Object.freeze({}),
  });
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot: join(await canonicalTestRoot("game-runtime-attachment-recovery-"), "runtime"),
    gameplayWorkerEnabled: true,
    hostBindingFactory,
    recoveryAttachment: Object.freeze({
      recoveryJournal,
      recoveryBinding,
    }) as unknown as GameRuntimeRecoveryAttachment,
  });
  assert.equal(Object.is(attachment.recoveryJournal, recoveryJournal), true);
  assert.equal(Object.is(attachment.recoveryBinding, recoveryBinding), true);
  assert.equal(attachment.recoveryPort, undefined);
});
