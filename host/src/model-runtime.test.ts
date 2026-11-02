import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { createCompanionRuntime, DEFAULT_COMPANION_MODEL_CONFIG } from "./runtime.js";
import { catalogModelById } from "./tavern/provider-catalog.js";

// The runtime writes an identity profile under a path lock, and releasing a lock on Windows goes through the build-time
// reclaimer - the same binding every other path-lock consumer's suite makes. Without it the release fails and the failure
// surfaces as an unrelated-looking error several frames deep.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const identity = { playerId: "player_01", saveId: "save_01", worldId: "world_01", companionId: "companion_01" };

test("product default selects DeepSeek V4.1 Flash at high thinking", () => {
  assert.deepEqual(DEFAULT_COMPANION_MODEL_CONFIG, {
    provider: "cpa-oai",
    modelId: "deepseek-v4.1-flash",
    thinkingLevel: "high",
  });
});

test("Companion Agent registry is identity-scoped and uses DeepSeek V4.1 Flash through the configured CPA provider", async () => {
  const root = await canonicalTestRoot("gamebuddy-deepseek-agent-model-");
  const runtime = await createCompanionRuntime(identity, root, undefined, {
    provider: "cpa-oai",
    modelId: "deepseek-v4.1-flash",
    thinkingLevel: "high",
  });
  try {
    assert.equal(runtime.session.agent.state.model?.provider, "cpa-oai");
    assert.equal(runtime.session.agent.state.model?.id, "deepseek-v4.1-flash");
    assert.equal(runtime.session.agent.state.thinkingLevel, "high");
    const models = await readFile(join(runtime.paths.agentDir, "models.json"), "utf8");
    assert.match(models, /"apiKey": "\$CPA_OAI_API_KEY"/);
    assert.match(models, /"thinkingFormat": "deepseek"/);
    assert.match(models, /"requiresReasoningContentOnAssistantMessages": true/);
    // The document carries the model's own declared window, not a product-wide default
    // and not a number written here: the catalog is that fact's owner, so the assertion
    // reads it. A stale literal in this line (131,072, two model generations back) was
    // the same second-spelling defect the price had, and it went unnoticed because a
    // test that pins a value cannot notice the value changing.
    assert.match(models, new RegExp(`"contextWindow": ${catalogModelById("deepseek-v4.1-flash")?.contextWindow}`));
    assert.doesNotMatch(models, /sk-|Bearer\s+[A-Za-z0-9]/i);
    assert.match(models, /127\.0\.0\.1:8317\/v1/);
    assert.doesNotMatch(models, /xiaomimimo|MIMO_API_KEY|mimo-v2\.5|XAI_API_KEY/i);
  } finally {
    runtime.session.dispose();
  }
});
