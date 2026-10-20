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
import { fixtureActions, fixtureScenario } from "./stardew-native-local-player-fixture.mjs";

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

test("scenario check reports a scenario the Mod's fixture code does not name", () => {
  const findings = checkScenarioAcceptance({
    modSources: [{ file: "ModEntry.Fixtures.cs", source: 'FixtureScenario is not ("native_till_soil_v1")' }],
    fixture: { actions: () => ["till_soil"], scenario: () => "native_absent_v1" },
    publishedScenarios: new Map(),
    actionIds: ["till_soil"],
  });
  assert.deepEqual(
    findings.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );

  assert.deepEqual(checkScenarioAcceptance({ modSources: readModFixtureSources(repoRoot) }), []);

  // The plan's world only rescues an action when the switch actually names it: a run plan that records an
  // unknown world too is still a finding.
  const planAlsoUnknown = checkScenarioAcceptance({
    modSources: [{ file: "ModEntry.Fixtures.cs", source: '"native_other_v1"' }],
    fixture: { actions: fixtureActions, scenario: fixtureScenario },
    publishedScenarios: new Map([["till_soil", "native_absent_plan_v1"]]),
    actionIds: ["till_soil"],
  });
  assert.deepEqual(
    planAlsoUnknown.map((entry) => entry.code),
    ["scenario_not_accepted_by_mod"],
  );
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
