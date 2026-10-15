using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeFertilizeTileFixture(StardewValley.Farm farm, StardewValley.AnimalHouse[] houses)
    {
        if (!long.TryParse(this.config.PlayerId, out long fertilizerFarmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? fertilizerFarmhand = Game1.GetPlayer(fertilizerFarmhandId, onlyOnline: false);
        bool fertilizerFarmhandOwnsRetainedCabin = fertilizerFarmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == fertilizerFarmhandId);
        if (!fertilizerFarmhandOwnsRetainedCabin || fertilizerFarmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
        if (fertilizerFarmhand.MaxItems < 36)
            fertilizerFarmhand.increaseBackpackSize(36 - fertilizerFarmhand.MaxItems);
        const string fertilizerId = "(O)368";
        bool hasFertilizer = fertilizerFarmhand.Items.OfType<StardewValley.Object>()
            .Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0);
        if (!hasFertilizer && fertilizerFarmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(fertilizerId, 2)) is not null)
            throw new InvalidOperationException("fixture_farmhand_fertilizer_inventory_full");
        bool hasFertilizerAfter = fertilizerFarmhand.Items.OfType<StardewValley.Object>()
            .Any(item => item.QualifiedItemId == fertilizerId && item.Stack > 0);
        if (!hasFertilizerAfter)
            throw new InvalidOperationException("fixture_farmhand_fertilizer_missing_after_add");
        Microsoft.Xna.Framework.Vector2[] eligibleDirt = farm.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt && dirt.CanApplyFertilizer(fertilizerId))
            .Select(pair => pair.Key)
            .ToArray();
        string[] eligibleDirtTiles = eligibleDirt
            .Take(16)
            .Select(tile => $"{(int)tile.X},{(int)tile.Y}")
            .ToArray();
        if (eligibleDirt.Length == 0)
            throw new InvalidOperationException("fixture_native_fertilizer_target_missing");
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native fertilize-tile v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={fertilizerFarmhand.MaxItems}; fertilizer={fertilizerId}; eligible_dirt_count={eligibleDirt.Length}; eligible_dirt_tiles={string.Join("|", eligibleDirtTiles)}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
    }
}
