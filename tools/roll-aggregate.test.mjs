import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGGREGATE = new URL("./roll-aggregate.mjs", import.meta.url).pathname.replace(/^\/([A-Z]):\//, "$1:/");

/** Regression-plus-behavior wrappers around reading a run's observation. */
function observation({ ladder = "3", promptSha256 = "abc123", turnMs = 120000, actionCount = 12, rejectionRate = 0.08, summaryChars = 60 } = {}) {
  return { schema: "game_ladder_observation/v1", promptSha256, promptOverridden: false, ladder, contextAssembled: true, worldBookAssembled: true, turnMs, actionCount, rejectionRate, receiptCount: 3, summaryChars };
}

function makeRun(options = {}) {
  const { state = "passed", observationOverrides = {} } = options;
  return JSON.stringify({ state, observation: observation(observationOverrides) }, null, 1);
}

async function writeRuns(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
}

async function runAggregate(args) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [AGGREGATE, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("summarizes one group with means and stddevs per metric", async () => {
  const dir = await mkdtemp(join(tmpdir(), "roll-agg-"));
  try {
    await writeRuns(dir, {
      "a.json": makeRun({ observationOverrides: { turnMs: 100000, actionCount: 10, rejectionRate: 0.1 } }),
      "b.json": makeRun({ observationOverrides: { turnMs: 140000, actionCount: 14, rejectionRate: 0.1, summaryChars: 80 } }),
    });
    const { code, stdout } = await runAggregate(["--runs", dir]);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.mode, "runs");
    assert.equal(out.groups.length, 1);
    assert.deepEqual(out.excludedOldRuns, []);
    const g = out.groups[0];
    assert.equal(g.count, 2);
    assert.equal(g.values.gatePassed.mean, 1);
    assert.equal(g.values.turnMs.mean, 120000);
    assert.ok(g.values.turnMs.stddev > 0);
    assert.equal(g.values.rejectionRate.mean, 0.1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("declares improved when the change exceeds the noise window", async () => {
  const base = await mkdtemp(join(tmpdir(), "roll-base-"));
  const changed = await mkdtemp(join(tmpdir(), "roll-changed-"));
  try {
    const baseFiles = {};
    const changedFiles = {};
    for (let i = 0; i < 5; i += 1) {
      baseFiles[`b${i}.json`] = makeRun({ observationOverrides: { rejectionRate: 0.3 + i * 0.01, turnMs: 150000 + i * 1000 } });
      changedFiles[`c${i}.json`] = makeRun({ observationOverrides: { rejectionRate: 0.05 + i * 0.005, turnMs: 90000 + i * 1000 } });
    }
    await writeRuns(base, baseFiles);
    await writeRuns(changed, changedFiles);
    const { code, stdout } = await runAggregate(["--base", base, "--changed", changed]);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    const verdicts = Object.fromEntries(out.verdicts.map((v) => [v.metric, v.verdict]));
    assert.equal(verdicts.gatePassed, "no_conclusion");
    assert.equal(verdicts.rejectionRate, "improved");
    assert.equal(verdicts.turnMs, "improved");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(changed, { recursive: true, force: true });
  }
});

test("declares no_conclusion when the difference sits inside the noise window", async () => {
  const base = await mkdtemp(join(tmpdir(), "roll-base-"));
  const changed = await mkdtemp(join(tmpdir(), "roll-changed-"));
  try {
    const baseFiles = {};
    const changedFiles = {};
    for (let i = 0; i < 5; i += 1) {
      baseFiles[`b${i}.json`] = makeRun({ observationOverrides: { rejectionRate: 0.1 + i * 0.008, turnMs: 120000 + i * 3000 } });
      changedFiles[`c${i}.json`] = makeRun({ observationOverrides: { rejectionRate: 0.1 + i * 0.008, turnMs: 121000 + i * 3000 } });
    }
    await writeRuns(base, baseFiles);
    await writeRuns(changed, changedFiles);
    const { code, stdout } = await runAggregate(["--base", base, "--changed", changed]);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    for (const v of out.verdicts) assert.equal(v.verdict, "no_conclusion");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(changed, { recursive: true, force: true });
  }
});

test("refuses to compare groups with under 3 samples on a metric", async () => {
  const base = await mkdtemp(join(tmpdir(), "roll-base-"));
  const changed = await mkdtemp(join(tmpdir(), "roll-changed-"));
  try {
    await writeRuns(base, { "b0.json": makeRun() });
    await writeRuns(changed, { "c0.json": makeRun() });
    const { code, stdout } = await runAggregate(["--base", base, "--changed", changed]);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    for (const v of out.verdicts) assert.equal(v.verdict, "insufficient_samples");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(changed, { recursive: true, force: true });
  }
});

test("flags group mismatch and excludes old runs without an observation block", async () => {
  const base = await mkdtemp(join(tmpdir(), "roll-base-"));
  const changed = await mkdtemp(join(tmpdir(), "roll-changed-"));
  try {
    await writeRuns(base, { "b0.json": makeRun({ observationOverrides: { ladder: "3", promptSha256: "baseline" } }) });
    await writeRuns(changed, {
      "c0.json": makeRun({ observationOverrides: { ladder: "3", promptSha256: "changed" } }),
      "old.json": JSON.stringify({ state: "passed" }), // no observation block
    });
    const { code, stdout } = await runAggregate(["--base", base, "--changed", changed]);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.verdicts[0].verdict, "group_mismatch");
    assert.equal(out.excludedOldRuns.changed.length, 1);
    assert.equal(out.excludedOldRuns.changed[0].reason, "no_observation_block");
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(changed, { recursive: true, force: true });
  }
});

test("usage error exits 2", async () => {
  const { code, stderr } = await runAggregate([]);
  assert.equal(code, 2);
  assert.match(stderr, /usage:/);
});