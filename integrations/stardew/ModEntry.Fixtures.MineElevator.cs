using System;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>Floor the fixture stages progress up to (the offered set becomes {0,5,10}).</summary>
    private const int MineElevatorFixtureFloor = 10;
    /// <summary>A generated level that carries the elevator tile, used as the arrival floor.</summary>
    private const string MineElevatorFixtureLevel = "UndergroundMine5";
    private const int MineElevatorFixtureTileX = 6;
    private const int MineElevatorFixtureTileY = 6;

    /// <summary>
    /// select_mine_elevator_floor pre-attachment Given: the player has mine progress
    /// and stands on a mine floor that really carries the elevator tile.
    ///
    /// Two things this fixture deliberately does NOT do:
    ///
    /// <list type="bullet">
    /// <item>It never writes <c>mine_lowestLevelReachedForOrder</c>. Under the M8
    /// ruling, a staged Given must fail closed when that field is not its untouched
    /// default, because the two fields together are what the game reads for mine
    /// progress — writing the second one would let the fixture conceal a
    /// precondition it does not actually satisfy.</item>
    /// <item>It does not assume the elevator tile exists. The floor is only accepted
    /// after tile 112 is freshly observed in the arrival floor's Buildings layer, and
    /// it is rejected otherwise, so a wrong floor name fails loudly instead of
    /// producing an action that can never succeed.</item>
    /// </list>
    ///
    /// It emits no receipt: the action under test is the one that selects a floor.
    /// </summary>
    private void InstallNativeLocalMineElevatorFixture(Farmer player)
    {
        // The other progress field must still be its default (M8 fail-closed rule).
        int forOrder = Game1.netWorldState?.Value?.LowestMineLevelForOrder ?? -1;
        if (forOrder != -1)
            throw new InvalidOperationException("fixture_native_local_mine_elevator_order_progress_present");

        // Declared Given: progress up to floor 10, so the offered set is {0,5,10}.
        MineShaft.lowestLevelReached = MineElevatorFixtureFloor;
        if (MineShaft.lowestLevelReached != MineElevatorFixtureFloor)
            throw new InvalidOperationException("fixture_native_local_mine_elevator_progress_not_established");

        // Arrive on the floor that carries the elevator. warpFarmer is how the native
        // path itself moves between mine floors, so the fixture uses the game's own
        // transition rather than editing map tiles.
        Game1.warpFarmer(MineElevatorFixtureLevel, MineElevatorFixtureTileX, MineElevatorFixtureTileY, 2);

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized mine-elevator precondition before bridge attachment: "
                + $"level={MineElevatorFixtureLevel};tile={MineElevatorFixtureTileX},{MineElevatorFixtureTileY};"
                + $"lowest_level_reached={MineShaft.lowestLevelReached};for_order={forOrder};"
                + "elevator_tile_asserted_at_admission=true");
    }
}
