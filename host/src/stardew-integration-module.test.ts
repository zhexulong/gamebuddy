import assert from "node:assert/strict";
import test from "node:test";

import { STARDEW_INTEGRATION_MODULE } from "./stardew-integration-module.js";

test("till_soil completion evidence requires exact location, coordinates, and soil transition", () => {
  const valid = "location=Farm;target=37,18;before=none;after=HoeDirt";
  const receipt = { state: "succeeded", reasonCode: "soil_tilled", evidence: { detail: valid } } as const;
  assert.equal(STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("till_soil", receipt), true);
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
      STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("till_soil", {
        ...receipt,
        evidence: { detail: malformed },
      }),
      false,
    );
  }
  assert.equal(
    STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("till_soil", { ...receipt, state: "accepted" }),
    false,
  );
});

test("water_crop completion evidence requires exact opaque target, transition, and one water unit", () => {
  const valid =
    "location=Farm;target=crop_abcdef0123456789;tile=38,18;before_watered=false;after_watered=true;water_before=40;water_after=39;water_consumed=true";
  const receipt = { state: "succeeded", reasonCode: "crop_watered", evidence: { detail: valid } } as const;
  assert.equal(STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("water_crop", receipt), true);
  for (const malformed of [
    valid.replace("location=Farm", "location=none"),
    valid.replace("target=crop_abcdef0123456789", "target=none"),
    valid.replace("target=crop_abcdef0123456789", "target=crop bad"),
    valid.replace("tile=38,18", "tile=38,-1"),
    valid.replace("before_watered=false", "before_watered=true"),
    valid.replace("before_watered=false", "before_watered=False"),
    valid.replace("after_watered=true", "after_watered=false"),
    valid.replace("after_watered=true", "after_watered=TRUE"),
    valid.replace("water_before=40;water_after=39", "water_before=40;water_after=40"),
    valid.replace("water_before=40;water_after=39", "water_before=40.5;water_after=39.5"),
    valid.replace("water_before=40;water_after=39", "water_before=Infinity;water_after=39"),
    valid.replace("water_consumed=true", "water_consumed=false"),
    valid.replace("water_consumed=true", "water_consumed=True"),
    `${valid};target=crop_duplicate`,
    `${valid};unknown=value`,
  ]) {
    assert.equal(
      STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("water_crop", {
        ...receipt,
        evidence: { detail: malformed },
      }),
      false,
    );
  }
  assert.equal(
    STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("water_crop", { ...receipt, state: "uncertain" }),
    false,
  );
});

test("place_wood_fence completion evidence is exact and fail-closed", () => {
  const valid =
    "source=(O)322;location=Farm;x=10;y=12;target=wood_fence_deadbeef;item=(O)322;slot=4;source_empty_before=true;is_fence=true;is_gate=false;health=99;max_health=100;inventory_before=1;inventory_after=0";
  const receipt = { state: "succeeded", reasonCode: "wood_fence_placed", evidence: { detail: valid } };
  assert.equal(STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("place_wood_fence", receipt), true);
  for (const malformed of [
    valid.replace("source_empty_before=true", "source_empty_before=false"),
    valid.replace("is_fence=true", "is_fence=false"),
    valid.replace("is_gate=false", "is_gate=true"),
    valid.replace("health=99;max_health=100", "health=101;max_health=100"),
    valid.replace("health=99;max_health=100", "health=NaN;max_health=100"),
    valid.replace("inventory_before=1;inventory_after=0", "inventory_before=2;inventory_after=2"),
    valid.replace("x=10", "x=1001"),
    valid.replace("slot=4", "slot=37"),
    valid.replace("inventory_before=1", "inventory_before=2").replace("inventory_after=0", "inventory_after=1"),
    `${valid};target=wood_fence_duplicate`,
    valid.replace("source=(O)322", "source=unknown"),
  ])
    assert.equal(
      STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("place_wood_fence", {
        ...receipt,
        evidence: { detail: malformed },
      }),
      false,
    );
  assert.equal(
    STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("place_wood_fence", {
      ...receipt,
      state: "accepted",
    }),
    false,
  );
});

test("bait_crab_pot completion evidence preserves decimal owner identity and exact native transition", () => {
  const valid =
    "source=(O)685;location=Farm;x=34;y=52;target=bait_crab_pot_ecedec446e08d884;pot=(O)710;slot=5;owner=680508790015262242;bait_before=none;bait_after=(O)685;inventory_before=1;inventory_after=0;actionable=true;active_execution=null";
  const receipt = { state: "succeeded", reasonCode: "crab_pot_baited", evidence: { detail: valid } } as const;
  assert.equal(STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("bait_crab_pot", receipt), true);
  for (const malformed of [
    valid.replace("owner=680508790015262242", "owner=680508790015262242.0"),
    valid.replace("owner=680508790015262242", "owner=-1"),
    valid.replace("bait_before=none", "bait_before=(O)685"),
    valid.replace("bait_after=(O)685", "bait_after=none"),
    valid.replace("inventory_before=1;inventory_after=0", "inventory_before=1;inventory_after=1"),
    valid.replace("actionable=true", "actionable=false"),
    valid.replace("active_execution=null", "active_execution=execution_01"),
    `${valid};owner=680508790015262242`,
    `${valid};unknown=value`,
  ])
    assert.equal(
      STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("bait_crab_pot", {
        ...receipt,
        evidence: { detail: malformed },
      }),
      false,
    );
  assert.equal(
    STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("bait_crab_pot", { ...receipt, state: "accepted" }),
    false,
  );
});

test("dig_artifact_spot completion evidence is strict and source-only", () => {
  const valid =
    "location=Farm;target=artifact_spot_deadbeef;result_target=artifact_result_deadbeef;tile=10,12;tool=hoe;slot=4;stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2;qualified_item_id=(O)590;source_present_before=true;source_present_after=false;hoedirt_present_before=false;hoedirt_present_after=true;source_removed=true";
  const receipt = { state: "succeeded", reasonCode: "artifact_spot_dug", evidence: { detail: valid } };
  assert.equal(STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("dig_artifact_spot", receipt), true);
  for (const malformed of [
    valid.replace(";result_target=artifact_result_deadbeef", ""),
    valid.replace("result_target=artifact_result_deadbeef", "result_target=not opaque"),
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
    valid.replace("hoedirt_present_before=false", "hoedirt_present_before=true"),
    valid.replace("slot=4", "slot=37"),
    `${valid};reward_claimed=false`,
  ])
    assert.equal(
      STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("dig_artifact_spot", {
        ...receipt,
        evidence: { detail: malformed },
      }),
      false,
    );
  assert.equal(
    STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("dig_artifact_spot", {
      ...receipt,
      evidence: {
        detail: valid.replace(
          "stamina_before=100;stamina_after=98;stamina_delta=-2;expected_stamina_cost=2",
          "stamina_before=100;stamina_after=98.5;stamina_delta=-1.5;expected_stamina_cost=1.5",
        ),
      },
    }),
    true,
  );
  assert.equal(
    STARDEW_INTEGRATION_MODULE.actionCatalog.hasCompletionEvidence("dig_artifact_spot", {
      ...receipt,
      state: "accepted",
    }),
    false,
  );
});
