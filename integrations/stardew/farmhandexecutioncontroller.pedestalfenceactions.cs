using System.Globalization;
using Microsoft.Xna.Framework;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalTakePedestalItem(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetPedestalTarget(location, targetX, targetY, expectedTargetId, out StardewValley.Objects.ItemPedestal? pedestal, out StardewValley.Object? item))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pedestal_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "take_pedestal_item", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteTakePedestalItem(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId, requestedDeadlineMs), nowMs, requestedDeadlineMs);
        return this.ExecuteTakePedestalItem(executionId, requestId, targetX, targetY, expectedTargetId, requestedDeadlineMs);
    }

    private LocalExecutionReceipt ExecuteTakePedestalItem(string executionId, string requestId, int targetX, int targetY, string expectedTargetId, long deadlineMs)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetPedestalTarget(location, targetX, targetY, expectedTargetId, out StardewValley.Objects.ItemPedestal? pedestal, out StardewValley.Object? item))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pedestal_target_changed", $"target={targetX},{targetY}");

        int inventoryBefore = CountQualifiedItem(Game1.player, item!.QualifiedItemId);
        LocalPedestalTakingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId,
            item!.QualifiedItemId, item.Stack, inventoryBefore, this.tick, deadlineMs);
        this.activePedestalTaking = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};phase=pending_native_mutex");
        this.Remember(accepted);
        this.AddTrace(accepted);
        try
        {
            _ = pedestal!.checkForAction(Game1.player);
        }
        catch
        {
            this.activePedestalTaking = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "pedestal_take_native_outcome_unknown",
                $"location={specification.Location};target={expectedTargetId};native_call_threw=true;never_retry=true");
        }
        return accepted;
    }

    private static bool TryGetPedestalTarget(GameLocation location, int x, int y, string expectedTargetId,
        out StardewValley.Objects.ItemPedestal? pedestal, out StardewValley.Object? item)
    {
        pedestal = null;
        item = null;
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            || placed is not StardewValley.Objects.ItemPedestal candidate
            || candidate.heldObject.Value is not StardewValley.Object held
            || !string.Equals(BuildPedestalTargetId(location, x, y, candidate, held), expectedTargetId, StringComparison.Ordinal))
            return false;
        pedestal = candidate;
        item = held;
        return true;
    }

    private static IReadOnlyList<BridgePedestalTarget> DiscoverPedestalTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePedestalTarget>();
        List<BridgePedestalTarget> result = new();
        foreach ((Vector2 tile, StardewValley.Object placed) in location.objects.Pairs)
        {
            if (placed is not StardewValley.Objects.ItemPedestal pedestal || pedestal.heldObject.Value is not StardewValley.Object held
                || (int)tile.X < 0 || (int)tile.X > 1000 || (int)tile.Y < 0 || (int)tile.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgePedestalTarget(BuildPedestalTargetId(location, (int)tile.X, (int)tile.Y, pedestal, held),
                location.NameOrUniqueName, (int)tile.X, (int)tile.Y, held.QualifiedItemId, held.Stack));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static string BuildPedestalTargetId(GameLocation location, int x, int y, StardewValley.Objects.ItemPedestal pedestal, StardewValley.Object held)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:pedestal:{held.QualifiedItemId}:{held.Stack}";
        return $"pedestal_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    public LocalExecutionReceipt RequestLocalToggleFenceGate(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetFenceGate(location, targetX, targetY, expectedTargetId, out StardewValley.Fence? fence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fence_gate_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "toggle_fence_gate", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteToggleFenceGate(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteToggleFenceGate(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteToggleFenceGate(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        GameLocation location = Game1.player.currentLocation;
        if (!TryGetFenceGate(location, targetX, targetY, expectedTargetId, out StardewValley.Fence? fence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fence_gate_target_changed", $"target={targetX},{targetY}");
        int before = fence!.gatePosition.Value;
        try
        {
            fence.toggleGate(Game1.player, open: before == 0);
        }
        catch
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "fence_gate_toggle_outcome_unknown",
                $"target={expectedTargetId};gate_position_before={before};native_call_threw=true;never_retry=true");
        }
        int after = fence.gatePosition.Value;
        bool succeeded = (before == 0 && after == 88) || (before == 88 && after == 0);
        string evidence = $"target={expectedTargetId};tile={targetX},{targetY};gate_position_before={before};gate_position_after={after};is_open={(after == 88).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            succeeded ? "fence_gate_toggled" : "fence_gate_postcondition_unavailable", evidence);
    }

    private static bool TryGetFenceGate(GameLocation location, int x, int y, string expectedTargetId, out StardewValley.Fence? fence)
    {
        fence = null;
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            || placed is not StardewValley.Fence candidate || !candidate.isGate.Value || candidate.getDrawSum() == 0
            || (candidate.gatePosition.Value != 0 && candidate.gatePosition.Value != 88)
            || !string.Equals(BuildFenceGateTargetId(location, x, y, candidate), expectedTargetId, StringComparison.Ordinal)) return false;
        fence = candidate;
        return true;
    }

    private static IReadOnlyList<BridgeFenceGateTarget> DiscoverFenceGateTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFenceGateTarget>();
        List<BridgeFenceGateTarget> result = new();
        foreach ((Vector2 tile, StardewValley.Object placed) in location.objects.Pairs)
        {
            if (placed is not StardewValley.Fence fence || !fence.isGate.Value || fence.getDrawSum() == 0 || (fence.gatePosition.Value != 0 && fence.gatePosition.Value != 88)
                || (int)tile.X < 0 || (int)tile.X > 1000 || (int)tile.Y < 0 || (int)tile.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeFenceGateTarget(BuildFenceGateTargetId(location, (int)tile.X, (int)tile.Y, fence), location.NameOrUniqueName,
                (int)tile.X, (int)tile.Y, fence.gatePosition.Value == 88));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static string BuildFenceGateTargetId(GameLocation location, int x, int y, StardewValley.Fence fence)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:fence_gate:{(fence.obsolete_whichType ?? 1)}";
        return $"fence_gate_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private void SettlePedestalTakingUncertain(string reasonCode, string? lifecycleReason = null)
    {
        if (this.activePedestalTaking is not LocalPedestalTakingSpec specification) return;
        this.activePedestalTaking = null;
        this.revision++;
        LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, reasonCode, this.revision,
            $"location={specification.Location};target={specification.TargetId};native_mutex_pending=true;never_retry=true;lifecycle_reason={lifecycleReason ?? "none"}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
    }
}
