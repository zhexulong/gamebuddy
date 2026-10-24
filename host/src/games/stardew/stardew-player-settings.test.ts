import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../../windows-stale-lock-reclaimer/index.js";
import {
  DEFAULT_STARDEW_PLAYER_SETTINGS,
  StardewPlayerSettingsRevisionConflict,
  StardewPlayerSettingsStore,
  readStardewPlayerSettings,
  stardewPlayerSettingsPath,
} from "./stardew-player-settings.js";

// The record's durable path lock releases through the Windows stale-lock
// reclaimer; bind the same capability the production runtime binds.
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

async function createRoot(): Promise<string> {
  return await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-stardew-player-settings-"));
}

async function seedDocument(root: string, document: unknown): Promise<string> {
  const path = stardewPlayerSettingsPath(root);
  await mkdir(join(root, "stardew"), { recursive: true });
  await writeFile(path, JSON.stringify(document), "utf8");
  return path;
}

test("an absent record projects every family consented and a solo night", async () => {
  const root = await createRoot();
  const settings = await readStardewPlayerSettings(root);
  assert.deepEqual(settings, {
    revision: 0,
    deniedActionFamilies: [],
    advanceDayMinimumOnlineFarmers: 1,
  });
  assert.equal(DEFAULT_STARDEW_PLAYER_SETTINGS.revision, 0);
});

test("one save advances the revision and both values", async () => {
  const store = new StardewPlayerSettingsStore(await createRoot());
  const saved = await store.update(0, {
    deniedActionFamilies: ["farming_crops", "animals_pets"],
    advanceDayMinimumOnlineFarmers: 2,
  });
  assert.deepEqual(saved, {
    revision: 1,
    // Stored sorted, so two records with the same denials compare equal.
    deniedActionFamilies: ["animals_pets", "farming_crops"],
    advanceDayMinimumOnlineFarmers: 2,
  });
  assert.deepEqual(await store.read(), saved);
});

test("a stale revision is refused and changes nothing", async () => {
  const store = new StardewPlayerSettingsStore(await createRoot());
  await store.update(0, { deniedActionFamilies: ["farming_crops"], advanceDayMinimumOnlineFarmers: 1 });
  await assert.rejects(
    () => store.update(0, { deniedActionFamilies: [], advanceDayMinimumOnlineFarmers: 1 }),
    StardewPlayerSettingsRevisionConflict,
  );
  assert.deepEqual(await store.read(), {
    revision: 1,
    deniedActionFamilies: ["farming_crops"],
    advanceDayMinimumOnlineFarmers: 1,
  });
});

/**
 * The whole-record-replacement defect this repository has fixed twice: a save
 * must patch the keys it owns and leave every other key in the document alone.
 * The hand-added field here is one no reader knows about, which is exactly the
 * case a browser payload-derived replacement destroys.
 */
test("a hand-added field elsewhere in the document survives a save", async () => {
  const root = await createRoot();
  const path = await seedDocument(root, {
    schemaVersion: 1,
    revision: 0,
    deniedActionFamilies: [],
    advanceDayMinimumOnlineFarmers: 1,
    windowMode: "hidden",
    playerNote: { kept: ["verbatim", 7] },
  });

  await new StardewPlayerSettingsStore(root).update(0, {
    deniedActionFamilies: ["resource_gathering"],
    advanceDayMinimumOnlineFarmers: 3,
  });

  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(written.playerNote, { kept: ["verbatim", 7] });
  assert.equal(written.windowMode, "hidden");
  assert.equal(written.revision, 1);
  assert.deepEqual(written.deniedActionFamilies, ["resource_gathering"]);
  assert.equal(written.advanceDayMinimumOnlineFarmers, 3);
});

test("a foreign field does not stop the record from being read", async () => {
  const root = await createRoot();
  await seedDocument(root, {
    schemaVersion: 1,
    revision: 4,
    deniedActionFamilies: ["shops_economy"],
    advanceDayMinimumOnlineFarmers: 2,
    aFieldFromALaterBuild: true,
  });
  assert.deepEqual(await readStardewPlayerSettings(root), {
    revision: 4,
    deniedActionFamilies: ["shops_economy"],
    advanceDayMinimumOnlineFarmers: 2,
  });
});

test("the update refuses values a player could not have chosen", async () => {
  const store = new StardewPlayerSettingsStore(await createRoot());
  for (const bad of [
    { deniedActionFamilies: ["NotALowercaseFamily"], advanceDayMinimumOnlineFarmers: 1 },
    { deniedActionFamilies: ["farming_crops", "farming_crops"], advanceDayMinimumOnlineFarmers: 1 },
    { deniedActionFamilies: [], advanceDayMinimumOnlineFarmers: 0 },
    { deniedActionFamilies: [], advanceDayMinimumOnlineFarmers: 5 },
    { deniedActionFamilies: [], advanceDayMinimumOnlineFarmers: 1.5 },
    { deniedActionFamilies: [], advanceDayMinimumOnlineFarmers: 1, extra: true },
  ]) {
    await assert.rejects(() => store.update(0, bad as never), /invalid_stardew_player_settings_update/);
  }
  // A refused update writes nothing, so the revision a caller read is still valid.
  assert.equal((await store.read()).revision, 0);
});

test("a corrupt record is refused instead of silently replaced", async () => {
  const root = await createRoot();
  await seedDocument(root, { schemaVersion: 1, revision: "one", deniedActionFamilies: [] });
  await assert.rejects(() => readStardewPlayerSettings(root), /invalid_stardew_player_settings_store/);
  await assert.rejects(
    () =>
      new StardewPlayerSettingsStore(root).update(0, { deniedActionFamilies: [], advanceDayMinimumOnlineFarmers: 1 }),
    /invalid_stardew_player_settings_store/,
  );
});
