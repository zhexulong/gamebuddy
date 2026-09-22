using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

// Lane B.2/B.3 container actions over the native Chest data seam.
// Seam decision (tools/stardew-chest-seam-probe.md): chest_store uses the
// menu-free Chest.addItem path; chest_retrieve removes the exact target item
// through GetItemsForPlayer().Remove + clearNulls and hands it to the native
// player inventory. Neither path mounts ItemGrabMenu, neither writes the
// NetList directly, and only player-owned ordinary Chests are eligible
// (IsOwnedOrdinaryChest / BuildChestTargetId live next to the Discover radar
// in farmhandexecutioncontroller.cs and are shared by the partial class).
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalChestStore(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object storedItem)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(storedItem.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot};expected={expectedQualifiedItemId}");

        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? chestObject)
            || chestObject is not Chest chest
            || !IsOwnedOrdinaryChest(chest)
            || !string.Equals(BuildChestTargetId(location, targetX, targetY, chest), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, chestObject is Chest eligible ? "chest_target_changed" : "chest_not_owned", $"target={targetX},{targetY}");

        int playerStackBefore = storedItem.Stack;
        int chestStackBefore = ChestItemCount(chest, expectedQualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;
        Item? remaining = chest.addItem(storedItem);
        bool menuAfter = Game1.activeClickableMenu is not null;

        int playerStackAfter = Game1.player.Items[slot] is StardewValley.Object remainingItem && ReferenceEquals(remainingItem, storedItem) ? storedItem.Stack : 0;
        int chestStackAfter = ChestItemCount(chest, expectedQualifiedItemId);
        bool sourceConsumed = Game1.player.Items[slot] is null || !ReferenceEquals(Game1.player.Items[slot], storedItem);
        bool stored = remaining is null || remaining.Stack <= 0;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};chest=chest;item={expectedQualifiedItemId};player_stack_before={playerStackBefore};player_stack_after={playerStackAfter};source_consumed={sourceConsumed.ToString().ToLowerInvariant()};chest_stack_before={chestStackBefore};chest_stack_after={chestStackAfter};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, stored ? ExecutionState.Succeeded : ExecutionState.Rejected, stored ? "chest_stored" : "chest_full", evidence);
    }

    private static int ChestItemCount(Chest chest, string qualifiedItemId) =>
        chest.GetItemsForPlayer().Where(item => item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)).Sum(item => item.Stack);
}
