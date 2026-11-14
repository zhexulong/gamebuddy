#!/usr/bin/env node
/**
 * Replay a gate against a past commit: archive that revision into a tree outside this repository, put
 * today's gate into it, and run the gate the way this repository runs it.
 *
 * WHY (measured 2026-11-14)
 *
 * "This gate fires on the commit that introduced the defect, and not on its parent" is the strongest red
 * proof this tree has, and every one of them was built by hand: `git archive <rev> | tar -x` into a temp
 * tree, copy the gate plus the libraries it imports, run the suite, quote the finding. It was done four
 * times in one night by four agents; three of them lost an afternoon to it, and two of those to the same
 * two steps: an invocation the repository does not use (a plain `node --test x.mjs` where the registered
 * command is `node --test --import tsx ...`) reads as a confident false negative, and a tree with no
 * `node_modules` crashes in a way that is easy to report as "the gate did not fire". The reading lives in
 * chat logs instead of in a command, so it has to be rebuilt - and re-derived wrongly - every time.
 *
 * WHAT IT DOES
 *
 *   1. `git archive <rev> | tar -x -C <temp>` into a directory OUTSIDE this repository. An ignored temp
 *      directory inside the repository is not enough: the tree being measured must not be the tree the
 *      tool lives in, or a gate that reads its own checkout measures the wrong thing.
 *   2. Copy the gate's files from the CURRENT worktree, so the gate under test is today's gate, and its
 *      repo-relative imports with it - each one found by the gate's own import statements, never from a
 *      list in this file.
 *   3. Read the invocation out of the script that registers the gate (root or owning workspace
 *      `package.json`), keep its flags, narrow its file list to this gate. It never invents an invocation:
 *      a gate no script names is `not_measured: gate_unregistered`, not `node <path>` on a guess.
 *   4. Run it, read what it printed, and print one verdict per revision.
 *
 * THE THREE ZEROES, kept apart because they are different facts:
 *
 *   fired         the gate reported findings on that tree. The count and the finding lines are printed.
 *   did-not-fire  the gate reported zero findings AND stated a non-empty population (`examined=N`, or a
 *                 test run with at least one passing test). "Nothing to report" needs a population that
 *                 was there to report on, or it says nothing.
 *   not_measured  the run cannot support either claim. The reason is named, never implied:
 *                   gate_unregistered        no registered script runs this gate
 *                   unsupported_runner:<r>   the registered command does not start with `node`
 *                   dependencies_absent:<m>  a bare specifier is not installed, and nothing is installed
 *                                            into the archived tree by design (no `pnpm install` here)
 *                   population_empty         the gate's population was empty - it agrees with itself
 *                   population_unstated      zero findings and no population marker
 *                   findings_unreadable      no `findings=` / JSON report in the output
 *                   run_failed:<code>        the gate threw, crashed, or exited non-zero with zero findings
 *                   run_timeout              the gate outlived the replay's own bound
 *                   exit_code_disagrees      the report says findings and the process claimed success
 *
 * An `--expect fired@294d22ab --expect did-not-fire@294d22ab^` pair turns this into the ablation a
 * reviewer can re-run: exit 0 only when every expectation holds, with the actual verdict beside each one.
 *
 * WHAT IT REFUSES
 *
 *   - No network, no `pnpm install`, no `node_modules` written into the archived tree: this tool never
 *     touches a lockfile. A bare dependency is resolved from the packages the worktree already has
 *     installed (a directory link, named by the gate's own imports); if it is not installed, the verdict
 *     is `dependencies_absent:<module>`, because guessing is the defect this tool exists to stop.
 *   - No writes inside the repository: the trees live in the OS temp directory and are removed unless
 *     `--keep`. `--out` is the caller's own choice of directory for the captured output.
 *   - The only flag added to a registered run is `--test-reporter=tap` for a `node --test` command: it
 *     changes how the run is read, not what is run. The exact argv is printed with every verdict.
 *
 * WINDOWS
 *
 * The archive is streamed from `git archive` into `tar -x -f -`, both spawned directly, so no shell and no
 * PowerShell pipe is between them. `tar` is the bsdtar shipped in `%SystemRoot%\System32`. Verified: 3508
 * files extracted from `294d22ab` on Windows, the same count the tree has.
 *
 * USAGE
 *
 *   node tools/replay-gate-on-history.mjs --gate tools/check-spec-waiver-comments.mjs \
 *     --at 930a031e^ --at 930a031e --expect fired@930a031e^ --expect did-not-fire@930a031e
 *   node tools/replay-gate-on-history.mjs --gate tools/check-spec-waiver-comments.mjs \
 *     --rev-range 930a031e^..930a031e        # the same two revisions; both endpoints are measured
 *   node tools/replay-gate-on-history.mjs --gate dialogue-web/tests/selector-producer-gate.test.mjs \
 *     --at 294d22ab --out .tmp/replay        # keep the captured stdout/stderr per revision
 *
 * `pnpm replay:gate-on-history` is the same command, registered in package.json.
 *
 * `--gate` may be repeated (the check script and its test file); `--expect` then needs one gate, because
 * an expectation about two gates at one revision is an expectation about nothing.
 *
 * red-proof: history  the selector-producer gate replayed on tonight's drawer conversion - `fired`,
 *            8 findings at `294d22ab` against 6 at `294d22ab^`, the two extras being exactly
 *            `surface-navigation.spec.ts:53 attr aria-modal` and `:54 class composed-drawer-backdrop`
 *            (tools/replay-gate-on-history.test.mjs)
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILTINS = new Set(builtinModules);
const SOURCE_SUFFIX = /\.(?:[cm]?[jt]sx?)$/iu;
const GATE_TIMEOUT_MS = 15 * 60_000;
const REPORT_LINES = 12;
const READING_LINES = 5;

// Line-anchored, and never across a newline inside the quotes: a gate that writes `from "..."` inside a
// template or a comment must not contribute a module name. Every specifier here becomes a copy or a link.
const IMPORT_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*(?:with\s*\{[^}\n]*\}\s*)?;?\s*$/gmu,
  /^[ \t]*import\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*;?\s*$/gmu,
  /^[ \t]*import\s*\(\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*\)/gmu,
  /\brequire\s*\(\s*(?:"([^"\n]+)"|'([^'\n]+)')\s*\)/gu,
];

function gitText(args) {
  const result = spawnSync("git", args, { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveRevision(spec) {
  const sha = gitText(["rev-parse", "--verify", "--quiet", `${spec}^{commit}`]);
  if (sha === null) return null;
  return { spec, sha, short: sha.slice(0, 8), subject: gitText(["log", "-1", "--format=%s", sha]) ?? "" };
}

function usage(message) {
  const text =
    `${message}\n\nUsage:\n` +
    "  node tools/replay-gate-on-history.mjs --gate <path> (--at <rev> ... | --rev-range <A..B>)\n" +
    "     [--out <dir>] [--keep] [--expect <fired|did-not-fire|not_measured>@<rev> ...]\n";
  process.stderr.write(text);
  process.exitCode = 2;
}

function parseArguments(argv) {
  const options = { gates: [], at: [], revRange: null, out: null, keep: false, expects: [], problems: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const take = () => {
      if (value === undefined || value.startsWith("--")) {
        options.problems.push(`${flag} needs a value`);
        return null;
      }
      index += 1;
      return value;
    };
    if (flag === "--gate") {
      const read = take();
      if (read !== null) options.gates.push(read);
    } else if (flag === "--at") {
      const read = take();
      if (read !== null) options.at.push(read);
    } else if (flag === "--rev-range") {
      const read = take();
      if (read !== null) options.revRange = read;
    } else if (flag === "--out") {
      const read = take();
      if (read !== null) options.out = read;
    } else if (flag === "--expect") {
      const read = take();
      if (read !== null) options.expects.push(read);
    } else if (flag === "--keep") options.keep = true;
    else options.problems.push(`unknown argument ${flag}`);
  }
  return options;
}

/** The `package.json` files whose scripts may register this gate: its owning workspace, then the root. */
function registrationFiles(gateRel) {
  const found = [];
  let dir = dirname(gateRel);
  while (dir !== "." && dir !== "" && dir !== sep) {
    if (existsSync(join(REPOSITORY_ROOT, dir, "package.json"))) {
      found.push(dir);
      break;
    }
    dir = dirname(dir);
  }
  if (!found.includes(".")) found.push(".");
  return found;
}

