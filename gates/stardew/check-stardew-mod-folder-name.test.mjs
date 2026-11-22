import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

/**
 * The check asserts one name across the csproj, two JavaScript seams and every PowerShell harness under `tools/`.
 * Its falsifiers therefore run the check itself (through `--root`) against a miniature tree, so a passing green here
 * cannot come from a rule that was re-implemented in the test.
 *
 * red-proof: fixture  the PowerShell case spells `Mods/GameBuddy.Stardew/config.json` - the exact string four real
 * harnesses carried on 2026-11-04, when a correct lane died at preflight with `Missing harness path`.
 */

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const CHECK = join(REPO, "tools", "check-stardew-mod-folder-name.mjs");

function runCheck(...args) {
  try {
    const out = execFileSync(process.execPath, [CHECK, ...args], { encoding: "utf8" });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** A tree that satisfies every clause, so each case below can break exactly one. */
async function agreeingTree() {
  const root = await mkdtemp(join(tmpdir(), "modfolder-"));
  const write = async (path, contents) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  };
  await write(
    "integrations/stardew/GameBuddy.Stardew.csproj",
    "<Project><PropertyGroup><ModFolderName>GameBuddy</ModFolderName></PropertyGroup></Project>\n",
  );
  await write("tools/lib/stardew-fixture-profile.mjs", "export const modRoot = join(mods, STARDEW_MOD_FOLDER);\n");
  await write("tools/lib/stardew-mod-config.ps1", "function Get-GameBuddyStardewModConfigPath([string]$ModsPath) {}\n");
  await write(
    "tools/live-run/game/launch-ladder-live.mjs",
    "const config = join(mods, STARDEW_MOD_FOLDER, 'config.json');\n",
  );
  await write(
    "tools/run-fixture.ps1",
    '. (Join-Path $PSScriptRoot "lib/stardew-mod-config.ps1")\n$clientConfig = Get-GameBuddyStardewModConfigPath $ModsPath\n',
  );
  return root;
}

test("the tree agrees today", () => {
  const result = runCheck();
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /stardew_mod_folder: GameBuddy/u);
  assert.match(result.out, /every tools\/ PowerShell harness/u);
});

test("the agreeing tree passes, so the failing cases below fail for their own reason", async () => {
  const root = await agreeingTree();
  try {
    const result = runCheck("--root", root);
    assert.equal(result.code, 0, result.out);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a csproj that declares the MSBuild default is a mismatch, not a pass", async () => {
  const root = await agreeingTree();
  try {
    await writeFile(
      join(root, "integrations/stardew/GameBuddy.Stardew.csproj"),
      "<Project><PropertyGroup><ModFolderName>GameBuddy.Stardew</ModFolderName></PropertyGroup></Project>\n",
      "utf8",
    );
    const result = runCheck("--root", root);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /GameBuddy\.Stardew\.csproj:declares ModFolderName=GameBuddy\.Stardew/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a JavaScript seam that spells the folder under Mods is named", async () => {
  const root = await agreeingTree();
  try {
    await writeFile(
      join(root, "tools/lib/stardew-fixture-profile.mjs"),
      'export const config = join(profile, "Mods", "GameBuddy.Stardew", "config.json");\n',
      "utf8",
    );
    const result = runCheck("--root", root);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /stardew-fixture-profile\.mjs:spells "GameBuddy\.Stardew" literally under Mods/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a PowerShell harness that spells the folder is named, including one added later", async () => {
  const root = await agreeingTree();
  try {
    // The historical line, verbatim: this is what four fixtures carried while the fixtures deployed GameBuddy.
    await writeFile(
      join(root, "tools/run-fixture.ps1"),
      '$clientConfig = Join-Path $ModsPath "GameBuddy.Stardew/config.json"\n',
      "utf8",
    );
    // A file the check has never seen, in a subdirectory it must still reach.
    await mkdir(join(root, "tools/lib"), { recursive: true });
    await writeFile(
      join(root, "tools/lib/new-harness.ps1"),
      '$cfg = Join-Path $ModsPath "GameBuddy.Stardew\\config.json"\n',
      "utf8",
    );
    const result = runCheck("--root", root);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /run-fixture\.ps1:spells "GameBuddy\.Stardew", which every fixture contradicts/u);
    assert.match(result.out, /lib\/new-harness\.ps1:spells "GameBuddy\.Stardew"/u);
    assert.match(result.out, /Get-GameBuddyStardewModConfigPath/u, "the failure must name the seam to use");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deployed name and the assembly file names are not folder splits", async () => {
  const root = await agreeingTree();
  try {
    await writeFile(
      join(root, "tools/run-fixture.ps1"),
      '$cfg = Join-Path $ModsPath "GameBuddy/config.json"\nCopy-Item (Join-Path $ModsPath "GameBuddy/GameBuddy.Stardew.dll") $out\n',
      "utf8",
    );
    const result = runCheck("--root", root);
    assert.equal(result.code, 0, result.out);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tree without the PowerShell seam is a mismatch", async () => {
  const root = await agreeingTree();
  try {
    await writeFile(join(root, "tools/lib/stardew-mod-config.ps1"), "Set-StrictMode -Version Latest\n", "utf8");
    const result = runCheck("--root", root);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /stardew-mod-config\.ps1:must define Get-GameBuddyStardewModConfigPath/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
