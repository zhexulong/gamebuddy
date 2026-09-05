import assert from "node:assert/strict";
import test from "node:test";
import type { StardewBridgeConnection } from "./game-connection.js";
import type { ExecutionReceipt } from "./protocol.js";
import { TEST_MOD_REGISTRATIONS } from "./stardew-test-fixtures.js";
import { STARDEW_GAME_INTEGRATION_ADAPTER } from "./stardew-game-integration-adapter.js";

test("every locally adapted Mod action has an explicit fail-closed completion rule", () => {
  for (const action of TEST_MOD_REGISTRATIONS)
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        action.actionId,
        {
          state: "succeeded",
          reasonCode: "succeeded",
          evidence: { detail: "anything=true" },
        },
      ),
      false,
      action.actionId,
    );
});

test("equip completion rejects malicious substring detail and accepts only the exact Mod fixture", () => {
  const valid = "slot=1;before=none;expected=Axe;after=Axe";
  const receipt = {
    state: "succeeded",
    reasonCode: "tool_selected",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "equip_tool",
      receipt,
    ),
    true,
  );
  for (const malicious of [
    "slot=1;before=none;expected=Axe;after=Axe;admin=true",
    "slot=1;before=none;expected=Axe;after=Axe_not_really",
    "slot=1;before=none;expected=Axe;after=Axe;before=none",
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "equip_tool",
        {
          ...receipt,
          evidence: { detail: malicious },
        },
      ),
      false,
    );
});

test("plant, refill, break, and chop completion evidence reject opaque sentinels and out-of-range slots", () => {
  const cases = [
    [
      "plant_seed",
      "seed_planted",
      "location=Farm;target=soil_01;tile=1,2;item=(O)472;crop=Parsnip;inventory_before=2;inventory_after=1",
      "item=(O)472",
      "item=false",
    ],
    [
      "plant_seed",
      "seed_planted",
      "location=Farm;target=soil_01;tile=1,2;item=(O)472;crop=Parsnip;inventory_before=2;inventory_after=1",
      "crop=Parsnip",
      "crop=false",
    ],
    [
      "refill_watering_can",
      "watering_can_refilled",
      "target=water_01;slot=3;can=WateringCan;water_before=0;water_after=40;water_max=40",
      "slot=3",
      "slot=999",
    ],
    [
      "break_rock_source",
      "rock_source_broken",
      "target=rock_01;tool=pickaxe;slot=3;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true",
      "slot=3",
      "slot=999",
    ],
    [
      "chop_tree_source",
      "tree_source_chopped",
      "target=tree_01;tool=axe;slot=3;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true",
      "slot=3",
      "slot=999",
    ],
  ] as const;
  for (const [actionId, reasonCode, valid, expected, invalid] of cases) {
    const receipt = {
      state: "succeeded",
      reasonCode,
      evidence: { detail: valid },
    } as const;
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        actionId,
        receipt,
      ),
      true,
      actionId,
    );
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(actionId, {
        ...receipt,
        evidence: { detail: valid.replace(expected, invalid) },
      }),
      false,
      `${actionId}:${invalid}`,
    );
  }
});

test("every accepted semantic evidence field rejects protocol scalar sentinels", () => {
  const cases = [
    [
      "equip_tool",
      "tool_selected",
      "slot=1;before=none;expected=Axe;after=Axe",
      ["before", "expected", "after"],
    ],
    [
      "till_soil",
      "soil_tilled",
      "location=Farm;target=37,18;before=none;after=HoeDirt",
      ["location", "target"],
    ],
    [
      "move_to_tile",
      "target_reached",
      "tile=37,18;target=37,18;arrival=exact;path=stardew_native",
      ["tile", "target"],
    ],
    [
      "water_crop",
      "crop_watered",
      "location=Farm;target=crop_01;tile=37,18;before_watered=false;after_watered=true;water_before=1;water_after=0;water_consumed=true",
      ["location", "target", "tile"],
    ],
    [
      "refill_watering_can",
      "watering_can_refilled",
      "target=water_01;slot=3;can=WateringCan;water_before=0;water_after=40;water_max=40",
      ["target", "can"],
    ],
    [
      "dig_artifact_spot",
      "artifact_spot_dug",
      "location=Farm;target=artifact_01;result_target=result_01;tile=10,12;tool=hoe;slot=4;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;qualified_item_id=(O)590;source_present_before=true;source_present_after=false;hoedirt_present_before=false;hoedirt_present_after=true;source_removed=true",
      ["location", "target", "result_target", "tile"],
    ],
    [
      "break_rock_source",
      "rock_source_broken",
      "target=rock_01;tool=pickaxe;slot=3;qualified_item_id=(O)2;durability_before=1;durability_after=removed;removed=true",
      ["target"],
    ],
    [
      "clear_hoedirt",
      "hoedirt_cleared",
      "location=Farm;target=soil_01;tile=10,12;tool=pickaxe;slot=3;crop_before=false;hoedirt_present_before=true;hoedirt_present_after=false;removed=true",
      ["location", "target", "tile"],
    ],
    [
      "chop_tree_source",
      "tree_source_chopped",
      "target=tree_01;tool=axe;slot=3;tree=Oak;health_before=1;health_after=5;stump_before=false;stump_after=true;source_transformed=true",
      ["target", "tree"],
    ],
    [
      "place_wood_fence",
      "wood_fence_placed",
      "source=(O)322;location=Farm;x=10;y=12;target=fence_01;item=(O)322;slot=4;source_empty_before=true;is_fence=true;is_gate=false;health=99;max_health=100;inventory_before=1;inventory_after=0",
      ["location", "target"],
    ],
    [
      "bait_crab_pot",
      "crab_pot_baited",
      "source=(O)685;location=Farm;x=10;y=12;target=pot_01;pot=(O)710;slot=4;owner=1;bait_before=none;bait_after=(O)685;inventory_before=1;inventory_after=0;actionable=true;active_execution=null",
      ["location", "target"],
    ],
    [
      "plant_seed",
      "seed_planted",
      "location=Farm;target=soil_01;tile=1,2;item=(O)472;crop=Parsnip;inventory_before=2;inventory_after=1",
      ["location", "target", "tile", "item", "crop"],
    ],
  ] as const;
  const scalars = [
    "none",
    "true",
    "false",
    "null",
    "undefined",
    "nan",
    "infinity",
  ];
  for (const [actionId, reasonCode, valid, fields] of cases) {
    const receipt = {
      state: "succeeded",
      reasonCode,
      evidence: { detail: valid },
    } as const;
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        actionId,
        receipt,
      ),
      true,
      actionId,
    );
    for (const field of fields)
      for (const scalar of scalars)
        assert.equal(
          STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
            actionId,
            {
              ...receipt,
              evidence: {
                detail: valid.replace(
                  new RegExp(`(${field}=)[^;]+`),
                  `$1${scalar}`,
                ),
              },
            },
          ),
          actionId === "equip_tool" && field === "before" && scalar === "none",
          `${actionId}:${field}=${scalar}`,
        );
  }
});

