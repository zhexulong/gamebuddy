using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.GameData.Shops;
using StardewValley.GameData.Tools;
using StardewValley.Internal;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// shop_purchase pre-attachment Given: the actor stands in the SeedShop, the clock is
    /// inside trading hours, and Pierre is present and within interaction reach.
    ///
    /// Only the declared Given is established. The shop's stock, its owner eligibility
    /// (<c>ShopOwnerData.Condition</c>), the price, the money movement and the inventory
    /// insertion are all the game's, read and driven at admission time. This fixture emits
    /// no receipt — the action under test is the purchase.
    ///
    /// Two facts are asserted BEFORE the bridge attaches, so a wrong fixture fails loudly
    /// here instead of looking like a product bug later:
    ///
    /// <list type="number">
    /// <item>the live <c>Data/Shops</c> entry for SeedShop has at least one owner entry the
    /// game currently considers eligible (<c>ShopBuilder.GetCurrentOwners</c>). If it does
    /// not, the clock is wrong, not the action.</item>
    /// <item>Pierre is actually found in the SeedShop character list at the tile the Mod
    /// put him on.</item>
    /// </list>
    /// </summary>
    private void InstallNativeLocalShopPurchaseFixture(Farmer player)
    {
        // The template is a FarmHouse morning. Warp into the SeedShop interior first, so
        // the location and its character list are the ones the purchase will use.
        if (Game1.getLocationFromName("SeedShop") is not GameLocation shop)
            throw new InvalidOperationException("fixture_native_local_shop_purchase_seed_shop_missing");

        // Trading hours. SeedShop's content condition is written against the clock, so the
        // fixture moves the clock rather than guessing what that condition says: 12:00 is
        // inside the window vanilla uses, and the assertion below proves it took effect.
        Game1.timeOfDay = 1200;
        if (Game1.timeOfDay != 1200)
            throw new InvalidOperationException("fixture_native_local_shop_purchase_clock_not_set");

        // Pierre must be physically present: TryOpenShopMenu only considers NPCs in the
        // location's character list (Utility.cs, the ownerArea loop). A morning template has
        // him on his own schedule, so placing him here is the same world fact his trading
        // schedule produces, and is disposable fixture state (same approach as the bus
        // fixture placing Pam on her on-duty tile).
        NPC? owner = Game1.getCharacterFromName("Pierre");
        if (owner is null)
            throw new InvalidOperationException("fixture_native_local_shop_purchase_owner_missing");
        if (!shop.characters.Contains(owner))
            shop.characters.Add(owner);

        // A walkable, unoccupied standing tile for the actor, and an owner tile Chebyshev-1
        // from it — that distance is the interaction radius the Mod re-derives at admission
        // (Utility.tileWithinRadiusOfPlayer(..., 1)).
        Vector2? standing = null;
        Vector2 ownerTile = Vector2.Zero;
        for (int x = 1; x < shop.Map.Layers[0].LayerWidth - 1 && standing is null; x++)
        {
            for (int y = 1; y < shop.Map.Layers[0].LayerHeight - 1 && standing is null; y++)
            {
                Vector2 candidate = new(x, y);
                if (!shop.isTileOnMap(candidate) || !shop.isTilePassable(candidate))
                    continue;
                if (shop.IsTileOccupiedBy(candidate, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                    continue;

                // An owner tile one step away that is itself walkable (the shop counter
                // area is walkable in the SeedShop map).
                foreach (Vector2 offset in new[]
                {
                    new Vector2(1f, 0f), new Vector2(-1f, 0f), new Vector2(0f, 1f),
                    new Vector2(0f, -1f), new Vector2(1f, 1f), new Vector2(-1f, 1f),
                    new Vector2(1f, -1f), new Vector2(-1f, -1f),
                })
                {
                    Vector2 neighbour = candidate + offset;
                    if (!shop.isTileOnMap(neighbour) || !shop.isTilePassable(neighbour))
                        continue;
                    standing = candidate;
                    ownerTile = neighbour;
                    break;
                }
            }
        }
        if (standing is null)
            throw new InvalidOperationException("fixture_native_local_shop_purchase_standing_tile_missing");

        owner.Position = new Vector2(ownerTile.X * 64f, ownerTile.Y * 64f);
        if (!shop.characters.Contains(owner))
            throw new InvalidOperationException("fixture_native_local_shop_purchase_owner_not_present");

        // The declared Given is only real if the GAME agrees a shop is open here, so ask
        // it exactly the way discovery does.
        bool anyEligibleOwner = DataLoader.Shops(Game1.content).TryGetValue("SeedShop", out ShopData? shopData)
            && shopData is not null
            && ShopBuilder.GetCurrentOwners(shopData).Any();
        if (!anyEligibleOwner)
            throw new InvalidOperationException("fixture_native_local_shop_purchase_no_eligible_seed_shop_owner");

        player.warpFarmer(new Warp(0, 0, shop.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized shop-purchase precondition before bridge attachment: "
                + $"location={shop.NameOrUniqueName};standing={(int)standing.Value.X},{(int)standing.Value.Y};"
                + $"owner={owner.Name};owner_tile={(int)ownerTile.X},{(int)ownerTile.Y};"
                + $"time_of_day={Game1.timeOfDay};money={player.Money}");
    }

    /// <summary>The tool the upgrade Given supplies.</summary>
    private const string ToolUpgradeFixtureTool = "CopperHoe";

    /// <summary>The shop the engine's own upgrade branch answers to (Tool.cs:875), opened by
    /// <c>Utility.TryOpenShopMenu("ClintUpgrade", "Clint")</c> from the blacksmith's Upgrade answer
    /// (GameLocation.cs:12342).</summary>
    private const string ToolUpgradeFixtureShopId = "ClintUpgrade";

    /// <summary>
    /// shop_purchase's SECOND Given: the actor stands at the blacksmith's counter with exactly ONE upgradeable tool in
    /// the pack, and the purse and the material that tool's own upgrade entry charges.
    ///
    /// <para>
    /// Only that Given is established. What the shop sells, what it charges, which material it takes and the upgrade
    /// itself are the game's: this fixture asks <c>ShopBuilder.GetToolUpgradeData</c> (the call
    /// <c>Tool.actionWhenPurchased</c> reads, Tool.cs:879) what the entry for this tool needs, and
    /// <c>ShopBuilder.GetShopStock</c> (the call the menu is built from, ShopMenu.cs:278-281) whether the blacksmith
    /// really sells it. It emits no receipt.
    /// </para>
    /// <para>
    /// EXACTLY ONE tool, because the shop's tool rows are derived from what the pack can upgrade
    /// (<c>TOOL_UPGRADES</c>, ItemQueryResolver.cs:604-641): leaving the template's base axe, pickaxe and can in the pack
    /// would give the same shop four upgrade rows and make the caller's entry ambiguous.
    /// </para>
    /// <para>
    /// The counter is the ENGINE's arrangement, read from the map the same way <c>open_geode</c>'s fixture reads it: the
    /// <c>Action: Blacksmith</c> tile, the actor on the row below it, Clint behind it. Whether DISCOVERY publishes this
    /// counter is deliberately not asserted - that is <c>EnumerateShopCounters</c>'s answer at request time - so the
    /// fixture logs the owner rows the game reports instead of pre-judging them.
    /// </para>
    /// </summary>
    private void InstallNativeLocalShopToolUpgradeFixture(Farmer player)
    {
        // The template is a FarmHouse morning. Warp into the Blacksmith first, so the location and its character list
        // are the ones the purchase will use. The location, the owner and the counter tile are the SAME counter family
        // `open_geode` reads, so they are read through that one set of constants rather than respelled here.
        if (Game1.getLocationFromName(ExecutionManager.GeodeCounterLocationName) is not GameLocation shop)
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_blacksmith_missing");

        // Trading hours, the world fact that puts Clint behind his counter.
        Game1.timeOfDay = 1200;
        if (Game1.timeOfDay != 1200)
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_clock_not_set");

        NPC? owner = Game1.getCharacterFromName(ExecutionManager.GeodeCounterOwnerName);
        if (owner is null)
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_owner_missing");
        if (!shop.characters.Contains(owner))
            shop.characters.Add(owner);

        List<Point> counters = ExecutionManager.FindGeodeCounterTiles(shop);
        if (counters.Count == 0)
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_counter_tile_missing");

        Point counter = counters[0];
        Point standing = new(counter.X, counter.Y + 1);
        if (!shop.isTileOnMap(new Vector2(standing.X, standing.Y)) || !shop.isTilePassable(new Vector2(standing.X, standing.Y)))
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_standing_tile_blocked");
        if (shop.IsTileOccupiedBy(new Vector2(standing.X, standing.Y), ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_standing_tile_occupied");

        Vector2 ownerTile = new(counter.X, counter.Y - 1);
        owner.Position = new Vector2(ownerTile.X * 64f, ownerTile.Y * 64f);
        if (!shop.characters.Contains(owner))
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_owner_not_present");

        // Exactly one tool, and it is the copper hoe: the shop derives its tool rows from the pack (TOOL_UPGRADES), so a
        // second upgradeable tool would make the caller's entry ambiguous. The count is asserted below.
        foreach (Tool? owned in player.Items.OfType<Tool>().ToArray())
            player.Items.Remove(owned);
        if (player.addItemToInventory(ItemRegistry.Create("(T)" + ToolUpgradeFixtureTool, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_inventory_full");
        if (player.Items.OfType<Tool>().Count() != 1 || player.Items.CountId(ToolUpgradeFixtureTool) != 1)
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_tool_missing_or_ambiguous");

        // The entry the engine would offer for THAT tool, by the engine's own rule, and what it charges.
        ToolUpgradeData? upgrade = null;
        string upgradedToolId = string.Empty;
        foreach (KeyValuePair<string, ToolData> tool in Game1.toolData)
        {
            ToolUpgradeData? candidate = ShopBuilder.GetToolUpgradeData(tool.Value, player);
            if (candidate is null || !string.Equals(candidate.RequireToolId, ToolUpgradeFixtureTool, StringComparison.Ordinal))
                continue;
            upgrade = candidate;
            upgradedToolId = "(T)" + tool.Key;
            break;
        }
        if (upgrade is null || upgrade.Price < 0)
            throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_entry_missing");

        // The blacksmith really sells it: the same call the menu is built from. A shop whose stock lacks this row has no
        // Given to buy, and the run must say so here rather than look like a refused purchase later.
        if (!ShopBuilder.GetShopStock(ToolUpgradeFixtureShopId).Keys.Any(entry =>
                string.Equals(entry.QualifiedItemId, upgradedToolId, StringComparison.Ordinal)))
            throw new InvalidOperationException(
                "fixture_native_local_shop_tool_upgrade_stock_missing:" + ToolUpgradeFixtureShopId + ":" + upgradedToolId);

        // The purse, and the material the entry takes beside the gold: ShopMenu.tryToPurchaseItem charges only when
        // HasTradeItem passes (ShopMenu.cs:1350), so a Given without the material would make the click silently do
        // nothing.
        if (player.Money < upgrade.Price)
            player.Money = upgrade.Price + 1000;
        string tradeItem = string.IsNullOrEmpty(upgrade.TradeItemId) ? "none" : upgrade.TradeItemId;
        if (string.IsNullOrEmpty(upgrade.TradeItemId) == false && upgrade.TradeItemAmount > 0)
        {
            int missing = upgrade.TradeItemAmount - player.Items.CountId(upgrade.TradeItemId);
            if (missing > 0 && player.addItemToInventory(ItemRegistry.Create(upgrade.TradeItemId, missing)) is not null)
                throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_material_unplaceable");
            if (player.Items.CountId(upgrade.TradeItemId) < upgrade.TradeItemAmount)
                throw new InvalidOperationException("fixture_native_local_shop_tool_upgrade_material_short");
        }

        // What discovery will see at request time, logged rather than asserted: whether vanilla's Data/Shops carries an
        // NPC owner for this shop is the one fact this fixture cannot establish, and a wrong answer there belongs to the
        // action's own shop_target_unavailable refusal, not to a fixture that pretends otherwise.
        ShopOwnerData[] currentOwners =
            DataLoader.Shops(Game1.content).TryGetValue(ToolUpgradeFixtureShopId, out ShopData? upgradeShop)
                && upgradeShop is not null
                ? ShopBuilder.GetCurrentOwners(upgradeShop).ToArray()
                : Array.Empty<ShopOwnerData>();
        string ownerRows = currentOwners.Length == 0
            ? "none"
            : string.Join(",", currentOwners.Select(entry => entry.Type + ":" + (entry.Name ?? "none")));

        player.warpFarmer(new Warp(0, 0, shop.NameOrUniqueName, standing.X, standing.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized shop tool-upgrade precondition before bridge attachment: "
                + $"location={shop.NameOrUniqueName};standing={standing.X},{standing.Y};counter={counter.X},{counter.Y};"
                + $"owner={owner.Name};owner_tile={(int)ownerTile.X},{(int)ownerTile.Y};"
                + $"shop={ToolUpgradeFixtureShopId};shop_owners={ownerRows};"
                + $"tool={ToolUpgradeFixtureTool};upgraded={upgradedToolId};price={upgrade.Price};"
                + $"trade_item={tradeItem};trade_amount={upgrade.TradeItemAmount};"
                + $"time_of_day={Game1.timeOfDay};money={player.Money}");
    }
}
