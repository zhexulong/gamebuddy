import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import type { CompanionModelConfig } from "../runtime.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  type ModelProfile,
  ModelProfileRevisionConflict,
  ModelProfileStore,
  resolveModelProfileConfig,
} from "./model-profile-store.js";

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

test("model profiles start from the shipped recommendation without activation state and survive store re-opening", async () => {
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

/**
 * The defect this slice fixes: a model id the shipped recommendation does not
 * name is the player's own input, so it saves, reads back byte for byte, and is
 * the exact model the next runtime is constructed with. Nothing consults a
 * catalog (design/28 §2.3.1: `host/src/settings/model-profile-store.ts` used to
 * pin `deepseek-v4-flash` and `"high"` as frozen literals).
 */
test("a model id outside the recommended catalog round-trips through the profile and into the runtime configuration", async () => {
  await withStore(async (path, store) => {
    const localModelId = "qwen2.5-coder:7b";
    const updated = await store.update("chat", 0, { modelId: localModelId, thinkingLevel: "xhigh" });
    assert.deepEqual(updated, {
      surface: "chat",
      revision: 1,
      modelId: localModelId,
      thinkingLevel: "xhigh",
    } satisfies ModelProfile);

    // Durable read-back through a fresh store instance: the file is the authority.
    const reopened = await new ModelProfileStore(path).read("chat");
    assert.equal(reopened.modelId, localModelId);
    assert.equal(reopened.thinkingLevel, "xhigh");
    assert.deepEqual(resolveModelProfileConfig(reopened), {
      provider: "cpa-oai",
      modelId: localModelId,
      thinkingLevel: "xhigh",
    } satisfies CompanionModelConfig);

    // The other surface keeps its own model; one profile never overrides the other.
    assert.equal((await store.read("game")).modelId, "deepseek-v4-flash");
  });
});

test("every bounded model id and thinking level resolves to an immutable runtime-compatible model configuration", async () => {
  await withStore(async (_path, store) => {
    const profile = await store.read("chat");
    const config: CompanionModelConfig | null = resolveModelProfileConfig(profile);
    assert.deepEqual(config, { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "high" });
    assert.equal(Object.isFrozen(config), true);
    // A third-party gateway spelling and a local server's tag are both usable.
    for (const modelId of ["openrouter/anthropic.claude-3", "llama3.2:latest", "my-model_v2"]) {
      assert.deepEqual(resolveModelProfileConfig({ ...profile, modelId } as never), {
        provider: "cpa-oai",
        modelId,
        thinkingLevel: "high",
      });
    }
    // Only the bounded shape is refused, never catalog membership.
    assert.equal(resolveModelProfileConfig({ ...profile, modelId: "" } as never), null);
    assert.equal(resolveModelProfileConfig({ ...profile, modelId: " spaced" } as never), null);
    assert.equal(resolveModelProfileConfig({ ...profile, thinkingLevel: "" } as never), null);
    assert.equal(resolveModelProfileConfig({ ...profile, thinkingLevel: "high level" } as never), null);
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
      store.update("chat", 0, { modelId: "", thinkingLevel: "high" } as never),
      /invalid_model_profile_update/,
    );
    await assert.rejects(
      store.update("chat", 0, { modelId: "has space", thinkingLevel: "high" } as never),
      /invalid_model_profile_update/,
    );
    await assert.rejects(
      store.update("chat", 0, { modelId: "deepseek-v4-flash", thinkingLevel: "" } as never),
      /invalid_model_profile_update/,
    );
    await assert.rejects(
      store.update("chat", 0, { modelId: "deepseek-v4-flash", thinkingLevel: "3 high" } as never),
      /invalid_model_profile_update/,
    );
    assert.equal((await store.read("chat")).revision, 0);

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        chat: { revision: 0, modelId: " cpa-oai/deepseek-v4-flash", thinkingLevel: "high" },
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
