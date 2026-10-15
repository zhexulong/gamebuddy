using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
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
//
// Shared-container contention: a chest and the fridge are world objects more than one player
// can reach at once, so both bodies read the container's own native lock (Chest.GetMutex(), the
// same NetMutex the vanilla menu path acquires while a player has it open) immediately before
// the write and refuse BY NAME (`container_in_use`) when another player already holds it. The
// shared admission serialises only THIS actor's body; it cannot see the other player's hands.
// See ContainerContentionRefusal.
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
        // 5.2: out of the native radius, walk in rather than refuse. The item and the
        // container are resolved above; both are re-resolved after the walk inside the
        // closure, because the walk takes several ticks and either can change.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "chest_store",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteChestStore(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteChestStore(executionId, requestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId);
    }

    /// <summary>
    /// Executes chest_store against the current world, re-resolving the item, the
    /// container and the target identity because an approach leg may have taken several
    /// ticks. Shared by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteChestStore(string executionId, string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId)
    {
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
        // Another player's open container outranks this actor's hands: the shared admission can
        // only see that THIS body is free, so the container's own native lock is the authority on
        // whether its inventory is already in use.
        if (ReadContainerContentionRefusal(chest) is string contentionRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, contentionRefusal, $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};container={(container.IsFridge ? "fridge" : "chest")};lock=held_by_other_player");

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

        GameLocation location = Game1.player.currentLocation;
        (StardewValley.Objects.Chest Chest, bool IsFridge)? resolved = ResolveStorageContainerAt(location, targetX, targetY);
        if (resolved is not { } container)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_not_owned", $"target={targetX},{targetY}");
        Chest chest = container.Chest;
        if (!string.Equals(BuildContainerTargetId(location, targetX, targetY, chest, container.IsFridge), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_target_changed", $"target={targetX},{targetY}");
        // 5.2: out of the native radius, walk in rather than refuse. The container is
        // resolved above; it and the stored item are re-resolved after the walk inside
        // the closure, because the walk takes several ticks and either can change.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "chest_retrieve",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteChestRetrieve(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteChestRetrieve(executionId, requestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId);
    }

    /// <summary>
    /// Executes chest_retrieve against the current world, re-resolving the container
    /// and the stored item because an approach leg may have taken several ticks. Shared
    /// by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteChestRetrieve(string executionId, string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId)
    {
        _ = slot;
        GameLocation location = Game1.player.currentLocation;
        (StardewValley.Objects.Chest Chest, bool IsFridge)? resolved = ResolveStorageContainerAt(location, targetX, targetY);
        if (resolved is not { } container)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_not_owned", $"target={targetX},{targetY}");
        Chest chest = container.Chest;
        if (!string.Equals(BuildContainerTargetId(location, targetX, targetY, chest, container.IsFridge), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_target_changed", $"target={targetX},{targetY}");
        // Same contention ruling as chest_store: the container is resolved here too, and the
        // native lock is the only thing that can say another player already has it open.
        if (ReadContainerContentionRefusal(chest) is string contentionRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, contentionRefusal, $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};container={(container.IsFridge ? "fridge" : "chest")};lock=held_by_other_player");

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
        // An unaccepted remainder means the player inventory could not take the whole stack. Returning
        // it to the same chest keeps the item in the world instead of letting the reference fall out of
        // scope; `retrieved` still requires leftover is null, so a rolled-back attempt stays Uncertain.
        bool leftoverReturned = false;
        if (leftover is not null && leftover.Stack > 0)
        {
            chest.addItem(leftover);
            leftoverReturned = true;
        }
        bool menuAfter = Game1.activeClickableMenu is not null;

        int chestStackAfter = ChestItemCount(chest, expectedQualifiedItemId);
        int inventoryAfter = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        bool retrieved = leftover is null && chestStackAfter == chestStackBefore - target.Stack && inventoryAfter == inventoryBefore + target.Stack;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};container={(container.IsFridge ? "fridge" : "chest")};item={expectedQualifiedItemId};chest_stack_before={chestStackBefore};chest_stack_after={chestStackAfter};inventory_before={inventoryBefore};inventory_after={inventoryAfter};leftover_returned={leftoverReturned.ToString().ToLowerInvariant()};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, retrieved ? ExecutionState.Succeeded : ExecutionState.Uncertain, retrieved ? "chest_retrieved" : "chest_retrieve_postcondition_unavailable", evidence);
    }

    private static int ChestItemCount(Chest chest, string qualifiedItemId) =>
        chest.GetItemsForPlayer().Where(item => item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)).Sum(item => item.Stack);

    /// <summary>
    /// The named refusal for a storage container ANOTHER player already has open. A placed
    /// chest and the kitchen fridge are world objects more than one player can reach at once,
    /// and the shared admission only ever serialises THIS actor's body: it can see that the
    /// actor is idle, never that another player's hands are already in the container.
    /// </summary>
    internal const string ContainerInUse = "container_in_use";

    /// <summary>
    /// The container-contention ruling: null when the acting player may use the container,
    /// otherwise the named refusal. The facts/decision split <see cref="WorldModel"/> uses, so
    /// the ruling is pinnable without a live game thread. <paramref name="locked"/> is the
    /// native lock's "somebody owns this container" reading and <paramref name="heldLocally"/> is
    /// "that somebody is the acting player". A LOCALLY held lock is the actor's own open
    /// container UI, which the shared admission's non-Modal profiles already refuse as a hold,
    /// so only a lock owned by another player is contention.
    /// </summary>
    internal static string? ContainerContentionRefusal(bool locked, bool heldLocally) =>
        locked && !heldLocally ? ContainerInUse : null;

    /// <summary>
    /// Reads that ruling off one live container. <c>Chest.GetMutex()</c> is the game's own
    /// cross-player container lock (<see cref="NetMutex"/>): the vanilla menu path acquires it
    /// while a player has the container open (<c>Chest.checkForAction</c> -
    /// <c>GetMutex().RequestLock</c>), and the net-synced owner makes that hold visible on every
    /// client. A menu-free write that ignored it would race the incumbent's open menu over the
    /// same inventory. Only containers <see cref="IsOwnedOrdinaryChest"/> admits reach this - no
    /// <c>GlobalInventoryId</c>, no special chest type - so <c>GetMutex()</c> is the chest's own
    /// field and mints no team mutex as a side effect.
    /// </summary>
    private static string? ReadContainerContentionRefusal(Chest chest)
    {
        NetMutex mutex = chest.GetMutex();
        return ContainerContentionRefusal(mutex.IsLocked(), mutex.IsLockHeld());
    }
}
