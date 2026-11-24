/**
 * Does the COMMIT build? Both layers, from committed bytes only.
 *
 * THE DEFECT. `prelive`'s L2 build and `pnpm typecheck` both read the WORKING TREE, so a commit whose consumers need a
 * declaration that exists only in somebody's uncommitted file is green for as long as that file is on disk. Measured
 * four times on 2026-11-25, and no rung of the ladder could see any of it:
 *
 *   `cb8e91c7`, `8264f967` (Host side)   the host typechecked against a `program-status-wait.ts` member another lane had
 *                                        not committed, so HEAD failed `TS2769` while the product tree was green
 *   `8264f967` (Mod side)                the commit referenced `FarmhandIntegerArgumentBound`/`FarmhandStringArgumentBound`
 *                                        and committed no definition
 *   `f6ea803a`                           red in both languages at once, green on disk
 *
 * A green working tree is not evidence about a commit. This gate is the reading that says so, and it adds no compile
 * authority of its own - see the next paragraph, which is what this lane cost to learn.
 *
 * THE MOD HALF IS WIRING, NOT COVERAGE. `gates/stardew/check-csharp-compile.mjs` already owns it: `git ls-files
 * '*.csproj'` as the population, four documented exclusions each printing its cost, and `error CS####` as "committed
 * source that does not compile". Measured 2026-11-25 by running it inside a clean worktree at `6574f2b0`: 83.2 s,
 * `csharp_compile projects=30 compiled=24 excluded=4 failed=2`, the two failures being `GameBuddy.Stardew.csproj` and
 * the integration suite, both naming the same `BridgeSession.cs(443,13): error CS0246` this lane found by hand. So it
 * compiles the Mod project on a machine with the game (the mod build package finds the Steam folder by itself; the
 * `EXCLUSIONS` row stands for the machines where it cannot, and prints that cost there). What it has never had is a rung,
 * and what it cannot do alone is read a COMMIT: it builds the tree it lives in. Run from inside this gate's worktree it
 * builds the commit, and there is still exactly one spelling of which C# projects exist and how each is judged.
 *
 * WHAT IT DOES, in four steps, each of which is why the next one is believable:
 *
 *   1. resolve the ref (`--rev`, default `HEAD`) to a sha;
 *   2. `git worktree add --detach` a throwaway worktree at that sha;
 *   3. prove the worktree IS that commit and nothing else: `rev-parse HEAD` equals the resolved sha and
 *      `status --porcelain` is empty. A worktree carrying anything else is not the commit's bytes, so the run is BLOCKED
 *      rather than measured;
 *   4. run BOTH layers there, and print each one's own exit code:
 *
 *        host  `node host/node_modules/typescript/lib/tsc.js --project host/tsconfig.json --noEmit` - the command
 *              `pnpm typecheck` runs, which is the one that cannot see a missing committed file. Nothing else in this
 *              repository typechecks a commit: the two host incidents above had no gate at all.
 *        mod   `node gates/stardew/check-csharp-compile.mjs`, run FROM the worktree, so that gate's project population,
 *              classifications and exclusions are the commit's own bytes. Its `*_excluded:` lines are printed with it:
 *              a layer that measured a narrower population than the tree says so in this gate's output.
 *
 * THE PAIR IS THE VERDICT, and it is one line so that neither layer's green can be read as the tree's:
 *
 *   head_build ref=<sha> host=<exit> mod=<exit> errors=<n>
 *
 * Neither layer is skipped to save time, and `errors=` counts compiler diagnostics across both - de-duplicated, because
 * MSBuild prints each C# error once per failing project and once again in its summary, and a failed layer that printed
 * no diagnostic is named separately (`head_build_failed_without_a_diagnostic`), because `errors=0` beside a non-zero
 * exit is the reading that makes a reader trust the wrong half.
 *
 * THE HOST LAYER'S DEPENDENCIES ARE JUNCTIONED, NOT INSTALLED. A bare worktree has no `node_modules`, and a fresh
 * `pnpm install` costs minutes and a package source; the two entries `tsc` resolves are junctioned from this checkout
 * (`node_modules`, `host/node_modules`), as `tools/new-lane-worktree.mjs` documents. What that costs is stated rather
 * than hidden: the compiler and the dependency tree are THIS checkout's, so the layer proves "this commit's sources
 * compile against the installed workspace", not "a fresh install of this commit's lockfile resolves". The Mod layer
 * needs no junction at all: MSBuild restores from the global packages folder.
 *
 * THE FOLDER-PICKER `.dist` PAIR IS NOT NEEDED, and nothing here copies one. That pair is required by the live-run kit's
 * PIN (§4c) because its §4 generation build consumes it. This gate runs neither that phase nor a `dotnet publish`, so a
 * checkout with no `.dist` anywhere still gets both verdicts. The shared cache stays untouched: nothing is written
 * outside the throwaway worktree, and this checkout is never written to.
 *
 * COST, measured 2026-11-25 on this machine with nothing else building: `git worktree add` + removal 3.9 s / 0.4 s, the
 * host layer 9.2-25.5 s depending on how much it has to say, and the Mod layer 83.2 s cold (30 projects). The combined
 * reading is therefore ~100 s - more than L0's whole rung and comparable to `prelive` L2's own 84 s Host artifact build,
 * which is why it is a rung of its own (`l2b`, after `l2`) rather than a member of the millisecond rung, and why
 * `--skip-compile` skips it with that flag's own meaning ("do not pay a compile"). Every run says which of the two it
 * did: a skipped rung prints `not measured: --skip-compile`.
 *
 * WHAT WOULD MAKE THIS VACUOUS, and what stops each - the list is the gate:
 *
 *   * reading the working tree (the defect itself): a detached worktree at the resolved sha, plus the two proofs above;
 *     and the Mod authority is spawned from the worktree, so it reads the commit's project list rather than the lane's;
 *   * one layer's green standing for the tree: both layers always run, the pair carries both exit codes, and a layer
 *     that could not run is `not measured` with its reason - never a zero;
 *   * a stale `bin/`/`obj/` from a shared root masking a failure: the worktree is new and both are gitignored, so a
 *     failing commit starts from no build output at all;
 *   * a hung build reported as a pass: each layer has a deadline, a layer that hits it FAILS with
 *     `head_build_layer_timeout:<layer>:<ms>`, and the layer's whole tree is then killed by its exact pid
 *     (`taskkill /T`), because `spawnSync`'s own deadline reaches only the process it started: measured 2026-11-25, the C#
 *     layer at `1fbfac9b` outlived a ten-minute deadline that way (its grandchild held the output pipe) and left two
 *     `check-csharp-compile` processes behind, so the layer's output now goes to a FILE, which has no reader to wait for;
 *   * a run that measured nothing exiting 0: a reading with no layer verdict is `head_build_blocked`, exit 2;
 *   * a leftover worktree (disk, and a stale registration): `finally` removes the junctions and then the worktree on
 *     every path, including a layer that threw or was killed by its deadline, and a removal that fails is named
 *     (`head_build_worktree_left`) with exit 2 rather than swallowed. A HARD kill (TerminateProcess, `kill -9`) cannot
 *     run any JavaScript and is the one case this cannot cover; each run owns a pid-named path and refuses to reuse an
 *     existing one, so a leftover from such a kill can never be measured by the next run.
 *
 * NOT MEASURED is its own word, on its own line, and it is what an environment gap prints:
 *
 *   head_build_mod_skipped: <reason>     this commit has no `gates/stardew/check-csharp-compile.mjs` (very old refs), or
 *                                        `dotnet` is not on PATH; the Mod was not compiled here.
 *   head_build_host_skipped: <reason>    `host/node_modules/typescript` is absent from this checkout.
 *   head_build_blocked: <code> - <detail>   the reading could not be taken at all (no git, an unresolvable ref, an
 *                                        unclean worktree, a path already in use). Exit 2.
 *
 * Each of the first two is a `*_skipped:` line, the marker `tools/prelive.mjs` and
 * `gates/meta/check-ci-coverage.mjs` both read as "measured nothing": the run is counted apart from a pass instead of
 * becoming one.
 *
 * USAGE:
 *   node gates/arch/check-head-build.mjs                       # HEAD, both layers
 *   node gates/arch/check-head-build.mjs --rev 8264f967         # any commit, same two layers
 *   node gates/arch/check-head-build.mjs --worktree D:/scratch/hb --keep   # a chosen path, and do not remove it
 *
 * `GAMEBUDDY_HEAD_BUILD_DIR` puts the throwaway worktree somewhere other than the system temporary directory (a machine
 * whose `C:` is full points it at another drive).
 *
 * PINS, read by this gate on 2026-11-25 (the pair is the verdict, and a green host beside a red Mod is the reading no rung
 * could report):
 *
 *   head_build ref=8264f9678d47 host=2 mod=1 errors=16
 *   head_build ref=f6ea803ae89c host=2 mod=1 errors=9
 *   head_build ref=cdf24e8588c3 host=0 mod=1 errors=8
 *   head_build ref=29f9bd8615cd host=0 mod=0 errors=0
 *
 * The first three were read while the product working tree compiled in both languages, which is the defect. The fourth is
 * the same gate green, on the commit that landed the Mod half of the repair (`6018801f` moved the destination search to
 * the Host and left its only call site on the Mod): the reading can pass, so it is a rung rather than a standing red.
 *
 * red-proof: history  `8264f967` -> `head_build ref=8264f9678d47 host=2 mod=1 errors=16`: eight host diagnostics beside
 *   eight C# project failures, the pair a single reading would have collapsed into "red" without saying which layer
 * red-proof: history  `f6ea803a` -> `head_build ref=f6ea803ae89c host=2 mod=1 errors=9`: both layers red at one commit
 *   while the working tree that supplied the missing host declaration was green, which is the defect this gate exists for
 * red-proof: history  `cdf24e85` -> `head_build ref=cdf24e8588c3 host=0 mod=1 errors=8`: a host-green commit whose Mod
 *   does not compile
 * red-proof: history  `29f9bd86` -> `head_build ref=29f9bd8615cd host=0 mod=0 errors=0`, exit 0: the same gate green on
 *   the first commit whose committed bytes build in both languages
 * red-proof: inject  a green host layer beside a red Mod layer -> `host=0 mod=1 errors=1` and exit 1, on real `git init`
 *   repositories through the gate's own code (gates/arch/check-head-build.test.mjs)
 * red-proof: inject  a layer whose child outlives its deadline -> `head_build_layer_timeout:mod:300ms`, the layer failed,
 *   and the worktree is gone; a layer that throws -> `head_build_threw` with the same clean path
 * red-proof: inject  a worktree whose `status --porcelain` is not empty -> `head_build_worktree_not_clean`, exit 2: the
 *   commit's bytes are never measured
 */

