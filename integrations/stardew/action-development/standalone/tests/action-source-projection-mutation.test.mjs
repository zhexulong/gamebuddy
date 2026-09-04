import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY,
  deriveActionSourceProjection,
  loadSources,
} from "../src/action-source-projection-producer.mjs";

const sourceRoot = path.resolve(ACTION_SOURCE_PROJECTION_PRODUCER_DIRECTORY, "../inputs/action-projection-source");
const sources = await loadSources(sourceRoot);

function expectRejection(overrides, code) {
  assert.throws(
    () => deriveActionSourceProjection({ ...sources, ...overrides }),
    (error) => error instanceof Error && error.message === `stardew_action_source_projection_${code}`,
  );
}

test("standalone runner and fixture sources derive the exact published parity projection", () => {
  const projection = deriveActionSourceProjection(sources);
  assert.equal(projection.runnerFixtureParity.actions.length, 25);
  assert.deepEqual(projection.runnerFixtureParity.actions.slice(0, 5), [
    { actionId: "move_to_tile", runner: "run-stardew-native-local-player-move-smoke.mjs", fixtureScenario: null },
    { actionId: "equip_tool", runner: "run-stardew-native-local-player-equip-tool-smoke.mjs", fixtureScenario: null },
    { actionId: "travel", runner: "run-stardew-native-local-player-travel-smoke.mjs", fixtureScenario: null },
    { actionId: "enter_exit", runner: "run-stardew-native-local-player-enter-exit-smoke.mjs", fixtureScenario: null },
    { actionId: "till_soil", runner: "run-stardew-native-local-player-till-soil-smoke.mjs", fixtureScenario: "native_till_soil_v1" },
  ]);
  assert.equal(projection.runnerFixtureParity.obsoleteRunnerFilenamesAbsent.length, 25);
});

test("standalone gate metadata does not suppress Host-supported executable actions", () => {
  const withoutEquipGate = sources.gate_descriptors.replace(
    '  gate("equip_tool", 1, "run-stardew-native-local-player-equip-tool-smoke.mjs", "tool_selected"),\n',
    "",
  );
  assert.notEqual(withoutEquipGate, sources.gate_descriptors, "equip_tool gate anchor must match");
  const projection = deriveActionSourceProjection({ ...sources, gate_descriptors: withoutEquipGate });
  assert.ok(projection.mod.executableActionIds.includes("equip_tool"));
});

test("standalone runner source mutations fail closed and fixture drift remains observable", () => {
  const runnerSources = JSON.parse(sources.runner_sources);
  const missing = structuredClone(runnerSources);
  delete missing.files["run-stardew-native-local-player-equip-tool-smoke.mjs"];
  expectRejection({ runner_sources: JSON.stringify(missing) }, "runner_missing:equip_tool");

  const wrongImport = structuredClone(runnerSources);
  wrongImport.files["run-stardew-native-local-player-equip-tool-smoke.mjs"] = wrongImport.files[
    "run-stardew-native-local-player-equip-tool-smoke.mjs"
  ].replace("./lib/stardew-native-smoke-harness-v1.mjs", "./lib/wrong-harness.mjs");
  expectRejection({ runner_sources: JSON.stringify(wrongImport) }, "runner_shared_harness_import_missing:equip_tool");

  const obsolete = structuredClone(runnerSources);
  obsolete.entries.push("run-stardew-equip-tool-smoke.mjs");
  expectRejection(
    { runner_sources: JSON.stringify(obsolete) },
    "obsolete_runner_present:run-stardew-equip-tool-smoke.mjs",
  );

  const fixtureDrift = sources.gate_descriptors.replace("native_till_soil_v1", "native_till_soil_v2");
  const changed = deriveActionSourceProjection({ ...sources, gate_descriptors: fixtureDrift });
  assert.equal(changed.runnerFixtureParity.actions[4].fixtureScenario, "native_till_soil_v2");
});
