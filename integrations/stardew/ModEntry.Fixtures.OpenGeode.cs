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
    /// the counter reach is re-read there from the live map's counter tile and the live
    /// character list. This fixture emits no receipt.
    ///
    /// Why the counter is supplied rather than walked to: a shop interior in Pelican Town
    /// is entered through a `LockedDoorWarp` building action, which is the door table's
    /// business (`enter_exit`), not a map `Warp`. `travel` serves only
    /// `GameLocation.warps` (farmhandexecutioncontroller.movementactions.cs), so no
    /// location publishes an edge into the Blacksmith and no walk from outside it exists.
    /// The actor is therefore placed at the counter the same way
    /// <see cref="InstallNativeLocalShopPurchaseFixture"/> places it in the SeedShop.
    ///
    /// The standing tile is the ENGINE's arrangement, not a convenient one: the counter tile
    /// is the map's own `Action: Blacksmith` tile (GameLocation.cs:9873-9878), the actor
    /// stands on the row below it - `who.TilePoint.Y > tileLocation.Y` (:9874) - and inside
    /// the native click radius (Game1.cs:11509). Clint is put behind the counter, which is
    /// where the game keeps him; the action finds him by name in the room's character list
    /// rather than by that tile (:10950-10955).
    ///
    /// Three facts are asserted BEFORE the bridge attaches, so a wrong fixture fails
    /// loudly here instead of looking like a product refusal later:
    /// <list type="number">
    /// <item>the pack holds exactly one geode stack, of exactly one unit;</item>
    /// <item>Clint is in the Blacksmith's own character list, and the actor is put on the row below the
    /// map's counter tile - the two facts the action re-reads when the request arrives;</item>
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

        // The counter tile, read from the map exactly as the action reads it, and the tile below
        // it for the actor: the engine's own arrangement for this interaction, so "stands at the
        // counter" means what the action will check rather than a tile that happened to be free.
        List<Point> counters = ExecutionManager.FindGeodeCounterTiles(shop);
        if (counters.Count == 0)
            throw new InvalidOperationException("fixture_native_local_open_geode_counter_tile_missing");

        Point counter = counters[0];
        Point standing = new(counter.X, counter.Y + 1);
        if (!shop.isTileOnMap(new Vector2(standing.X, standing.Y)) || !shop.isTilePassable(new Vector2(standing.X, standing.Y)))
            throw new InvalidOperationException("fixture_native_local_open_geode_standing_tile_blocked");
        if (shop.IsTileOccupiedBy(new Vector2(standing.X, standing.Y), ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
            throw new InvalidOperationException("fixture_native_local_open_geode_standing_tile_occupied");

        Vector2 ownerTile = new(counter.X, counter.Y - 1);
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

        // `Game1.warpFarmer` is DEFERRED: it fades to black and applies the position in the next update
        // (`performWarpFarmer`, Game1.cs:10005-10041), so nothing about the actor's tile can be read back here.
        // What this fixture owes is the arrangement the action will re-read at request time - the row below the
        // counter, one tile from it - which the two tiles above are.
        player.warpFarmer(new Warp(0, 0, shop.NameOrUniqueName, standing.X, standing.Y, false));

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized open-geode precondition before bridge attachment: "
                + $"location={shop.NameOrUniqueName};standing={standing.X},{standing.Y};"
                + $"counter={counter.X},{counter.Y};counter_action={ExecutionManager.GeodeCounterTileAction};"
                + $"owner={owner.Name};owner_tile={(int)ownerTile.X},{(int)ownerTile.Y};"
                + $"radius={ExecutionManager.NativeInteractionRadius};"
                + $"geode={OpenGeodeFixtureItemId};geode_stacks={geodeStacks};"
                + $"time_of_day={Game1.timeOfDay};money={player.Money};fee={ExecutionManager.GeodeProcessingFee}");
    }
}
