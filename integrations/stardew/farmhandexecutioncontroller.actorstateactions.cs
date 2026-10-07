using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

// THE ACTOR'S OWN ATTACHMENT STATE — three actions whose subject is the farmer themselves:
// `equip_wearable` and `unequip_wearable` move one wearable between the backpack and one of the
// actor's own wearable BODY SLOTS, and `dismount_transport` ends the actor's own mounted state.
// None of them mutates a world tile, so each postcondition is an ACTOR fact and each target
// identity is a slot of the actor rather than a coordinate or a world object.
//
// THE SEAM, AND THE BRANCH EACH ONE TAKES.
//   * equip_wearable / unequip_wearable: `Farmer.Equip<TItem>(TItem newItem, NetRef<TItem> slot)`
//     (Farmer.cs:7050-7060) — public, UI-free, synchronous, and the method the native
//     InventoryPage click path itself ends in: `InventoryPage.receiveLeftClick` case
//     "Hat"/"Boots"/"Shirt"/"Pants" calls `Game1.player.Equip((Hat)item, Game1.player.hat)`
//     (InventoryPage.cs:304/336/359/381), the ring cases call `Equip((Ring)item, slot)` on the
//     left/right `NetRef<Ring>` (:316-321), and the shift-click quick-equip path repeats those
//     same calls (:457-501). That overload detaches both items (:7053-7054), runs
//     `oldItem.onUnequip` / `newItem.onEquip` for the local player (:7073-7082), marks the
//     equipment buffs dirty when either side carries buffs (:7084-7087) and writes the slot
//     through its callback (:7057). Everything else around the click — the cursor slot, the
//     menu, the sounds — is the UI's, not the capability's, so none of it is reproduced here.
//     `unequip_wearable` calls the SAME seam with `newItem: null`, which is the documented way
//     to just clear the slot (:7047: "or <c>null</c> to just unequip the old item").
//   * dismount_transport: `Horse.dismount(bool from_demolish = false)` (Horse.cs:508-530) —
//     public, UI-free, synchronous, and the TERMINAL of the native dismount. The interactive
//     branch is `Horse.checkAction`'s mounted half (Horse.cs:691-717): it stages the jump
//     animation and either returns into the tick-driven `Horse.update()` continuation
//     (:265-319, which finally calls `dismount()` at :318) or calls `dismount()` outright
//     (:715). Every non-interactive caller in the game calls the terminal directly —
//     `Game1.cs:5971` (26:00 sends the player home), `:5995` (passing out), `:9949-9993`
//     (warps), the multiplayer disconnect at `Client.cs:262`, and the obelisk force-dismount at
//     `GameLocation.cs:14791`. A bridge cannot drive a multi-tick animation, so this action IS
//     the terminal, called with the native DEFAULT `from_demolish: false`: the ordinary
//     dismount, which hands the horse back to the location when its stable is found (:514-517).
//
// WHAT THE NATIVE SEAMS READ, AND WHAT THIS ACTION THEREFORE REFUSES TO ASSUME.
//   * The wearable seams take the item and the slot's `NetRef` and read no menu, no cursor and
//     no held slot, so `slot` here is an ordinary backpack index and NOT the selected slot. (That
//     is the one place this pair differs from `dress_mannequin`, whose native branch reads
//     `who.ActiveObject` — Building.cs:764's rule — and therefore needs the held slot.)
//   * `dismount()` dereferences `rider` (:511) before anything else, so an unmounted actor would
//     be a null dereference rather than a no-op: `mount is not null` is admitted BEFORE the
//     call, as `dismount_transport_not_riding`. It also writes `RIDER.mount = null` — a
//     cross-actor write if the horse's `rider` were somebody else — so a horse whose rider is not
//     this actor is refused by name (`dismount_transport_rider_mismatch`) instead of silently
//     unmounting another player.
//
// ARGUMENTS. `equip_wearable` is exactly `{slot, expectedQualifiedItemId, expectedTargetId}`,
// `unequip_wearable` exactly `{slot, expectedTargetId}`, and `dismount_transport` carries NO
// arguments at all — its subject is the actor's own mount and its readiness is native state, the
// same rule `advance_day`/`dismiss_modal` follow. The protocol has no optional arguments and
// rejects a missing OR extra key, so "add a target id for safety" is not available here.
//   * `slot` is the backpack side of the move in both wearable actions: the SOURCE slot whose
//     item is put on (corroborated by `expectedQualifiedItemId`), and for unequip the DESTINATION
//     slot the removed wearable must land in. That asymmetry is what makes the native
//     `isInventoryFull()` refusal meaningful, and it is why unequip needs no item id: the item is
//     whatever the named body slot already holds.
//   * `expectedTargetId` is an opaque id per BODY SLOT of the actor, published by discovery as
//     `wearable_<body_slot>_<16 hex>`; see `BuildWearableTargetId`.
//
// THE IDENTITY BINDS THE STATE THE POSTCONDITION NEEDS. Both wearable postconditions are that
// the SLOT'S CONTENTS MOVE, so the id hashes the slot's current occupant: "the hat slot, which is
// currently empty" and "the hat slot, which currently holds (H)0" are two different targets, and a
// request naming a body slot whose occupant moved since discovery is refused
// (`wearable_target_changed`) rather than silently swapping the wrong item out. The body slot is
// the id's readable segment so a stale id can still be attributed to the slot it names; the
// state is the hashed half, so it cannot be forged from the outside.
//   * The already-satisfied check runs BEFORE the staleness check, on purpose, because a repeat
//     of a satisfied request is by construction a request whose id describes the PREVIOUS state:
//     a repeat that arrives after the action already happened reports `wearable_already_equipped`
//     / `wearable_already_unequipped` as a SUCCESS with `moved=false`, instead of failing on the
//     state change the action itself caused.
//   * `unequip_wearable`'s already-satisfied check also precedes its `isInventoryFull()` refusal:
//     an already empty slot moves nothing, so nothing can drop on the ground.
//
// THE DISPOSITION OF THE MOVED ITEM, stated where a reader needs it. The native flow parks the
// displaced item in the CURSOR slot and lets the menu's exit path push it into the pack, dropping
// it on the ground when there is no room (`InventoryPage.exitThisMenu` line 895-899:
// `setHeldItem(Game1.player.addItemToInventory(takeHeldItem()))` then `createItemDebris`). A
// headless bridge has no cursor slot, so:
//   * equip takes the new item out of `slot` and puts the previously worn item INTO that same
//     slot — the exact slot the new item came from, which is how the native swap reads to the
//     player. The seam is called BEFORE the pack is touched, so a throwing native call cannot
//     lose the item: the pack still holds it and the receipt reports the observed occupant.
//   * unequip requires a named, EMPTY destination slot and refuses when `who.isInventoryFull()`
//     (the frozen rule for this action) or when the destination is occupied
//     (`wearable_destination_slot_occupied`). Writing into an occupied destination would displace
//     an item the request never named — the `Util.addItemToInventory(item, position, items)` swap —
//     and dropping it is exactly the silent loss this action must not produce.
//
// POSTCONDITIONS, OBSERVED. No native return value is evidence here: `dismount()` is `void`, and
// `Equip`'s return is the displaced item, which says nothing about whether the act happened. Every
// receipt re-reads the world after the call:
//   * equip: the named body slot now holds the requested item (`occupant_after`), re-read through
//     `TryReadWearableBodySlot`, i.e. `Farmer.hat/boots/shirtItem/pantsItem/leftRing/rightRing` —
//     what the game really holds. There is no `goingToEquip`/`goingToUnequip` field in this game
//     build (`grep` over the decompiled Farmer finds none), so the slot's own item is the fact.
//   * unequip: the named body slot is empty AND the named destination slot holds the removed item
//     (`ReferenceEquals` to the item the seam returned).
//   * dismount: `!who.isRidingHorse()` — the frozen fact — plus `who.mount is null`, the field
//     `dismount()` writes first (:511) and the one `isRidingHorse()` reads (Farmer.cs:2716-2723).
//
// ONE NATIVE CONSEQUENCE OF CALLING THE TERMINAL DIRECTLY, named rather than left to be found
// later: `dismount()` adds `rider.TemporaryPassableTiles` for `dismountTile` (:519), and
// `dismountTile` is a private field only the animation sets (:711). Called as the terminal it is
// still (0,0), so exactly one 64x64 tile at the map ORIGIN becomes temporarily passable —
// `BoundingBoxGroup` holds individual rectangles, not a union (BoundingBoxGroup.cs:35-41), so no
// other tile is affected, and the group is cleared by the mount path (Horse.cs:694) and by the
// warp/knockback paths (GameLocation.cs:3725/3857/3915). The receipt reports the flag so the
// consequence is visible instead of inferred.
//
// LIFECYCLE. All three are registered in `FarmhandActionCatalog` as
// `FarmhandActionLifecycle.Experimental` (equip_wearable/unequip_wearable in family `body_tools`,
// handler group ResourceTools; dismount_transport in family `animal_transport`, handler group
// Movement), so they stay off the default Agent surface until each passes its own native-local
// live gate; the promotion to LiveVerified is a separate catalog edit owned by the parent.
//
// FAILURE MODES, each with its own terminal code. equip_wearable: an id that names no body slot of
// this actor (`wearable_target_not_found`), a body slot whose occupant moved since discovery
// (`wearable_target_changed`), an out-of-range or empty source slot (`item_not_owned_in_slot`), a
// source slot holding a different item (`wearable_item_mismatch`), a source item that is not
// wearable at all (`wearable_item_not_wearable`), a wearable aimed at the wrong body slot
// (`wearable_body_slot_mismatch`), the native call throwing (`wearable_native_exception`), the
// call completing without the slot holding the item (`wearable_postcondition_unavailable`),
// already satisfied (`wearable_already_equipped`), and success (`wearable_equipped`).
// unequip_wearable: the same target codes, a FULL BACKPACK (`wearable_inventory_full`, the frozen
// refusal), an out-of-range destination (`wearable_destination_slot_invalid`), a destination that
// is not free (`wearable_destination_slot_occupied`), the native call throwing
// (`wearable_native_exception`), the world not showing the move
// (`wearable_postcondition_unavailable`), already satisfied (`wearable_already_unequipped`), and
// success (`wearable_unequipped`).
// dismount_transport: an unmounted actor (`dismount_transport_not_riding`), a horse ridden by
// somebody else (`dismount_transport_rider_mismatch`), the native call throwing
// (`dismount_transport_native_exception`), the world still showing a mount
// (`dismount_transport_postcondition_unavailable`), and success (`transport_dismounted`).
internal sealed partial class ExecutionManager
{
    /// <summary>The actor's own wearable body slots, in discovery order.</summary>
    internal static readonly string[] WearableBodySlots = { "hat", "boots", "shirt", "pants", "left_ring", "right_ring" };

