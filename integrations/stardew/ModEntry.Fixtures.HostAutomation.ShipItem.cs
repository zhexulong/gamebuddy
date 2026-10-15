using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    private void InitializeNativeShipItemFixture(StardewValley.Farm farm)
    {
        // Pre-attachment fixture only, on the Host side of the LAN topology: the
        // naturally-loaded Farm keeps its single native "Shipping Bin" building
        // (Farm.cs:173 AddDefaultBuilding) and the already-bound Farmhand's own
        // backpack gains one ordinary shippable Object. Production alone calls
        // Farm.shipItem and owns all receipt/postcondition evidence; the night
        // settlement stays entirely native.
        Farmer farmhand = this.ResolveHostAutomationFarmhand(farm);
        const string shipItemId = "(O)24";
        if (!farmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == shipItemId && item.Stack > 0)
            && farmhand.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(shipItemId, 1)) is not null)
            throw new InvalidOperationException("fixture_farmhand_ship_item_inventory_full");
        if (!farmhand.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == shipItemId && item.Stack > 0))
            throw new InvalidOperationException("fixture_farmhand_ship_item_missing_after_add");
        StardewValley.Buildings.ShippingBin? bin = farm.buildings.OfType<StardewValley.Buildings.ShippingBin>().FirstOrDefault();
        if (bin is null || bin.daysOfConstructionLeft.Value > 0)
            throw new InvalidOperationException("fixture_native_ship_item_bin_missing");
        // The production seam resolves its settlement container through
        // Farm.getShippingBin(who), which selects the personal bin only when the
        // live team flag useSeparateWallets is set (Farm.cs:1025-1032). Resolve
        // it for the bound Farmhand — the actor the tested call will actually run
        // as — so the fixture empties the exact container that will be written to
        // under either flag setting, and the shipped-stack delta stays
        // unambiguous. This is pre-attachment fixture state only.
        StardewValley.Inventories.IInventory destinationBin = farm.getShippingBin(farmhand);
        destinationBin.Clear();
        if (destinationBin.CountItemStacks() != 0)
            throw new InvalidOperationException("fixture_native_ship_item_bin_not_empty");
        Vector2? standing = FindNativeLocalShippingBinStandingTile(farm, bin);
        if (standing is null)
            throw new InvalidOperationException("fixture_native_ship_item_standing_tile_missing");
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log($"GameBuddy HostAutomation initialized native ship-item v1 fixture before attachment: Cabin retained; farmhand={farmhand.UniqueMultiplayerID}; item={shipItemId}; bin={bin.tileX.Value},{bin.tileY.Value}; separate_wallets={Game1.player.team.useSeparateWallets.Value}; bin_empty_start=true; approach={standing.Value.X},{standing.Value.Y}; production alone invokes Farm.shipItem and emits receipt.", LogLevel.Info);
    }
}
