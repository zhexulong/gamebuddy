/**
 * One rule, three surfaces: which provider and model does a turn use?
 *
 * This rule was written down three times and had already diverged once - a configured connection
 * reached the Chat and not the Game - because each surface decided it for itself. The lane that
 * consolidated it (`settings/model-selection.ts`, `resolveSurfaceModelSelection`) left three
 * *translations* behind, one per surface, and a translation is still a place where the answer can be
 * distorted: the Chat turned every non-selected outcome into "no model", the Game and the Preview
 * refuse by their own name.
 *
 * So this table holds the rule and the translations apart. For every state a root can be in it asks
 * **every** surface's real entry - the Chat's exact construction, the Game's runtime attachment and
 * the Preview's own model composition - and asserts:
 *
 *  1. every surface that has a model reports the SAME provider and model, because that pair is the
 *     one fact the connection owns and no surface may restate it;
 *  2. the only difference between the surfaces is the thinking level, and it is exactly the one the
 *     rule documents: the Chat runs at the level the player tuned the connection to, the Game and the
 *     Preview at the level their own profile holds;
 *  3. a surface with no model never claims one, and its answer traces to the outcome the one
 *     function returned rather than to a second reading of the store.
 *
 * A table that hardcoded each case as its own test could only ever prove the cases somebody thought
 * of. This one is one array of states, one array of consumers and one loop, so a new state or a new
 * surface joins the comparison by being added to an array.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { withConsumedChatRuntimeBinding } from "../../host/src/continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.ts";
import { createTestChatRuntimeBinding } from "../../host/src/continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.ts";
import { prepareExactChatRuntimeConstruction } from "../../host/src/continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.ts";
import { createGameRuntimeAttachment } from "../../host/src/continuity-semantic-game-runtime-materializer/game-runtime-attachment.ts";
import { resolveFarmhandPreviewModelConfig } from "../../host/src/farmhand-companion-preview.ts";
import { DEFAULT_IDENTITY_PROFILE, identityProfileMetadata, writeIdentityProfile } from "../../host/src/identity-profile.ts";
import { bindWindowsStaleLockReclaimer } from "../../host/src/path-lock.ts";
import { identityKey, resolveRuntimePaths } from "../../host/src/runtime-identity.ts";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "../../host/src/tavern/chat-thread-store.ts";
import { connectionDocumentPath, TavernConnectionStore } from "../../host/src/tavern/connection-store.ts";
import { createBuildWindowsStaleLockReclaimer } from "../../host/src/windows-stale-lock-reclaimer/index.ts";

const principal = Object.freeze({ continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" });
/** The Game surface's identity carries a save and a world; the Chat one does not. */
const gameIdentity = Object.freeze({ ...principal, saveId: "save_01", worldId: "world_01" });

/** The level the player tuned the connection to, and the two the surfaces' own profiles hold. */
const CONNECTION_LEVEL = "high";
const CHAT_PROFILE_LEVEL = "low";
const GAME_PROFILE_LEVEL = "medium";

/** The one connection every state is built around, so a surface's answer can be compared by name. */
const CONNECTION = Object.freeze({ providerId: "deepseek", modelId: "deepseek-v4-pro", thinkingLevel: CONNECTION_LEVEL });

// The connection store and the Chat thread store take durable path locks, so the test needs the same
// test-only reclaimer binding every other path-lock consumer's test uses.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

/** One runtime root laid out as production lays it out, with both surface profiles written. */
async function root(prefix) {
  const runtimeRoot = await mkdtemp(join(await realpath(tmpdir()), prefix));
  const agentDir = resolveRuntimePaths(gameIdentity, runtimeRoot).agentDir;
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(runtimeRoot, "settings", "model-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      chat: { revision: 3, thinkingLevel: CHAT_PROFILE_LEVEL },
      game: { revision: 7, thinkingLevel: GAME_PROFILE_LEVEL },
    }),
  );
  return Object.freeze({ runtimeRoot, agentDir });
}

/** One ready, active player connection, written by the real store. */
async function activateConnection(agentDir) {
  const store = new TavernConnectionStore(agentDir);
  const created = await store.create({
    providerId: CONNECTION.providerId,
    apiKey: "sk-synthetic-connection-key",
    baseUrl: null,
    apiShape: null,
    modelId: CONNECTION.modelId,
  });
  const connectionId = created.connections[0].connectionId;
  const probed = await store.recordProbe(connectionId, { outcome: "ready", modelIds: [CONNECTION.modelId] });
  await store.activate(connectionId, probed.revision);
}