    /// <summary>
    /// Equips one wearable the actor already owns into their own named body slot. See the file
    /// header for the seam, the argument meanings, the identity rule and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalEquipWearable(
        string requestId,
        int slot,
        string expectedQualifiedItemId,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: the seam is one instantaneous native slot write, no tool
        // lifecycle, no swing, no menu — the same profile `talk_to_npc` and `toggle_tool_light`
        // admit through.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        if (!TryParseWearableBodySlot(expectedTargetId, out string bodySlot))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_target_not_found",
                $"published={expectedTargetId};body_slots={string.Join("|", WearableBodySlots)}");

        string identity = $"body_slot={bodySlot};source_slot={slot};requested={expectedQualifiedItemId}";

        // The already-satisfied path comes FIRST: the actor already wears the requested item, so
        // the postcondition holds whatever the pack holds and whatever state the id was minted
        // against. A repeat of a satisfied request must land here, not on an error.
        TryReadWearableBodySlot(player, bodySlot, out Item? occupantBefore);
        if (occupantBefore is not null && string.Equals(occupantBefore.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Succeeded,
                "wearable_already_equipped",
                $"{identity};occupant={occupantBefore.QualifiedItemId};moved=false");

        string liveTargetId = BuildWearableTargetId(player, bodySlot);
        if (!string.Equals(liveTargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_target_changed",
                $"{identity};published={expectedTargetId};live={liveTargetId};occupant_before={DescribeWearableOccupant(occupantBefore)}");

        if (slot < 0 || slot >= player.Items.Count || player.Items[slot] is not Item source)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "item_not_owned_in_slot",
                $"{identity};inventory_slots={player.Items.Count};slot_item=none");
        if (!string.Equals(source.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_item_mismatch",
                $"{identity};slot_item={source.QualifiedItemId}");
        if (!IsWearableItem(source))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_item_not_wearable",
                $"{identity};slot_item={source.QualifiedItemId};item_type={source.GetType().Name}");
        if (!IsWearableForBodySlot(source, bodySlot))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_body_slot_mismatch",
                $"{identity};slot_item={source.QualifiedItemId};item_type={source.GetType().Name}");

        // THE SEAM, called before the backpack is touched: if it throws, the item is still in the
        // pack and the receipt can say so instead of reporting a loss.
        Item? displaced;
        try
        {
            displaced = EquipIntoWearableBodySlot(player, bodySlot, source);
        }
        catch (Exception nativeException)
        {
            TryReadWearableBodySlot(player, bodySlot, out Item? occupantAfterThrow);
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "wearable_native_exception",
                $"{identity};occupant_before={DescribeWearableOccupant(occupantBefore)};occupant_after={DescribeWearableOccupant(occupantAfterThrow)};"
                + $"pack_slot_untouched={PackSlotHolds(player, slot, expectedQualifiedItemId).ToString().ToLowerInvariant()};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // The item left the pack when it was worn (the native click path takes it out of the
        // inventory through the cursor slot), and the displaced item takes its place: the slot the
        // new item came from is exactly where a player sees the swap land.
        player.Items[slot] = displaced;

        TryReadWearableBodySlot(player, bodySlot, out Item? occupantAfter);
        bool equipped = occupantAfter is not null
            && string.Equals(occupantAfter.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal);
        string evidence =
            $"{identity};occupant_before={DescribeWearableOccupant(occupantBefore)};occupant_after={DescribeWearableOccupant(occupantAfter)};"
            + $"displaced={displaced?.QualifiedItemId ?? "none"};pack_slot_after={player.Items[slot]?.QualifiedItemId ?? "none"}";
        return equipped
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "wearable_equipped", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "wearable_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Removes the wearable the actor wears in their own named body slot into a named EMPTY
    /// backpack slot. See the file header for the seam, the destination rule, the frozen
    /// inventory-full refusal and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalUnequipWearable(
        string requestId,
        int slot,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        if (!TryParseWearableBodySlot(expectedTargetId, out string bodySlot))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_target_not_found",
                $"published={expectedTargetId};body_slots={string.Join("|", WearableBodySlots)}");

        string identity = $"body_slot={bodySlot};destination_slot={slot}";

        // Already satisfied, and therefore FIRST: the slot is empty, nothing will move, and no
        // item can reach the ground — so the inventory-full refusal below cannot apply.
        TryReadWearableBodySlot(player, bodySlot, out Item? occupantBefore);
        if (occupantBefore is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Succeeded,
                "wearable_already_unequipped",
                $"{identity};occupant=none;moved=false");

        string liveTargetId = BuildWearableTargetId(player, bodySlot);
        if (!string.Equals(liveTargetId, expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_target_changed",
                $"{identity};published={expectedTargetId};live={liveTargetId};occupant_before={DescribeWearableOccupant(occupantBefore)}");

        // THE FROZEN REFUSAL, checked before the destination is even looked at: with no free
        // backpack slot the removed wearable has nowhere to land, and the native exit-menu path
        // would drop it on the ground (`InventoryPage.exitThisMenu` :895-899). Refusing is the
        // only honest outcome; a receipt reporting success here would be reporting a lost item.
        int freeSlots = FreeInventorySlots(player);
        if (player.isInventoryFull())
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_inventory_full",
                $"{identity};occupant_before={DescribeWearableOccupant(occupantBefore)};inventory_full=true;free_inventory_slots={freeSlots};inventory_slots={player.Items.Count}");

        if (slot < 0 || slot >= player.Items.Count)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_destination_slot_invalid",
                $"{identity};inventory_slots={player.Items.Count}");
        if (player.Items[slot] is not null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_destination_slot_occupied",
                $"{identity};destination_item={player.Items[slot]!.QualifiedItemId};inventory_full=false;free_inventory_slots={freeSlots}");

        string? removedItemId = occupantBefore.QualifiedItemId;
        Item? removed;
        try
        {
            removed = UnequipFromWearableBodySlot(player, bodySlot);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "wearable_native_exception",
                $"{identity};occupant_before={DescribeWearableOccupant(occupantBefore)};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // The seam returned what it took off. A null here means the slot emptied between the
        // staleness check and the call (or was never the state the id named): report that rather
        // than writing a null into the destination and calling it a move.
        if (removed is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "wearable_target_changed",
                $"{identity};published={expectedTargetId};occupant_before={DescribeWearableOccupant(occupantBefore)};occupant_after=none;removed=none");

        player.Items[slot] = removed;
        TryReadWearableBodySlot(player, bodySlot, out Item? occupantAfter);
        Item? destinationAfter = 0 <= slot && slot < player.Items.Count ? player.Items[slot] : null;
        bool slotCleared = occupantAfter is null;
        bool landed = destinationAfter is not null && ReferenceEquals(destinationAfter, removed);
        string evidence =
            $"{identity};occupant_before={DescribeWearableOccupant(occupantBefore)};occupant_after={DescribeWearableOccupant(occupantAfter)};"
            + $"removed={removedItemId};destination_before=none;destination_after={destinationAfter?.QualifiedItemId ?? "none"};landed={landed.ToString().ToLowerInvariant()}";
        return slotCleared && landed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "wearable_unequipped", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "wearable_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Ends the actor's own mounted state through the native dismount terminal. See the file
    /// header for the seam, the two preconditions and the observed postcondition.
    /// </summary>
    public LocalExecutionReceipt RequestLocalDismountTransport(string requestId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: this seam drives no tool lifecycle and starts no swing — the
        // native callers are the clock, a pass-out, a warp and the obelisk.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        string location = player.currentLocation?.NameOrUniqueName ?? "unknown";
        if (player.mount is not Horse mount)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "dismount_transport_not_riding",
                $"mount=none;riding={player.isRidingHorse().ToString().ToLowerInvariant()};location={location};tile={player.TilePoint.X},{player.TilePoint.Y}");

        // `dismount()` writes RIDER.mount = null and dereferences that rider without checking it
        // (Horse.cs:511), so a horse whose rider is another actor is refused by name instead of
        // unmounting somebody else.
        if (!ReferenceEquals(mount.rider, player))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "dismount_transport_rider_mismatch",
                $"horse_id={mount.HorseId};rider={mount.rider?.Name ?? "none"};location={location}");

        bool ridingBefore = player.isRidingHorse();
        bool mountingBefore = mount.mounting.Value;
        string horseId = mount.HorseId.ToString();
        try
        {
            // THE SEAM, with the native DEFAULT from_demolish: false.
            mount.dismount();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "dismount_transport_native_exception",
                $"horse_id={horseId};location={location};riding_before={ridingBefore.ToString().ToLowerInvariant()};mount_after={(player.mount is not null).ToString().ToLowerInvariant()};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // Re-read the world AFTER the call. `mount` is what `dismount()` clears; `isRidingHorse()`
        // is the frozen postcondition (and is also false while an event is up, which admission has
        // already refused, so the two agree here).
        bool mountAfter = player.mount is not null;
        bool ridingAfter = player.isRidingHorse();
        string evidence =
            $"horse_id={horseId};location={location};tile={player.TilePoint.X},{player.TilePoint.Y};"
            + $"riding_before={ridingBefore.ToString().ToLowerInvariant()};mounting_before={mountingBefore.ToString().ToLowerInvariant()};"
            + $"riding_after={ridingAfter.ToString().ToLowerInvariant()};mount_after={mountAfter.ToString().ToLowerInvariant()}";
        return !mountAfter && !ridingAfter
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "transport_dismounted", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "dismount_transport_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The actor's own wearable body slots, projected read-only from live state. Every slot of the
    /// fixed set is published, empty or not, because an EMPTY slot is exactly the target an equip
    /// into a free slot names; the occupant fields say which are filled. Nothing is synthesized:
    /// the occupant is the item the game itself holds in that slot.
    /// </summary>
    internal static IReadOnlyList<BridgeWearableTarget> DiscoverWearableTargets(Farmer player)
    {
        List<BridgeWearableTarget> result = new(WearableBodySlots.Length);
        foreach (string bodySlot in WearableBodySlots)
        {
            if (!TryReadWearableBodySlot(player, bodySlot, out Item? occupant)) continue;
            result.Add(new BridgeWearableTarget(
                BuildWearableTargetId(player, bodySlot),
                bodySlot,
                occupant?.QualifiedItemId,
                occupant?.DisplayName));
        }
        return result;
    }

    /// <summary>
    /// The opaque id of one wearable body slot OF THIS ACTOR: the slot name plus a digest of the
    /// slot's current occupant. The slot name is readable so a stale id can still be attributed to
    /// the slot it names; the state is hashed so it cannot be forged. See the file header for why
    /// the occupant is part of the identity at all: the postcondition is that the slot's contents
    /// MOVE, so a request must name the state it expects to move away from.
    /// </summary>
    internal static string BuildWearableTargetId(Farmer player, string bodySlot)
    {
        TryReadWearableBodySlot(player, bodySlot, out Item? occupant);
        string occupantId = occupant?.QualifiedItemId ?? "empty";
        string raw = $"wearable:{bodySlot}:{occupantId}";
        return $"wearable_{bodySlot}_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Reads the body slot named by an opaque wearable target id, without trusting the id's
    /// digest: the readable segment is the slot name and the digest is validated for shape only.
    /// The state half is checked separately against the live slot, so an id can never retarget a
    /// different slot than the one it names.
    /// </summary>
    internal static bool TryParseWearableBodySlot(string expectedTargetId, out string bodySlot)
    {
        bodySlot = string.Empty;
        if (string.IsNullOrEmpty(expectedTargetId)) return false;
        foreach (string candidate in WearableBodySlots)
        {
            string prefix = $"wearable_{candidate}_";
            if (!expectedTargetId.StartsWith(prefix, StringComparison.Ordinal)) continue;
            string digest = expectedTargetId[prefix.Length..];
            if (digest.Length != 16 || !digest.All(character => (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')))
                continue;
            bodySlot = candidate;
            return true;
        }
        return false;
    }

    /// <summary>
    /// The one place that answers "what does this body slot of this actor hold right now?", shared
    /// by discovery, admission, execution and the fixture so the product and its declared Given can
    /// never disagree about the state a request names. False means the name is not a wearable body
    /// slot at all — which is a different answer from "the slot is empty".
    /// </summary>
    internal static bool TryReadWearableBodySlot(Farmer player, string bodySlot, out Item? occupant)
    {
        occupant = null;
        switch (bodySlot)
        {
            case "hat": occupant = player.hat.Value; return true;
            case "boots": occupant = player.boots.Value; return true;
            case "shirt": occupant = player.shirtItem.Value; return true;
            case "pants": occupant = player.pantsItem.Value; return true;
            case "left_ring": occupant = player.leftRing.Value; return true;
            case "right_ring": occupant = player.rightRing.Value; return true;
            default: return false;
        }
    }

    /// <summary>Whether the item is wearable at all, i.e. has a body slot in this game build.</summary>
    internal static bool IsWearableItem(Item item) => item is Hat or Boots or Ring or Clothing;

    /// <summary>
    /// Whether the item is wearable in that OWN body slot. A hat aimed at the boots slot is a
    /// named refusal, not a silent cast: the seam is generic per item type and would throw.
    /// </summary>
    internal static bool IsWearableForBodySlot(Item item, string bodySlot) => (item, bodySlot) switch
    {
        (Hat, "hat") => true,
        (Boots, "boots") => true,
        (Clothing clothing, "shirt") => clothing.clothesType.Value == Clothing.ClothesType.SHIRT,
        (Clothing clothing, "pants") => clothing.clothesType.Value == Clothing.ClothesType.PANTS,
        (Ring, "left_ring") => true,
        (Ring, "right_ring") => true,
        _ => false,
    };

    /// <summary>
    /// THE SEAM for equipping, one arm per body slot because `Farmer.Equip&lt;TItem&gt;` is generic
    /// in the slot's item type. The return value is the item that was previously worn.
    /// </summary>
    private static Item? EquipIntoWearableBodySlot(Farmer player, string bodySlot, Item item) => bodySlot switch
    {
        "hat" => player.Equip((Hat)item, player.hat),
        "boots" => player.Equip((Boots)item, player.boots),
        "shirt" => player.Equip((Clothing)item, player.shirtItem),
        "pants" => player.Equip((Clothing)item, player.pantsItem),
        "left_ring" => player.Equip((Ring)item, player.leftRing),
        "right_ring" => player.Equip((Ring)item, player.rightRing),
        _ => null,
    };

    /// <summary>
    /// THE SEAM for unequipping: the same overload with <c>newItem: null</c>, which its own
    /// documentation names as the way to just clear the slot (Farmer.cs:7047: "or &lt;c&gt;null&lt;/c&gt;
    /// to just unequip the old item"). The game's own annotation marks that parameter
    /// non-nullable, so the null is written with the forgiving operator and the reason: the
    /// documented null IS the operation. The return value is the item that was worn.
    /// </summary>
    private static Item? UnequipFromWearableBodySlot(Farmer player, string bodySlot) => bodySlot switch
    {
        "hat" => player.Equip<Hat>(null!, player.hat),
        "boots" => player.Equip<Boots>(null!, player.boots),
        "shirt" => player.Equip<Clothing>(null!, player.shirtItem),
        "pants" => player.Equip<Clothing>(null!, player.pantsItem),
        "left_ring" => player.Equip<Ring>(null!, player.leftRing),
        "right_ring" => player.Equip<Ring>(null!, player.rightRing),
        _ => null,
    };

    private static string DescribeWearableOccupant(Item? occupant) => occupant?.QualifiedItemId ?? "none";

    private static bool PackSlotHolds(Farmer player, int slot, string qualifiedItemId) =>
        slot >= 0 && slot < player.Items.Count
        && player.Items[slot] is Item item
        && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal);

    /// <summary>
    /// The native answer to "would a removed wearable have anywhere to land", in the same terms
    /// the game uses (`Farmer.isInventoryFull`, Farmer.cs:4702-4712). Reported as a fact next to
    /// the refusal so a reader can see how full the backpack was, never as a substitute check.
    /// </summary>
    private static int FreeInventorySlots(Farmer player)
    {
        int free = 0;
        for (int index = 0; index < player.Items.Count; index++)
        {
            if (player.Items[index] is null) free++;
        }
        return free;
    }
}
