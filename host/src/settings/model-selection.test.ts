import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveSurfaceModelSelection } from "./model-selection.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { TavernConnectionStore, connectionDocumentPath } from "../tavern/connection-store.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";

// The connection store takes a durable path lock when it creates and activates a record, so these
// tests need the same test-only reclaimer binding every other path-lock consumer's test uses.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

type SurfaceRoot = Readonly<{ runtimeRoot: string; agentDir: string }>;

/**
 * One runtime root as production composes it: the surface profiles live under the root, and the
 * player's connections live in the identity-scoped directory the caller passes as `agentDir`.
 */
async function surfaceRoot(prefix: string): Promise<SurfaceRoot> {
  const runtimeRoot = await canonicalTestRoot(prefix);
  const agentDir = join(runtimeRoot, "contexts", "identity_01", "pi-agent");
  await mkdir(join(runtimeRoot, "settings"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return Object.freeze({ runtimeRoot, agentDir });
}

/** One ready, active player connection, written by the real store. */
async function activateConnection(agentDir: string, modelId = "deepseek-v4-pro"): Promise<void> {
  const store = new TavernConnectionStore(agentDir);
  const created = await store.create({
    providerId: "deepseek",
    apiKey: "sk-synthetic-connection-key",
    baseUrl: null,
    apiShape: null,
    modelId,
  });
  const connectionId = created.connections[0]!.connectionId;
  const probed = await store.recordProbe(connectionId, { outcome: "ready", modelIds: [modelId] });
  await store.activate(connectionId, probed.revision);
}

test("an active connection is the provider and model, and each surface takes its own thinking level", async () => {
  const value = await surfaceRoot("model-selection-active-");
  await activateConnection(value.agentDir);
  const active = await new TavernConnectionStore(value.agentDir).active();
  assert.notEqual(active, null);

  // Chat runs at the level the player chose on the connection itself.
  const chat = await resolveSurfaceModelSelection({ ...value, surface: "chat" });
  assert.equal(chat.status, "selected");
  assert.deepEqual(chat.status === "selected" ? chat.modelConfig : null, {
    provider: active!.providerId,
    modelId: active!.modelId,
    thinkingLevel: active!.thinkingLevel,
  });

  // The Game keeps the level its own profile holds: it tunes how much she reasons before she acts
  // in the world, which is not a property of the endpoint the player talks through.
  await writeFile(
    join(value.runtimeRoot, "settings", "model-profiles.json"),
    JSON.stringify({
      schemaVersion: 1,
      chat: { revision: 1, thinkingLevel: "low" },
      game: { revision: 7, thinkingLevel: "medium" },
    }),
  );
  const game = await resolveSurfaceModelSelection({ ...value, surface: "game" });
  assert.equal(game.status, "selected");
  assert.deepEqual(game.status === "selected" ? game.modelConfig : null, {
    provider: active!.providerId,
    modelId: active!.modelId,
    thinkingLevel: "medium",
  });
  assert.equal(game.modelProfileRevision, 7);
});

test("a root with no activated connection answers no_model rather than refusing", async () => {
  const value = await surfaceRoot("model-selection-none-");
  for (const surface of ["chat", "game"] as const) {
    const outcome = await resolveSurfaceModelSelection({ ...value, surface });
    // `no_model` is a member of the outcome, not a throw and not `null`: the read happened and found
    // nothing, which is the first-run state the Chat surface must still open in.
    assert.deepEqual(outcome, { status: "no_model", modelProfileRevision: 0 });
  }
});

test("a connection store that cannot be read is its own answer, not an absent connection", async () => {
  const value = await surfaceRoot("model-selection-unreadable-");
  await writeFile(connectionDocumentPath(value.agentDir), "{ not a connection document", "utf8");
  for (const surface of ["chat", "game"] as const) {
    const outcome = await resolveSurfaceModelSelection({ ...value, surface });
    // The two facts are distinct on purpose: "the player activated nothing" is fixed in Settings by
    // activating a connection, while a corrupt document is a store defect. Collapsing them into one
    // answer is how one surface came to present a broken store as an unconfigured product.
    assert.deepEqual(outcome, { status: "unreadable", modelProfileRevision: 0 });
  }
  assert.equal(
    (await readFile(connectionDocumentPath(value.agentDir), "utf8")).startsWith("{ not a"),
    true,
    "classifying the read does not rewrite the document it could not understand",
  );
});

test("the surface profile's own store failure still refuses by its own name", async () => {
  const value = await surfaceRoot("model-selection-profile-unreadable-");
  await writeFile(join(value.runtimeRoot, "settings", "model-profiles.json"), "{ not a profile store", "utf8");
  await assert.rejects(
    () => resolveSurfaceModelSelection({ ...value, surface: "chat" }),
    /invalid_model_profile_store/,
  );
});
