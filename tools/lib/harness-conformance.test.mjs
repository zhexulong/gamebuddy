// One falsifier per check: each check must be able to report its own finding when the wiring it guards is
// broken, and must stay silent on the real checkout's good wiring.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkExperimentalRunners,
  checkGateFalsifiers,
  checkLiveRunPreflight,
  checkRunnerResolution,
  checkScenarioAcceptance,
  harnessGateNames,
  readModFixtureSources,
} from "./harness-conformance.mjs";
import { preflightLiveRun } from "./live-run-preflight.mjs";

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(toolsDir, "..");

test("preflight check reports a preflight that misses a bad tree", () => {
  const blindPreflight = () => ({ ok: true, checks: [], firstFailure: null });
  const findings = checkLiveRunPreflight({ preflight: blindPreflight });
  assert.ok(
    findings.some((entry) => entry.code === "preflight_missed_a_bad_tree"),
    `expected a missed-tree finding, got ${JSON.stringify(findings)}`,
  );

  assert.deepEqual(checkLiveRunPreflight({ preflight: preflightLiveRun }), []);
});

test("scenario check reports a fixture-library mapping the Mod never learned, and no run plan can rescue it", () => {
  const modSources = [
    { file: "ModEntry.Fixtures.cs", source: 'FixtureScenario is not ("native_till_soil_v1")' },
    {
      file: "ModEntry.Fixtures.MultiDay.cs",
      source: 'fixture.FixtureScenario == "native_multi_day_play_session_v1"',
    },
  ];

  // The fixture library's own mapping is the authority: a name the Mod's switch does not name is the
  // finding on its own, with no run-plan record in sight.
  const noPlan = checkScenarioAcceptance({
    modSources,
    fixture: { actions: () => ["till_soil"], scenario: () => "native_absent_v1" },
    publishedScenarios: new Map(),
    actionIds: ["till_soil"],
  });
  assert.deepEqual(
    noPlan.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );

  // The exact defect the old fallback masked: the fixture library named `native_respond_level_up_v1` (a
  // world the Mod's switch has never had) while the run plan recorded `native_multi_day_play_session_v1`
  // (accepted). The plan is a second authority for the same fact, and its disagreement is a finding, not
  // a rescue - the fixture library's own mapping must itself be accepted.
  const maskedByPlan = checkScenarioAcceptance({
    modSources,
    fixture: { actions: () => ["respond_level_up"], scenario: () => "native_respond_level_up_v1" },
    publishedScenarios: new Map([["respond_level_up", "native_multi_day_play_session_v1"]]),
    actionIds: ["respond_level_up"],
  });
  assert.deepEqual(
    maskedByPlan.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );
  assert.match(maskedByPlan[0].detail, /second authority for the same fact that disagrees/u);

  // A run plan that records an unknown world too is still the same finding.
  const planAlsoUnknown = checkScenarioAcceptance({
    modSources,
    fixture: { actions: () => ["till_soil"], scenario: () => "native_absent_v1" },
    publishedScenarios: new Map([["till_soil", "native_absent_plan_v1"]]),
    actionIds: ["till_soil"],
  });
  assert.deepEqual(
    planAlsoUnknown.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );

  // The real checkout's own wiring is conformant.
  assert.deepEqual(checkScenarioAcceptance({ modSources: readModFixtureSources(repoRoot) }), []);
});

test("runner check reports a runner that is not on disk", () => {
  const findings = checkRunnerResolution({
    actionIds: ["till_soil"],
    resolve: () => "run-stardew-native-local-player-does-not-exist.mjs",
    toolsDir,
  });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["runner_not_found"],
  );

  assert.deepEqual(checkRunnerResolution({ toolsDir }), []);
});

// The property is "importing it starts nothing", so the falsifier is a runner that starts something on import - with
// `import.meta.main` written in it, which is all the source-text form this check replaced ever looked for.
test("runner check imports the runner and reports one that starts on import", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-runner-"));
  try {
    const stubTools = join(root, "tools");
    mkdirSync(stubTools, { recursive: true });
    const stub = "run-stub-smoke.mjs";
    writeFileSync(
      join(stubTools, stub),
      '// import.meta.main is named in this comment and nowhere else\nprocess.stdout.write("session started\\n");\n',
    );
    const findings = checkRunnerResolution({ actionIds: ["till_soil"], resolve: () => stub, toolsDir: stubTools });
    assert.deepEqual(
      findings.map((entry) => entry.code),
      ["runner_missing_cli"],
    );
    assert.match(findings[0].detail, /import printed: session started/u);

    // The control: a runner whose CLI really is gated imports silently and passes.
    writeFileSync(join(stubTools, stub), 'if (import.meta.main) process.stdout.write("session started\\n");\n');
    assert.deepEqual(checkRunnerResolution({ actionIds: ["till_soil"], resolve: () => stub, toolsDir: stubTools }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(checkRunnerResolution({ toolsDir }), []);
});

test("experimental runner check reports a descriptor runner that is not on disk", () => {
  const findings = checkExperimentalRunners({
    runners: { absent_action: "run-stardew-native-local-player-absent.mjs" },
    toolsDir,
  });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["experimental_runner_missing"],
  );

  assert.deepEqual(checkExperimentalRunners({ toolsDir }), []);
});

test("gate check reports a gate that neither self-reports nor is declared", () => {
  const findings = checkGateFalsifiers({ gateNames: ["check-a-gate-nobody-classified.mjs"], toolsDir });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["gate_without_falsifier"],
  );

  assert.deepEqual(checkGateFalsifiers({ gateNames: harnessGateNames(toolsDir), toolsDir }), []);
});

// The report is what the gate PRINTS, so the falsifier deletes the print while keeping the words the source-text form
// looked for: a comment naming `checks` and `mode:` satisfies a regex and proves nothing about the run. The stub lives
// in its own directory so it is never picked up as a real gate by `harnessGateNames`.
test("gate check reads the report a gate prints, not the words in its source", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-gates-"));
  try {
    const stubTools = join(root, "tools");
    mkdirSync(stubTools, { recursive: true });
    const stub = "check-stub-gate.mjs";
    writeFileSync(
      join(stubTools, stub),
      '// this gate prints checks and mode: in a comment, and a human line on stdout\nprocess.stdout.write("all good\\n");\n',
    );
    const findings = checkGateFalsifiers({ gateNames: [stub], withFalsifier: [stub], toolsDir: stubTools });
    assert.deepEqual(
      findings.map((entry) => entry.code),
      ["falsifier_signature_missing"],
    );
    assert.match(findings[0].detail, /the default run printed no self-verification report \(exit 0\)/u);

    // The control: the same file, printing a report, passes - so the finding above is about the artifact.
    writeFileSync(
      join(stubTools, stub),
      'const checks = [{ id: "one_rule", status: "passed" }];\nprocess.stdout.write(`${JSON.stringify({ gate: "stub/v1", status: "passed", checks })}\\n`);\n',
    );
    assert.deepEqual(checkGateFalsifiers({ gateNames: [stub], withFalsifier: [stub], toolsDir: stubTools }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