test("move_to_tile completion evidence accepts exact native arrival after :0.## tile serialization", () => {
  const valid = "tile=37,18;target=37,18;arrival=exact;path=stardew_native";
  const receipt = {
    state: "succeeded",
    reasonCode: "target_reached",
    evidence: { detail: valid },
  } as const;
  for (const producerPermitted of [
    valid,
    // The producer checks actual distance <= 0.2 before serializing the tile
    // with :0.##, so these nonintegral renderings can be genuine exact arrivals.
    "tile=37.2,18;target=37,18;arrival=exact;path=stardew_native",
    "tile=37.14,18.14;target=37,18;arrival=exact;path=stardew_native",
    "tile=1000.2,0;target=1000,0;arrival=exact;path=stardew_native",
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "move_to_tile",
        {
          ...receipt,
          evidence: { detail: producerPermitted },
        },
      ),
      true,
      producerPermitted,
    );
  for (const malformed of [
    valid.replace("path=stardew_native", ""),
    valid.replace("path=stardew_native", "path=synthetic"),
    valid.replace("arrival=exact", "arrival=warp_adjacent"),
    valid.replace("target=37,18", "target=37,19"),
    "tile=37.21,18;target=37,18;arrival=exact;path=stardew_native",
    "tile=37.15,18.15;target=37,18;arrival=exact;path=stardew_native",
    "tile=37.20,18;target=37,18;arrival=exact;path=stardew_native",
    "tile=037,18;target=37,18;arrival=exact;path=stardew_native",
    "tile=37.0,18;target=37,18;arrival=exact;path=stardew_native",
    "tile=37.001,18;target=37,18;arrival=exact;path=stardew_native",
    "tile=37,18;target=37.0,18;arrival=exact;path=stardew_native",
    "tile=-1,18;target=37,18;arrival=exact;path=stardew_native",
    "tile=37,18;target=none;arrival=exact;path=stardew_native",
    "tile=37,18;target=1001,18;arrival=exact;path=stardew_native",
    `${valid};path=stardew_native`,
    `${valid};extra=value`,
  ]) {
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "move_to_tile",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
  }
});

test("till_soil completion evidence requires exact location, coordinates, and soil transition", () => {
  const valid = "location=Farm;target=37,18;before=none;after=HoeDirt";
  const receipt = {
    state: "succeeded",
    reasonCode: "soil_tilled",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "till_soil",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("location=Farm", "location=none"),
    valid.replace("target=37,18", "target=37,-1"),
    valid.replace("target=37,18", "target=not-a-coordinate"),
    valid.replace("before=none", "before=HoeDirt"),
    valid.replace("after=HoeDirt", "after=none"),
    valid.replace(";before=none", ""),
    `${valid};target=37,18`,
    `${valid};unknown=value`,
  ]) {
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "till_soil",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
    );
  }
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "till_soil",
      { ...receipt, state: "accepted" },
    ),
    false,
  );
});

test("water_crop completion evidence accepts both Mod water relations and rejects inconsistent variants", () => {
  const normal =
    "location=Farm;target=crop_abcdef0123456789;tile=38,18;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true";
  // FarmhandExecutionController emits no bottomless/enchantment discriminator.
  // Its producer-defined waterConsumed=true branch can leave WaterLeft
  // unchanged.
  const noDecrement = normal.replace(
    "water_before=40;water_after=39",
    "water_before=40;water_after=40",
  );
  const receipt = {
    state: "succeeded",
    reasonCode: "crop_watered",
    evidence: { detail: normal },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "water_crop",
      receipt,
    ),
    true,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "water_crop",
      {
        ...receipt,
        evidence: { detail: noDecrement },
      },
    ),
    true,
  );
  for (const malformed of [
    normal.replace("location=Farm", "location=none"),
    normal.replace("target=crop_abcdef0123456789", "target=none"),
    normal.replace("target=crop_abcdef0123456789", "target=true"),
    normal.replace("target=crop_abcdef0123456789", "target=crop bad"),
    normal.replace("tile=38,18", "tile=38,-1"),
    normal.replace("before_watered=false", "before_watered=true"),
    normal.replace("before_watered=false", "before_watered=False"),
    normal.replace("after_watered=true", "after_watered=false"),
    normal.replace("after_watered=true", "after_watered=TRUE"),
    normal.replace(
      "water_before=40;water_after=39",
      "water_before=40;water_after=41",
    ),
    normal.replace(
      "water_before=40;water_after=39",
      "water_before=40;water_after=38",
    ),
    normal.replace(
      "water_before=40;water_after=39",
      "water_before=40.5;water_after=39.5",
    ),
    normal.replace(
      "water_before=40;water_after=39",
      "water_before=Infinity;water_after=39",
    ),
    normal.replace("water_consumed=true", "water_consumed=false"),
    normal.replace("water_consumed=true", "water_consumed=True"),
    `${normal};target=crop_duplicate`,
    `${normal};unknown=value`,
  ]) {
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "water_crop",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
    );
  }
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "water_crop",
      { ...receipt, state: "uncertain" },
    ),
    false,
  );
});