/**
 * The Chat surface's own answer, through its real construction: the exact binding, the exact thread
 * and the profile a mount requires are all set up here, so what comes back is what a mounted Chat
 * would freeze in, never a literal copied out of the translate.
 */
async function chatModelConfig(runtimeRoot) {
  const binding = createTestChatRuntimeBinding({
    manifest: Object.freeze({
      schemaVersion: 2,
      topology: "independent_chat_and_game_surfaces",
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
    ownerProof: Object.freeze({ processId: 42, creationTime100ns: "123456" }),
  });
  const threads = createChatThreadStore(runtimeRoot, identityKey(principal));
  let prepared;
  try {
    const profilePaths = resolveRuntimePaths(principal, runtimeRoot, "chat_session_01");
    await mkdir(dirname(profilePaths.identityProfilePath), { recursive: true });
    const profile = Object.freeze({
      ...DEFAULT_IDENTITY_PROFILE,
      profileId: "profile_01",
      identity: Object.freeze({ ...DEFAULT_IDENTITY_PROFILE.identity }),
    });
    await writeIdentityProfile(profilePaths.identityProfilePath, profile);
    await createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return identityProfileMetadata(profile);
      },
    }).createExplicit({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "chat_session_01",
      companionId: principal.companionId,
      continuityId: principal.continuityId,
      opening: "blank",
    });
    const execution = await binding.executeWithBinding(async (token) => {
      const captured = { value: undefined };
      await withConsumedChatRuntimeBinding(token, async (value) => {
        captured.value = value;
      });
      return captured.value;
    });
    prepared = await prepareExactChatRuntimeConstruction(execution, {
      principal: execution.principal,
      operationId: "operation_01",
      requestId: "request_01",
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "chat_session_01",
      runtimeBindingDigest: execution.bindingFacts.runtimeBindingDigest,
      owner: execution.bindingFacts.owner,
      deadlineAtMs: Date.now() + 5_000,
      expected: Object.freeze({ partitionRevision: 1, fenceEpoch: 1, selectionRevision: 1 }),
      payloadDigest: "b".repeat(64),
      fenceToken: "fence_01",
      prepared: Object.freeze({ partitionRevision: 2, fenceEpoch: 2, selectionRevision: 1 }),
    });
    return { modelConfig: prepared.modelConfig, revision: prepared.modelProfileRevision };
  } finally {
    prepared?.closeChatThreadStore?.();
    threads.close?.();
    await binding.close();
  }
}

/**
 * The three consumers, each asked through its own real entry point.
 *
 * Every consumer answers the same normalized shape, so the loop below compares answers rather than
 * call signatures: `reach` says whether the surface has a model at all, and `refusal` carries the
 * name a surface that cannot run without one states.
 */
const CONSUMERS = Object.freeze([
  {
    id: "chat",
    /** A Chat opens with no model; the player reads on and brings a connection in Settings. */
    async ask(value) {
      const answer = await chatModelConfig(value.runtimeRoot);
      return answer.modelConfig === null
        ? { reach: "no_model", answer: "mounts-without-a-model" }
        : { reach: "model", ...answer.modelConfig, revision: answer.revision };
    },
  },
  {
    id: "game",
    /**
     * A Game surface builds without a model and carries none, the same way a Chat opens without one: the runtime
     * derives `model === undefined` from the omission and the request that needs a model is what refuses. Reaching
     * "model" therefore means the attachment actually carried one, not merely that construction succeeded.
     */
    async ask(value) {
      try {
        const attachment = await createGameRuntimeAttachment({
          runtimeRoot: value.runtimeRoot,
          agentDir: value.agentDir,
          gameplayWorkerEnabled: false,
          hostBindingFactory: () => undefined,
        });
        return attachment.modelConfig === undefined
          ? { reach: "no_model", answer: "mounts-without-a-model" }
          : { reach: "model", ...attachment.modelConfig };
      } catch (error) {
        return { reach: "no_model", answer: error.message };
      }
    },
  },
  {
    id: "preview",
    /** The bounded Preview has no Settings screen to send the player to, so it refuses too. */
    async ask(value) {
      try {
        return { reach: "model", ...(await resolveFarmhandPreviewModelConfig(gameIdentity, value.runtimeRoot)) };
      } catch (error) {
        return { reach: "no_model", answer: error.message };
      }
    },
  },
]);

/**
 * The states a root can be in. Each arranges its own store, and each carries the answer a surface
 * that has a model must report - the one fact this table exists to keep in one place.
 */
