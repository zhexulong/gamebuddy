using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeFeedAnimalFixture(StardewValley.Farm farm, StardewValley.AnimalHouse[] houses)
    {
        if (!long.TryParse(this.config.PlayerId, out long feedFarmhandId))
            throw new InvalidOperationException("fixture_farmhand_id_invalid");
        Farmer? feedFarmhand = Game1.GetPlayer(feedFarmhandId, onlyOnline: false);
        bool feedFarmhandOwnsRetainedCabin = feedFarmhand is not null && farm.buildings
            .Select(building => building.GetIndoors())
            .OfType<StardewValley.Locations.Cabin>()
            .Any(cabin => cabin.OwnerId == feedFarmhandId);
        if (!feedFarmhandOwnsRetainedCabin || feedFarmhand is null)
            throw new InvalidOperationException("fixture_bound_farmhand_missing_after_native_setup");
        if (feedFarmhand.MaxItems < 36)
            feedFarmhand.increaseBackpackSize(36 - feedFarmhand.MaxItems);
        bool hasHay = feedFarmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == "(O)178" && item.Stack > 0);
        if (!hasHay && feedFarmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>("(O)178", 2)) is not null)
            throw new InvalidOperationException("fixture_farmhand_hay_inventory_full");
        bool hasHayAfter = feedFarmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == "(O)178" && item.Stack > 0);
        if (!hasHayAfter)
            throw new InvalidOperationException("fixture_farmhand_hay_missing_after_add");
        string feedInventory = string.Join(",", feedFarmhand.Items.Select((item, slot) => item is null ? $"{slot}:null" : $"{slot}:{item.QualifiedItemId}:stack={item.Stack}"));
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native feed-animal v1 fixture before attachment: animal_houses={houses.Length}; Cabin retained; Farmhand inventory_slots={feedFarmhand.MaxItems}; hay={hasHayAfter}; inventory={feedInventory}; a native save/reload plus production bridge evidence are still required.", LogLevel.Info);
    }
}
