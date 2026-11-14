// red-proof: inject  the `travel` gate row deleted from STARDEW_PUBLISHED_ACTION_GATES
//  -> `✖ published action gate rows are complete, unique, and each resolves to a gate artifact` with a deep-equal listing `- travel`, exit 1
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  describeGateRouteProblems,
  resolveStardewActionGateRoutes,
  SLICE_DRIVER,
  SMOKE_CONTRACT_DIRECTORY,
  smokeContractPath,
} from "./lib/stardew-action-gate-route.mjs";
import {
  GATE_EXEMPT_PUBLISHED_ACTIONS,
  readAllPublishedExecutionStardewActionIds,
  readPublishedStardewActionIds,
} from "./lib/stardew-published-action-registry.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("published action gate rows are complete, unique, and each resolves to a gate artifact", async () => {
  const gates = STARDEW_PUBLISHED_ACTION_GATES;
  const publishedActionIds = await readPublishedStardewActionIds();
  const gateActionIds = gates.map((gate) => gate.actionId);
  assert.equal(new Set(gateActionIds).size, gateActionIds.length);
  assert.equal(new Set(publishedActionIds).size, publishedActionIds.length);
  assert.deepEqual(new Set(gateActionIds), new Set(publishedActionIds));

  // One resolution for the whole table, so a row that resolves to nothing reports EVERY such action rather than
  // stopping the run at the first ENOENT.
  const routes = resolveStardewActionGateRoutes(gateActionIds);
  assert.equal(routes.length, gates.length, "the resolver dropped rows, which would narrow every check below");
  assert.deepEqual(
    describeGateRouteProblems(routes),
    [],
    "these gate rows do not resolve to a gate artifact that exists:\n" + describeGateRouteProblems(routes).join("\n"),
  );

  for (const [index, gate] of gates.entries()) {
    const route = routes[index];
    assert.equal(route.action, gate.actionId, "the resolver answered for a different action");
    assert.match(gate.actionId, /^[a-z][a-z0-9_]{1,127}$/);
    assert.match(gate.terminalReasonCode, /^[a-z][a-z0-9_]{1,127}$/);
    if (gate.fixtureScenario !== null) assert.match(gate.fixtureScenario, /^native_[a-z0-9_]+_v\d+$/);

    // The route decides which artifact is the gate; the row decides what the gate must prove. Both routes carry the
    // same evidence record, so these three facts cannot differ by route.
    if (route.route === "runner") {
      assert.match(gate.runner, /^run-stardew-[a-z0-9-]+\.mjs$/);
      assert.equal(route.gate, `tools/${gate.runner}`);
      assert.equal(route.executes, route.gate);
    } else {
      assert.equal(route.route, "contract", `${gate.actionId}: a row must resolve to a runner or a contract`);
      assert.equal(gate.runner, null, `${gate.actionId}: a contract row names no runner`);
      assert.equal(route.gate, smokeContractPath(gate.actionId));
      assert.equal(route.executes, SLICE_DRIVER);
    }
    assert.equal(route.evidence.action, gate.actionId);
    assert.equal(route.evidence.scenario, gate.fixtureScenario);
    assert.equal(route.evidence.terminalReasonCode, gate.terminalReasonCode);

    await access(resolve(ROOT, route.gate), constants.R_OK);
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
  assert.deepEqual(
    unknownExemption,
    [],
    `exemptions naming actions that are not published: ${unknownExemption.join(", ")}`,
  );

  // Every exemption must name a runner that actually exists, so the carve-out
  // carries evidence rather than prose alone.
  for (const entry of GATE_EXEMPT_PUBLISHED_ACTIONS) {
    assert.match(entry.runner, /^run-stardew-[a-z0-9-]+\.mjs$/, `${entry.actionId} exemption runner shape`);
    assert.match(entry.terminalReasonCode, /^[a-z][a-z0-9_]{1,127}$/, `${entry.actionId} exemption reason code`);
    await access(resolve(ROOT, "tools", entry.runner), constants.R_OK);
    const source = await readFile(resolve(ROOT, "tools", entry.runner), "utf8");
    assert.ok(source.includes(`"${entry.actionId}"`), `${entry.runner} must drive ${entry.actionId}`);
    assert.ok(
      source.includes(`"${entry.terminalReasonCode}"`),
      `${entry.runner} must assert terminal reason code ${entry.terminalReasonCode}`,
    );
  }
});

