using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.GameData.Shops;
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
}
