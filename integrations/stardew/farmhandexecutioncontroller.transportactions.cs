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


    public LocalExecutionReceipt RequestLocalMountTransport(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = this.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        GameLocation location = Game1.player.currentLocation;
        Horse? horse = location.characters.OfType<Horse>().FirstOrDefault(candidate =>
            string.Equals(BuildHorseTargetId(location, candidate), expectedTargetId, StringComparison.Ordinal)
            && candidate.rider is null
            && !string.IsNullOrWhiteSpace(candidate.Name)
            && !string.Equals(candidate.Name, "Horse", StringComparison.Ordinal));
        if (horse is null) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_unavailable", $"target={expectedTargetId}");
        if ((int)horse.Tile.X != targetX || (int)horse.Tile.Y != targetY)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_moved", $"target={expectedTargetId};actual={(int)horse.Tile.X},{(int)horse.Tile.Y}");
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_target_out_of_range", $"target={expectedTargetId}");
        if (Game1.player.CurrentItem is StardewValley.Objects.Hat || Game1.player.CurrentItem?.QualifiedItemId == "(O)Carrot")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_interaction_item_interference", null);
        LocalMountTransportSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, horse.HorseId, requestedDeadlineMs);
        this.activeMountTransport = specification;
        bool handled = horse.checkAction(Game1.player, location);
        if (!handled)
        {
            this.activeMountTransport = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "horse_action_not_handled", $"target={expectedTargetId}");
        }
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "horse_mount_pending", this.revision, $"target={expectedTargetId};tile={targetX},{targetY};horse_id={horse.HorseId}");
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
        // the actor is already on, plus one) and never a client-supplied value; the
        // ladder itself is re-read from the live layer, so a stale coordinate or an
        // old target id cannot pick a level.
        if (location is MineShaft shaft)
        {
            if (!TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)
                || ladderX != targetX || ladderY != targetY
                || !string.Equals(BuildMineEntryTargetId(shaft.NameOrUniqueName, ladderX, ladderY, MineLadderSelector), expectedTargetId, StringComparison.Ordinal))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_ladder_target_unavailable",
                    $"target={expectedTargetId};tile={targetX},{targetY};ladder={ladderX},{ladderY};level={shaft.mineLevel}");
            if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_ladder_out_of_range", $"tile={targetX},{targetY};ladder={ladderX},{ladderY}");

            int descentLevel = shaft.mineLevel + 1;
            Game1.enterMine(descentLevel);
            if (Game1.player.currentLocation is MineShaft descended && descended.mineLevel == descentLevel)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={descended.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};from_level={shaft.mineLevel}");
            LocalTravelSpec descentSpecification = new(executionId, requestId, "enter_mine", shaft.NameOrUniqueName, ladderX, ladderY, MineShaft.GetLevelName(descentLevel), 6, 6, this.revision, requestedDeadlineMs);
            this.activeTravel = descentSpecification;
            LocalExecutionReceipt descentAccepted = new(executionId, requestId, ExecutionState.Accepted, "mine_entry_pending", this.revision, $"source={shaft.NameOrUniqueName}:{ladderX},{ladderY};target={descentSpecification.TargetLocation}:6,6;level={descentLevel}");
            this.Remember(descentAccepted);
            this.AddTrace(descentAccepted);
            return descentAccepted;
        }

        string? action = location.doesTileHaveProperty(targetX, targetY, "Action", "Buildings");
        if (action is null
            || !string.Equals(BuildMineEntryTargetId(location.NameOrUniqueName, targetX, targetY, MineEntranceSelector), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_target_unavailable", $"tile={targetX},{targetY}");
        // The entrance tile declares its own target level in the Action string.
        // This reads it exactly the way the native click path does
        // (GameLocation.performAction `case "Mine"`: ArgUtility.TryGetOptionalInt(
        // action, 1, out mineLevel, out error, 1, "int mineLevel") ->
        // Game1.enterMine(mineLevel), GameLocation.cs:9807-9816), so the entered
        // level is the facility's own declaration rather than a value derived from
        // the actor's progress. A malformed parameter is the same refusal the
        // native path produces (it logs an error and enters nothing).
        // NOTE (unverified): the shipped map data is xnb and cannot be read from
        // here, so which literal the live entrance declares is deliberately NOT
        // asserted: whatever the tile declares is what gets entered.
        string[] actionTokens = ArgUtility.SplitBySpace(action);
        if (!string.Equals(actionTokens.FirstOrDefault(), "Mine", StringComparison.Ordinal)
            || !ArgUtility.TryGetOptionalInt(actionTokens, 1, out int declaredLevel, out _, 1, "int mineLevel"))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_target_unavailable", $"tile={targetX},{targetY};action={action}");
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_out_of_range", $"tile={targetX},{targetY}");
        // Enter through the public native entry (the M8-frozen seam) with the
        // level this exact tile declares; the checks above already proved it is a
        // mine entrance and that its declared level is readable.
        Game1.enterMine(declaredLevel);
        // The native MineShaft layout repositions the farmer onto the level's
        // stairs, so the requested landing tile is not a legal postcondition;
        // reaching the declared level is (the travel-completion branch agrees).
        if (Game1.player.currentLocation is MineShaft mine && mine.mineLevel == declaredLevel)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={mine.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");
        LocalTravelSpec specification = new(executionId, requestId, "enter_mine", location.NameOrUniqueName, targetX, targetY, MineShaft.GetLevelName(declaredLevel), 6, 6, this.revision, requestedDeadlineMs);
        this.activeTravel = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "mine_entry_pending", this.revision, $"source={location.NameOrUniqueName}:{targetX},{targetY};target={specification.TargetLocation}:6,6;level={declaredLevel}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
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
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "raft_target_out_of_range", $"tile={targetX},{targetY}");

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

}
