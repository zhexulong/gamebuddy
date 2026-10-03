// Regression gate for the native-local runner contract audit.
//
// The audit exists because a runner can be structurally incapable of passing live
// while its own unit test stays green: the test builds a config in the same
// retired shape the runner expects, so the two agree with each other and disagree
// with the live fixture. Nothing in the repo ran those tests, which is how the
// class rotted unnoticed.
//
// Every case runs against a COPY of the tools tree. An earlier version of this
// file mutated the shared runners in place, which raced the lane that is migrating
// them: a restore could overwrite work that landed between the write and the
// restore. Copying removes that hazard entirely and is also why the audit takes an
// injectable toolsRoot.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { auditRunnerContracts } from "./audit-stardew-native-local-runner-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tools/lib/stardew-native-local-player-fixture.mjs");

const workspaces = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** Copy the tools tree so mutations cannot touch the shared working files. */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "runner-contract-"));
  workspaces.push(dir);
  cpSync(path.join(ROOT, "tools"), path.join(dir, "tools"), { recursive: true });
  const fixtureCopy = path.join(dir, "tools/lib/stardew-native-local-player-fixture.mjs");
  return {
    toolsRoot: path.join(dir, "tools"),
    fixturePath: fixtureCopy,
    audit: () => auditRunnerContracts({ toolsRoot: path.join(dir, "tools"), fixturePath: fixtureCopy }),
    runnerPath: (id) => path.join(dir, `tools/run-stardew-native-local-player-${id}-smoke.mjs`),
  };
}

// The baseline-conforming set is the reference shape; use one that is unpinned in
// neither direction so "the audit works" is distinguishable from "the change was
// exempt".
const CONFORMING_RUNNER = "dig-artifact-spot";

// The retired shape, written out here rather than borrowed from a live runner:
// the migration is retiring every such runner, so a real one would disappear and
// silently turn the assertions below into no-ops.
const RETIRED_SHAPE_SOURCE = [
  "export async function runSyntheticSmoke(client, receipts, config) {",
  "  if (config.ActionPolicyVersion !== 0) throw new Error(\"native_local_action_policy_invalid\");",
  "  if (JSON.stringify(config.EnabledActions) !== JSON.stringify([])) throw new Error(\"invalid\");",
  "  return { state: \"blocked\" };",
  "}",
  "",
].join("\n");

test("the current runner set has no regression and no new retired-shape runner", () => {
  const report = auditRunnerContracts();
  assert.deepEqual(report.findings, [], "no runner may regress out of the baseline-conforming set");
  assert.ok(report.runnerCount >= 50, `expected the full runner set, saw ${report.runnerCount}`);
  assert.ok(report.conformingCount > 0, "at least some runners must already conform");
});

test("regressing a baseline-conforming runner back to the retired shape is a finding", () => {
  const box = sandbox();
  const original = readFileSync(box.runnerPath(CONFORMING_RUNNER), "utf8");
  const mutated = original.replace(
    /validateNativeLocalFixturePolicy\(value, \{[^}]*\}\);/,
    "if (value.ActionPolicyVersion !== 0) throw new Error('native_local_action_policy_invalid');",
  );
  assert.notEqual(mutated, original, "mutation must actually change the source");
  writeFileSync(box.runnerPath(CONFORMING_RUNNER), mutated);

  const findings = box.audit().findings;
  const named = findings.filter((f) => f.kind === "conforming_regression" && f.runner === CONFORMING_RUNNER);
  assert.equal(named.length, 1, "audit must report the regression");
  assert.match(named[0].detail, /retired-policy-shape/);
});

test("regressing a baseline-conforming runner to an equality capability set is a finding", () => {
  const box = sandbox();
  const original = readFileSync(box.runnerPath(CONFORMING_RUNNER), "utf8");
  const mutated = original.replace(
    /(assertRequiredCapabilities\([^;]*\);)/,
    "$1\n    assertExactCapabilities(before, EXPECTED_CAPABILITIES);",
  );
  assert.notEqual(mutated, original, "mutation must actually change the source");
  writeFileSync(box.runnerPath(CONFORMING_RUNNER), mutated);

  const named = box.audit().findings.filter((f) => f.kind === "conforming_regression" && f.runner === CONFORMING_RUNNER);
  assert.equal(named.length, 1);
  assert.match(named[0].detail, /exact-capability-set/);
});

test("a NEW runner written in the retired shape is a finding even though it is not in the baseline", () => {
  const box = sandbox();
  // Write the retired shape into a name the baseline has never seen.
  const newId = "brand-new-action";
  writeFileSync(box.runnerPath(newId), RETIRED_SHAPE_SOURCE);

  const named = box.audit().findings.filter((f) => f.kind === "new_runner_on_retired_contract" && f.runner === newId);
  assert.equal(named.length, 1, "a new runner must conform; the baseline cannot excuse it");
});

test("a NEW runner that conforms is accepted", () => {
  const box = sandbox();
  const conforming = readFileSync(box.runnerPath(CONFORMING_RUNNER), "utf8");
  const newId = "brand-new-conforming-action";

  // The sandbox copies the current tools tree, which can already hold
  // non-baseline runners (other lanes' pilots, e.g. cut-grass). What this test
  // proves is that writing ONE more conforming runner increases the new-runner
  // count by exactly one and stays finding-free. Audit must therefore run
  // BEFORE the write to capture the pre-write count.
  const before = box.audit();
  writeFileSync(box.runnerPath(newId), conforming);
  const report = box.audit();
  assert.equal(report.newRunnerCount, before.newRunnerCount + 1, 'the new runner must be detected as new');
  assert.deepEqual(report.findings, [], "a conforming new runner is not a finding");
});

test("improving a runner is never a finding, and the retired shape is fully migrated out", () => {
  const box = sandbox();

  // The two baseline sets have collapsed onto each other: every runner conforms,
  // so the exemption set and the runner set are equal. Assert that explicitly, so
  // a future reader can tell "no debt left" apart from "the audit silently
  // stopped classifying".
  const report = box.audit();
  assert.equal(report.debt.length, 0, "the retired shape is fully migrated out");
  assert.equal(
    report.conformingCount,
    report.runnerCount,
    "at zero debt every runner must conform; a gap means the baselines drifted",
  );

  // Replacing a baseline runner's body with another runner's conforming body is
  // what the migration did, and must stay green -- otherwise the gate fights the
  // lane improving things instead of the debt.
  const conforming = readFileSync(box.runnerPath(CONFORMING_RUNNER), "utf8");
  const otherConforming = report.runners.find((r) => r.conforming && r.id !== CONFORMING_RUNNER).id;
  const otherBody = readFileSync(box.runnerPath(otherConforming), "utf8");
  assert.notEqual(otherBody, conforming, "the two bodies must differ for this to test a rewrite");
  writeFileSync(box.runnerPath(CONFORMING_RUNNER), otherBody);

  assert.deepEqual(box.audit().findings, [], "rewriting a runner to conform must never be a finding");
});

test("a fixture that stops writing the deny-by-exception policy is a finding", () => {
  const box = sandbox();
  const original = readFileSync(FIXTURE, "utf8");
  const mutated = original.replace("  result.DeniedActions = [];", "  result.EnabledActions = [];");
  assert.notEqual(mutated, original, "mutation must change the fixture's output shape");
  writeFileSync(box.fixturePath, mutated);

  assert.ok(
    box.audit().findings.some((f) => f.kind === "contract"),
    "audit must notice the fixture no longer writes what it assumes",
  );
});