// source-invariant: reads no file of this tree's source - openSync/readFileSync below are the CHILD's output log
// source-expiry: when spawnSync can bound a whole process tree on this platform, the log file stops being the fix here

export const gateDeclaration = {
  id: "check-head-build",
  domain: "arch",
  tier: "l2",
  kind: "contract",
};

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot as findRepositoryRoot } from "../../tools/lib/repository-root.mjs";
import { cleanOutputLines } from "../../tools/lib/subprocess-output.mjs";

const REPOSITORY_ROOT = findRepositoryRoot(import.meta.url);

/** The two layers' own inputs, declared here so a moved project is one edit and the header cannot drift from the code. */
export const HOST_TYPESCRIPT = "host/node_modules/typescript/lib/tsc.js";
export const HOST_PROJECT = "host/tsconfig.json";

/**
 * The Mod side's ONE compile authority, which this gate runs rather than restating.
 *
 * `gates/stardew/check-csharp-compile.mjs` owns the project population (`git ls-files '*.csproj'`), the four documented
 * exclusions with their cost, and the rule that a `CS####` diagnostic is committed source that does not compile. What it
 * has never had is a home in the ladder, and what it cannot do on its own is read a COMMIT - it builds the tree it lives
 * in, which is the blind spot. Run from inside this gate's worktree it builds the commit, and there is still exactly one
 * spelling of "which C# projects exist and how each is judged".
 */
