/**
 * The falsifiers for `tools/check-crash-report-containment.mjs`, and the containment proof for the writer it exists
 * to bound.
 *
 * Two halves, because the leak had two halves. The gate must SEE a report wherever it lies and must name the credential
 * it carries without quoting it - that is the reader. The writer is the reason there was anything to read: a machine
 * `NODE_OPTIONS` fires a crash report into the dying process's cwd, so the last case drives two real Node children
 * that throw and shows the report landing inside the tree for the inherited environment and outside it for the
 * environment every child of ours is given.
 *
 * Every case builds its own tree under the OS temp root and removes it, and none of them reads the machine's real
 * `NODE_OPTIONS`: the flags each case needs are stated in the case, so a green run here does not depend on what this
 * machine happens to be configured with.
 *
 * red-proof: inject  `report.1.json` planted in an archived copy of this tree, holding `API_KEY=deadbeef` ->
 *                    `crash_report_inside_repo:report.1.json` and
 *                    `crash_report_carries_a_secret:report.1.json:API_KEY`, exit 1, `deadbeef` never printed
 * red-proof: inject  a report two directories deep and one inside a nested checkout -> the first is named, the second
 *                    is pruned and the prune count says so (tools/check-crash-report-containment.test.mjs)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { credentialNamesIn, judgeScan, scanForCrashReports } from "./check-crash-report-containment.mjs";
import { containedChildEnvironment, containedNodeOptions } from "./lib/crash-report-containment.mjs";

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), "check-crash-report-containment.mjs");
/** A report's real shape, cut to the parts that decide the verdict. The token is not a token. */
const REPORT_BODY = (environment) =>
  JSON.stringify({ header: { event: "uncaughtException", environmentVariables: environment }, javascriptStack: {} });

