using System;
using System.Collections.Generic;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

/// <summary>
/// Mine elevator floor selection (Lane L3 card §3.7; design decision M8).
///
/// The card ruled that <c>enter_mine</c> keeps its tile semantics and that the
/// elevator becomes its OWN action if the product wants "any already-unlocked
/// floor". This is that action, and it follows the card's two conditions exactly:
///
/// <list type="number">
/// <item><b>It must not become a cheat teleport.</b> The offered floor set is read
/// from the live <c>MineShaft.lowestLevelReached</c> — floor 0 plus every multiple
/// of 5 up to min(lowestLevelReached, 120), the same enumeration
/// <c>MineElevatorMenu</c> builds (MineElevatorMenu.cs:16/37) — and the client's
/// opaque id is matched against a set re-derived here on the game thread. An
/// unlocked checkpoint never authorizes an arbitrary level.</item>
/// <item><b>It must use the real native facility.</b> The elevator is a physical
/// tile in the CURRENT <c>MineShaft</c>: <c>MineShaft.checkAction</c> dispatches on
/// the Buildings layer tile index <b>112</b> and opens the menu only when
/// <c>mineLevel &lt;= 120</c> (MineShaft.cs:3053-3072). Both facts are re-checked
/// here, so the action cannot be used from a location that has no elevator.</item>
/// </list>
///
/// The transition is asynchronous, exactly like <c>travel</c> and <c>enter_mine</c>:
/// <c>Game1.enterMine(floor)</c> performs <c>warpFarmer(...)</c>, and reading
/// <c>Game1.CurrentMineLevel</c> in the same frame still returns the OLD level
/// (measured live: dispatch to floor 10 reported <c>actual_floor=5</c>). So this
/// accepts, hands the specification to <c>activeTravel</c>, and lets
/// <c>CompleteTravelAfterWarp</c> mint the single terminal once the Warped edge
/// arrives — the same one-terminal ledger path as every other travel-family action.
///
/// Floor 0 is not "go home": it is "return to the mine entrance"
/// (<c>Game1.warpFarmer("Mine", 17, 4)</c>, MineElevatorMenu.cs:86), so it targets
/// that map rather than a generated level.
/// </summary>
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    /// <summary>The elevator's tile index in the Buildings layer of a MineShaft.</summary>
    private const int MineElevatorTileIndex = 112;
    /// <summary>Native ceiling: the elevator works only at mineLevel &lt;= 120 (MineShaft.cs:3067).</summary>
    private const int HighestElevatorMineLevel = 120;
    /// <summary>Native ceiling on selectable floors (MineElevatorMenu.cs:16).</summary>
    private const int HighestSelectableMineFloor = 120;
    /// <summary>Mine shaft 0 returns to this location/tile (MineElevatorMenu.cs:86).</summary>
    internal const string MineEntranceLocation = "Mine";
    internal const int MineEntranceTileX = 17;
    internal const int MineEntranceTileY = 4;
    /// <summary>Prefix of a generated mine level's location name (MineShaft.cs:4870).</summary>
    internal const string GeneratedMineLevelPrefix = "UndergroundMine";

    /// <summary>
    /// The floors the elevator offers right now. Pure over the public
    /// <c>lowestLevelReached</c>, so the same function serves the snapshot projection
    /// and the admission re-check and they cannot drift apart.
    /// </summary>
    internal static IReadOnlyList<int> SelectableMineFloors(int lowestLevelReached)
    {
        List<int> floors = new() { 0 };
        int highest = Math.Min(lowestLevelReached, HighestSelectableMineFloor) / 5 * 5;
        for (int floor = 5; floor <= highest; floor += 5)
            floors.Add(floor);
        return floors;
    }

    internal static string MineElevatorFloorTargetId(int floor) => $"mine_elevator_floor_{floor}";

    /// <summary>
    /// The elevator exists as a physical tile of the CURRENT mine shaft. Both native
    /// facts are checked against live state: this must be a MineShaft, and its
    /// Buildings layer must carry tile 112 (MineShaft.cs:3057/3066).
    /// </summary>
    private static bool TryFindMineElevatorTile(GameLocation? location, out int tileX, out int tileY)
    {
        tileX = 0;
        tileY = 0;
        if (location is not MineShaft shaft)
            return false;
        xTile.Layers.Layer? buildings = shaft.map?.GetLayer("Buildings");
        if (buildings is null)
            return false;
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (buildings.Tiles[x, y]?.TileIndex == MineElevatorTileIndex)
                {
                    tileX = x;
                    tileY = y;
                    return true;
                }
            }
        }
        return false;
    }

    /// <summary>
    /// Snapshot projection, published only when the native selection is actually
    /// legal right now: a MineShaft carrying the elevator tile, at a level the
    /// elevator serves (mineLevel &lt;= 120). Off that, the empty list is the honest
    /// answer because the action would refuse.
    /// </summary>
    private IReadOnlyList<BridgeMineElevatorFloorTarget> DiscoverMineElevatorFloors()
    {
        Farmer? player = Game1.player;
        if (player is null || !TryFindMineElevatorTile(player.currentLocation, out _, out _))
            return Array.Empty<BridgeMineElevatorFloorTarget>();
        if (player.currentLocation is not MineShaft shaft || shaft.mineLevel > HighestElevatorMineLevel)
            return Array.Empty<BridgeMineElevatorFloorTarget>();

        int lowest = MineShaft.lowestLevelReached;
        int current = shaft.mineLevel;
        List<BridgeMineElevatorFloorTarget> targets = new();
        foreach (int floor in SelectableMineFloors(lowest))
        {
            targets.Add(new BridgeMineElevatorFloorTarget(
                MineElevatorFloorTargetId(floor),
                floor,
                IsCurrentFloor: floor == current,
                IsMineEntrance: floor == 0));
        }
        return targets;
    }

    public LocalExecutionReceipt RequestLocalSelectMineElevatorFloor(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            // The guard reason NAMES the failure (no bound actor / wrong scope / world not ready). This body used
            // to discard it with `out _` and report player_not_actionable for every identity failure, which is
            // the failure-mode collapse the review flagged.
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        // One body at a time, exactly like the other travel-family actions: the
        // specification owns the body until the Warped edge releases it.
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null
            || this.activeToolApproach is not null)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "body_owned",
                this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId);
        }

        // Native facility first: a MineShaft with the elevator tile. A location that
        // has no elevator cannot select a floor, and this is also what stops the
        // action from being usable from the entrance map.
        if (!TryFindMineElevatorTile(actor.currentLocation, out int elevatorX, out int elevatorY))
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "mine_elevator_unavailable",
                $"expected=MineShaft+Buildings:{MineElevatorTileIndex};actual={actor.currentLocation?.NameOrUniqueName ?? "none"}");

        MineShaft shaft = (MineShaft)actor.currentLocation!;

        // The elevator's own level ceiling (MineShaft.cs:3067).
        if (shaft.mineLevel > HighestElevatorMineLevel)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "mine_elevator_out_of_service",
                $"mine_level={shaft.mineLevel};max={HighestElevatorMineLevel}");

        if (string.IsNullOrWhiteSpace(request.Args.ExpectedTargetId))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "missing_expected_target_id", null);
        string targetId = request.Args.ExpectedTargetId;

        // Re-derive the offered set on the game thread: the client's id is matched
        // against live progress, never parsed into a level.
        int lowestLevelReached = MineShaft.lowestLevelReached;
        int? selectedFloor = null;
        foreach (int floor in SelectableMineFloors(lowestLevelReached))
        {
            if (string.Equals(MineElevatorFloorTargetId(floor), targetId, StringComparison.Ordinal))
            {
                selectedFloor = floor;
                break;
            }
        }

        if (selectedFloor is not int floorToSelect)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "mine_elevator_floor_not_available",
                $"target={targetId};lowest_level_reached={lowestLevelReached}");

        // The native no-op (MineElevatorMenu.cs:90-93) is named rather than dispatched.
        if (floorToSelect != 0 && floorToSelect == shaft.mineLevel)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "mine_elevator_floor_already_current",
                $"floor={floorToSelect}");

        // Floor 0 targets the mine entrance map; every other floor targets a
        // generated level, and the native layout repositions the actor on arrival,
        // so the postcondition for those is "reached the level", not a fixed tile.
        string targetLocation = floorToSelect == 0
            ? MineEntranceLocation
            : $"{GeneratedMineLevelPrefix}{floorToSelect}";
        int targetTileX = floorToSelect == 0 ? MineEntranceTileX : 6;
        int targetTileY = floorToSelect == 0 ? MineEntranceTileY : 6;
        int originFloor = shaft.mineLevel;
        string originLocation = shaft.NameOrUniqueName;

        LocalTravelSpec specification = new(
            executionId,
            request.RequestId,
            "select_mine_elevator_floor",
            originLocation,
            actor.TilePoint.X,
            actor.TilePoint.Y,
            targetLocation,
            targetTileX,
            targetTileY,
            this.revision,
            request.DeadlineMs);

        try
        {
            if (floorToSelect == 0)
            {
                Game1.warpFarmer(MineEntranceLocation, MineEntranceTileX, MineEntranceTileY, flip: true);
            }
            else
            {
                // The public flag first: the mine entrance reads it to choose the
                // elevator landing tile over the ladder one (MineElevatorMenu.cs:94).
                Game1.player.ridingMineElevator = true;
                Game1.enterMine(floorToSelect);
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "mine_elevator_native_exception",
                $"target={targetId};floor={floorToSelect};native_exception={nativeException.GetType().Name}");
        }

        this.activeTravel = specification;
        LocalExecutionReceipt accepted = new(
            executionId,
            request.RequestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            $"origin={originLocation};origin_floor={originFloor};floor={floorToSelect};"
                + $"is_entrance={floorToSelect == 0};target={targetLocation};"
                + $"lowest_level_reached={lowestLevelReached};elevator_tile={elevatorX},{elevatorY};"
                + $"riding_mine_elevator={Game1.player.ridingMineElevator}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }
}