export const MOD_GATE = "gates/stardew/check-csharp-compile.mjs";

/** A layer that has not finished in ten minutes has not measured anything a reader can act on. */
export const LAYER_TIMEOUT_MS = 10 * 60_000;

const MAX_OUTPUT = 32 * 1024 * 1024;

/** A TypeScript diagnostic carries `error TS####`; a C# one carries `error CS####`, in any locale. */
const HOST_DIAGNOSTIC = /(?:^|\s)error TS\d+/u;
const MOD_DIAGNOSTIC = /error CS\d{4}/u;

const usage = "usage: node gates/arch/check-head-build.mjs [--rev <rev>] [--worktree <dir>] [--keep]";

/**
 * The two layers, as data. Each names the program that decides it, and the Mod layer's program is the tree's existing
 * compile authority rather than a second `dotnet build` invocation: the argument is a path relative to the worktree, so
 * the gate runs from the commit's own copy.
 */
export function buildLayers() {
  return [
    {
      name: "host",
      command: process.execPath,
      args: [HOST_TYPESCRIPT, "--project", HOST_PROJECT, "--noEmit"],
      diagnostic: HOST_DIAGNOSTIC,
      skipReason: (root) =>
        existsSync(join(root, HOST_TYPESCRIPT)) ? null : `${HOST_TYPESCRIPT} is not in this checkout`,
    },
    {
      name: "mod",
      command: process.execPath,
      args: [MOD_GATE],
      diagnostic: MOD_DIAGNOSTIC,
      skipReason: (root) => (existsSync(join(root, MOD_GATE)) ? null : `${MOD_GATE} is not in this commit`),
    },
  ];
}

