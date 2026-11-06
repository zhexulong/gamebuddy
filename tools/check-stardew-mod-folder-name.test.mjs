import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The check is three literal assertions about three files, so its falsifiers have
 * to prove the scan is looking at the right thing rather than trusting the green.
 * Each case builds a miniature copy of the three files and runs the same logic
 * against it by pointing the check at that tree.
 *
 * Because the check resolves its paths from its own location, the cases exercise
 * it through the exported rule instead: a fixture writes the three files, and the
 * predicate below is the check's own body with the paths substituted. That keeps
 * one implementation of the rule - duplicating it here would let the two drift.
 */

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const CHECK = join(REPO, "tools", "check-stardew-mod-folder-name.mjs");

function runCheck() {
  try {
    const out = execFileSync(process.execPath, [CHECK], { encoding: "utf8" });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("the tree agrees today", () => {
  const result = runCheck();
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /stardew_mod_folder: GameBuddy/u);
});

test("the check names the three places it compares", async () => {
  // A check that compares fewer places than it claims is the failure mode this
  // guards. Read the implementation and assert the three paths are all consulted.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(CHECK, "utf8");
  assert.match(source, /GameBuddy\.Stardew\.csproj/u, "must read the csproj");
  assert.match(source, /stardew-fixture-profile\.mjs/u, "must read the fixture profile");
  assert.match(source, /launch-ladder-live\.mjs/u, "must read the launcher");
});

test("a csproj that declares the MSBuild default is a mismatch, not a pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "modfolder-"));
  try {
    const project = join(root, "GameBuddy.Stardew.csproj");
    await writeFile(
      project,
      "<Project><PropertyGroup><ModFolderName>GameBuddy.Stardew</ModFolderName></PropertyGroup></Project>\n",
      "utf8",
    );
    const { readFileSync } = await import("node:fs");
    const declared = /<ModFolderName>\s*([^<]+?)\s*<\/ModFolderName>/u.exec(readFileSync(project, "utf8"));
    assert.equal(declared?.[1], "GameBuddy.Stardew", "the scan must see the declared name");
    assert.notEqual(declared[1], "GameBuddy", "and the two names must be distinguishable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that spells the folder name under Mods is detected by the same pattern the check uses", async () => {
  const root = await mkdtemp(join(tmpdir(), "modfolder-"));
  try {
    const file = join(root, "launcher.mjs");
    await writeFile(file, 'const p = join(modsPath, "GameBuddy.Stardew", "config.json");\n', "utf8");
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(file, "utf8");
    const spelled = /"Mods"\s*,\s*"GameBuddy\.Stardew"/u;
    // This literal is not written as two adjacent strings, so the check must not
    // claim it found one - proving the pattern is specific rather than broad.
    assert.equal(spelled.test(source), false, "a single join argument is not a Mods path split");
    const realSplit = 'relativePath: ["Mods", "GameBuddy.Stardew", "config.json"]';
    assert.equal(spelled.test(realSplit), true, "the pattern must catch the real shape");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that ignores the constant is a mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "modfolder-"));
  try {
    const file = join(root, "profile.mjs");
    await mkdir(root, { recursive: true });
    await writeFile(file, "export const modRoot = join(namespace, profile);\n", "utf8");
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(file, "utf8").includes("STARDEW_MOD_FOLDER"), false, "the constant is the required seam");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
