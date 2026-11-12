// red-proof: inject  raising the budget tolerance from 50 percent to 500 percent -> `✖ the CLI prints the measured
//   cost and the budget it broke` (tools/perf/budget.test.mjs)
/**
 * The budget gate's own checks: the comparison it makes, and the verdict it prints.
 *
 * Nothing here spawns the benchmark suite - that would make a gate test as slow and as noisy as
 * the thing it gates. The comparison is exercised directly, and the printed verdict once through
 * the real CLI against a fixture baseline and a saved suite output.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUDGET_TOLERANCE,
  budgetMicros,
  compare,
  machineAcceptedSkipLine,
  machineComparison,
  machineIdentity,
  machineNotMeasuredLine,
  recordingLine,
  revisionLine,
  worstOfProcesses,
} from "../check-perf-budget.mjs";

const gatePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "check-perf-budget.mjs");

const recorded = { opsPerSecond: 500, perOpMicros: 2 };

test("a case may cost its budget and not one microsecond more", () => {
  const budget = budgetMicros(recorded);
  assert.equal(budget, 2 * (1 + BUDGET_TOLERANCE));

  const atBudget = compare({
    baselineCases: { "case/small": recorded },
    results: [{ id: "case", size: "small", opsPerSecond: 500 / (1 + BUDGET_TOLERANCE), perOpMicros: budget }],
  });
  assert.deepEqual(atBudget.slow, []);

  const overBudget = compare({
    baselineCases: { "case/small": recorded },
    results: [{ id: "case", size: "small", opsPerSecond: 250, perOpMicros: budget + 0.01 }],
  });
  assert.equal(overBudget.slow.length, 1);
  assert.equal(overBudget.slow[0].key, "case/small");
  assert.equal(overBudget.slow[0].budget, budget);
});

test("a case with no budget, a budget with no case, and a case measured twice are all failures", () => {
  const result = compare({
    baselineCases: { "gone/large": recorded },
    results: [
      { id: "new", size: "small", opsPerSecond: 500, perOpMicros: 2 },
      { id: "new", size: "small", opsPerSecond: 500, perOpMicros: 2 },
    ],
  });
  assert.deepEqual(result.unrecorded, ["new/small"]);
  assert.deepEqual(result.duplicates, ["new/small"]);
  assert.deepEqual(result.missing, ["gone/large"]);
});

test("the CLI prints the measured cost and the budget it broke", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-gate-"));
  try {
    await mkdir(join(root, "tools", "perf"), { recursive: true });
    const baseline = {
      note: "fixture",
      revision: "fixture",
      machine: machineIdentity(),
      tolerance: BUDGET_TOLERANCE,
      recording: { statistic: "worst", processes: 3 },
      cases: { "journal.write/large": recorded },
    };
    await writeFile(join(root, "tools", "perf", "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
    const resultsPath = join(root, "results.txt");
    await writeFile(
      resultsPath,
      `PERF_RESULT ${JSON.stringify({ id: "journal.write", size: "large", opsPerSecond: 200, perOpMicros: 5 })}\n`,
    );

    let failure;
    try {
      execFileSync(process.execPath, [gatePath, "--root", root, "--results", resultsPath], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 1, "a case past its budget must fail the gate");
    assert.match(failure.stdout, /perf_budget_failed compared=1 slow=1/u);
    assert.match(failure.stdout, /journal\.write\/large measured 200 ops\/s 5 µs\/op, budget 3\.00 µs\/op/u);
    // The budget in front of the case is a worst-of-3 one, and the run says so before it measures.
    assert.match(
      failure.stdout,
      /^perf_budget_baseline_recording: each budget is 1\.5x the worst of 3 independent benchmark processes$/mu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a baseline whose revision sits ahead of HEAD, or beside it, says which it is", () => {
  assert.match(
    revisionLine("abc1234", { ahead: 3, behind: 0 }),
    /^perf_budget_baseline_ahead: baseline revision abc1234 is 3 commits ahead of HEAD; /u,
  );
  assert.match(
    revisionLine("abc1234", { ahead: 2, behind: 5 }),
    /^perf_budget_baseline_diverged: baseline revision abc1234 is 5 commits behind and 2 commits ahead of HEAD; /u,
  );
});

test("the gate names how far the baseline is from HEAD, and that distance never decides the verdict", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-revision-"));
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=perf gate", "-c", "user.email=perf@example.invalid", ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "the revision the numbers were recorded at");
    const recordedRevision = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "a commit since");
    const headRevision = git("rev-parse", "HEAD");

    await mkdir(join(root, "tools", "perf"), { recursive: true });
    const resultsPath = join(root, "results.txt");
    await writeFile(
      resultsPath,
      `PERF_RESULT ${JSON.stringify({ id: "journal.write", size: "large", opsPerSecond: 500, perOpMicros: 2 })}\n`,
    );
    const writeBaseline = (revision) =>
      writeFile(
        join(root, "tools", "perf", "baseline.json"),
        `${JSON.stringify(
          {
            note: "fixture",
            revision,
            machine: machineIdentity(),
            tolerance: BUDGET_TOLERANCE,
            cases: { "journal.write/large": recorded },
          },
          null,
          2,
        )}\n`,
      );
    const run = () =>
      execFileSync(process.execPath, [gatePath, "--root", root, "--results", resultsPath], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

    // In budget on every reading: the verdict below is about the revision line, not a regression.
    await writeBaseline(recordedRevision);
    const behind = run();
    assert.match(
      behind,
      new RegExp(
        `^perf_budget_baseline_behind: baseline revision ${recordedRevision} is 1 commit behind HEAD; ` +
          "the numbers below describe that older code",
        "mu",
      ),
    );
    assert.match(behind, /^perf_budget_ok /mu, "a lagging baseline is a report, not a failure");
    // A baseline written before recordings existed is one best-of-5 reading, and the run says so.
    assert.match(behind, /^perf_budget_baseline_recording: none, /mu);

    await writeBaseline(headRevision);
    const current = run();
    assert.match(
      current,
      new RegExp(
        `^perf_budget_baseline_current: baseline revision ${headRevision} is HEAD; ` +
          "the numbers below were recorded at this revision$",
        "mu",
      ),
    );
    assert.match(current, /^perf_budget_ok /mu);

    await writeBaseline("0000000");
    const unknown = run();
    assert.match(unknown, /^perf_budget_baseline_unknown: baseline revision 0000000 is not a commit in this clone,/mu);
    assert.match(unknown, /^perf_budget_ok /mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const elsewhere = { platform: "linux", arch: "arm64", processors: 8, cpuModel: "Some Other CPU @ 2.00GHz" };

test("a baseline from another machine is a named non-comparison, not a comparison", () => {
  assert.equal(machineComparison(machineIdentity(), machineIdentity()), undefined, "the recording machine compares");

  const comparison = machineComparison(elsewhere, machineIdentity());
  assert.equal(comparison.code, "machine_identity_changed");
  // The population the run never touched is in the line: `compared=0` beside the cases the baseline holds.
  assert.match(
    machineNotMeasuredLine({ comparison, recordedCases: 12 }),
    /^perf_budget_not_measured:machine_identity_changed:linux\/arm64\/8 cpus\/Some Other CPU @ 2\.00GHz:win32\//u,
  );
  assert.match(machineNotMeasuredLine({ comparison, recordedCases: 12 }), / compared=0 recorded=12$/u);
  // The accepted skip states the same population, so a decision never renames itself a comparison.
  assert.match(
    machineAcceptedSkipLine({ comparison, recordedCases: 12 }),
    /^perf_budget_skipped: baseline recorded on linux\/arm64\/8 cpus\/Some Other CPU @ 2\.00GHz, measured on /u,
  );
  assert.match(machineAcceptedSkipLine({ comparison, recordedCases: 12 }), /, compared=0 recorded=12$/u);
});

test("a baseline recorded before machines were recorded cannot be compared either", () => {
  const comparison = machineComparison(undefined, machineIdentity());
  assert.equal(comparison.code, "machine_identity_unrecorded");
  assert.match(
    machineNotMeasuredLine({ comparison, recordedCases: 12 }),
    /^perf_budget_not_measured:machine_identity_unrecorded:unrecorded:/u,
  );
  assert.match(
    machineAcceptedSkipLine({ comparison, recordedCases: 12 }),
    /^perf_budget_skipped: baseline predates the machine identity, measured on /u,
  );
});

test("the CLI fails on another machine's baseline, and exits 0 only when the skip is asked for", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-skip-"));
  try {
    await mkdir(join(root, "tools", "perf"), { recursive: true });
    const baseline = {
      note: "fixture",
      revision: "fixture",
      machine: elsewhere,
      tolerance: BUDGET_TOLERANCE,
      cases: { "journal.write/large": recorded },
    };
    await writeFile(join(root, "tools", "perf", "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
    // Over budget by any reading: if the gate compared this, it would exit 1 for the regression instead.
    const resultsPath = join(root, "results.txt");
    await writeFile(
      resultsPath,
      `PERF_RESULT ${JSON.stringify({ id: "journal.write", size: "large", opsPerSecond: 20, perOpMicros: 50 })}\n`,
    );
    const run = (...args) => {
      try {
        return {
          status: 0,
          stdout: execFileSync(process.execPath, [gatePath, "--root", root, "--results", resultsPath, ...args], {
            encoding: "utf8",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        };
      } catch (error) {
        return { status: error.status, stdout: error.stdout ?? "" };
      }
    };

    // The default reading of a machine that cannot compare: blocked, named, and nothing compared.
    const blocked = run();
    assert.equal(blocked.status, 1, "a run that compared nothing must not exit 0");
    assert.match(
      blocked.stdout,
      /^perf_budget_not_measured:machine_identity_changed:linux\/arm64\/8 cpus\/Some Other CPU @ 2\.00GHz:win32\/.* compared=0 recorded=1$/mu,
    );
    assert.doesNotMatch(blocked.stdout, /perf_budget_(failed|ok)/u);

    // The explicit opt-in states the same non-comparison and exits 0, which is what CI's gates job asks for.
    const accepted = run("--accept-machine-skip");
    assert.equal(accepted.status, 0);
    assert.match(
      accepted.stdout,
      /^perf_budget_skipped: baseline recorded on linux\/arm64\/8 cpus\/Some Other CPU @ 2\.00GHz, measured on .* compared=0 recorded=1$/mu,
    );
    assert.doesNotMatch(accepted.stdout, /perf_budget_(failed|ok)/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const oneReading = (id, size, perOpMicros, detail) => ({
  id,
  size,
  // Per-op cost is what a budget moves, so ops/sec is derived the way a bench derives it.
  opsPerSecond: Math.round(100000 / perOpMicros) / 100,
  perOpMicros,
  detail,
});

test("a recording keeps each case's worst reading, never its best", () => {
  const worst = oneReading("case", "small", 3, { from: "the third process" });
  const cases = worstOfProcesses([
    new Map([
      ["case/small", oneReading("case", "small", 2, { from: "the first process" })],
      ["other/large", oneReading("other", "large", 11, { from: "the first process" })],
    ]),
    new Map([
      ["case/small", worst],
      ["other/large", oneReading("other", "large", 9, { from: "the second process" })],
    ]),
    new Map([
      ["case/small", oneReading("case", "small", 2.5, { from: "the third process" })],
      ["other/large", oneReading("other", "large", 10, { from: "the third process" })],
    ]),
  ]);

  assert.deepEqual(Object.keys(cases), ["case/small", "other/large"]);
  // ops/sec and detail belong to the worst reading too: a number is one measurement, not a mixture.
  assert.deepEqual(cases["case/small"], {
    opsPerSecond: worst.opsPerSecond,
    perOpMicros: 3,
    detail: { from: "the third process" },
  });
  assert.equal(cases["other/large"].perOpMicros, 11);
});

test("processes that measured different cases are refused, naming the case", () => {
  const both = new Map([
    ["a/small", oneReading("a", "small", 2)],
    ["b/large", oneReading("b", "large", 5)],
  ]);
  assert.throws(
    () => worstOfProcesses([both, new Map([["a/small", oneReading("a", "small", 3)]])]),
    /perf_suite_inconsistent_cases:b\/large/u,
  );
  assert.throws(
    () =>
      worstOfProcesses([
        both,
        new Map([
          ["a/small", oneReading("a", "small", 3)],
          ["b/large", oneReading("b", "large", 6)],
          ["c/small", oneReading("c", "small", 1)],
        ]),
      ]),
    /perf_suite_inconsistent_cases:c\/small/u,
  );
});

test("the gate says whether its budgets are a worst of K processes or one best-of-5", () => {
  assert.equal(
    recordingLine({ statistic: "worst", processes: 3 }),
    "perf_budget_baseline_recording: each budget is 1.5x the worst of 3 independent benchmark processes",
  );
  assert.match(
    recordingLine(undefined),
    /^perf_budget_baseline_recording: none, so each budget is 1\.5x a single best-of-5 reading/u,
  );
});

test("a recording is measured, never copied from a saved output", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-perf-record-"));
  try {
    await mkdir(join(root, "tools", "perf"), { recursive: true });
    const resultsPath = join(root, "results.txt");
    await writeFile(
      resultsPath,
      `PERF_RESULT ${JSON.stringify({ id: "journal.write", size: "large", opsPerSecond: 500, perOpMicros: 2 })}\n`,
    );

    let failure;
    try {
      execFileSync(process.execPath, [gatePath, "--root", root, "--update", "--results", resultsPath], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      failure = error;
    }
    // One saved output is one process's readings; a baseline that claims three processes cannot copy it.
    assert.equal(failure?.status, 2);
    assert.match(failure.stderr, /perf_update_reads_no_saved_results/u);
    assert.equal(statSync(join(root, "tools", "perf", "baseline.json"), { throwIfNoEntry: false }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
