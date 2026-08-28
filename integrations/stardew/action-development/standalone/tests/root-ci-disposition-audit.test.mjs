import assert from "node:assert/strict";
import test from "node:test";
import { auditRootStardewCiDisposition } from "../src/root-ci-disposition-audit.mjs";

test("reports remaining root Stardew CI and portfolio edges as retained pending package parity", async () => {
  const report = await auditRootStardewCiDisposition();
  assert.equal(report.schema, "gamebuddy-stardew-root-ci-disposition-audit/v1");
  assert.equal(report.status, "blocked");
  assert.deepEqual(
    report.blocked.map((entry) => entry.command),
    [
      "pnpm test:stardew-action-projection",
      "pnpm check:stardew-action-surface",
      "pnpm test:stardew:static",
      "node tools/verify-stardew-static.mjs",
    ],
  );
  assert.ok(report.blocked.every((entry) => entry.disposition === "retain_until_package_parity"));
  assert.doesNotMatch(JSON.stringify(report), /verify-stardew-scaffold|job:stardew-scaffold/);
});
