using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;
using StardewValley.Locations;
using GameBuddy.Stardew.Core.Models;

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
    /// <summary>The descending ladder's Buildings-layer tile index in a mine level (MineShaft.cs:3083).</summary>
    private const int MineLadderTileIndex = 173;

    private static IReadOnlyList<BridgeMineEntranceTarget> DiscoverMineEntranceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null) return Array.Empty<BridgeMineEntranceTarget>();

        // Inside a mine level the way down is that level's own ladder tile, whose
        // native terminal is the same public `Game1.enterMine` this action already
        // owns (MineShaft.checkAction case 173, MineShaft.cs:3083-3086). A shaft has
        // no `Mine` Action tile, so reporting the entrance scan here would report
        // nothing at all.
        if (location is MineShaft shaft)
            return TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)
                ? new[] { new BridgeMineEntranceTarget(BuildMineEntryTargetId(shaft.NameOrUniqueName, ladderX, ladderY, MineLadderSelector), ladderX, ladderY) }
                : Array.Empty<BridgeMineEntranceTarget>();

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
    internal static bool TryFindMineLadderTile(GameLocation? location, out int tileX, out int tileY)
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
                if (buildings.Tiles[x, y]?.TileIndex == MineLadderTileIndex)
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
    /// The opaque id of one live mine-entry object. Two kinds share the family: a
    /// <c>Mine</c> Action tile on the mine entrance map, and the descending ladder
    /// tile inside a mine level. Both keep the published <c>mine_entrance_&lt;16 hex&gt;</c>
    /// wire shape (the Host validates exactly that prefix and length), and the hash
    /// input names the kind, so the two can never collide.
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
        string executionId = this.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        GameLocation location = Game1.player.currentLocation;
        // The horse is a moving subject, so the request binds the SUBJECT (`location + HorseId`) rather than the tile
        // the snapshot happened to publish. Comparing the live tile against the published one refused
        // `horse_target_moved` for a horse that had taken one step, a race no caller can win by retrying.
        Horse? horse = ResolveHorseTarget(location, expectedTargetId);
        if (horse is null) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_unavailable", $"target={expectedTargetId}");
        if (Game1.player.CurrentItem is StardewValley.Objects.Hat || Game1.player.CurrentItem?.QualifiedItemId == "(O)Carrot")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_interaction_item_interference", null);
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
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_interaction_item_interference", null);
        // Reach is measured against the horse's LIVE tile. The walk was aimed at the tile it occupied when the
        // approach began, and it may have moved since; the shared arrival leg sees only that fixed tile, so this is
        // the check that separates "arrived and it moved" from "never got close enough".
        int horseTileX = (int)horse.Tile.X;
        int horseTileY = (int)horse.Tile.Y;
        if (!IsTileWithinChebyshevRadius(Game1.player, horseTileX, horseTileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_out_of_range",
                $"target={expectedTargetId};horse={horseTileX},{horseTileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=target_moved");

        LocalMountTransportSpec specification = new(executionId, requestId, location.NameOrUniqueName, horseTileX, horseTileY, expectedTargetId, horse.HorseId, requestedDeadlineMs);
        this.activeMountTransport = specification;
        bool handled = horse.checkAction(Game1.player, location);
        if (!handled)
        {
            this.activeMountTransport = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_action_not_handled", $"target={expectedTargetId}");
        }
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "horse_mount_pending", this.revision, $"target={expectedTargetId};tile={horseTileX},{horseTileY};horse_id={horse.HorseId}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    public LocalExecutionReceipt RequestLocalEnterMine(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = this.NewExecutionId(requestId);
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
            MineLadderTargetResolution ladder = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId);
            if (!ladder.Accepted)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_ladder_target_unavailable", ladder.Evidence);
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
        MineLadderTargetResolution ladder = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId);
        if (!ladder.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_ladder_target_unavailable", ladder.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, ladder.TileX, ladder.TileY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_ladder_out_of_range",
                $"ladder={ladder.TileX},{ladder.TileY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;approach=did_not_arrive");

        MineShaft shaft = (MineShaft)location;
        int descentLevel = shaft.mineLevel + 1;
        Game1.enterMine(descentLevel);
        if (Game1.player.currentLocation is MineShaft descended && descended.mineLevel == descentLevel)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={descended.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};from_level={shaft.mineLevel}");
        LocalTravelSpec descentSpecification = new(executionId, requestId, "enter_mine", shaft.NameOrUniqueName, ladder.TileX, ladder.TileY, MineShaft.GetLevelName(descentLevel), 6, 6, this.revision, requestedDeadlineMs);
        this.activeTravel = descentSpecification;
        LocalExecutionReceipt descentAccepted = new(executionId, requestId, ExecutionState.Accepted, "mine_entry_pending", this.revision, $"source={shaft.NameOrUniqueName}:{ladder.TileX},{ladder.TileY};target={descentSpecification.TargetLocation}:6,6;level={descentLevel}");
        this.Remember(descentAccepted);
        this.AddTrace(descentAccepted);
        return descentAccepted;
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
        this.activeTravel = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "mine_entry_pending", this.revision, $"source={location.NameOrUniqueName}:{entrance.TileX},{entrance.TileY};target={specification.TargetLocation}:6,6;level={declaredLevel}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// The live ladder the request names on the mine level the actor is on, or a refusal. The tile is re-read from the
    /// level's own Buildings layer and compared with the requested coordinate, so a stale coordinate or an old target
    /// id cannot pick a level.
    /// </summary>
    private static MineLadderTargetResolution ResolveMineLadderTarget(GameLocation location, int targetX, int targetY, string expectedTargetId)
    {
        if (location is not MineShaft shaft
            || !TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)
            || ladderX != targetX || ladderY != targetY
            || !string.Equals(BuildMineEntryTargetId(shaft.NameOrUniqueName, ladderX, ladderY, MineLadderSelector), expectedTargetId, StringComparison.Ordinal))
            return new MineLadderTargetResolution(false, targetX, targetY,
                $"target={expectedTargetId};tile={targetX},{targetY}");

        return new MineLadderTargetResolution(true, ladderX, ladderY, string.Empty);
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
        string executionId = this.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        if (slot < 0 || slot >= player.Items.Count || player.CurrentToolIndex != slot || player.Items[slot] is not Raft raft || !ReferenceEquals(player.CurrentTool, raft))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_not_equipped_in_requested_slot", $"slot={slot}");
        if (!location.isWaterTile(targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_not_water", $"tile={targetX},{targetY}");
        // 5.2: the water tile is on the map the actor is standing on and the shore beside it is walkable, so out of the
        // native radius means walk to the shore and launch, rather than refuse.
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "use_raft", location, targetX, targetY, BuildRaftTargetId(location, targetX, targetY),
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteUseRaft(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY), nowMs, requestedDeadlineMs);

        return this.ExecuteUseRaft(executionId, requestId, slot, targetX, targetY);
    }

    /// <summary>
    /// Launches the raft at the named water tile. Reached both in range and on arrival: the slot, the raft in it and
    /// the tile's water property are re-read because the walk takes ticks and the actor can be holding something else
    /// by the end of it.
    /// </summary>
    private LocalExecutionReceipt ExecuteUseRaft(string executionId, string requestId, int slot, int targetX, int targetY)
    {
        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;
        if (slot < 0 || slot >= player.Items.Count || player.CurrentToolIndex != slot || player.Items[slot] is not Raft raft || !ReferenceEquals(player.CurrentTool, raft))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_not_equipped_in_requested_slot", $"slot={slot}");
        if (!location.isWaterTile(targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_not_water", $"tile={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_out_of_range",
                $"tile={targetX},{targetY};actor_tile={player.TilePoint.X},{player.TilePoint.Y};reach=1;approach=did_not_arrive");

        float staminaBefore = player.Stamina;
        bool raftingBefore = player.isRafting;
        raft.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 1, player);
        bool launched = !raftingBefore && player.isRafting;
        if (!launched && player.Stamina != staminaBefore)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "raft_launch_postcondition_unavailable", $"tile={targetX},{targetY};is_rafting={player.isRafting.ToString().ToLowerInvariant()};stamina_changed=true");
        return this.RememberTerminal(requestId, executionId, launched ? ExecutionState.Succeeded : ExecutionState.Rejected,
            launched ? "raft_launched" : "raft_launch_not_started",
            $"tile={targetX},{targetY};is_rafting={player.isRafting.ToString().ToLowerInvariant()};stamina_before={staminaBefore:0.####};stamina_after={player.Stamina:0.####}");
    }

    /// <summary>One live ladder tile, or <c>Accepted=false</c> with the request's own tiles and the id it named.</summary>
    private sealed record MineLadderTargetResolution(bool Accepted, int TileX, int TileY, string Evidence);

    /// <summary>One live mine entrance, with the level its own Action string declares.</summary>
    private sealed record MineEntranceTargetResolution(bool Accepted, int TileX, int TileY, int DeclaredLevel, string Evidence);

}
