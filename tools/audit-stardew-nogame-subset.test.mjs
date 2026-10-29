// The no-game subset gate. Its job is to fail when the project's `<Compile Include>` list and
// the compiler disagree, so the assertions here are about the gate's own report: that both
// directions are named, and that the derivation is the compiler's answer rather than a list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveGameFreeFiles, projectFiles, suiteFiles } from "./audit-stardew-nogame-subset.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = join(
  ROOT,
  "integrations/stardew/tests/GameBuddy.Stardew.NoGame.Tests/GameBuddy.Stardew.NoGame.Tests.csproj",
);

test("the derivation asks the compiler, so it cannot agree with a hand-edited list", () => {
  const result = deriveGameFreeFiles();
  assert.equal(result.derived === null, false, "the compiler must accept some subset");
  assert.ok(result.rounds >= 1);
  assert.equal(result.total, suiteFiles().length);
  assert.equal(result.derived.length + result.refused.length, result.total);
});

test("the project compiles exactly the files the compiler accepts without a game", () => {
  const derived = deriveGameFreeFiles();
  assert.deepEqual(projectFiles(), derived.derived);
});

test("no game-free file is left out of the no-game lane", () => {
  const derived = deriveGameFreeFiles();
  const included = projectFiles();
  const missing = derived.derived.filter((name) => !included.includes(name));
  assert.deepEqual(missing, [], `unrun headless tests: ${missing.join(", ")}`);
});

test("no file that needs a game is compiled into the no-game lane", () => {
  const derived = deriveGameFreeFiles();
  const included = projectFiles();
  const extra = included.filter((name) => !derived.derived.includes(name));
  assert.deepEqual(extra, [], `game-dependent files in the no-game lane: ${extra.join(", ")}`);
});

test("the project includes the suite's files and holds no copy of its own", () => {
  const project = readFileSync(PROJECT, "utf8");
  for (const match of project.matchAll(/<Compile\s+Include="([^"]+)"/gu)) {
    assert.ok(
      match[1].replace(/\\/gu, "/").startsWith("../GameBuddy.Stardew.Integration.Tests/"),
      `${match[1]} is not a file of the integration suite`,
    );
  }
  assert.deepEqual(
    projectFiles().filter((name) => !suiteFiles().includes(name)),
    [],
  );
});

test("the subset is small enough that a green run must not be read as the whole suite", () => {
  // A guard against the other silent failure: if this subset ever grew to the whole suite the
  // no-game lane would be claiming to be the integration suite. The printed counts carry the
  // same fact at run time; this keeps a person from quietly deleting the distinction.
  const derived = deriveGameFreeFiles();
  const total = suiteFiles().length;
  assert.ok(derived.derived.length < total, "a no-game subset that equals the suite is not a subset");
  assert.ok(derived.refused.length > 0, "some files must still need a game");
});
