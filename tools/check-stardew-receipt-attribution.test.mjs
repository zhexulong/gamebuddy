import assert from "node:assert/strict";
import test from "node:test";
import { checkStardewReceiptAttribution, validateReceiptAttribution } from "./check-stardew-receipt-attribution.mjs";

const MOVEMENT = "integrations/stardew/StardewBodyController.cs";

test("the shipped movement attribution carries a run measurement", () => {
  const report = checkStardewReceiptAttribution();
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test("receipt validator rejects an attribution without a measurement and accepts undecided", () => {
  assert.equal(validateReceiptAttribution("path_search=native_budget_exhausted;budget=40000").ok, false);
  assert.equal(validateReceiptAttribution("path_search=undecided;budget=undecided").ok, true);
  assert.equal(validateReceiptAttribution("measurement=cardinal_flood;path_search=no_cardinal_route;budget=undecided").ok, true);
});

test("mutation: removing the measurement from a producer is blocked", () => {
  const original = `
class Mutated {
  LocalExecutionReceipt Refusal() {
    return $"measurement=cardinal_flood;path_search=no_cardinal_route;route_exists_cardinal=false";
  }
}`;
  const mutated = original.replace("measurement=cardinal_flood;", "");
  const report = checkStardewReceiptAttribution({ sourceOverrides: { [MOVEMENT]: mutated } });
  assert.ok(report.findings.some((finding) => finding.key === "path_search"));
  assert.ok(report.findings.some((finding) => finding.key === "route_exists"));
});
