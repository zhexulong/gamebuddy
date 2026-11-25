/**
 * Falsifiers for `gates/arch/check-head-build.mjs`, each on a real `git init` repository.
 *
 * The defect the gate exists for cannot be planted in a directory: it is the difference between the working tree and a
 * commit, so every case below writes a repository, commits it, and asks the gate about a `git worktree add --detach` of
 * it. The two LAYERS are the one thing replaced here, and replacing them is the point: `tsc` and `dotnet` are boundaries
 * this suite does not own, while the worktree, the cleanliness proof, the pair, the not-measured word and the cleanup
 * are the gate, and each is driven through the gate's own code rather than around it.
 *
 * red-proof: inject  a green host layer beside a red Mod layer -> `host=0 mod=1 errors=1` and exit 1 ("a green host layer
 *                    beside red C# is not one green reading")
 * red-proof: inject  both layers red at one commit -> `host=2 mod=1 errors=3` and exit 1
 * red-proof: inject  a layer that exits non-zero printing no diagnostic -> `head_build_failed_without_a_diagnostic:mod`,
 *                    because `errors=0` beside a non-zero exit is the reading that misleads a reader
 * red-proof: inject  a layer whose child outlives its deadline -> `head_build_layer_timeout:mod:300ms`, the layer failed,
 *                    and the worktree this run created is gone ("an interrupted layer is cleaned up after")
 * red-proof: inject  a worktree whose `status --porcelain` is not empty -> `head_build_worktree_not_clean`, exit 2
 *                    ("a worktree holding somebody else's bytes is not the commit")
 * red-proof: inject  a worktree at a different revision -> `head_build_worktree_wrong_revision`, exit 2
 * red-proof: inject  a ref that does not resolve -> `head_build_ref_unresolved`, exit 2, no layer run
 * red-proof: inject  a run whose first layer throws -> `head_build_threw` and the worktree is gone ("a throw is not a
 *                    leftover")
 * red-proof: inject  a layer the environment cannot run -> `head_build_mod_skipped:` on the pair as `mod=not_measured`
 *                    and exit 0 ("not measured is a word, not a zero"), and both layers skipped -> `head_build_nothing_measured`,
 *                    exit 2 ("a run that measured no layer is blocked")
 * red-proof: history  the commit's own test is red on its own bytes -> `head_tests files=2 passed=1 failed=1 [file: …]`
 *                    and exit 1: measured at `cc3469a8`, whose two layers were `host=0 mod=0` and whose
 *                    `host/src/hello-ack-refusal-naming.test.ts` ran 1 of its 2 tests red
 * red-proof: inject  a derived test file that exits non-zero -> `[file: <path>]` on the `head_tests` line and exit 1
 * red-proof: inject  a derived test file the commit's project did not emit -> `head_tests_skipped:`, and a layer that ran
 *                    no file at all -> `head_tests_nothing_measured`, exit 2 (never a pass)
 * red-proof: inject  a test child killed by its own deadline -> `head_tests_file_timeout:<path>:<ms>`, the file counted red
 * red-proof: inject  a commit that touches no test file -> `head_tests population=0 reason=<derived: the commit touched no
 *                    test file>`, exit 0
 * red-proof: inject  a `git diff-tree` that fails -> `head_tests_blocked: head_tests_population_underivable`, exit 2
 * red-proof: inject  an unbound reclaimer in a child's output -> `head_tests_skipped:` (the invocation refused, not the
 *                    commit), and the same output with the pair bound -> a red file
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  headTestsLines,
  measureHeadTests,
  renderReport,
  runHeadBuild,
  runTestFile,
  worktreeBlockedReason,
} from "./check-head-build.mjs";

const roots = [];

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  roots.push(path);
  return path;
}

/** A git command in a fixture repository, insulated from this machine's own git configuration. */
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-gitconfig") },
  });
}

/** A repository with one commit, which is what a worktree at `HEAD` needs. */
function makeRepository(files = { "host/src/main.ts": "export const value = 1;\n" }) {
  const root = scratch("head-build-repo");
  git(root, ["init", "-q"]);
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  git(root, ["add", "--", ...Object.keys(files)]);
  git(root, [
    "-c",
    "user.name=head-build-gate",
    "-c",
    "user.email=head-build@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    "planted",
  ]);
  return root;
}

