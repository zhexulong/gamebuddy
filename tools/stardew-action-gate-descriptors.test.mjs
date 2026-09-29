import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  GATE_EXEMPT_PUBLISHED_ACTIONS,
  readAllPublishedExecutionStardewActionIds,
  readPublishedStardewActionIds,
} from "./lib/stardew-published-action-registry.mjs";
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

test("every published execution action is either gated or an explicitly declared exemption", async () => {
  // The assertion above compares the descriptor set against a projection that
  // has already had the exemptions removed, so it agrees with itself no matter
  // how many actions the exemptions hide. This test states the partition
  // instead: published execution actions split into "has a descriptor" and
  // "is named in GATE_EXEMPT_PUBLISHED_ACTIONS", with nothing in neither and
  // nothing in both.
  const gateActionIds = new Set(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => gate.actionId));
  const exempt = new Set(GATE_EXEMPT_PUBLISHED_ACTIONS.map((entry) => entry.actionId));
  const allPublished = new Set(await readAllPublishedExecutionStardewActionIds());

  const neither = [...allPublished].filter((id) => !gateActionIds.has(id) && !exempt.has(id));
  const both = [...allPublished].filter((id) => gateActionIds.has(id) && exempt.has(id));
  const unknownExemption = [...exempt].filter((id) => !allPublished.has(id));

  assert.deepEqual(neither, [], `published actions with no descriptor and no exemption: ${neither.join(", ")}`);
  assert.deepEqual(both, [], `published actions that are both gated and exempt: ${both.join(", ")}`);
  assert.deepEqual(unknownExemption, [], `exemptions naming actions that are not published: ${unknownExemption.join(", ")}`);

  // Every exemption must name a runner that actually exists, so the carve-out
  // carries evidence rather than prose alone.
  for (const entry of GATE_EXEMPT_PUBLISHED_ACTIONS) {
    assert.match(entry.runner, /^run-stardew-[a-z0-9-]+\.mjs$/, `${entry.actionId} exemption runner shape`);
    assert.match(entry.terminalReasonCode, /^[a-z][a-z0-9_]{1,127}$/, `${entry.actionId} exemption reason code`);
    await access(resolve(ROOT, "tools", entry.runner), constants.R_OK);
    const source = await readFile(resolve(ROOT, "tools", entry.runner), "utf8");
    assert.ok(
      source.includes(`"${entry.actionId}"`),
      `${entry.runner} must drive ${entry.actionId}`,
    );
    assert.ok(
      source.includes(`"${entry.terminalReasonCode}"`),
      `${entry.runner} must assert terminal reason code ${entry.terminalReasonCode}`,
    );
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
    // Promoted to live_verified by a real native-local run: express_emote and
    // face_direction share one runner because one fixture turn proves both
    // actor-expression mutations in the same revision chain.
    express_emote: "run-stardew-native-local-player-expression-smoke.mjs",
    // Promoted to live_verified: a real shared-world run proved each one on its
    // required topology (pet_animal: Host LAN + AI Farmhand, pet_completed;
    // interact_npc_with_item: native-local quest_item_delivered; advance_day:
    // co-op day_advanced, ready 2/2).
    pet_animal: "run-stardew-native-local-player-pet-animal-smoke.mjs",
    interact_npc_with_item: "run-stardew-native-local-player-interact-npc-with-item-smoke.mjs",
    advance_day: "run-stardew-native-local-player-advance-day-smoke.mjs",
    face_direction: "run-stardew-native-local-player-expression-smoke.mjs",
    // Promoted to live_verified in the same ladder: every remaining experimental
    // action has now passed its own native-local run, so each names the
    // shared-harness route that produced it.
    clear_debris: "run-stardew-native-local-player-clear-debris-smoke.mjs",
    npc_relationship: "run-stardew-native-local-player-npc-relationship-smoke.mjs",
    water_pet_bowl: "run-stardew-native-local-player-water-pet-bowl-smoke.mjs",
    water_slime_hutch_trough: "run-stardew-native-local-player-water-slime-hutch-trough-smoke.mjs",
    chest_store: "run-stardew-native-local-player-chest-store-smoke.mjs",
    chest_retrieve: "run-stardew-native-local-player-chest-retrieve-smoke.mjs",
    chop_stump: "run-stardew-native-local-player-chop-stump-smoke.mjs",
    plant_sapling: "run-stardew-native-local-player-plant-sapling-smoke.mjs",
    cut_weeds: "run-stardew-native-local-player-cut-weeds-smoke.mjs",
    scythe_crop: "run-stardew-native-local-player-scythe-crop-smoke.mjs",
    craft_item: "run-stardew-native-local-player-craft-item-smoke.mjs",
    cook_recipe: "run-stardew-native-local-player-cook-recipe-smoke.mjs",
    collect_crab_pot_output: "run-stardew-native-local-player-crab-pot-collect-smoke.mjs",
    ship_item: "run-stardew-native-local-player-ship-item-smoke.mjs",
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
      "express_emote",
      "face_direction",
      "pet_animal",
      "interact_npc_with_item",
      "clear_debris",
      "npc_relationship",
      "water_pet_bowl",
      "water_slime_hutch_trough",
      "chest_store",
      "chest_retrieve",
      "chop_stump",
      "plant_sapling",
      "cut_weeds",
      "scythe_crop",
      "craft_item",
      "cook_recipe",
      "collect_crab_pot_output",
      "ship_item",
    ],
  );
  assert.deepEqual(
    STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario === null).map((gate) => gate.actionId),
    ["move_to_tile", "equip_tool", "travel", "enter_exit", "advance_day"],
  );
});
