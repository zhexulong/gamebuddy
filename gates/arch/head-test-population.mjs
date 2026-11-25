/**
 * WHICH of a commit's own tests must run, derived from the commit's own file list.
 *
 * WHY THIS FILE EXISTS. `gates/arch/check-head-build.mjs` asks whether a COMMIT compiles, because `prelive`'s L2 build
 * and `pnpm typecheck` both read the working tree. It answered that question for two languages and never asked the next
 * one: measured 2026-11-25 at `cc3469a8`, both layers passed (`host=0 mod=0 errors=0`) while the commit's own
 * `host/src/hello-ack-refusal-naming.test.ts` was red on the commit's own bytes - 1 of its 2 tests passed - and the first
 * reading that noticed was a game launch. A commit that compiles is not a commit whose tests pass, and a test file's name
 * is not evidence that it runs: only running it is.
 *
 * THE POPULATION IS THE COMMIT'S FILE LIST, crossed with the tree it carries:
 *
 *   a changed test file      runs itself. `*.test.ts` and `*.test.mjs`/`*.test.js` alike, because a commit that touched a
 *                            test file has changed what that test says.
 *   a changed module         runs the tests NAMED for it beside it: `<stem>.test.ts`, `<stem>.private.test.ts`,
 *                            `<stem>.internal.test.ts` - one prefix rule, because those three spellings are this tree's
 *                            three ways of saying "the suite of this module".
 *   a changed TypeScript     runs the tests that IMPORT it. This is the rule that finds the historical red above: nothing
 *   module or fixture       is named after `protocol.ts`'s behaviour, and `hello-ack-refusal-naming.test.ts` is one of the
 *                           105 committed suites that import `./protocol.js`. A derived population without it would have
 *                           printed `population=1` for `cc3469a8` and passed - a green reading over the exact commit this
 *                           layer exists for.
 *   a changed `.cs` file     is named `head_tests_skipped:` with the reason there is no mapping: see `CSHARP_LIMIT`.
 *
 * THE LIMITS ARE STATED HERE RATHER THAN DISCOVERED LATER, and each is a boundary of what a FILE LIST can say:
 *
 *   * imports only. A suite that READS a changed file (`readFileSync("fixtures/x.json")`) instead of importing it is not
 *     derived. Following file reads would mean following arbitrary string arguments, which no static reading can do
 *     without running the test it is trying to select.
 *   * declaration specifiers only, resolved relative (`./x.js` -> `x.ts`). A package specifier or an absolute path is not
 *     this tree's own file, so it names nothing to run.
 *   * the C# side has no mapping at all, and this is measured rather than assumed: `cc3469a8` changed
 *     `FarmhandActionDefinitions.cs` and added `ArgumentDescriptionFitsTheWireBoundTests.cs`, and no rule turns the first
 *     into the second - the suite is one `dotnet test` assembly per project, its files are named for the behaviour they
 *     pin (`ArgumentDescriptionFitsTheWireBound`), and the source's own name appears in none of them. A name-shaped guess
 *     would silently select nothing, so a `.cs` change is printed as `head_tests_skipped:` with that reason.
 *
 * NOTHING IS DERIVED FROM A WORKING TREE. The file list comes from `git diff-tree <rev>` and the bytes come from the
 * detached worktree `check-head-build` proved is the commit, so a lane's uncommitted test cannot enter the population.
 *
 * A DERIVATION THAT COULD NOT BE TAKEN IS NOT AN EMPTY ONE. `head_tests_population_underivable` (exit 2 at the caller) is
 * what a failed `git diff-tree` produces, and it is a different word from `population=0` - which is a real reading about
 * a commit that touched no test file at all.
 *
 * source-invariant: a relative import specifier in a test file is how this tree declares which module that suite covers,
 *   and it is the only artefact from which a commit's affected suites can be derived without running them.
 * source-expiry: when the TypeScript compiler's own program is the seam this gate reads (a `--listFiles`-style
 *   dependency reading per changed file), the specifier scan here is retired in favour of that authority.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The two ways this tree names a test file: the Host's compiled suite, and a `node --test` script. */
const TYPE_SCRIPT_TEST = /\.test\.ts$/u;
const NODE_TEST = /\.test\.(?:mjs|js)$/u;

/** Directories a walk must not enter: dependencies, build output, and the gitignored mounts this tree keeps. */
const UNWALKED = new Set(["node_modules", "vendor", "obj", "bin", "dist", "dist-test", "ref", ".git"]);

/** `from "./x.js"` and `import("./x.js")`: the two spellings by which a suite names a file of this tree. */
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']*)["']/gu;

/**
 * Why a changed `.cs` file runs no test here, in the words the reading prints. One constant, so the report line and this
 * module cannot describe the same absence two ways.
 */
export const CSHARP_LIMIT =
  "the C# suite is one `dotnet test` assembly per project and its files are named for the behaviour they pin, so no " +
  "mechanical name maps a changed `.cs` file to its `*Tests.cs`";

/** Does this path name a test this layer can run? */
export function isTestFile(path) {
  return TYPE_SCRIPT_TEST.test(path) || NODE_TEST.test(path);
}

