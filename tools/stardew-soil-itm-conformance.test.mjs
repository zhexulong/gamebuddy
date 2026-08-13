import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assessSoilItmConformance, validateSoilItmConformance } from "./lib/stardew-soil-itm-conformance.mjs";

const model = JSON.parse(await readFile(new URL("./stardew-soil-itm-canary.model.json", import.meta.url), "utf8"));
const sourceReport = { modelKind: "derived_soil_interaction_transition_model", sourceManifestSha256: "a".repeat(64) };
const projections = [
  { interactionClassId: "soil.till", bridgeAction: "till_soil" },
  { interactionClassId: "soil.plant_seed", bridgeAction: "plant_seed" },
  { interactionClassId: "soil.fertilize_tile", bridgeAction: "fertilize_tile" },
  { interactionClassId: "soil.water", bridgeAction: "water_crop" },
  { interactionClassId: "soil.harvest_grab", bridgeAction: "harvest_crop" },
];
const target = { targetVersion: "1.6.15.24356" };

function liveCases() {
  return [
    {
      interactionClassId: "soil.till",
      receipt: { state: "succeeded", reasonCode: "soil_tilled", evidence: { detail: "before=none;after=HoeDirt" } },
      freshPostcondition: { targetNoLongerEligible: true },
      runnerEvidence: target,
    },
    {
      interactionClassId: "soil.plant_seed",
      expected: { qualifiedItemId: "(O)479" },
      receipt: {
        state: "succeeded",
        reasonCode: "seed_planted",
        evidence: { detail: "crop=479;item=(O)479;inventory_before=2;inventory_after=1" },
      },
      freshPostcondition: { targetNoLongerEligible: true },
      runnerEvidence: target,
    },
    {
      interactionClassId: "soil.fertilize_tile",
      expected: { qualifiedItemId: "(O)368" },
      receipt: {
        state: "succeeded",
        reasonCode: "fertilizer_applied",
        evidence: { detail: "fertilizer_before=none;fertilizer_after=(O)368;inventory_before=2;inventory_after=1" },
      },
      freshPostcondition: { targetNoLongerEligible: true },
      runnerEvidence: target,
    },
    {
      interactionClassId: "soil.water",
      receipt: {
        state: "succeeded",
        reasonCode: "crop_watered",
        evidence: { detail: "water_before=40;water_after=39" },
      },
      freshPostcondition: { targetNoLongerEligible: true, watered: true },
      runnerEvidence: target,
    },
    {
      interactionClassId: "soil.harvest_grab",
      receipt: {
        state: "succeeded",
        reasonCode: "crop_harvested",
        evidence: { detail: "native_accepted=true;inventory_gained=true;crop_present_after=true" },
      },
      freshPostcondition: { targetNoLongerEligible: true, cropPresentAfter: true },
      runnerEvidence: target,
    },
  ];
}

test("accepts independently recorded live cases only when every ITM observable commit conforms", () => {
  const result = validateSoilItmConformance({ model, projections, liveCases: liveCases(), sourceReport });
  assert.equal(result.state, "all_declared_soil_classes_have_live_conformance_evidence");
  assert.equal(result.classCount, 5);
});

test("rejects a missing class live case", () => {
  const entries = liveCases().filter((entry) => entry.interactionClassId !== "soil.harvest_grab");
  assert.throws(() => validateSoilItmConformance({ model, projections, liveCases: entries, sourceReport }), {
    code: "soil_itm_conformance_live_missing",
  });
});

test("rejects an incorrect seed receipt even if it says succeeded", () => {
  const entries = liveCases();
  entries[1].receipt.evidence.detail = "crop=479;item=(O)479;inventory_before=2;inventory_after=2";
  assert.throws(() => validateSoilItmConformance({ model, projections, liveCases: entries, sourceReport }), {
    code: "soil_itm_conformance_observable_mismatch",
  });
});

test("rejects a projection that silently omits a model class", () => {
  assert.throws(
    () =>
      validateSoilItmConformance({
        model,
        projections: projections.slice(0, -1),
        liveCases: liveCases(),
        sourceReport,
      }),
    { code: "soil_itm_conformance_projection_missing" },
  );
});

test("assessment stays incomplete when a real target environment or evidence is unavailable", () => {
  const result = assessSoilItmConformance({ model, projections, sourceReport, environment: { state: "blocked" } });
  assert.equal(result.state, "incomplete_pending_independent_live_conformance");
  assert.deepEqual(result.missingLiveEvidence, [
    "soil.till",
    "soil.plant_seed",
    "soil.fertilize_tile",
    "soil.water",
    "soil.harvest_grab",
  ]);
  assert.deepEqual(result.missingProtocolEvidence, ["native_day_progression_with_fresh_observation"]);
});

test("assessment requires independent native day/fresh-observation protocol evidence too", () => {
  const result = assessSoilItmConformance({
    model,
    projections,
    liveCases: liveCases(),
    sourceReport,
    environment: { state: "ready" },
  });
  assert.equal(result.state, "incomplete_pending_independent_live_conformance");
  assert.deepEqual(result.missingProtocolEvidence, ["native_day_progression_with_fresh_observation"]);
});
