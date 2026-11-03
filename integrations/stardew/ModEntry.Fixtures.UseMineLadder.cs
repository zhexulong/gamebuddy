using System;
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

        Game1.enterMine(UseMineLadderFixtureLevel);

        // The arrival is the level's own choice, so it is read after the entry rather than assumed. It must be inside
        // the radius the handler re-checks (Chebyshev 1), or the run would depend on a walk rather than on the ladder.
        int actorX = player.TilePoint.X;
        int actorY = player.TilePoint.Y;
        int chebyshev = Math.Max(Math.Abs(actorX - exitX), Math.Abs(actorY - exitY));
        if (chebyshev > 1)
            throw new InvalidOperationException(
                $"fixture_native_local_use_mine_ladder_arrival_out_of_range:{actorX},{actorY}:{exitX},{exitY}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized use-mine-ladder precondition before bridge attachment: "
                + $"shaft={levelName};level={shaft.mineLevel};exit={exitX},{exitY};arrival={actorX},{actorY};"
                + "descent_ladder_absent=true; production alone leaves the mine and emits the receipt.",
            LogLevel.Info);
    }
}
