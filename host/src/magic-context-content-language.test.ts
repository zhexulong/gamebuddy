/**
 * HER OWN MEMORIES, IN HER OWN LANGUAGE.
 *
 * <p>
 * The fold's `<new-compartments>` block is not authored by the companion: Magic Context's embedded historian writes
 * those summaries and their one-line titles, and its prompt follows the extension's `language` setting rather than
 * the companion prompt. Unset - which is what the Host's user-scope config was until now - the vendor returns that
 * system prompt untouched and the summary comes out in whatever language the model defaults to. Measured over a
 * 35-minute Chinese Game session: 6,396 characters of first-person English, and eleven `compaction` records titled
 * in English.
 * </p>
 *
 * <p>
 * The two ends of one chain are asserted here. The value side: the player's BCP-47 companion locale reduced to the
 * single shape the vendor's validator accepts (its `isValidLanguageCode`: two letters that `Intl.DisplayNames` can
 * name), with a locale it would reject refused by NAME rather than written - a value that fails that refine fails
 * the read of the whole user config, taking the historian's model and the fold's thresholds with it. The file side:
 * the value lands in the user-scope config through a real mount, and never in the project file, whose copy the
 * vendor deletes on load.
 * </p>
 *
 * <p>
 * `withContentLanguageDirective` itself is not driven here, because the Host cannot reach it: the vendored
 * pi-plugin exports it from no subpath (`.`, `./memory`, `./tavern` were each read). What the vendor does with the
 * value is therefore cited, not executed - `pi-plugin/src/index.ts:1113` carries `config.language` into the
 * historian deps and `pi-historian-runner.ts:562-566` appends the directive with it.
 * </p>
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAGIC_CONTEXT_CONTENT_LANGUAGE_UNSUPPORTED,
  magicContextContentLanguage,
} from "./magic-context-content-language.js";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import type { PresentationRuntime } from "./presentation.js";
import { type CompanionIdentity, createCompanionRuntime, resolveRuntimePaths } from "./runtime.js";
import { PlayerPreferenceStore, playerPreferencePath } from "./settings/player-preference-store.js";
import { createBuildWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.js";

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

const identity: CompanionIdentity = Object.freeze({
  continuityId: "continuity_content_language",
  playerId: "player_content_language",
  saveId: "save_content_language",
  worldId: "world_content_language",
  companionId: "companion_content_language",
});

/** The root these cases build in: where the product builds, not where the runner happens to point TMP. */
function canonicalRootParent(): string {
  const root = process.platform === "win32" ? (process.env.LOCALAPPDATA ?? tmpdir()) : tmpdir();
  return realpathSync(root);
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(canonicalRootParent(), "gamebuddy-content-language-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The player's own companion language, written the one way the product writes it. */
async function writeCompanionLocale(root: string, locale: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await new PlayerPreferenceStore(playerPreferencePath(root)).update(0, { action: "setLocale", locale });
}

/** The two Magic Context config files the mount wrote, read back as the extension reads them. */
async function writtenConfigs(root: string): Promise<{
  project: Record<string, unknown>;
  user: Record<string, unknown>;
}> {
  const runtimeCwd = resolveRuntimePaths(identity, root).runtimeCwd;
  return {
    project: JSON.parse(await readFile(join(runtimeCwd, ".cortexkit", "magic-context.jsonc"), "utf8")),
    user: JSON.parse(await readFile(join(runtimeCwd, "config", "cortexkit", "magic-context.jsonc"), "utf8")),
  };
}

/**
 * A Game mount, in the exact shape the Game surface constructs: `createGameCompanionRuntime` hands the core no
 * presentation, so the locale this surface writes can only come from the stored preference.
 */
async function mountGameSurface(root: string) {
  return await createCompanionRuntime(
    identity,
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    "game_content_language_01",
    undefined,
    "game",
  );
}

function presentationFor(surface: "chat" | "game", locale: string): PresentationRuntime {
  return Object.freeze({
    profile: Object.freeze({ locale, text: true, speech: null }),
    surface,
    sessionId: `${surface}_content_language_01`,
  });
}

/** Everything the mount and the writer print, so a named diagnostic can be read where it is emitted. */
async function captureStderr(run: () => Promise<void>): Promise<string> {
  const write = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return printed;
}

test("a companion locale reaches Magic Context as the 2-letter code its validator accepts", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["zh-CN", "zh"],
    ["zh-Hant-TW", "zh"],
    ["pt-BR", "pt"],
    ["ja-JP", "ja"],
    ["en", "en"],
  ];
  for (const [locale, expected] of cases) assert.equal(magicContextContentLanguage(locale), expected, locale);
});