function commandSegments(command) {
  return command
    .split(/\s*&&\s*/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/**
 * The argv a registered segment runs, narrowed to one gate file: the runner, every flag and every argument
 * stay where they are; the OTHER test files (and, for a `--test` run, the other test directories) are
 * dropped. `null` when the segment does not name this gate; `{ runner }` alone when it names it through a
 * runner this tool cannot read.
 */
function narrowInvocation(segment, gatePaths) {
  const parts = segment.split(/\s+/u).filter((part) => part !== "");
  const unquote = (token) => token.replace(/^["']|["']$/gu, "").replace(/\\/gu, "/");
  const gateIndex = parts.findIndex((part) => gatePaths.includes(unquote(part)));
  if (gateIndex < 0) return null;
  const runner = unquote(parts[0]);
  if (runner !== "node" && runner !== "nodejs") return { runner: parts[0] };
  const runsTests = parts.includes("--test");
  const argv = [];
  parts.forEach((token, index) => {
    const positional = index > 0 && !token.startsWith("-");
    const path = join(REPOSITORY_ROOT, unquote(token));
    const otherFile = positional && SOURCE_SUFFIX.test(unquote(token)) && index !== gateIndex;
    const otherDirectory =
      positional && runsTests && index !== gateIndex && existsSync(path) && statSync(path).isDirectory();
    if (otherFile || otherDirectory) return;
    argv.push(token);
  });
  const testAt = argv.indexOf("--test");
  if (testAt >= 0 && !argv.some((token) => token.startsWith("--test-reporter"))) {
    argv.splice(testAt + 1, 0, "--test-reporter=tap");
  }
  return { runner, argv };
}

/**
 * Every registered way this gate is run, narrowest first. A command names its file relative to one of
 * three places - the repository root, the `package.json` that owns the script, or the directory a `cd`
 * puts the run in (`cd host && bun test src/x.test.ts`) - so all three are read, and the run's own
 * directory travels with the invocation.
 */
export function registeredInvocations(gateRel) {
  const found = [];
  for (const packageDir of registrationFiles(gateRel)) {
    const packageFile = join(packageDir, "package.json");
    const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, packageFile), "utf8"));
    for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
      let cwdSuffix = "";
      for (const segment of commandSegments(command)) {
        const cd = /^cd\s+(\S+)$/u.exec(segment);
        if (cd !== null) {
          cwdSuffix = cd[1].replace(/\\/gu, "/");
          continue;
        }
        const cwdDir = relative(".", join(packageDir, cwdSuffix)).replace(/\\/gu, "/").replace(/^\.$/u, ".");
        const gatePaths = [
          gateRel,
          relative(packageDir, gateRel).replace(/\\/gu, "/"),
          relative(join(packageDir, cwdSuffix), gateRel).replace(/\\/gu, "/"),
        ];
        const invocation = narrowInvocation(segment, gatePaths);
        if (invocation === null) continue;
        found.push({
          packageDir,
          cwdDir: cwdDir === "" ? "." : cwdDir,
          packageFile: packageFile === "." ? "package.json" : `${packageFile.replace(/\\/gu, "/")}`,
          script,
          command,
          segment,
          runner: invocation.runner,
          argv: invocation.argv ?? null,
          dropped: Array.isArray(invocation.argv) ? segment.split(/\s+/u).length - invocation.argv.length : 0,
        });
      }
    }
  }
  return found.sort(
    (left, right) =>
      left.dropped - right.dropped ||
      left.command.length - right.command.length ||
      left.script.localeCompare(right.script),
  );
}

