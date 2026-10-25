/**
 * The budget gate's own checks: the comparison it makes, and the verdict it prints.
 *
 * Nothing here spawns the benchmark suite - that would make a gate test as slow and as noisy as
 * the thing it gates. The comparison is exercised directly, and the printed verdict once through
 * the real CLI against a fixture baseline and a saved suite output.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUDGET_TOLERANCE, budgetMicros, compare, machineIdentity, machineSkipLine } from "../check-perf-budget.mjs";

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
    assert.match(failure.stdout, /perf_budget_failed slow=1/u);
    assert.match(failure.stdout, /journal\.write\/large measured 200 ops\/s 5 µs\/op, budget 3\.00 µs\/op/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const elsewhere = { platform: "linux", arch: "arm64", processors: 8, cpuModel: "Some Other CPU @ 2.00GHz" };

test("a baseline from another machine is a stated skip, not a comparison", () => {
  assert.equal(machineSkipLine(machineIdentity(), machineIdentity()), undefined, "the recording machine compares");

  const line = machineSkipLine(elsewhere, machineIdentity());
  assert.match(
    line,
    /^perf_budget_skipped: baseline recorded on linux\/arm64\/8 cpus\/Some Other CPU @ 2\.00GHz, measured on /u,
  );
});

test("a baseline recorded before machines were recorded cannot be compared either", () => {
  const line = machineSkipLine(undefined, machineIdentity());
  assert.match(line, /^perf_budget_skipped: baseline predates the machine identity, measured on /u);
});

test("the CLI skips with both identities instead of failing on another machine's numbers", async () => {
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
    // Over budget by any reading: if the gate compared this, it would exit 1.
    const resultsPath = join(root, "results.txt");
    await writeFile(
      resultsPath,
      `PERF_RESULT ${JSON.stringify({ id: "journal.write", size: "large", opsPerSecond: 20, perOpMicros: 50 })}\n`,
    );

    const stdout = execFileSync(process.execPath, [gatePath, "--root", root, "--results", resultsPath], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(
      stdout,
      /^perf_budget_skipped: baseline recorded on linux\/arm64\/8 cpus\/Some Other CPU @ 2\.00GHz, measured on /mu,
    );
    assert.doesNotMatch(stdout, /perf_budget_(failed|ok)/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
