using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeUseItemFixture(StardewValley.Farm farm)
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

        const string foodId = "(O)216";
        StardewValley.Object? food = farmhand.Items.OfType<StardewValley.Object>()
            .FirstOrDefault(item => item.QualifiedItemId == foodId && item.Stack > 0);
        if (food is null)
        {
            StardewValley.Object suppliedFood = ItemRegistry.Create<StardewValley.Object>(foodId, 3);
            if (farmhand.addItemToInventory(suppliedFood) is not null)
                throw new InvalidOperationException("fixture_farmhand_food_inventory_full");
            food = farmhand.Items.OfType<StardewValley.Object>()
                .FirstOrDefault(item => item.QualifiedItemId == foodId && item.Stack > 0);
        }
        if (food is null || food.Edibility == -300 || (Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink))
            throw new InvalidOperationException("fixture_farmhand_food_missing_after_add");

        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native use-item v1 fixture before attachment: Cabin retained; food={food.QualifiedItemId}; stack={food.Stack}; edibility={food.Edibility}; Farmhand inventory_slots={farmhand.MaxItems}; production Farmer.eatHeldObject plus animation and stack postconditions are still required.", LogLevel.Info);
    }
}