export function specifiersOf(source) {
  const specifiers = new Set();
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isBuiltin(specifier) {
  return specifier.startsWith("node:") || BUILTINS.has(specifier);
}

function worktreeFileExists(repoRelative) {
  return existsSync(join(REPOSITORY_ROOT, repoRelative));
}

/** The repo-relative path a relative specifier names, trying the extensions this tree omits. */
function relativeImportPath(fromDir, specifier) {
  const candidates = [
    specifier,
    `${specifier}.mjs`,
    `${specifier}.js`,
    `${specifier}.cjs`,
    `${specifier}.ts`,
    `${specifier}.tsx`,
    `${specifier}/index.mjs`,
  ];
  for (const candidate of candidates) {
    const resolved = relative(REPOSITORY_ROOT, resolve(join(REPOSITORY_ROOT, fromDir), candidate));
    if (!resolved.startsWith("..") && worktreeFileExists(resolved)) return resolved;
  }
  return null;
}

/**
 * The installed copy of a package in the worktree, searched the way Node resolves it: from the importing
 * file's directory upward through each `node_modules`, and through pnpm's hoisted `.pnpm/node_modules`
 * beside it - a package this workspace does not depend on directly still resolves there.
 */
function installedPackagePath(fromDir, packageName) {
  let dir = fromDir;
  while (true) {
    for (const candidate of [
      join(dir, "node_modules", packageName),
      join(dir, "node_modules", ".pnpm", "node_modules", packageName),
    ]) {
      const absolute = join(REPOSITORY_ROOT, candidate);
      if (existsSync(join(absolute, "package.json"))) return realpathSync(absolute);
    }
    if (dir === "." || dir === "") return null;
    const parent = dirname(dir);
    dir = parent === "." ? "" : parent;
  }
}

/**
 * Copy the gate and its repo-relative imports from the worktree into the archived tree, and link the bare
 * packages it imports from what the worktree already has installed. Never installs anything.
 */
function provisionGate(treeDir, gateFiles, extraModules = [], baseDir = ".") {
  const copied = [];
  const linked = [];
  const missing = [];
  const seen = new Set();
  const queue = gateFiles.map((gateRel) => resolveGatePath(gateRel));
  while (queue.length > 0) {
    const repoRelative = queue.shift();
    if (seen.has(repoRelative)) continue;
    seen.add(repoRelative);
    const source = join(REPOSITORY_ROOT, repoRelative);
    if (!existsSync(source)) {
      missing.push(repoRelative);
      continue;
    }
    const target = join(treeDir, repoRelative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
    copied.push(repoRelative);
    const fromDir = dirname(repoRelative);
    for (const specifier of specifiersOf(readFileSync(source, "utf8"))) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        const imported = relativeImportPath(fromDir, specifier);
        if (imported === null) missing.push(`${repoRelative} -> ${specifier}`);
        else queue.push(imported);
        continue;
      }
      if (linkPackage(treeDir, fromDir, packageNameOf(specifier), linked, missing)) continue;
    }
  }
  for (const specifier of extraModules) {
    if (isBuiltin(specifier)) continue;
    linkPackage(treeDir, baseDir, packageNameOf(specifier), linked, missing);
  }
  return { copied, linked: [...new Set(linked)], missing, late: [] };
}