/**
 * Kill the layer's whole tree, by the one PID `spawnSync` reports: `taskkill /T` on an exact pid (never a name), and a plain
 * signal elsewhere. `spawnSync`'s own deadline reaches only the process it started, and a build that leaves workers behind
 * survives it - which is how the deadline became a hang instead of a verdict.
 */
function killTree(pid) {
  if (typeof pid !== "number") return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** `git` in one place, so every reading below is the same call and a failure is a value rather than a throw. */
export function gitRunner({ root = REPOSITORY_ROOT } = {}) {
  return (args, cwd = root) => {
    const outcome = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: MAX_OUTPUT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: typeof outcome.status === "number" ? outcome.status : 1,
      stdout: outcome.stdout ?? "",
      stderr: outcome.stderr ?? "",
      error: outcome.error ?? null,
    };
  };
}

/** A junction is removed with `unlink`, never recursively: recursion through a reparse point deletes the real tree. */
function removeJunction(path) {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to unlink: never created, or already gone.
  }
}

/** The reason this reading could not be taken, in the one word the caller reads. */
const blocked = (code, detail) => ({ blocked: { code, detail } });

/** A reading that did not happen: never a pass, and exit 2 at the CLI, whatever the cause. */
const blockedReading = (rev, code, detail) => ({ status: "blocked", rev, layers: [], errors: 0, code, detail });

/** Resolve `rev` to a commit sha, or say why not. */
export function resolveCommit({ rev = "HEAD", git = gitRunner() } = {}) {
  const outcome = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  const sha = outcome.stdout.trim();
  if (outcome.status !== 0 || sha === "")
    return blocked("head_build_ref_unresolved", `${rev} does not resolve to a commit (${firstLine(outcome)})`);
  return { sha };
}

/**
 * The two proofs that the worktree holds the commit and nothing else.
 *
 * A `git worktree add --detach` is clean by construction, which is exactly why an unclean one has to be refused: it means
 * something wrote into it (a shared build root, a copied `node_modules`, another lane's overlay) and the reading would
 * then be about those bytes. `rev-parse HEAD` is the second half: a path that exists and holds a DIFFERENT commit is the
 * same defect with a clean status.
 */
export function worktreeBlockedReason({ git, worktree, revision }) {
  const head = git(["rev-parse", "HEAD"], worktree);
  const resolved = head.stdout.trim();
  if (resolved !== revision)
    return blocked(
      "head_build_worktree_wrong_revision",
      `${worktree} is at ${resolved || "(unreadable)"}, not ${revision}`,
    );
  const porcelain = cleanOutputLines(git(["status", "--porcelain"], worktree).stdout).filter((line) => line !== "");
  if (porcelain.length > 0)
    return blocked(
      "head_build_worktree_not_clean",
      `${porcelain.length} path(s) differ from the commit, so these are not its bytes: ${porcelain.slice(0, 3).join(" · ")}`,
    );
  return null;
}