/** The `git` runner the gate takes, over a fixture repository. */
function gitRunnerFor(root) {
  return (args, cwd = root) => {
    try {
      const stdout = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "no-global-gitconfig") },
      });
      return { status: 0, stdout, stderr: "", error: null };
    } catch (error) {
      return {
        status: typeof error.status === "number" ? error.status : 1,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? ""),
        error: null,
      };
    }
  };
}

/** A layer that is this process running a snippet: the layer's own command, not a replacement for the gate's code. */
function nodeLayer(name, { script, diagnostic = /error (?:TS|CS)\d+/u, skipReason }) {
  return { name, command: process.execPath, args: ["-e", script], diagnostic, skipReason };
}

const GREEN = (name) => nodeLayer(name, { script: "process.exit(0)" });

/** A layer that prints one diagnostic and exits non-zero, the shape both compilers produce. */
const RED = (name, line, exit) =>
  nodeLayer(name, { script: `console.log(${JSON.stringify(line)}); process.exit(${exit})` });

/** Run the gate over a fixture repository with a chosen worktree path, and always report where that path is. */
function run({ root, layers, timeoutMs = 10_000, run: runner, worktree = join(scratch("head-build-wt"), "wt") }) {
  const report = runHeadBuild({
    root,
    worktree,
    layers,
    timeoutMs,
    git: gitRunnerFor(root),
    ...(runner === undefined ? {} : { run: runner }),
  });
  const rendered = renderReport(report);
  return { report, rendered, worktree, pair: rendered.lines[0] };
}

test("both layers green is the only reading that passes", () => {
  const root = makeRepository();
  const { report, pair, rendered, worktree } = run({ root, layers: [GREEN("host"), GREEN("mod")] });
  assert.equal(report.status, "passed");
  assert.match(pair, / host=0 mod=0 errors=0$/u);
  assert.equal(rendered.exitCode, 0);
  assert.match(rendered.lines.join("\n"), /head_build: passed - both layers compiled the commit/u);
  assert.equal(existsSync(worktree), false);
});
test("a green host layer beside a red Mod layer is not one green reading", () => {
  const root = makeRepository();
  const { report, rendered, worktree, pair } = run({
    root,
    layers: [GREEN("host"), RED("mod", "BridgeSession.cs(443,13): error CS0246: nope", 1)],
  });
  assert.equal(report.status, "failed");
  assert.equal(report.errors, 1);
  assert.equal(pair, `head_build ref=${report.revision.slice(0, 12)} host=0 mod=1 errors=1`);
  assert.equal(rendered.exitCode, 1);
  assert.match(rendered.lines.join("\n"), /a working tree that compiles is not evidence about this commit/u);
  assert.equal(existsSync(worktree), false);
});

test("both layers red at one commit prints both exits", () => {
  const root = makeRepository();
  const { report, pair, rendered } = run({
    root,
    layers: [
      RED("host", "materializer.ts(586,73): error TS2769: no overload matches this call", 2),
      nodeLayer("mod", {
        script: 'console.log("a.cs(1,1): error CS0246: x"); console.log("b.cs(2,2): error CS0246: y"); process.exit(1)',
      }),
    ],
  });
  assert.equal(report.status, "failed");
  assert.equal(report.errors, 3);
  assert.match(pair, / host=2 mod=1 errors=3$/u);
  assert.equal(rendered.exitCode, 1);
});

test("a failure with no diagnostic is named rather than counted as zero errors", () => {
  const root = makeRepository();
  const { report, rendered } = run({ root, layers: [GREEN("host"), nodeLayer("mod", { script: "process.exit(1)" })] });
  assert.equal(report.errors, 0);
  assert.equal(report.status, "failed");
  assert.match(rendered.lines.join("\n"), /head_build_failed_without_a_diagnostic:mod exit=1/u);
});

