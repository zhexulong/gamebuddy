using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// ExecutionManager game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    /// <summary>Published native forage pickup. The native location action owns inventory and object removal.</summary>
    public LocalExecutionReceipt RequestLocalPickupForage(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? forage) || !forage.isForage())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_not_available", $"target={targetX},{targetY}");
        if (!string.Equals(forage.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || !string.Equals(BuildForageTargetId(location, targetX, targetY, forage), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_changed", $"target={targetX},{targetY}");
        if (!Game1.player.couldInventoryAcceptThisItem(forage))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={targetX},{targetY}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        LocalForagePickupSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        // Preserve the target-version player action ingress. tryToCheckAt owns
        // the bridge-state/radius guards and SMAPI check-action hook before it
        // reaches GameLocation.checkAction; direct checkAction would bypass
        // those native player-path constraints.
        bool actionHandled = Game1.tryToCheckAt(tile, Game1.player);
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool removed = !location.objects.ContainsKey(tile);
        bool inventoryChanged = afterCount > beforeCount;
        ExecutionState state = actionHandled && removed && inventoryChanged ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "forage_picked_up" : "forage_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={targetX},{targetY};item={expectedQualifiedItemId};removed={removed};inventory_before={beforeCount};inventory_after={afterCount}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>
    /// Requests pickup through target-version Debris lifecycle. Ordinary debris
    /// has no click action: its own GameLocation update magnetizes it to an
    /// eligible nearby Farmer and calls Debris.collect. The bridge only waits
    /// for that native delivery; it never calls collect, removes chunks, or
    /// mutates inventory itself.
    /// </summary>
    public LocalExecutionReceipt RequestLocalPickupItem(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId ?? this.activeItemPickup?.ExecutionId);

        StardewValley.GameLocation location = Game1.player.currentLocation;
        (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = FindItemTarget(location, Game1.player, expectedTargetId, expectedQualifiedItemId, radius: 8);
        if (target is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"target={targetX},{targetY}");
        Point liveTargetTile = GetChunkTile(target.Value.Chunk);
        if (liveTargetTile.X != targetX || liveTargetTile.Y != targetY)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_moved", $"expected={targetX},{targetY};actual={liveTargetTile.X},{liveTargetTile.Y}");
        if (!Game1.player.couldInventoryAcceptThisItem(target.Value.Debris.item ?? ItemRegistry.Create(expectedQualifiedItemId, target.Value.Stack)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={expectedTargetId}");

        int beforeCount = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        // The body controller drives this native approach. Debris.updateChunks
        // owns magnetic delivery and Debris.collect on following game updates;
        // the bridge never calls collect or touches chunks/inventory directly.
        LocalMoveSpec approach = new(executionId, requestId, new Vector2(liveTargetTile.X, liveTargetTile.Y), true, this.revision, this.tick + deadlineTicks, requestedDeadlineMs);
        this.activeItemPickup = new LocalItemPickupSpec(executionId, requestId, location.NameOrUniqueName, liveTargetTile.X, liveTargetTile.Y, expectedTargetId, expectedQualifiedItemId, target.Value.Stack, beforeCount, this.revision, requestedDeadlineMs);
        this.active = approach;
        if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode))
        {
            this.active = null;
            this.activeItemPickup = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode, $"target={expectedTargetId};tile={targetX},{targetY}");
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};stack={target.Value.Stack};inventory_before={beforeCount};native_auto_collect=true");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

}
