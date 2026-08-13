import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArguments, prepareReportTarget, writeReport } from "./run-player-managed-memory-http-live.mjs";

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-http-live-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("report argument accepts exactly one create-only report path", () => {
  assert.deepEqual(parseArguments([]), { reportPath: undefined });
  assert.throws(() => parseArguments(["--report"]), /usage:/);
  assert.throws(() => parseArguments(["--unknown", "report.json"]), /usage:/);
  assert.throws(() => parseArguments(["--report", "report.json", "extra"]), /usage:/);
});

test("report target requires an existing real parent and never overwrites evidence", async () =>
  withRoot(async (root) => {
    const target = join(root, "evidence.json");
    assert.match(await prepareReportTarget(target), /evidence\.json$/);
    await writeFile(target, "existing", "utf8");
    await assert.rejects(prepareReportTarget(target), /report_target_already_exists/);
    await assert.rejects(
      prepareReportTarget(join(root, "missing", "evidence.json")),
      /report_parent_missing_or_unresolvable/,
    );
  }));

test("report writer produces JSON only at its approved create-only target", async () =>
  withRoot(async (root) => {
    const target = await prepareReportTarget(join(root, "evidence.json"));
    const report = Object.freeze({ schema: "test/v1", state: "passed", statuses: { create: 201 } });
    await writeReport(target, report);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), report);
    await assert.rejects(writeReport(target, report), { code: "EEXIST" });
  }));

test("report writer rejects Memory content and browser credential field names", async () =>
  withRoot(async (root) => {
    await assert.rejects(
      writeReport(await prepareReportTarget(join(root, "memory-content.json")), {
        note: "The player prefers something private",
      }),
      /evidence_report_content_guard_rejected/,
    );
    await assert.rejects(
      writeReport(await prepareReportTarget(join(root, "credential.json")), { csrf: "not-safe-even-if-redacted" }),
      /evidence_report_content_guard_rejected/,
    );
  }));