test("place_wood_fence completion evidence is exact and fail-closed", () => {
  const valid =
    "source=(O)322;location=Farm;x=10;y=12;target=wood_fence_deadbeef;item=(O)322;slot=4;source_empty_before=true;is_fence=true;is_gate=false;health=99;max_health=100;inventory_before=1;inventory_after=0";
  const receipt = {
    state: "succeeded",
    reasonCode: "wood_fence_placed",
    evidence: { detail: valid },
  };
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "place_wood_fence",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("source_empty_before=true", "source_empty_before=false"),
    valid.replace("is_fence=true", "is_fence=false"),
    valid.replace("is_gate=false", "is_gate=true"),
    valid.replace("health=99;max_health=100", "health=101;max_health=100"),
    valid.replace("health=99;max_health=100", "health=NaN;max_health=100"),
    valid.replace(
      "inventory_before=1;inventory_after=0",
      "inventory_before=2;inventory_after=2",
    ),
    valid.replace("x=10", "x=1001"),
    valid.replace("slot=4", "slot=37"),
    valid
      .replace("inventory_before=1", "inventory_before=2")
      .replace("inventory_after=0", "inventory_after=1"),
    `${valid};target=wood_fence_duplicate`,
    valid.replace("source=(O)322", "source=unknown"),
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "place_wood_fence",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
    );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "place_wood_fence",
      {
        ...receipt,
        state: "accepted",
      },
    ),
    false,
  );
});

test("bait_crab_pot completion evidence preserves decimal owner identity and exact native transition", () => {
  const valid =
    "source=(O)685;location=Farm;x=34;y=52;target=bait_crab_pot_ecedec446e08d884;pot=(O)710;slot=5;owner=680508790015262242;bait_before=none;bait_after=(O)685;inventory_before=1;inventory_after=0;actionable=true;active_execution=null";
  const receipt = {
    state: "succeeded",
    reasonCode: "crab_pot_baited",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "bait_crab_pot",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("owner=680508790015262242", "owner=680508790015262242.0"),
    valid.replace("owner=680508790015262242", "owner=-1"),
    valid.replace("bait_before=none", "bait_before=(O)685"),
    valid.replace("bait_after=(O)685", "bait_after=none"),
    valid.replace(
      "inventory_before=1;inventory_after=0",
      "inventory_before=1;inventory_after=1",
    ),
    valid.replace("actionable=true", "actionable=false"),
    valid.replace("active_execution=null", "active_execution=execution_01"),
    `${valid};owner=680508790015262242`,
    `${valid};unknown=value`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "bait_crab_pot",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
    );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "bait_crab_pot",
      { ...receipt, state: "accepted" },
    ),
    false,
  );
});

test("navigate_to_destination completion evidence requires the bounded fresh destination assertion", () => {
  const valid = "destination=Mine;location=Mine;arrived=true;postcondition=true";
  const receipt = {
    state: "succeeded",
    reasonCode: "navigation_completed",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "navigate_to_destination",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("arrived=true", "arrived=false"),
    valid.replace("postcondition=true", "postcondition=false"),
    valid.replace("destination=Mine", "destination=none"),
    valid.replace("destination=Mine", "destination=true"),
    valid.replace("destination=Mine", "destination=null"),
    valid.replace("location=Mine", "location=none"),
    valid.replace("location=Mine", "location=undefined"),
    `${valid};destination=Mine`,
    `${valid};route=Mine:10,10`,
    "destination=Mine;location=Mine;arrived=maybe;postcondition=true",
    "location=Mine;arrived=true;postcondition=true",
    "destination=Mine;arrived=true;postcondition=true",
    "destination=Mine;location=Mine;arrived=true;postcondition=true;warp=true",
  ]) {
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "navigate_to_destination",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
  }
  // A matching destination/location substring in another reason code is not completion.
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "navigate_to_destination",
      { ...receipt, reasonCode: "arrived" },
    ),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "navigate_to_destination",
      { ...receipt, state: "accepted" },
    ),
    false,
  );
});

test("travel and enter_exit completion evidence require the exact warped destination", () => {
  const travelValid = "expected=BusStop:20,12;actual=BusStop:20,12";
  const travelReceipt = {
    state: "succeeded",
    reasonCode: "travel_completed",
    evidence: { detail: travelValid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "travel",
      travelReceipt,
    ),
    true,
  );
  const exitValid = "expected=SeedShop:4,9;actual=SeedShop:4,9";
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "enter_exit",
      {
        state: "succeeded",
        reasonCode: "enter_exit_completed",
        evidence: { detail: exitValid },
      },
    ),
    true,
  );
  for (const [actionId, reasonCode, malformed] of [
    [
      "travel",
      "travel_completed",
      travelValid.replace("actual=BusStop:20,12", "actual=BusStop:20,13"),
    ],
    [
      "travel",
      "travel_completed",
      travelValid.replace("actual=BusStop:20,12", "actual=Town:20,12"),
    ],
    [
      "enter_exit",
      "enter_exit_completed",
      exitValid.replace("expected=SeedShop:4,9", "expected=SeedShop:4,09"),
    ],
    [
      "enter_exit",
      "enter_exit_completed",
      exitValid.replace(";actual=SeedShop:4,9", ""),
    ],
    [
      "travel",
      "travel_completed",
      travelValid.replace("expected=BusStop", "expected=none"),
    ],
    [
      "travel",
      "travel_completed",
      travelValid.replace("actual=BusStop:20,12", "actual=BusStop:1001,12"),
    ],
    ["travel", "travel_completed", `${travelValid};actual=BusStop:20,12`],
    [
      "travel",
      "travel_completed",
      travelValid.replace("actual=BusStop:20,12", "actual=BusStop:x,12"),
    ],
  ] as const) {
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(actionId, {
        state: "succeeded",
        reasonCode,
        evidence: { detail: malformed },
      }),
      false,
      malformed,
    );
  }
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("travel", {
      ...travelReceipt,
      reasonCode: "enter_exit_completed",
    }),
    false,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "enter_exit",
      {
        ...travelReceipt,
        reasonCode: "travel_completed",
      },
    ),
    false,
  );
});

