import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { STARDEW_GAME_EXECUTABLE_FILE, STARDEW_SMAPI_EXECUTABLE_FILE, probeStardewGameRoot } from "./discovery.js";
import { createWindowsMicrosoftStoreInstallationSource } from "./microsoft-store-source.js";

/**
 * The Microsoft Store / PC Game Pass channel, proven on real directory shapes.
 *
 * Every test builds the layout the Xbox app actually writes under a temporary directory standing
 * in for one drive root, so the population is derived from that root the same way the production
 * sweep derives it from `C:\`, `D:\` and the rest. A string assertion on a constant would pass
 * while the channel offered a folder that holds no game.
 */

async function driveRoot(): Promise<string> {
  return await realpath(await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-store-drive-")));
}

const MODS_ENABLED = ["Program Files", "ModifiableWindowsApps", "Stardew Valley"] as const;
const DEFAULT_LAYOUT = ["XboxGames", "Stardew Valley", "Content"] as const;

async function writeGame(directory: string, files: readonly string[]): Promise<string> {
  await mkdir(directory, { recursive: true });
  for (const file of files) await writeFile(join(directory, file), "binary");
  return directory;
}

test("a mods-enabled Store install is proposed, with the folder the game is really in", async () => {
  const drive = await driveRoot();
  try {
    const installRoot = await writeGame(join(drive, ...MODS_ENABLED), [STARDEW_GAME_EXECUTABLE_FILE]);
    const facts = await createWindowsMicrosoftStoreInstallationSource({
      platform: "win32",
      driveRoots: [drive],
      probe: probeStardewGameRoot,
    }).read();
    assert.deepEqual(facts, { roots: [installRoot], diagnostics: [] });
  } finally {
    await rm(drive, { recursive: true, force: true });
  }
});

test("a game in the default Store layout is named as an install no mod loader can run in", async () => {
  const drive = await driveRoot();
  try {
    const content = await writeGame(join(drive, ...DEFAULT_LAYOUT), [STARDEW_GAME_EXECUTABLE_FILE]);
    // The game is genuinely there - the shared probe says so - which is why silence here would be
    // the "not installed" sentence this channel exists to stop saying.
    assert.deepEqual(await probeStardewGameRoot(content), {
      readable: true,
      gameExecutable: true,
      smapi: false,
    });
    const facts = await createWindowsMicrosoftStoreInstallationSource({
      platform: "win32",
      driveRoots: [drive],
      probe: probeStardewGameRoot,
    }).read();
    assert.deepEqual(facts.roots, []);
    assert.deepEqual(facts.diagnostics, ["microsoft-store-install-not-mod-enabled"]);
  } finally {
    await rm(drive, { recursive: true, force: true });
  }
});

test("a drive carrying neither Store layout says nothing at all", async () => {
  const drive = await driveRoot();
  try {
    const facts = await createWindowsMicrosoftStoreInstallationSource({
      platform: "win32",
      driveRoots: [drive],
      probe: probeStardewGameRoot,
    }).read();
    assert.deepEqual(facts, { roots: [], diagnostics: [] });
  } finally {
    await rm(drive, { recursive: true, force: true });
  }
});

test("both layouts on one drive report the offerable install and the unusable copy", async () => {
  const drive = await driveRoot();
  try {
    const installRoot = await writeGame(join(drive, ...MODS_ENABLED), [
      STARDEW_GAME_EXECUTABLE_FILE,
      STARDEW_SMAPI_EXECUTABLE_FILE,
    ]);
    await writeGame(join(drive, ...DEFAULT_LAYOUT), [STARDEW_GAME_EXECUTABLE_FILE]);
    const facts = await createWindowsMicrosoftStoreInstallationSource({
      platform: "win32",
      driveRoots: [drive],
      probe: probeStardewGameRoot,
    }).read();
    assert.deepEqual(facts.roots, [installRoot]);
    assert.deepEqual(facts.diagnostics, ["microsoft-store-install-not-mod-enabled"]);
  } finally {
    await rm(drive, { recursive: true, force: true });
  }
});

test("a layout root this process could not inspect is named, never read as an empty drive", async () => {
  const drive = await driveRoot();
  try {
    // The unreadable case is the boundary this process does not own (a permission or IO failure),
    // so the probe is the seam that reports it. Both layouts are unreadable here.
    const facts = await createWindowsMicrosoftStoreInstallationSource({
      platform: "win32",
      driveRoots: [drive],
      probe: async () => Object.freeze({ readable: false, gameExecutable: false }),
    }).read();
    assert.deepEqual(facts, { roots: [], diagnostics: ["microsoft-store-root-unreadable"] });
  } finally {
    await rm(drive, { recursive: true, force: true });
  }
});

test("outside Windows the channel reports itself unavailable without touching a drive", async () => {
  let probed = 0;
  const facts = await createWindowsMicrosoftStoreInstallationSource({
    platform: "linux",
    driveRoots: ["C:\\"],
    probe: async () => {
      probed += 1;
      return Object.freeze({ readable: true, gameExecutable: true });
    },
  }).read();
  assert.deepEqual(facts, { roots: [], diagnostics: ["microsoft-store-unavailable"] });
  assert.equal(probed, 0);
});
