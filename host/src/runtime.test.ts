import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  companionStatusTool,
  createCompanionRuntime,
  identityKey,
  PHASE_0B_ALLOWED_TOOL_NAMES,
  resolveRuntimePaths,
} from "./runtime.js";
import { createDeterministicBridgePair } from "./bridge.js";
import { CompanionIntegrationClient } from "./integration.js";
import { type Scope } from "./protocol.js";

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

test("Phase 0B exposes only its deterministic Companion test tool", async () => {
  const tool = companionStatusTool;
  const result = await tool.execute("test-call", {}, new AbortController().signal, () => {}, {} as never);

  assert.deepEqual(PHASE_0B_ALLOWED_TOOL_NAMES, ["companion_status"]);
  const firstContent = result.content[0];
  assert.equal(firstContent?.type, "text");
  assert.match(firstContent?.type === "text" ? firstContent.text : "", /no game capabilities enabled/);
});

test("runtime rejects a mounted integration whose save identity does not match", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase3-scope-"));
  const wrongScope: Scope = { integrationId: "stardew", saveId: "other_save", worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId };
  const [hostEndpoint] = createDeterministicBridgePair(wrongScope);
  const integration = new CompanionIntegrationClient(wrongScope, hostEndpoint);
  await assert.rejects(() => createCompanionRuntime(identity, root, integration), /exactly match/);
  integration.dispose();
});

test("runtime mounts only the explicitly verified Stardew product tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-phase3-tools-"));
  const scope: Scope = { integrationId: "stardew", saveId: identity.saveId, worldId: identity.worldId, playerId: identity.playerId, companionId: identity.companionId };
  const [hostEndpoint] = createDeterministicBridgePair(scope);
  const integration = new CompanionIntegrationClient(scope, hostEndpoint);
  const runtime = await createCompanionRuntime(identity, root, integration);
  try {
    // The executable action is absent until the Mod grants a fresh, bounded token.
    // Observations and execution status remain factual and safe before handshake.
    assert.deepEqual(runtime.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", "stardew_execution_status", "stardew_observe", "todowrite"]);
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
    assert.deepEqual(config.historian.disallowed_tools, ["*"]);
    assert.deepEqual(config.todowrite, { enabled: true, overlay: false });
    assert.equal(config.dreamer.disable, true);
    assert.equal(config.memory.enabled, false);
    await access(join(runtime.paths.runtimeCwd, "data", "cortexkit", "magic-context", "context.db"));

    const sessionFile = runtime.session.sessionFile;
    assert.match(sessionFile ?? "", /\.jsonl$/);
    assert.ok(sessionFile);
    runtime.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Phase 0B persistence sentinel." }],
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
    assert.equal(resumed.session.messages.some((message) => JSON.stringify(message).includes("Phase 0B persistence sentinel.")), true);
    assert.deepEqual(resumed.session.agent.state.tools.map((tool) => tool.name).sort(), ["companion_status", "todowrite"]);
  } finally {
    resumed.session.dispose();
  }
});
