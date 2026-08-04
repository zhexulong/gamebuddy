import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  companionStatusTool,
  DEFAULT_COMPANION_MODEL_CONFIG,
  createCompanionStatusTool,
  createCompanionRuntime,
  identityKey,
  MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
  MAGIC_CONTEXT_MEMORY_DOMAIN,
  MAGIC_CONTEXT_MEMORY_ENABLED,
  MAGIC_CONTEXT_HISTORIAN_ENABLED,
  MAGIC_CONTEXT_RECALL_ENABLED,
  PHASE_0B_ALLOWED_TOOL_NAMES,
  resolveRuntimePaths,
} from "./runtime.js";
import { createDeterministicBridgePair } from "./bridge.js";
import { CompanionIntegrationClient } from "./integration.js";
import { type Scope } from "./protocol.js";
import { type KnowledgeBundle } from "./knowledge.js";
import { DEFAULT_IDENTITY_PROFILE, identityProfileHash } from "./identity-profile.js";
import type { CompanionRunManifest } from "./run-manifest.js";

const identity = Object.freeze({
  playerId: "player_01",
  saveId: "save_01",
  worldId: "world_01",
  companionId: "companion_01",
});

test("opaque identity keys partition contexts without display names", () => {
  const first = identityKey(identity);
  const second = identityKey({ ...identity, saveId: "save_02" });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.throws(() => identityKey({ ...identity, playerId: "Player One" }), /opaque identifier/);
});

test("runtime paths stay outside the repository workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase0b-"));
  const paths = resolveRuntimePaths(identity, root);

  assert.equal(paths.root, root);
  assert.match(paths.runtimeCwd, /contexts/);
  assert.match(paths.agentDir, /pi-agent/);
  assert.match(paths.sessionDir, /sessions/);
});

test("continuity identity is stable across surfaces while legacy game identities stay scoped", () => {
  const chat = identityKey({ playerId: identity.playerId, companionId: identity.companionId, continuityId: "continuity_01" });
  const game = identityKey({ ...identity, continuityId: "continuity_01" });
  assert.equal(chat, game);
  assert.notEqual(chat, identityKey({ playerId: identity.playerId, companionId: identity.companionId, continuityId: "continuity_02" }));
  assert.notEqual(identityKey(identity), identityKey({ ...identity, saveId: "save_02" }));
});

test("offline runtime exposes only its deterministic Companion status tool", async () => {
  const tool = companionStatusTool;
  const result = await tool.execute("test-call", {}, new AbortController().signal, () => {}, {} as never);

  assert.deepEqual(PHASE_0B_ALLOWED_TOOL_NAMES, ["companion_status"]);
  const firstContent = result.content[0];
  assert.equal(firstContent?.type, "text");
  assert.match(firstContent?.type === "text" ? firstContent.text : "", /"connected":false/);
});

test("mounted Companion status reports live integration facts without inferring success", async () => {
  const integration = {
    scope: { integrationId: "stardew", saveId: identity.saveId, worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId },
    state: {
      connected: true,
      sessionId: "session_01",
      capabilities: ["equip_tool"],
      snapshot: { revision: 9, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["equip_tool"], activeExecution: null },
      latestReceipt: { executionId: "execution_01", requestId: "request_01", state: "accepted" as const, reasonCode: "accepted", revision: 9, evidence: null },
      latestReasonCode: null,
    },
  };
  const result = await createCompanionStatusTool(integration).execute("status", {}, new AbortController().signal, () => {}, {} as never);
  assert.equal((result.details as { connected: boolean }).connected, true);
  assert.deepEqual((result.details as { capabilities: readonly string[] }).capabilities, ["equip_tool"]);
  assert.equal((result.details as { snapshotRevision: number }).snapshotRevision, 9);
  assert.equal((result.details as { latestReceiptState: string }).latestReceiptState, "accepted");
  assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /succeeded/);
});