function withTree(prefix, build) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    build(root);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function plant(root, relative, body) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function runGate(root) {
  const outcome = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  return { status: outcome.status, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" };
}

/** The machine-readable line, read the way the harness reads it: the last JSON object the gate printed. */
function reportLine(stdout) {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .reverse()
    .find((entry) => entry.startsWith("{"));
  assert.ok(line !== undefined, `the gate printed no report line:\n${stdout}`);
  return JSON.parse(line);
}

test("a tree with no report is green, and states the population it examined", () => {
  const root = withTree("gb-containment-clean-", (tree) => {
    plant(tree, "host/src/app.ts", "export const app = 1;\n");
    plant(tree, "dialogue-web/index.html", "<html></html>\n");
    plant(tree, "notes.json", '{"report": "not a crash report"}\n');
  });
  try {
    const outcome = runGate(root);
    assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /examined 3 files, 0 crash reports/u);
    assert.equal(reportLine(outcome.stdout).status, "passed");
    assert.equal(reportLine(outcome.stdout).examined, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a planted report is named with its credential's variable name and never the credential", () => {
  const value = "deadbeefdeadbeefdeadbeef";
  const root = withTree("gb-containment-secret-", (tree) => {
    plant(tree, "report.1.json", REPORT_BODY({ GITHUB_PERSONAL_ACCESS_TOKEN: value, PATH: "C:\\Windows" }));
  });
  try {
    const outcome = runGate(root);
    assert.equal(outcome.status, 1, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /^crash_report_inside_repo:report\.1\.json$/mu);
    assert.match(outcome.stdout, /^crash_report_carries_a_secret:report\.1\.json:GITHUB_PERSONAL_ACCESS_TOKEN$/mu);
    assert.ok(
      !outcome.stdout.includes(value) && !outcome.stderr.includes(value),
      "the gate quoted the credential it found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a report is found at any depth, not only where .gitignore happened to cover it", () => {
  const root = withTree("gb-containment-depth-", (tree) => {
    plant(tree, "dialogue-web/report.20261112.235059.54632.0.001.json", REPORT_BODY({}));
    plant(tree, ".tmp/probe/report.20261112.235100.54633.0.001.json", REPORT_BODY({}));
    plant(tree, "host/src/report.notjson.txt", "unrelated\n");
  });
  try {
    const outcome = runGate(root);
    assert.equal(outcome.status, 1, outcome.stdout + outcome.stderr);
    assert.match(
      outcome.stdout,
      /crash_report_inside_repo:dialogue-web\/report\.20261112\.235059\.54632\.0\.001\.json/u,
    );
    assert.match(
      outcome.stdout,
      /crash_report_inside_repo:\.tmp\/probe\/report\.20261112\.235100\.54633\.0\.001\.json/u,
    );
    // A report that names a credential variable with no value in it is a leak, not a leaked credential.
    assert.ok(!/crash_report_carries_a_secret:/u.test(outcome.stdout), outcome.stdout);
    assert.equal(reportLine(outcome.stdout).crashReports, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the credential shape is a shape, not the four names that were measured", () => {
  const text = REPORT_BODY({
    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_abcdefghijklmnop",
    CPA_OAI_API_KEY: "cpa-0123456789abcdef",
    TAVILY_API_KEY: "tvly-0123456789abcdef",
    ANTHROPIC_API_KEY: "sk-ant-0123456789abcdef",
    DEPLOY_PASSWORD: "correct-horse-battery",
    SESSION_SECRET: "an-entirely-arbitrary-secret",
    API_KEY: "none",
    TOKEN: "",
    HOME_DIR: "/home/player",
    PATH: "C:\\Windows\\system32",
  });
  assert.deepEqual(credentialNamesIn(text), [
    "ANTHROPIC_API_KEY",
    "CPA_OAI_API_KEY",
    "DEPLOY_PASSWORD",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "SESSION_SECRET",
    "TAVILY_API_KEY",
  ]);
  // Values are never part of the answer: a name is what a reader can act on, and the value is the leak itself.
  for (const name of credentialNamesIn(text)) assert.match(name, /^[A-Z][A-Z0-9_]*$/u);
});

test("a scan that read nothing is blocked, never green", () => {
  const root = withTree("gb-containment-empty-", () => {});
  try {
    const outcome = runGate(root);
    assert.equal(outcome.status, 2, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /examined 0 files, 0 crash reports/u);
    assert.match(outcome.stdout, /crash_report_scan_blocked:examined=0/u);
    assert.equal(reportLine(outcome.stdout).status, "blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory the scan could not list blocks the run and names it", async () => {
  const root = withTree("gb-containment-unreadable-", (tree) => {
    plant(tree, "readable/a.txt", "a\n");
  });
  try {
    const scan = await scanForCrashReports(root, {
      list: async (directory) => {
        if (directory.endsWith("readable")) {
          const error = new Error("denied");
          error.code = "EACCES";
          throw error;
        }
        const { readdir } = await import("node:fs/promises");
        return readdir(directory, { withFileTypes: true });
      },
    });
    assert.deepEqual(scan.unreadable, ["readable: EACCES"]);
    const verdict = judgeScan(scan, { readFile: () => "" });
    assert.equal(verdict.status, "blocked");
    assert.deepEqual(verdict.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("another checkout and a dependency tree are pruned, and the counts say so", async () => {
  const root = withTree("gb-containment-pruned-", (tree) => {
    plant(tree, "kept/a.txt", "a\n");
    plant(tree, ".worktrees/stale/.git", "gitdir: /elsewhere\n");
    plant(tree, ".worktrees/stale/report.7.json", REPORT_BODY({}));
    plant(tree, "host/node_modules/pkg/report.8.json", REPORT_BODY({}));
  });
  try {
    const scan = await scanForCrashReports(root);
    assert.deepEqual(scan.reports, []);
    assert.equal(scan.pruned.nestedCheckouts, 1);
    assert.equal(scan.pruned.dependencyTrees, 1);
    // The boundary, stated rather than implied: both pruned trees hold a report this scan does not report.
    assert.equal(scan.examined, 1);
    const outcome = runGate(root);
    assert.match(outcome.stdout, /pruned 1 nested checkout\(s\), 1 dependency tree\(s\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the contained environment drops the reporting switch, aims the directory elsewhere, and keeps the rest", () => {
  const options = containedNodeOptions(
    "--report-on-fatalerror --report-compact --diagnostic-dir=D:/diag --heapsnapshot-near-heap-limit=1 " +
      "--import file:///D:/PiData/agent/diag/memwatch.mjs --max-old-space-size=8192 --report-directory=D:/old",
    "D:/temp/reports",
  );
  assert.equal(
    options,
    "--report-compact --diagnostic-dir=D:/diag --heapsnapshot-near-heap-limit=1 " +
      "--import file:///D:/PiData/agent/diag/memwatch.mjs --max-old-space-size=8192 --report-directory=D:/temp/reports",
  );
  // The preload and the heap ceiling are someone's deliberate configuration and survive; an absent value stays absent.
  assert.equal(containedNodeOptions("", "D:/temp/reports"), "");
  assert.equal(containedNodeOptions(undefined, "D:/temp/reports"), "");
});

test("a child that dies writes its report outside the tree once the environment is contained", () => {
  const root = withTree("gb-containment-child-", () => {});
  const elsewhere = join(root, "reports");
  const cwd = join(root, "checkout");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  const flags = "--report-uncaught-exception --report-compact";
  const spawnArgs = ["-e", "throw new Error('the containment proof dies here')"];
  const spawnOptions = { cwd, encoding: "utf8", timeout: 60_000 };
  const reports = (directory) => readdirSync(directory).filter((name) => /^report\..*\.json$/u.test(name));
  try {
    // The reading this containment exists for: the inherited environment puts the report in the child's own cwd.
    const inherited = { ...process.env, NODE_OPTIONS: flags };
    spawnSync(process.execPath, spawnArgs, { ...spawnOptions, env: inherited });
    assert.equal(reports(cwd).length, 1, "the inherited environment did not write a report into the child's cwd");
    assert.equal(reports(elsewhere).length, 0);

    // The same child, given the environment every child of ours is given: the same report, somewhere else.
    const contained = containedChildEnvironment(inherited, elsewhere);
    assert.equal(contained.SystemRoot, inherited.SystemRoot, "containment dropped an unrelated variable");
    assert.match(contained.NODE_OPTIONS, /--report-directory=/u);
    rmSync(join(cwd, reports(cwd)[0]), { force: true });

    spawnSync(process.execPath, spawnArgs, { ...spawnOptions, env: contained });
    assert.equal(reports(cwd).length, 0, "a contained child still wrote its report inside the tree");
    assert.equal(reports(elsewhere).length, 1, "the contained child's report did not land outside the tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
