using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativePlantSeedFixture(StardewValley.Farm farm, StardewValley.AnimalHouse[] houses)
    {
        if (!long.TryParse(this.config.PlayerId, out long seedFarmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? seedFarmhand = Game1.GetPlayer(seedFarmhandId, onlyOnline: false);
        bool seedFarmhandOwnsRetainedCabin = seedFarmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == seedFarmhandId);
        if (!seedFarmhandOwnsRetainedCabin || seedFarmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
        if (seedFarmhand.MaxItems < 36)
            seedFarmhand.increaseBackpackSize(36 - seedFarmhand.MaxItems);
        // The validated fixture template is in Summer; use a normal Summer
        // crop seed so target-version canPlantThisSeedHere remains an
        // actual production precondition rather than a forced fixture fact.
        const string seedId = "(O)479";
        bool hasSeed = seedFarmhand.Items.OfType<StardewValley.Object>()
            .Any(item => item.QualifiedItemId == seedId && item.Stack > 0);
        if (!hasSeed && seedFarmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(seedId, 2)) is not null)
            throw new InvalidOperationException("fixture_farmhand_seed_inventory_full");
        if (!seedFarmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == seedId && item.Stack > 0))
            throw new InvalidOperationException("fixture_farmhand_seed_missing_after_add");
        // SetupBigFarm creates grown crops. The target-version debug
        // commands remove only fixture HoeDirt and repopulate legal,
        // empty native ground dirt; they never create a crop or invoke
        // Object.placementAction, so production alone owns crop creation.
        GameLocation? seedSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null) || !Game1.game1.parseDebugInput("SpreadDirt", null))
                throw new InvalidOperationException("fixture_native_empty_dirt_command_unavailable");
        }
        finally
        {
            Game1.currentLocation = seedSetupPreviousLocation;
        }
        Vector2[] eligibleDirt = farm.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is null
                && !(farm.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
                && dirt.canPlantThisSeedHere(seedId[3..^1], isFertilizer: false))
            .Select(pair => pair.Key)
            .ToArray();
        if (eligibleDirt.Length == 0)
            throw new InvalidOperationException("fixture_native_seed_target_missing");
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native plant-seed v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={seedFarmhand.MaxItems}; seed={seedId}; eligible_empty_dirt_count={eligibleDirt.Length}; eligible_empty_dirt_tiles={string.Join("|", eligibleDirt.Take(16).Select(tile => $"{(int)tile.X},{(int)tile.Y}"))}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
    }
}
