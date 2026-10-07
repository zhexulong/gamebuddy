using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// withdraw_silo_hay pre-attachment Given: the Farm owns a FINISHED Silo whose
    /// store holds exactly one Hay, and the actor stands at that Silo's human door.
    ///
    /// Only that declared Given is established. The withdrawal itself — the native
    /// <c>GameLocation.GetHayFromAnySilo</c> call, the item insertion into the
    /// actor's inventory and both halves of the observed postcondition — belongs to
    /// production, and this fixture emits no receipt.
    ///
    /// Exactly one Hay is declared on purpose: the run can then take the real Hay
    /// once and attempt the same target again, which must change nothing. A store
    /// deep enough to satisfy a second withdrawal would leave the negative attempt
    /// untested.
    ///
    /// Every step asserts its own fact, so a wrong fixture fails loudly here rather
    /// than looking like a product bug later (same convention as the sibling
    /// ShopPurchase/RideBus fixtures).
    /// </summary>
    private void InitializeNativeLocalWithdrawSiloHayFixture(Farmer player, GameLocation farm)
    {
        // A Silo must exist on the Farm. The bootstrapped stable template has none,
        // so one is built; a Silo the save already owns is reused.
        StardewValley.Buildings.Building? silo = farm.buildings.FirstOrDefault(building => building.buildingType.Value == "Silo");
        if (silo is null)
        {
            Vector2 siloTile = new(16, 8);
            while (farm.buildings.Any(building => building.tileX.Value == (int)siloTile.X && building.tileY.Value == (int)siloTile.Y))
                siloTile += new Vector2(3, 0);
            silo = new StardewValley.Buildings.Building("Silo", siloTile);
            farm.buildings.Add(silo);
            farm.updateLayout();
        }

        // The Given is a FINISHED Silo: a building still under construction counts
        // as zero hay capacity (GetHayCapacity), so the store below could not exist
        // and the native seam would have nothing to draw from.
        silo.daysOfConstructionLeft.Value = 0;
        if (farm.GetHayCapacity() < 1)
            throw new InvalidOperationException("fixture_native_local_withdraw_silo_hay_no_capacity");

        Point door = silo.getPointForHumanDoor();
        if (!farm.isTileOnMap(new Vector2(door.X, door.Y)))
            throw new InvalidOperationException("fixture_native_local_withdraw_silo_hay_door_missing");

        farm.piecesOfHay.Value = 1;
        if (farm.piecesOfHay.Value != 1)
            throw new InvalidOperationException("fixture_native_local_withdraw_silo_hay_store_not_set");

        player.warpFarmer(new StardewValley.Warp(0, 0, farm.NameOrUniqueName, door.X, door.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized Silo-withdraw precondition before bridge attachment: "
                + $"silo={silo.tileX.Value},{silo.tileY.Value};door={door.X},{door.Y};hay={farm.piecesOfHay.Value};"
                + $"capacity={farm.GetHayCapacity()}; production alone withdraws Hay and emits receipt.",
            LogLevel.Info);
    }
}
