import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { withConsumedChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import { createTestChatRuntimeBinding } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.test-support.js";
import { prepareExactChatRuntimeConstruction } from "../continuity-semantic-chat-runtime-construction/continuity-semantic-chat-runtime-construction.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { DEFAULT_IDENTITY_PROFILE, identityProfileMetadata, writeIdentityProfile } from "../identity-profile.js";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { identityKey, resolveRuntimePaths } from "../runtime-identity.js";
import { createChatThreadStore, createProfileAwareChatThreadCreationCapability } from "../tavern/chat-thread-store.js";
import { connectionAuthPath, connectionDocumentPath, TavernConnectionStore } from "../tavern/connection-store.js";
import { modelProviderEntry } from "../tavern/pi-provider-store.js";
import { catalogProvider } from "../tavern/provider-catalog.js";
import { ModelProfileStore } from "../settings/model-profile-store.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { createGameRuntimeAttachment, type GameRuntimeRecoveryAttachment } from "./game-runtime-attachment.js";

const hostBindingFactory = () => undefined;
const principal = Object.freeze({
  continuityId: "continuity_01",
  companionId: "companion_01",
  playerId: "player_01",
});
/** The Game surface's own identity carries the save and world; the Chat one does not. */
const gameIdentity = Object.freeze({ ...principal, saveId: "save_01", worldId: "world_01" });

// The connection store and the Chat thread store take durable path locks, so the
// tests need the same test-only reclaimer binding every other path-lock
// consumer's test uses; without it every mutation fails closed with a lock
// failure that has nothing to do with the store.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

type GameRoot = Readonly<{ runtimeRoot: string; agentDir: string }>;

/**
 * One runtime root as production derives it: the surface profiles live at the
 * root, and the player's connections live in the identity-scoped runtime
 * directory both surfaces derive from the identity they share.
 */
async function gameRoot(prefix: string, profiles: unknown): Promise<GameRoot> {
  const runtimeRoot = join(await canonicalTestRoot(prefix), "runtime");
  const agentDir = resolveRuntimePaths(gameIdentity, runtimeRoot).agentDir;
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  if (profiles !== undefined)
    await writeFile(join(runtimeRoot, "settings", "model-profiles.json"), JSON.stringify(profiles));
  return Object.freeze({ runtimeRoot, agentDir });
}

/** One ready, active player connection, written by the real store into that shared directory. */
async function activateConnection(
  agentDir: string,
  input: Readonly<{ providerId: string; modelId: string; apiKey: string }>,
): Promise<NonNullable<Awaited<ReturnType<TavernConnectionStore["active"]>>>> {
  const store = new TavernConnectionStore(agentDir);
  const created = await store.create({ ...input, baseUrl: null, apiShape: null });
  const connectionId = created.connections[0]!.connectionId;
  const probed = await store.recordProbe(connectionId, { outcome: "ready", modelIds: [input.modelId] });
  await store.activate(connectionId, probed.revision);
  const active = await store.active();
  assert.notEqual(active, null);
  return active!;
}

function permit(execution: ChatRuntimeBindingExecution): ProductionChatRuntimePermit {
  return Object.freeze({
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
}

/**
 * The Chat surface's own resolved model configuration, read from its real
 * construction over the same runtime root. The binding, the exact thread and the
 * profile it requires are set up here; only the configuration comes back, so the
 * parity assertions below compare two constructions' answers instead of a
 * literal copied out of one of them.
 */
async function chatModelConfig(
  runtimeRoot: string,
): Promise<Readonly<{ provider: string; modelId: string; thinkingLevel: string }>> {
  const binding = createTestChatRuntimeBinding({
    manifest: Object.freeze({
      schemaVersion: 2 as const,
      topology: "independent_chat_and_game_surfaces" as const,
      runtimeRoot,
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
    }),
    ownerProof: Object.freeze({ processId: 42, creationTime100ns: "123456" }),
  });
  const threads = createChatThreadStore(runtimeRoot, identityKey(principal));
  try {
    const profilePaths = resolveRuntimePaths(principal, runtimeRoot, "chat_session_01");
    await mkdir(dirname(profilePaths.identityProfilePath), { recursive: true });
    const profile = Object.freeze({
      ...DEFAULT_IDENTITY_PROFILE,
      profileId: "profile_01",
      identity: Object.freeze({ ...DEFAULT_IDENTITY_PROFILE.identity }),
    });
    await writeIdentityProfile(profilePaths.identityProfilePath, profile);
    const metadata = identityProfileMetadata(profile);
    await createProfileAwareChatThreadCreationCapability(threads, {
      async readExact() {
        return metadata;
      },
    }).createExplicit({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "chat_session_01",
      companionId: principal.companionId,
      continuityId: principal.continuityId,
      opening: "blank",
    });
    let prepared: Awaited<ReturnType<typeof prepareExactChatRuntimeConstruction>> | undefined;
    try {
      prepared = await binding.executeWithBinding((token) =>
        withConsumedChatRuntimeBinding(token, (execution) =>
          prepareExactChatRuntimeConstruction(execution, permit(execution)),
        ),
      );
      const modelConfig = prepared.modelConfig;
      // This helper's contract is "the model the player activated", so a root without one is a
      // fixture error rather than a value the parity assertions below should try to compare.
      assert.ok(modelConfig !== null, "the fixture activated a connection, so a model must resolve");
      return modelConfig;
    } finally {
      prepared?.closeChatThreadStore?.();
    }
  } finally {
    threads.close?.();
    await binding.close();
  }
}

test("an unarmed Game runtime attachment carries the player's own provider and model from the connection they activated", async () => {
  // The operational gate nonce arms the gameplay worker; it must never decide
  // whether the Game surface has a model.
  const value = await gameRoot("game-runtime-attachment-", {
    schemaVersion: 1,
    chat: { revision: 1, thinkingLevel: "low" },
    game: { revision: 7, thinkingLevel: "medium" },
  });
  const active = await activateConnection(value.agentDir, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKey: "sk-synthetic-connection-key",
  });
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot: value.runtimeRoot,
    agentDir: value.agentDir,
    gameplayWorkerEnabled: false,
    hostBindingFactory,
  });
  // The connection the player activated decides the provider and the model; the Game profile
  // decides only the level, which is this surface's own tuning. No shipped default is substituted
  // for either half.
  assert.deepEqual(attachment.modelConfig, {
    provider: active.providerId,
    modelId: active.modelId,
    thinkingLevel: "medium",
  });
  assert.equal(attachment.gameplaySubagentEnabled, false);
  assert.equal(attachment.hostBindingFactory, hostBindingFactory);
});

