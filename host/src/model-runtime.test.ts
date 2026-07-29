import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCompanionRuntime } from "./runtime.js";

const identity = { playerId: "player_01", saveId: "save_01", worldId: "world_01", companionId: "companion_01" };

test("optional MiMo model registry is identity-scoped and retains only an environment reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-mimo-model-"));
  const runtime = await createCompanionRuntime(identity, root, undefined, { provider: "xiaomi-mimo", modelId: "mimo-v2.5" });
  try {
    assert.equal(runtime.session.agent.state.model?.provider, "xiaomi-mimo");
    assert.equal(runtime.session.agent.state.model?.id, "mimo-v2.5");
    const models = await readFile(join(runtime.paths.agentDir, "models.json"), "utf8");
    assert.match(models, /"api-key": "\$MIMO_API_KEY"/);
    assert.doesNotMatch(models, /sk-|Bearer\s+[A-Za-z0-9]/i);
    // Registry configuration may name the provider endpoint, but no key value
    // or request transcript is persisted in the identity partition.
    assert.match(models, /api\.xiaomimimo\.com\/v1/);
  } finally {
    runtime.session.dispose();
  }
});
