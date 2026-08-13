import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveSoilInteractionTransitionModel, sourceManifestForSoilItm } from "./lib/stardew-soil-itm-canary.mjs";

const root = new URL("../.tmp-stardew-decompile/", import.meta.url);
const paths = [
  "StardewValley/Tools/Hoe.cs",
  "StardewValley/Object.cs",
  "StardewValley/Utility.cs",
  "StardewValley/TerrainFeatures/HoeDirt.cs",
  "StardewValley/Tools/WateringCan.cs",
  "StardewValley/Crop.cs",
];

async function fixture() {
  const sourceFiles = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await readFile(new URL(path, root), "utf8")])),
  );
  const model = JSON.parse(await readFile(new URL("./stardew-soil-itm-canary.model.json", import.meta.url), "utf8"));
  model.sourceManifestSha256 = sourceManifestForSoilItm(sourceFiles).sha256;
  return { sourceFiles, model };
}

test("derives a trace-first soil ITM with source-realization witnesses", async () => {
  const input = await fixture();
  const result = deriveSoilInteractionTransitionModel(input);
  assert.equal(result.canaryId, "stardew_1_6_15_soil_interaction_transition_model_v1");
  assert.equal(result.coverage.traceClosureState, "scope_bounded_complete");
  assert.equal(result.coverage.interactionClassCount, 5);
  assert.equal(result.coverage.protocolCount, 1);
  assert.equal(result.analysisBoundary.legacyCatalog, "not_read");
  assert.equal(result.analysisBoundary.publicActionProjection, "not_performed");
  assert.ok(result.interactionClasses.every((entry) => entry.nativeWitnesses.length > 0));
  assert.equal(result.protocols[0].protocolId, "native_day_progression_with_fresh_observation");
});

test("fails closed when a required source witness drifts", async () => {
  const input = await fixture();
  input.sourceFiles["StardewValley/Tools/Hoe.cs"] = input.sourceFiles["StardewValley/Tools/Hoe.cs"].replace(
    "location.makeHoeDirt(item)",
    "location.makeChangedDirt(item)",
  );
  assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_source_manifest_mismatch" });
});

test("rejects a source model that erases seed/fertilizer semantic separation", async () => {
  const input = await fixture();
  input.model.separationObligations = input.model.separationObligations.filter(
    (entry) => entry.leftClassId !== "soil.plant_seed",
  );
  assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_separation_missing" });
});

test("rejects a source model that omits an action-layer deletion counterfactual", async () => {
  const input = await fixture();
  input.model.irredundancyObligations = input.model.irredundancyObligations.filter(
    (entry) => entry.interactionClassId !== "soil.water",
  );
  assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_irredundancy_missing" });
});

test("rejects product registry vocabulary as a model input", async () => {
  const input = await fixture();
  input.model.interactionClasses[0].actionId = "till_soil";
  assert.throws(() => deriveSoilInteractionTransitionModel(input), { code: "soil_itm_forbidden_vocabulary" });
});
