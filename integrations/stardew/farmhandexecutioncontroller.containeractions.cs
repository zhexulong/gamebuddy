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
// directly, and the containers eligible are those `IsStorageContainer` admits
// (the one predicate the chest summary counts through too; it lives next to the
// Discover radar in farmhandexecutioncontroller.cs and is shared by the partial
// class).
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
// Shared-container contention: a chest and the fridge are world objects more than one player can reach at
// once, so both bodies TAKE the container's own native lock (Chest.GetMutex(), the same NetMutex the vanilla
// menu path acquires while a player has it open) and hold it across the write, releasing it in a `finally`.
// Reading that lock and then writing would answer only "is somebody else in there", and two actors can both
// answer "no" to that and then write the same inventory - an item-duplication or item-loss race. The shared
// admission serialises only THIS actor's body, so it is no substitute for the container's lock. The two ways
// of not getting the lock are named apart: `container_in_use` (another player holds it) and
// `container_lock_not_granted` (we asked, and the grant did not arrive in this tick). See TakeContainerLock.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalChestStore(string requestId, string chestId, string expectedQualifiedItemId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "chest_store", requestId, chestId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location =>
            {
                if (!TryFindCarriedStack(expectedQualifiedItemId, out _, out _))
                    return TileTargetGate.Refused(CarriedItemRefusal(expectedQualifiedItemId));
                StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
                return resolved.Resolved
                    ? TileTargetGate.Resolved(resolved.X, resolved.Y)
                    : TileTargetGate.Refused(new TileTargetRefusal(resolved.RefusalReasonCode!, $"target={chestId}"));
            },
            execute: (executionId, admittedRequestId) => this.ExecuteChestStore(executionId, admittedRequestId, chestId, expectedQualifiedItemId));

    private LocalExecutionReceipt ExecuteChestStore(string executionId, string requestId, string chestId, string expectedQualifiedItemId)
    {
        if (!TryFindCarriedStack(expectedQualifiedItemId, out int slot, out Item? storedItem) || storedItem is null)
        {
            TileTargetRefusal notCarried = CarriedItemRefusal(expectedQualifiedItemId);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, notCarried.ReasonCode, notCarried.Evidence);
        }

        GameLocation location = Game1.player.currentLocation;
        StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
        if (!resolved.Resolved)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolved.RefusalReasonCode!, $"target={chestId}");
        Chest chest = resolved.Chest!;
        int targetX = resolved.X;
        int targetY = resolved.Y;
        if (ReadContainerContentionRefusal(chest) is string contentionRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, contentionRefusal, $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};lock=held_by_other_player");
        if (TakeContainerLock(chest, location) is string lockRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, lockRefusal, $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};lock=not_granted");

        int playerStackBefore = storedItem.Stack;
        int chestStackBefore = ChestItemCount(chest, expectedQualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;
        Item? remaining;
        bool stored;
        int playerStackAfter;
        bool sourceConsumed;
        try
        {
            remaining = chest.addItem(storedItem);
            // Native Chest.grabItemFromInventory parity: Chest.addItem moves the
            // exact item reference into the chest inventory and never touches the
            // player. When the chest accepted the whole stack, the player slot must
            // release that same reference or the item exists in both inventories.
            stored = remaining is null || remaining.Stack <= 0;
            if (stored)
                Game1.player.removeItemFromInventory(storedItem);
            playerStackAfter = Game1.player.Items[slot] is Item remainingItem && ReferenceEquals(remainingItem, storedItem) ? storedItem.Stack : 0;
            sourceConsumed = Game1.player.Items[slot] is null || !ReferenceEquals(Game1.player.Items[slot], storedItem);
        }
        finally
        {
            chest.GetMutex().ReleaseLock();
        }
        bool menuAfter = Game1.activeClickableMenu is not null;

        int chestStackAfter = ChestItemCount(chest, expectedQualifiedItemId);
        bool postconditionHeld = stored && sourceConsumed && chestStackAfter == chestStackBefore + playerStackBefore;
        string evidence = $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};item={expectedQualifiedItemId};source_slot={slot};player_stack_before={playerStackBefore};player_stack_after={playerStackAfter};source_consumed={sourceConsumed.ToString().ToLowerInvariant()};chest_stack_before={chestStackBefore};chest_stack_after={chestStackAfter};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}";
        if (postconditionHeld)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "chest_stored", evidence);
        ExecutionState failureState = chestStackAfter != chestStackBefore ? ExecutionState.Uncertain : ExecutionState.Rejected;
        return this.RememberTerminal(requestId, executionId, failureState, "chest_full", evidence);
    }

    public LocalExecutionReceipt RequestLocalChestRetrieve(string requestId, string chestId, string expectedQualifiedItemId, long requestedDeadlineMs) =>
        this.RequestLocalTileTarget(
            "chest_retrieve", requestId, chestId, requestedDeadlineMs,
            AdmissionActionabilityProfile.General,
            authorize: null,
            gate: location =>
            {
                StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
                return resolved.Resolved
                    ? TileTargetGate.Resolved(resolved.X, resolved.Y)
                    : TileTargetGate.Refused(new TileTargetRefusal(resolved.RefusalReasonCode!, $"target={chestId}"));
            },
            execute: (executionId, admittedRequestId) => this.ExecuteChestRetrieve(executionId, admittedRequestId, chestId, expectedQualifiedItemId));

    private LocalExecutionReceipt ExecuteChestRetrieve(string executionId, string requestId, string chestId, string expectedQualifiedItemId)
    {
        GameLocation location = Game1.player.currentLocation;
        StorageContainerResolution resolved = ResolveStorageContainerById(location, chestId);
        if (!resolved.Resolved)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolved.RefusalReasonCode!, $"target={chestId}");
        Chest chest = resolved.Chest!;
        int targetX = resolved.X;
        int targetY = resolved.Y;
        if (ReadContainerContentionRefusal(chest) is string contentionRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, contentionRefusal, $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};lock=held_by_other_player");
        if (TakeContainerLock(chest, location) is string lockRefusal)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, lockRefusal, $"location={location.NameOrUniqueName};target={chestId};tile={targetX},{targetY};container={(resolved.IsFridge ? "fridge" : "chest")};lock=not_granted");

        try
        {
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
            return this.SettlePostcondition(requestId, executionId, retrieved, "chest_retrieved", "chest_retrieve_postcondition_unavailable", evidence);
        }
        finally
        {
            chest.GetMutex().ReleaseLock();
        }
    }

    /// <summary>
    /// THE PACK SIDE, ASKED IN TWO ANSWERS, because `chest_store` names an ITEM and no slot.
    ///
    /// <para>
    /// `item_not_owned` — the pack holds no stack of that item id at all. `carried=none` states the half that
    /// was asked, and no slot appears because the request named none.
    /// </para>
    /// <para>
    /// `item_slot_changed:&lt;slot&gt;` — the pack holds it, at the slot the receipt names, and something other
    /// than the id spelling in hand matched it. `TryFindCarriedStack` compares `QualifiedItemId` verbatim, so a
    /// request that spelled `390` for a stack the game records as `(O)390` found nothing and was answered
    /// `item_not_owned_in_slot` — a code about a SLOT, for a request that never named one, about an item she was
    /// holding (`round84`). The match here is the engine's own qualification
    /// (`ItemRegistry.QualifyItemId`), and the honest answer is where the item is rather than that she owns none.
    /// </para>
    /// <para>
    /// Both halves are one fact each, and neither is `item_not_owned_in_slot`: that code lives in the actions that
    /// NAME a slot (`load_building_chest`, `item_tile`, `equip`), where "the slot holds nothing" is what refused.
    /// </para>
    /// </summary>
    private static TileTargetRefusal CarriedItemRefusal(string expectedQualifiedItemId)
    {
        string wanted = ItemRegistry.QualifyItemId(expectedQualifiedItemId);
        for (int index = 0; index < Game1.player.Items.Count; index++)
        {
            if (Game1.player.Items[index] is not Item candidate || candidate.Stack <= 0)
                continue;
            if (string.Equals(ItemRegistry.QualifyItemId(candidate.QualifiedItemId), wanted, StringComparison.Ordinal))
                return new TileTargetRefusal($"item_slot_changed:{index}", $"item={expectedQualifiedItemId};carried={candidate.QualifiedItemId};slot={index}");
        }

        return new TileTargetRefusal("item_not_owned", $"item={expectedQualifiedItemId};carried=none");
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
    ///
    /// A container that IS there but whose contents are not this room's storage answers
    /// <c>container_not_storage</c>: the id matched, so "it moved" would be false, and the named limit
    /// lives in <see cref="IsStorageContainer"/> rather than being folded into the ownership refusal
    /// the previous revision used for every kind it could not open.
    /// </summary>
    internal static StorageContainerResolution ResolveStorageContainerById(StardewValley.GameLocation location, string chestId)
    {
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in LocationStorageContainers(location))
        {
            if (!string.Equals(BuildContainerTargetId(location, x, y, chest, isFridge), chestId, StringComparison.Ordinal))
                continue;
            if (!IsStorageContainer(chest))
                return new StorageContainerResolution(null, isFridge, x, y, ContainerNotStorage);
            return new StorageContainerResolution(chest, isFridge, x, y, null);
        }
        return new StorageContainerResolution(null, false, 0, 0, "chest_target_changed");
    }

    /// <summary>
    /// The named refusal for a container whose contents belong to another action's meaning - a mini shipping
    /// bin's sale goods, an enricher's fertilizer slot, an auto-loader's machine feed. Named apart from
    /// <c>chest_target_changed</c> because the container IS where the id says it is.
    /// </summary>
    internal const string ContainerNotStorage = "container_not_storage";

    private static IEnumerable<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> LocationStorageContainers(StardewValley.GameLocation location)
    {
        foreach (StardewValley.Object obj in location.objects.Values)
        {
            // The ONE chest predicate (`TryDescribePlacedChest`), so the container actions, the chest summary and the
            // colour family cannot answer "is this a chest" three ways.
            if (TryDescribePlacedChest(obj, out StardewValley.Objects.Chest? chest))
                yield return (chest!, (int)chest!.TileLocation.X, (int)chest.TileLocation.Y, false);
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

    internal static string? ContainerContentionRefusal(bool locked, bool heldLocally) =>
        locked && !heldLocally ? ContainerInUse : null;

    /// <summary>
    /// Reads that ruling off one live container. <c>Chest.GetMutex()</c> is the game's own
    /// cross-player container lock (<see cref="NetMutex"/>): the vanilla menu path acquires it
    /// while a player has the container open (<c>Chest.checkForAction</c> -
    /// <c>GetMutex().RequestLock</c>), and the net-synced owner makes that hold visible on every
    /// client. A menu-free write that ignored it would race the incumbent's open menu over the
    /// same inventory.
    ///
    /// What it locks travels with the container's own kind (`Chest.cs:744-755`): a chest with a
    /// <c>GlobalInventoryId</c> or a Junimo chest locks the inventory it shares with its kin, and every
    /// other kind locks its own field. Both are the lock the vanilla menu path would hold, so a Junimo
    /// chest open in another room is refused as contention instead of being written through.
    /// </summary>
    private static string? ReadContainerContentionRefusal(Chest chest)
    {
        NetMutex mutex = chest.GetMutex();
        return ContainerContentionRefusal(mutex.IsLocked(), mutex.IsLockHeld());
    }

    internal const string ContainerLockNotGranted = "container_lock_not_granted";

    /// <summary>
    /// Takes the container's own lock for one menu-free write, or answers the named refusal. The caller releases it in
    /// a <c>finally</c>.
    ///
    /// <para>
    /// <c>RequestLock</c> only RECORDS a request when the mutex is free: the lock is claimed when the net event is
    /// polled on the master (NetMutex.cs:34-41), and the acquired callback runs from <c>NetMutex.Update</c>
    /// (NetMutex.cs:83-99), which the engine calls once per tick from <c>Chest.updateWhenCurrentLocation</c>
    /// (Chest.cs:1075). Driving that same public method once is how the grant settles inside one receipt - the identical
    /// step the fish-tank and pedestal deposits drive around their own mutexes. On the host the claim and the callback
    /// both land inside that call. On a farmhand the request needs the host's round trip, which a receipt that settles
    /// inside one game tick cannot wait for, so the write is refused as
    /// <see cref="ContainerLockNotGranted"/> instead of being performed unlocked.
    /// </para>
    ///
    /// <para>
    /// A refused request is cancelled with <see cref="NetMutex.ReleaseLock"/> rather than left pending: a grant that
    /// arrives for a request nobody is waiting on would hold the container against the other players until the chest's
    /// own per-tick release ran (<c>Chest.updateWhenCurrentLocation</c>, Chest.cs:1132-1134).
    /// </para>
    ///
    /// <para>
    /// <see cref="ReadContainerContentionRefusal"/> answers the <see cref="ContainerInUse"/> case first, so this is
    /// reached with the mutex either free or already ours. The "already ours" state is the actor's own open container
    /// UI, which the shared admission's non-Modal profiles refuse as a hold before the body runs.
    /// </para>
    /// </summary>
    private static string? TakeContainerLock(Chest chest, GameLocation location)
    {
        NetMutex mutex = chest.GetMutex();
        bool granted = false;
        mutex.RequestLock(() => granted = true);
        if (!granted)
            mutex.Update(location);
        if (granted)
            return null;

        mutex.ReleaseLock();
        return ContainerLockNotGranted;
    }
}
