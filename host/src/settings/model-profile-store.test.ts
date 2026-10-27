import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { type ModelProfile, ModelProfileRevisionConflict, ModelProfileStore } from "./model-profile-store.js";

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

// A profile update takes the durable path lock, so these tests need the same
// test-only reclaimer binding every other path-lock consumer's test uses.
test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

async function withStore(run: (path: string, store: ModelProfileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-model-profiles-"));
  try {
    await run(
      join(root, "settings", "model-profiles.json"),
      new ModelProfileStore(join(root, "settings", "model-profiles.json")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The profile owns one fact and only one: how much each surface reasons before it answers.
 *
 * The model and the provider are NOT here, and that is the change this pins. The store used to
 * ship a default profile naming `deepseek-v4.1-flash` and, through `resolveModelProfileConfig`, the
 * operator's `cpa-oai` gateway - so a fresh install believed it could answer through an endpoint
 * that exists on exactly one machine. With BYOK, the model is the player's active connection's:
 * the one record that names a provider, a model and an endpoint together.
 */
test("model profiles start from the shipped thinking level and hold no model of their own", async () => {
  await withStore(async (path, store) => {
    const chat = await store.read("chat");
    const game = await store.read("game");
    assert.deepEqual({ ...chat, surface: undefined }, { ...game, surface: undefined });
    assert.equal(chat.surface, "chat");
    assert.equal(game.surface, "game");
    assert.equal(chat.thinkingLevel, "high");
    assert.equal(game.thinkingLevel, "high");
    assert.equal(chat.revision, 0);
    assert.equal(game.revision, 0);
    assert.equal("active" in chat, false);
    assert.equal("modelId" in chat, false, "a profile names no model: the connection does");

    await store.update("chat", 0, { thinkingLevel: "high" });
    assert.equal((await new ModelProfileStore(path).read("chat")).revision, 1);
    assert.equal((await new ModelProfileStore(path).read("game")).revision, 0);
  });
});

/**
 * A profile written by another build loads, and the surface's own provider/model survives with it.
 *
 * The premise this protects has changed with the field: `modelId` is a live member again - the surface's own override
 * of the active connection - so a document that carries it must load *with* it rather than dropping it. What is still
 * refused is a half-stated selection, which is the shape that cannot be resolved.
 */
test("a document carrying a surface's own provider and model loads, and the pair survives the projection", async () => {
  await withStore(async (path, store) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 4, modelId: "deepseek-v4.1-flash", providerId: "cpa-oai", thinkingLevel: "low" },
        game: { revision: 2, modelId: "qwen2.5-coder:7b", providerId: "ollama", thinkingLevel: "max" },
      }),
    );
    assert.deepEqual(await store.read("chat"), {
      surface: "chat",
      revision: 4,
      thinkingLevel: "low",
      modelId: "deepseek-v4.1-flash",
      providerId: "cpa-oai",
    } satisfies ModelProfile);
    const saved = await store.update("chat", 4, { thinkingLevel: "xhigh" });
    // An update that names no model keeps the surface's own override: changing how much she reasons is not a reason to
    // drop the model the player pinned for this surface.
    assert.deepEqual(saved, {
      surface: "chat",
      revision: 5,
      thinkingLevel: "xhigh",
      modelId: "deepseek-v4.1-flash",
      providerId: "cpa-oai",
    } satisfies ModelProfile);
    // The game surface never had an override, so its entry stays as the other build wrote it - including its revision -
    // until a save touches it: reading is not writing.
    const written = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")) as {
      chat: Record<string, unknown>;
      game: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(written.chat).sort(), ["modelId", "providerId", "revision", "thinkingLevel"]);
    assert.equal(written.game.revision, 2);
  });
});

test("updates remain isolated to their selected surface", async () => {
  await withStore(async (_path, store) => {
    const changed = await store.update("chat", 0, { thinkingLevel: "high" });
    const game = await store.read("game");
    assert.equal(changed.revision, 1);
    assert.equal(game.revision, 0);
  });
});

test("stale revisions are rejected deterministically without changing a profile", async () => {
  await withStore(async (_path, store) => {
    await store.update("game", 0, { thinkingLevel: "medium" });
    await assert.rejects(store.update("game", 0, { thinkingLevel: "medium" }), ModelProfileRevisionConflict);
    assert.deepEqual(await store.read("game"), {
      surface: "game",
      revision: 1,
      thinkingLevel: "medium",
    } satisfies ModelProfile);
  });
});