function linkPackage(treeDir, fromDir, packageName, linked, missing) {
  if (linked.includes(packageName)) return true;
  const installed = installedPackagePath(fromDir, packageName);
  if (installed === null) {
    missing.push(packageName);
    return false;
  }
  const link = join(treeDir, "node_modules", packageName);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(installed, link, process.platform === "win32" ? "junction" : "dir");
  linked.push(packageName);
  return true;
}

function resolveGatePath(gate) {
  const absolute = resolve(process.cwd(), gate);
  const repoRelative = relative(REPOSITORY_ROOT, absolute);
  return repoRelative.startsWith("..") ? gate : repoRelative.replace(/\\/gu, "/");
}

/** The modules a registered command loads through its own flags (`--import tsx`, `--require x`). */
function flaggedModules(argv) {
  const modules = [];
  for (let index = 0; index < (argv?.length ?? 0); index += 1) {
    const token = argv[index];
    if (token === "--import" || token === "--require" || token === "--loader") modules.push(argv[index + 1]);
    else if (token.startsWith("--import=") || token.startsWith("--require=")) modules.push(token.split("=")[1]);
  }
  return modules.filter((module) => typeof module === "string" && /^[@\w]/u.test(module));
}

function extractArchive(revision, treeDir) {
  mkdirSync(treeDir, { recursive: true });
  return new Promise((accept, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", revision.sha], { cwd: REPOSITORY_ROOT });
    const extract = spawn("tar", ["-x", "-f", "-", "-C", treeDir], { stdio: ["pipe", "ignore", "pipe"] });
    const errors = [];
    archive.stderr.on("data", (chunk) => errors.push(String(chunk)));
    extract.stderr.on("data", (chunk) => errors.push(String(chunk)));
    archive.on("error", reject);
    extract.on("error", reject);
    archive.stdout.pipe(extract.stdin);
    archive.on("close", (code) => {
      if (code !== 0) reject(new Error(`git archive failed: ${errors.join("").trim()}`));
    });
    extract.on("close", (code) => {
      if (code !== 0) reject(new Error(`tar -x failed: ${errors.join("").trim()}`));
      else accept(errors.join("").trim());
    });
  });
}

function lastMatchCount(pattern, text) {
  pattern.lastIndex = 0;
  let value = null;
  for (const match of text.matchAll(pattern)) value = Number(match[1]);
  return value;
}

