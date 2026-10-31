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
// CONTRACT: a container and an item, not a tile and a slot. Both actions take
// `chestId` + `expectedQualifiedItemId` and nothing else. The published
// container id already binds the location, the tile and the chest type, so a
// caller that also sent x/y would be keeping two spellings of one fact in sync;
// and a slot is perception (which stack the snapshot happened to row up), not
// intent. The tile is re-derived from the id here, on the game thread, and the
// item is re-resolved on its own side at execution time - so the safety slice
// is exactly as wide as before, it just no longer asks the caller to spell a
// fact the snapshot already published. `chest_store` takes the FIRST carried
// stack of that item id (the same "first stack whose id matches" the retrieve
// side has always used through GetItemsForPlayer()).
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
    public LocalExecutionReceipt RequestLocalChestStore(string requestId, string chestId, string expectedQualifiedItemId, long requestedDeadlineMs)
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
        if (!TryFindCarriedStack(expectedQualifiedItemId, out _, out _))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"item={expectedQualifiedItemId};carried=none");

        GameLocation location = Game1.player.currentLocation;
        StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
        if (!resolved.Resolved)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolved.RefusalReasonCode!, $"target={chestId}");
        // 5.2: out of the native radius, walk in rather than refuse. The item and the
        // container are resolved above; both are re-resolved after the walk inside the
        // closure, because the walk takes several ticks and either can change.
        if (!IsTileWithinChebyshevRadius(Game1.player, resolved.X, resolved.Y, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "chest_store",
                location,
                resolved.X,
                resolved.Y,
                chestId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteChestStore(arrivalExecutionId, arrivalRequestId, chestId, expectedQualifiedItemId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteChestStore(executionId, requestId, chestId, expectedQualifiedItemId);
    }

    /// <summary>
    /// Executes chest_store against the current world, re-resolving the item, the
    /// container and its tile because an approach leg may have taken several
    /// ticks. Shared by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteChestStore(string executionId, string requestId, string chestId, string expectedQualifiedItemId)
    {
        if (!TryFindCarriedStack(expectedQualifiedItemId, out int slot, out Item? storedItem) || storedItem is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"item={expectedQualifiedItemId};carried=none");

        GameLocation location = Game1.player.currentLocation;
        StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
        if (!resolved.Resolved)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolved.RefusalReasonCode!, $"target={chestId}");
        Chest chest = resolved.Chest!;
        int targetX = resolved.X;
        int targetY = resolved.Y;
        // Another player's open container outranks this actor's hands: the shared admission can
        // only see that THIS body is free, so the container's own native lock is the authority on
        // whether its inventory is already in use.
        if (ReadContainerContentionRefusal(chest) is string contentionRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, contentionRefusal, $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};lock=held_by_other_player");

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

        int playerStackAfter = Game1.player.Items[slot] is Item remainingItem && ReferenceEquals(remainingItem, storedItem) ? storedItem.Stack : 0;
        int chestStackAfter = ChestItemCount(chest, expectedQualifiedItemId);
        bool sourceConsumed = Game1.player.Items[slot] is null || !ReferenceEquals(Game1.player.Items[slot], storedItem);
        bool postconditionHeld = stored && sourceConsumed && chestStackAfter == chestStackBefore + playerStackBefore;
        string evidence = $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};item={expectedQualifiedItemId};source_slot={slot};player_stack_before={playerStackBefore};player_stack_after={playerStackAfter};source_consumed={sourceConsumed.ToString().ToLowerInvariant()};chest_stack_before={chestStackBefore};chest_stack_after={chestStackAfter};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        if (postconditionHeld)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "chest_stored", evidence);
        // A partial accept (some stack merged, remainder still held) mutated the
        // chest without consuming the source slot; never claim those as a clean
        // success or a clean rejection.
        ExecutionState failureState = chestStackAfter != chestStackBefore ? ExecutionState.Uncertain : ExecutionState.Rejected;
        return this.RememberTerminal(requestId, executionId, failureState, "chest_full", evidence);
    }

    public LocalExecutionReceipt RequestLocalChestRetrieve(string requestId, string chestId, string expectedQualifiedItemId, long requestedDeadlineMs)
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
        StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
        if (!resolved.Resolved)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolved.RefusalReasonCode!, $"target={chestId}");
        // 5.2: out of the native radius, walk in rather than refuse. The container is
        // resolved above; it and the stored item are re-resolved after the walk inside
        // the closure, because the walk takes several ticks and either can change.
        if (!IsTileWithinChebyshevRadius(Game1.player, resolved.X, resolved.Y, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "chest_retrieve",
                location,
                resolved.X,
                resolved.Y,
                chestId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteChestRetrieve(arrivalExecutionId, arrivalRequestId, chestId, expectedQualifiedItemId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteChestRetrieve(executionId, requestId, chestId, expectedQualifiedItemId);
    }

    /// <summary>
    /// Executes chest_retrieve against the current world, re-resolving the container
    /// and the stored item because an approach leg may have taken several ticks. Shared
    /// by the in-range path and the post-approach path.
    /// </summary>
    private LocalExecutionReceipt ExecuteChestRetrieve(string executionId, string requestId, string chestId, string expectedQualifiedItemId)
    {
        GameLocation location = Game1.player.currentLocation;
        StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
        if (!resolved.Resolved)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolved.RefusalReasonCode!, $"target={chestId}");
        Chest chest = resolved.Chest!;
        int targetX = resolved.X;
        int targetY = resolved.Y;
        // Same contention ruling as chest_store: the container is resolved here too, and the
        // native lock is the only thing that can say another player already has it open.
        if (ReadContainerContentionRefusal(chest) is string contentionRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, contentionRefusal, $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};lock=held_by_other_player");

        Item? target = chest.GetItemsForPlayer().FirstOrDefault(item => item is not null && string.Equals(item.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal) && item.Stack > 0);
        if (target is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chest_empty", $"target={chestId};item={expectedQualifiedItemId}");
        if (!Game1.player.couldInventoryAcceptThisItem(target))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={chestId};item={expectedQualifiedItemId}");

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
        string evidence = $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};item={expectedQualifiedItemId};chest_stack_before={chestStackBefore};chest_stack_after={chestStackAfter};inventory_before={inventoryBefore};inventory_after={inventoryAfter};leftover_returned={leftoverReturned.ToString().ToLowerInvariant()};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, retrieved ? ExecutionState.Succeeded : ExecutionState.Uncertain, retrieved ? "chest_retrieved" : "chest_retrieve_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The first carried stack of one item id: the pack side of the same rule
    /// <c>chest_retrieve</c> has always used on the container side
    /// (<c>GetItemsForPlayer().FirstOrDefault(...)</c>). Two carried stacks of one id are one
    /// address, which is why the descriptor has no `slot` argument to disagree with them; the
    /// chosen slot still travels in the evidence, so a reader can see which stack moved.
    ///
    /// The stack is an <see cref="Item"/>, not a <c>StardewValley.Object</c>, because the pair this
    /// predicate gates is <c>Chest.addItem(Item)</c> + <c>Farmer.removeItemFromInventory(Item)</c> and
    /// the container side of the same trade has always taken an <c>Item</c> out. Pinned to the
    /// narrower class, every <c>Tool</c>, <c>MeleeWeapon</c>, <c>Slingshot</c>, <c>Ring</c>, <c>Hat</c>,
    /// <c>Boots</c>, <c>Clothing</c> and <c>Furniture</c> was invisible here while <c>chest_retrieve</c>
    /// could still put one into the pack - a one-way door, refused by name as an item the actor could
    /// see in their own hands.
    /// </summary>
    private static bool TryFindCarriedStack(string expectedQualifiedItemId, out int slot, out Item? item)
    {
        for (int index = 0; index < Game1.player.Items.Count; index++)
        {
            if (Game1.player.Items[index] is not Item candidate || candidate.Stack <= 0)
                continue;
            if (!string.Equals(candidate.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
                continue;
            slot = index;
            item = candidate;
            return true;
        }
        slot = -1;
        item = null;
        return false;
    }

    /// <summary>
    /// One resolved storage container for a published container id, or the named reason that id
    /// no longer names a live eligible one. <see cref="X"/>/<see cref="Y"/> are the container's
    /// own tile, recovered from the id rather than from a second caller-supplied coordinate.
    /// </summary>
    internal readonly record struct StorageContainerResolution(
        StardewValley.Objects.Chest? Chest,
        bool IsFridge,
        int X,
        int Y,
        string? RefusalReasonCode)
    {
        internal bool Resolved => this.Chest is not null;
    }

    /// <summary>
    /// Re-derives the container one published id names, on the game thread.
    ///
    /// The id IS the whole address: <c>BuildContainerTargetId</c> binds the location, the tile and
    /// the chest type, so a match proves the same container still stands where the snapshot found
    /// it, and a container that was removed, moved or replaced by another chest type matches
    /// nothing and is refused as <c>chest_target_changed</c> rather than retargeted. Because the
    /// match is the identity check, there is no separate <c>expectedTargetId</c> comparison left to
    /// drift from it.
    ///
    /// Resolution deliberately carries NO discovery radius: the walk-in approach exists precisely so
    /// that a published container which has drifted out of the snapshot window is still reachable,
    /// and the one-tile interaction radius is measured after the tile is known.
    /// </summary>
    internal static StorageContainerResolution ResolveStorageContainerById(StardewValley.GameLocation location, string chestId)
    {
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in LocationStorageContainers(location))
        {
            if (!string.Equals(BuildContainerTargetId(location, x, y, chest, isFridge), chestId, StringComparison.Ordinal))
                continue;
            // The id matched, so this is the container that was published - it is only no longer one
            // this actor may open. A name of its own, rather than the staleness code above.
            if (!IsOwnedOrdinaryChest(chest))
                return new StorageContainerResolution(null, isFridge, x, y, "chest_not_owned");
            return new StorageContainerResolution(chest, isFridge, x, y, null);
        }
        return new StorageContainerResolution(null, false, 0, 0, "chest_target_changed");
    }

    /// <summary>
    /// Every storage container the current location holds, with the tile each one occupies: the
    /// chests in the object layer plus the room's built-in kitchen fridge, which never enters that
    /// layer. No eligibility and no radius filter - resolution asks "does this id still name a
    /// container" while discovery asks "which ones are published now", and folding the second
    /// question into the first would let the snapshot's row budget decide a refusal. Both read this
    /// one list (<see cref="DiscoverStorageContainers"/> filters it), so the container family has a
    /// single spelling.
    /// </summary>
    private static IEnumerable<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> LocationStorageContainers(StardewValley.GameLocation location)
    {
        foreach (StardewValley.Object obj in location.objects.Values)
        {
            if (obj is StardewValley.Objects.Chest chest)
                yield return (chest, (int)chest.TileLocation.X, (int)chest.TileLocation.Y, false);
        }
        if (KitchenFridgeTile(location) is { } fridgeTile && location.GetFridge() is { } fridge)
            yield return (fridge, (int)fridgeTile.X, (int)fridgeTile.Y, true);
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
    /// otherwise the named refusal. The facts/decision split <see cref="WorldModel"/> uses, so the
    /// ruling is pinnable without a live game thread. <paramref name="locked"/> is the
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
