using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void PrepareNativeHarvestCropFixture(StardewValley.Farm farm)
    {
        // SetupBigFarm seeds 472..476, which are out of season in the
        // Summer template and are killed by the native GrowCrops pass.
        // Re-seed the same native crop plot with in-season Tomato
        // Seeds, then let the target-version GrowCrops command advance
        // the crop to its ready phase. This is fixture setup only: it
        // never calls HoeDirt.performUseAction or Crop.harvest.
        GameLocation? previousHarvestLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("SpreadSeeds 480", null)
                || !Game1.game1.parseDebugInput("GrowCrops 11", null))
                throw new InvalidOperationException("fixture_native_crop_setup_unavailable");
        }
        finally
        {
            Game1.currentLocation = previousHarvestLocation;
        }
    }

    private void InitializeNativeHarvestCropFixture(StardewValley.Farm farm)
    {
        long farmhandId = this.ResolveBoundFarmhandId();
        Farmer? farmhand = Game1.GetPlayer(farmhandId, onlyOnline: false);
        bool ownsRetainedCabin = farmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == farmhandId);
        if (!ownsRetainedCabin || farmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing");
        if (farmhand.MaxItems < 36)
            farmhand.increaseBackpackSize(36 - farmhand.MaxItems);

        // SetupBigFarm has already used the target-version GrowCrops command.
        // Select only a ready ordinary Grab crop from its native crop plot; do
        // not call Crop.harvest, performUseAction, destroyCrop, or add harvest
        // output here. Production must independently rediscover this target.
        const int cropPlotAnchorX = 38;
        const int cropPlotAnchorY = 18;
        KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>? selected = farm.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && dirt.readyForHarvest()
                && dirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value))
            .Select(pair => new KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>(pair.Key, (StardewValley.TerrainFeatures.HoeDirt)pair.Value))
            .Where(pair => Math.Max(Math.Abs((int)pair.Key.X - cropPlotAnchorX), Math.Abs((int)pair.Key.Y - cropPlotAnchorY)) <= 1)
            .OrderBy(pair => Math.Max(Math.Abs((int)pair.Key.X - cropPlotAnchorX), Math.Abs((int)pair.Key.Y - cropPlotAnchorY)))
            .ThenBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y)
            .Cast<KeyValuePair<Vector2, StardewValley.TerrainFeatures.HoeDirt>?>()
            .FirstOrDefault();
        if (selected is null || selected.Value.Value.crop is null)
            throw new InvalidOperationException("fixture_native_ready_grab_crop_missing");

        StardewValley.Crop crop = selected.Value.Value.crop;
        StardewValley.Item harvestItem;
        try
        {
            harvestItem = ItemRegistry.Create(crop.indexOfHarvest.Value, 1);
        }
        catch (Exception)
        {
            throw new InvalidOperationException("fixture_native_harvest_item_missing");
        }
        if (!farmhand.couldInventoryAcceptThisItem(harvestItem))
            throw new InvalidOperationException("fixture_farmhand_harvest_inventory_unavailable");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native harvest-crop v1 fixture before attachment: Cabin retained; selected={crop.netSeedIndex.Value ?? "unknown"}@{(int)selected.Value.Key.X},{(int)selected.Value.Key.Y}; harvest={harvestItem.QualifiedItemId}; ready={selected.Value.Value.readyForHarvest()}; harvest_method={crop.GetHarvestMethod()}; regrows={crop.RegrowsAfterHarvest()}; Farmhand inventory_slots={farmhand.MaxItems}; production HoeDirt.performUseAction plus native inventory and crop postconditions are still required.", LogLevel.Info);
    }
}
