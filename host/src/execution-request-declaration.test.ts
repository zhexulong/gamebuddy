import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_REQUEST_ARGUMENT_RULES,
  EXECUTION_REQUEST_REQUIREMENTS,
  type ExecutionRequest,
  type ExecutionRequestReading,
  type ExecutionRequestRequirement,
  executionRequestReading,
  firstExecutionRequestRefusal,
  type Snapshot,
  validateExecutionRequest,
} from "./protocol.js";

/**
 * THE DECLARATION IS WALKED, NOT TRUSTED.
 *
 * <p>
 * `validateExecutionRequest` is a lookup and a fold over two declarations - `EXECUTION_REQUEST_REQUIREMENTS` for the
 * payload and `EXECUTION_REQUEST_ARGUMENT_RULES` for each action's `args`. A table that decides nothing looks exactly
 * like a table that decides everything, so every row here has to be shown deciding: for each one this suite takes a VALID
 * payload, breaks exactly that row's fact (`row.violated`), and asserts three things - the row is the FIRST row that
 * refuses it, the code it returns is the row's own `refusal`, and `validateExecutionRequest` itself returns that same
 * code. A row weakened to `() => true`, given another row's code, or moved below a row that already covers its witness
 * fails on one of the three.
 * </p>
 *
 * <p>
 * THE POPULATION COMES FROM THE AUTHORITY. The actions are `Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES)` and the
 * fixtures are typed `Record<ExecutionRequest["action"], …>`, so an action the union grows and the table forgets is a
 * compile error and an action the table grows and the fixture forgets is one too. Every action's exact argument set is
 * then cross-checked against its own fixture in both directions, and the set is proven load-bearing three ways: the
 * fixture is accepted, one extra key is refused, and each declared name removed in turn is refused.
 * </p>
 *
 * <p>
 * WHAT THIS SUITE CANNOT SEE, said rather than implied. A row DELETED from `protocol.ts` leaves the population, so a walk
 * driven by the table cannot miss what the table no longer mentions. That gap is covered elsewhere, and by different
 * mechanisms: `satisfies Record<ExecutionRequest["action"], …>` makes a missing ACTION a compile error,
 * `protocol-catalog-agreement.test.ts` holds every declared argument name against the Mod's published `argumentSchema`,
 * and the witnesses below pin the code each surviving row returns. No assertion here claims to have read a row that is
 * not in the file.
 * </p>
 *
 * red-proof: inject  a row's predicate weakened to `() => true` (tileRow's `isTileCoordinate` pair) ->
 *                   `move_to_tile: breaking \`args.x, args.y\` must be decided by that row, but \`none\` decided it`
 * red-proof: inject  one extra argument in one fixture (`till_soil: { ...TILE, unexpected: 1 }`) ->
 *                   `till_soil: the fixture must carry exactly the names the declaration pins, or one of the two is a
 *                   second spelling`
 */

/** The clock every reading is judged at. */
const NOW = 1_000_000;
const TARGET_ID = "target_1";
const ITEM_ID = "(O)322";
const MINECART_ID = "minecart_0123456789abcdef";
const TILE = { x: 10, y: 11 };

/**
 * The snapshot every witness is dispatched against: it declares every action the table carries and publishes one row in
 * each family the argument rows consult, so a refusal here is about the payload and never about a missing projection.
 */
const SNAPSHOT: Snapshot = {
  revision: 7,
  location: "Farm",
  tile: TILE,
  stamina: 270,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES),
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  activeExecution: null,
  raftTargets: [{ targetId: "raft_1", x: TILE.x, y: TILE.y }],
  horseTargets: [{ targetId: TARGET_ID, x: TILE.x, y: TILE.y, name: "Biscuit" }],
  mineEntranceTargets: [{ targetId: TARGET_ID, x: TILE.x, y: TILE.y }],
  minecartTargets: [
    {
      targetId: MINECART_ID,
      networkId: "network_1",
      destinationId: "destination_1",
      displayName: "Bus Stop",
      price: 0,
      stationX: TILE.x,
      stationY: TILE.y,
      targetLocation: "BusStop",
      targetTileX: 1,
      targetTileY: 2,
    },
  ],
  machineTargets: [
    {
      targetId: TARGET_ID,
      x: TILE.x,
      y: TILE.y,
      qualifiedItemId: "(O)710",
      displayName: "Furnace",
      readyForHarvest: false,
      minutesUntilReady: 10,
      loadInputSlot: 2,
      loadInputQualifiedItemId: ITEM_ID,
      loadInputStack: 5,
    },
  ],
};

