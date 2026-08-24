import assert from "node:assert/strict";
import test from "node:test";
import { deriveSoilTileSemanticKernels, methodBody } from "./lib/stardew-source-semantic-kernel.mjs";

function source(methodName, fragments) {
  return `public void ${methodName}() {\n${fragments.map((fragment) => `  ${fragment};`).join("\n")}\n}`;
}

function soilSources() {
  return {
    "StardewValley/Game1.cs": source("pressUseToolButton", [
      "player.CurrentTool.DoFunction(location, x, y, power, player)",
      "Utility.tryToPlaceItem(currentLocation, player.ActiveObject, x, y)",
    ]),
    "StardewValley/Tools/Hoe.cs": source("DoFunction", [
      "tilesAffected(vector, power, who)",
      "location.makeHoeDirt(item)",
      "location.checkForBuriedItem(x, y, false, false, who)",
    ]),
    "StardewValley/Tools/WateringCan.cs": source("DoFunction", [
      "CanRefillWateringCanOnTile(x, y)",
      "WaterLeft > 0 || who.hasWateringCanEnchantment",
      "value.performToolAction(this, 0, item)",
    ]),
    "StardewValley/TerrainFeatures/HoeDirt.cs": [
      source("performUseAction", [
        "HarvestMethod.Grab",
        "crop.harvest((int)tileLocation.X, (int)tileLocation.Y, this)",
        "destroyCrop(showAnimation: false)",
      ]),
      source("plant", [
        "if (isFertilizer)",
        "CanApplyFertilizer(itemId)",
        "fertilizer.Value = ItemRegistry.QualifyItemId(itemId) ?? itemId",
        "Crop.ResolveSeedId(itemId, location)",
        "who.currentLocation.CheckItemPlantRules(itemId, a, b, out deniedMessage)",
        "who.currentLocation.CanPlantSeedsHere(itemId, x, y, flag, out deniedMessage)",
        "crop = new Crop(itemId, point.X, point.Y, Location)",
      ]),
      source("performToolAction", ["if (t is WateringCan)", "state.Value = 1"]),
    ].join("\n"),
    "StardewValley/Object.cs": source("placementAction", [
      "base.Category == -74 || base.Category == -19",
      "dirt.canPlantThisSeedHere(text4, who.ActiveObject.Category == -19)",
      "dirt.plant(text4, who, who.ActiveObject.Category == -19)",
      "item2.Category == -19 && dirt.plant(item2.ItemId, who, isFertilizer: true)",
    ]),
    "StardewValley/Utility.cs": source("tryToPlaceItem", [
      "item.placementAction(location, x, y, Game1.player)",
      "Game1.player.reduceActiveItemByOne()",
    ]),
    "StardewValley/Crop.cs": source("harvest", [
      "currentPhase.Value >= phaseDays.Count - 1",
      "Game1.player.addItemToInventoryBool(item.getOne())",
      "Game1.createItemDebris(item.getOne(), position, -1)",
    ]),
  };
}

test("methodBody finds a balanced C# method body while ignoring braces in strings", () => {
  const body = methodBody('public void Example() { var s = "}"; if (true) { Call(); } }', "Example");
  assert.match(body, /Call\(\)/);
});

test("derives the source-reused soil input kernel as a closed discriminated union", () => {
  const result = deriveSoilTileSemanticKernels(soilSources());
  assert.equal(result.state, "source_derived_candidate");
  assert.equal(result.factorization.existingPublishedActionCountInDomain, 5);
  assert.equal(result.factorization.sourceDerivedKernelCount, 4);
  assert.deepEqual(result.factorization.projections, {
    till_soil: "soil.till",
    plant_seed: "soil.apply_input[inputKind=seed]",
    fertilize_tile: "soil.apply_input[inputKind=fertilizer]",
    water_crop: "soil.hydrate",
    harvest_crop: "soil.harvest_grab",
  });
  const input = result.semanticKernels.find((kernel) => kernel.kernelId === "soil.apply_input");
  assert.deepEqual(
    input.variants.map((variant) => variant.inputKind),
    ["seed", "fertilizer"],
  );
  assert.match(input.publicContractConstraint, /arbitrary placeable objects/);
});

test("fails closed when target-version source no longer proves a shared input commit", () => {
  const sources = soilSources();
  sources["StardewValley/Utility.cs"] = source("tryToPlaceItem", [
    "item.placementAction(location, x, y, Game1.player)",
  ]);
  assert.throws(() => deriveSoilTileSemanticKernels(sources), {
    code: "source_semantic_kernel_evidence_missing",
  });
});
