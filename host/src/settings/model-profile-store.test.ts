import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompanionModelConfig } from "../runtime.js";
import {
  type ModelProfile,
  ModelProfileRevisionConflict,
  ModelProfileStore,
  resolveModelProfileConfig,
} from "./model-profile-store.js";

async function withStore(run: (path: string, store: ModelProfileStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-model-profiles-"));
  try {
    await run(
      join(root, "settings", "model-profiles.json"),
      new ModelProfileStore(join(root, "settings", "model-profiles.json")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("model profiles expose the sole approved preference without activation state and survive store re-opening", async () => {
  await withStore(async (path, store) => {
    const chat = await store.read("chat");
    const game = await store.read("game");
    assert.deepEqual({ ...chat, surface: undefined }, { ...game, surface: undefined });
    assert.equal(chat.surface, "chat");
    assert.equal(game.surface, "game");
    assert.equal(chat.modelId, "deepseek-v4-flash");
    assert.equal(game.modelId, "deepseek-v4-flash");
    assert.equal(chat.revision, 0);
    assert.equal(game.revision, 0);
    assert.equal("active" in chat, false);

    await store.update("chat", 0, { modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    assert.equal((await new ModelProfileStore(path).read("chat")).revision, 1);
    assert.equal((await new ModelProfileStore(path).read("game")).revision, 0);
  });
});

test("the sole approved profile always resolves to an immutable runtime-compatible model configuration", async () => {
  await withStore(async (_path, store) => {
    const profile = await store.read("chat");
    const config: CompanionModelConfig | null = resolveModelProfileConfig(profile);
    assert.deepEqual(config, { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    assert.equal(Object.isFrozen(config), true);
    assert.equal(resolveModelProfileConfig({ ...profile, modelId: "unapproved/model" } as never), null);
    assert.equal(resolveModelProfileConfig({ ...profile, provider: "cpa-oai" } as never), null);
  });
});

test("updates remain isolated to their selected surface", async () => {
  await withStore(async (_path, store) => {
    const changed = await store.update("chat", 0, { modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    const game = await store.read("game");
    assert.equal(changed.revision, 1);
    assert.equal(game.revision, 0);
  });
});

test("stale revisions are rejected deterministically without changing a profile", async () => {
  await withStore(async (_path, store) => {
    await store.update("game", 0, { modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    await assert.rejects(
      store.update("game", 0, { modelId: "deepseek-v4-flash", thinkingLevel: "high" }),
      ModelProfileRevisionConflict,
    );
    assert.deepEqual(await store.read("game"), {
      surface: "game",
      revision: 1,
      modelId: "deepseek-v4-flash",
      thinkingLevel: "high",
    } satisfies ModelProfile);
  });
});

test("invalid profile updates and persisted profiles are rejected", async () => {
  await withStore(async (path, store) => {
    await assert.rejects(
      store.update("chat", 0, { modelId: "unapproved/model", thinkingLevel: "high" } as never),
      /invalid_model_profile_update/,
    );
    await assert.rejects(
      store.update("chat", 0, { modelId: "deepseek-v4-flash", thinkingLevel: "low" } as never),
      /invalid_model_profile_update/,
    );
    assert.equal((await store.read("chat")).revision, 0);

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 0, modelId: "cpa-oai/deepseek-v4-flash", thinkingLevel: "high" },
        game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      }),
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high", active: true },
        game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      }),
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        root: "/legacy/root",
        chat: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
        game: { revision: 0, modelId: "deepseek-v4-flash", thinkingLevel: "high" },
      }),
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);

    await writeFile(
      path,
      '{"schemaVersion":1,"chat":{"revision":0,"modelId":"deepseek-v4-flash","thinkingLevel":"high"},"game":{"revision":0,"modelId":"deepseek-v4-flash","thinkingLevel":"high"},"schema\\u0056ersion":1}',
    );
    await assert.rejects(store.read("chat"), /invalid_model_profile_store/);
  });
});

test("profile projection exposes no credential, provider, or endpoint values", async () => {
  await withStore(async (_path, store) => {
    const profile = (await store.read("chat")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(profile).sort(), ["modelId", "revision", "surface", "thinkingLevel"]);
    assert.equal(profile.modelId, "deepseek-v4-flash");
    for (const [key, value] of Object.entries(profile)) {
      assert.doesNotMatch(key, /credential|secret|token|password|provider|endpoint|authorization/i);
      assert.equal(typeof value === "string" && /^(?:https?:|cpa-oai\/)/.test(value), false);
    }
  });
});
