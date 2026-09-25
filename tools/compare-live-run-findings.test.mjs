import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const TOOL = "tools/compare-live-run-findings.mjs";

/** @param {object} overrides */
function runFile(overrides = {}) {
  return {
    state: "passed",
    ladder: 4,
    systemFindings: { findings: [], reasonSummaries: {}, rejectedCount: 0, acceptedCount: 6, totalCount: 6 },
    interactionAssessment: { passed: true },
    agentTurn: { settled: true },
    voiceResult: { state: "completed" },
    harvestReceipt: { reasonCode: "crop_harvested" },
    offerReceipt: { reasonCode: "gift_given" },
    ...overrides,
  };
}

function write(dir, name, value) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(value, null, 2), "utf8");
  return p;
}

/** @returns {{code: number, stdout: string, stderr: string}} */
function compare(a, b) {
  try {
    const stdout = execFileSync("node", [TOOL, a, b], { encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("an identical run reports no changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "findings-cmp-"));
  const a = write(dir, "a.json", runFile());
  const b = write(dir, "b.json", runFile());
  const { code, stdout } = compare(a, b);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.summary.regressions, 0);
  assert.equal(parsed.summary.improvements, 0);
  assert.equal(parsed.rows.length, 0);
});

test("removing rejections and findings is reported as an improvement", () => {
  const dir = mkdtempSync(join(tmpdir(), "findings-cmp-"));
  const a = write(
    dir,
    "a.json",
    runFile({
      systemFindings: {
        findings: [{ id: "blind_guess_enumeration", component: "observation", count: 4 }],
        reasonSummaries: { soil_not_diggable: 4 },
        rejectedCount: 4,
        acceptedCount: 2,
        totalCount: 6,
      },
    }),
  );
  const b = write(dir, "b.json", runFile());
  const { code, stdout } = compare(a, b);
  assert.equal(code, 0, "an improvement must not be a failure");
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.summary.improvements >= 3, `expected >=3 improvements, got ${parsed.summary.improvements}`);
  assert.equal(parsed.summary.regressions, 0);
  const names = parsed.rows.map((row) => row.name);
  assert.ok(names.includes("rejectedCount"));
  assert.ok(names.includes("blind_guess_enumeration"));
  assert.ok(names.includes("soil_not_diggable"));
  for (const row of parsed.rows) assert.equal(row.verdict, "improvement");
});

test("a newly introduced finding is a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "findings-cmp-"));
  const a = write(dir, "a.json", runFile());
  const b = write(
    dir,
    "b.json",
    runFile({
      systemFindings: {
        findings: [{ id: "delivery_rejection", component: "delivery", count: 1 }],
        reasonSummaries: { execution_receipt_replay_rejected: 1 },
        rejectedCount: 1,
        acceptedCount: 5,
        totalCount: 6,
      },
    }),
  );
  const { code, stdout, stderr } = compare(a, b);
  assert.equal(code, 1, "a regression must fail the comparison");
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.summary.regressions >= 2);
  assert.match(stderr, /REGRESSION/);
  const delivery = parsed.rows.find((row) => row.name === "delivery_rejection");
  assert.equal(delivery.verdict, "regression");
});

test("a lost stage receipt is a regression even when the verdict still passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "findings-cmp-"));
  const a = write(dir, "a.json", runFile());
  const b = write(dir, "b.json", runFile({ offerReceipt: null }));
  const { code, stdout } = compare(a, b);
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout);
  const row = parsed.rows.find((entry) => entry.name === "receipt.offer");
  assert.ok(row, "expected receipt.offer in the diff");
  assert.equal(row.verdict, "regression");
  assert.equal(row.after, null);
});

test("a newly settled agent turn is an improvement, not a regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "findings-cmp-"));
  const a = write(dir, "a.json", runFile({ agentTurn: { settled: false } }));
  const b = write(dir, "b.json", runFile({ agentTurn: { settled: true } }));
  const { code, stdout } = compare(a, b);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  const row = parsed.rows.find((entry) => entry.name === "agentTurn.settled");
  assert.equal(row.verdict, "improvement");
});

test("usage error exits 2 when a file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "findings-cmp-"));
  const a = write(dir, "a.json", runFile());
  const { code } = compare(a, join(dir, "missing.json"));
  assert.equal(code, 2);
});
