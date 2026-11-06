using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The one geode the fixture supplies. `(O)535` is the ordinary geode, and it is the
    /// id the engine's own <c>Utility.IsGeode</c> accepts (that predicate reads
    /// <c>Data/ObjectInformation</c>'s geode drop table, not a list kept here).
    /// </summary>
    private const string OpenGeodeFixtureItemId = "(O)535";

    /// <summary>
    /// open_geode pre-attachment Given: the actor is at the blacksmith's counter with one
    /// geode in the pack.
    ///
    /// Only the declared Given is established. The menu, the cursor load, the smash, the
    /// fee, the drop table, the animation, the delivery and the close are all
    /// <see cref="ExecutionManager"/>'s (farmhandexecutioncontroller.geodeactions.cs), and
    /// the counter reach is re-read there from the live location, the live character list
    /// and the live tiles. This fixture emits no receipt.
    ///
    /// Why the counter is supplied rather than walked to: a shop interior in Pelican Town
    /// is entered through a `LockedDoorWarp` building action, which is the door table's
    /// business (`enter_exit`), not a map `Warp`. `travel` serves only
    /// `GameLocation.warps` (farmhandexecutioncontroller.movementactions.cs), so no
    /// location publishes an edge into the Blacksmith and no walk from outside it exists.
    /// The actor is therefore placed at the counter the same way
    /// <see cref="InstallNativeLocalShopPurchaseFixture"/> places it in the SeedShop.
    ///
    /// Three facts are asserted BEFORE the bridge attaches, so a wrong fixture fails
    /// loudly here instead of looking like a product refusal later:
    /// <list type="number">
    /// <item>the pack holds exactly one geode stack, of exactly one unit;</item>
    /// <item>Clint is in the Blacksmith's own character list at the tile this fixture put
    /// him on, and the actor stands within the counter reach the action re-derives;</item>
    /// <item>the processing fee is affordable, so a smash refusal can never be the
    /// fixture's fault.</item>
    /// </list>
    /// </summary>
    private void InstallNativeLocalOpenGeodeFixture(Farmer player)
    {
        // The template is a FarmHouse morning. Warp into the Blacksmith first, so the
        // location and its character list are the ones the action will use.
        if (Game1.getLocationFromName(ExecutionManager.GeodeCounterLocationName) is not GameLocation shop)
            throw new InvalidOperationException("fixture_native_local_open_geode_blacksmith_missing");

        // Trading hours: the world fact that puts Clint behind his counter.
        Game1.timeOfDay = 1200;
        if (Game1.timeOfDay != 1200)
            throw new InvalidOperationException("fixture_native_local_open_geode_clock_not_set");

        NPC? owner = Game1.getCharacterFromName(ExecutionManager.GeodeCounterOwnerName);
        if (owner is null)
            throw new InvalidOperationException("fixture_native_local_open_geode_owner_missing");
        if (!shop.characters.Contains(owner))
            shop.characters.Add(owner);

        // A walkable, unoccupied standing tile for the actor, and an owner tile Chebyshev-1
        // from it. One step is inside the counter reach the action re-derives
        // (`GeodeCounterInteractionRadius`), and leaves a tile of margin for the arrival.
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
            throw new InvalidOperationException("fixture_native_local_open_geode_standing_tile_missing");

        owner.Position = new Vector2(ownerTile.X * 64f, ownerTile.Y * 64f);
        if (!shop.characters.Contains(owner))
            throw new InvalidOperationException("fixture_native_local_open_geode_owner_not_present");

        // Exactly one geode stack of exactly one unit: the runner reads the world back to
        // prove "the geode count fell by one", which is only unambiguous when the pack
        // holds one stack.
        foreach (Item? ownedGeode in player.Items.Where(item => item is not null && Utility.IsGeode(item)).ToArray())
            player.Items.Remove(ownedGeode);
        if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(OpenGeodeFixtureItemId, 1)) is not null)
            throw new InvalidOperationException("fixture_native_local_open_geode_inventory_full");
        int geodeStacks = player.Items.Count(item => item is not null && Utility.IsGeode(item));
        if (geodeStacks != 1 || player.Items.CountId(OpenGeodeFixtureItemId) != 1)
            throw new InvalidOperationException("fixture_native_local_open_geode_geode_missing_or_ambiguous");
        if (player.Money < ExecutionManager.GeodeProcessingFee)
            throw new InvalidOperationException("fixture_native_local_open_geode_fee_unaffordable");

        player.warpFarmer(new Warp(0, 0, shop.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized open-geode precondition before bridge attachment: "
                + $"location={shop.NameOrUniqueName};standing={(int)standing.Value.X},{(int)standing.Value.Y};"
                + $"owner={owner.Name};owner_tile={(int)ownerTile.X},{(int)ownerTile.Y};"
                + $"reach={ExecutionManager.GeodeCounterInteractionRadius};"
                + $"geode={OpenGeodeFixtureItemId};geode_stacks={geodeStacks};"
                + $"time_of_day={Game1.timeOfDay};money={player.Money};fee={ExecutionManager.GeodeProcessingFee}");
    }
}
