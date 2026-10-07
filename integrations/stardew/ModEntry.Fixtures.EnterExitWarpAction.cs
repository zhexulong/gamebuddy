using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The one Buildings-layer Action this fixture writes. It is a SINGLE token, and
    /// <c>GameLocation.performAction</c> owns it behind a real gate:
    /// <c>case "WarpCommunityCenter"</c> (GameLocation.cs:9461-9471) warps only while
    /// <c>Game1.MasterPlayer.mailReceived</c> holds <c>ccDoorUnlock</c> or
    /// <c>JojaMember</c>; otherwise it draws
    /// <c>Strings\StringsFromCSFiles:GameLocation.cs.8175</c> and does not warp.
    /// </summary>
    private const string EnterExitWarpActionFixtureAction = "WarpCommunityCenter";

    /// <summary>
    /// enter_exit door-gate WIDENING pre-attachment Given: one Farm tile whose
    /// Buildings-layer <c>Action</c> is the single-token gated warp
    /// <c>WarpCommunityCenter</c> with that gate CLOSED, and the actor standing on the
    /// tile directly north of it.
    ///
    /// The case the widening exists for is the disagreement between the two sets the
    /// Mod may admit on: <c>DispatchNativeDoor</c> used to require membership of
    /// <c>location.doors</c> — the table <c>GameLocation.updateDoors</c> builds once, at
    /// map load (:17586-17638) — while the game's own door entry reads the LIVE
    /// Buildings layer. This fixture writes the Action AFTER the location loaded, so the
    /// table genuinely does not hold the tile and the two sets genuinely disagree:
    ///
    ///   * <c>location.getWarpFromDoor</c> (:2194-2244) READS the live layer, so it
    ///     resolves this tile to <c>CommunityCenter (32,23)</c>. That is the warp the old
    ///     door-table path fell through to — via <c>ResolveDoorWarp</c> and
    ///     <c>Game1.player.warpFarmer</c> — without ever running the <c>ccDoorUnlock</c>
    ///     test. The fixture asserts the resolved warp precisely so the run documents the
    ///     bypass it prevents.
    ///   * <c>location.doors</c> does not hold the tile, which the fixture asserts. If it
    ///     ever did, the run would exercise the tile the OLD door table already covered
    ///     and would prove nothing about the widening.
    ///
    /// Only that declared Given is established. The entry itself — <c>performAction</c>,
    /// the gate's own refusal dialogue, and the closure of the modal it leaves mounted —
    /// belongs to production, and this fixture emits no receipt: it neither calls
    /// <c>performAction</c>/<c>checkAction</c> nor moves the actor onto the tile.
    ///
    /// Every step asserts its own fact, so a wrong fixture fails loudly here rather than
    /// looking like a product bug later (same convention as the sibling
    /// WithdrawSiloHay/ToggleAnimalDoor fixtures).
    /// </summary>
    private void InitializeNativeLocalEnterExitWarpActionFixture(Farmer player, GameLocation farm)
    {
        // The gate must be CLOSED, or the run would prove the opposite of its claim:
        // performAction's WarpCommunityCenter arm warps when either mail flag is set.
        // This mirrors the exact test at GameLocation.cs:9462.
        if (Game1.MasterPlayer.mailReceived.Contains("ccDoorUnlock")
            || Game1.MasterPlayer.mailReceived.Contains("JojaMember"))
            throw new InvalidOperationException("fixture_native_local_enter_exit_warp_action_gate_open");

        xTile.Layers.Layer? buildings = farm.map?.GetLayer("Buildings");
        if (buildings is null)
            throw new InvalidOperationException("fixture_native_local_enter_exit_warp_action_buildings_layer_missing");

        (Vector2 Target, Vector2 Standing, bool TargetWalkable)? selected = FindNativeLocalEnterExitWarpActionFixtureTile(farm, buildings);
        if (selected is null)
            throw new InvalidOperationException("fixture_native_local_enter_exit_warp_action_tile_missing");

        Vector2 target = selected.Value.Target;
        Vector2 standing = selected.Value.Standing;

        // The assertion that makes this the WIDENING's case rather than the old path's:
        // the door table must not hold the tile. updateDoors ran at map load, before this
        // write, so the table and the live layer disagree here on purpose.
        if (farm.doors.ContainsKey(new Point((int)target.X, (int)target.Y)))
            throw new InvalidOperationException("fixture_native_local_enter_exit_warp_action_tile_in_door_table");

        // The native selector text, exactly the token `performAction` parses and the
        // predicate `updateDoors`/`IsNativeWarpAction` read ("contains Warp").
        buildings.Tiles[(int)target.X, (int)target.Y].Properties["Action"] = EnterExitWarpActionFixtureAction;
        string? written = farm.doesTileHaveProperty((int)target.X, (int)target.Y, "Action", "Buildings");
        if (!string.Equals(written, EnterExitWarpActionFixtureAction, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_local_enter_exit_warp_action_property_rejected");

        // The fact that makes the run load-bearing: the RESOLVER still returns a warp for
        // this tile. That resolved warp is what enter_exit used to fall through to, and it
        // is the target the widening replaces with the game's own gated click entry.
        Warp? resolved = farm.getWarpFromDoor(new Point((int)target.X, (int)target.Y), player);
        if (resolved is null || !string.Equals(resolved.TargetName, "CommunityCenter", StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_local_enter_exit_warp_action_unresolvable");

        // The actor stands on the tile NORTH of the target. A walk-in warp would change
        // the location and is the only thing that could rebuild the door table, and the
        // write above deliberately happened after the location loaded, so the two sets
        // stay in disagreement through bridge attachment.
        player.warpFarmer(new Warp(0, 0, farm.NameOrUniqueName, (int)standing.X, (int)standing.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized enter-exit warp-action precondition before bridge attachment: "
                + $"action={EnterExitWarpActionFixtureAction};target={(int)target.X},{(int)target.Y};"
                + $"standing={(int)standing.X},{(int)standing.Y};door_table_holds_target=false;"
                + $"target_walkable={selected.Value.TargetWalkable};"
                + $"resolved_warp={resolved.TargetName}:{resolved.TargetX},{resolved.TargetY};ccDoorUnlock=false;"
                + " production alone runs the native door entry and emits receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// The declared Given's one tile: a Buildings-layer tile that can carry an Action
    /// (non-null), that no Building owns, that the door table does not already hold, that
    /// carries no Action of its own, and whose NORTH neighbour the actor can legally stand
    /// on. Nothing is written here.
    ///
    /// The walkability test is the fixture family's own <see cref="IsFixtureWalkableFarmTile"/>,
    /// which is built on the product's <c>GameLocation.isTilePassable</c>, so the fixture
    /// and the planner cannot disagree about where the actor may stand. A walkable TARGET
    /// is preferred — a doorway is a tile the player walks onto — but the producer's
    /// <c>ResolveDoorWarp</c> never reads the target's passability, so a non-walkable
    /// candidate still establishes the declared Given; which one was chosen is reported in
    /// the returned flag, so the fixture log records it either way.
    /// </summary>
    private static (Vector2 Target, Vector2 Standing, bool TargetWalkable)? FindNativeLocalEnterExitWarpActionFixtureTile(
        GameLocation farm, xTile.Layers.Layer buildings)
    {
        (Vector2 Target, Vector2 Standing, bool TargetWalkable)? fallback = null;
        for (int y = 2; y < buildings.LayerHeight - 1; y++)
        {
            for (int x = 1; x < buildings.LayerWidth - 1; x++)
            {
                if (buildings.Tiles[x, y] is null)
                    continue;
                // Reuse the producer's own read: the fixture and DispatchNativeDoor must
                // agree on what "this tile already carries an Action" means.
                if (ExecutionManager.ReadBuildingsLayerAction(buildings, x, y) is not null)
                    continue;
                if (farm.doors.ContainsKey(new Point(x, y)))
                    continue;
                // getWarpFromDoor tries building human doors first, and doesTileHaveProperty
                // answers for Building-owned tiles before the raw layer, so a tile a
                // Building owns is a different case from the one under test.
                if (farm.buildings.Any(building => building is not null && building.occupiesTile(x, y)))
                    continue;

                Vector2 target = new(x, y);
                Vector2 standing = new(x, y - 1);
                if (!IsFixtureWalkableFarmTile(farm, standing))
                    continue;
                if (IsFixtureWalkableFarmTile(farm, target))
                    return (target, standing, true);
                fallback ??= (target, standing, false);
            }
        }

        return fallback;
    }
}
