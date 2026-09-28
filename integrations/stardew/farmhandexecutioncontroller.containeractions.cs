using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

// Lane B.2/B.3 container actions over the native Chest data seam.
// Seam decision (tools/stardew-chest-seam-probe.md): chest_store mirrors the
// native Chest.grabItemFromInventory sequence - Chest.addItem hands the exact
// item reference to the chest inventory, then the player slot releases that
// same reference through Farmer.removeItemFromInventory. Chest.addItem alone
// never touches the player, so omitting the release would duplicate the item.
// chest_retrieve removes the exact target item through
// GetItemsForPlayer().Remove + clearNulls and hands it to the native player
// inventory. Neither path mounts ItemGrabMenu, neither writes the NetList
// directly, and only player-owned ordinary Chests are eligible
// (IsOwnedOrdinaryChest / BuildChestTargetId live next to the Discover radar
// in farmhandexecutioncontroller.cs and are shared by the partial class).
//
// Target family: "storage container" is deliberately wider than "placed chest".
// The built-in kitchen fridge IS a Chest (FarmHouse.fridge / IslandFarmHouse.fridge
// are NetRef<Chest> built with playerChest: true), it serves the same store/take
// intent, and it resolves through GameLocation.GetFridge() + the room's map tile
// because it never enters location.objects. Both targets run the identical
// transaction, so only resolution and the opaque target id differ.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalChestStore(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object storedItem)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(storedItem.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot};expected={expectedQualifiedItemId}");

        GameLocation location = Game1.player.currentLocation;
        (StardewValley.Objects.Chest Chest, bool IsFridge)? resolved = ResolveStorageContainerAt(location, targetX, targetY);
        if (resolved is not { } container)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_not_owned", $"target={targetX},{targetY}");
        Chest chest = container.Chest;
        if (!string.Equals(BuildContainerTargetId(location, targetX, targetY, chest, container.IsFridge), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_target_changed", $"target={targetX},{targetY}");

        int playerStackBefore = storedItem.Stack;
        int chestStackBefore = ChestItemCount(chest, expectedQualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;
        Item? remaining = chest.addItem(storedItem);
        // Native Chest.grabItemFromInventory parity: Chest.addItem moves the
        // exact item reference into the chest inventory and never touches the
        // player. When the chest accepted the whole stack, the player slot must
        // release that same reference or the item exists in both inventories.
        bool stored = remaining is null || remaining.Stack <= 0;
        if (stored)
            Game1.player.removeItemFromInventory(storedItem);
        bool menuAfter = Game1.activeClickableMenu is not null;

        int playerStackAfter = Game1.player.Items[slot] is StardewValley.Object remainingItem && ReferenceEquals(remainingItem, storedItem) ? storedItem.Stack : 0;
        int chestStackAfter = ChestItemCount(chest, expectedQualifiedItemId);
        bool sourceConsumed = Game1.player.Items[slot] is null || !ReferenceEquals(Game1.player.Items[slot], storedItem);
        bool postconditionHeld = stored && sourceConsumed && chestStackAfter == chestStackBefore + playerStackBefore;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};container={(container.IsFridge ? "fridge" : "chest")};item={expectedQualifiedItemId};player_stack_before={playerStackBefore};player_stack_after={playerStackAfter};source_consumed={sourceConsumed.ToString().ToLowerInvariant()};chest_stack_before={chestStackBefore};chest_stack_after={chestStackAfter};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        if (postconditionHeld)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "chest_stored", evidence);
        // A partial accept (some stack merged, remainder still held) mutated the
        // chest without consuming the source slot; never claim those as a clean
        // success or a clean rejection.
        ExecutionState failureState = chestStackAfter != chestStackBefore ? ExecutionState.Uncertain : ExecutionState.Rejected;
        return this.RememberTerminal(requestId, executionId, failureState, "chest_full", evidence);
    }

    public LocalExecutionReceipt RequestLocalChestRetrieve(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        GameLocation location = Game1.player.currentLocation;
        (StardewValley.Objects.Chest Chest, bool IsFridge)? resolved = ResolveStorageContainerAt(location, targetX, targetY);
        if (resolved is not { } container)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_not_owned", $"target={targetX},{targetY}");
        Chest chest = container.Chest;
        if (!string.Equals(BuildContainerTargetId(location, targetX, targetY, chest, container.IsFridge), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_target_changed", $"target={targetX},{targetY}");

        Item? target = chest.GetItemsForPlayer().FirstOrDefault(item => item is not null && string.Equals(item.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal) && item.Stack > 0);
        if (target is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_empty", $"target={targetX},{targetY};item={expectedQualifiedItemId}");
        if (!Game1.player.couldInventoryAcceptThisItem(target))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={expectedTargetId};item={expectedQualifiedItemId}");

        int chestStackBefore = ChestItemCount(chest, expectedQualifiedItemId);
        int inventoryBefore = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;
        chest.GetItemsForPlayer().Remove(target);
        chest.clearNulls();
        Item? leftover = Game1.player.addItemToInventory(target);
        bool menuAfter = Game1.activeClickableMenu is not null;

        int chestStackAfter = ChestItemCount(chest, expectedQualifiedItemId);
        int inventoryAfter = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool retrieved = leftover is null && chestStackAfter == chestStackBefore - target.Stack && inventoryAfter == inventoryBefore + target.Stack;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};container={(container.IsFridge ? "fridge" : "chest")};item={expectedQualifiedItemId};chest_stack_before={chestStackBefore};chest_stack_after={chestStackAfter};inventory_before={inventoryBefore};inventory_after={inventoryAfter};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, retrieved ? ExecutionState.Succeeded : ExecutionState.Uncertain, retrieved ? "chest_retrieved" : "chest_retrieve_postcondition_unavailable", evidence);
    }

    private static int ChestItemCount(Chest chest, string qualifiedItemId) =>
        chest.GetItemsForPlayer().Where(item => item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)).Sum(item => item.Stack);
}