test("invalid profile updates and persisted profiles are rejected", async () => {
  await withStore(async (path, store) => {
    await assert.rejects(store.update("chat", 0, { thinkingLevel: "" } as never), /invalid_model_profile_update/);
    await assert.rejects(store.update("chat", 0, { thinkingLevel: "3 high" } as never), /invalid_model_profile_update/);
    // A model without the provider that serves it is not a selection: the pair is written together or not at all.
    await assert.rejects(
      store.update("chat", 0, { modelId: "deepseek-v4.1-flash", thinkingLevel: "high" } as never),
      /invalid_model_profile_update/,
    );
    // And a provider with no model names nothing to run.
    await assert.rejects(
      store.update("chat", 0, { providerId: "cpa-oai", thinkingLevel: "high" } as never),
      /invalid_model_profile_update/,
    );
    // Both together are the override, and they are accepted.
    const overridden = await store.update("chat", 0, {
      modelId: "deepseek-v4.1-flash",
      providerId: "cpa-oai",
      thinkingLevel: "high",
    });
    assert.equal(overridden.modelId, "deepseek-v4.1-flash");
    assert.equal(overridden.providerId, "cpa-oai");
    // Clearing both removes the override and leaves the surface on the active connection.
    const cleared = await store.update("chat", overridden.revision, {
      modelId: null,
      providerId: null,
      thinkingLevel: "high",
    });
    assert.equal(cleared.modelId, undefined);
    assert.equal(cleared.providerId, undefined);
    // Two writes happened, so the revision moved twice; what the assertion is about is that the rejected updates above
    // wrote nothing, which the intermediate state already showed.
    assert.equal((await store.read("chat")).revision, cleared.revision);

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 0, thinkingLevel: " high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 0, thinkingLevel: "high", active: true },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        root: "/legacy/root",
        chat: { revision: 0, thinkingLevel: "high" },
        game: { revision: 0, thinkingLevel: "high" },
      }),
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);

    await writeFile(
      path,
      '{"schemaVersion":1,"chat":{"revision":0,"thinkingLevel":"high"},"game":{"revision":0,"thinkingLevel":"high"},"schema\\u0056ersion":1}',
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);
  });
});

test("a profile written before the surface owned a model still loads, and drops the stale id", async () => {
  // The comment above `validStoredProfile` promises exactly this: 'A profile written before this store
  // stopped owning a model id still carries one, and a root that upgraded must not fail to load'.
  //
  // It did fail. A document with `modelId` and no `providerId` - which is what every root upgraded from
  // the previous format has on disk - hit the final rule (`modelId === undefined) === (providerId ===
  // undefined`), was declared invalid, and `load` rethrew it as `invalid_model_profile_store`. Measured
  // 2026-10-27: a real root at `%LOCALAPPDATA%/GameBuddy/settings/model-profiles.json` (written
  // 2026-10-24, `{"revision":0,"modelId":"deepseek-v4.1-flash","thinkingLevel":"high"}`) made every
  // live run crash at step 0 with `invalid_model_profile_store`, before a single game action.
  //
  // So the promise was documentation, not behaviour. This pins the behaviour.
  await withStore(async (path, store) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 3, modelId: "deepseek-v4.1-flash", thinkingLevel: "high" },
        game: { revision: 5, modelId: "deepseek-v4.1-flash", thinkingLevel: "low" },
      }),
    );

    const chat = await store.read("chat");

    assert.equal(chat.revision, 3);
    assert.equal(chat.thinkingLevel, "high");
    // Dropped, not preserved: the model is the active connection's, and a stale id can only disagree
    // with it. `freezeProfile` keeps the pair together, so dropping the id drops nothing else.
    assert.equal("modelId" in chat, false, "the stale model id is dropped, not kept");
    assert.equal("providerId" in chat, false);
  });
});

test("profile projection exposes no credential, provider, endpoint or model value", async () => {
  await withStore(async (_path, store) => {
    const profile = (await store.read("chat")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(profile).sort(), ["revision", "surface", "thinkingLevel"]);
    for (const [key, value] of Object.entries(profile)) {
      assert.doesNotMatch(key, /credential|secret|token|password|provider|endpoint|authorization|model/iu);
      assert.equal(typeof value === "string" && /^(?:https?:|cpa-oai\/)/.test(value), false);
    }
  });
});