test("every published gate resolves to the native-local artifact for its route kind, never a retired route", async () => {
  // A gate row used to carry one fact - a runner filename - and this test froze all 103 of them into a golden map, so
  // retiring a runner meant editing a 103-line list before the gate could open at all: the file's existence, not the
  // action's evidence, was what made the gate real. What that map was standing in for is a PROPERTY: whichever route a
  // row takes, the artifact it names is the shared native-local one for that kind of route.
  //
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

  const gates = STARDEW_PUBLISHED_ACTION_GATES;
  const routes = resolveStardewActionGateRoutes(gates.map((gate) => gate.actionId));
  const contractGate = new RegExp(`^${SMOKE_CONTRACT_DIRECTORY}/[a-z0-9_]+\\.json$`, "u");
  const examined = { runner: 0, contract: 0 };
  const problems = [];

  for (const route of routes) {
    if (route.problem !== null) {
      problems.push(`${route.action}: ${route.problem.code} ${route.problem.detail ?? ""}`.trim());
      continue;
    }
    examined[route.route] += 1;
    if (forbiddenRouteIds.includes(route.gate.replace(/^tools\//u, "")))
      problems.push(`${route.action}: ${route.gate} is an obsolete route ID`);
    if (route.route === "runner") {
      if (!/^tools\/run-stardew-native-local-player-[a-z0-9-]+\.mjs$/u.test(route.gate)) {
        problems.push(`${route.action}: ${route.gate} is not a native-local player runner`);
        continue;
      }
      const runnerSource = await readFile(resolve(ROOT, route.gate), "utf8");
      if (!/from "\.\/lib\/stardew-native-smoke-harness-v1\.mjs"/u.test(runnerSource))
        problems.push(`${route.action}: ${route.gate} must be a shared-harness runner`);
      if (/host-production-module/u.test(runnerSource))
        problems.push(`${route.action}: ${route.gate} must not use the legacy host route`);
    } else {
      if (!contractGate.test(route.gate))
        problems.push(`${route.action}: ${route.gate} is not a contract under ${SMOKE_CONTRACT_DIRECTORY}/`);
      else if (route.contract?.action !== route.action)
        problems.push(`${route.action}: ${route.gate} does not declare ${route.action}`);
      if (route.executes !== SLICE_DRIVER)
        problems.push(`${route.action}: a contract route is run by ${SLICE_DRIVER}, not ${String(route.executes)}`);
    }
  }

  assert.deepEqual(
    problems,
    [],
    "gate routes that do not resolve to the native-local artifact for their route kind:\n" + problems.join("\n"),
  );
  // A population of zero agrees with itself, so state what was examined - and keep the runner half honest, because a
  // table that drifted to all contracts would leave the runner rules above with nothing left to check.
  assert.equal(
    examined.runner + examined.contract,
    gates.length,
    `examined ${examined.runner} runner(s) and ${examined.contract} contract(s), the gate table has ${gates.length} rows`,
  );
  assert.ok(examined.runner > 0, "no runner route was examined, so the runner half of this gate is decorative");

  const toolEntries = await readdir(resolve(ROOT, "tools"));
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
      "clear_fish_pond",
      "harvest_crop",
      "refill_watering_can",
      "break_rock",
      "clear_hoedirt",
      "dig_artifact_spot",
      "chop_tree",
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
      "ride_minecart",
      "ride_bus",
      "withdraw_silo_hay",
      "use_obelisk",
      "shop_purchase",
      "toggle_animal_door",
      "select_mine_elevator_floor",
      "cut_grass",
      "harvest_bush",
      "harvest_fruit_tree",
      "shake_tree",
      "take_pedestal_item",
      "toggle_fence_gate",
      "clear_cask",
      "dress_mannequin",
      "set_sign_display",
      "deposit_silo_hay",
      "toggle_tool_light",
      "use_raft",
      "mount_transport",
      "enter_mine",
      "dismiss_modal",
      "answer_dialogue",
      "respond_level_up",
      "place_owned_object",
      "remove_placed_item",
      "break_container",
      "equip_wearable",
      "unequip_wearable",
      "dismount_transport",
      "use_warp_item",
      "pan_ore",
      "claim_mail_attachment",
      "build_farm_building",
      "name_entity",
      "accept_daily_quest",
      "accept_special_order",
      "claim_museum_reward",
      "redeem_prize_ticket",
      "tailor_clothing",
      "dye_clothing_with_item",
      "color_placed_object",
      "load_building_chest",
      "collect_building_chest_output",
      "send_multiplayer_chat",
      "talk_to_npc",
      "use_mine_ladder",
      "pet_farm_animal",
      "fish_here",
      "break_resource_clump",
      "rotate_furniture",
      "remove_fence",
      "open_geode",
      "sweep_scythe",
    ],
  );
  assert.deepEqual(
    STARDEW_PUBLISHED_ACTION_GATES.filter((gate) => gate.fixtureScenario === null).map((gate) => gate.actionId),
    ["move_to_tile", "equip_tool", "travel", "enter_exit", "sleep", "move_placed_furniture"],
  );
});
