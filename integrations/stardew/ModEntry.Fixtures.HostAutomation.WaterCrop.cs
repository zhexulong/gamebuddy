using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeWaterCropFixture(StardewValley.Farm farm, StardewValley.AnimalHouse[] houses)
    {
        if (!long.TryParse(this.config.PlayerId, out long waterFarmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? waterFarmhand = Game1.GetPlayer(waterFarmhandId, onlyOnline: false);
        bool waterFarmhandOwnsRetainedCabin = waterFarmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == waterFarmhandId);
        if (!waterFarmhandOwnsRetainedCabin || waterFarmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
        if (waterFarmhand.MaxItems < 36)
            waterFarmhand.increaseBackpackSize(36 - waterFarmhand.MaxItems);
        WateringCan? availableCan = waterFarmhand.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
        if (availableCan is null)
        {
            WateringCan suppliedCan = new();
            if (waterFarmhand.addItemToInventory(suppliedCan) is not null)
                throw new InvalidOperationException("fixture_farmhand_watering_can_inventory_full");
            availableCan = waterFarmhand.Items.OfType<WateringCan>().FirstOrDefault(candidate => candidate.WaterLeft > 0);
        }
        if (availableCan is null)
            throw new InvalidOperationException("fixture_farmhand_watering_can_missing_after_add");
        // SetupBigFarm finishes ordinary crops with GrowCrops, and a
        // mature non-regrowing crop no longer needs water. Use the
        // target-version debug seed spreader only to establish a new
        // native, unwatered crop precondition; never invoke `Water` or
        // assign HoeDirt state directly.
        GameLocation? cropSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("SpreadSeeds 472", null))
                throw new InvalidOperationException("fixture_native_spread_seeds_command_unavailable");
        }
        finally
        {
            Game1.currentLocation = cropSetupPreviousLocation;
        }
        int dryCropCount = farm.terrainFeatures.Pairs.Count(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
            && dirt.needsWatering() && !dirt.isWatered());
        if (dryCropCount == 0)
            throw new InvalidOperationException("fixture_native_unwatered_crop_missing");
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native water-crop v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={waterFarmhand.MaxItems}; watering_can_water={availableCan.WaterLeft}; unwatered_crop_count={dryCropCount}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
    }
}
