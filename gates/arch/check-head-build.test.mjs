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
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { renderReport, runHeadBuild, worktreeBlockedReason } from "./check-head-build.mjs";

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