/** The first non-empty line of a child's output, capped: what a reader needs from a git refusal. */
function firstLine(outcome) {
  const line = cleanOutputLines(`${outcome.stderr ?? ""}${outcome.stdout ?? ""}`).find((entry) => entry !== "");
  return line === undefined ? "(it printed nothing)" : line.slice(0, 200);
}

/**
 * One layer, run once.
 *
 * `outcome` has three values and they are not two: `not_measured` is the environment refusing (no compiler, no game
 * folder), `failed` is the commit refusing, `passed` is the compiler agreeing. Only the last two say anything about the
 * commit, which is why `not_measured` never becomes a zero.
 */
export function runLayer({ layer, root, run = spawnSync, timeoutMs = LAYER_TIMEOUT_MS, logDirectory = tmpdir() }) {
  const skipReason = layer.skipReason?.(root) ?? null;
  if (skipReason !== null)
    return {
      name: layer.name,
      outcome: "not_measured",
      exitCode: null,
      ms: 0,
      diagnostics: [],
      notCovered: [],
      tail: [],
      reason: skipReason,
    };
  // The child's output goes to a FILE, not a pipe, and that is load-bearing: `spawnSync` waits for its pipes to close, so a
  // build whose grandchildren inherit them keeps this call alive long after the deadline killed the process it started.
  // Measured 2026-11-25: the C# layer at `1fbfac9b` outlived its ten-minute deadline by four minutes that way, and left
  // two `check-csharp-compile` processes behind. A file has no such reader to wait for.
  const logPath = join(logDirectory, `head-build-${layer.name}-${process.pid}.log`);
  const descriptor = openSync(logPath, "w");
  const startedAt = Date.now();
  let outcome;
  try {
    outcome = run(layer.command, layer.args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      stdio: ["ignore", descriptor, descriptor],
    });
  } finally {
    closeSync(descriptor);
  }
  const ms = Date.now() - startedAt;
  let captured = "";
  try {
    captured = readFileSync(logPath, "utf8");
  } finally {
    rmSync(logPath, { force: true });
  }
  const lines = cleanOutputLines(captured).filter((line) => line !== "");
  // One diagnostic per fact: MSBuild prints each C# error once per failing project and once again in its summary, so the
  // same line arrives twice and `errors=` would then count four for two. The text carries file, line and code, so two
  // identical lines are one diagnostic reported twice rather than two findings.
  const diagnostics = [...new Set(lines.filter((line) => layer.diagnostic.test(line)))];
  // What the layer DECLARES it did not cover: the C# authority prints one line per project it excluded, with the cost,
  // and a reader of this gate's output has to see that the population it measured was narrower than the tree.
  const notCovered = lines.filter((line) => /_excluded:/u.test(line));
  const base = { name: layer.name, ms, diagnostics, notCovered, tail: lines.slice(-3) };
  if (outcome.error?.code === "ENOENT")
    return { ...base, outcome: "not_measured", exitCode: null, reason: `\`${layer.command}\` is not on PATH here` };
  if (outcome.error?.code === "ETIMEDOUT") {
    killTree(outcome.pid);
    return {
      ...base,
      outcome: "failed",
      exitCode: null,
      reason: `head_build_layer_timeout:${layer.name}:${timeoutMs}ms`,
    };
  }
  const exitCode = typeof outcome.status === "number" ? outcome.status : 1;
  return { ...base, outcome: exitCode === 0 ? "passed" : "failed", exitCode };
}

/** Every layer's verdict, in the order they are declared: nothing is skipped to save time. */
function readLayers({ layers, root, run, timeoutMs }) {
  return layers.map((layer) => runLayer({ layer, root, run, timeoutMs }));
}

/** The pair, with `not_measured` written as that word rather than as a zero. */
function verdictOf(layers, name) {
  const layer = layers.find((entry) => entry.name === name);
  if (layer === undefined) return "absent";
  if (layer.outcome === "not_measured") return "not_measured";
  return String(layer.exitCode);
}

