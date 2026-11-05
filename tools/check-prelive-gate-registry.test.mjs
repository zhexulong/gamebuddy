import assert from "node:assert/strict";
import test from "node:test";

import {
  EXEMPTIONS,
  POPULATION_SCAN,
  REASON_CLASSES,
  auditRegistry,
  checkRegistry,
  derivePopulation,
  preludeGatePaths,
  verifyRunsIn,
} from "./check-prelive-gate-registry.mjs";
import { PRELUDE_RUNGS } from "./prelive.mjs";

/**
 * Falsifiers for the register. Each case is one way the claim "every gate either runs in prelive or says where else
 * it runs" can be false, and the assertion is on the FILE the finding names - a register that reports a count without
 * naming the gate is the silence it exists to remove.
 *
 * red-proof: inject  with the `elsewhere`-claims-must-run-in-CI check disabled in the gate, this suite failed on
 *   "an elsewhere claim that the CI coverage gate says runs nowhere is red, quoting that gate's reason"
 */

const CLEAN = () => ({
  population: ["tools/check-a.mjs", "tools/check-b.mjs"],
  wired: new Map([["tools/check-a.mjs", "l0"]]),
  exemptions: [
    {
      path: "tools/check-b.mjs",
      reason: "elsewhere: static scan, runs on every push in the CI gates job",
      runsIn: "pnpm check:b",
    },
  ],
  scripts: { "check:b": "node tools/check-b.mjs" },
  workflow: () => "",
  ciCoverage: { runs: new Set(["check:b"]), registered: new Map() },
});

const codesFor = (result) => result.findings.map((finding) => `${finding.code}:${finding.path}`).sort();

