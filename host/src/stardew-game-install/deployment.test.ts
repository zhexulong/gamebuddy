import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decideStardewCompanionModDeployment,
  deployStardewCompanionMod,
  isCanonicalWindowsDirectory,
  type StardewCompanionModDeploymentFailure,
  type StardewCompanionModDeploymentResult,
  type StardewCompanionModPackage,
  type StardewCompanionModTargetState,
} from "./index.js";

const UNIQUE_ID = "zhexulong.GameBuddy";
const MOD_ENTRIES = Object.freeze([
  "GameBuddy.Stardew.Core.dll",
  "GameBuddy.Stardew.deps.json",
  "GameBuddy.Stardew.dll",
  "manifest.json",
]);

function decision(target: StardewCompanionModTargetState, version = "0.1.0") {
  return decideStardewCompanionModDeployment(target, Object.freeze({ uniqueId: UNIQUE_ID, version }));
}

test("the deployment decision names every target state", () => {
  assert.deepEqual(decision({ kind: "absent" }), { kind: "install" });
  assert.deepEqual(decision({ kind: "unreadable" }), { kind: "target_unreadable" });
  assert.deepEqual(decision({ kind: "installed", uniqueId: UNIQUE_ID, version: "0.1.0" }), {
    kind: "update",
    installedVersion: "0.1.0",
  });
  assert.deepEqual(decision({ kind: "installed", uniqueId: UNIQUE_ID, version: "0.0.9" }), {
    kind: "replace_requires_consent",
    installedVersion: "0.0.9",
  });
  assert.deepEqual(decision({ kind: "installed", uniqueId: "someone.else.Mod", version: "0.1.0" }), {
    kind: "foreign_mod_present",
    uniqueId: "someone.else.Mod",
  });
});

test("only canonical drive-rooted directories are acceptable game roots", () => {
  assert.equal(isCanonicalWindowsDirectory("C:\\Games\\Stardew Valley"), true);
  assert.equal(isCanonicalWindowsDirectory("C:\\"), true);
  assert.equal(isCanonicalWindowsDirectory("c:\\Games"), true);
  assert.equal(isCanonicalWindowsDirectory("relative\\Games"), false);
  assert.equal(isCanonicalWindowsDirectory("\\\\server\\share"), false);
  assert.equal(isCanonicalWindowsDirectory("C:/Games"), false);
  assert.equal(isCanonicalWindowsDirectory("C:\\Games\\..\\Other"), false);
  assert.equal(isCanonicalWindowsDirectory("C:\\Games\\bad<name"), false);
  assert.equal(isCanonicalWindowsDirectory(undefined), false);
});

test("an invalid package is refused before any installation is touched", async () => {
  const result = await deployStardewCompanionMod({
    installRoot: "C:\\Games\\Stardew Valley",
    package: { root: "C:\\pkg", entries: [], uniqueId: UNIQUE_ID, version: "0.1.0" },
  });
  assert.deepEqual(result, { kind: "failed", failure: "mod_package_invalid" });
});

function isFailure(
  result: StardewCompanionModDeploymentResult,
  failure: StardewCompanionModDeploymentFailure,
): boolean {
  return result.kind === "failed" && result.failure === failure;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(join(await realpath(tmpdir()), prefix));
}

async function writePackage(
  directory: string,
  version: string,
  uniqueId = UNIQUE_ID,
): Promise<StardewCompanionModPackage> {
  await mkdir(directory, { recursive: true });
  for (const entry of MOD_ENTRIES.slice(0, 3)) await writeFile(join(directory, entry), `${entry}:${version}`);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      Name: "GameBuddy",
      Author: "GameBuddy contributors",
      UniqueID: uniqueId,
      Version: version,
      EntryDll: "GameBuddy.Stardew.dll",
    }),
  );
  return Object.freeze({ root: directory, entries: MOD_ENTRIES, uniqueId, version });
}

async function writeGameRoot(prefix: string, withSmapi = true, withMods = true): Promise<string> {
  const root = await temporaryDirectory(prefix);
  await writeFile(join(root, "Stardew Valley.exe"), "game");
  if (withSmapi) await writeFile(join(root, "StardewModdingAPI.exe"), "smapi");
  if (withMods) await mkdir(join(root, "Mods"));
  return root;
}

async function installedManifestVersion(gameRoot: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(gameRoot, "Mods", "GameBuddy", "manifest.json"), "utf8")) as {
      Version?: unknown;
    };
    return typeof manifest.Version === "string" ? manifest.Version : undefined;
  } catch {
    return undefined;
  }
}

