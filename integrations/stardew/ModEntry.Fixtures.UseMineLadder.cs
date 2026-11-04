using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The generated mine level the exit fixture enters. Level 1 is the one mine level with no monsters at all
    /// (<c>MineShaft.adjustLevelChances</c> zeroes the monster chance for <c>mineLevel == 1</c>), so the actor can stand
    /// still beside the exit ladder without the run being decided by combat.
    /// </summary>
    private const int UseMineLadderFixtureLevel = 1;

    /// <summary>
    /// use_mine_ladder pre-attachment Given: the actor is inside a generated mine level, adjacent to the level's own
    /// EXIT ladder, and the level carries no descent ladder at all.
    ///
    /// <para>
    /// That second half is the measured defect this fixture exists for: measured 2026-11-03 (round30) a companion that
    /// had entered level 1 was published no ladder of either kind, so every way out was unnamable and it stayed in the
    /// mine until it passed out at 02:00. The exit ladder is shipped map data, so it is there before anything is
    /// cleared; the descent ladder is not, and the fixture refuses to run on a level where one already exists.
    /// </para>
    ///
    /// <para>
    /// Precedence, all native: the level is created through <c>MineShaft.GetMine</c> (the lookup
    /// <c>Game1.enterMine</c> resolves), the exit tile is read through the PRODUCTION finder, and the actor enters with
    /// <c>Game1.enterMine</c> so the landing tile is the level's own choice (<c>MineShaft.resetLocalState</c>).
    /// It emits no receipt and performs no exit: the action under test is the one that leaves.
    /// </para>
    ///
    /// <para>
    /// The landing tile is read from <c>shaft.mineEntrancePosition</c>, never from <c>player.TilePoint</c>:
    /// <c>Game1.enterMine</c> only QUEUES the warp (<c>Game1.warpFarmer</c> sets <c>locationRequest</c>,
    /// <c>xLocationAfterWarp</c> and <c>_isWarping</c> and fades to black), so the actor still reports the tile of the
    /// PREVIOUS location until the fade completes. Measured 2026-11-04: reading it synchronously compared a
    /// FarmHouse tile against the mine's ladder and refused a correct Given with
    /// <c>fixture_native_local_use_mine_ladder_arrival_out_of_range:10,3:9,9</c>.
    /// </para>
    /// </summary>
    private void InstallNativeLocalUseMineLadderFixture(Farmer player)
    {
        string levelName = MineShaft.GetLevelName(UseMineLadderFixtureLevel);
        MineShaft shaft = MineShaft.GetMine(levelName);
        if (!string.Equals(shaft.NameOrUniqueName, levelName, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_local_use_mine_ladder_shaft_mismatch");
        if (shaft.map is null)
            throw new InvalidOperationException("fixture_native_local_use_mine_ladder_map_missing");

        // The Given is "the way out and nothing else": a level that already carries the descent ladder would let the
        // run pass on a world where the published rows are not the ones this fixture asserts.
        if (ExecutionManager.TryFindMineLadderTile(shaft, out int descentX, out int descentY))
            throw new InvalidOperationException($"fixture_native_local_use_mine_ladder_descent_ladder_present:{descentX},{descentY}");

        if (!ExecutionManager.TryFindMineExitLadderTile(shaft, out int exitX, out int exitY))
            throw new InvalidOperationException("fixture_native_local_use_mine_ladder_exit_ladder_missing");

        // The arrival is the level's own choice, so it is asked of the level rather than assumed, and it is asked
        // BEFORE the entry because the warp is queued. `resetLocalState` lands the actor on this exact tile, and
        // `findLadder` derives it as the tile beneath the level's own ladder tile, so the two coordinates have one
        // source and the run depends on the ladder rather than on a walk.
        Vector2 arrival = shaft.mineEntrancePosition(player);
        int arrivalX = (int)arrival.X;
        int arrivalY = (int)arrival.Y;
        int chebyshev = Math.Max(Math.Abs(arrivalX - exitX), Math.Abs(arrivalY - exitY));
        string exitSheet = shaft.getTileSheetIDAt(exitX, exitY, "Buildings");
        if (chebyshev > 1)
            throw new InvalidOperationException(
                $"fixture_native_local_use_mine_ladder_arrival_out_of_range:{arrivalX},{arrivalY}:{exitX},{exitY}:{exitSheet}");

        Game1.enterMine(UseMineLadderFixtureLevel);

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized use-mine-ladder precondition before bridge attachment: "
                + $"shaft={levelName};level={shaft.mineLevel};exit={exitX},{exitY};exit_sheet={exitSheet};"
                + $"arrival={arrivalX},{arrivalY};"
                + "descent_ladder_absent=true; production alone leaves the mine and emits the receipt.",
            LogLevel.Info);
    }
}