/**
 * A fresh root has no model, and the refusal names it.
 *
 * The premise this replaces: the store used to ship `deepseek-v4.1-flash` on the operator's
 * `cpa-oai` gateway, so a root with no connection configured still produced an attachment - a Game
 * runtime that would have sent into an endpoint existing on exactly one machine. With BYOK, no
 * connection is no model: the attachment refuses rather than inventing one, and the level the store
 * still owns travels to the surface that will use it once a connection exists.
 */
test("a Game root with no activated connection has no model and refuses by name", async () => {
  const value = await gameRoot("game-runtime-attachment-default-", undefined);
  await assert.rejects(
    () =>
      createGameRuntimeAttachment({
        runtimeRoot: value.runtimeRoot,
        agentDir: value.agentDir,
        gameplayWorkerEnabled: true,
        hostBindingFactory,
      }),
    /game_runtime_model_configuration_unavailable/,
  );
  // The store itself still answers: it owns the level, and the refusal is not a store failure.
  assert.equal(
    (await new ModelProfileStore(join(value.runtimeRoot, "settings", "model-profiles.json")).read("game"))
      .thinkingLevel,
    "high",
  );
});

test("a store that cannot yield a Game profile refuses the attachment instead of building a model-less runtime", async () => {
  const value = await gameRoot("game-runtime-attachment-refusal-", {
    schemaVersion: 1,
    chat: { revision: 1, thinkingLevel: "low" },
  });
  await assert.rejects(
    () =>
      createGameRuntimeAttachment({
        runtimeRoot: value.runtimeRoot,
        agentDir: value.agentDir,
        gameplayWorkerEnabled: false,
        hostBindingFactory,
      }),
    /invalid_model_profile_store/,
  );
});