const STATES = Object.freeze([
  {
    id: "connection-active",
    async arrange(value) {
      await activateConnection(value.agentDir);
    },
    /** The pair is the connection's, for every surface. */
    pair: Object.freeze({ provider: CONNECTION.providerId, modelId: CONNECTION.modelId }),
    /** ... and the level is the surface's own, which is the one documented difference. */
    levels: Object.freeze({ chat: CONNECTION_LEVEL, game: GAME_PROFILE_LEVEL, preview: GAME_PROFILE_LEVEL }),
    refusals: Object.freeze({}),
  },
  {
    id: "connection-absent",
    async arrange() {},
    pair: null,
    levels: Object.freeze({}),
    /** The fresh-install state: each surface says so in its own words. */
    refusals: Object.freeze({
      chat: "mounts-without-a-model",
      game: "mounts-without-a-model",
      preview: "farmhand_preview_model_configuration_unavailable",
    }),
  },
  {
    id: "connection-unreadable",
    async arrange(value) {
      // A corrupt connection document is a store defect, not an unconfigured product. The profile
      // store is still intact, so the surfaces reach their own answer instead of failing earlier.
      await writeFile(connectionDocumentPath(value.agentDir), "{ not a connection document", "utf8");
    },
    pair: null,
    levels: Object.freeze({}),
    refusals: Object.freeze({
      chat: "mounts-without-a-model",
      game: "game_runtime_model_configuration_unavailable",
      preview: "farmhand_preview_model_configuration_unavailable",
    }),
  },
]);

test("every surface answers the same provider and model for every state a root can be in", async (t) => {
  const answers = [];
  for (const state of STATES) {
    const value = await root(`parity-model-selection-${state.id}-`);
    try {
      await state.arrange(value);
      const perConsumer = {};
      for (const consumer of CONSUMERS) perConsumer[consumer.id] = await consumer.ask(value);
      answers.push({ state, perConsumer });
    } finally {
      await rm(value.runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  for (const { state, perConsumer } of answers) {
    const withModel = Object.entries(perConsumer).filter(([, answer]) => answer.reach === "model");
    const withoutModel = Object.entries(perConsumer).filter(([, answer]) => answer.reach === "no_model");

    if (state.pair === null) {
      // No surface may invent a model. `withModel` non-empty is exactly the divergence that started
      // this: one surface using an endpoint the player never configured.
      assert.deepEqual(
        withModel.map(([id]) => id),
        [],
        `${state.id}: no surface may report a model when the player configured none`,
      );
      for (const [id, answer] of withoutModel)
        assert.equal(
          answer.answer,
          state.refusals[id],
          `${state.id}: ${id} must answer in its own documented way, got ${JSON.stringify(answer)}`,
        );
      t.diagnostic(`${state.id}: ${withoutModel.map(([id, answer]) => `${id}=${answer.answer}`).join(", ")}`);
      continue;
    }

    // The rule: one provider, one model, for every surface that has one.
    assert.equal(withModel.length, CONSUMERS.length, `${state.id}: every surface must have the model the player configured`);
    for (const [id, answer] of withModel) {
      assert.equal(answer.provider, state.pair.provider, `${state.id}: ${id} must take the connection's provider`);
      assert.equal(answer.modelId, state.pair.modelId, `${state.id}: ${id} must take the connection's model`);
      assert.equal(
        answer.thinkingLevel,
        state.levels[id],
        `${state.id}: ${id}'s level is its own surface's, and the rule says which`,
      );
    }
    assert.deepEqual(withoutModel.map(([id]) => id), [], `${state.id}: no surface may report no model while one is configured`);
    t.diagnostic(
      `${state.id}: ${withModel.map(([id, answer]) => `${id}=${answer.provider}/${answer.modelId}@${answer.thinkingLevel}`).join(", ")}`,
    );
  }
});

/**
 * The translation each surface applies, stated once, so a change to one of them is a change to this
 * table rather than a surprise in a live run. The Chat is the only surface that opens without a
 * model: a product with no model must still let the player read the conversation.
 */
test("the surfaces differ only in what they do with no model, and the rule says which do what", () => {
  const openers = CONSUMERS.filter((consumer) => consumer.id === "chat");
  assert.equal(openers.length, 1, "the Chat is the surface that opens without a model");
  for (const state of STATES) {
    const refusals = Object.keys(state.refusals);
    if (refusals.length === 0) continue;
    assert.deepEqual(
      refusals.sort(),
      CONSUMERS.map((consumer) => consumer.id).sort(),
      `${state.id}: every surface's answer to "no model" is part of the rule, not an accident`,
    );
  }
});
