import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACTION_POLICY,
  PUBLISHED_STARDEW_ACTIONS,
  STARDEW_ACTION_REGISTRY,
  parseActionPolicy,
  isMaterializablePublishedAction,
  RETIRED_ACTION_POLICY_MIGRATIONS,
  searchVisibleActions,
  visiblePublishedActions,
} from "./action-registry.js";

test("default consent exposes only published live capabilities", () => {
  const visible = visiblePublishedActions([
    "move_to_tile",
    "equip_tool",
    "travel",
    "enter_exit",
    "pickup_forage",
    "pickup_item",
    "water_crop",
    "refill_watering_can",
    "plant_seed",
    "fertilize_tile",
    "machine_inspect",
    "use_item",
    "harvest_crop",
    "end_day",
  ]);
  assert.deepEqual(
    visible.map((entry) => entry.actionId),
    [
      "move_to_tile",
      "equip_tool",
      "travel",
      "enter_exit",
      "pickup_forage",
      "pickup_item",
      "water_crop",
      "refill_watering_can",
      "plant_seed",
      "fertilize_tile",
      "machine_inspect",
      "use_item",
      "harvest_crop",
    ],
  );
  assert.equal(PUBLISHED_STARDEW_ACTIONS.length, 25);
  assert.ok(
    STARDEW_ACTION_REGISTRY.some(
      (entry) => entry.actionId === "travel" && entry.actionClass === "primitive" && entry.lifecycle === "published",
    ),
  );
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "till_soil" && entry.lifecycle === "published"));
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "pickup_forage" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "pickup_item" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "water_crop" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some(
      (entry) =>
        entry.actionId === "refill_watering_can" &&
        entry.familyId === "farming_crops" &&
        entry.actionClass === "primitive" &&
        entry.lifecycle === "published",
    ),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "plant_seed" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "fertilize_tile" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "clear_debris" && entry.lifecycle === "experimental"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "machine_inspect" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some(
      (entry) =>
        entry.actionId === "machine_load" &&
        entry.familyId === "machines_processing" &&
        entry.lifecycle === "published",
    ),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some(
      (entry) =>
        entry.actionId === "machine_collect_output" &&
        entry.familyId === "machines_processing" &&
        entry.lifecycle === "published",
    ),
  );
  assert.equal(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "collect_resource"),
    false,
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "pet_animal" && entry.lifecycle === "experimental"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some(
      (entry) => entry.actionId === "collect_animal_product" && entry.lifecycle === "published",
    ),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "feed_animal" && entry.lifecycle === "published"),
  );
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "use_item" && entry.lifecycle === "published"));
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "harvest_crop" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "break_rock_source" && entry.lifecycle === "published"),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some(
      (entry) =>
        entry.actionId === "clear_hoedirt" &&
        entry.familyId === "farming_crops" &&
        entry.actionClass === "primitive" &&
        entry.lifecycle === "published",
    ),
  );
  assert.ok(
    STARDEW_ACTION_REGISTRY.some(
      (entry) =>
        entry.actionId === "chop_tree_source" &&
        entry.familyId === "resource_gathering" &&
        entry.actionClass === "primitive" &&
        entry.lifecycle === "published",
    ),
  );
  assert.deepEqual(
    PUBLISHED_STARDEW_ACTIONS.map((entry) => entry.actionId),
    [
      "move_to_tile",
      "equip_tool",
      "travel",
      "enter_exit",
      "till_soil",
      "pickup_forage",
      "pickup_item",
      "water_crop",
      "refill_watering_can",
      "plant_seed",
      "fertilize_tile",
      "place_wood_fence",
      "place_crab_pot",
      "bait_crab_pot",
      "machine_inspect",
      "machine_load",
      "machine_collect_output",
      "collect_animal_product",
      "feed_animal",
      "use_item",
      "harvest_crop",
      "break_rock_source",
      "clear_hoedirt",
      "dig_artifact_spot",
      "chop_tree_source",
    ],
  );
  assert.equal(new Set(STARDEW_ACTION_REGISTRY.map((entry) => entry.actionId)).size, STARDEW_ACTION_REGISTRY.length);
  assert.ok(STARDEW_ACTION_REGISTRY.every((entry) => entry.actionClass === "primitive"));
  assert.ok(
    STARDEW_ACTION_REGISTRY.every(
      (entry) => isMaterializablePublishedAction(entry) === (entry.lifecycle === "published"),
    ),
  );
  assert.equal(
    STARDEW_ACTION_REGISTRY.some((entry) => entry.lifecycle === "planned"),
    false,
  );
});

test("retired action identifiers require an explicit fail-closed migration", () => {
  assert.deepEqual(RETIRED_ACTION_POLICY_MIGRATIONS.collect_resource, [
    "chop_tree_source",
    "break_rock_source",
    "pickup_item",
  ]);
  assert.throws(
    () => parseActionPolicy({ policyVersion: 1, deniedActions: ["collect_resource"], deniedFamilies: [] }),
    /retired_action_policy_identifier_requires_explicit_migration/,
  );
});

test("denied action is absent from every visible query result", () => {
  const policy = { ...DEFAULT_ACTION_POLICY, deniedActions: ["equip_tool"] } as const;
  const visible = visiblePublishedActions(["move_to_tile", "equip_tool", "travel"], policy);
  const searched = searchVisibleActions(["move_to_tile", "equip_tool", "travel"], "equip", policy);

  assert.deepEqual(
    visible.map((entry) => entry.actionId),
    ["move_to_tile", "travel"],
  );
  assert.deepEqual(searched, []);
});

test("denied family removes all actions in that family without a denial oracle", () => {
  const policy = { ...DEFAULT_ACTION_POLICY, deniedFamilies: ["body_tools"] } as const;
  const visible = visiblePublishedActions(["move_to_tile", "equip_tool", "travel"], policy);

  assert.deepEqual(
    visible.map((entry) => entry.actionId),
    ["move_to_tile", "travel"],
  );
  assert.deepEqual(searchVisibleActions(["move_to_tile", "equip_tool", "travel"], "body_tools", policy), []);
});

test("refill_watering_can is capability-gated and can be explicitly denied", () => {
  assert.deepEqual(
    visiblePublishedActions(["move_to_tile"]).map((entry) => entry.actionId),
    ["move_to_tile"],
  );
  assert.deepEqual(
    visiblePublishedActions(["move_to_tile", "refill_watering_can"]).map((entry) => entry.actionId),
    ["move_to_tile", "refill_watering_can"],
  );

  const denyAction = { ...DEFAULT_ACTION_POLICY, deniedActions: ["refill_watering_can"] } as const;
  const denyFamily = { ...DEFAULT_ACTION_POLICY, deniedFamilies: ["farming_crops"] } as const;
  assert.deepEqual(visiblePublishedActions(["refill_watering_can"], denyAction), []);
  assert.deepEqual(visiblePublishedActions(["refill_watering_can"], denyFamily), []);
});

test("unpublished or retired capabilities never become visible through the registry", () => {
  const visible = visiblePublishedActions(["end_day", "shop_buy", "collect_resource", "move_to_tile"]);

  assert.deepEqual(
    visible.map((entry) => entry.actionId),
    ["move_to_tile"],
  );
});
