import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { readPublishedStardewActionIds } from "./lib/stardew-published-action-registry.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("published action descriptors are complete, unique, and point to declared runner contracts", async () => {
  const gates = STARDEW_PUBLISHED_ACTION_GATES;
  const publishedActionIds = await readPublishedStardewActionIds();
  const gateActionIds = gates.map((gate) => gate.actionId);
  assert.equal(new Set(gateActionIds).size, gateActionIds.length);
  assert.equal(new Set(publishedActionIds).size, publishedActionIds.length);
  assert.deepEqual(new Set(gateActionIds), new Set(publishedActionIds));

  for (const gate of gates) {
    assert.match(gate.actionId, /^[a-z][a-z0-9_]{1,127}$/);
    assert.match(gate.terminalReasonCode, /^[a-z][a-z0-9_]{1,127}$/);
    assert.match(gate.runner, /^run-stardew-[a-z0-9-]+\.mjs$/);
    if (gate.fixtureScenario !== null) assert.match(gate.fixtureScenario, /^native_[a-z0-9_]+_v\d+$/);

    const runnerPath = resolve(ROOT, "tools", gate.runner);
    await access(runnerPath, constants.R_OK);
  }
});

test("descriptor runner identity names the native-local shared-harness runner for every published gate", async () => {
  // Golden mapping: each published ordinary Farmhand action resolves to the
  // actual native-local route (run-stardew-native-local-player-*), which is
  // the shared-harness runner. Any parallel/legacy runner ID is stale.
  const expectedRunners = Object.freeze({
    move_to_tile: "run-stardew-native-local-player-move-smoke.mjs",
    equip_tool: "run-stardew-native-local-player-equip-tool-smoke.mjs",
    travel: "run-stardew-native-local-player-travel-smoke.mjs",
    enter_exit: "run-stardew-native-local-player-enter-exit-smoke.mjs",
    till_soil: "run-stardew-native-local-player-till-soil-smoke.mjs",
    pickup_forage: "run-stardew-native-local-player-pickup-forage-smoke.mjs",
    pickup_item: "run-stardew-native-local-player-pickup-item-smoke.mjs",
    water_crop: "run-stardew-native-local-player-water-crop-smoke.mjs",
    plant_seed: "run-stardew-native-local-player-plant-seed-smoke.mjs",
    fertilize_tile: "run-stardew-native-local-player-fertilize-tile-smoke.mjs",
    machine_inspect: "run-stardew-native-local-player-machine-inspect-smoke.mjs",
    machine_load: "run-stardew-native-local-player-machine-load-smoke.mjs",
    machine_collect_output: "run-stardew-native-local-player-machine-collect-output-smoke.mjs",
    collect_animal_product: "run-stardew-native-local-player-collect-animal-product-smoke.mjs",
    feed_animal: "run-stardew-native-local-player-feed-animal-smoke.mjs",
    use_item: "run-stardew-native-local-player-use-item-smoke.mjs",
    harvest_crop: "run-stardew-native-local-player-harvest-crop-smoke.mjs",
    refill_watering_can: "run-stardew-native-local-player-refill-watering-can-smoke.mjs",
    break_rock_source: "run-stardew-native-local-player-break-rock-source-smoke.mjs",
    clear_hoedirt: "run-stardew-native-local-player-clear-hoedirt-smoke.mjs",
    dig_artifact_spot: "run-stardew-native-local-player-dig-artifact-spot-smoke.mjs",
    chop_tree_source: "run-stardew-native-local-player-chop-tree-source-smoke.mjs",
    place_wood_fence: "run-stardew-native-local-player-place-wood-fence-smoke.mjs",
    place_crab_pot: "run-stardew-native-local-player-place-crab-pot-smoke.mjs",
    bait_crab_pot: "run-stardew-native-local-player-bait-crab-pot-smoke.mjs",
  });
  // Obsolete parallel-route runner IDs that must never be re-selected.
  const forbiddenRouteIds = Object.freeze([
    "run-stardew-move-probe.mjs",
    "run-stardew-clear-debris-smoke.mjs",
    "run-stardew-collect-animal-product-smoke.mjs",
    "run-stardew-enter-exit-smoke.mjs",
    "run-stardew-equip-tool-smoke.mjs",
    "run-stardew-feed-animal-smoke.mjs",
    "run-stardew-fertilize-tile-smoke.mjs",
    "run-stardew-harvest-crop-fixture-smoke.mjs",
    "run-stardew-harvest-crop-smoke.mjs",
    "run-stardew-machine-inspect-fixture-smoke.mjs",
    "run-stardew-machine-inspect-smoke.mjs",
    "run-stardew-npc-relationship-fixture-smoke.mjs",
    "run-stardew-npc-relationship-smoke.mjs",
    "run-stardew-pet-animal-smoke.mjs",
    "run-stardew-pickup-forage-fixture-smoke.mjs",
    "run-stardew-pickup-forage-smoke.mjs",
    "run-stardew-pickup-item-fixture-smoke.mjs",
    "run-stardew-pickup-item-smoke.mjs",
    "run-stardew-plant-seed-fixture-smoke.mjs",
    "run-stardew-plant-seed-smoke.mjs",
    "run-stardew-till-soil-fixture-smoke.mjs",
    "run-stardew-till-soil-smoke.mjs",
    "run-stardew-travel-smoke.mjs",
    "run-stardew-use-item-smoke.mjs",
    "run-stardew-water-crop-smoke.mjs",
  ]);

  assert.deepEqual(
    Object.fromEntries(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => [gate.actionId, gate.runner])),
    expectedRunners,
  );
  const toolEntries = await readdir(resolve(ROOT, "tools"));
  for (const gate of STARDEW_PUBLISHED_ACTION_GATES) {
    assert.match(gate.runner, /^run-stardew-native-local-player-[a-z0-9-]+\.mjs$/);
    assert.equal(forbiddenRouteIds.includes(gate.runner), false, `${gate.runner} is an obsolete route ID`);
    const runnerSource = await readFile(resolve(ROOT, "tools", gate.runner), "utf8");
    assert.match(
      runnerSource,
      /from "\.\/lib\/stardew-native-smoke-harness-v1\.mjs"/,
      `${gate.runner} must be a shared-harness runner`,
    );
    assert.doesNotMatch(runnerSource, /host-production-module/, `${gate.runner} must not use the legacy host route`);
  }
  for (const route of forbiddenRouteIds)
    assert.equal(toolEntries.includes(route), false, `${route} must be deleted rather than merely de-selected`);
});

test("fixture-backed descriptor coverage is explicit rather than inferred", () => {
  const fixtureBacked = STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario !== null);
  assert.deepEqual(
    fixtureBacked.map((gate) => gate.actionId),
    [
      "till_soil",
      "pickup_forage",
      "pickup_item",
      "water_crop",
      "plant_seed",
      "fertilize_tile",
      "machine_inspect",
      "machine_load",
      "machine_collect_output",
      "collect_animal_product",
      "feed_animal",
      "use_item",
      "harvest_crop",
      "refill_watering_can",
      "break_rock_source",
      "clear_hoedirt",
      "dig_artifact_spot",
      "chop_tree_source",
      "place_wood_fence",
      "place_crab_pot",
      "bait_crab_pot",
    ],
  );
  assert.deepEqual(
    STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario === null).map((gate) => gate.actionId),
    ["move_to_tile", "equip_tool", "travel", "enter_exit"],
  );
});
