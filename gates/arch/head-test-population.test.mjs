/**
 * Falsifiers for `gates/arch/head-test-population.mjs`, the derivation behind the `head_tests` reading.
 *
 * The derivation is the half of that layer a reader can check without a compiler: which of a commit's own tests must run,
 * given the files it touched. Every case here is a synthetic file list over a synthetic tree - except the two that ask
 * `git` itself, because "the commit's own file list" is git's answer and a second reading of it would be a second
 * authority.
 *
 * red-proof: inject  drop the importing-suite rule -> `cc3469a8` derives `protocol.test.ts` and never
 *                    `hello-ack-refusal-naming.test.ts`, i.e. `population` for the commit whose own test was red at 1 of 2
 *                    (the historical red this layer exists for) - the case "a changed module runs the suites that import
 *                    it" fails, naming the missing file
 * red-proof: inject  map a changed `.cs` file to `<Name>Tests.cs` by name -> the case "a changed C# source is named, never
 *                    mapped by a guess" fails on `unmapped` being empty: `cc3469a8` changed
 *                    `FarmhandActionDefinitions.cs` and its new test is `ArgumentDescriptionFitsTheWireBoundTests.cs`,
 *                    which that rule never reaches
 * red-proof: inject  read the walk's `node_modules` -> the case "the walk skips dependencies and build output" fails on a
 *                    test file under `host/node_modules/`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  commitChangedPaths,
  deriveHeadTestPopulation,
  listTestFiles,
  siblingTests,
  specifierCandidates,
} from "./head-test-population.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  roots.push(path);
  return path;
}

/** A tree of files, as `{ path: text }`, written under a fresh directory. */
function tree(files) {
  const root = scratch("head-test-population");
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), contents);
  }
  return root;
}

/** The derivation over a synthetic commit: the file list, the tree's tests, and the tree's bytes. */
function derive({ changedPaths, files }) {
  const read = (path) => files[path] ?? null;
  return deriveHeadTestPopulation({
    changedPaths,
    listTests: () =>
      Object.keys(files)
        .filter((path) => /\.test\.(?:ts|mjs|js)$/u.test(path))
        .sort(),
    read,
  });
}

test("a changed test file runs itself, and a changed module runs the suites named for it", () => {
  const files = {
    "host/src/mod.ts": "export const value = 1;\n",
    "host/src/mod.test.ts": "import test from 'node:test';\n",
    "host/src/mod.private.test.ts": "import test from 'node:test';\n",
    "host/src/mod.internal.test.ts": "import test from 'node:test';\n",
    "host/src/other.test.ts": "import test from 'node:test';\n",
  };
  const derived = derive({ changedPaths: ["host/src/mod.ts", "host/src/other.test.ts"], files });
  assert.deepEqual(
    derived.tests.map((entry) => entry.path),
    ["host/src/mod.internal.test.ts", "host/src/mod.private.test.ts", "host/src/mod.test.ts", "host/src/other.test.ts"],
  );
  assert.equal(
    derived.tests.every((entry) => entry.runner === "ts"),
    true,
  );
  assert.deepEqual(siblingTests({ changedPath: "host/src/mod.ts", candidates: Object.keys(files) }), [
    "host/src/mod.test.ts",
    "host/src/mod.private.test.ts",
    "host/src/mod.internal.test.ts",
  ]);
});

test("a changed module runs the suites that import it, and only those", () => {
  const files = {
    "host/src/protocol.ts": "export const frame = 1;\n",
    "host/src/protocol.test.ts": "import { frame } from './protocol.js';\n",
    "host/src/hello-ack-refusal-naming.test.ts": "import { frame } from './protocol.js';\n",
    "host/src/nested/deep.test.ts": "import { frame } from '../protocol.js';\n",
    "host/src/unrelated.test.ts": "import { other } from './other.js';\n",
    "host/src/other.ts": "export const other = 2;\n",
  };
  const derived = derive({ changedPaths: ["host/src/protocol.ts"], files });
  assert.deepEqual(
    derived.tests.map((entry) => entry.path),
    ["host/src/hello-ack-refusal-naming.test.ts", "host/src/nested/deep.test.ts", "host/src/protocol.test.ts"],
  );
});

test("a changed fixture runs the suites that import it", () => {
  const files = {
    "integrations/stardew/action-development/contracts/generated/action-surface.v1.json": "{}\n",
    "host/src/surface.test.ts": "import surface from '../../integrations/stardew/x/action-surface.v1.json';\n",
  };
  // The specifier is written as the tree spells it, so the derivation resolves the changed path it names and no other.
  const changed = "integrations/stardew/x/action-surface.v1.json";
  const derived = derive({ changedPaths: [changed], files });
  assert.deepEqual(
    derived.tests.map((entry) => entry.path),
    ["host/src/surface.test.ts"],
  );
  assert.deepEqual(specifierCandidates({ from: "host/src/a.test.ts", specifier: "./b.js" }), [
    "host/src/b.js",
    "host/src/b.ts",
  ]);
});

test("a changed C# source is named, never mapped by a guess", () => {
  const derived = derive({
    changedPaths: [
      "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
      "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ArgumentDescriptionFitsTheWireBoundTests.cs",
    ],
    files: {},
  });
  assert.deepEqual(derived.tests, []);
  assert.equal(derived.unmapped.length, 2);
  assert.match(derived.unmapped[0].reason, /no mechanical name maps a changed `\.cs` file to its `\*Tests\.cs`/u);
});

test("the walk skips dependencies and build output", () => {
  const root = tree({
    "host/src/real.test.ts": "\n",
    "host/src/nested/deeper.test.ts": "\n",
    "host/node_modules/pkg/x.test.js": "\n",
    "host/dist-test/x.test.js": "\n",
    "vendor/tool/y.test.mjs": "\n",
  });
  assert.deepEqual(listTestFiles({ root }), ["host/src/nested/deeper.test.ts", "host/src/real.test.ts"]);
});

test("the file list is git's own answer, and a refusal is blocked rather than empty", () => {
  const root = tree({ "host/src/mod.ts": "export const value = 1;\n", "documentation/note.md": "# note\n" });
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-gitconfig") },
    });
  git(["init", "-q"]);
  git(["add", "--", "host/src/mod.ts", "documentation/note.md"]);
  git([
    "-c",
    "user.name=x",
    "-c",
    "user.email=x@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "planted",
  ]);
  const runner = (args) => ({ status: 0, stdout: git(args), stderr: "", error: null });
  assert.deepEqual(commitChangedPaths({ git: runner, rev: "HEAD" }).paths, [
    "documentation/note.md",
    "host/src/mod.ts",
  ]);
  const refusal = commitChangedPaths({
    git: () => ({ status: 128, stdout: "", stderr: "fatal: bad object\n", error: null }),
    rev: "no-such-commit",
  });
  assert.equal(refusal.blocked.code, "head_tests_population_underivable");
  assert.match(refusal.blocked.detail, /diff-tree/u);
});