/** A JSON report a gate prints, if it prints one. */
function jsonReport(text) {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed.findings)) {
        return {
          findings: parsed.findings.length,
          population: Number.isFinite(parsed.examined) ? parsed.examined : null,
        };
      }
      if (Number.isFinite(parsed.findings)) {
        return { findings: parsed.findings, population: Number.isFinite(parsed.examined) ? parsed.examined : null };
      }
    } catch {
      // A line that is not JSON is not a report; the next line may still be one.
    }
  }
  return null;
}

/**
 * Verdict for a gate that prints its own report: `findings=<n>` with an `examined=<n>` population, or a
 * JSON report. The process exit code is a cross-check, never the reading.
 */
export function readReportVerdict({ exitCode, stdout, stderr }) {
  const text = `${stdout}\n${stderr}`;
  const missing = missingModuleIn(text);
  if (missing !== null) {
    return {
      verdict: "not_measured",
      reason: `dependencies_absent:${missing.module}`,
      findings: null,
      population: null,
      details: [missing.line],
      reportLine: null,
    };
  }
  const report = jsonReport(text);
  const findings = report?.findings ?? lastMatchCount(/\bfindings=(\d+)/gu, text);
  const population = report?.population ?? lastMatchCount(/\bexamined=(\d+)/gu, text);
  const reportLine =
    stdout
      .split(/\r?\n/u)
      .find((line) => /\bfindings=\d|\{"?findings/u.test(line))
      ?.trim() ?? null;
  if (findings === null) {
    const said = stdout
      .split(/\r?\n/u)
      .concat(stderr.split(/\r?\n/u))
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .slice(-3);
    return {
      verdict: "not_measured",
      reason: "findings_unreadable",
      findings: null,
      population,
      details: said,
      reportLine,
    };
  }
  if (findings > 0) {
    const details = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && line !== reportLine);
    const reported = details.length > 0 || reportLine === null ? details : [reportLine];
    if (exitCode === 0)
      return {
        verdict: "not_measured",
        reason: "exit_code_disagrees",
        findings,
        population,
        details: reported,
        reportLine,
      };
    return { verdict: "fired", findings, population, details: reported, reportLine };
  }
  if (exitCode !== 0) {
    const said =
      `${stderr}`
        .split(/\r?\n/u)
        .find((line) => line.trim() !== "")
        ?.trim() ?? "no output";
    return {
      verdict: "not_measured",
      reason: `run_failed:exit ${exitCode}`,
      findings,
      population,
      details: [said],
      reportLine,
    };
  }
  if (population === null)
    return { verdict: "not_measured", reason: "population_unstated", findings, population, details: [], reportLine };
  if (population === 0)
    return { verdict: "not_measured", reason: "population_empty", findings, population, details: [], reportLine };
  return { verdict: "did-not-fire", findings: 0, population, details: [], reportLine };
}

function tapBlocks(stdout) {
  const blocks = [];
  let current = null;
  let nested = null;
  for (const line of stdout.split(/\r?\n/u)) {
    const failed = /^not ok\s+\d+\s+-\s+(.*)$/u.exec(line);
    if (failed !== null) {
      current = { name: failed[1], fields: new Map(), actual: [] };
      blocks.push(current);
      nested = null;
      continue;
    }
    if (/^ok\s+\d+\s+-/u.test(line)) {
      current = null;
      nested = null;
    } else if (current !== null) {
      const field = /^ {2}([A-Za-z_]+):\s?(.*)$/u.exec(line);
      if (field !== null) {
        const value = field[2].replace(/^'(.*)'$/u, "$1");
        current.fields.set(field[1], value);
        nested = value === "" ? field[1] : null;
      } else if (nested === "actual") {
        const entry = /^ {4}\d+:\s'(.*)'$/u.exec(line);
        if (entry !== null) current.actual.push(entry[1]);
      }
    }
  }
  return blocks;
}

function missingModuleIn(text) {
  const match = /Cannot find (?:package|module) '([^']+)'/u.exec(text);
  if (match === null) return null;
  const line =
    text
      .split(/\r?\n/u)
      .find((candidate) => candidate.includes(match[0]))
      ?.trim() ?? match[0];
  return { module: match[1], line };
}