export function junctionPlan({ worktree, root = REPOSITORY_ROOT }) {
  return [
    { link: join(worktree, "node_modules"), target: join(root, "node_modules") },
    { link: join(worktree, "host", "node_modules"), target: join(root, "host", "node_modules") },
  ].filter((entry) => existsSync(entry.target));
}

/** The verdict, from the two layer readings: any failure is a failure, and no layer verdict at all is blocked. */
function verdictFor(read, errors) {
  const measured = read.filter((layer) => layer.outcome !== "not_measured");
  if (read.some((layer) => layer.outcome === "failed")) return { status: "failed", layers: read, errors };
  if (measured.length === 0)
    return {
      status: "blocked",
      layers: read,
      errors,
      code: "head_build_nothing_measured",
      detail: `no layer produced a verdict: ${read.map((layer) => `${layer.name}: ${layer.reason}`).join(" · ")}`,
    };
  return { status: "passed", layers: read, errors };
}

/** One reading inside a worktree that already exists: add it, prove it is the commit, run both layers there. */
function measureCommit({ git, run, layers, timeoutMs, root, worktree, revision, rev }) {
  const added = git(["worktree", "add", "--detach", worktree, revision], root);
  if (added.status !== 0)
    return blockedReading(rev, "head_build_worktree_add_failed", `${firstLine(added)} (path ${worktree})`);
  for (const entry of junctionPlan({ worktree, root })) {
    mkdirSync(dirname(entry.link), { recursive: true });
    symlinkSync(entry.target, entry.link, "junction");
  }
  const refused = worktreeBlockedReason({ git, worktree, revision });
  if (refused !== null) return blockedReading(rev, refused.blocked.code, refused.blocked.detail);
  const read = readLayers({ layers: layers ?? buildLayers(), root: worktree, run, timeoutMs });
  const errors = read.reduce((total, layer) => total + layer.diagnostics.length, 0);
  return { ...verdictFor(read, errors), rev, revision, worktree };
}

/**
 * The reading, end to end. Returns data and never prints: the CLI renders it, so a falsifier asserts the same values the
 * operator reads.
 *
 * `finally` covers the layer that threw and the layer its deadline killed, because both leave the worktree behind. The
 * one case no JavaScript can cover is a hard kill of THIS process; each run owns a pid-named path and refuses to reuse
 * an existing one, so such a leftover is never measured.
 */
export function runHeadBuild({
  rev = "HEAD",
  worktree = null,
  keep = false,
  container = process.env.GAMEBUDDY_HEAD_BUILD_DIR ?? tmpdir(),
  layers = null,
  timeoutMs = LAYER_TIMEOUT_MS,
  root = REPOSITORY_ROOT,
  git = gitRunner({ root }),
  run = spawnSync,
} = {}) {
  const resolved = resolveCommit({ rev, git });
  if (resolved.blocked !== undefined) return blockedReading(rev, resolved.blocked.code, resolved.blocked.detail);

  const path = worktree ?? join(container, `gb-head-build-${process.pid}`);
  if (existsSync(path))
    return blockedReading(
      rev,
      "head_build_path_in_use",
      `${path} already exists; each run owns a fresh path and this one will not measure somebody else's tree`,
    );
  mkdirSync(dirname(path), { recursive: true });

  let reading = null;
  let leftover = null;
  try {
    reading = measureCommit({ git, run, layers, timeoutMs, root, worktree: path, revision: resolved.sha, rev });
  } catch (error) {
    reading = blockedReading(rev, "head_build_threw", error instanceof Error ? error.message : String(error));
  } finally {
    if (!keep) {
      for (const entry of junctionPlan({ worktree: path, root })) removeJunction(entry.link);
      if (!removeWorktree({ git, worktree: path, root })) leftover = path;
    }
  }
  if (leftover !== null)
    return blockedReading(
      rev,
      "head_build_worktree_left",
      `${leftover} is still on disk after \`git worktree remove --force\` and a prune; the reading above is not ` +
        "reported as a verdict because this run left a tree behind",
    );
  return keep ? { ...reading, kept: true } : reading;
}

const rmdir = (path) => rmSync(path, { recursive: true, force: true, maxRetries: 3 });

