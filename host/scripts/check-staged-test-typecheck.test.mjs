/**
 * The scoping predicate, planted against.
 *
 * `check-staged-test-typecheck.mjs` decides whether a commit is blocked from ONE question - which files this commit
 * contains - so a predicate that quietly returns an empty set turns the gate green over everything. That is the exact
 * shape of the defect the gate exists for (a gate that cannot report), so the predicate is tested directly rather
 * than only through a real commit.
 *
 * The filtering is tested over paths, not over a real index: a suite that stages files would race every other lane in
 * this worktree, and the property being protected is "which of these paths is this commit's business", which is a pure
 * function of a path list.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { hostProjectFiles } from "./check-staged-test-typecheck.mjs";

test("scope.1: a Host test source is this commit's business", (t) => {
  const files = hostProjectFiles(["host/src/declaration-agreement.test.ts"]);
  assert.deepEqual(files, ["src/declaration-agreement.test.ts"], "the path is relative to host/, as tsc reports it");
  t.diagnostic(`scope.1: ${files.join(", ")}`);
});

test("scope.2: a path outside the Host test project is dropped, not reported", () => {
  // `tsconfig.test.json` compiles `host/src/**` only: a file it never loads cannot carry an error it could report, and
  // naming it in the failure would be a false accusation.
  assert.deepEqual(
    hostProjectFiles([
      "dialogue-web/src/app.ts",
      "tools/scripts/pre-commit.mjs",
      "integrations/stardew/ModEntry.cs",
      "package.json",
    ]),
    [],
    "nothing outside host/src is compiled by the project this gate reads",
  );
});

test("scope.3: the one path inside host/src the project EXCLUDES is excluded here too", () => {
  // `host/tsconfig.test.json` excludes `src/main.ts`. Keeping it would make every commit to the production entry point
  // pay for a compile it cannot affect, and would report errors from a file this gate does not describe. No fact gets
  // two spellings: this list is the project's own `exclude`, and the assertion below fails if the project changes.
  assert.deepEqual(hostProjectFiles(["host/src/main.ts"]), [], "the test project excludes the production entry point");
});

test("scope.4: a non-TypeScript path is not compiled, so it is not checked", () => {
  assert.deepEqual(hostProjectFiles(["host/src/test-fixtures/windows-named-mutex-abandon-child.ps1"]), []);
});

test("scope.5: every Host source type the project includes is checked, not only the ones named `.test.ts`", (t) => {
  // The population is the PROJECT's include, not a filename convention: a production source under `host/src` is
  // compiled by `tsconfig.test.json` too, so a commit that breaks one of those must be blocked by the same gate.
  const files = hostProjectFiles(["host/src/game-tools.ts", "host/src/declaration-agreement.test.ts"]);
  assert.deepEqual(
    files,
    ["src/game-tools.ts", "src/declaration-agreement.test.ts"],
    "a type error does not care which suffix the file has",
  );
  t.diagnostic(`scope.5: ${files.length} file(s)`);
});
