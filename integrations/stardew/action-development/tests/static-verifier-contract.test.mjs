import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseJsonWithoutDuplicateKeys } from "../src/json-text.mjs";
import {
  BLOCKED_MISSING_TARGET_ASSEMBLIES,
  CONTRACT_OUTPUTS,
  FAILED_CONTRACT_OUTPUT_MISSING,
  FAILED_TARGET_ASSEMBLY,
  FAILED_TARGET_CLOSURE_PARTIAL,
  INPUT_SCHEMA,
  INTEGRATION_REQUIREMENTS,
  PACKAGE_FIXTURE_SCOPE,
  REPORT_SCHEMA,
  STATIC_CHECKS,
  TARGET_ASSEMBLIES,
  TARGET_ASSEMBLIES_AVAILABLE,
  VERIFIER_ID,
  validateInput,
  validateReport,
} from "../static-verifier/schema.mjs";
import {
  checkContractOutputAvailability,
  checkTargetAssemblyAvailability,
  createMissingTargetFixture,
  verifyStaticInput,
} from "../static-verifier/verifier.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = path.join(path.dirname(directory), "static-verifier", "fixtures");

function fails(code, callback) {
  assert.throws(callback, new RegExp(`stardew_static_verifier_schema_${code}`));
}

function fixtureName(name) {
  return `input.${name}.v1.json`;
}

async function readFixture(name) {
  return parseJsonWithoutDuplicateKeys(await readFile(path.join(fixtureDirectory, fixtureName(name)), "utf8"), "static_verifier_fixture");
}

function withRoot(clone, artifactRoot) {
  return { ...clone, artifactRoot };
}

test("freezes the exact versioned capability contract identity", () => {
  assert.equal(INPUT_SCHEMA, "gamebuddy-stardew-static-verifier-input/v1");
  assert.equal(REPORT_SCHEMA, "gamebuddy-stardew-static-verifier-report/v1");
  assert.equal(VERIFIER_ID, "gamebuddy.stardew.action-development.static-verifier@v1");
  assert.equal(PACKAGE_FIXTURE_SCOPE, "package-owned-fixture");
  assert.deepEqual(TARGET_ASSEMBLIES, [
    { id: "gamebuddy-stardew-mod", role: "mod", relativePath: "GameBuddy.Stardew.dll", required: true, siblingOf: "gamebuddy-stardew-core" },
    { id: "gamebuddy-stardew-core", role: "core", relativePath: "GameBuddy.Stardew.Core.dll", required: true, siblingOf: "gamebuddy-stardew-mod" },
  ]);
  assert.deepEqual(CONTRACT_OUTPUTS, [
    { id: "capability-publication-contract", relativePath: "FarmhandCapabilityPublicationProjection.Contract.dll", required: true },
  ]);
  assert.deepEqual(STATIC_CHECKS, [{ id: "target-assembly-availability", kind: "target_assembly_availability", required: true }]);
  assert.equal(INTEGRATION_REQUIREMENTS.length, 3);
});

test("accepts only the exact committed producer fixtures as validated input", async () => {
  for (const name of ["pass", "blocked", "partial", "malformed", "contract-missing"]) {
    const validated = validateInput(await readFixture(name));
    assert.equal(validated.schema, INPUT_SCHEMA);
    assert.equal(validated.scope, PACKAGE_FIXTURE_SCOPE);
    assert.deepEqual(validated.targetAssemblies, TARGET_ASSEMBLIES);
    assert.deepEqual(validated.contractOutputs, CONTRACT_OUTPUTS);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.targetAssemblies), true);
  }
});

