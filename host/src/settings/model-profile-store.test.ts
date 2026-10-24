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
 * A profile written by the build that still had a model id loads, and the stale member is dropped.
 *
 * The premise this protects: a player upgrading in place must not meet
 * `invalid_model_profile_store` because of a field the product no longer reads. The member is
 * dropped rather than preserved - it can only disagree with the connection that really decides the
 * model - and it disappears from disk at the first save rather than on read.
 */
test("a document still carrying the retired modelId loads, and the field is gone from the projection", async () => {
  await withStore(async (path, store) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 4, modelId: "deepseek-v4.1-flash", thinkingLevel: "low" },
        game: { revision: 2, modelId: "qwen2.5-coder:7b", thinkingLevel: "max" },
      }),
    );
    assert.deepEqual(await store.read("chat"), {
      surface: "chat",
      revision: 4,
      thinkingLevel: "low",
    } satisfies ModelProfile);
    const saved = await store.update("chat", 4, { thinkingLevel: "xhigh" });
    assert.deepEqual(saved, { surface: "chat", revision: 5, thinkingLevel: "xhigh" } satisfies ModelProfile);
    // The write is what drops it, on BOTH surfaces: the store serialises the document it validated,
    // and that document has no model id in it. A stale member can only disagree with the connection
    // that really decides the model, so it is not carried forward.
    const written = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")) as {
      chat: Record<string, unknown>;
      game: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(written.chat).sort(), ["revision", "thinkingLevel"]);
    assert.deepEqual(Object.keys(written.game).sort(), ["revision", "thinkingLevel"]);
    // Reading alone is not writing: the un-saved surface kept its revision and its file entry until
    // a save touches it.
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
    // A model id is not a field of this record at all any more.
    await assert.rejects(
      store.update("chat", 0, { modelId: "deepseek-v4.1-flash", thinkingLevel: "high" } as never),
      /invalid_model_profile_update/,
    );
    assert.equal((await store.read("chat")).revision, 0);

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
