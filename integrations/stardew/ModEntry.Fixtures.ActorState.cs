using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The wearable the equip/unequip fixtures hand out. `(H)0` is the same vanilla hat id the
    /// dress_mannequin fixture creates, so the item is real target-version content, not a
    /// hand-built instance.
    /// </summary>
    private const string ActorStateFixtureWearableId = "(H)0";

    /// <summary>The name the fixture gives the horse it rides, when the save owns none.</summary>
    private const string ActorStateFixtureName = "GameBuddyFixtureHorse";

    /// <summary>
    /// equip_wearable pre-attachment Given: the actor's own HAT slot is EMPTY and one backpack slot
    /// holds a hat. That is the state the action's target id names ("the hat slot, currently
    /// empty") and the state an ordinary equip moves away from.
    ///
    /// Only those two facts are established. Nothing is equipped here — the native
    /// <c>Farmer.Equip&lt;Hat&gt;</c> call, the observed slot contents and the terminal receipt
    /// belong to production — and this fixture emits no receipt. Every step asserts its own fact,
    /// so an unusable fixture fails loudly here instead of looking like a product bug later.
    /// </summary>
    private void InitializeNativeLocalEquipWearableFixture(Farmer player, GameLocation farm)
    {
        // The save's own hat, if any, is put back in the pack rather than discarded: clearing the
        // slot is the fixture's job, destroying an item is not.
        if (player.hat.Value is Hat wornHat)
        {
            player.Equip<Hat>(null!, player.hat);
            if (player.addItemToInventory(wornHat) is not null)
                throw new InvalidOperationException("fixture_native_local_equip_wearable_displaced_hat_inventory_full");
        }
        if (player.hat.Value is not null)
            throw new InvalidOperationException("fixture_native_local_equip_wearable_hat_slot_not_empty");

        Item wearable = ItemRegistry.Create(ActorStateFixtureWearableId, 1);
        if (wearable is not Hat)
            throw new InvalidOperationException("fixture_native_local_equip_wearable_item_not_wearable");
        if (player.addItemToInventory(wearable) is not null)
            throw new InvalidOperationException("fixture_native_local_equip_wearable_inventory_full");
        int sourceSlot = player.Items.IndexOf(wearable);
        if (sourceSlot < 0)
            throw new InvalidOperationException("fixture_native_local_equip_wearable_source_slot_missing");

        // The predicate the action itself resolves the slot with, so the fixture and the product
        // cannot disagree about the Given.
        if (!ExecutionManager.TryReadWearableBodySlot(player, "hat", out Item? occupant) || occupant is not null)
            throw new InvalidOperationException("fixture_native_local_equip_wearable_hat_slot_not_empty");
        if (!ExecutionManager.IsWearableForBodySlot(wearable, "hat"))
            throw new InvalidOperationException("fixture_native_local_equip_wearable_body_slot_mismatch");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized equip-wearable precondition before bridge attachment: "
                + $"wearable={wearable.QualifiedItemId};source_slot={sourceSlot};hat_slot=empty; "
                + "production alone equips and emits receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// unequip_wearable pre-attachment Given: the actor WEARS one hat, and the backpack state the
    /// scenario declares — either at least one free slot (the ordinary unequip) or no free slot at
    /// all (the frozen `isInventoryFull()` refusal).
    ///
    /// Only those facts are established; the native <c>Farmer.Equip&lt;Hat&gt;(null, hat)</c> call,
    /// the observed slot contents and the terminal receipt belong to production, and this fixture
    /// emits no receipt.
    /// </summary>
    private void InitializeNativeLocalUnequipWearableFixture(Farmer player, GameLocation farm, bool inventoryFull)
    {
        Item wearable = ItemRegistry.Create(ActorStateFixtureWearableId, 1);
        if (wearable is not Hat hat)
            throw new InvalidOperationException("fixture_native_local_unequip_wearable_item_not_wearable");
        Hat? displaced = player.Equip(hat, player.hat);
        if (displaced is not null && player.addItemToInventory(displaced) is not null)
            throw new InvalidOperationException("fixture_native_local_unequip_wearable_displaced_hat_inventory_full");
        if (!ExecutionManager.TryReadWearableBodySlot(player, "hat", out Item? occupant)
            || occupant?.QualifiedItemId != hat.QualifiedItemId)
            throw new InvalidOperationException("fixture_native_local_unequip_wearable_hat_not_worn");

        if (inventoryFull)
        {
            // Every slot the game's own fullness predicate looks at (Farmer.maxItems, Farmer.cs:602)
            // holds an item, so `isInventoryFull()` is true and a removed wearable would have
            // nowhere to land. Filled through the native insertion path, the same way the other
            // fixtures give the actor an item, and bounded so a pack that cannot be filled fails
            // loudly instead of looping.
            int attempts = 0;
            int limit = 2 * Math.Max(player.Items.Count, player.maxItems.Value) + 8;
            while (!player.isInventoryFull() && attempts < limit)
            {
                attempts++;
                if (player.addItemToInventory(ItemRegistry.Create("(O)178", 999)) is not null)
                    throw new InvalidOperationException("fixture_native_local_unequip_wearable_inventory_fill_failed");
            }
            if (!player.isInventoryFull())
                throw new InvalidOperationException("fixture_native_local_unequip_wearable_inventory_fill_failed");
        }
        else if (player.isInventoryFull())
        {
            throw new InvalidOperationException("fixture_native_local_unequip_wearable_no_free_inventory_slot");
        }

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized unequip-wearable precondition before bridge attachment: "
                + $"wearable={hat.QualifiedItemId};hat_slot=worn;inventory_full={player.isInventoryFull().ToString().ToLowerInvariant()};"
                + $"inventory_slots={player.Items.Count}; production alone unequips and emits receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// dismount_transport pre-attachment Given: the actor is RIDING a horse whose rider is this
    /// actor. That is the state the native terminal requires (`Horse.dismount` dereferences
    /// <c>rider</c>) and the state `!who.isRidingHorse()` is a change from.
    ///
    /// The riding state is SET here rather than animated, because the native mount is a multi-tick
    /// animation: `Horse.checkAction`'s unmounted half stages it (Horse.cs:674-687) and
    /// `Horse.update` completes it by removing the horse from the location's characters
    /// (Horse.cs:253) and assigning `Farmer.mount` (:254). This fixture writes exactly that pair
    /// of facts — nothing else about the mount. Production alone calls `Horse.dismount()` and
    /// emits the receipt; this fixture never dismounts anything.
    /// </summary>
    private void InitializeNativeLocalDismountTransportFixture(Farmer player, GameLocation farm)
    {
        Horse? horse = player.mount as Horse
            ?? farm.characters.OfType<Horse>().FirstOrDefault(candidate =>
                !string.IsNullOrWhiteSpace(candidate.Name)
                && !string.Equals(candidate.Name, "Horse", StringComparison.Ordinal)
                && candidate.rider is null);
        if (horse is null)
        {
            Vector2 tile = new(player.Tile.X + 1, player.Tile.Y);
            horse = new Horse(Guid.NewGuid(), (int)tile.X, (int)tile.Y)
            {
                Name = ActorStateFixtureName,
            };
            farm.characters.Add(horse);
        }
        if (string.IsNullOrWhiteSpace(horse.Name) || string.Equals(horse.Name, "Horse", StringComparison.Ordinal))
            horse.Name = ActorStateFixtureName;

        horse.mounting.Value = false;
        horse.dismounting.Value = false;
        horse.rider = player;
        player.mount = horse;
        // The native mount completion takes the horse out of the location's character list; the
        // actor's own `mount` reference is what carries the riding state from there on.
        farm.characters.Remove(horse);

        if (player.mount is not Horse mounted || !ReferenceEquals(mounted.rider, player))
            throw new InvalidOperationException("fixture_native_local_dismount_transport_not_riding");
        if (!player.isRidingHorse())
            throw new InvalidOperationException("fixture_native_local_dismount_transport_riding_flag_missing");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized dismount-transport precondition before bridge attachment: "
                + $"horse_id={horse.HorseId};rider={player.Name};riding=true;tile={player.TilePoint.X},{player.TilePoint.Y}; "
                + "production alone dismounts and emits receipt.",
            LogLevel.Info);
    }
}
