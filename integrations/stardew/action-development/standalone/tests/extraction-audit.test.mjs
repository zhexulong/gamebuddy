import assert from "node:assert/strict";
import test from "node:test";
import { auditStandaloneCoupling } from "../src/extraction-audit.mjs";

test("attests the package-local standalone closure without former-root fallback", async () => {
  const report = await auditStandaloneCoupling();
  assert.equal(report.schema, "gamebuddy-stardew-extraction-audit/v1");
  assert.equal(report.status, "standalone-ready");
  assert.equal(report.rootReadPolicy, "reject-former-monorepo-root");
  assert.deepEqual(report.blockers, []);
  assert.ok(report.inputs.length > 0);
  assert.ok(report.inputs.every((input) => input.startsWith("inputs/")));
});