test("a gate neither wired nor exempt is reported as forgotten, and the file is named", () => {
  const result = checkRegistry({
    ...CLEAN(),
    population: ["tools/check-a.mjs", "tools/check-b.mjs", "tools/check-c.mjs"],
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(codesFor(result), ["gate_forgotten:tools/check-c.mjs"]);
});

test("an exemption for a gate prelive now runs is stale, and the rung that runs it is named", () => {
  const base = CLEAN();
  const result = checkRegistry({
    ...base,
    wired: new Map([...base.wired, ["tools/check-b.mjs", "l0b"]]),
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(codesFor(result), ["exempt_but_wired:tools/check-b.mjs"]);
  assert.equal(result.findings[0].detail, "prelive l0b runs it");
});

test("an exemption for a path that is not a gate is stale, so the table cannot keep dead rows", () => {
  const base = CLEAN();
  const result = checkRegistry({
    ...base,
    exemptions: [
      ...base.exemptions,
      { path: "tools/check-gone.mjs", reason: base.exemptions[0].reason, runsIn: "pnpm check:b" },
    ],
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(codesFor(result), ["exempt_not_a_gate:tools/check-gone.mjs"]);
});

test("a reason with no declared class, or too short to name anything, is not an exemption", () => {
  const base = CLEAN();
  const unknownClass = checkRegistry({
    ...base,
    exemptions: [{ path: "tools/check-b.mjs", reason: "because it is slow", runsIn: "pnpm check:b" }],
  });
  assert.deepEqual(codesFor(unknownClass), ["exempt_unreasoned:tools/check-b.mjs"]);
  assert.match(unknownClass.findings[0].detail, /unknown class "because it is slow"/u);
  const tooShort = checkRegistry({
    ...base,
    exemptions: [{ path: "tools/check-b.mjs", reason: "elsewhere: slow", runsIn: "pnpm check:b" }],
  });
  assert.deepEqual(codesFor(tooShort), ["exempt_unreasoned:tools/check-b.mjs"]);
  assert.match(tooShort.findings[0].detail, /too short/u);
});

test("every declared reason class has a meaning, and every exemption uses one", () => {
  for (const entry of EXEMPTIONS) {
    const className = entry.reason.split(":")[0].trim();
    assert.ok(Object.hasOwn(REASON_CLASSES, className), `${entry.path} uses undeclared class ${className}`);
    assert.ok(REASON_CLASSES[className].length > 40, `${className} must say why, not just name a bucket`);
  }
});

test("a runsIn that names no script, or a script that does not name the gate, is dangling", () => {
  const base = CLEAN();
  const unknownScript = checkRegistry({
    ...base,
    exemptions: [{ path: "tools/check-b.mjs", reason: base.exemptions[0].reason, runsIn: "pnpm check:missing" }],
    ciCoverage: { runs: new Set(["check:missing"]), registered: new Map() },
  });
  assert.deepEqual(codesFor(unknownScript), ["exempt_runs_in_unknown_script:tools/check-b.mjs"]);
  const otherGate = checkRegistry({
    ...base,
    scripts: { "check:b": "node tools/check-somewhere-else.mjs" },
  });
  assert.deepEqual(codesFor(otherGate), ["exempt_runs_in_script_does_not_name_the_gate:tools/check-b.mjs"]);
  assert.match(otherGate.findings[0].detail, /node tools\/check-somewhere-else\.mjs/u);
});

test("a ci: claim is checked against the workflow file it names", () => {
  const base = CLEAN();
  const entry = { path: "tools/check-b.mjs", reason: base.exemptions[0].reason, runsIn: "ci:.github/workflows/ci.yml" };
  const missingFile = checkRegistry({ ...base, exemptions: [entry], workflow: () => null });
  assert.deepEqual(codesFor(missingFile), ["exempt_runs_in_unknown_workflow:tools/check-b.mjs"]);
  const notNamed = checkRegistry({ ...base, exemptions: [entry], workflow: () => "run: pnpm test" });
  assert.deepEqual(codesFor(notNamed), ["exempt_runs_in_workflow_does_not_name_the_gate:tools/check-b.mjs"]);
  const named = checkRegistry({ ...base, exemptions: [entry], workflow: () => "run: node tools/check-b.mjs" });
  assert.equal(named.status, "passed");
});

test("an elsewhere claim that the CI coverage gate says runs nowhere is red, quoting that gate's reason", () => {
  const base = CLEAN();
  const result = checkRegistry({
    ...base,
    ciCoverage: {
      runs: new Set(),
      registered: new Map([["check:b", { reason: "debt", detail: "measured red at HEAD" }]]),
    },
  });
  assert.deepEqual(codesFor(result), ["exempt_elsewhere_not_in_ci:tools/check-b.mjs"]);
  assert.match(result.findings[0].detail, /registers check:b as debt: measured red at HEAD/u);
});

test("a gate the ladder names but the population does not contain is red, not silently wired", () => {
  const base = CLEAN();
  const result = checkRegistry({ ...base, wired: new Map([...base.wired, ["tools/check-nope.mjs", "l0"]]) });
  assert.deepEqual(codesFor(result), ["wired_not_a_gate:tools/check-nope.mjs"]);
});

test("verifyRunsIn reads on-demand as a claim with no scheduled home, not as a pass", () => {
  assert.equal(verifyRunsIn({ path: "tools/x.mjs", runsIn: "on-demand" }, { scripts: {}, workflow: () => "" }), null);
  assert.deepEqual(verifyRunsIn({ path: "tools/x.mjs", runsIn: "whenever" }, { scripts: {}, workflow: () => "" }), {
    code: "exempt_runs_in_unrecognised",
    detail: "whenever",
  });
});

test("the derivation excludes a gate's falsifier suite and includes the tree-guarding stardew tests", () => {
  const population = derivePopulation({
    list: (dir) =>
      dir === "tools"
        ? ["check-a.mjs", "check-a.test.mjs", "audit-b.mjs", "audit-b.test.mjs", "check-c.mutation.mjs", "read-x.mjs"]
        : ["action-source-projection-drift.test.mjs", "static-verifier-contract.test.mjs", "portfolio.test.mjs"],
  });
  assert.deepEqual(population, [
    "tools/audit-b.mjs",
    "tools/check-a.mjs",
    "tools/check-c.mutation.mjs",
    "integrations/stardew/action-development/tests/action-source-projection-drift.test.mjs",
  ]);
});

test("the scans are two directories and the stardew one is the drift/reconciliation convention", () => {
  assert.deepEqual(
    POPULATION_SCAN.map((scan) => scan.dir),
    ["tools", "integrations/stardew/action-development/tests"],
  );
});

test("the real tree: the wired set is exactly what the ladder declares, and no gate is forgotten", () => {
  const population = derivePopulation();
  const wired = preludeGatePaths();
  const result = auditRegistry();
  assert.deepEqual(result.findings, [], "every gate in the tree must be wired or say where it runs");
  assert.deepEqual(
    [...wired.keys()].filter((path) => !population.includes(path)),
    [],
    "a rung may only name a gate that is in the population",
  );
  assert.ok(result.total > 90, `the population is the tree's gates, not a sample: ${result.total}`);
  assert.equal(result.wired, wired.size);
  assert.equal(result.wired + result.exempt, result.total);
  assert.equal([...PRELUDE_RUNGS].length, 2);
});

test("the real tree: every withdrawn gate names the input or the measurement that keeps it out of prelive", () => {
  const result = auditRegistry();
  assert.equal(result.status, "passed");
  assert.ok(result.exempt > 60, `most of the tree's gates run elsewhere; measured ${result.exempt}`);
  assert.ok(
    result.onDemand.length < result.exempt,
    "on-demand is the exception; a table where most gates have no scheduled home means the register is not a register",
  );
  for (const path of result.onDemand)
    assert.ok(
      EXEMPTIONS.find((entry) => entry.path === path)?.reason.length > 40,
      `${path} has no scheduled home and must still say why`,
    );
});