const ACTIONS = Object.keys(EXECUTION_REQUEST_ARGUMENT_RULES) as readonly ExecutionRequest["action"][];

const TARGET = { ...TILE, expectedTargetId: TARGET_ID };
const SLOT_AND_TARGET = { ...TARGET, slot: 2 };
const ITEM_AND_TARGET = { ...TARGET, expectedQualifiedItemId: ITEM_ID };
const SLOT_ITEM_AND_TARGET = { ...ITEM_AND_TARGET, slot: 2 };

/** One valid `args` per action, typed by the union so a forgotten action is a compile error rather than an empty case. */
const VALID_ARGS: Readonly<Record<ExecutionRequest["action"], Readonly<Record<string, unknown>>>> = Object.freeze({
  move_to_tile: TILE,
  navigate_to_destination: { destination: { kind: "label", label: "Farm" } },
  equip_tool: { tool: "axe" },
  travel: TILE,
  shop_purchase: { expectedTargetId: TARGET_ID, expectedQualifiedItemId: ITEM_ID, quantity: 1 },
  ride_minecart: { ...TILE, expectedTargetId: MINECART_ID },
  select_mine_elevator_floor: { expectedTargetId: TARGET_ID },
  ride_bus: {},
  withdraw_silo_hay: TARGET,
  place_owned_object: SLOT_ITEM_AND_TARGET,
  remove_placed_item: SLOT_AND_TARGET,
  move_placed_furniture: TARGET,
  rotate_furniture: TARGET,
  remove_fence: SLOT_AND_TARGET,
  put_item_in_fish_tank: SLOT_ITEM_AND_TARGET,
  place_item_on_pedestal: SLOT_ITEM_AND_TARGET,
  break_container: SLOT_AND_TARGET,
  use_obelisk: TARGET,
  toggle_animal_door: TARGET,
  clear_fish_pond: TARGET,
  accept_daily_quest: { expectedTargetId: TARGET_ID },
  accept_special_order: { expectedTargetId: TARGET_ID },
  claim_museum_reward: { expectedTargetId: TARGET_ID },
  build_farm_building: { buildingType: "Coop", ...TARGET },
  redeem_prize_ticket: {},
  tailor_clothing: { leftSlot: 2, rightSlot: 3, expectedTargetId: TARGET_ID },
  dye_clothing_with_item: { leftSlot: 2, rightSlot: 3, expectedTargetId: TARGET_ID },
  open_geode: { slot: 2, expectedQualifiedItemId: ITEM_ID },
  color_placed_object: { ...TARGET, colorSelection: 3 },
  send_multiplayer_chat: { text: "hello" },
  name_entity: { text: "Biscuit" },
  use_warp_item: { slot: 2, expectedQualifiedItemId: ITEM_ID },
  pan_ore: { slot: 2, ...TILE },
  claim_mail_attachment: TARGET,
  load_building_chest: SLOT_AND_TARGET,
  collect_building_chest_output: TARGET,
  use_raft: { slot: 2, ...TILE },
  mount_transport: TARGET,
  enter_mine: TARGET,
  use_mine_ladder: TARGET,
  enter_exit: TILE,
  till_soil: TILE,
  pickup_forage: ITEM_AND_TARGET,
  pickup_item: ITEM_AND_TARGET,
  water_crop: TARGET,
  refill_watering_can: SLOT_AND_TARGET,
  harvest_crop: ITEM_AND_TARGET,
  plant_seed: SLOT_ITEM_AND_TARGET,
  fertilize_tile: SLOT_ITEM_AND_TARGET,
  place_wood_fence: SLOT_ITEM_AND_TARGET,
  place_crab_pot: { ...SLOT_ITEM_AND_TARGET, expectedQualifiedItemId: "(O)710" },
  bait_crab_pot: { ...SLOT_ITEM_AND_TARGET, expectedQualifiedItemId: "(O)685" },
  clear_debris: SLOT_AND_TARGET,
  break_resource_clump: TARGET,
  fish_here: TARGET,
  machine_inspect: TARGET,
  machine_load: SLOT_ITEM_AND_TARGET,
  machine_collect_output: TARGET,
  npc_relationship: TARGET,
  talk_to_npc: TARGET,
  equip_wearable: { slot: 2, expectedQualifiedItemId: ITEM_ID, expectedTargetId: TARGET_ID },
  unequip_wearable: { slot: 2, expectedTargetId: TARGET_ID },
  dismount_transport: {},
  pet_animal: TARGET,
  pet_farm_animal: TARGET,
  collect_animal_product: SLOT_AND_TARGET,
  feed_animal: SLOT_AND_TARGET,
  use_item: { slot: 2, expectedQualifiedItemId: ITEM_ID },
  chop_tree: SLOT_AND_TARGET,
  break_rock: SLOT_AND_TARGET,
  clear_hoedirt: SLOT_AND_TARGET,
  dig_artifact_spot: SLOT_AND_TARGET,
  express_emote: { emote: "wave" },
  face_direction: { direction: "down" },
  chest_store: { chestId: "chest_1", expectedQualifiedItemId: ITEM_ID },
  chest_retrieve: { chestId: "chest_1", expectedQualifiedItemId: ITEM_ID },
  chop_stump: SLOT_AND_TARGET,
  plant_sapling: SLOT_ITEM_AND_TARGET,
  cut_weeds: SLOT_AND_TARGET,
  cut_grass: SLOT_AND_TARGET,
  clear_cask: SLOT_AND_TARGET,
  dress_mannequin: SLOT_AND_TARGET,
  set_sign_display: SLOT_AND_TARGET,
  deposit_silo_hay: SLOT_AND_TARGET,
  toggle_tool_light: { slot: 2, ...TILE },
  scythe_crop: SLOT_AND_TARGET,
  interact_npc_with_item: SLOT_ITEM_AND_TARGET,
  craft_item: { expectedTargetId: TARGET_ID },
  cook_recipe: { expectedTargetId: TARGET_ID },
  collect_crab_pot_output: TARGET,
  ship_item: ITEM_AND_TARGET,
  water_pet_bowl: TARGET,
  dismiss_modal: {},
  answer_dialogue: { responseKey: "key_1" },
  respond_level_up: { choice: "confirm", expectedSkill: 1, expectedLevel: 2 },
  water_slime_hutch_trough: TARGET,
  harvest_bush: TARGET,
  harvest_fruit_tree: TARGET,
  shake_tree: TARGET,
  take_pedestal_item: TARGET,
  toggle_fence_gate: TARGET,
  sleep: {},
});

