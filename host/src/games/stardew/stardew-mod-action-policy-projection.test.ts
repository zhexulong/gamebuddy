import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../../windows-stale-lock-reclaimer/index.js";
import {
  mergeStardewModActionPolicy,
  projectStardewModActionPolicy,
  readStardewModPresentationLocale,
  writeStardewModActionPolicyIntoConfig,
} from "./stardew-mod-action-policy-projection.js";
import { PlayerPreferenceStore, playerPreferencePath } from "../../settings/player-preference-store.js";

bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

async function withConfig(document: unknown, run: (configPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-stardew-mod-config-"));
  try {
    const directory = join(root, "ai-client", "Mods", "GameBuddy");
    await mkdir(directory, { recursive: true });
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify(document), "utf8");
    await run(configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const COMPOSER_CONFIG = Object.freeze({
  EnableLocalBridge: true,
  // A qualified fixture name, not the production pipe name: this suite is about
  // which keys survive a merge, so it must not spell the value
  // `integrations/stardew/config.example.json` owns (duplicated-authority gate).
  PipeName: "gamebuddy-stardew-policy-projection",
  BridgeToken: "bridge-token-0123456789",
  SaveId: "save-1",
  WorldId: "world-1",
  PlayerId: "player-1",
  CompanionId: "companion-1",
  ActionPolicyVersion: 1,
  FarmhandProvisioner: {
    Enable: true,
    ManifestPath: "C:\\session\\stardew-farmhand-manifest.json",
    SessionToken: "session-token-0123456789",
    IntegrationVersion: "0.1.0",
    TimeoutSeconds: 45,
  },
});

test("the projection names exactly the three fields the settings record becomes, and no locale", () => {
  const policy = projectStardewModActionPolicy({
    deniedActionFamilies: ["farming_crops", "animals_pets"],
    advanceDayMinimumOnlineFarmers: 2,
  });
  assert.deepEqual(policy, {
    DeniedActions: [],
    DeniedActionFamilies: ["farming_crops", "animals_pets"],
    AdvanceDayMinimumOnlineFarmers: 2,
  });
  assert.equal(Object.isFrozen(policy), true);
});

/**
 * The property this module exists for: the bridge credentials, the provisioning
 * token and every fixture field the composer wrote survive a player save. A
 * projection that rebuilt the document from the record would erase all of them,
 * and the Mod would then fail to connect at the next launch.
 */ test("merging leaves every key the composer wrote exactly as it was", () => {
  const merged = mergeStardewModActionPolicy(COMPOSER_CONFIG, {
    DeniedActions: [],
    DeniedActionFamilies: ["npc_social"],
    AdvanceDayMinimumOnlineFarmers: 2,
  });
  for (const [key, value] of Object.entries(COMPOSER_CONFIG)) {
    assert.deepEqual(merged[key], value, `${key} must survive the merge unchanged`);
  }
  assert.deepEqual(merged.DeniedActionFamilies, ["npc_social"]);
  assert.equal(merged.AdvanceDayMinimumOnlineFarmers, 2);
});

test("merging into a live config keeps its credentials and writes the policy", async () => {
  await withConfig(COMPOSER_CONFIG, async (configPath) => {
    const wrote = await writeStardewModActionPolicyIntoConfig(configPath, {
      DeniedActions: [],
      DeniedActionFamilies: ["resource_gathering"],
      AdvanceDayMinimumOnlineFarmers: 3,
    });
    assert.equal(wrote, true);
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(written.FarmhandProvisioner, COMPOSER_CONFIG.FarmhandProvisioner);
    assert.equal(written.BridgeToken, COMPOSER_CONFIG.BridgeToken);
    assert.equal(written.PipeName, COMPOSER_CONFIG.PipeName);
    assert.deepEqual(written.DeniedActionFamilies, ["resource_gathering"]);
    assert.equal(written.AdvanceDayMinimumOnlineFarmers, 3);
    assert.deepEqual(written.DeniedActions, []);
  });
});

test("a config carrying a field nobody here knows about keeps it", async () => {
  await withConfig({ ...COMPOSER_CONFIG, WindowMode: "hidden" }, async (configPath) => {
    await writeStardewModActionPolicyIntoConfig(configPath, {
      DeniedActions: [],
      DeniedActionFamilies: [],
      AdvanceDayMinimumOnlineFarmers: 1,
    });
    const written = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(written.WindowMode, "hidden");
  });
});

test("an absent config is skipped, not an error", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-stardew-mod-absent-"));
  try {
    const wrote = await writeStardewModActionPolicyIntoConfig(join(root, "no-such", "config.json"), {
      DeniedActions: [],
      DeniedActionFamilies: [],
      AdvanceDayMinimumOnlineFarmers: 1,
    });
    assert.equal(wrote, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merging into a document without a chosen language leaves the key absent", () => {
  const merged = mergeStardewModActionPolicy(COMPOSER_CONFIG, {
    DeniedActions: [],
    DeniedActionFamilies: [],
    AdvanceDayMinimumOnlineFarmers: 1,
  });
  // Absence is the answer: it is what makes the Mod present in the live game
  // locale, so a merge must not fill the key with a placeholder either.
  assert.equal(Object.hasOwn(merged, "PresentationLocale"), false);
});

/**
 * A live action-policy save says nothing about language, so it must not erase a
 * locale the bootstrap authored into the same document - and a projection that
 * carries a locale must set it.
 */
test("a projection with no locale leaves the document's authored locale alone", () => {
  const authored = { ...COMPOSER_CONFIG, PresentationLocale: "en-US" };
  const merged = mergeStardewModActionPolicy(authored, {
    DeniedActions: [],
    DeniedActionFamilies: ["npc_social"],
    AdvanceDayMinimumOnlineFarmers: 1,
  });
  assert.equal(merged.PresentationLocale, "en-US");

  const withLocale = mergeStardewModActionPolicy(authored, {
    DeniedActions: [],
    DeniedActionFamilies: [],
    AdvanceDayMinimumOnlineFarmers: 1,
    PresentationLocale: "zh-CN",
  });
  assert.equal(withLocale.PresentationLocale, "zh-CN");
});

async function withPreference(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-stardew-presentation-locale-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the presentation locale is read from the preference record, never invented", async () => {
  await withPreference(async (root) => {
    // Nobody chose: there is no locale to project, and the Mod keeps its own
    // live-game-locale fallback.
    assert.equal(await readStardewModPresentationLocale(root), undefined);

    await new PlayerPreferenceStore(playerPreferencePath(root)).update(0, { action: "setLocale", locale: "en-US" });
    assert.equal(await readStardewModPresentationLocale(root), "en-US");
  });
});

test("an unreadable preference record yields no locale rather than a guess", async () => {
  await withPreference(async (root) => {
    const path = playerPreferencePath(root);
    await mkdir(join(root, "settings"), { recursive: true });
    await writeFile(path, "{ not a record", "utf8");
    assert.equal(await readStardewModPresentationLocale(root), undefined);
  });
});

test("a document this module cannot merge into is refused, not replaced", async () => {
  await withConfig(["not", "an", "object"], async (configPath) => {
    await assert.rejects(
      () =>
        writeStardewModActionPolicyIntoConfig(configPath, {
          DeniedActions: [],
          DeniedActionFamilies: [],
          AdvanceDayMinimumOnlineFarmers: 1,
        }),
      /stardew_mod_config_not_mergeable/,
    );
    // The refusal left the document exactly as it was.
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), ["not", "an", "object"]);
  });
});