test("a first install copies the package and is not a link", { skip: process.platform !== "win32" }, async () => {
  const gameRoot = await writeGameRoot("gamebuddy-mod-install-root-");
  const packageRoot = await temporaryDirectory("gamebuddy-mod-install-package-");
  try {
    const result = await deployStardewCompanionMod({
      installRoot: gameRoot,
      package: await writePackage(packageRoot, "0.1.0"),
    });
    assert.deepEqual(result, { kind: "installed", version: "0.1.0" });
    assert.equal(await installedManifestVersion(gameRoot), "0.1.0");
    for (const entry of MOD_ENTRIES) {
      const state = await lstat(join(gameRoot, "Mods", "GameBuddy", entry));
      assert.equal(state.isFile(), true);
      assert.equal(state.isSymbolicLink(), false);
    }
  } finally {
    await rm(gameRoot, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("re-deploying the same version is an idempotent update", { skip: process.platform !== "win32" }, async () => {
  const gameRoot = await writeGameRoot("gamebuddy-mod-update-root-");
  const packageRoot = await temporaryDirectory("gamebuddy-mod-update-package-");
  try {
    const mod = await writePackage(packageRoot, "0.1.0");
    await deployStardewCompanionMod({ installRoot: gameRoot, package: mod });
    const result = await deployStardewCompanionMod({ installRoot: gameRoot, package: mod });
    assert.deepEqual(result, { kind: "updated", installedVersion: "0.1.0", version: "0.1.0" });
  } finally {
    await rm(gameRoot, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test(
  "a different installed version is never replaced without consent",
  { skip: process.platform !== "win32" },
  async () => {
    const gameRoot = await writeGameRoot("gamebuddy-mod-consent-root-");
    const packageRoot = await temporaryDirectory("gamebuddy-mod-consent-package-");
    try {
      await deployStardewCompanionMod({ installRoot: gameRoot, package: await writePackage(packageRoot, "0.1.0") });
      const newer = await writePackage(packageRoot, "0.2.0");
      const refused = await deployStardewCompanionMod({ installRoot: gameRoot, package: newer });
      assert.equal(isFailure(refused, "existing_mod_version_requires_consent"), true);
      assert.equal(await installedManifestVersion(gameRoot), "0.1.0");
      const consented = await deployStardewCompanionMod({
        installRoot: gameRoot,
        package: newer,
        allowReplaceDifferentVersion: true,
      });
      assert.deepEqual(consented, { kind: "updated", installedVersion: "0.1.0", version: "0.2.0" });
      assert.equal(await installedManifestVersion(gameRoot), "0.2.0");
    } finally {
      await rm(gameRoot, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  },
);

test("another author's Mod directory is never touched", { skip: process.platform !== "win32" }, async () => {
  const gameRoot = await writeGameRoot("gamebuddy-mod-foreign-root-");
  const packageRoot = await temporaryDirectory("gamebuddy-mod-foreign-package-");
  try {
    await mkdir(join(gameRoot, "Mods", "GameBuddy"), { recursive: true });
    await writeFile(
      join(gameRoot, "Mods", "GameBuddy", "manifest.json"),
      JSON.stringify({ UniqueID: "someone.else.Mod", Version: "9.9.9" }),
    );
    const result = await deployStardewCompanionMod({
      installRoot: gameRoot,
      package: await writePackage(packageRoot, "0.1.0"),
    });
    assert.equal(isFailure(result, "foreign_mod_present"), true);
    assert.equal(await installedManifestVersion(gameRoot), "9.9.9");
  } finally {
    await rm(gameRoot, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test(
  "a Mod directory that cannot be read as our manifest is refused",
  { skip: process.platform !== "win32" },
  async () => {
    const gameRoot = await writeGameRoot("gamebuddy-mod-unreadable-root-");
    const packageRoot = await temporaryDirectory("gamebuddy-mod-unreadable-package-");
    try {
      await mkdir(join(gameRoot, "Mods", "GameBuddy"), { recursive: true });
      await writeFile(join(gameRoot, "Mods", "GameBuddy", "manifest.json"), "{not json");
      const result = await deployStardewCompanionMod({
        installRoot: gameRoot,
        package: await writePackage(packageRoot, "0.1.0"),
      });
      assert.equal(isFailure(result, "installed_mod_manifest_unreadable"), true);
    } finally {
      await rm(gameRoot, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a game without SMAPI, without a Mods folder, or absent is named",
  { skip: process.platform !== "win32" },
  async () => {
    const packageRoot = await temporaryDirectory("gamebuddy-mod-precondition-package-");
    const noSmapi = await writeGameRoot("gamebuddy-mod-no-smapi-", false, true);
    const noMods = await writeGameRoot("gamebuddy-mod-no-mods-", true, false);
    const missing = join(await realpath(tmpdir()), "gamebuddy-mod-never-created");
    const notAGame = await temporaryDirectory("gamebuddy-mod-not-a-game-");
    try {
      const mod = await writePackage(packageRoot, "0.1.0");
      assert.equal(
        isFailure(await deployStardewCompanionMod({ installRoot: noSmapi, package: mod }), "smapi_not_installed"),
        true,
      );
      assert.equal(
        isFailure(await deployStardewCompanionMod({ installRoot: noMods, package: mod }), "mods_directory_missing"),
        true,
      );
      assert.equal(
        isFailure(
          await deployStardewCompanionMod({ installRoot: missing, package: mod }),
          "game_installation_not_found",
        ),
        true,
      );
      assert.equal(
        isFailure(
          await deployStardewCompanionMod({ installRoot: notAGame, package: mod }),
          "game_installation_not_found",
        ),
        true,
      );
      assert.equal(
        isFailure(
          await deployStardewCompanionMod({ installRoot: "relative\\Stardew Valley", package: mod }),
          "game_installation_not_found",
        ),
        true,
      );
    } finally {
      await rm(noSmapi, { recursive: true, force: true });
      await rm(noMods, { recursive: true, force: true });
      await rm(notAGame, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
    }
  },
);