/** Verdict for a `node --test` run, read from its TAP: an assertion failure is a finding, any other failure is not a reading. */
export function readTestRunVerdict({ exitCode, stdout, stderr }) {
  const text = `${stdout}\n${stderr}`;
  const missing = missingModuleIn(text);
  if (missing !== null) {
    return {
      verdict: "not_measured",
      reason: `dependencies_absent:${missing.module}`,
      findings: null,
      population: null,
      details: [missing.line],
      reportLine: null,
    };
  }
  const tests = lastMatchCount(/^# tests (\d+)$/gmu, stdout);
  const passing = lastMatchCount(/^# pass (\d+)$/gmu, stdout);
  const failures = tapBlocks(stdout).filter((block) => block.fields.get("failureType") === "testCodeFailure");
  const assertions = failures.filter((block) =>
    /ERR_ASSERTION|AssertionError/u.test(`${block.fields.get("code")} ${block.fields.get("name")}`),
  );
  const otherFailures = failures.filter((block) => !assertions.includes(block));
  const readings = stdout
    .split(/\r?\n/u)
    .filter((line) => /^# (?!Subtest:|tests |pass |fail |cancelled |skipped |todo |duration_ms)/u.test(line))
    .map((line) => line.replace(/^#\s*/u, "").trim());
  if (otherFailures.length > 0) {
    const code = otherFailures[0].fields.get("code") ?? otherFailures[0].fields.get("name") ?? "threw";
    return {
      verdict: "not_measured",
      reason: `run_failed:${code}`,
      findings: null,
      population: tests,
      details: otherFailures.map((block) => block.name),
      reportLine: null,
    };
  }
  if (assertions.length === 0) {
    if (exitCode !== 0) {
      const said =
        `${stderr}`
          .split(/\r?\n/u)
          .find((line) => line.trim() !== "")
          ?.trim() ?? "no output";
      return {
        verdict: "not_measured",
        reason: `run_failed:exit ${exitCode}`,
        findings: 0,
        population: tests,
        details: [said],
        reportLine: null,
      };
    }
    if ((tests ?? 0) === 0 || (passing ?? 0) === 0)
      return {
        verdict: "not_measured",
        reason: "population_empty",
        findings: 0,
        population: tests ?? 0,
        details: [],
        reportLine: null,
      };
    return { verdict: "did-not-fire", findings: 0, population: tests, details: [], reportLine: null, readings };
  }
  const collected = assertions.flatMap((block) => block.actual);
  const details = collected.length > 0 ? collected : assertions.map((block) => block.name);
  if (exitCode === 0) {
    return {
      verdict: "not_measured",
      reason: "exit_code_disagrees",
      findings: details.length,
      population: tests,
      details,
      reportLine: null,
    };
  }
  return { verdict: "fired", findings: details.length, population: tests, details, reportLine: null, readings };
}

/** The environment the gate runs in: the repository's own, minus the test-runner context. */
function childEnvironment() {
  const environment = { ...process.env };
  // A `node --test` child that inherits NODE_TEST_CONTEXT writes nothing and exits 0, so a replay started
  // from inside a suite would read an empty run as a clean one.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function runGate(treeDir, invocation) {
  const cwd = join(treeDir, invocation.cwdDir);
  const result = spawnSync(process.execPath, invocation.argv.slice(1), {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: GATE_TIMEOUT_MS,
    env: childEnvironment(),
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    exitCode: result.status ?? (timedOut ? "timeout" : -1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? `${result.error?.message ?? ""}`,
    timedOut,
  };
}

function unlinkCreated(treeDir, packages) {
  for (const packageName of packages) {
    const link = join(treeDir, "node_modules", packageName);
    try {
      rmSync(link, { recursive: false, force: true });
    } catch {
      /* a link that is already gone is the goal */
    }
  }
}

const NOT_RUN = Object.freeze({ exitCode: "-", command: "not run" });

function printVerdict(result, gate) {
  const { revision, run, reading, provisioned, artifacts, treeDir } = result;
  const lines = [`== ${revision.short}  ${revision.subject}`, `   gate: ${gate}`];
  lines.push(
    `   verdict: ${reading.verdict}${reading.findings === null || reading.findings === undefined ? "" : `  findings=${reading.findings}`}` +
      `${reading.population === null || reading.population === undefined ? "" : `  population=${reading.population}`}` +
      `${reading.reason ? `  reason=${reading.reason}` : ""}  exit=${run.exitCode}`,
  );
  lines.push(`   run: ${run.command}`);
  if (provisioned !== undefined) {
    lines.push(
      `   provisioned: ${provisioned.copied.length} worktree file(s), ${provisioned.linked.length} installed package(s)` +
        `${provisioned.missing.length === 0 ? "" : `; unread specifier(s): ${provisioned.missing.join(", ")}`}` +
        `${provisioned.late.length === 0 ? "" : `; linked after the run named it: ${provisioned.late.join(", ")}`}`,
    );
  }
  if (reading.reportLine !== null && reading.reportLine !== undefined) lines.push(`   report: ${reading.reportLine}`);
  for (const line of (reading.readings ?? []).slice(0, READING_LINES)) lines.push(`   reading: ${line}`);
  for (const line of (reading.details ?? []).slice(0, REPORT_LINES)) lines.push(`   finding: ${line}`);
  if (artifacts !== null && artifacts !== undefined) lines.push(`   captured: ${artifacts}`);
  if (treeDir !== null && treeDir !== undefined) lines.push(`   kept: ${treeDir}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function replayRevision({ revision, gateRel, keep, outDir }) {
  const invocation = registeredInvocations(gateRel)[0];
  if (invocation === undefined) {
    return { revision, run: NOT_RUN, reading: { verdict: "not_measured", reason: "gate_unregistered", details: [] } };
  }
  if (invocation.runner !== "node" && invocation.runner !== "nodejs") {
    return {
      revision,
      invocation,
      run: NOT_RUN,
      reading: {
        verdict: "not_measured",
        reason: `unsupported_runner:${invocation.runner}`,
        details: [invocation.command],
      },
    };
  }
  const treeDir = mkdtempSync(join(tmpdir(), "gamebuddy-gate-replay-"));
  const created = { packages: [] };
  try {
    await extractArchive(revision, treeDir);
    const provisioned = provisionGate(treeDir, [gateRel], flaggedModules(invocation.argv), invocation.cwdDir);
    created.packages = provisioned.linked;
    let run = runGate(treeDir, invocation);
    let reading = invocation.argv.includes("--test") ? readTestRunVerdict(run) : readReportVerdict(run);
    // A gate can need a package only at run time - a child process, a dynamic require. The run names it, the
    // worktree has it installed, so link that one and run again; at most three rounds, and a module the
    // worktree does not have keeps the `dependencies_absent` verdict.
    for (let round = 0; round < 3; round += 1) {
      const absent = /^dependencies_absent:(.+)$/u.exec(reading.reason ?? "");
      if (absent === null || run.timedOut) break;
      const moduleName = packageNameOf(absent[1]);
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/u.test(moduleName)) break;
      if (!linkPackage(treeDir, invocation.cwdDir, moduleName, created.packages, [])) break;
      provisioned.late.push(moduleName);
      run = runGate(treeDir, invocation);
      reading = invocation.argv.includes("--test") ? readTestRunVerdict(run) : readReportVerdict(run);
    }
    run.command = `${invocation.argv[0]} ${invocation.argv.slice(1).join(" ")}   (cwd ${invocation.cwdDir}, registration ${invocation.script})`;
    if (run.timedOut) reading = { verdict: "not_measured", reason: "run_timeout", details: [] };
    const artifacts = outDir === null ? null : writeArtifacts(outDir, revision, gateRel, { run, reading, invocation });
    return { revision, invocation, run, reading, artifacts, provisioned, treeDir: keep ? treeDir : null };
  } finally {
    if (!keep) {
      unlinkCreated(treeDir, created.packages);
      rmSync(treeDir, { recursive: true, force: true });
    }
  }
}

function writeArtifacts(outDir, revision, gateRel, { run, reading, invocation }) {
  mkdirSync(outDir, { recursive: true });
  const stem = join(outDir, `${revision.short}.${gateRel.split("/").pop()}`);
  writeFileSync(`${stem}.stdout.txt`, run.stdout);
  writeFileSync(`${stem}.stderr.txt`, run.stderr);
  writeFileSync(
    `${stem}.verdict.json`,
    `${JSON.stringify(
      {
        revision: revision.sha,
        subject: revision.subject,
        gate: gateRel,
        registration: { script: invocation.script, package: invocation.packageFile, argv: invocation.argv },
        exitCode: run.exitCode,
        verdict: reading.verdict,
        reason: reading.reason ?? null,
        findings: reading.findings,
        population: reading.population,
        details: reading.details ?? [],
      },
      null,
      2,
    )}\n`,
  );
  return `${stem}.{stdout,stderr,verdict}.txt|json`;
}

function expansionProblems(options) {
  if (options.gates.length === 0) return "--gate is required";
  if (options.at.length === 0 && options.revRange === null) return "--at <rev> or --rev-range <A..B> is required";
  if (options.at.length > 0 && options.revRange !== null)
    return "--at and --rev-range are two ways to say the same thing; use one";
  if (options.expects.length > 0 && options.gates.length > 1) {
    return "--expect needs one --gate: an expectation about two gates at one revision is an expectation about nothing";
  }
  return options.problems[0] ?? null;
}

function revisionsOf(options) {
  const specs =
    options.revRange === null
      ? options.at
      : [
          options.revRange.split("..")[0],
          ...(gitText(["rev-list", "--reverse", options.revRange]) ?? "").split("\n").filter((sha) => sha !== ""),
        ];
  const revisions = [];
  for (const spec of specs) {
    const revision = resolveRevision(spec);
    if (revision === null) return { problem: `cannot resolve revision ${spec}` };
    if (!revisions.some((known) => known.sha === revision.sha)) revisions.push(revision);
  }
  return { revisions };
}

function expectationResults(expects, results) {
  const outcomes = [];
  for (const expectation of expects) {
    const at = expectation.indexOf("@");
    if (at <= 0) return { problem: `--expect ${expectation} is not <verdict>@<rev>` };
    const wanted = expectation.slice(0, at);
    const spec = expectation.slice(at + 1);
    if (!["fired", "did-not-fire", "not_measured"].includes(wanted)) {
      return { problem: `--expect ${expectation}: verdict must be fired, did-not-fire or not_measured` };
    }
    const revision = resolveRevision(spec);
    if (revision === null) return { problem: `--expect ${expectation}: cannot resolve revision ${spec}` };
    const result = results.find((candidate) => candidate.revision.sha === revision.sha);
    if (result === undefined) return { problem: `--expect ${expectation}: ${revision.short} was not measured` };
    const actual = result.reading.verdict;
    outcomes.push({
      expectation: `${wanted}@${revision.short}`,
      wanted,
      actual,
      held: wanted === actual,
      reason: result.reading.reason ?? null,
    });
  }
  return { outcomes };
}

async function main(argv) {
  const options = parseArguments(argv);
  const problem = expansionProblems(options);
  if (problem !== null) {
    usage(problem);
    return;
  }
  const { revisions, problem: revisionProblem } = revisionsOf(options);
  if (revisionProblem !== undefined) {
    usage(revisionProblem);
    return;
  }
  const gates = options.gates.map((gate) => resolveGatePath(gate));
  const outDir = options.out === null ? null : resolve(process.cwd(), options.out);
  process.stdout.write(`replay-gate-on-history  ${gates.join(", ")}\n`);
  for (const gate of gates) {
    const [chosen, ...others] = registeredInvocations(gate);
    if (chosen === undefined) {
      process.stdout.write(
        `  gate ${gate}: not_measured  reason=gate_unregistered  (no script in a package.json runs this file)\n`,
      );
      continue;
    }
    process.stdout.write(`  registration: ${chosen.script} in ${chosen.packageFile} -> ${chosen.segment}\n`);
    if (chosen.argv !== null)
      process.stdout.write(`  narrowed to: ${chosen.argv.join(" ")}   (cwd ${chosen.packageDir})\n`);
    for (const other of others) process.stdout.write(`  also registered: ${other.script} in ${other.packageFile}\n`);
  }
  process.stdout.write(`  temp trees: ${tmpdir()}  (${options.keep ? "kept" : "removed after each revision"})\n\n`);

  const results = [];
  for (const gate of gates) {
    for (const revision of revisions) {
      const result = await replayRevision({ revision, gateRel: gate, keep: options.keep, outDir });
      results.push(result);
      printVerdict(result, gate);
    }
  }

  if (options.expects.length === 0) {
    const measured = results.filter((result) => result.reading.verdict !== "not_measured");
    process.stdout.write(
      `\n${results.length} revision(s): ${measured.length} measured, ${results.length - measured.length} not_measured\n`,
    );
    process.exitCode = measured.length === results.length ? 0 : 1;
    return;
  }
  const { outcomes, problem: expectationProblem } = expectationResults(options.expects, results);
  if (expectationProblem !== undefined) {
    usage(expectationProblem);
    return;
  }
  for (const outcome of outcomes) {
    process.stdout.write(
      `expectation ${outcome.expectation}  actual=${outcome.actual}${outcome.reason === null ? "" : ` (${outcome.reason})`}  ${outcome.held ? "held" : "VIOLATED"}\n`,
    );
  }
  const violated = outcomes.filter((outcome) => !outcome.held);
  process.stdout.write(
    `${outcomes.length} expectation(s): ${outcomes.length - violated.length} held, ${violated.length} violated\n`,
  );
  process.exitCode = violated.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
