import assert from "node:assert/strict";
import test from "node:test";
import { auditRootStardewCiDisposition } from "../src/root-ci-disposition-audit.mjs";

test("proves the root CI cutover to one package-owned deterministic Stardew command", async () => {
  const report = await auditRootStardewCiDisposition();
  assert.equal(report.schema, "gamebuddy-stardew-root-ci-disposition-audit/v1");
  assert.equal(report.status, "package-owned");
  assert.equal(report.workflowCommand, "pnpm --dir integrations/stardew/action-development action:ci");
  assert.equal(report.workflowCommandOccurrences, 1);
  assert.equal(report.rootStardewPortfolioEntryCount, 0);
  assert.deepEqual(report.packageEntries, [
    "equip-tool-contract-check",
    "scaffold-contract",
     "action-surface-check",
     "action-surface-export-check",
     "action-source-projection-check",
    "static-production-admission",
    "package-deterministic-tests",
  ]);
  assert.deepEqual(report.retiredRootEdges, [
    "check:stardew-action-surface",
    "test:stardew-action-projection",
    "test:stardew:static",
    "verify:stardew:static",
    "p7-p9-stardew-static-portfolio",
  ]);
  assert.deepEqual(report.targetEvidencePolicy, {
    ordinaryCiMissingPublication: "blocked",
    blockedIsTargetPass: false,
    liveOrTargetMutationSelectable: false,
  });
});