/** The reading a dispatch of `action` with `args` produces, built by the one constructor the validator uses. */
function readingOf(
  action: ExecutionRequest["action"],
  args: Readonly<Record<string, unknown>>,
): ExecutionRequestReading {
  return executionRequestReading(
    {
      requestId: "request_1",
      idempotencyKey: "idempotency_1",
      action,
      args,
      expectedRevision: SNAPSHOT.revision,
      deadlineMs: NOW + 30_000,
    },
    SNAPSHOT,
    NOW,
  );
}

/** The action's rows in the order the validator decides them. */
function rowsOf(action: ExecutionRequest["action"]): readonly ExecutionRequestRequirement[] {
  return EXECUTION_REQUEST_ARGUMENT_RULES[action];
}

/**
 * Show one row deciding: the witness it breaks is refused BY IT, and by it FIRST.
 *
 * The first-refuser assertion is what a table alone cannot give: a row can carry the right code and still be unreachable
 * because the row above it refuses the same witnesses, which is how a requirement stops being load-bearing without
 * anything failing.
 */
function assertRowDecides(
  label: string,
  rows: readonly ExecutionRequestRequirement[],
  row: ExecutionRequestRequirement,
  valid: ExecutionRequestReading,
  verdict: (reading: ExecutionRequestReading) => string | null,
): void {
  assert.ok(row.field.length > 0, `${label}: a row must name the field it decides`);
  assert.ok(row.shape.length > 0, `${label}: a row must name the shape it accepts`);
  assert.ok(row.refusal.length > 0, `${label}: a row must carry the code it returns`);

  const witness = row.violated(valid);
  const first = rows.find((candidate) => !candidate.isMet(witness));
  assert.equal(
    first,
    row,
    `${label}: breaking \`${row.field}\` must be decided by that row, but \`${first?.field ?? "none"}\` decided it`,
  );
  assert.equal(firstExecutionRequestRefusal(rows, witness), row.refusal, `${label}: \`${row.field}\` must refuse`);
  assert.equal(
    verdict(witness),
    row.refusal,
    `${label}: validateExecutionRequest must return \`${row.refusal}\` for the payload that breaks \`${row.field}\``,
  );
}