test("rejects partial, replaced, or drifted Mod/Core sibling identity", async () => {
  const pass = await readFixture("pass");
  const withoutCore = structuredClone(pass);
  withoutCore.targetAssemblies = [pass.targetAssemblies[0]];
  fails("target_assembly_count", () => validateInput(withoutCore));

  const extraAssembly = structuredClone(pass);
  extraAssembly.targetAssemblies.push(pass.targetAssemblies[1]);
  fails("target_assembly_count", () => validateInput(extraAssembly));

  const alternateCore = structuredClone(pass);
  alternateCore.targetAssemblies[1] = { ...pass.targetAssemblies[1], relativePath: "Other.Core.dll" };
  fails("target_assembly_definition", () => validateInput(alternateCore));

  const swappedRoles = structuredClone(pass);
  swappedRoles.targetAssemblies[1] = { ...pass.targetAssemblies[1], role: "mod" };
  fails("target_assembly_definition", () => validateInput(swappedRoles));

  const brokenPairing = structuredClone(pass);
  brokenPairing.targetAssemblies[1] = { ...pass.targetAssemblies[1], siblingOf: "some-other-mod" };
  fails("target_assembly_definition", () => validateInput(brokenPairing));

  const optionalCore = structuredClone(pass);
  optionalCore.targetAssemblies[1] = { ...pass.targetAssemblies[1], required: false };
  fails("target_assembly_definition", () => validateInput(optionalCore));

  const renamed = structuredClone(pass);
  renamed.targetAssemblies[0] = { ...pass.targetAssemblies[0], id: "gamebuddy-stardew-mod-renamed" };
  fails("target_assembly_definition", () => validateInput(renamed));

  const unknownKey = structuredClone(pass);
  unknownKey.targetAssemblies[0].extra = true;
  fails("target_assembly_shape", () => validateInput(unknownKey));
});

test("rejects envelope, scope, root, and contract-output drift", async () => {
  const pass = await readFixture("pass");

  fails("input_shape", () => validateInput({ ...pass, extra: true }));
  fails("input_schema", () => validateInput({ ...pass, schema: "other/v1" }));
  fails("input_scope", () => validateInput({ ...pass, scope: "root-owned" }));
  fails("input_id", () => validateInput({ ...pass, inputId: "../escape" }));
  fails("artifact_root", () => validateInput({ ...pass, artifactRoot: "C:/outside" }));
  fails("artifact_root", () => validateInput({ ...pass, artifactRoot: "../outside" }));

  const driftedContract = structuredClone(pass);
  driftedContract.contractOutputs = [];
  fails("contract_output_count", () => validateInput(driftedContract));

  const renamedContract = structuredClone(pass);
  renamedContract.contractOutputs[0] = { ...pass.contractOutputs[0], relativePath: "Other.Contract.dll" };
  fails("contract_output_definition", () => validateInput(renamedContract));
});

test("target absence is a named blocked report, never a pass or a build request", async () => {
  const blocked = validateInput(await readFixture("blocked"));
  const report = verifyStaticInput(blocked);
  assert.equal(report.state, "blocked");
  assert.equal(report.reasonCode, BLOCKED_MISSING_TARGET_ASSEMBLIES);
  assert.deepEqual(report.summary, { passed: 0, failed: 0, blocked: 1, passDenominator: 0 });
  assert.deepEqual(report.targetAssemblies.present, []);
  assert.equal(report.targetAssemblies.missing.length, 2);
  assert.equal(report.contractOutputs.missing.length, 1);
  assert.deepEqual(report.checks, [
    { id: "target-assembly-availability", kind: "target_assembly_availability", state: "blocked", reasonCode: BLOCKED_MISSING_TARGET_ASSEMBLIES },
  ]);
  assert.equal(validateReport(report), report);
});