/** How a test file is run: the Host's compiled suite, or `node --test` over the file itself. */
export function runnerOf(path) {
  if (TYPE_SCRIPT_TEST.test(path)) return "ts";
  if (NODE_TEST.test(path)) return "node";
  return null;
}

/** Every `*.test.ts` / `*.test.mjs` / `*.test.js` below `root`, as repo-relative paths with `/` separators. */
export function listTestFiles({ root }) {
  const found = [];
  const walk = (relative) => {
    const entries = readdirSync(relative === "" ? root : join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!UNWALKED.has(entry.name)) walk(child);
      } else if (isTestFile(child)) found.push(child);
    }
  };
  walk("");
  return found.sort();
}

/**
 * The files a relative specifier names, in the order a resolver would try them: the literal path, then the TypeScript
 * source a `.js` specifier is written for - this tree compiles `import "./protocol.js"` from `protocol.ts`.
 */
export function specifierCandidates({ from, specifier }) {
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const literal = segments.join("/");
  return literal.endsWith(".js") ? [literal, `${literal.slice(0, -".js".length)}.ts`] : [literal];
}

/** The relative specifiers one test file names. */
export function specifiersOf(source) {
  return [...source.matchAll(RELATIVE_SPECIFIER)].map((match) => match[1]);
}

/** The `<stem>.test.*` spellings a module's own suites carry, from one prefix rule rather than three list entries. */
export function siblingPattern(stem) {
  const escaped = stem.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}(?:\\.[A-Za-z0-9_-]+)*\\.test\\.(?:ts|mjs|js)$`, "u");
}

/** The directory a repo-relative path sits in: `""` at the root, so every other reading has one shape. */
const directoryOf = (path) => (path.includes("/") ? path.replace(/\/[^/]*$/u, "") : "");

/** The file name a repo-relative path ends in. */
const nameOf = (path) => {
  const directory = directoryOf(path);
  return directory === "" ? path : path.slice(directory.length + 1);
};

/** The tests named for a changed module, beside it. */
export function siblingTests({ changedPath, candidates }) {
  const directory = directoryOf(changedPath);
  const pattern = siblingPattern(nameOf(changedPath).replace(/\.[^.]*$/u, ""));
  return candidates.filter(
    (candidate) => candidate !== changedPath && directoryOf(candidate) === directory && pattern.test(nameOf(candidate)),
  );
}

/** The TypeScript suites of a commit, each with the relative specifiers it names: one read per file, done once. */
export function typeScriptSuites({ candidates, read }) {
  return candidates
    .filter((candidate) => TYPE_SCRIPT_TEST.test(candidate))
    .map((path) => ({ path, specifiers: specifiersOf(read(path) ?? "") }));
}

/** The suites that import a changed file, from the specifiers already read. */
export function importingTests({ changedPath, suites }) {
  return suites
    .filter((suite) =>
      suite.specifiers.some((specifier) => specifierCandidates({ from: suite.path, specifier }).includes(changedPath)),
    )
    .map((suite) => suite.path);
}

/**
 * The derivation. `changedPaths` is the commit's own file list, `listTests()` the tests the commit carries, and `read()`
 * a file of the commit - so one call answers "which of this commit's tests must run, and what could not be mapped".
 */
export function deriveHeadTestPopulation({ changedPaths, listTests, read }) {
  const candidates = listTests();
  const suites = typeScriptSuites({ candidates, read });
  const chosen = new Set();
  const unmapped = [];
  for (const changedPath of changedPaths) {
    if (isTestFile(changedPath)) {
      chosen.add(changedPath);
      continue;
    }
    for (const test of siblingTests({ changedPath, candidates })) chosen.add(test);
    // A changed file any suite IMPORTS is a file that suite reads, whether it is a module or a fixture: the specifier is
    // the only declaration of that dependency a file list can be crossed with.
    for (const test of importingTests({ changedPath, suites })) chosen.add(test);
    if (changedPath.endsWith(".cs")) unmapped.push({ path: changedPath, reason: CSHARP_LIMIT });
  }
  return {
    examined: changedPaths.length,
    tests: [...chosen].sort().map((path) => ({ path, runner: runnerOf(path) })),
    unmapped,
  };
}

/** The files one commit touched, from `git`'s own answer, or the reason it could not be read. */
export function commitChangedPaths({ git, rev }) {
  const outcome = git([
    "diff-tree",
    "-r",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "--root",
    "-m",
    "--first-parent",
    `${rev}^{commit}`,
  ]);
  const paths = outcome.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (outcome.status !== 0)
    return {
      blocked: {
        code: "head_tests_population_underivable",
        detail: `${rev}: \`git diff-tree\` exited ${outcome.status} (${(outcome.stderr || outcome.stdout).trim().slice(0, 200)})`,
      },
    };
  // A commit that touched nothing is a reading; a commit whose file list git could not produce is not. `-m --first-parent`
  // makes a merge answer with its own diff against the first parent, so an empty list is a real empty commit.
  return { paths };
}

/** One file of the commit, or `null` when it is not readable there. */
export function readCommitFile({ worktree, path }) {
  try {
    return readFileSync(join(worktree, path), "utf8");
  } catch {
    return null;
  }
}