test("a locale with no 2-letter ISO 639-1 language is refused by name, never written", async () => {
  // Three-letter languages are real BCP-47 and no ISO 639-1 code; "xx" is two letters the vendor cannot resolve;
  // the rest are the shapes a corrupt or half-written preference could hold.
  for (const locale of ["yue-Hant-TW", "fil-PH", "xx-YY", "", "-CN"]) {
    let language: string | undefined;
    const printed = await captureStderr(async () => {
      language = magicContextContentLanguage(locale);
    });
    assert.equal(language, undefined, `${JSON.stringify(locale)} must not reach the config`);
    assert.ok(
      printed.includes(MAGIC_CONTEXT_CONTENT_LANGUAGE_UNSUPPORTED),
      `${JSON.stringify(locale)} was refused without a named diagnostic: ${printed}`,
    );
    assert.ok(printed.includes(JSON.stringify(locale)), `the diagnostic must name the locale it refused: ${printed}`);
  }
});

test("a Game mount writes the player's stored language where the historian reads it", async () => {
  await withRoot(async (root) => {
    await writeCompanionLocale(root, "zh-CN");
    const runtime = await mountGameSurface(root);
    try {
      const { project, user } = await writtenConfigs(root);
      assert.equal(user.language, "zh");
      // User scope only: the vendor deletes a project-tier `language` on load (project-security.ts:432-437), so a
      // copy written there would be a silent no-op rather than a second opinion.
      assert.equal("language" in project, false);
    } finally {
      runtime.session.dispose();
    }
  });
});

test("a surface that resolved its own locale writes that value", async () => {
  await withRoot(async (root) => {
    // Chat and Preview resolve the player's locale once and carry it on their presentation; the config then names
    // the same language the surface's own prompt was built in rather than a second read of the store.
    const runtime = await createCompanionRuntime(
      identity,
      root,
      undefined,
      undefined,
      undefined,
      presentationFor("chat", "en-US"),
      false,
      undefined,
      "chat_content_language_01",
      undefined,
      "chat",
    );
    try {
      const { user } = await writtenConfigs(root);
      assert.equal(user.language, "en");
    } finally {
      runtime.session.dispose();
    }
  });
});

test("a locale the vendor would reject never reaches the file, and the surface still mounts", async () => {
  await withRoot(async (root) => {
    await writeCompanionLocale(root, "yue-Hant-TW");
    let runtime: Awaited<ReturnType<typeof mountGameSurface>> | undefined;
    const printed = await captureStderr(async () => {
      runtime = await mountGameSurface(root);
    });
    try {
      const { project, user } = await writtenConfigs(root);
      assert.equal("language" in user, false, "a language the vendor's validator rejects must not be in the config");
      assert.equal("language" in project, false);
      assert.ok(printed.includes(MAGIC_CONTEXT_CONTENT_LANGUAGE_UNSUPPORTED), "the refusal must be a named diagnostic");
      assert.ok(printed.includes('"yue-Hant-TW"'), "the diagnostic must name the locale it refused");
      assert.ok(runtime !== undefined, "a locale without an ISO 639-1 code must not stop the surface mounting");
    } finally {
      runtime?.session.dispose();
    }
  });
});
