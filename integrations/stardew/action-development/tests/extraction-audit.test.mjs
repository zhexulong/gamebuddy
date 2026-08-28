import assert from "node:assert/strict";
import test from "node:test";
import { auditStandaloneCoupling } from "../src/extraction-audit.mjs";

test("reports current monorepo extraction blockers without attempting a fallback", async () => {
  const report = await auditStandaloneCoupling();
  assert.equal(report.schema, "gamebuddy-stardew-extraction-audit/v1");
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers.map((item) => item.id), ["devkit-workspace-link", "stardew-contract-exporter-project", "stardew-core-source-closure"]);
  assert.ok(report.blockers.every((item) => item.reason.length > 0));
});