test("pickup_forage completion evidence requires the native removal and inventory gain", () => {
  const valid =
    "location=Forest;target=12,9;item=(O)16;removed=true;inventory_before=0;inventory_after=1";
  const receipt = {
    state: "succeeded",
    reasonCode: "forage_picked_up",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "pickup_forage",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("removed=true", "removed=false"),
    valid.replace(
      "inventory_before=0;inventory_after=1",
      "inventory_before=1;inventory_after=1",
    ),
    valid.replace("item=(O)16", "item=none"),
    valid.replace("target=12,9", "target=12,1001"),
    valid.replace("location=Forest", "location=false"),
    `${valid};inventory_after=2`,
    `${valid};unknown=value`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "pickup_forage",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("pickup_item completion evidence requires the native auto-collect chunk removal", () => {
  const valid =
    "location=Farm;target=item_abcdef0123456789;tile=12,9;item=(O)78;stack=1;native_auto_collect=true;chunk_removed=true;inventory_before=0;inventory_after=1";
  const receipt = {
    state: "succeeded",
    reasonCode: "item_picked_up",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "pickup_item",
      receipt,
    ),
    true,
  );
  const multiStack = valid
    .replace("stack=1;", "stack=3;")
    .replace(
      "inventory_before=0;inventory_after=1",
      "inventory_before=5;inventory_after=8",
    );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "pickup_item",
      {
        ...receipt,
        evidence: { detail: multiStack },
      },
    ),
    true,
  );
  for (const malformed of [
    valid.replace("native_auto_collect=true", "native_auto_collect=false"),
    valid.replace("chunk_removed=true", "chunk_removed=false"),
    valid.replace("stack=1;", "stack=0;"),
    valid.replace("inventory_after=1", "inventory_after=0"),
    valid.replace("target=item_abcdef0123456789", "target=item bad id"),
    valid.replace("tile=12,9", "tile=12.5,9"),
    `${valid};chunk_removed=true`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "pickup_item",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("fertilize_tile completion evidence requires the exact applied fertilizer and decrement", () => {
  const valid =
    "location=Farm;target=soil_01;tile=5,9;item=(O)368;fertilizer_before=none;fertilizer_after=(O)368;inventory_before=1;inventory_after=0";
  const receipt = {
    state: "succeeded",
    reasonCode: "fertilizer_applied",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "fertilize_tile",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("fertilizer_after=(O)368", "fertilizer_after=none"),
    valid.replace("fertilizer_after=(O)368", "fertilizer_after=(O)369"),
    valid.replace(
      "inventory_before=1;inventory_after=0",
      "inventory_before=2;inventory_after=2",
    ),
    valid.replace("fertilizer_before=none", "fertilizer_before=false"),
    valid.replace("item=(O)368", "item=none"),
    valid.replace("target=soil_01", "target=soil 01"),
    `${valid};fertilizer_after=(O)369`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "fertilize_tile",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("place_crab_pot completion evidence requires the exact native placement facts", () => {
  const valid =
    "source=(O)710;location=Farm;x=10;y=12;target=crab_pot_01;item=(O)710;slot=4;source_empty_before=true;is_crab_pot=true;owner=680508790015262242;offset_x=0;offset_y=0;overlay_tiles=11,12:1|10,13:2;inventory_before=1;inventory_after=0";
  const receipt = {
    state: "succeeded",
    reasonCode: "crab_pot_placed",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "place_crab_pot",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("overlay_tiles=11,12:1|10,13:2", "overlay_tiles=11,12:0"),
    valid.replace(
      "overlay_tiles=11,12:1|10,13:2",
      "overlay_tiles=11,12:1|10,13",
    ),
    valid.replace(
      "overlay_tiles=11,12:1|10,13:2",
      "overlay_tiles=11:1|10,13:2",
    ),
    valid.replace("is_crab_pot=true", "is_crab_pot=false"),
    valid.replace("owner=680508790015262242", "owner=680508790015262242.0"),
    valid.replace("offset_x=0", "offset_x=none"),
    valid.replace("offset_y=0", "offset_y=NaN"),
    valid.replace("source=(O)710", "source=(O)685"),
    valid.replace("item=(O)710", "item=(O)685"),
    valid.replace(
      "inventory_before=1;inventory_after=0",
      "inventory_before=1;inventory_after=1",
    ),
    valid.replace("y=12", "y=1001"),
    valid.replace("slot=4", "slot=37"),
    `${valid};is_crab_pot=true`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "place_crab_pot",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("machine inspection, load, and collect completion evidence are exact Keg contracts", () => {
  const inspect = {
    state: "succeeded",
    reasonCode: "machine_inspected",
    evidence: {
      detail:
        "location=Shed;target=machine_01;tile=5,9;machine=(BC)12;ready_for_harvest=false;minutes_until_ready=120;held=none;last_input=none",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "machine_inspect",
      inspect,
    ),
    true,
  );
  const inspectReady = {
    ...inspect,
    evidence: {
      detail:
        "location=Shed;target=machine_01;tile=5,9;machine=(BC)12;ready_for_harvest=true;minutes_until_ready=0;held=(O)395;last_input=(O)433",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "machine_inspect",
      inspectReady,
    ),
    true,
  );
  for (const malformed of [
    inspect.evidence.detail.replace(
      "minutes_until_ready=120",
      "minutes_until_ready=1.5",
    ),
    inspect.evidence.detail.replace("machine=(BC)12", "machine=none"),
    inspect.evidence.detail.replace("held=none", "held=false"),
    `${inspect.evidence.detail};ready_for_harvest=false`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "machine_inspect",
        {
          ...inspect,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );

  const load = {
    state: "succeeded",
    reasonCode: "machine_coffee_loaded",
    evidence: {
      detail:
        "location=Shed;target=machine_01;tile=5,9;machine=(BC)12;slot=3;input=(O)433;input_stack_before=5;input_stack_after=removed;last_input=(O)433;held=(O)395;ready_for_harvest=false;minutes_until_ready=120;native_check_action=true",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "machine_load",
      load,
    ),
    true,
  );
  for (const malformed of [
    load.evidence.detail.replace(
      "minutes_until_ready=120",
      "minutes_until_ready=119",
    ),
    load.evidence.detail.replace(
      "input_stack_after=removed",
      "input_stack_after=4",
    ),
    load.evidence.detail.replace(
      "input_stack_before=5",
      "input_stack_before=4",
    ),
    load.evidence.detail.replace("last_input=(O)433", "last_input=none"),
    load.evidence.detail.replace("held=(O)395", "held=(O)395_extra"),
    load.evidence.detail.replace(
      "native_check_action=true",
      "native_check_action=false",
    ),
    load.evidence.detail.replace("input=(O)433", "input=(O)472"),
    `${load.evidence.detail};minutes_until_ready=120`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "machine_load",
        {
          ...load,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );

  const collect = {
    state: "succeeded",
    reasonCode: "machine_coffee_collected",
    evidence: {
      detail:
        "location=Shed;target=machine_01;tile=5,9;machine=(BC)12;output=(O)395;input=(O)433;ready_before=true;minutes_until_ready_before=0;inventory_coffee_before=0;inventory_coffee_after=1;held_after=none;ready_after=false;native_check_action=true",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "machine_collect_output",
      collect,
    ),
    true,
  );
  for (const malformed of [
    collect.evidence.detail.replace("ready_before=true", "ready_before=false"),
    collect.evidence.detail.replace(
      "inventory_coffee_before=0;inventory_coffee_after=1",
      "inventory_coffee_before=0;inventory_coffee_after=2",
    ),
    collect.evidence.detail.replace("held_after=none", "held_after=(O)395"),
    collect.evidence.detail.replace("ready_after=false", "ready_after=true"),
    collect.evidence.detail.replace("output=(O)395", "output=(O)348"),
    collect.evidence.detail.replace(
      "minutes_until_ready_before=0",
      "minutes_until_ready_before=0.0",
    ),
    `${collect.evidence.detail};native_check_action=true`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "machine_collect_output",
        {
          ...collect,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("use_item completion evidence requires the native consumption and animation completion", () => {
  const valid =
    "slot=4;item=(O)216;stack_before=1;stack_after=0;edibility=20;drink=false;stamina_before=270;stamina_after=285;health_before=33;health_after=40;animation_complete=true";
  const receipt = {
    state: "succeeded",
    reasonCode: "item_used",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "use_item",
      receipt,
    ),
    true,
  );
  const stacked = valid.replace(
    "stack_before=1;stack_after=0",
    "stack_before=5;stack_after=4",
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("use_item", {
      ...receipt,
      evidence: { detail: stacked },
    }),
    true,
  );
  // The action admits drinks with negative edibility; the terminal receipt
  // carries the native Edibility integer unchanged.
  const drink =
    "slot=4;item=(O)773;stack_before=1;stack_after=0;edibility=-300;drink=true;stamina_before=270.5;stamina_after=285;health_before=33;health_after=40;animation_complete=true";
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence("use_item", {
      ...receipt,
      evidence: { detail: drink },
    }),
    true,
  );
  for (const malformed of [
    valid.replace(
      "stack_before=1;stack_after=0",
      "stack_before=1;stack_after=1",
    ),
    valid.replace(
      "stack_before=1;stack_after=0",
      "stack_before=5;stack_after=5",
    ),
    valid.replace("animation_complete=true", "animation_complete=false"),
    valid.replace("stamina_before=270", "stamina_before=NaN"),
    valid.replace("health_after=40", "health_after=-1"),
    valid.replace("edibility=20", "edibility=20.5"),
    valid.replace("item=(O)216", "item=none"),
    valid.replace("slot=4", "slot=37"),
    `${valid};animation_complete=true`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "use_item",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("feed_animal completion evidence requires the exact trough placement", () => {
  const valid =
    "location=Coop;target=trough_01;tile=5,9;slot=3;native_handled=true;trough_filled=true;hay_before=1;hay_after=0;hay_consumed=true";
  const receipt = {
    state: "succeeded",
    reasonCode: "hay_placed_in_trough",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "feed_animal",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace("native_handled=true", "native_handled=false"),
    valid.replace("trough_filled=true", "trough_filled=false"),
    valid.replace("hay_before=1;hay_after=0", "hay_before=2;hay_after=2"),
    valid.replace("hay_before=1;hay_after=0", "hay_before=1;hay_after=1"),
    valid.replace("hay_consumed=true", "hay_consumed=false"),
    valid.replace("target=trough_01", "target=trough 01"),
    `${valid};trough_filled=true`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "feed_animal",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("collect_animal_product completion evidence preserves opaque animal identity and produce stack", () => {
  const valid =
    "location=Barn;target=animal_01;animal=680508790015262242;tool=milk_pail;produce=(O)184;produce_stack=1;produce_cleared=true;inventory_before=0;inventory_after=1;inventory_gained=true;animation_complete=true";
  const receipt = {
    state: "succeeded",
    reasonCode: "animal_product_collected",
    evidence: { detail: valid },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "collect_animal_product",
      receipt,
    ),
    true,
  );
  const cracker = valid
    .replace("produce_stack=1;", "produce_stack=2;")
    .replace(
      "inventory_before=0;inventory_after=1",
      "inventory_before=0;inventory_after=2",
    );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "collect_animal_product",
      {
        ...receipt,
        evidence: { detail: cracker },
      },
    ),
    true,
  );
  const shears = valid.replace("tool=milk_pail", "tool=shears");
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "collect_animal_product",
      {
        ...receipt,
        evidence: { detail: shears },
      },
    ),
    true,
  );
  for (const malformed of [
    valid.replace("tool=milk_pail", "tool=axe"),
    valid.replace("produce_cleared=true", "produce_cleared=false"),
    valid.replace("produce_stack=1", "produce_stack=0"),
    valid.replace("produce_stack=1", "produce_stack=3"),
    valid.replace("inventory_after=1", "inventory_after=0"),
    valid.replace("inventory_gained=true", "inventory_gained=false"),
    valid.replace("animation_complete=true", "animation_complete=false"),
    valid.replace("animal=680508790015262242", "animal=680508790015262242.0"),
    valid.replace("produce=(O)184", "produce=none"),
    `${valid};inventory_gained=true`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "collect_animal_product",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("harvest_crop completion evidence distinguishes regrowing and destroyed crops", () => {
  const destroyed = {
    state: "succeeded",
    reasonCode: "crop_harvested",
    evidence: {
      detail:
        "location=Farm;target=crop_01;tile=5,9;crop=Parsnip;item=(O)24;native_path_return=true;native_accepted=true;regrows=false;phase_before=4;phase_after=none;day_of_phase_before=0;day_of_phase_after=none;regrow_advanced=false;inventory_before=0;inventory_after=1;inventory_gained=true;crop_present_after=false",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "harvest_crop",
      destroyed,
    ),
    true,
  );
  const regrow = {
    ...destroyed,
    evidence: {
      detail:
        "location=Farm;target=crop_01;tile=5,9;crop=Strawberry;item=(O)400;native_path_return=false;native_accepted=true;regrows=true;phase_before=4;phase_after=4;day_of_phase_before=1;day_of_phase_after=2;regrow_advanced=true;inventory_before=0;inventory_after=1;inventory_gained=true;crop_present_after=true",
    },
  } as const;
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "harvest_crop",
      regrow,
    ),
    true,
  );
  for (const malformed of [
    destroyed.evidence.detail.replace(
      "native_path_return=true",
      "native_path_return=false",
    ),
    destroyed.evidence.detail.replace(
      "crop_present_after=false",
      "crop_present_after=true",
    ),
    destroyed.evidence.detail.replace("phase_after=none", "phase_after=4"),
    destroyed.evidence.detail.replace(
      "day_of_phase_after=none",
      "day_of_phase_after=2",
    ),
    destroyed.evidence.detail.replace("inventory_after=1", "inventory_after=0"),
    destroyed.evidence.detail.replace(
      "inventory_gained=true",
      "inventory_gained=false",
    ),
    destroyed.evidence.detail.replace("regrows=false", "regrows=maybe"),
    regrow.evidence.detail.replace(
      "regrow_advanced=true",
      "regrow_advanced=false",
    ),
    regrow.evidence.detail.replace(
      "crop_present_after=true",
      "crop_present_after=false",
    ),
    regrow.evidence.detail.replace(
      "day_of_phase_before=1;day_of_phase_after=2",
      "day_of_phase_before=2;day_of_phase_after=2",
    ),
    regrow.evidence.detail.replace(
      "phase_before=4;phase_after=4",
      "phase_before=4;phase_after=3",
    ),
    `${destroyed.evidence.detail};native_accepted=true`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "harvest_crop",
        {
          ...destroyed,
          evidence: { detail: malformed },
        },
      ),
      false,
      malformed,
    );
});

test("completion parsers never accept another action's succeeded evidence", () => {
  const cross = [
    [
      "travel",
      "travel_completed",
      "expected=BusStop:20,12;actual=BusStop:20,12",
    ],
    [
      "pickup_forage",
      "forage_picked_up",
      "location=Forest;target=12,9;item=(O)16;removed=true;inventory_before=0;inventory_after=1",
    ],
    [
      "harvest_crop",
      "crop_harvested",
      "location=Farm;target=crop_01;tile=5,9;crop=Parsnip;item=(O)24;native_path_return=true;native_accepted=true;regrows=false;phase_before=4;phase_after=none;day_of_phase_before=0;day_of_phase_after=none;regrow_advanced=false;inventory_before=0;inventory_after=1;inventory_gained=true;crop_present_after=false",
    ],
  ] as const;
  for (const [actionId, , detail] of cross) {
    const receipt = {
      state: "succeeded",
      reasonCode: "succeeded",
      evidence: { detail },
    } as const;
    for (const other of TEST_MOD_REGISTRATIONS) {
      if (other.actionId === actionId) continue;
      assert.equal(
        STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
          other.actionId,
          receipt,
        ),
        false,
        `${other.actionId} should reject ${actionId} evidence`,
      );
    }
  }
});

test("dig_artifact_spot completion evidence is strict and source-only", () => {
  const valid =
    "location=Farm;target=artifact_spot_deadbeef;result_target=artifact_result_deadbeef;tile=10,12;tool=hoe;slot=4;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;qualified_item_id=(O)590;source_present_before=true;source_present_after=false;hoedirt_present_before=false;hoedirt_present_after=true;source_removed=true";
  const receipt = {
    state: "succeeded",
    reasonCode: "artifact_spot_dug",
    evidence: { detail: valid },
  };
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "dig_artifact_spot",
      receipt,
    ),
    true,
  );
  for (const malformed of [
    valid.replace(";result_target=artifact_result_deadbeef", ""),
    valid.replace(
      "result_target=artifact_result_deadbeef",
      "result_target=not opaque",
    ),
    `${valid};result_target=artifact_result_2`,
    `${valid};slot=5`,
    valid.replace("qualified_item_id=(O)590", "qualified_item_id=(O)388"),
    valid.replace("source_present_after=false", "source_present_after=true"),
    valid.replace("stamina_delta=-2", "stamina_delta=2"),
    valid.replace("stamina_after=98", "stamina_after=99"),
    valid.replace("expected_stamina_cost=2", "expected_stamina_cost=-1"),
    valid.replace(
      "stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
      "stamina_before=270;stamina_after=268;stamina_delta=-2;expected_stamina_cost=999",
    ),
    valid.replace("expected_stamina_cost=2", "expected_stamina_cost=2.02"),
    valid.replace(
      "hoedirt_present_before=false",
      "hoedirt_present_before=true",
    ),
    valid.replace("slot=4", "slot=37"),
    `${valid};reward_claimed=false`,
  ])
    assert.equal(
      STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
        "dig_artifact_spot",
        {
          ...receipt,
          evidence: { detail: malformed },
        },
      ),
      false,
    );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "dig_artifact_spot",
      {
        ...receipt,
        evidence: {
          detail: valid.replace(
            "stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
            "stamina_before=100;stamina_after=98.5;stamina_delta=-1.5;expected_stamina_cost=1.5",
          ),
        },
      },
    ),
    true,
  );
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "dig_artifact_spot",
      {
        ...receipt,
        state: "accepted",
      },
    ),
    false,
  );
});
const adapterPreservationScope = {
  integrationId: "stardew",
  saveId: "save_adapter_preservation_01",
  worldId: "world_adapter_preservation_01",
  playerId: "player_adapter_preservation_01",
  companionId: "companion_adapter_preservation_01",
} as const;

/**
 * Exact validated Mod-derived bridge state for a fresh snapshot plus a
 * succeeded receipt. Mirroring the production LocalStardewBridgeClient, the
 * snapshot carries the same catalog revision and enabled action IDs as the
 * connection catalog, so the capabilities fact is current.
 */
function adapterPreservationConnection(
  overrides: Partial<StardewBridgeConnection["state"]> = {},
): StardewBridgeConnection {
  const state: StardewBridgeConnection["state"] = {
    connected: true,
    sessionId: "session_adapter_preservation_01",
    capabilities: TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId),
    catalogRegistrations: TEST_MOD_REGISTRATIONS,
    catalogRevision: 42,
    enabledActionIds: TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId),
    snapshot: {
      revision: 9,
      location: "Farm",
      tile: { x: 1, y: 2 },
      stamina: 100,
      health: 100,
      actionable: true,
      capabilities: TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId),
      catalogRevision: 42,
      enabledActionIds: TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId),
      presentationLocale: "en-US",
      activeExecution: null,
    },
    latestReceipt: null,
    latestReasonCode: null,
    ...overrides,
  };
  return {
    scope: adapterPreservationScope,
    module: STARDEW_GAME_INTEGRATION_ADAPTER,
    state,
  };
}

function succeededWaterCropReceipt(): ExecutionReceipt {
  return {
    executionId: "exec_water_07",
    requestId: "req_water_07",
    actionId: "water_crop",
    state: "succeeded",
    reasonCode: "crop_watered",
    revision: 7,
    evidence: {
      detail:
        "location=Farm;target=crop_abcdef0123456789;tile=38,18;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true",
    },
  };
}

test("readState preserves the succeeded Mod receipt identity, revision, and evidence byte-for-byte", () => {
  const receipt = succeededWaterCropReceipt();
  const view = STARDEW_GAME_INTEGRATION_ADAPTER.readState(
    adapterPreservationConnection({
      latestReceipt: receipt,
      latestReasonCode: "crop_watered",
    }),
  );
  assert.notEqual(view.latestReceipt, null);
  assert.equal(view.latestReceipt?.actionId, receipt.actionId);
  assert.equal(view.latestReceipt?.requestId, receipt.requestId);
  assert.equal(view.latestReceipt?.executionId, receipt.executionId);
  assert.equal(view.latestReceipt?.state, receipt.state);
  assert.equal(view.latestReceipt?.reasonCode, receipt.reasonCode);
  // The Mod revision is preserved exactly; the adapter never renumbers it.
  assert.equal(view.latestReceipt?.revision, receipt.revision);
  assert.equal(view.latestReceipt?.revision, 7);
  // Evidence passes through untouched; the adapter neither repairs nor infers it.
  assert.deepEqual(view.latestReceipt?.evidence, receipt.evidence);
  assert.equal(
    view.latestReceipt?.evidence?.detail,
    "location=Farm;target=crop_abcdef0123456789;tile=38,18;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true",
  );
});

test("readState keeps Mod catalog capabilityRevision independent from snapshot revision", () => {
  const view = STARDEW_GAME_INTEGRATION_ADAPTER.readState(
    adapterPreservationConnection(),
  );
  assert.equal(view.capabilityRevision, 42);
  assert.deepEqual(
    view.enabledActionIds,
    TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId),
  );
  assert.equal(view.snapshotRevision, 9);
  assert.notEqual(view.capabilityRevision, view.snapshotRevision);
  // The two revisions come from distinct Mod facts: the catalog publication
  // and the world snapshot observation.
  assert.equal(view.capabilityRevision, 42);
  assert.equal(view.snapshotRevision, 9);

  // A missing world snapshot leaves snapshotRevision absent without erasing
  // the catalog capability revision.
  const noSnapshot = STARDEW_GAME_INTEGRATION_ADAPTER.readState(
    adapterPreservationConnection({ snapshot: null }),
  );
  assert.equal(noSnapshot.capabilityRevision, 42);
  assert.equal(noSnapshot.snapshotRevision, null);

  // An absent catalog publication leaves capabilityRevision absent without
  // inventing one from the snapshot.
  const noCatalog = STARDEW_GAME_INTEGRATION_ADAPTER.readState(
    adapterPreservationConnection({ catalogRevision: undefined }),
  );
  assert.equal(noCatalog.capabilityRevision, null);
  assert.deepEqual(
    noCatalog.enabledActionIds,
    TEST_MOD_REGISTRATIONS.map((entry) => entry.actionId),
  );
  assert.equal(noCatalog.snapshotRevision, 9);

  const noEnabledActions = STARDEW_GAME_INTEGRATION_ADAPTER.readState(
    adapterPreservationConnection({ enabledActionIds: undefined }),
  );
  assert.equal("enabledActionIds" in noEnabledActions, false);
});

test("readState completion predicate is decided only by catalog source semantics, never snapshot or bare succeeded state", () => {
  const receipt = succeededWaterCropReceipt();
  const connection = adapterPreservationConnection({
    latestReceipt: receipt,
    latestReasonCode: "crop_watered",
  });
  const view = STARDEW_GAME_INTEGRATION_ADAPTER.readState(connection);
  // The projected receipt is the unchanged Mod receipt, so the completion
  // predicate answers from the catalog's per-action evidence semantics.
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      receipt.actionId,
      {
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        evidence: receipt.evidence,
      },
    ),
    true,
  );
  // Completion is action-specific: this succeeded water_crop receipt never
  // completes a different catalog action, even about a fresh snapshot.
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "plant_seed",
      {
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        evidence: receipt.evidence,
      },
    ),
    false,
  );
  // An unknown action fails closed for the same succeeded receipt.
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      "not_a_published_action",
      {
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        evidence: receipt.evidence,
      },
    ),
    false,
  );

  // Absent evidence never becomes completion: a succeeded state plus a fresh
  // snapshot/catalog cannot substitute for the Mod evidence fact.
  const absentEvidence: ExecutionReceipt = { ...receipt, evidence: null };
  const absentView = STARDEW_GAME_INTEGRATION_ADAPTER.readState(
    adapterPreservationConnection({
      latestReceipt: absentEvidence,
      latestReasonCode: "crop_watered",
    }),
  );
  assert.deepEqual(absentView.latestReceipt?.evidence, null);
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      absentEvidence.actionId,
      {
        state: absentEvidence.state,
        reasonCode: absentEvidence.reasonCode,
        evidence: absentEvidence.evidence,
      },
    ),
    false,
  );

  // A stale/mismatched snapshot (observation predates the current catalog
  // publication) preserves the receipt but still cannot manufacture
  // completion from the bare succeeded state.
  const stale = adapterPreservationConnection({
    latestReceipt: absentEvidence,
    latestReasonCode: "crop_watered",
    catalogRevision: 43,
    snapshot: {
      ...adapterPreservationConnection().state.snapshot!,
      catalogRevision: 42,
    },
  });
  const staleView = STARDEW_GAME_INTEGRATION_ADAPTER.readState(stale);
  assert.equal(staleView.capabilityRevision, 43);
  assert.equal(staleView.snapshotRevision, 9);
  assert.deepEqual(staleView.latestReceipt?.evidence, null);
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      absentEvidence.actionId,
      {
        state: absentEvidence.state,
        reasonCode: absentEvidence.reasonCode,
        evidence: absentEvidence.evidence,
      },
    ),
    false,
  );
  // The stale snapshot never downgrades a genuinely completed receipt either:
  // the Mod evidence fact is preserved and still completes.
  const staleWithValidReceipt = adapterPreservationConnection({
    latestReceipt: receipt,
    latestReasonCode: "crop_watered",
    catalogRevision: 43,
    snapshot: {
      ...adapterPreservationConnection().state.snapshot!,
      catalogRevision: 42,
    },
  });
  const staleValidView =
    STARDEW_GAME_INTEGRATION_ADAPTER.readState(staleWithValidReceipt);
  assert.deepEqual(staleValidView.latestReceipt?.evidence, receipt.evidence);
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      receipt.actionId,
      {
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        evidence:
          staleValidView.latestReceipt?.evidence ??
          ({ detail: "" } as const),
      },
    ),
    true,
  );
});