/**
 * `git worktree remove --force`, then the directory, then a prune.
 *
 * Measured on this machine's Windows: `worktree remove` can refuse while the administrative record survives, and the next
 * `add` at the same path then only says `already exists` - a sentence that names neither cause nor remedy
 * (`phases/pin.ps1` hit it and prunes for the same reason). So the directory is removed whatever git says, the record is
 * pruned, and the caller is told if the path is still there.
 */
export function removeWorktree({ git, worktree, root = REPOSITORY_ROOT }) {
  const removed = git(["worktree", "remove", "--force", worktree], root);
  if (removed.status !== 0) rmdir(worktree);
  if (existsSync(worktree)) rmdir(worktree);
  git(["worktree", "prune"], root);
  return !existsSync(worktree);
}

/** What the operator reads: the pair first, then each layer's own exit code and diagnostics. */
export function renderReport(report) {
  const lines = [];
  // No pair can be printed when no worktree was read: there is nothing the pair would be about, and a `0` beside it
  // would be the silent pass this gate exists for.
  if (report.revision === undefined) {
    lines.push(`head_build_blocked: ${report.code} - ${report.detail}`);
    lines.push("head_build: blocked - no layer was measured, which is not a pass");
    return { lines, exitCode: 2 };
  }
  lines.push(
    `head_build ref=${report.revision.slice(0, 12)} host=${verdictOf(report.layers, "host")} ` +
      `mod=${verdictOf(report.layers, "mod")} errors=${report.errors}`,
  );
  lines.push(`head_build: examined ${report.layers.length} layer(s) at ${report.revision}`);
  for (const layer of report.layers) {
    if (layer.outcome === "not_measured") {
      lines.push(`head_build_${layer.name}_skipped: ${layer.reason}`);
      continue;
    }
    lines.push(
      `head_build_layer:${layer.name} exit=${layer.exitCode} ${layer.ms}ms diagnostics=${layer.diagnostics.length}`,
    );
    if (layer.outcome === "failed" && layer.diagnostics.length === 0)
      lines.push(
        `head_build_failed_without_a_diagnostic:${layer.name} exit=${layer.exitCode} - ` +
          `${layer.reason ?? "the compiler printed no diagnostic at all"}; | ${layer.tail.join(" | ")}`,
      );
    for (const diagnostic of layer.diagnostics.slice(0, 20)) lines.push(`  | ${diagnostic}`);
    if (layer.diagnostics.length > 20) lines.push(`  | and ${layer.diagnostics.length - 20} more`);
    for (const line of layer.notCovered) lines.push(`  ! ${line}`);
  }
  if (report.status === "blocked") {
    lines.push(`head_build_blocked: ${report.code} - ${report.detail}`);
    return { lines, exitCode: 2 };
  }
  if (report.status === "failed") {
    lines.push("head_build: failed - a working tree that compiles is not evidence about this commit");
    return { lines, exitCode: 1 };
  }
  const skipped = report.layers.filter((layer) => layer.outcome === "not_measured").length;
  lines.push(
    skipped === 0
      ? "head_build: passed - both layers compiled the commit"
      : `head_build: passed for ${report.layers.length - skipped} of ${report.layers.length} layer(s); ` +
          `${skipped} NOT measured here, so this is not a whole-tree green`,
  );
  return { lines, exitCode: 0 };
}

export function parseArguments(argv) {
  const options = { rev: "HEAD", worktree: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep") {
      options.keep = true;
      continue;
    }
    if (argument !== "--rev" && argument !== "--worktree" && argument !== "--game-path")
      throw new Error(`unknown argument: ${argument}\n${usage}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} needs a value\n${usage}`);
    index += 1;
    if (argument === "--rev") options.rev = value;
    else options.worktree = resolve(value);
  }
  return options;
}

export function main(argv, { run = spawnSync, git = gitRunner() } = {}) {
  const options = parseArguments(argv);
  const report = runHeadBuild({
    rev: options.rev,
    worktree: options.worktree,
    keep: options.keep,
    run,
    git,
  });
  const rendered = renderReport(report);
  for (const line of rendered.lines) process.stdout.write(`${line}\n`);
  if (options.keep && report.worktree !== undefined)
    process.stdout.write(`head_build_kept_worktree: ${report.worktree}\n`);
  return rendered.exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
