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

    private static IReadOnlyList<BridgeMineEntranceTarget> DiscoverMineEntranceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null || location is MineShaft) return Array.Empty<BridgeMineEntranceTarget>();
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<BridgeMineEntranceTarget> result = new();
        for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= Math.Min(width - 1, player.TilePoint.X + TargetDiscoveryRadius); x++)
        for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= Math.Min(height - 1, player.TilePoint.Y + TargetDiscoveryRadius); y++)
        {
            string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
            if (action is null || !string.Equals(action.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(), "Mine", StringComparison.Ordinal))
                continue;
            result.Add(new BridgeMineEntranceTarget(BuildMineEntranceTargetId(location, x, y), x, y));
            if (result.Count == 16) return result;
        }
        return result;
    }

    private static string BuildMineEntranceTargetId(GameLocation location, int x, int y) =>
        $"mine_entrance_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}:Mine"))).ToLowerInvariant()[..16]}";

    private static IReadOnlyList<BridgeMineLampTarget> DiscoverMineLampTargets(Farmer player)
    {
        if (player.currentLocation is not MineShaft mine || mine.map is null) return Array.Empty<BridgeMineLampTarget>();
        int width = mine.map.Layers[0].LayerWidth;
        int height = mine.map.Layers[0].LayerHeight;
        List<BridgeMineLampTarget> result = new();
        for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= Math.Min(width - 1, player.TilePoint.X + TargetDiscoveryRadius); x++)
        for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= Math.Min(height - 1, player.TilePoint.Y + TargetDiscoveryRadius); y++)
        {
            string? action = mine.doesTileHaveProperty(x, y, "Action", "Buildings");
            if (action is null || !string.Equals(action.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(), "Lamp", StringComparison.Ordinal))
                continue;
            result.Add(new BridgeMineLampTarget(BuildMineLampTargetId(mine, x, y), x, y, LightLevel: 0f));
            if (result.Count == 16) return result;
        }
        return result;
    }

    private static string BuildMineLampTargetId(GameLocation location, int x, int y) =>
        $"mine_lamp_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}:Lamp"))).ToLowerInvariant()[..16]}";

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
        if (location is MineShaft) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "already_in_mine", null);
        string? action = location.doesTileHaveProperty(targetX, targetY, "Action", "Buildings");
        if (!string.Equals(BuildMineEntranceTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal)
            || action is null
            || !string.Equals(action.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(), "Mine", StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_target_unavailable", $"tile={targetX},{targetY}");
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_entrance_out_of_range", $"tile={targetX},{targetY}");
        int nextLevel = Math.Max(1, Game1.player.deepestMineLevel + 1);
        // Enter through the public native entry (the M8-frozen seam); the tile
        // check above already proved this really is a mine entrance.
        Game1.enterMine(nextLevel);
        if (Game1.player.currentLocation is MineShaft mine && Game1.player.TilePoint == new Point(6, 6) && mine.mineLevel == nextLevel)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_entered", $"level={mine.mineLevel};tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");
        LocalTravelSpec specification = new(executionId, requestId, "enter_mine", location.NameOrUniqueName, targetX, targetY, MineShaft.GetLevelName(nextLevel), 6, 6, this.revision, requestedDeadlineMs);
        this.activeTravel = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "mine_entry_pending", this.revision, $"source={location.NameOrUniqueName}:{targetX},{targetY};target={specification.TargetLocation}:6,6;level={nextLevel}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    public LocalExecutionReceipt RequestLocalToggleMineLamp(string requestId, int targetX, int targetY, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = this.NewExecutionId(requestId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        if (Game1.player.currentLocation is not MineShaft mine)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_lamp_location_required", null);
        string? action = mine.doesTileHaveProperty(targetX, targetY, "Action", "Buildings");
        if (action is null || !string.Equals(action.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(), "Lamp", StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_lamp_target_unavailable", $"tile={targetX},{targetY}");
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_lamp_out_of_range", $"tile={targetX},{targetY}");
        if (!mine.performAction(action, Game1.player, new xTile.Dimensions.Location(targetX, targetY)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mine_lamp_action_not_handled", $"tile={targetX},{targetY}");
        // lightLevel is protected on GameLocation; the native Lamp case flips it
        // internally, so success is the performAction acknowledgement.
        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mine_lamp_toggled",
            $"tile={targetX},{targetY};action={action};handled=true");
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
