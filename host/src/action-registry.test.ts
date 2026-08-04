import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACTION_POLICY,
  PUBLISHED_STARDEW_ACTIONS,
  STARDEW_ACTION_REGISTRY,
  searchVisibleActions,
  visiblePublishedActions,
} from "./action-registry.js";

test("default consent exposes only published live capabilities", () => {
  const visible = visiblePublishedActions(["move_to_tile", "equip_tool", "travel", "enter_exit", "pickup_forage", "pickup_item", "water_crop", "plant_seed", "fertilize_tile", "machine_inspect", "use_item", "harvest_crop", "end_day"]);
  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile", "equip_tool", "travel", "enter_exit", "pickup_forage", "pickup_item", "water_crop", "plant_seed", "fertilize_tile", "machine_inspect", "use_item", "harvest_crop"]);
  assert.equal(PUBLISHED_STARDEW_ACTIONS.length, 15);
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "travel" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "till_soil" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "pickup_forage" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "pickup_item" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "water_crop" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "plant_seed" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "fertilize_tile" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "clear_debris" && entry.lifecycle === "experimental"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "machine_inspect" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "collect_resource" && entry.lifecycle === "experimental"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "pet_animal" && entry.lifecycle === "experimental"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "collect_animal_product" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "feed_animal" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "use_item" && entry.lifecycle === "published"));
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "harvest_crop" && entry.lifecycle === "published"));
  assert.deepEqual(PUBLISHED_STARDEW_ACTIONS.map((entry) => entry.actionId), ["move_to_tile", "equip_tool", "travel", "enter_exit", "till_soil", "pickup_forage", "pickup_item", "water_crop", "plant_seed", "fertilize_tile", "machine_inspect", "collect_animal_product", "feed_animal", "use_item", "harvest_crop"]);
  assert.equal(new Set(STARDEW_ACTION_REGISTRY.map((entry) => entry.actionId)).size, STARDEW_ACTION_REGISTRY.length);
  assert.ok(STARDEW_ACTION_REGISTRY.some((entry) => entry.actionId === "end_day" && entry.lifecycle === "planned"));
});

test("denied action is absent from every visible query result", () => {
  const policy = { ...DEFAULT_ACTION_POLICY, deniedActions: ["equip_tool"] } as const;
  const visible = visiblePublishedActions(["move_to_tile", "equip_tool", "travel"], policy);
  const searched = searchVisibleActions(["move_to_tile", "equip_tool", "travel"], "equip", policy);

  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile", "travel"]);
  assert.deepEqual(searched, []);
});

test("denied family removes all actions in that family without a denial oracle", () => {
  const policy = { ...DEFAULT_ACTION_POLICY, deniedFamilies: ["body_tools"] } as const;
  const visible = visiblePublishedActions(["move_to_tile", "equip_tool", "travel"], policy);

  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile", "travel"]);
  assert.deepEqual(searchVisibleActions(["move_to_tile", "equip_tool", "travel"], "body_tools", policy), []);
});

test("unpublished capabilities never become visible through the registry", () => {
  const visible = visiblePublishedActions(["end_day", "shop_buy", "move_to_tile"]);

  assert.deepEqual(visible.map((entry) => entry.actionId), ["move_to_tile"]);
});