test("runtime rejects a mounted integration whose save identity does not match", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase3-scope-"));
  const wrongScope: Scope = { integrationId: "stardew", saveId: "other_save", worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId };
  const [hostEndpoint] = createDeterministicBridgePair(wrongScope);
  const integration = new CompanionIntegrationClient(wrongScope, hostEndpoint);
  await assert.rejects(() => createCompanionRuntime(identity, root, integration), /exactly match/);
  integration.dispose();
});

test("game surface keeps the game system prompt when it resumes an explicit surface session", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-game-surface-runtime-"));
  const scope: Scope = { integrationId: "stardew", saveId: identity.saveId, worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new CompanionIntegrationClient(scope, hostEndpoint);
  const runtime = await createCompanionRuntime(identity, root, integration, undefined, undefined, undefined, false, undefined, "game_surface_01", undefined, "game");
  try {
    assert.doesNotMatch(runtime.session.systemPrompt, /<gamebuddy_chat_surface>/);
    assert.equal(runtime.session.agent.state.tools.some((tool) => tool.name === "companion_text"), false);
  } finally {
    runtime.session.dispose();
    integration.dispose();
  }
});

test("runtime mounts only the explicitly verified Stardew product tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase3-tools-"));
  const scope: Scope = { integrationId: "stardew", saveId: identity.saveId, worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new CompanionIntegrationClient(scope, hostEndpoint);
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    // The executable action is absent until the Mod declares it in the
    // player-controlled capability snapshot. Observations remain factual.
    assert.deepEqual(runtime.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", "stardew_execution_status", "stardew_interaction_catalog", "stardew_observe", "stardew_search_interactions", "todowrite"]);
  } finally {
    runtime.session.dispose();
    integration.dispose();
  }
});

test("runtime materializes the optional gameplay subagent without exposing its tools to the parent by default", async () => {
  const offlineRoot = await mkdtemp(join(tmpdir(), "gamebuddy-gameplay-subagent-offline-"));
  const delegatedRoot = await mkdtemp(join(tmpdir(), "gamebuddy-gameplay-subagent-enabled-"));
  const scope: Scope = { integrationId: "stardew", saveId: identity.saveId, worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new CompanionIntegrationClient(scope, hostEndpoint);
  const config = { provider: "cpa-oai" as const, modelId: "deepseek-v4-flash" as const, thinkingLevel: "high" as const };
  const offline = await createCompanionRuntime(identity, offlineRoot);
  try { assert.equal(offline.session.agent.state.tools.some((tool) => tool.name === "delegate_game_task"), false); }
  finally { offline.session.dispose(); }
  const delegated = await createCompanionRuntime(identity, delegatedRoot, integration, config, undefined, undefined, true);
  try {
    assert.ok(delegated.gameplaySubagent);
    assert.deepEqual(delegated.gameplaySubagent.modelConfig, { provider: "cpa-oai", modelId: "gpt-5.6-luna", thinkingLevel: "medium" });
    const manifest = JSON.parse(await readFile(delegated.paths.runManifestPath, "utf8"));
    assert.deepEqual(manifest.model, { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    assert.deepEqual(manifest.gameplaySubagentModel, { provider: "cpa-oai", modelId: "gpt-5.6-luna", thinkingLevel: "medium" });
    assert.equal(delegated.session.agent.state.tools.some((tool) => tool.name === "delegate_game_task"), true);
    assert.deepEqual(delegated.session.agent.state.tools.filter((tool) => tool.name.includes("speak") || tool.name.includes("text")).map((tool) => tool.name), []);
    delegated.gameplaySubagent?.cancel("test_cancel");
  } finally { delegated.gameplaySubagent?.dispose(); delegated.session.dispose(); integration.dispose(); }
});

test("runtime mounts Host-owned version-bound knowledge only when explicitly configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase3-knowledge-"));
  const scope: Scope = { integrationId: "stardew", saveId: identity.saveId, worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const bundle: KnowledgeBundle = { bundleVersion: 1, integrationId: "stardew", gameVersion: "1.6.15", rules: [{ id: "move-v1", integrationId: "stardew", gameVersion: "1.6.15", capability: "move_to_tile", text: "Use a fresh actionable snapshot." }] };
  const integration = new CompanionIntegrationClient(scope, hostEndpoint, bundle, "1.6.15");
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    assert.ok(runtime.session.agent.state.tools.some((tool) => tool.name === "stardew_game_knowledge"));
  } finally {
    runtime.session.dispose();
    integration.dispose();
  }
});

