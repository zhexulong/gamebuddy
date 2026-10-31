using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using Netcode;
using StardewValley;
using StardewValley.Inventories;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The pack side of <c>chest_store</c>: which carried stacks count as "the actor owns this item".
///
/// The native transaction is <c>Chest.addItem(Item)</c> followed by <c>Farmer.removeItemFromInventory(Item)</c>, and
/// both take the base class. The pick predicate must therefore be as wide as the pair it feeds. It was pinned to
/// <c>StardewValley.Object</c>, which silently excluded every <c>Tool</c>, <c>MeleeWeapon</c>, <c>Slingshot</c>,
/// <c>Ring</c>, <c>Hat</c>, <c>Boots</c>, <c>Clothing</c> and <c>Furniture</c> - and <c>chest_retrieve</c>, which has
/// always taken an <c>Item</c> out of the chest, can put any of those into the pack. The asymmetry made the pair a
/// one-way door: an item taken out could never be put back, and the refusal named an item the actor was visibly
/// holding (<c>item_not_owned_in_slot;carried=none</c>).
/// </summary>
public sealed class ChestStoreCarriedItemTests
{
    [Fact]
    public void ACarriedToolIsACarriedStack()
    {
        using var pack = new HeadlessPack();
        pack.Carry(new MeleeWeapon { }, "(W)47", slot: 4);

        pack.Carried("(W)47").Should().Be((true, 4),
            "a scythe is carried by the same predicate as a parsnip: the native store/remove pair takes `Item`");
    }

    [Fact]
    public void ACarriedOrdinaryObjectIsStillACarriedStack()
    {
        // The widening must not disturb the case the predicate was written for.
        using var pack = new HeadlessPack();
        pack.Carry(new StardewValley.Object(), "(O)24", slot: 2);

        pack.Carried("(O)24").Should().Be((true, 2));
    }

    [Fact]
    public void TheFirstCarriedStackOfThatIdIsTheOneNamed()
    {
        // Two stacks of one id are one address; the FIRST one is the address, and its slot is reported so the receipt
        // can name which stack moved.
        using var pack = new HeadlessPack();
        pack.Carry(new StardewValley.Object(), "(O)24", slot: 1);
        pack.Carry(new StardewValley.Object(), "(O)24", slot: 6);

        pack.Carried("(O)24").Should().Be((true, 1));
    }

    [Fact]
    public void AnItemTheActorDoesNotCarryIsNotACarriedStack()
    {
        using var pack = new HeadlessPack();
        pack.Carry(new MeleeWeapon(), "(W)47", slot: 0);

        pack.Carried("(O)24").Should().Be((false, -1));
    }

    /// <summary>
    /// A headless <c>Game1.player</c> whose backpack holds only what a test puts there.
    ///
    /// The two seeding shapes are the ones the file already uses elsewhere: an uninitialized <c>Farmer</c> whose
    /// backing netfield is assigned by reflection (`ApproachClassificationTests.HeadlessWorld`), and uninitialized
    /// game items whose identity and stack are set through the fields those properties read
    /// (`HeldToolProjectionTests.SeedTool`) - `new MeleeWeapon()` loads game content.
    /// </summary>
    private sealed class HeadlessPack : IDisposable
    {
        private readonly Farmer? playerBefore;

        internal HeadlessPack()
        {
            this.playerBefore = Game1.player;
            var player = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(player, "netItems", new NetRef<Inventory> { Value = new Inventory() });
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, player);
        }

        internal void Carry(Item item, string qualifiedItemId, int slot)
        {
            SetField(item, "_qualifiedItemId", qualifiedItemId);
            SetField(item, "stack", new NetInt(1));
            while (Game1.player.Items.Count <= slot) Game1.player.Items.Add(null!);
            Game1.player.Items[slot] = item;
        }

        /// <summary>Drive the production predicate and answer what it reported, as one comparable pair.</summary>
        internal (bool Found, int Slot) Carried(string qualifiedItemId)
        {
            MethodInfo predicate = typeof(ExecutionManager)
                .GetMethod("TryFindCarriedStack", BindingFlags.NonPublic | BindingFlags.Static)!;
            var arguments = new object?[] { qualifiedItemId, null, null };
            bool found = (bool)predicate.Invoke(null, arguments)!;
            return (found, (int)arguments[1]!);
        }

        public void Dispose() =>
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);
    }
}
