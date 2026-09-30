// Regression gate for the native-local runner contract audit.
//
// The audit exists because a runner can be structurally incapable of passing
// live while its own unit test stays green: the test builds a config in the same
// retired shape the runner expects, so the two agree with each other and disagree
// with the live fixture. Nothing in the repo ran those tests, which is how the
// class rotted unnoticed. Every case below mutates the audit's own inputs and
// asserts the exact finding it must produce.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { auditRunnerContracts } from "./audit-stardew-native-local-runner-contract.mjs";

/**
 * Re-import the audit with a cache-busting query so a mutated pin list is read
 * from disk. A plain import would keep the list frozen at first load, and the two
 * stale-pin cases would silently test nothing.
 */
const freshAudit = async () =>
  (await import(`./audit-stardew-native-local-runner-contract.mjs?t=${Date.now()}${Math.random()}`)).auditRunnerContracts;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Use an UNPINNED runner: a pinned one is exempt by design, so mutating it would
// not distinguish "the audit works" from "the entry was still listed".
const RUNNER_ID = "dig-artifact-spot";
const RUNNER = path.join(ROOT, `tools/run-stardew-native-local-player-${RUNNER_ID}-smoke.mjs`);
const original = readFileSync(RUNNER, "utf8");
const restore = () => writeFileSync(RUNNER, original);

after(restore);

test("current runners are either conforming or explicitly pinned as debt", () => {
  const report = auditRunnerContracts();
  assert.deepEqual(report.findings, [], "no unpinned runner may read the retired policy shape or assert an equality capability set");
  assert.ok(report.runnerCount >= 50, `expected the full runner set, saw ${report.runnerCount}`);
  assert.ok(report.conformingCount > 0, "at least some runners must already conform");
});

test("a runner that reads the retired policy shape is reported", () => {
  // Match on the call, not on a specific expected-constant name: the runners were
  // written by several lanes and do not agree on that name.
  const mutated = original.replace(
    /validateNativeLocalFixturePolicy\(value, \{[^}]*\}\);/,
    "if (value.ActionPolicyVersion !== 0) throw new Error('native_local_action_policy_invalid');",
  );
  assert.notEqual(mutated, original, "mutation must actually change the source");
  writeFileSync(RUNNER, mutated);

  const report = auditRunnerContracts();
  const named = report.findings.filter((f) => f.kind === "unregistered_debt" && f.runner === RUNNER_ID);
  assert.equal(named.length, 1, "audit must name the runner that reads the retired shape");
  assert.match(named[0].detail, /retired ActionPolicyVersion\/EnabledActions shape/);

  restore();
});

test("a runner that asserts an equal capability set is reported", () => {
  const mutated = original.replace(
    /(assertRequiredCapabilities\([^;]*\);)/,
    "$1\n    assertExactCapabilities(before, EXPECTED_CAPABILITIES);",
  );
  assert.notEqual(mutated, original, "mutation must actually change the source");
  writeFileSync(RUNNER, mutated);

  const report = auditRunnerContracts();
  const named = report.findings.filter((f) => f.kind === "unregistered_debt" && f.runner === RUNNER_ID);
  assert.equal(named.length, 1);
  assert.match(named[0].detail, /equal capability set/);

  restore();
});

test("a conforming runner still listed as debt is reported as a stale pin", async () => {
  // Stale-pin detection is what lets the debt list only shrink: fixing a runner
  // without removing its entry must be an error, not a silent no-op.
  const auditPath = path.join(ROOT, "tools/audit-stardew-native-local-runner-contract.mjs");
  const auditOriginal = readFileSync(auditPath, "utf8");
  try {
    const mutated = auditOriginal.replace('  "advance-day",\n', `  "advance-day",\n  "${RUNNER_ID}",\n`);
    assert.notEqual(mutated, auditOriginal, "mutation must add a pin");
    writeFileSync(auditPath, mutated);

    const report = (await freshAudit())();
    const stale = report.findings.filter((f) => f.kind === "stale_pin" && f.runner === RUNNER_ID);
    assert.equal(stale.length, 1, "audit must report a conforming runner still listed as debt");
  } finally {
    writeFileSync(auditPath, auditOriginal);
  }
});

test("a listed runner that no longer exists is reported as a stale pin", async () => {
  const auditPath = path.join(ROOT, "tools/audit-stardew-native-local-runner-contract.mjs");
  const auditOriginal = readFileSync(auditPath, "utf8");
  try {
    const mutated = auditOriginal.replace('  "advance-day",\n', '  "advance-day",\n  "no-such-runner",\n');
    assert.notEqual(mutated, auditOriginal, "mutation must add a pin");
    writeFileSync(auditPath, mutated);

    const report = (await freshAudit())();
    const stale = report.findings.filter((f) => f.kind === "stale_pin" && f.runner === "no-such-runner");
    assert.equal(stale.length, 1);
  } finally {
    writeFileSync(auditPath, auditOriginal);
  }
});
