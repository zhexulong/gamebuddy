import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalTestRoot } from "./test-support/canonical-test-root.test-support.js";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";
import { createCompanionRuntime, DEFAULT_COMPANION_MODEL_CONFIG } from "./runtime.js";
import { declaredContextWindow } from "./tavern/pi-provider-store.js";

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
    // The document carries the window this PRODUCT declares for the model, which is its own authority:
    // `declaredContextWindow` (`pi-provider-store.ts:121`) takes whatever the catalog states and caps it at
    // `WORKING_CONTEXT_WINDOW_CEILING`, a measured fold threshold rather than a policy. The catalog states
    // 1,000,000 for this id and the document carries 240,000, so reading `catalogModelById` here asserted a number
    // the product never writes - the same two-spellings-of-one-fact defect as the stale literal, one owner over.
    assert.match(models, new RegExp(`"contextWindow": ${String(declaredContextWindow("deepseek-v4.1-flash"))}\\b`));
    assert.doesNotMatch(models, /sk-|Bearer\s+[A-Za-z0-9]/i);
    assert.match(models, /127\.0\.0\.1:8317\/v1/);
    assert.doesNotMatch(models, /xiaomimimo|MIMO_API_KEY|mimo-v2\.5|XAI_API_KEY/i);
  } finally {
    runtime.session.dispose();
  }
});
