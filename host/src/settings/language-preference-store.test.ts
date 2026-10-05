import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import {
  companionLocalePath,
  type LanguagePreference,
  LanguagePreferenceRevisionConflict,
  LanguagePreferenceStore,
  readStoredCompanionLocale,
  resolveCompanionLocale,
} from "./language-preference-store.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";

// The store's durable path lock releases through the Windows stale-lock
// reclaimer; bind the same capability the production runtime binds.
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

async function withStore(run: (path: string, store: LanguagePreferenceStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-language-preference-"));
  try {
    const path = join(root, "settings", "language-preference.json");
    await run(path, new LanguagePreferenceStore(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("language preference defaults to unconfigured and projects exact public keys", async () => {
  await withStore(async (_path, store) => {
    assert.deepEqual(await store.read(), {
      revision: 0,
      locale: null,
    } satisfies LanguagePreference);

    const updated = await store.update(0, { locale: "zh-CN" });
    assert.equal(updated.revision, 1);
    assert.equal(updated.locale, "zh-CN");
    assert.deepEqual(Object.keys(updated).sort(), ["locale", "revision"]);
    assert.deepEqual(await store.read(), updated);

    const english = await store.update(1, { locale: "en-US" });
    assert.equal(english.revision, 2);
    assert.equal(english.locale, "en-US");
  });
});

test("language preference rejects a stale revision and malformed updates", async () => {
  await withStore(async (_path, store) => {
    await store.update(0, { locale: "en-US" });
    await assert.rejects(store.update(0, { locale: "zh-CN" }), LanguagePreferenceRevisionConflict);
    await assert.rejects(store.update(1, { locale: "ja-JP" as never }), /invalid_language_preference_update/);
    await assert.rejects(store.update(1, { locale: null as never }), /invalid_language_preference_update/);
    await assert.rejects(store.update(1, {} as never), /invalid_language_preference_update/);
  });
});

test("language preference store rejects malformed persisted files without overwriting them", async () => {
  await withStore(async (path, store) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, revision: 0, locale: "ja-JP" }));
    await assert.rejects(store.read(), /invalid_language_preference_store/);
    assert.deepEqual(await store.read().catch(() => null), null);
  });
});

test("language preference store rejects a corrupted persisted file without overwriting it", async () => {
  await withStore(async (path, store) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{\"schemaVersion\":1,\"revision\":0,\"locale\":\"zh-CN\" , garbage");
    await assert.rejects(store.read(), /invalid_language_preference_store/);
    // A malformed store never overwrites the file with defaults.
    const raw = await readFile(path, "utf8");
    assert.match(raw, /garbage/);
    await assert.rejects(store.update(0, { locale: "en-US" }), /invalid_language_preference_store/);
  });
});
test("the runtime-facing reader resolves the player's choice from the one root path", async () => {
  // The runtime never carries a locale of its own: it asks this reader, and only a
  // configured preference overrides the default.
  const root = await canonicalTestRoot("companion-locale-root-");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  assert.equal(companionLocalePath(root).endsWith(join("settings", "language-preference.json")), true);
  // Never configured: no stored value, and the effective locale is the default.
  assert.equal(await readStoredCompanionLocale(root), undefined);
  assert.equal(await resolveCompanionLocale(root), "zh-CN");

  const store = new LanguagePreferenceStore(companionLocalePath(root));
  await store.update(0, { locale: "en-US" });
  assert.equal(await readStoredCompanionLocale(root), "en-US");
  assert.equal(await resolveCompanionLocale(root), "en-US");

  // A corrupt file is not a "no preference": the runtime must refuse rather than
  // speak a language the player did not choose.
  await writeFile(companionLocalePath(root), "{\"schemaVersion\":1,\"revision\":0,\"locale\":\"fr-FR\"}");
  await assert.rejects(readStoredCompanionLocale(root), /invalid_language_preference_store/);
  await rm(root, { recursive: true, force: true });
});
