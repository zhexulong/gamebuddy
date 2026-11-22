import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync as write, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./check-action-coverage.mjs", import.meta.url));

/** A run directory whose timeline declares the states a real receipt carries. */
function runWith(receipts) {
  const dir = mkdtempSync(join(tmpdir(), "gb-coverage-"));
  mkdirSync(join(dir, "run"), { recursive: true });
  const rows = receipts.map(({ actionId, state }) => JSON.stringify({ worldFactPayload: { actionId, state } }));
  write(join(dir, "run", "timeline.jsonl"), rows.join("\n"));
  return dir;
}

test("an action that was only ever REJECTED does not count as covered", () => {
  // The distinction the whole tool exists for: a rejected dispatch is evidence the action does not work, so counting it
  // as coverage would let the run that proved a defect certify the capability.
  const dir = runWith([
    { actionId: "cut_weeds", state: "succeeded" },
    { actionId: "enter_mine", state: "rejected" },
    { actionId: "enter_mine", state: "rejected" },
  ]);
  const out = execFileSync("node", [TOOL, "--run-dir", join(dir, "run"), "--json"], { encoding: "utf8" });
  const report = JSON.parse(out);

  assert.ok(report.neverSucceeded.includes("enter_mine"), "rejected twice and never succeeded is NOT covered");
  assert.ok(!report.neverSucceeded.includes("cut_weeds"), "one success is coverage");
  assert.equal(report.everAttempted >= 2, true, "but the attempt is still recorded");
});