test("a connection store that cannot be read refuses the Game attachment by the same named gate", async () => {
  // The third state a root can be in. The one owner of the selection rule answers `unreadable` for
  // it - a distinct fact from `no_model` - and this surface still refuses with the code its player
  // reads, because a Game runtime cannot start without a model whichever of the two it met.
  const value = await gameRoot("game-runtime-attachment-unreadable-", undefined);
  await mkdir(dirname(connectionDocumentPath(value.agentDir)), { recursive: true });
  await writeFile(connectionDocumentPath(value.agentDir), "{ not a connection document", "utf8");
  await assert.rejects(
    () =>
      createGameRuntimeAttachment({
        runtimeRoot: value.runtimeRoot,
        agentDir: value.agentDir,
        gameplayWorkerEnabled: false,
        hostBindingFactory,
      }),
    /game_runtime_model_configuration_unavailable/,
  );
});

test("the attachment builder keeps its named refusal for a Game surface it cannot resolve a model for", async () => {
  // Two refusals stand between a root and a silently model-less Game surface, and both are stated
  // rather than accidental: the profile store's own `invalid_model_profile_store` for a document it
  // cannot read (asserted above), and this surface's named gate for a root with no model - the
  // reachable case now that no model is shipped. Neither may be replaced by an invented default.
  //
  // The behaviour is asserted below (a root with no model refuses with this surface's own code). What is
  // pinned here is the *delegation*, because the failure this guards against is a second copy of "which
  // provider and model" appearing in this file and drifting from the Chat and the Preview. That is a fact
  // about which function the file asks, not about the shape of the expression that calls it - an earlier
  // version matched `requireSelectedModelConfig(await resolveSurfaceModelSelection(`, which broke the
  // moment the call was split across a `const` and said nothing about behaviour.
  const source = await readFile(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/continuity-semantic-game-runtime-materializer/game-runtime-attachment.ts",
    ),
    "utf8",
  );
  assert.match(source, /from "..\/settings\/model-selection\.js"/, "it asks the one owner of the rule");
  assert.match(source, /resolveSurfaceModelSelection\(\{?/, "and calls that owner");
  assert.match(source, /surface: "game"/, "naming its own surface");
  assert.match(
    source,
    /requireSelectedModelConfig\(\s*\w+,\s*GAME_MODEL_CONFIGURATION_UNAVAILABLE\)/,
    "and maps the outcome onto this surface's named refusal",
  );
  assert.match(source, /GAME_MODEL_CONFIGURATION_UNAVAILABLE = "game_runtime_model_configuration_unavailable"/);
  assert.doesNotMatch(source, /new TavernConnectionStore/, "the attachment reads no connection of its own");
  assert.doesNotMatch(source, /new ModelProfileStore/, "the attachment reads no surface profile of its own");
  assert.doesNotMatch(source, /thinkingLevel:/, "the attachment chooses no thinking level of its own");
  assert.doesNotMatch(source, /cpa-oai/, "the Game attachment resolves no operator gateway of its own");
});

/**
 * The invariant: every attachment the builder DOES return names a provider and a model, and the
 * only roots that reach it are the ones where the player activated a connection.
 */
test("every Game runtime attachment the builder returns names a provider and a model", async () => {
  const profile = {
    schemaVersion: 1,
    chat: { revision: 1, thinkingLevel: "low" },
    game: { revision: 7, thinkingLevel: "medium" },
  };
  const connected = await gameRoot("game-runtime-attachment-model-less-connected-", profile);
  await activateConnection(connected.agentDir, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKey: "sk-synthetic-connection-key",
  });
  const { modelConfig } = await createGameRuntimeAttachment({
    runtimeRoot: connected.runtimeRoot,
    agentDir: connected.agentDir,
    gameplayWorkerEnabled: false,
    hostBindingFactory,
  });
  assert.ok(modelConfig !== undefined, "an attachment carries a model configuration");
  assert.equal(
    typeof modelConfig.provider === "string" && modelConfig.provider.length > 0,
    true,
    "an attachment carries a provider",
  );
  assert.equal(
    typeof modelConfig.modelId === "string" && modelConfig.modelId.length > 0,
    true,
    "an attachment carries a model",
  );
  // The other half of the same invariant: with no connection there is no attachment at all.
  const bare = await gameRoot("game-runtime-attachment-model-less-fresh-", profile);
  await assert.rejects(
    () =>
      createGameRuntimeAttachment({
        runtimeRoot: bare.runtimeRoot,
        agentDir: bare.agentDir,
        gameplayWorkerEnabled: false,
        hostBindingFactory,
      }),
    /game_runtime_model_configuration_unavailable/,
  );
});