test("the declaration carries argument rules for every action, and none of them is empty", () => {
  assert.ok(ACTIONS.length > 90, `the declaration must have been read (found ${ACTIONS.length} actions)`);
  for (const action of ACTIONS) {
    const rows = rowsOf(action);
    assert.ok(rows.length > 0, `${action}: an action with no argument row is an action the Host admits unchecked`);
    const exact = rows.find((row) => row.argumentNames !== undefined);
    assert.ok(exact !== undefined, `${action}: no row pins the exact argument set`);
  }
});

test("every action's own valid payload is accepted", () => {
  const refused = ACTIONS.filter((action) => {
    const reading = readingOf(action, VALID_ARGS[action]);
    return validateExecutionRequest(reading.request, SNAPSHOT, NOW) !== null;
  });
  assert.deepEqual(refused, [], "an action whose own fixture is refused cannot be dispatched by any caller");
});

test("every row of the payload declaration refuses exactly the payload that breaks it", () => {
  for (const row of EXECUTION_REQUEST_REQUIREMENTS) {
    assertRowDecides("the payload", EXECUTION_REQUEST_REQUIREMENTS, row, readingOf("move_to_tile", TILE), (reading) =>
      validateExecutionRequest(reading.request, reading.snapshot, reading.nowMs),
    );
  }
});

test("every argument row of every action refuses exactly the payload that breaks it", () => {
  for (const action of ACTIONS) {
    for (const row of rowsOf(action)) {
      assertRowDecides(action, rowsOf(action), row, readingOf(action, VALID_ARGS[action]), (reading) =>
        validateExecutionRequest(reading.request, reading.snapshot, reading.nowMs),
      );
    }
  }
});

test("every action's exact argument set is the one its fixture carries, and the set is load-bearing", () => {
  const without = (args: Readonly<Record<string, unknown>>, name: string) =>
    Object.fromEntries(Object.entries(args).filter(([key]) => key !== name));

  for (const action of ACTIONS) {
    const declared = rowsOf(action).find((row) => row.argumentNames !== undefined)?.argumentNames;
    assert.ok(declared !== undefined, `${action}: no row pins the exact argument set`);
    assert.deepEqual(
      [...Object.keys(VALID_ARGS[action])].sort(),
      [...declared].sort(),
      `${action}: the fixture must carry exactly the names the declaration pins, or one of the two is a second spelling`,
    );
    assert.equal(
      validateExecutionRequest({ ...readingOf(action, VALID_ARGS[action]).request }, SNAPSHOT, NOW),
      null,
      `${action}: the declared set must be accepted`,
    );

    const extra = readingOf(action, { ...VALID_ARGS[action], unexpected: true });
    assert.notEqual(
      validateExecutionRequest(extra.request, SNAPSHOT, NOW),
      null,
      `${action}: one argument the declaration does not list must be refused`,
    );
    for (const name of declared) {
      const missing = readingOf(action, without(VALID_ARGS[action], name));
      assert.equal(
        validateExecutionRequest(missing.request, SNAPSHOT, NOW),
        rowsOf(action)[0]?.refusal,
        `${action}: dropping \`${name}\` must be refused by the exact-set row`,
      );
    }
  }
});
