/**
 * The test-only fold channel, proved at the layer that owns it: the runtime's own user-scope config.
 *
 * Magic Context reads `execute_threshold_tokens` and `protected_tokens` from the USER scope, and by its
 * own rule a PROJECT file may only raise the trigger - never lower it. So a live harness that needs a
 * real fold inside a CI-sized conversation cannot express it through the project config, and the
 * runtime already owns a user-scope file inside its root. The Host reads the launcher's request for
 * exactly those two keys and writes them there.
 *
 * This asserts the WIRING (env in, config out) and the boundaries that keep it from becoming an
 * operator surface: nothing is written when the channel is absent, and invalid values are ignored
 * rather than coerced. The fold itself is proved end to end by `pi-magic-context-chapter-fold.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createCompanionRuntime, type CompanionIdentity } from "./runtime.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_01",
  playerId: "player_01",
  saveId: "save_01",
  worldId: "world_01",
  companionId: "companion_01",
});

const CHANNEL_KEYS = [
  "GAMEBUDDY_MAGIC_CONTEXT_TEST_EXECUTE_THRESHOLD_TOKENS",
  "GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOKENS",
] as const;

/** The user-scope config the runtime wrote, wherever this surface puts its working directory. */
function findUserConfig(root: string): Record<string, unknown> {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      if (entry === "magic-context.jsonc" && current.endsWith(join("config", "cortexkit")))
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      // Only descend where a config can live; a full walk of a runtime root is mostly data files.
      if (entry === "contexts" || entry === "config" || entry === "cortexkit" || /^[0-9a-f]{16,}$/u.test(entry))
        queue.push(path);
    }
  }
  return {};
}

/** Construct one runtime with `env` applied, then read the user-scope config it wrote. */
async function constructAndReadConfig(
  env: Partial<Record<(typeof CHANNEL_KEYS)[number], string>>,
): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gamebuddy-fold-channel-"));
  const previous = CHANNEL_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of CHANNEL_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  try {
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      { provider: "cpa-oai", modelId: "deepseek-v4-flash", thinkingLevel: "low" },
      undefined,
      undefined,
      false,
      undefined,
      "chat_session_01",
      undefined,
      "chat",
    );
    try {
      return findUserConfig(root);
    } finally {
      runtime.session.dispose();
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Best effort: a durable lease can still hold the directory on Windows (EPERM), and a cleanup
    // failure must not replace the result this test exists to report.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* the OS reclaims the temp directory */
    }
  }
}

test("the test-only channel puts the fold trigger in the runtime's own user-scope config", async () => {
  const config = await constructAndReadConfig({
    GAMEBUDDY_MAGIC_CONTEXT_TEST_EXECUTE_THRESHOLD_TOKENS: "6000",
    GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOKENS: "4000",
  });
  assert.deepEqual(config.execute_threshold_tokens, { default: 6_000 });
  assert.equal(config.protected_tokens, 4_000);
});

test("the channel is absent unless a launcher asks for it", async () => {
  const config = await constructAndReadConfig({});
  assert.equal("execute_threshold_tokens" in config, false);
  assert.equal("protected_tokens" in config, false);
});

test("the channel ignores values it cannot honour", async () => {
  const config = await constructAndReadConfig({
    GAMEBUDDY_MAGIC_CONTEXT_TEST_EXECUTE_THRESHOLD_TOKENS: "not-a-number",
    GAMEBUDDY_MAGIC_CONTEXT_TEST_PROTECTED_TOKENS: "-5",
  });
  assert.equal("execute_threshold_tokens" in config, false);
  assert.equal("protected_tokens" in config, false);
});
