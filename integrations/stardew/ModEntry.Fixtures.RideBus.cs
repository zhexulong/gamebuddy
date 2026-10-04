using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// ride_bus pre-attachment Given: the vault is complete, the actor can afford a
    /// ticket, the driver is on duty, and the actor stands beside the ticket machine.
    ///
    /// Nothing here touches the fare, the question, the control freeze or the arrival:
    /// the native interaction owns all of those, and this fixture emits no receipt. It
    /// only establishes the four facts <c>BusStop.checkAction</c> and the Mod's own
    /// guard read (BusStop.cs:81 mail flag, :135-137 driver tile, :141 fare).
    /// </summary>
    private void InstallNativeLocalRideBusFixture(Farmer player)
    {
        if (Game1.getLocationFromName("BusStop") is not BusStop bus)
            throw new InvalidOperationException("fixture_native_local_ride_bus_bus_stop_missing");

        // ccVault is the native gate the ticket branch reads; setting the mail flag is
        // the same world fact a completed vault bundle produces (disposable fixture
        // state only). Add is idempotent on the native mail set.
        Game1.MasterPlayer.mailReceived.Add("ccVault");
        if (!Game1.MasterPlayer.mailReceived.Contains("ccVault"))
            throw new InvalidOperationException("fixture_native_local_ride_bus_vault_not_established");

        int ticketPrice = bus.TicketPrice;
        player.Money = Math.Max(player.Money, ticketPrice + 5000);
        if (player.Money < ticketPrice)
            throw new InvalidOperationException("fixture_native_local_ride_bus_fare_unaffordable");

        // The driver must sit on the native on-duty tile, otherwise the action refuses
        // with no_driver.
        NPC? driver = bus.characters.FirstOrDefault(character => character is not null && character.Name == "Pam");
        if (driver is null)
            throw new InvalidOperationException("fixture_native_local_ride_bus_driver_missing");
        driver.Position = new Vector2(21 * 64f, 10 * 64f);
        if (driver.TilePoint.X != 21 || driver.TilePoint.Y != 10)
            throw new InvalidOperationException("fixture_native_local_ride_bus_driver_not_on_duty");

        if (!TryFindBusTicketMachine(bus, out int ticketX, out int ticketY))
            throw new InvalidOperationException("fixture_native_local_ride_bus_ticket_machine_missing");

        // Standing tile: Chebyshev-1 from the machine (the interaction radius the
        // native cursor sprite uses), walkable and unoccupied.
        Vector2? standing = null;
        for (int dx = -1; dx <= 1 && standing is null; dx++)
        {
            for (int dy = -1; dy <= 1 && standing is null; dy++)
            {
                Vector2 tile = new(ticketX + dx, ticketY + dy);
                if (!bus.isTileOnMap(tile) || !bus.isTilePassable(tile))
                    continue;
                if (bus.IsTileOccupiedBy(tile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                    continue;
                standing = tile;
            }
        }
        if (standing is null)
            throw new InvalidOperationException("fixture_native_local_ride_bus_standing_tile_missing");

        player.warpFarmer(new Warp(0, 0, bus.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized ride-bus precondition before bridge attachment: "
                + $"ticket={ticketX},{ticketY};standing={(int)standing.Value.X},{(int)standing.Value.Y};"
                + $"fare={ticketPrice};money={player.Money};driver={driver.TilePoint.X},{driver.TilePoint.Y}");
    }

    /// <summary>
    /// The ticket machine is identified by its Buildings-layer tile index, the same
    /// fact <c>BusStop.checkAction</c> branches on (BusStop.cs:77), so the fixture and
    /// the product agree on which tile is the machine by construction.
    /// </summary>
    private static bool TryFindBusTicketMachine(GameLocation location, out int tileX, out int tileY)
    {
        tileX = 0;
        tileY = 0;
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            return false;
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (buildings.Tiles[x, y]?.TileIndex == 1057)
                {
                    tileX = x;
                    tileY = y;
                    return true;
                }
            }
        }
        return false;
    }
}
