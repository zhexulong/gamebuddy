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
  writeStardewModActionPolicyIntoConfig,
} from "./stardew-mod-action-policy-projection.js";

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
  PipeName: "gamebuddy-stardew",
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

test("the projection names exactly the three fields the record becomes", () => {
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
 */
test("merging leaves every key the composer wrote exactly as it was", () => {
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
