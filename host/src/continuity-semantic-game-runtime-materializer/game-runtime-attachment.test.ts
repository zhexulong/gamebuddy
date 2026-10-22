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
      return prepared.modelConfig;
    } finally {
      prepared?.closeChatThreadStore?.();
    }
  } finally {
    threads.close?.();
    await binding.close();
  }
}

test("an unarmed Game runtime attachment still carries the player's own Game profile model", async () => {
  // The operational gate nonce arms the gameplay worker; it must never decide
  // whether the Game surface has a model. Before this invariant held, an
  // unarmed Game runtime was constructed with no model configuration at all.
  const value = await gameRoot("game-runtime-attachment-", {
    schemaVersion: 1,
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
    game: { revision: 7, modelId: "player-game-model", thinkingLevel: "medium" },
  });
  // The player never selected a connection in this root: the surface profile is
  // the whole answer, exactly as before the connection could be one.
  await assert.rejects(readFile(connectionDocumentPath(value.agentDir), "utf8"), /ENOENT/);
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot: value.runtimeRoot,
    agentDir: value.agentDir,
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
  const value = await gameRoot("game-runtime-attachment-default-", undefined);
  const attachment = await createGameRuntimeAttachment({
    runtimeRoot: value.runtimeRoot,
    agentDir: value.agentDir,
    gameplayWorkerEnabled: true,
    hostBindingFactory,
  });
  // A root with no saved profile is not a refusal: the store itself ships the
  // recommendation both surfaces start from, and the worker arming flag
  // travels with the model rather than replacing it.
  assert.deepEqual(attachment.modelConfig, {
    provider: "cpa-oai",
    modelId: "deepseek-v4.1-flash",
    thinkingLevel: "high",
  });
  assert.equal(attachment.gameplaySubagentEnabled, true);
});

test("a store that cannot yield a Game profile refuses the attachment instead of building a model-less runtime", async () => {
  const value = await gameRoot("game-runtime-attachment-refusal-", {
    schemaVersion: 1,
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
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

test("the attachment builder keeps its named refusal for a Game profile it cannot resolve", async () => {
  // ModelProfileStore validates every profile it returns, so today the
  // reachable refusal for a store without a usable Game profile is the store's
  // own `invalid_model_profile_store` (asserted above). This named second gate
  // is the only thing between a future store change and a silently model-less
  // Game surface, so its removal must be a decision rather than an accident.
  const source = await readFile(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../src/continuity-semantic-game-runtime-materializer/game-runtime-attachment.ts",
    ),
    "utf8",
  );
  assert.match(
    source,
    /if \(modelConfig === null\)\s*throw new Error\("game_runtime_model_configuration_unavailable"\);/,
  );
  assert.match(source, /\.read\(\s*"game",?\s*\)/);
});

/**
 * The gate above is the guard, but a guard nobody can reach proves nothing, and
 * today nobody can: `ModelProfileStore.read` validates every field it returns
 * (`model-profile-store.ts:127-137`), so `resolveModelProfileConfig` is total
 * over a store that does not throw, and a store that throws refuses earlier with
 * its own `invalid_model_profile_store` (asserted above). The null branch is
 * therefore unconstructible from disk, and inventing a store state to reach it
 * would be testing a product that does not exist. What the builder CAN be pinned
 * to is the invariant the gate exists for: no attachment it returns is ever
 * model-less, in any of the configurations a root can be in.
 */
test("every Game runtime attachment the builder returns names a provider and a model", async () => {
  const saved = await gameRoot("game-runtime-attachment-model-less-saved-", {
    schemaVersion: 1,
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
    game: { revision: 7, modelId: "player-game-model", thinkingLevel: "medium" },
  });
  const connected = await gameRoot("game-runtime-attachment-model-less-connected-", {
    schemaVersion: 1,
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
    game: { revision: 7, modelId: "player-game-model", thinkingLevel: "medium" },
  });
  await activateConnection(connected.agentDir, {
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    apiKey: "sk-synthetic-connection-key",
  });
  for (const value of [await gameRoot("game-runtime-attachment-model-less-fresh-", undefined), saved, connected]) {
    const { modelConfig } = await createGameRuntimeAttachment({
      runtimeRoot: value.runtimeRoot,
      agentDir: value.agentDir,
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
  }
});

test("an active player connection is the Game surface's provider and model, and the Game keeps its own thinking level", async () => {
  const value = await gameRoot("game-runtime-attachment-connection-", {
    schemaVersion: 1,
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
    game: { revision: 7, modelId: "player-game-model", thinkingLevel: "medium" },
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
  // The record the player activated decides the provider and the model. Neither
  // surface profile is substituted for it, and the endpoint is not copied into
  // the configuration: the field pair below is the selection itself.
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
    chat: { revision: 1, modelId: "player-chat-model", thinkingLevel: "low" },
    game: { revision: 7, modelId: "player-game-model", thinkingLevel: "medium" },
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
