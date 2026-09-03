import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCompanionRuntime, DEFAULT_COMPANION_MODEL_CONFIG } from "./runtime.js";

const identity = { playerId: "player_01", saveId: "save_01", worldId: "world_01", companionId: "companion_01" };

test("product default selects DeepSeek V4 Flash at high thinking", () => {
  assert.deepEqual(DEFAULT_COMPANION_MODEL_CONFIG, {
    provider: "cpa-oai",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "high",
  });
});

test("Companion Agent registry is identity-scoped and uses DeepSeek V4 Flash through the configured CPA provider", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-deepseek-agent-model-"));
  const runtime = await createCompanionRuntime(identity, root, undefined, {
    provider: "cpa-oai",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "high",
  });
  try {
    assert.equal(runtime.session.agent.state.model?.provider, "cpa-oai");
    assert.equal(runtime.session.agent.state.model?.id, "deepseek-v4-flash");
    assert.equal(runtime.session.agent.state.thinkingLevel, "high");
    const models = await readFile(join(runtime.paths.agentDir, "models.json"), "utf8");
    assert.match(models, /"apiKey": "\$CPA_OAI_API_KEY"/);
    assert.match(models, /"thinkingFormat": "deepseek"/);
    assert.match(models, /"requiresReasoningContentOnAssistantMessages": true/);
    assert.match(models, /"contextWindow": 1000000/);
    assert.doesNotMatch(models, /sk-|Bearer\s+[A-Za-z0-9]/i);
    assert.match(models, /127\.0\.0\.1:8317\/v1/);
    assert.doesNotMatch(models, /xiaomimimo|MIMO_API_KEY|mimo-v2\.5|XAI_API_KEY/i);
  } finally {
    runtime.session.dispose();
  }
});
