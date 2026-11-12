using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;
using StardewValley.Characters;
using StardewValley.Locations;
using GameBuddy.Stardew.Core.Models;
using MineFloorCapability = GameBuddy.Stardew.Core.MineFloorCapability;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private static IReadOnlyList<BridgeRaftTarget> DiscoverRaftTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null)
            return Array.Empty<BridgeRaftTarget>();

        return AdjacentCardinalTiles(player)
            .Where(tile => location.isWaterTile((int)tile.X, (int)tile.Y))
            .Take(16)
            .Select(tile => new BridgeRaftTarget(BuildRaftTargetId(location, (int)tile.X, (int)tile.Y), (int)tile.X, (int)tile.Y))
            .ToArray();
    }

    private static IEnumerable<Vector2> AdjacentCardinalTiles(Farmer player)
    {
        Vector2 origin = player.Tile;
        yield return origin + new Vector2(0, -1);
        yield return origin + new Vector2(1, 0);
        yield return origin + new Vector2(0, 1);
        yield return origin + new Vector2(-1, 0);
    }

    private static string BuildRaftTargetId(GameLocation location, int x, int y) =>
        $"raft_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}"))).ToLowerInvariant()[..16]}";

    private static IReadOnlyList<BridgeHorseTarget> DiscoverHorseTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHorseTarget>();
        return location.characters.OfType<Horse>()
            .Where(horse => !string.IsNullOrWhiteSpace(horse.Name)
                && !string.Equals(horse.Name, "Horse", StringComparison.Ordinal)
                && horse.rider is null
                && IsTileWithinChebyshevRadius(player, (int)horse.Tile.X, (int)horse.Tile.Y, TargetDiscoveryRadius))
            .Take(16)
            .Select(horse => new BridgeHorseTarget(BuildHorseTargetId(location, horse), (int)horse.Tile.X, (int)horse.Tile.Y, horse.Name))
            .ToArray();
    }

    private static string BuildHorseTargetId(GameLocation location, Horse horse) =>
        $"horse_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{horse.HorseId}"))).ToLowerInvariant()[..16]}";

    /// <summary>The mine entrance map's own <c>Action</c> selector.</summary>
    internal const string MineEntranceSelector = "Mine";
    /// <summary>The ladder-down selector of this same opaque id family.</summary>
    internal const string MineLadderSelector = "MineLadder";
    /// <summary>The ladder-up (exit) selector of this same opaque id family.</summary>
    internal const string MineExitLadderSelector = "MineExitLadder";
    /// <summary>The descending ladder's Buildings-layer tile index in a mine level (MineShaft.cs:3083).</summary>
    private const int MineLadderTileIndex = 173;
    /// <summary>The exit ladder's Buildings-layer tile index in a mine level (MineShaft.cs:3073).</summary>
    private const int MineExitLadderTileIndex = 115;
    /// <summary>The question key the 115 branch itself opens (MineShaft.cs:3080).</summary>
    internal const string MineExitQuestionKey = "ExitMine";
    /// <summary>The one response that leaves; the tile offers Leave and Do nothing (MineShaft.cs:3077-3078).</summary>
    internal const string MineExitResponseKey = "Leave";
    /// <summary>Skull Cavern's entrance map, where `ExitMine_Leave` sends an actor past level 120.</summary>
    internal const string SkullCavernEntranceLocation = "SkullCave";
    /// <summary>
    /// The secret woods shaft's level number. `ExitMine_Leave` treats it as the exception it is and returns the actor to
    /// the Mine entrance at 67,10 rather than 23,8 (GameLocation.cs:12390-12392).
    /// </summary>
    internal const int SecretWoodsMineLevel = 77377;
    /// <summary>Where `ExitMine_Leave` lands an actor leaving an ordinary mine level.</summary>
    internal const int MineExitTileX = 23;
    internal const int MineExitTileY = 8;

    private static IReadOnlyList<BridgeMineEntranceTarget> DiscoverMineEntranceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null) return Array.Empty<BridgeMineEntranceTarget>();

        // Inside a mine level this family publishes that level's own LADDER tiles, in both directions:
        //
        //  - the way OUT is tile 115, which the level's shipped Buildings layer carries at its stairs, so it
        //    exists whether or not anything has been cleared. Measured 2026-11-03 (round30): a companion that
        //    entered level 1 was published `warps: 0`, `doorTargets: 0` and no descent ladder, so every way out
        //    was unnamable and it stayed in the mine until it passed out at 02:00;
        //  - the way DOWN is tile 173, which exists only after a stone is broken or a level is cleared
        //    (`createLadderDown`, MineShaft.cs:3587-3612).
        //
        // A shaft has no `Mine` Action tile, so reporting the entrance scan here would report nothing at all.
        if (location is MineShaft shaft)
        {
            List<BridgeMineEntranceTarget> ladders = new();
            if (TryFindMineExitLadderTile(shaft, out int exitX, out int exitY))
                ladders.Add(new BridgeMineEntranceTarget(BuildMineEntryTargetId(shaft.NameOrUniqueName, exitX, exitY, MineExitLadderSelector), exitX, exitY));
            if (TryFindMineLadderTile(shaft, out int ladderX, out int ladderY))
                ladders.Add(new BridgeMineEntranceTarget(BuildMineEntryTargetId(shaft.NameOrUniqueName, ladderX, ladderY, MineLadderSelector), ladderX, ladderY));
            return ladders;
        }

        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<BridgeMineEntranceTarget> result = new();
        for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= Math.Min(width - 1, player.TilePoint.X + TargetDiscoveryRadius); x++)
        for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= Math.Min(height - 1, player.TilePoint.Y + TargetDiscoveryRadius); y++)
        {
            string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
            if (action is null || !string.Equals(action.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(), MineEntranceSelector, StringComparison.Ordinal))
                continue;
            result.Add(new BridgeMineEntranceTarget(BuildMineEntryTargetId(location.NameOrUniqueName, x, y, MineEntranceSelector), x, y));
            if (result.Count == 16) return result;
        }
        return result;
    }

    /// <summary>
    /// The descent tile of a mine level, found the same way the elevator tile is: a
    /// live scan of the level's own Buildings layer, never a client coordinate.
    /// </summary>
    internal static bool TryFindMineLadderTile(GameLocation? location, out int tileX, out int tileY) =>
        TryFindMineTileWithIndex(location, MineLadderTileIndex, out tileX, out tileY);

    /// <summary>
    /// The EXIT tile of a mine level: the same live scan on the ladder-up index. A location that is not a mine level has
    /// neither ladder, so it answers false and the caller turns that into a refusal rather than a coordinate.
    /// </summary>
    internal static bool TryFindMineExitLadderTile(GameLocation? location, out int tileX, out int tileY) =>
        TryFindMineTileWithIndex(location, MineExitLadderTileIndex, out tileX, out tileY);

    /// <summary>One mine tile by its Buildings-layer index, scanned from the live layer and never from the request.</summary>
    private static bool TryFindMineTileWithIndex(GameLocation? location, int tileIndex, out int tileX, out int tileY)
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
                if (buildings.Tiles[x, y]?.TileIndex == tileIndex)
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
    /// The opaque id of one live mine-entry object. Three kinds share the family: a
    /// <c>Mine</c> Action tile on the mine entrance map, the descending ladder tile
    /// inside a mine level, and the exit ladder tile there. All keep the published
    /// <c>mine_entrance_&lt;16 hex&gt;</c> wire shape (the Host validates exactly that
    /// prefix and length), and the hash input names the kind, so they can never collide.
    /// </summary>
    internal static string BuildMineEntryTargetId(string locationName, int x, int y, string selector) =>
        $"mine_entrance_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{locationName}:{x},{y}:{selector}"))).ToLowerInvariant()[..16]}";

    /// <summary>
    /// The horse a published opaque id names, from the actor's CURRENT location.
    /// <c>BuildHorseTargetId</c> hashes the location and the horse's own id, so a horse that walked between the
    /// snapshot and this read resolves to the same subject. The discovery filters are re-applied because either can
    /// change while the actor walks: a horse that acquired a rider is no longer this action's target.
    /// </summary>
    private static Horse? ResolveHorseTarget(GameLocation location, string expectedTargetId) =>
        location.characters.OfType<Horse>().FirstOrDefault(candidate =>
            string.Equals(BuildHorseTargetId(location, candidate), expectedTargetId, StringComparison.Ordinal)
            && candidate.rider is null
            && !string.IsNullOrWhiteSpace(candidate.Name)
            && !string.Equals(candidate.Name, "Horse", StringComparison.Ordinal));

    public LocalExecutionReceipt RequestLocalMountTransport(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        GameLocation location = Game1.player.currentLocation;
        // The horse is a moving subject, so the request binds the SUBJECT (`location + HorseId`) rather than the tile
        // the snapshot happened to publish. Comparing the live tile against the published one refused
        // `horse_target_moved` for a horse that had taken one step, a race no caller can win by retrying.
        Horse? horse = ResolveHorseTarget(location, expectedTargetId);
        if (horse is null) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_unavailable", $"target={expectedTargetId}");
        if (Game1.player.CurrentItem is StardewValley.Objects.Hat || Game1.player.CurrentItem?.QualifiedItemId == "(O)Carrot")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_interaction_item_interference",
                $"held={(Game1.player.CurrentItem?.QualifiedItemId ?? "none")}");
        // 5.2: out of the native Chebyshev-1 radius, walk in rather than refuse. The horse stands on the map the actor
        // is already on; identity, reach and hands are re-read on arrival because the walk takes ticks and the horse
        // keeps walking.
        int horseTileX = (int)horse.Tile.X;
        int horseTileY = (int)horse.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, horseTileX, horseTileY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "mount_transport", location, horseTileX, horseTileY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteMountTransport(arrivalExecutionId, arrivalRequestId, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

        return this.ExecuteMountTransport(executionId, requestId, expectedTargetId, requestedDeadlineMs);
    }

    /// <summary>
    /// Executes mount_transport against the current world, re-deriving the horse from its opaque id. Shared by the
    /// in-range path and the post-approach path: reusing the object captured before the walk would drive the native
    /// <c>checkAction</c> at the tile the horse had already left.
    /// </summary>
    private LocalExecutionReceipt ExecuteMountTransport(string executionId, string requestId, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        Horse? horse = ResolveHorseTarget(location, expectedTargetId);
        if (horse is null) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_unavailable", $"target={expectedTargetId}");
        if (Game1.player.CurrentItem is StardewValley.Objects.Hat || Game1.player.CurrentItem?.QualifiedItemId == "(O)Carrot")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_interaction_item_interference",
                $"held={(Game1.player.CurrentItem?.QualifiedItemId ?? "none")}");
        // Reach is measured against the horse's LIVE tile. The walk was aimed at the tile it occupied when the
        // approach began, and it may have moved since; the shared arrival leg sees only that fixed tile, so this is
        // the check that separates "arrived and it moved" from "never got close enough".
        int horseTileX = (int)horse.Tile.X;
        int horseTileY = (int)horse.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, horseTileX, horseTileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_out_of_range",
                $"target={expectedTargetId};horse={horseTileX},{horseTileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=target_moved");

        LocalMountTransportSpec specification = new(executionId, requestId, location.NameOrUniqueName, horseTileX, horseTileY, expectedTargetId, horse.HorseId, requestedDeadlineMs);
        this.slots.MountTransport.Assign(specification);
        bool handled = horse.checkAction(Game1.player, location);
        if (!handled)
        {
            this.slots.MountTransport.Clear();
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_action_not_handled", $"target={expectedTargetId}");
        }
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "horse_mount_pending", $"target={expectedTargetId};tile={horseTileX},{horseTileY};horse_id={horse.HorseId}");
    }

    public LocalExecutionReceipt RequestLocalEnterMine(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        GameLocation location = Game1.player.currentLocation;

        // Inside a mine the way down is that level's own ladder tile, not the
        // entrance map's `Mine` Action. The native branch it mirrors is
        // `MineShaft.checkAction` case 173 -> `Game1.enterMine(mineLevel + 1)`
        // (MineShaft.cs:3083-3086), so the target level is native state (the level
        // the actor is already on, plus one) and never a client-supplied value.
        if (location is MineShaft)
        {
            MineLadderTargetResolution ladder = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Descend);
            if (!ladder.Accepted)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, ladder.RefusalCode, ladder.Evidence);
            // The floor, before the walk: a descent this surface cannot answer is refused at the request too, because
            // walking to the ladder first costs a turn and teaches the caller nothing it was not just told.
            if (this.RefuseDescentIntoMonsters(requestId, executionId, location, ((MineShaft)location).mineLevel + 1, attempt: "ladder_request") is { } refusedDescent)
                return refusedDescent;
            // 5.2: the ladder is a tile of the level the actor is standing on, so out of the native radius means walk
            // in, not refuse. Identity and reach are re-read on arrival from the live layer.
            if (!IsTileWithinChebyshevRadius(Game1.player, ladder.TileX, ladder.TileY, 1))
                return this.TryBeginToolApproach(requestId, executionId, "enter_mine", location, ladder.TileX, ladder.TileY, expectedTargetId,
                    (arrivalExecutionId, arrivalRequestId) => this.ExecuteEnterMineLadder(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

            return this.ExecuteEnterMineLadder(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
        }

        MineEntranceTargetResolution entrance = ResolveMineEntrance(location, targetX, targetY, expectedTargetId);
        if (!entrance.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_target_unavailable", entrance.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, entrance.TileX, entrance.TileY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "enter_mine", location, entrance.TileX, entrance.TileY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteEnterMineEntrance(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

        return this.ExecuteEnterMineEntrance(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    /// <summary>
    /// Descends the live ladder of the mine level the actor is on. Reached both in range and on arrival, so the ladder
    /// is re-read from the level's own Buildings layer and the descent level is derived from the shaft's LIVE level
    /// rather than carried in from the request.
    /// </summary>
    private LocalExecutionReceipt ExecuteEnterMineLadder(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        MineLadderTargetResolution ladder = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Descend);
        if (!ladder.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, ladder.RefusalCode, ladder.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, ladder.TileX, ladder.TileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_ladder_out_of_range",
                $"ladder={ladder.TileX},{ladder.TileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=did_not_arrive");

        MineShaft shaft = (MineShaft)location;
        int descentLevel = shaft.mineLevel + 1;
        // Re-asked on the GAME THREAD at the swing, not only at the request: the floor is native state, and the only
        // place it can be read for the act is here.
        if (this.RefuseDescentIntoMonsters(requestId, executionId, location, descentLevel, attempt: "ladder") is { } refusedDescent)
            return refusedDescent;
        Game1.enterMine(descentLevel);
        if (Game1.player.currentLocation is MineShaft descended && descended.mineLevel == descentLevel)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={descended.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};from_level={shaft.mineLevel}");
        LocalTravelSpec descentSpecification = new(executionId, requestId, "enter_mine", shaft.NameOrUniqueName, ladder.TileX, ladder.TileY, MineShaft.GetLevelName(descentLevel), 6, 6, this.revision, requestedDeadlineMs);
        this.slots.Travel.Assign(descentSpecification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "mine_entry_pending", $"source={shaft.NameOrUniqueName}:{ladder.TileX},{ladder.TileY};target={descentSpecification.TargetLocation}:6,6;level={descentLevel}");
    }

    /// <summary>
    /// Enters the mine through the entrance map's own <c>Mine</c> Action tile. Reached both in range and on arrival:
    /// the tile's Action property is re-read on arrival, so the level entered is the level THIS tile declares now.
    /// </summary>
    private LocalExecutionReceipt ExecuteEnterMineEntrance(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        MineEntranceTargetResolution entrance = ResolveMineEntrance(location, targetX, targetY, expectedTargetId);
        if (!entrance.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_target_unavailable", entrance.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, entrance.TileX, entrance.TileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_out_of_range",
                $"tile={entrance.TileX},{entrance.TileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=did_not_arrive");

        int declaredLevel = entrance.DeclaredLevel;
        // The entrance map declares which floor it enters (`case "Mine"`, GameLocation.cs:9807-9816), so that value is
        // the one this surface has to be able to answer.
        if (this.RefuseDescentIntoMonsters(requestId, executionId, location, declaredLevel, attempt: "entrance") is { } refusedEntrance)
            return refusedEntrance;
        // Enter through the public native entry (the M8-frozen seam) with the
        // level this exact tile declares; the checks above already proved it is a
        // mine entrance and that its declared level is readable.
        Game1.enterMine(declaredLevel);
        // The native MineShaft layout repositions the farmer onto the level's
        // stairs, so the requested landing tile is not a legal postcondition;
        // reaching the declared level is (the travel-completion branch agrees).
        if (Game1.player.currentLocation is MineShaft mine && mine.mineLevel == declaredLevel)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={mine.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");
        LocalTravelSpec specification = new(executionId, requestId, "enter_mine", location.NameOrUniqueName, entrance.TileX, entrance.TileY, MineShaft.GetLevelName(declaredLevel), 6, 6, this.revision, requestedDeadlineMs);
        this.slots.Travel.Assign(specification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "mine_entry_pending", $"source={location.NameOrUniqueName}:{entrance.TileX},{entrance.TileY};target={specification.TargetLocation}:6,6;level={declaredLevel}");
    }

    /// <summary>
    /// The refusal for a descent into a floor this surface cannot answer, or null when the engine keeps that floor
    /// monster-free.
    ///
    /// <para>
    /// The published action surface has no combat action, so a floor that spawns hostiles asks for a capability that
    /// does not exist. Descending into one is the shape of failure that costs a whole day: the companion is knocked out,
    /// loses what it was carrying, and the receipt that promised `mine_entered` named nothing about it. The refusal
    /// therefore names the FLOOR and the missing CAPABILITY, and nothing else about the descent is attempted.
    /// </para>
    /// <para>
    /// The floor's own state is published beside it (`current_floor`, `hostiles`): whether a hostile is standing in
    /// front of her right now is a live read of this level's own `characters`, and it is a fact she needs whatever the
    /// answer about the next floor turns out to be. What is deliberately NOT done is predicting the target floor's roll -
    /// that draw belongs to `MineShaft.loadLevel`, and a second copy of it here would be a second authority over it.
    /// </para>
    /// <para>
    /// <paramref name="attempt"/> names which seam asked (`ladder_request`, `ladder`, `entrance`, `elevator`), so a
    /// receipt that refused before the walk and one that refused at the swing are distinguishable.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt? RefuseDescentIntoMonsters(
        string requestId,
        string executionId,
        GameLocation location,
        int targetFloor,
        string attempt)
    {
        if (MineFloorCapability.IsMonsterFree(targetFloor))
            return null;
        return this.RememberTerminal(
            requestId,
            executionId,
            ExecutionState.Rejected,
            MineFloorCapability.RefusalReasonCode,
            $"{MineFloorCapability.DescribeRefusal(targetFloor)};attempt={attempt};{DescribeHostilesOnCurrentFloor(location)}");
    }

    /// <summary>
    /// Where she is standing and how many hostiles are on THAT floor, from the level's own character list - the one
    /// place the engine keeps them (<c>GameLocation.characters</c>), read rather than predicted.
    /// </summary>
    private static string DescribeHostilesOnCurrentFloor(GameLocation location)
    {
        int hostiles = 0;
        foreach (NPC character in location.characters)
        {
            if (character is StardewValley.Monsters.Monster)
                hostiles += 1;
        }

        int floor = location is MineShaft shaft ? shaft.mineLevel : 0;
        return $"current_floor={floor};hostiles={hostiles}";
    }

    /// <summary>
    /// Leaves the mine level through its own exit ladder.
    ///
    /// <para>
    /// Boundary: the native seam is the LEVEL's own <c>checkAction</c>, not a warp this body invents.
    /// <c>MineShaft.checkAction</c> switches on the Buildings-layer tile index (:3057) and case 115 opens the
    /// <c>ExitMine</c> question with the game's own two responses, Leave and Do nothing (:3073-3081). This body drives
    /// exactly that: the tile is re-read from the live layer, the game opens its question, and the answer is
    /// "Leave", settled through the same location leaf <c>answer_dialogue</c> uses. The warp is performed by the game
    /// inside <c>answerDialogueAction</c> (case <c>ExitMine_Leave</c>, GameLocation.cs:12388-12401), so no coordinate of
    /// ours becomes the destination.
    /// </para>
    /// <para>
    /// Why it exists: measured 2026-11-03 (round30) a companion that had taken <c>enter_mine</c> was published no
    /// ladder at all on a freshly generated level and stayed there until it passed out at 02:00, losing the next day.
    /// The way OUT is the one tile every mine level carries.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalUseMineLadder(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;

        GameLocation location = Game1.player.currentLocation;
        MineLadderTargetResolution exit = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Exit);
        if (!exit.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, exit.RefusalCode, exit.Evidence);
        // 5.2: the ladder is a tile of the level the actor is already on, so out of the native radius means walk in,
        // not refuse. Identity and reach are re-read on arrival from the live layer.
        if (!IsTileWithinChebyshevRadius(Game1.player, exit.TileX, exit.TileY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "use_mine_ladder", location, exit.TileX, exit.TileY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteUseMineLadder(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);

        return this.ExecuteUseMineLadder(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    /// <summary>
    /// Drives the exit ladder the request names. Reached both in range and on arrival, so the tile, the level and the
    /// question are re-read from live state: the walk takes ticks and the level can be left by something else first.
    /// </summary>
    private LocalExecutionReceipt ExecuteUseMineLadder(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        MineLadderTargetResolution exit = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Exit);
        if (!exit.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, exit.RefusalCode, exit.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, exit.TileX, exit.TileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_exit_ladder_out_of_range",
                $"ladder={exit.TileX},{exit.TileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=did_not_arrive");

        MineShaft shaft = (MineShaft)location;
        string origin = shaft.NameOrUniqueName;
        int originLevel = shaft.mineLevel;
        (string destinationLocation, int destinationX, int destinationY) = MineExitDestination(originLevel);

        bool handled;
        try
        {
            handled = shaft.checkAction(new xTile.Dimensions.Location(exit.TileX, exit.TileY), Game1.viewport, Game1.player);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "mine_exit_native_exception",
                $"from={origin}:{originLevel};ladder={exit.TileX},{exit.TileY};native_dispatched=false;native_exception={nativeException.GetType().Name}");
        }
        if (!handled)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_exit_ladder_not_handled",
                $"from={origin}:{originLevel};ladder={exit.TileX},{exit.TileY};native_handled=false");

        // WIA §4.2 owner lease: the box that is about to appear is the one THIS execution caused by driving the ladder,
        // so it is action-owned until the execution ends. Without the lease the world-change arbitration reads the
        // game's own ExitMine question as an external interruption and kills the exit inside its own answer.
        this.RegisterModalOwner(executionId);

        // The question the GAME asked: its key and the responses it offered are read from the box it opened, never
        // assumed, so a level whose 115 branch changes shape is a refusal rather than a guessed answer.
        DialogueBox? question = Game1.activeClickableMenu as DialogueBox;
        string questionKey = shaft.lastQuestionKey ?? string.Empty;
        string offeredKeys = question?.responses is { Length: > 0 } offeredResponses
            ? string.Join(",", offeredResponses.Select(response => response.responseKey))
            : string.Join(",", (Game1.questionChoices ?? new List<Response>()).Select(response => response.responseKey));
        bool answerOffered = question is not null
            && question.isQuestion
            && string.Equals(questionKey, MineExitQuestionKey, StringComparison.Ordinal)
            && offeredKeys.Split(',').Contains(MineExitResponseKey, StringComparer.Ordinal);
        if (!answerOffered)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_exit_question_not_offered",
                $"from={origin}:{originLevel};ladder={exit.TileX},{exit.TileY};modal_type={(Game1.activeClickableMenu?.GetType().Name ?? "none")};question={(question?.isQuestion ?? false).ToString().ToLowerInvariant()};question_key={(questionKey.Length == 0 ? "none" : questionKey)};response_keys={(offeredKeys.Length == 0 ? "none" : offeredKeys)}");

        bool answered;
        try
        {
            answered = TryAnswerLocationQuestion(new Response(MineExitResponseKey, MineExitResponseKey));
            // The same outro `answer_dialogue` performs: the box is the game's, and leaving it up would hold the
            // body behind a modal after the world already moved.
            question!.beginOutro();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "mine_exit_native_exception",
                $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};native_dispatched=true;native_exception={nativeException.GetType().Name}");
        }

        if (!answered)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Failed, "mine_exit_answer_not_accepted",
                $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};native_answered=false");

        // The answer itself performs the warp, so an immediate terminal is only available when the actor is already
        // out of every mine level; otherwise the travel record owns the body until the game's own Warped edge.
        if (Game1.player.currentLocation is not MineShaft stillInside)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_left",
                $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};ladder={exit.TileX},{exit.TileY};actual={Game1.player.currentLocation?.NameOrUniqueName ?? "none"}:{Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");

        LocalTravelSpec exitSpecification = new(executionId, requestId, "use_mine_ladder", origin, exit.TileX, exit.TileY, destinationLocation, destinationX, destinationY, this.revision, requestedDeadlineMs);
        this.slots.Travel.Assign(exitSpecification);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "mine_exit_pending",
            $"from={origin}:{originLevel};question={MineExitQuestionKey};response={MineExitResponseKey};ladder={exit.TileX},{exit.TileY};target={destinationLocation}:{destinationX},{destinationY};still_in={stillInside.NameOrUniqueName}");
    }

    /// <summary>
    /// Where the game's own <c>ExitMine_Leave</c> response sends the actor, as the three-branch rule it applies to the
    /// CURRENT mine level (GameLocation.cs:12388-12401): the secret woods shaft returns to the Mine entrance at 67,10,
    /// anything past level 120 to the Skull Cavern entrance, and every other level to the Mine entrance at 23,8.
    ///
    /// <para>
    /// The destination has to be restated here because the response performs the warp INSIDE the game, and the travel
    /// record needs a destination to judge arrival - the same shape <c>select_mine_elevator_floor</c> already uses for
    /// the entrance map (MineElevatorMenu.cs:86). A value that drifts from the game's rule cannot produce a false
    /// success: it produces <c>mine_exit_postcondition_mismatch</c>.
    /// </para>
    /// </summary>
    internal static (string Location, int X, int Y) MineExitDestination(int mineLevel) => mineLevel switch
    {
        SecretWoodsMineLevel => (MineEntranceLocation, 67, 10),
        > HighestElevatorMineLevel => (SkullCavernEntranceLocation, 3, 4),
        _ => (MineEntranceLocation, MineExitTileX, MineExitTileY),
    };

    /// <summary>
    /// The live ladder the request names on the mine level the actor is on, or a refusal. The tile is re-read from the
    /// level's own Buildings layer and compared with the requested coordinate, so a stale coordinate or an old target
    /// id cannot pick a level.
    ///
    /// <para>
    /// EACH LADDER KIND HAS EXACTLY ONE OWNER: <c>use_mine_ladder</c> leaves through tile 115 and <c>enter_mine</c>
    /// descends tile 173, and neither serves the other's tile. A request that names the other kind is refused BY NAME
    /// with the action that does own it, because the two rows share one opaque id family and a caller cannot otherwise
    /// tell them apart: `mine_entrance_&lt;16 hex&gt;` for an exit ladder and for a descent ladder look identical.
    /// </para>
    /// </summary>
    private static MineLadderTargetResolution ResolveMineLadderTarget(GameLocation? location, int targetX, int targetY, string expectedTargetId, MineLadderKind wanted)
    {
        if (location is not MineShaft shaft)
            return new MineLadderTargetResolution(false, wanted, targetX, targetY, "not_in_mine",
                $"expected=MineShaft;actual={location?.NameOrUniqueName ?? "none"};tile={targetX},{targetY}");

        bool namesDescend = TryFindMineLadderTile(shaft, out int descendX, out int descendY)
            && descendX == targetX && descendY == targetY
            && string.Equals(BuildMineEntryTargetId(shaft.NameOrUniqueName, descendX, descendY, MineLadderSelector), expectedTargetId, StringComparison.Ordinal);
        bool namesExit = TryFindMineExitLadderTile(shaft, out int exitX, out int exitY)
            && exitX == targetX && exitY == targetY
            && string.Equals(BuildMineEntryTargetId(shaft.NameOrUniqueName, exitX, exitY, MineExitLadderSelector), expectedTargetId, StringComparison.Ordinal);

        if (wanted == MineLadderKind.Descend)
        {
            if (namesDescend)
                return new MineLadderTargetResolution(true, wanted, descendX, descendY, string.Empty, string.Empty);
            if (namesExit)
                return new MineLadderTargetResolution(false, wanted, exitX, exitY, "mine_ladder_is_exit",
                    $"target={expectedTargetId};tile={exitX},{exitY};mine_level={shaft.mineLevel};use_action=use_mine_ladder");
            return new MineLadderTargetResolution(false, wanted, targetX, targetY, "mine_ladder_target_unavailable",
                $"target={expectedTargetId};tile={targetX},{targetY};mine_level={shaft.mineLevel}");
        }

        if (namesExit)
            return new MineLadderTargetResolution(true, wanted, exitX, exitY, string.Empty, string.Empty);
        if (namesDescend)
            return new MineLadderTargetResolution(false, wanted, descendX, descendY, "mine_ladder_descends",
                $"target={expectedTargetId};tile={descendX},{descendY};mine_level={shaft.mineLevel};use_action=enter_mine");
        return new MineLadderTargetResolution(false, wanted, targetX, targetY, "mine_exit_ladder_target_unavailable",
            $"target={expectedTargetId};tile={targetX},{targetY};expected=MineShaft+Buildings:{MineExitLadderTileIndex};mine_level={shaft.mineLevel};use_action=enter_mine");
    }

    /// <summary>
    /// The mine entrance the request names, with the level its own <c>Action</c> string declares.
    ///
    /// The level is read exactly the way the native click path reads it (<c>GameLocation.performAction</c>
    /// `case "Mine"`: `ArgUtility.TryGetOptionalInt(action, 1, out mineLevel, out error, 1, "int mineLevel")` ->
    /// `Game1.enterMine(mineLevel)`, GameLocation.cs:9807-9816), so the entered level is the facility's own declaration
    /// rather than a value derived from the actor's progress. A malformed parameter is the same refusal the native path
    /// produces (it logs an error and enters nothing).
    /// NOTE (unverified): the shipped map data is xnb and cannot be read from here, so which literal the live entrance
    /// declares is deliberately NOT asserted: whatever the tile declares is what gets entered.
    /// </summary>
    private static MineEntranceTargetResolution ResolveMineEntrance(GameLocation location, int targetX, int targetY, string expectedTargetId)
    {
        string? action = location.doesTileHaveProperty(targetX, targetY, "Action", "Buildings");
        string[] actionTokens = ArgUtility.SplitBySpace(action ?? string.Empty);
        if (action is null
            || !string.Equals(BuildMineEntryTargetId(location.NameOrUniqueName, targetX, targetY, MineEntranceSelector), expectedTargetId, StringComparison.Ordinal)
            || !string.Equals(actionTokens.FirstOrDefault(), MineEntranceSelector, StringComparison.Ordinal)
            || !ArgUtility.TryGetOptionalInt(actionTokens, 1, out int declaredLevel, out _, 1, "int mineLevel"))
            return new MineEntranceTargetResolution(false, targetX, targetY, 0, $"tile={targetX},{targetY};action={action ?? "none"}");

        return new MineEntranceTargetResolution(true, targetX, targetY, declaredLevel, string.Empty);
    }

    public LocalExecutionReceipt RequestLocalUseRaft(string requestId, int slot, int targetX, int targetY, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        // Ask before walking: a pack that cannot satisfy this action's own `tool:raft` claim is refused now rather than
        // after an approach leg the action could never finish. The slot the caller named is recorded, never obeyed.
        if (ResolveDeclaredTool(player.Items, "use_raft").RefusalCode is { } toolRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusal, $"slot={slot}");
        if (!location.isWaterTile(targetX, targetY))
            // What the tile actually IS, beside the tile the caller named: `tile=..` alone repeats the request, so "that is
            // not water" arrived with nothing to act on (`refusal_names_nothing_actionable`, gate
            // `refusal_informativeness/v1`). The fields are the sibling `pan_site_not_water` refusal's own spelling.
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_not_water",
                $"tile={targetX},{targetY};location={location.NameOrUniqueName};is_water=false;actor_tile={player.TilePoint.X},{player.TilePoint.Y}");
        // 5.2: the water tile is on the map the actor is standing on and the shore beside it is walkable, so out of the
        // native radius means walk to the shore and launch, rather than refuse.
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "use_raft", location, targetX, targetY, BuildRaftTargetId(location, targetX, targetY),
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteUseRaft(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY), nowMs, requestedDeadlineMs);

        return this.ExecuteUseRaft(executionId, requestId, slot, targetX, targetY);
    }

    /// <summary>
    /// Launches the raft at the named water tile. Reached both in range and on arrival: the tool and the tile's water
    /// property are re-read because the walk takes ticks. The raft is NOT the caller's to name - the action's own
    /// registration claims `tool:raft`, so this selects the raft it needs and puts the actor's own selection back in a
    /// `finally`, which is what every other declared-tool action in this Mod does.
    /// </summary>
    private LocalExecutionReceipt ExecuteUseRaft(string executionId, string requestId, int slot, int targetX, int targetY)
    {
        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        if (!TrySelectDeclaredTool(player, "use_raft", out DeclaredToolSelection selection, out string toolRefusalCode))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, toolRefusalCode, $"slot={slot}");
        try
        {
            // Never launch whatever the switch left in hand: the selection's own postcondition.
            if (selection.Tool is not Raft raft)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, $"tool_not_selected:{selection.Category}", $"slot={selection.Slot}");
            if (!location.isWaterTile(targetX, targetY))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_not_water",
                    $"tile={targetX},{targetY};location={location.NameOrUniqueName};is_water=false;actor_tile={player.TilePoint.X},{player.TilePoint.Y}");
            if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_out_of_range",
                    $"tile={targetX},{targetY};actor_tile={player.TilePoint.X},{player.TilePoint.Y};reach=1;approach=did_not_arrive");

            float staminaBefore = player.Stamina;
            bool raftingBefore = player.isRafting;
            raft.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 1, player);
            bool launched = !raftingBefore && player.isRafting;
            if (!launched && player.Stamina != staminaBefore)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "raft_launch_postcondition_unavailable", $"tile={targetX},{targetY};is_rafting={player.isRafting.ToString().ToLowerInvariant()};stamina_changed=true");
            // The Host pins this action's success evidence to the exact key set `tile;is_rafting;stamina_before;stamina_after`,
            // so the selection adds no key here; the tests prove the switch and the restore instead.
            return this.RememberTerminal(requestId, executionId, launched ? ExecutionState.Succeeded : ExecutionState.Rejected,
                launched ? "raft_launched" : "raft_launch_not_started",
                $"tile={targetX},{targetY};is_rafting={player.isRafting.ToString().ToLowerInvariant()};stamina_before={staminaBefore:0.####};stamina_after={player.Stamina:0.####}");
        }
        finally
        {
            RestoreToolSelection(player, selection);
        }
    }

    /// <summary>Which of the two ladder kinds a request may name; each kind has exactly one owner action.</summary>
    internal enum MineLadderKind
    {
        Descend,
        Exit,
    }

    /// <summary>One live ladder tile of the kind the request named, or a refusal code and its evidence.</summary>
    private sealed record MineLadderTargetResolution(bool Accepted, MineLadderKind Kind, int TileX, int TileY, string RefusalCode, string Evidence);

    /// <summary>One live mine entrance, with the level its own Action string declares.</summary>
    private sealed record MineEntranceTargetResolution(bool Accepted, int TileX, int TileY, int DeclaredLevel, string Evidence);

}