test("runtime loads only Magic Context and preserves a session partition", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase0b-runtime-"));
  const runtime = await createCompanionRuntime(identity, root);

  try {
    assert.deepEqual(runtime.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", "todowrite"]);
    assert.equal(runtime.extensions.length, 1);
    assert.match(runtime.extensions[0] ?? "", /pi-magic-context/);

    const config = JSON.parse(await readFile(join(runtime.paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8"));
    assert.equal(config.embedding.provider, "off");
    assert.equal(MAGIC_CONTEXT_HISTORIAN_ENABLED, true);
    assert.equal(config.historian.disable, undefined);
    assert.equal(config.historian.model, `${DEFAULT_COMPANION_MODEL_CONFIG.provider}/${DEFAULT_COMPANION_MODEL_CONFIG.modelId}`);
    assert.equal(config.historian.thinking_level, DEFAULT_COMPANION_MODEL_CONFIG.thinkingLevel);
    assert.deepEqual(config.historian.disallowed_tools, ["*"]);
    assert.deepEqual(config.todowrite, { enabled: true, overlay: false });
    assert.equal(config.dreamer.disable, true);
    assert.equal(config.system_prompt_injection.enabled, false);
    assert.equal(runtime.session.systemPrompt.includes("## Magic Context"), false);
    assert.equal(runtime.session.systemPrompt.includes("ctx_memory"), false);
    assert.equal(config.memory.domain, MAGIC_CONTEXT_MEMORY_DOMAIN);
    assert.equal(config.memory.enabled, MAGIC_CONTEXT_MEMORY_ENABLED);
    assert.equal(config.memory.auto_promote, true);
    assert.equal(MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED, true);
    assert.equal(config.memory.auto_search.enabled, MAGIC_CONTEXT_RECALL_ENABLED);
    assert.equal(MAGIC_CONTEXT_RECALL_ENABLED, false);
    const manifest = JSON.parse(await readFile(runtime.paths.runManifestPath, "utf8")) as CompanionRunManifest;
    assert.deepEqual(manifest.featureFlags, {
      gameplaySubagent: false,
      magicContextMemoryDomain: MAGIC_CONTEXT_MEMORY_DOMAIN,
      magicContextMemoryEnabled: MAGIC_CONTEXT_MEMORY_ENABLED,
      magicContextAutoPromoteEnabled: MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED,
      magicContextAutoSearchEnabled: false,
    });
    await access(join(runtime.paths.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"));

    const sessionFile = runtime.session.sessionFile;
    assert.match(sessionFile ?? "", /\.jsonl$/);
    assert.ok(sessionFile);
    runtime.sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Player conversation persistence sentinel." }],
      timestamp: Date.now(),
    });
    runtime.sessionManager.appendCustomMessageEntry(
      "gamebuddy_test_event",
      "{\"kind\":\"test_event\",\"source\":\"runtime_test\"}",
      false,
      { kind: "test_event", source: "runtime_test" },
    );
    runtime.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Phase 0B todo/session persistence sentinel." }],
      api: "openai-completions",
      provider: "test",
      model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    assert.equal((await stat(sessionFile)).isFile(), true);
    const sessionFiles = await readdir(runtime.paths.sessionDir);
    assert.equal(sessionFiles.length, 1);
  } finally {
    runtime.session.dispose();
  }

  const resumed = await createCompanionRuntime(identity, root);
  try {
    assert.equal(resumed.session.sessionFile, runtime.session.sessionFile);
    const resumedEntries = JSON.stringify(resumed.session.messages);
    assert.match(resumedEntries, /Player conversation persistence sentinel\./);
    assert.match(resumedEntries, /Phase 0B todo\/session persistence sentinel\./);
    assert.match(resumedEntries, /gamebuddy_test_event/);
    assert.deepEqual(resumed.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", "todowrite"]);
  } finally {
    resumed.session.dispose();
  }

  const otherSave = await createCompanionRuntime({ ...identity, saveId: "save_02" }, root);
  try {
    assert.notEqual(otherSave.session.sessionFile, runtime.session.sessionFile);
    assert.equal(JSON.stringify(otherSave.session.messages).includes("Player conversation persistence sentinel."), false);
    assert.notEqual(otherSave.paths.runtimeCwd, runtime.paths.runtimeCwd);
  } finally {
    otherSave.session.dispose();
  }
});

test("concurrent runtime bootstraps retain separate Magic Context data roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-runtime-concurrency-"));
  const cwdBefore = process.cwd();
  const firstIdentity = { ...identity, saveId: "save_concurrent_01" };
  const secondIdentity = { ...identity, saveId: "save_concurrent_02" };
  const [first, second] = await Promise.all([
    createCompanionRuntime(firstIdentity, root),
    createCompanionRuntime(secondIdentity, root),
  ]);
  try {
    assert.notEqual(first.paths.runtimeCwd, second.paths.runtimeCwd);
    await access(join(first.paths.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"));
    await access(join(second.paths.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"));
    assert.equal(process.cwd(), cwdBefore);
  } finally {
    first.session.dispose();
    second.session.dispose();
  }
});

test("internal Historian fixture override can disable automatic authoring without changing Memory gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-historian-off-fixture-"));
  const runtime = await createCompanionRuntime(identity, root, undefined, undefined, undefined, undefined, false, undefined, "historian_off_fixture", undefined, "chat", { historianEnabled: false });
  try {
    const config = JSON.parse(await readFile(join(runtime.paths.runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8"));
    assert.deepEqual(config.historian, { disable: true });
    assert.equal(config.memory.enabled, MAGIC_CONTEXT_MEMORY_ENABLED);
    assert.equal(config.memory.auto_promote, MAGIC_CONTEXT_AUTO_PROMOTE_ENABLED);
    assert.equal(config.memory.auto_search.enabled, false);
  } finally {
    runtime.session.dispose();
  }
});

test("runtime binds the Host-owned IdentityProfile to Pi system prompt and fails closed on mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-identity-profile-runtime-"));
  const runtime = await createCompanionRuntime(identity, root);
  try {
    assert.match(runtime.session.systemPrompt, /<gamebuddy_companion_identity/);
    assert.match(runtime.session.systemPrompt, new RegExp(runtime.identityProfile.canonicalHash));
    assert.equal(JSON.stringify(runtime.session.messages).includes("gamebuddy_companion_identity"), false);
    const storedProfile = JSON.parse(await readFile(runtime.paths.identityProfilePath, "utf8")) as typeof DEFAULT_IDENTITY_PROFILE & { canonicalHash: string };
    assert.equal(storedProfile.canonicalHash, identityProfileHash(DEFAULT_IDENTITY_PROFILE));
  } finally {
    runtime.session.dispose();
  }

  const modifiedProfile = {
    ...DEFAULT_IDENTITY_PROFILE,
    identity: { ...DEFAULT_IDENTITY_PROFILE.identity, name: "Modified Companion" },
  };
  await writeFile(runtime.paths.identityProfilePath, JSON.stringify({ ...modifiedProfile, canonicalHash: identityProfileHash(modifiedProfile) }), "utf8");
  await assert.rejects(() => createCompanionRuntime(identity, root), /identity_profile_mismatch/);

  const secondRoot = await mkdtemp(join(tmpdir(), "gamebuddy-identity-profile-binding-"));
  const first = await createCompanionRuntime(identity, secondRoot);
  const bindingPath = first.paths.identityProfileBindingPath;
  first.session.dispose();
  await unlink(bindingPath);
  await assert.rejects(() => createCompanionRuntime(identity, secondRoot), /identity_profile_mismatch/);
});