test("a layer killed by its own deadline leaves no worktree behind", () => {
  const root = makeRepository();
  const { report, rendered, worktree } = run({
    root,
    timeoutMs: 300,
    layers: [GREEN("host"), nodeLayer("mod", { script: "setTimeout(() => {}, 10000)" })],
  });
  assert.equal(report.status, "failed");
  assert.equal(report.layers[1].reason, "head_build_layer_timeout:mod:300ms");
  assert.match(rendered.lines.join("\n"), /head_build_layer_timeout:mod:300ms/u);
  assert.equal(existsSync(worktree), false);
});

test("a throw inside a layer is a blocked reading, and the worktree is still removed", () => {
  const root = makeRepository();
  const { report, worktree } = run({
    root,
    layers: [GREEN("host"), GREEN("mod")],
    run: () => {
      throw new Error("layer spawn exploded");
    },
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "head_build_threw");
  assert.match(report.detail, /layer spawn exploded/u);
  assert.equal(existsSync(worktree), false);
});

test("an unclean worktree is blocked, never measured", () => {
  const refusal = worktreeBlockedReason({
    git: (args) => ({
      status: 0,
      stdout: args[0] === "rev-parse" ? "abc123\n" : " M host/src/main.ts\n?? scratch.txt\n",
      stderr: "",
      error: null,
    }),
    worktree: "D:/scratch/wt",
    revision: "abc123",
  });
  assert.equal(refusal.blocked.code, "head_build_worktree_not_clean");
  assert.match(refusal.blocked.detail, /2 path\(s\) differ from the commit/u);
});

test("a worktree at another revision is blocked, not measured", () => {
  const refusal = worktreeBlockedReason({
    git: () => ({ status: 0, stdout: "def456\n", stderr: "", error: null }),
    worktree: "D:/scratch/wt",
    revision: "abc123",
  });
  assert.equal(refusal.blocked.code, "head_build_worktree_wrong_revision");
});

test("a ref that does not resolve is blocked before any layer runs", () => {
  const root = makeRepository();
  const report = runHeadBuild({
    root,
    rev: "no-such-commit-anywhere",
    layers: [GREEN("host"), GREEN("mod")],
    git: gitRunnerFor(root),
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "head_build_ref_unresolved");
  assert.equal(report.layers.length, 0);
  assert.equal(renderReport(report).exitCode, 2);
});

test("a worktree path already in use is refused rather than measured", () => {
  const root = makeRepository();
  const worktree = join(scratch("head-build-wt"), "wt");
  mkdirSync(worktree, { recursive: true });
  const report = runHeadBuild({ root, worktree, layers: [GREEN("host")], git: gitRunnerFor(root) });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "head_build_path_in_use");
  assert.equal(existsSync(worktree), true);
});

test("a layer the environment cannot run is not measured, not zero", () => {
  const root = makeRepository();
  const { report, pair, rendered } = run({
    root,
    layers: [
      GREEN("host"),
      nodeLayer("mod", { script: "process.exit(0)", skipReason: () => "dotnet is not on PATH here" }),
    ],
  });
  assert.equal(report.status, "passed");
  assert.match(pair, / mod=not_measured errors=0$/u);
  assert.match(rendered.lines.join("\n"), /head_build_mod_skipped: dotnet is not on PATH here/u);
  assert.equal(rendered.exitCode, 0);
});

test("a layer that declares what it did not cover says so in the reading", () => {
  const root = makeRepository();
  const { rendered } = run({
    root,
    layers: [
      GREEN("host"),
      nodeLayer("mod", {
        script:
          'console.log("csharp_compile_excluded:integrations/stardew/Mod.csproj:no game folder here"); process.exit(0)',
      }),
    ],
  });
  assert.match(
    rendered.lines.join("\n"),
    /! csharp_compile_excluded:integrations\/stardew\/Mod\.csproj:no game folder here/u,
  );
});

test("a run that measured no layer is blocked", () => {
  const root = makeRepository();
  const { report, rendered } = run({
    root,
    layers: [
      nodeLayer("host", { script: "process.exit(0)", skipReason: () => "no typescript here" }),
      nodeLayer("mod", { script: "process.exit(0)", skipReason: () => "no game folder here" }),
    ],
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.code, "head_build_nothing_measured");
  assert.equal(rendered.exitCode, 2);
});

//
// The third reading: the commit's own tests
//

/**
 * The files a commit needs for the tests reading to reach a child: the Host test project, the compiler it runs, and one
 * test file. Nothing is emitted into `dist-test` here - the compile step's stub writes what it "emitted", which is what a
 * real one does, and keeps a build output out of the committed file list.
 */
function headTestRepository({ files = { "host/src/hello.test.ts": "import test from 'node:test';\n" } } = {}) {
  const root = makeRepository({
    // The fixture carries the same ignore the real tree does, because the gate junctions `host/node_modules` in AFTER a
    // commit is checked out and the cleanliness proof then has to still see the commit's own bytes.
    ".gitignore": "node_modules/\ndist-test/\n",
    "host/tsconfig.test.json": "{}\n",
    ...files,
  });
  // The compiler is this checkout's dependency tree rather than a file of the commit, and the gate junctioning it in is the
  // production arrangement: written here AFTER the commit, so it is the source checkout's `host/node_modules` that the
  // worktree sees, exactly as a real run sees this repo's.
  mkdirSync(join(root, "host", "node_modules", "typescript", "lib"), { recursive: true });
  writeFileSync(
    join(root, "host", "node_modules", "typescript", "lib", "tsc.js"),
    "// the compiler this checkout has\n",
  );
  return root;
}

/**
 * The two children `measureHeadTests` spawns, replaced: the TypeScript compiler and Node's test runner are boundaries this
 * suite does not own. Everything the gate does AROUND them - the derivation, the emitted-file check, the counting, the
 * skipped/reclassified rows and the verdict - is the code under test.
 */
function testChildren({
  compileExit = 0,
  emit = ["host/dist-test/hello.test.js"],
  child = { exit: 0, output: "" },
} = {}) {
  return (command, args, options) => {
    if (args.includes("--project")) {
      for (const relative of emit) {
        mkdirSync(dirname(join(options.cwd, relative)), { recursive: true });
        writeFileSync(join(options.cwd, relative), "// emitted\n");
      }
      return { status: compileExit, pid: undefined, stdout: "", stderr: "", error: null };
    }
    if (child.output !== "" && typeof options.stdio?.[1] === "number") writeSync(options.stdio[1], child.output);
    return {
      status: child.exit,
      pid: undefined,
      stdout: "",
      stderr: "",
      error: child.error ?? null,
    };
  };
}

/** One `measureHeadTests` reading over a fixture repository and its stubbed children. */
function headTests(root, { run: runner = testChildren(), rev = "HEAD", git = gitRunnerFor(root) } = {}) {
  return measureHeadTests({ worktree: root, root, rev, git, run: runner });
}

test("a commit whose own test is red is a red reading, and it names the file", () => {
  const root = headTestRepository();
  const reading = headTests(root, {
    run: testChildren({ child: { exit: 1, output: "ℹ tests 2\nℹ pass 1\nℹ fail 1\n" } }),
  });
  assert.equal(reading.outcome, "failed");
  assert.equal(reading.files, 1);
  assert.equal(reading.passed, 0);
  assert.equal(reading.failed, 1);
  assert.equal(reading.rows[0].counts.fail, 1);
  assert.equal(headTestsLines(reading)[0], "head_tests files=1 passed=0 failed=1 [file: host/src/hello.test.ts]");
});

test("a commit whose own test passes is one file, one exit code, no failure", () => {
  const root = headTestRepository();
  const reading = headTests(root, {
    run: testChildren({ child: { exit: 0, output: "ℹ tests 3\nℹ pass 3\nℹ fail 0\n" } }),
  });
  assert.equal(reading.outcome, "passed");
  assert.match(headTestsLines(reading)[0], /^head_tests files=1 passed=1 failed=0$/u);
});

test("a commit that touched no test file is a population of zero, and that is a reading rather than a gap", () => {
  const root = makeRepository({ "documentation/notes.md": "# nothing a test names\n" });
  const reading = headTests(root);
  assert.equal(reading.outcome, "empty");
  assert.deepEqual(headTestsLines(reading), [
    "head_tests population=0 reason=<derived: the commit touched no test file> examined=1",
  ]);
});

test("a file list git cannot produce is blocked, never a zero", () => {
  const root = headTestRepository();
  const reading = headTests(root, {
    git: () => ({ status: 128, stdout: "", stderr: "fatal: bad object", error: null }),
  });
  assert.equal(reading.outcome, "blocked");
  assert.equal(reading.code, "head_tests_population_underivable");
  const lines = headTestsLines(reading);
  assert.match(lines[0], /^head_tests_blocked: head_tests_population_underivable - /u);
});

test("a derived test the commit's project did not emit is skipped by name, and a layer that ran nothing is blocked", () => {
  const root = headTestRepository();
  const reading = headTests(root, { run: testChildren({ emit: [] }) });
  assert.equal(reading.files, 0);
  assert.equal(reading.outcome, "blocked");
  assert.equal(reading.code, "head_tests_nothing_measured");
  const lines = headTestsLines(reading);
  assert.match(lines[0], /^head_tests_blocked: head_tests_nothing_measured - /u);
  assert.match(
    lines.join("\n"),
    /head_tests_skipped: host\/src\/hello\.test\.ts the commit's own test project did not emit it, so nothing could run/u,
  );
});

test("a test child killed by its own deadline is named and counted red, never skipped", () => {
  const root = headTestRepository();
  const reading = headTests(root, {
    run: testChildren({ child: { exit: null, output: "", error: { code: "ETIMEDOUT" } } }),
  });
  assert.equal(reading.outcome, "failed");
  assert.equal(reading.rows[0].exitCode, null);
  assert.match(reading.rows[0].reason, /^head_tests_file_timeout:host\/src\/hello\.test\.ts:\d+ms$/u);
  assert.match(headTestsLines(reading).join("\n"), /exit=none \d+ms head_tests_file_timeout:/u);
});

test("an unbound reclaimer names the invocation, not the commit", () => {
  const root = scratch("head-build-tests");
  const test = { path: "host/src/hello.test.ts", runner: "ts" };
  const unbound = { exit: 1, output: "Error: windows_reclaimer_unavailable\n" };
  const skipped = runTestFile({
    worktree: root,
    test,
    index: 0,
    run: testChildren({ child: unbound }),
    preloadBound: false,
  });
  assert.equal(skipped.outcome, "skipped");
  assert.match(skipped.reason, /^windows_reclaimer_unavailable/u);
  const bound = runTestFile({
    worktree: root,
    test,
    index: 1,
    run: testChildren({ child: unbound }),
    preloadBound: true,
  });
  assert.equal(bound.outcome, "failed");
  assert.equal(bound.exitCode, 1);
});

test("a red test of the commit's own fails the run its two layers passed", () => {
  const root = headTestRepository();
  const children = testChildren({ child: { exit: 1, output: "ℹ tests 2\nℹ pass 1\nℹ fail 1\n" } });
  const { report, rendered, worktree } = run({
    root,
    layers: [GREEN("host"), GREEN("mod")],
    run: (command, args, options) =>
      args[0] === "-e" ? spawnSync(command, args, options) : children(command, args, options),
  });
  assert.equal(report.status, "failed");
  const text = rendered.lines.join("\n");
  assert.match(text, /host=0 mod=0 errors=0/u);
  assert.match(text, /head_tests files=1 passed=0 failed=1 \[file: host\/src\/hello\.test\.ts\]/u);
  assert.match(text, /a commit that compiles is not a commit whose own tests pass/u);
  assert.equal(rendered.exitCode, 1);
  assert.equal(existsSync(worktree), false);
});

test("the report says so when no test file was derived", () => {
  const root = makeRepository({ "documentation/notes.md": "# nothing a test names\n" });
  const { rendered } = run({ root, layers: [GREEN("host"), GREEN("mod")] });
  const text = rendered.lines.join("\n");
  assert.match(text, /head_tests population=0 reason=<derived: the commit touched no test file> examined=1/u);
  assert.match(text, /no test file was derived from it, so no test of it was run/u);
  assert.equal(rendered.exitCode, 0);
});
