using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The generated mine level the fixture enters. Level 1 is the one mine level with
    /// no monsters at all (<c>MineShaft.adjustLevelChances</c> zeroes the monster
    /// chance for <c>mineLevel == 1</c>), so the actor can stand still next to the
    /// ladder without the run being decided by combat; and `shouldCreateLadderOnThisLevel`
    /// is true there, so the level is one where the game itself spawns descending ladders.
    /// </summary>
    private const int EnterMineLadderFixtureLevel = 1;

    /// <summary>
    /// enter_mine descending a mine LADDER pre-attachment Given: the actor is inside a
    /// generated mine level that carries a descending ladder tile, adjacent to it.
    ///
    /// The precedence this fixture follows is the native one, in this order:
    ///
    /// <list type="number">
    /// <item>the level is created through <c>MineShaft.GetMine</c>, the same lookup
    /// <c>Game1.enterMine</c> resolves its destination through, so the instance the
    /// ladder is written into is the instance the actor warps to;</item>
    /// <item>the ladder is placed by the GAME's own generator, <c>createLadderDown</c>
    /// (<c>MineShaft.cs:3587-3612</c>), not by hand-writing a tile: that is the same
    /// call the level makes when a stone is broken, so the tile index, the tilesheet and
    /// the <c>ladderHasSpawned</c> bookkeeping are vanilla rather than fixture-authored.
    /// The tile it picks is the first neighbour that the game itself calls a clear mine
    /// floor (<c>MineShaft.isTileClearForMineObjects</c>), which is also the predicate
    /// the level uses when it places mine objects;</item>
    /// <item>the actor enters with <c>Game1.enterMine</c>, the public native entry
    /// <c>MineShaft.checkAction</c> case 173 owns, so nothing about the arrival is
    /// written here: <c>MineShaft.resetLocalState</c> chooses the landing tile from the
    /// level's own geometry.</item>
    /// </list>
    ///
    /// It emits no receipt and performs no descent: the action under test is the one
    /// that descends the ladder.
    /// </summary>
    private void InstallNativeLocalEnterMineLadderFixture(Farmer player)
    {
        string levelName = MineShaft.GetLevelName(EnterMineLadderFixtureLevel);
        MineShaft shaft = MineShaft.GetMine(levelName);
        if (!string.Equals(shaft.NameOrUniqueName, levelName, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_local_enter_mine_ladder_shaft_mismatch");
        if (shaft.map is null)
            throw new InvalidOperationException("fixture_native_local_enter_mine_ladder_map_missing");

        // A freshly generated level carries no descending ladder: `doCreateLadderDown`
        // only runs for a broken stone or a cleared monster. If the PRODUCTION finder
        // already answers here, this level is not the declared Given and the tile this
        // fixture adds would not be the one the handler re-reads, so fail closed instead
        // of building a target the request could never name.
        if (ExecutionManager.TryFindMineLadderTile(shaft, out int existingX, out int existingY))
            throw new InvalidOperationException($"fixture_native_local_enter_mine_ladder_already_present:{existingX},{existingY}");

        // The tile the native lifecycle will land the actor on. This is read from the
        // game's own arrival computation (`MineShaft.mineEntrancePosition`, the same call
        // `resetLocalState` makes), never chosen by the fixture; the ladder only has to be
        // inside the interaction radius the handler checks (Chebyshev 1).
        Vector2 arrival = shaft.mineEntrancePosition(player);
        int width = shaft.map.Layers[0].LayerWidth;
        int height = shaft.map.Layers[0].LayerHeight;
        if (arrival.X < 0 || arrival.Y < 0 || arrival.X >= width || arrival.Y >= height)
            throw new InvalidOperationException("fixture_native_local_enter_mine_ladder_arrival_unknown");

        Vector2[] neighbours =
        {
            arrival + new Vector2(0f, 1f), arrival + new Vector2(0f, -1f),
            arrival + new Vector2(1f, 0f), arrival + new Vector2(-1f, 0f),
            arrival + new Vector2(-1f, -1f), arrival + new Vector2(1f, -1f),
            arrival + new Vector2(-1f, 1f), arrival + new Vector2(1f, 1f),
        };
        Vector2? ladderTile = null;
        foreach (Vector2 candidate in neighbours)
        {
            if (candidate.X < 0 || candidate.Y < 0 || candidate.X >= width || candidate.Y >= height)
                continue;
            if (!shaft.isTileClearForMineObjects(candidate))
                continue;
            ladderTile = candidate;
            break;
        }
        if (ladderTile is null)
            throw new InvalidOperationException("fixture_native_local_enter_mine_ladder_tile_missing");

        // The game's own ladder spawn. `forceShaft` stays false, so this is the
        // descending ladder (tile index 173), never the shaft-jump variant (174) whose
        // native branch is a different, level-dropping action.
        shaft.createLadderDown((int)ladderTile.Value.X, (int)ladderTile.Value.Y);
        if (!ExecutionManager.TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)
            || ladderX != (int)ladderTile.Value.X
            || ladderY != (int)ladderTile.Value.Y)
            throw new InvalidOperationException(
                $"fixture_native_local_enter_mine_ladder_finder_disagrees:{(int)ladderTile.Value.X},{(int)ladderTile.Value.Y}:{ladderX},{ladderY}");

        Game1.enterMine(EnterMineLadderFixtureLevel);

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized enter-mine-ladder precondition before bridge attachment: "
                + $"shaft={levelName};level={shaft.mineLevel};arrival={(int)arrival.X},{(int)arrival.Y};"
                + $"ladder={(int)ladderTile.Value.X},{(int)ladderTile.Value.Y};"
                + "production_finder_agrees=true; production alone descends the ladder and emits the receipt.",
            LogLevel.Info);
    }
}