test("an active player connection is the Game surface's provider and model, and the Game keeps its own thinking level", async () => {
  const value = await gameRoot("game-runtime-attachment-connection-", {
    schemaVersion: 1,
    chat: { revision: 1, thinkingLevel: "low" },
    game: { revision: 7, thinkingLevel: "medium" },
  });
  const active = await activateConnection(value.agentDir, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKey: "sk-synthetic-connection-key",
  });
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot: value.runtimeRoot,
    agentDir: value.agentDir,
    gameplayWorkerEnabled: false,
    hostBindingFactory,
  });
  // The record the player activated decides the provider and the model. No surface profile is
  // substituted for it, and the endpoint is not copied into the configuration: the field pair
  // below is the selection itself.
  assert.deepEqual(attachment.modelConfig, {
    provider: active.providerId,
    modelId: active.modelId,
    // The thinking level is not the connection's: it is this surface's own
    // tuning for how much the companion reasons before it acts in the world.
    thinkingLevel: "medium",
  });
  // That same record, under that same directory, is what resolves the endpoint
  // and the credential the runtime hands the provider: the path `runtime-core`
  // merges into Pi's `models.json` and `auth.json` beside this attachment.
  const entry = await modelProviderEntry(value.agentDir, attachment.modelConfig);
  assert.equal(entry?.providerId, catalogProvider("deepseek")?.piProviderId);
  assert.equal(entry?.entry.baseUrl, catalogProvider("deepseek")?.baseUrl);
  const credentials = JSON.parse(await readFile(connectionAuthPath(value.agentDir), "utf8")) as Record<string, unknown>;
  assert.deepEqual(credentials.deepseek, { type: "api_key", key: "sk-synthetic-connection-key" });
});

test("Chat and Game resolve the same provider and model from one runtime root", async () => {
  const value = await gameRoot("game-runtime-attachment-parity-", {
    schemaVersion: 1,
    chat: { revision: 1, thinkingLevel: "low" },
    game: { revision: 7, thinkingLevel: "medium" },
  });
  const active = await activateConnection(value.agentDir, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKey: "sk-synthetic-connection-key",
  });
  const game = await createGameRuntimeAttachment({
    runtimeRoot: value.runtimeRoot,
    agentDir: value.agentDir,
    gameplayWorkerEnabled: false,
    hostBindingFactory,
  });
  const chat = await chatModelConfig(value.runtimeRoot);
  // One directory serves both surfaces: the Chat construction derives the
  // connection store Chat reads from the same identity and root the Game
  // materializer derives it from.
  assert.equal(resolveRuntimePaths(principal, value.runtimeRoot, "chat_session_01").agentDir, value.agentDir);
  // Equality on the configuration each construction resolved, not on a copy of
  // one of them.
  assert.equal(game.modelConfig?.provider, chat.provider);
  assert.equal(game.modelConfig?.modelId, chat.modelId);
  // What the two surfaces do NOT share is the surface's own tuning: Chat takes
  // the connection's level, the Game keeps the level the player set for the Game.
  assert.equal(chat.thinkingLevel, active.thinkingLevel);
  assert.equal(game.modelConfig?.thinkingLevel, "medium");
});

test("the construction zone's recovery composition reaches the attachment unchanged", async () => {
  const recoveryJournal = Object.freeze({});
  const recoveryBinding = Object.freeze({
    scope: Object.freeze({}),
    bindingIdentity: Object.freeze({}),
  });
  const value = await gameRoot("game-runtime-attachment-recovery-", undefined);
  // A connection is what gives this root a model at all; the recovery composition rides along
  // beside it, which is what this test is about.
  await activateConnection(value.agentDir, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKey: "sk-synthetic-connection-key",
  });
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot: value.runtimeRoot,
    agentDir: value.agentDir,
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
