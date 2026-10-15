using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeTillSoilFixture(StardewValley.Farm farm, StardewValley.AnimalHouse[] houses)
    {
        if (!long.TryParse(this.config.PlayerId, out long tillFarmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? tillFarmhand = Game1.GetPlayer(tillFarmhandId, onlyOnline: false);
        bool tillFarmhandOwnsRetainedCabin = tillFarmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == tillFarmhandId);
        if (!tillFarmhandOwnsRetainedCabin || tillFarmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
        if (tillFarmhand.MaxItems < 36)
            tillFarmhand.increaseBackpackSize(36 - tillFarmhand.MaxItems);
        if (!tillFarmhand.Items.OfType<Hoe>().Any()
            && tillFarmhand.addItemToInventory(new Hoe()) is not null)
            throw new InvalidOperationException("fixture_farmhand_hoe_inventory_full");
        if (!tillFarmhand.Items.OfType<Hoe>().Any())
            throw new InvalidOperationException("fixture_farmhand_hoe_missing_after_add");

        // SetupBigFarm starts with terrain features in its crop plot.
        // Reuse target-version debug commands only to establish legal,
        // empty ground for a future Hoe hit; production alone invokes
        // Hoe.DoFunction and creates the target postcondition.
        GameLocation? tillSetupPreviousLocation = Game1.currentLocation;
        try
        {
            Game1.currentLocation = farm;
            if (!Game1.game1.parseDebugInput("RemoveDirt", null))
                throw new InvalidOperationException("fixture_native_remove_dirt_command_unavailable");
        }
        finally
        {
            Game1.currentLocation = tillSetupPreviousLocation;
        }
        Vector2[] eligibleSoil = Enumerable.Range(0, farm.map.Layers[0].LayerWidth)
            .SelectMany(x => Enumerable.Range(0, farm.map.Layers[0].LayerHeight)
                .Select(y => new Vector2(x, y)))
            .Where(tile => farm.GetHoeDirtAtTile(tile) is null
                && farm.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Diggable", "Back") is not null
                && !farm.isWaterTile((int)tile.X, (int)tile.Y))
            .Take(64)
            .ToArray();
        if (eligibleSoil.Length == 0)
            throw new InvalidOperationException("fixture_native_tillable_soil_missing");
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native till-soil v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={tillFarmhand.MaxItems}; hoe=true; eligible_soil_count={eligibleSoil.Length}; eligible_soil_tiles={string.Join("|", eligibleSoil.Take(16).Select(tile => $"{(int)tile.X},{(int)tile.Y}"))}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
    }
}
