import assert from "node:assert/strict";
import test from "node:test";
import {
  contentAssetIsGameplayRelevant,
  classifyDataLoaderTable,
  contentOperationDomain,
  dataLoaderAssetPath,
  logicalContentAssetPath,
  logicalContentOperationFamily,
  knownToolBasisIds,
} from "./lib/stardew-gameplay-surface-rules.mjs";

test("FishingRod discovery names the unified fish lifecycle capability", () => {
  assert.deepEqual(knownToolBasisIds("StardewValley.Tools.FishingRod"), ["fish"]);
});

test("content classification collapses localized copies and preserves logical operation domains", () => {
  const localized = "Data/Events/Town.zh-CN.xnb";
  assert.equal(logicalContentAssetPath(localized), "Data/Events/Town.xnb");
  assert.equal(logicalContentOperationFamily(localized), "Data/Events");
  assert.deepEqual(contentOperationDomain(localized), { domainKind: "event_map", keyDomain: "Town" });
});

test("content classification distinguishes finite data tables from map and minigame assets", () => {
  assert.equal(contentAssetIsGameplayRelevant("Data/Machines.xnb"), true);
  assert.deepEqual(contentOperationDomain("Data/Machines.xnb"), { domainKind: "data_table", keyDomain: "Machines" });
  assert.deepEqual(contentOperationDomain("Maps/AdventureGuild.xnb"), { domainKind: "map_asset", keyDomain: "AdventureGuild" });
  assert.deepEqual(contentOperationDomain("Minigames/Darts.xnb"), { domainKind: "minigame_asset", keyDomain: "Darts" });
});

test("visual-only assets are not promoted to gameplay operation nodes", () => {
  assert.equal(contentAssetIsGameplayRelevant("Portraits/Abigail.xnb"), false);
  assert.equal(contentAssetIsGameplayRelevant("TileSheets/indoor.xnb"), false);
});

test("DataLoader table classification uses target-game tables without copying their keys", () => {
  assert.equal(dataLoaderAssetPath("Festivals_FestivalDates"), "Data/Festivals/FestivalDates.xnb");
  assert.deepEqual(classifyDataLoaderTable("CraftingRecipes"), {
    mappingStatus: "needs_expansion",
    semanticKind: "crafting_recipe_content",
    contentOperationFamily: "Data/CraftingRecipes",
    contentOperationDomain: { domainKind: "data_table", keyDomain: "CraftingRecipes" },
  });
  assert.deepEqual(classifyDataLoaderTable("AnimationDescriptions"), {
    mappingStatus: "not_surface",
    semanticKind: "supporting_content_data",
  });
});
