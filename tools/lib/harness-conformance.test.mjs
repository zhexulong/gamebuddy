// One falsifier per check: each check must be able to report its own finding when the wiring it guards is
// broken, and must stay silent on the real checkout's good wiring.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { preflightLiveRun } from "./live-run-preflight.mjs";
import {
  checkExperimentalRunners,
  checkGateFalsifiers,
  checkLiveRunPreflight,
  checkRunnerResolution,
  checkScenarioAcceptance,
  harnessGateNames,
  readModFixtureSources,
} from "./harness-conformance.mjs";

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
