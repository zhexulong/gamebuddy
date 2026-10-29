using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The snapshot's tool state, as a plan-writing caller reads it: WHICH slot the tool-family actions must be handed,
/// and which slot really holds which tool.
///
/// <para>
/// Why this exists: a live run that had to hand a tool action a <c>slot</c> guessed the number and came back with
/// <c>basic_pickaxe_not_equipped_in_requested_slot</c> and <c>invalid_tool_selector</c> receipts. The actions whose own
/// registration claims a tool (<c>cut_weeds</c>, <c>cut_grass</c>, <c>break_rock_source</c>, <c>water_crop</c>) now select
/// that tool themselves and ignore the number; the ones that still require it to EQUAL <c>Game1.player.CurrentToolIndex</c>
/// and to hold the exact tool (<c>farmhandexecutioncontroller.resourcetoolactions.cs</c>) are why the Mod publishes which
/// slot holds which tool instead of leaving the caller to guess.
/// </para>
///
/// <para>
/// <b>Instrument.</b> The three projections that decide these facts are invoked FOR REAL on synthetic inputs: the
/// slot list and the occupant read take an item list, and the active index is a vanilla <c>Farmer</c> read on an
/// uninitialized probe farmer with its <c>currentToolIndex</c> netfield seeded — the suite's standing pattern for a
/// <c>Game1.player</c> stand-in. A tool instance cannot be CONSTRUCTED headless (the <c>Tool</c> ctor loads game
/// content), so each one is an uninitialized instance seeded through the very fields its identity and level are read
/// from (<c>Item._qualifiedItemId</c>, <c>Tool.upgradeLevel</c>), which is what keeps the assertions about the
/// projection rather than about a stub of it. <c>CreateBridgeSnapshot</c> itself needs a live <c>Game1.player</c>, so
/// the last test pins the two fields' wiring at the source, the way <see cref="BodyOwnerNamingTests"/> pins its own.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class HeldToolProjectionTests
{
    [Fact]
    public void EveryToolSlotIsPublishedWithItsIdentityAndUpgradeLevel()
    {
        // The axe sits in slot 0 and the hoe in slot 2; slot 1 is empty. A caller that must name one of them needs
        // both the number and which tool it is - and the level, because the handlers require the BASIC tool, so an
        // upgraded axe is a different fact from the basic one even though both are "(T)Axe".
        IList<Item?> items = new List<Item?> { Axe(upgradeLevel: 2), null, Hoe() };

        IReadOnlyList<BridgeToolSlot> slots = ToolSlots(items);

        slots.Should().BeEquivalentTo(new[]
        {
            new BridgeToolSlot(0, "(T)Axe", 2, "axe"),
            new BridgeToolSlot(2, "(T)Hoe", 0, "hoe"),
        });
    }

    [Fact]
    public void AScytheAndAPickaxeInKnownSlotsReportTheirClaimCategories()
    {
        // The live failure this closes: the model read `snapshot.toolSlots` for the word "Scythe" and got `(W)47`,
        // which no label can ever say, so it guessed and the plan threw. The category is the word an action's own
        // `tool:<category>` claim uses, so a caller satisfying `tool:scythe` reads it rather than inferring it.
        IList<Item?> items = new List<Item?> { Scythe(), Pickaxe(upgradeLevel: 0), Lantern() };

        IReadOnlyList<BridgeToolSlot> slots = ToolSlots(items);

        slots[0].Category.Should().Be("scythe");
        slots[1].Category.Should().Be("pickaxe");
        // A scythe is a MeleeWeapon: it must report the word its own claim uses, never the family word.
        slots[0].Category.Should().NotBe("weapon");
        // The identity stays published beside the category: `(W)47` is honest about WHICH item this is.
        slots[0].Label.Should().Be("(W)47");
        // A tool the one mapping has no word for says so rather than guessing the nearest-looking one.
        slots[2].Category.Should().Be("unknown");
        FarmhandActionCatalog.ToolEnum.Should().NotContain("unknown", "`unknown` is the absence of a claim word");
    }

    [Fact]
    public void TheActiveSlotAndItsOccupantAgreeWithThePublishedToolSlot()
    {
        IList<Item?> items = new List<Item?> { Axe(upgradeLevel: 0), null, Hoe() };
        Farmer farmer = CreateFarmer(currentToolSlot: 2);

        // The value the snapshot publishes is vanilla's own currentToolIndex.
        int active = farmer.CurrentToolIndex;
        active.Should().Be(2);

        // The snapshot says three things about this slot, and they must name the same tool: it is the active index,
        // its occupant is the hoe, and the tool list carries the hoe AT that index.
        SlotItem(items, active).Should().Be("(T)Hoe");
        ToolSlots(items).Should().ContainSingle(entry => entry.Slot == active && entry.Label == "(T)Hoe");
    }

    [Fact]
    public void ANonToolInTheActiveSlotIsNamedAsItsOwnItem_NotAsATool()
    {
        // Holding seeds: `Farmer.CurrentTool` is `Items[CurrentToolIndex] as Tool`, so the held-tool fact is null -
        // and the snapshot must not leave that reading as "maybe the equip failed". The occupant field says exactly
        // what is in the hand, and the tool list says the seed slot is not a tool slot.
        IList<Item?> items = new List<Item?> { Axe(upgradeLevel: 0), Seeds() };
        Farmer farmer = CreateFarmer(currentToolSlot: 1);

        int active = farmer.CurrentToolIndex;
        active.Should().Be(1);

        SlotItem(items, active).Should().Be("(O)472");
        ToolSlots(items).Select(entry => entry.Slot).Should().BeEquivalentTo(new[] { 0 },
            "a pack slot that holds seeds is not a tool slot, and the axe in slot 0 stays discoverable");
        DescribeTool(items[active] as Tool).Should().BeNull(
            "the held tool fact is the active item AS A TOOL, so a held seed reads as no tool rather than as one");
    }

    [Fact]
    public void AnEmptyOrOutOfRangeActiveSlotHasNoOccupant()
    {
        IList<Item?> items = new List<Item?> { Axe(upgradeLevel: 0), null };

        SlotItem(items, 1).Should().BeNull("slot 1 is empty, so nothing occupies it");
        SlotItem(items, 36).Should().BeNull("an index outside the pack has no occupant");
        SlotItem(items, -1).Should().BeNull("no slot is never a slot");
    }

    [Fact]
    public void TheSnapshotPublishesTheActiveSlotAndItsOccupant()
    {
        // CreateBridgeSnapshot reads Game1.player, so the two new fields are pinned at their wiring: the slot comes
        // from vanilla's currentToolIndex and the occupant from the same slot, so the pair can never describe two
        // different slots.
        string body = MethodBody(Read("integrations/stardew/farmhandexecutioncontroller.cs"),
            "public BridgeSnapshot CreateBridgeSnapshot(");

        body.Should().Contain("CurrentToolSlot: player.CurrentToolIndex,");
        body.Should().Contain("CurrentToolSlotItem: DescribeSlotItem(player.Items, player.CurrentToolIndex)");
        body.Should().Contain("DiscoverToolSlots(player.Items)");
    }

    // ---- helpers -------------------------------------------------------------

    /// <summary>
    /// A tool whose identity and level are the ONLY things the projection reads, seeded through the fields those
    /// properties are backed by. `new Axe()` is impossible here: the Tool constructor loads game content.
    /// </summary>
    private static Axe Axe(int upgradeLevel) => SeedTool<Axe>("(T)Axe", upgradeLevel);

    private static Hoe Hoe() => SeedTool<Hoe>("(T)Hoe", 0);

    private static Pickaxe Pickaxe(int upgradeLevel) => SeedTool<Pickaxe>("(T)Pickaxe", upgradeLevel);

    /// <summary>A scythe is a MeleeWeapon whose own id says so, never the type alone.</summary>
    private static MeleeWeapon Scythe() => SeedTool<MeleeWeapon>("(W)47", 0);

    /// <summary>A tool the category mapping has no word for: it is a `Tool`, and no claim names it.</summary>
    private static Lantern Lantern() => SeedTool<Lantern>("(T)Lantern", 0);

    private static T SeedTool<T>(string qualifiedItemId, int upgradeLevel)
        where T : Tool
    {
        var tool = (T)FormatterServices.GetUninitializedObject(typeof(T));
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, qualifiedItemId);
        typeof(Tool).GetField("upgradeLevel", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, new NetInt(upgradeLevel));
        return tool;
    }

    /// <summary>Parsnip seeds, the non-tool a live run is caught holding.</summary>
    private static StardewValley.Object Seeds()
    {
        var seeds = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(seeds, "(O)472");
        return seeds;
    }

    /// <summary>
    /// An uninitialized `Farmer` with the one field `CurrentToolIndex` is backed by. `Farmer.Items` cannot be seeded
    /// (its backing netfield is not addressable), which is exactly why the slot projections take an item list.
    /// </summary>
    private static Farmer CreateFarmer(int currentToolSlot)
    {
        Farmer farmer = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer).GetField("currentToolIndex", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(farmer, new NetInt(currentToolSlot));
        return farmer;
    }

    private static IReadOnlyList<BridgeToolSlot> ToolSlots(IList<Item?> items) =>
        (IReadOnlyList<BridgeToolSlot>)Invoke("DiscoverToolSlots", items)!;

    private static string? SlotItem(IList<Item?> items, int slot) => (string?)Invoke("DescribeSlotItem", items, slot);

    private static string? DescribeTool(Tool? tool) => (string?)Invoke("DescribeTool", tool);

    /// <summary>The projections are private to the execution manager, so the seam is driven through reflection.</summary>
    private static object? Invoke(string method, params object?[] arguments) =>
        typeof(ExecutionManager)
            .GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, arguments);

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(opening, position - opening + 1);
        }

        throw new InvalidOperationException($"{signature} body is not balanced");
    }

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string RepositorySourcePath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }
}