test("partial, malformed, and contract-incomplete closures are named failed reports", async () => {
  const partial = validateInput(withRoot(await readFixture("partial"), "static-verifier/fixtures/closure/partial"));
  const partialReport = verifyStaticInput(partial);
  assert.equal(partialReport.state, "failed");
  assert.equal(partialReport.reasonCode, FAILED_TARGET_CLOSURE_PARTIAL);
  assert.deepEqual(partialReport.targetAssemblies.present, [{ id: "gamebuddy-stardew-mod", relativePath: "GameBuddy.Stardew.dll" }]);
  assert.deepEqual(partialReport.targetAssemblies.missing, [{ id: "gamebuddy-stardew-core", relativePath: "GameBuddy.Stardew.Core.dll" }]);
  assert.deepEqual(partialReport.targetAssemblies.unusable, []);

  const malformed = validateInput(withRoot(await readFixture("malformed"), "static-verifier/fixtures/closure/malformed"));
  const malformedReport = verifyStaticInput(malformed);
  assert.equal(malformedReport.state, "failed");
  assert.equal(malformedReport.reasonCode, FAILED_TARGET_ASSEMBLY);
  assert.deepEqual(malformedReport.targetAssemblies.unusable, [
    { id: "gamebuddy-stardew-mod", relativePath: "GameBuddy.Stardew.dll", reason: "not_a_readable_nonempty_file" },
  ]);
  assert.deepEqual(malformedReport.targetAssemblies.present, [{ id: "gamebuddy-stardew-core", relativePath: "GameBuddy.Stardew.Core.dll" }]);

  const contractMissing = validateInput(withRoot(await readFixture("contract-missing"), "static-verifier/fixtures/closure/contract-missing"));
  const contractReport = verifyStaticInput(contractMissing);
  assert.equal(contractReport.state, "failed");
  assert.equal(contractReport.reasonCode, FAILED_CONTRACT_OUTPUT_MISSING);
  assert.deepEqual(contractReport.contractOutputs.present, []);
  assert.deepEqual(contractReport.contractOutputs.missing, [
    { id: "capability-publication-contract", relativePath: "FarmhandCapabilityPublicationProjection.Contract.dll" },
  ]);
  for (const report of [partialReport, malformedReport, contractReport]) {
    assert.deepEqual(report.summary, { passed: 0, failed: 1, blocked: 0, passDenominator: 1 });
    assert.equal(validateReport(report), report);
  }
});

test("an exact complete closure produces exactly the v1 report schema", async () => {
  const report = verifyStaticInput(validateInput(withRoot(await readFixture("pass"), "static-verifier/fixtures/closure/pass")));
  assert.deepEqual(report, {
    schema: REPORT_SCHEMA,
    verifierId: VERIFIER_ID,
    inputId: "static-verifier-pass",
    scope: PACKAGE_FIXTURE_SCOPE,
    state: "passed",
    reasonCode: TARGET_ASSEMBLIES_AVAILABLE,
    summary: { passed: 1, failed: 0, blocked: 0, passDenominator: 1 },
    targetAssemblies: {
      required: TARGET_ASSEMBLIES,
      present: [
        { id: "gamebuddy-stardew-mod", relativePath: "GameBuddy.Stardew.dll" },
        { id: "gamebuddy-stardew-core", relativePath: "GameBuddy.Stardew.Core.dll" },
      ],
      missing: [],
      unusable: [],
    },
    contractOutputs: {
      required: CONTRACT_OUTPUTS,
      present: [{ id: "capability-publication-contract", relativePath: "FarmhandCapabilityPublicationProjection.Contract.dll" }],
      missing: [],
    },
    checks: [{ id: "target-assembly-availability", kind: "target_assembly_availability", state: "passed", reasonCode: TARGET_ASSEMBLIES_AVAILABLE }],
    integration: { status: "not-integrated", required: INTEGRATION_REQUIREMENTS },
  });
  assert.equal(validateReport(report), report);
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.targetAssemblies.present), true);

  const exceptionHandling = validateInput(withRoot(await readFixture("pass"), "static-verifier/fixtures/closure/pass"));
  assert.equal(
    checkTargetAssemblyAvailability(exceptionHandling, {
      exists: () => { throw new Error("io"); },
      stat: () => { throw new Error("io"); },
    }).missing.length,
    2,
  );
  assert.equal(
    checkContractOutputAvailability(exceptionHandling, { exists: () => false }).missing.length,
    1,
  );
});