test("readState never synthesizes a receipt or completion from the Mod snapshot active execution", () => {
  const activeExecution = {
    executionId: "exec_active_01",
    requestId: "req_active_01",
    action: "move_to_tile",
    state: "accepted" as const,
    reasonCode: "started",
    evidence: null,
  };
  const view = STARDEW_GAME_INTEGRATION_ADAPTER.readState(
    adapterPreservationConnection({
      latestReceipt: null,
      latestReasonCode: null,
      snapshot: {
        ...adapterPreservationConnection().state.snapshot!,
        activeExecution,
      },
    }),
  );
  // The in-flight snapshot fact must not be projected as a terminal receipt.
  assert.equal(view.latestReceipt, null);
  // The active execution identity is projected from the snapshot, untouched.
  assert.deepEqual(view.activeExecution, {
    actionId: activeExecution.action,
    requestId: activeExecution.requestId,
    executionId: activeExecution.executionId,
    state: activeExecution.state,
  });
  // And it cannot become an authoritative completion on its own.
  assert.equal(
    STARDEW_GAME_INTEGRATION_ADAPTER.actionCatalog.hasCompletionEvidence(
      activeExecution.action,
      {
        state: activeExecution.state,
        reasonCode: activeExecution.reasonCode,
        evidence: activeExecution.evidence,
      },
    ),
    false,
  );
});