test("report validation enforces the exact envelope, states, partitions, and integration block", async () => {
  const base = verifyStaticInput(validateInput(withRoot(await readFixture("pass"), "static-verifier/fixtures/closure/pass")));
  const clone = () => structuredClone(base);

  const extraKey = clone();
  extraKey.extra = true;
  fails("report_shape", () => validateReport(extraKey));

  const wrongReason = clone();
  wrongReason.state = "failed";
  fails("report_state_reason", () => validateReport(wrongReason));

  const wrongSummary = clone();
  wrongSummary.summary.passed = 0;
  fails("report_summary_state", () => validateReport(wrongSummary));

  const wrongDenominator = structuredClone(verifyStaticInput(validateInput(await readFixture("blocked"))));
  wrongDenominator.summary.passDenominator = 1;
  fails("report_summary_denominator", () => validateReport(wrongDenominator));

  const driftedIdentity = clone();
  driftedIdentity.targetAssemblies.required[0].relativePath = "Other.dll";
  fails("report_target_identity", () => validateReport(driftedIdentity));

  const overlapped = clone();
  overlapped.targetAssemblies.present.push({ id: "gamebuddy-stardew-mod", relativePath: "GameBuddy.Stardew.dll" });
  fails("report_target_partition", () => validateReport(overlapped));

  const overlappedContract = clone();
  overlappedContract.contractOutputs.missing.push(overlappedContract.contractOutputs.present[0]);
  fails("report_contract_partition", () => validateReport(overlappedContract));

  const driftedCheck = clone();
  driftedCheck.checks[0].id = "other-check";
  fails("report_check_identity", () => validateReport(driftedCheck));

  const driftedCheckState = clone();
  driftedCheckState.checks[0].state = "failed";
  fails("report_check_state", () => validateReport(driftedCheckState));

  const driftedIntegration = clone();
  driftedIntegration.integration.status = "integrated";
  fails("report_integration_status", () => validateReport(driftedIntegration));

  const driftedRequirements = clone();
  driftedRequirements.integration.required = ["changed"];
  fails("report_integration_required", () => validateReport(driftedRequirements));

  const unusableWithoutReason = clone();
  unusableWithoutReason.targetAssemblies.unusable.push({ id: "gamebuddy-stardew-mod", relativePath: "GameBuddy.Stardew.dll" });
  fails("report_target_unusable_shape", () => validateReport(unusableWithoutReason));
});

test("the capability contract is separate from the portfolio contract", async () => {
  const portfolio = JSON.parse(await readFile(path.join(path.dirname(path.dirname(fixtureDirectory)), "portfolio.json"), "utf8"));
  assert.notEqual(portfolio.schema, INPUT_SCHEMA);
  assert.ok(!portfolio.entries.some((entry) => /static-verifier|static_verifier/.test(entry.id)));
  fails("input_shape", () => validateInput(portfolio));

  const sources = await Promise.all([
    readFile(path.join(path.dirname(fixtureDirectory), "schema.mjs"), "utf8"),
    readFile(path.join(path.dirname(fixtureDirectory), "verifier.mjs"), "utf8"),
  ]);
  for (const source of sources) {
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    for (const specifier of imports) {
      assert.match(specifier, /^(?:node:)?[a-z-]+$|^\.\/schema\.mjs$/, `unexpected import ${specifier}`);
    }
    assert.doesNotMatch(source, /portfolio\.json|portfolio\.mjs/);
    assert.doesNotMatch(source, /(?:from|import)\s+["'](?:\.\.\/){2,}/);
  }

  const report = verifyStaticInput(validateInput(withRoot(await readFixture("pass"), "static-verifier/fixtures/closure/pass")));
  assert.equal(report.integration.status, "not-integrated");
  assert.deepEqual(report.integration.required, INTEGRATION_REQUIREMENTS);
});

test("the missing-target fixture factory preserves the exact frozen identity", async () => {
  const fixture = createMissingTargetFixture(await readFixture("pass"));
  assert.equal(Object.isFrozen(fixture), true);
  assert.deepEqual(fixture.targetAssemblies, TARGET_ASSEMBLIES);
  assert.deepEqual(validateInput(fixture).contractOutputs, CONTRACT_OUTPUTS);
});