using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
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
/// <c>basic_pickaxe_not_equipped_in_requested_slot</c> and <c>invalid_tool_selector</c> receipts. Every tool action now
/// selects the tool its own registration claims and ignores the number; the snapshot still publishes which slot holds
/// which tool, because that is how a caller names one in a receipt or in an <c>equip_tool</c> step.
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
    public void AToolThatCannotBeUpgradedIsPublishedWithoutALevelRatherThanWithTheEngineSentinel()
    {
        // Measured on Stardew Valley 1.6.15 (build 24356): a tool that cannot be upgraded carries `-1` by CONSTRUCTION
        // (`new MilkPail().UpgradeLevel == -1`, `new Shears().UpgradeLevel == -1`) while Axe, Hoe, Pickaxe and
        // WateringCan carry `0`. A level is an upgrade TIER, so the Host's `isToolSlotFact` refuses a negative one and
        // the bridge closes with `invalid_snapshot:toolSlots` - which is exactly what `collect_animal_product` did on
        // its first snapshot (measured 2026-11-09), because its fixture stocks the pack with a Milk Pail.
        //
        // The population is the PACK, never a list of tools named here: the assertion walks the same inventory the
        // projection walks and derives each expectation from that tool's own engine value, so a tool added tomorrow
        // is judged by the same rule instead of escaping it.
        IList<Item?> items = new List<Item?>
        {
            Axe(upgradeLevel: 2), MilkPail(), Shears(), null, Pickaxe(upgradeLevel: 0), Wand(),
        };

        IReadOnlyList<BridgeToolSlot> slots = ToolSlots(items);

        int upgradable = 0;
        int sentinelLevel = 0;
        for (int slot = 0; slot < items.Count; slot++)
        {
            if (items[slot] is not Tool tool)
                continue;
            BridgeToolSlot[] matching = slots.Where(entry => entry.Slot == slot).ToArray();
            matching.Should().ContainSingle($"pack slot {slot} holds a tool, so it must be published once");
            BridgeToolSlot published = matching[0];
            if (tool.UpgradeLevel < 0)
            {
                // The engine's sentinel is NOT a tier: it must not travel, and it must not be clamped to 0 either -
                // `0` is a real, different fact (the basic tool).
                published.UpgradeLevel.Should().BeNull(
                    $"{published.Label} carries engine level {tool.UpgradeLevel}, which means it does not upgrade, so no level may be published for it");
                sentinelLevel++;
            }
            else
            {
                published.UpgradeLevel.Should().Be(
                    tool.UpgradeLevel,
                    $"{published.Label} carries engine level {tool.UpgradeLevel}, and that is the tier a claim pins");
                upgradable++;
            }
        }

        // A population with only one kind would prove only one branch, which is how the defect survived: every live
        // pack that reached this projection held nothing but upgradable tools.
        upgradable.Should().BeGreaterThan(0, "the sample pack must contain a tool that upgrades");
        sentinelLevel.Should().BeGreaterThan(0, "the sample pack must contain a tool that cannot upgrade");

        // The WIRE form is the claim the Host reads: the key is ABSENT, not null and not -1. Serialised through the
        // options the real envelope writer uses, so this is the bytes the bridge sends.
        JsonElement wire = JsonSerializer.SerializeToElement(ToolSlots(items), BridgeProtocol.JsonOptions);
        foreach (JsonElement row in wire.EnumerateArray())
        {
            string label = row.GetProperty("label").GetString()!;
            int slot = row.GetProperty("slot").GetInt32();
            int engineLevel = ((Tool)items[slot]!).UpgradeLevel;
            if (engineLevel < 0)
                row.TryGetProperty("upgradeLevel", out JsonElement forbidden).Should().BeFalse(
                    $"{label} cannot upgrade, so the wire row must carry no upgradeLevel; it carried {forbidden}");
            else
                row.GetProperty("upgradeLevel").GetInt32().Should().Be(engineLevel, $"{label} must publish its tier");
        }
    }

    [Fact]
    public void EveryToolSlotIsPublishedWithItsIdentityAndUpgradeLevel()
    {
        // The axe sits in slot 0 and the hoe in slot 2; slot 1 is empty. A caller that must name one of them needs
        // both the number and which tool it is - and the level, because an action's claim may pin an upgrade tier, so an
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
        IList<Item?> items = new List<Item?> { Scythe(), Pickaxe(upgradeLevel: 0), Lantern(), Wand() };

        IReadOnlyList<BridgeToolSlot> slots = ToolSlots(items);

        slots[0].Category.Should().Be("scythe");
        slots[1].Category.Should().Be("pickaxe");
        // A scythe is a MeleeWeapon: it must report the word its own claim uses, never the family word.
        slots[0].Category.Should().NotBe("weapon");
        // The identity stays published beside the category: `(W)47` is honest about WHICH item this is.
        slots[0].Label.Should().Be("(W)47");
        // The lantern gained its own word with `toggle_tool_light`, so `tool:lantern` is resolvable from this list.
        slots[2].Category.Should().Be("lantern");
        // A tool the one mapping truly has no word for says so rather than guessing the nearest-looking one.
        slots[3].Category.Should().Be("unknown");
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

    /// <summary>A tool that cannot be upgraded: the engine constructs it at level `-1`, and this seeds exactly that.</summary>
    private static MilkPail MilkPail() => SeedTool<MilkPail>("(T)MilkPail", -1);

    private static Shears Shears() => SeedTool<Shears>("(T)Shears", -1);

    /// <summary>The word `toggle_tool_light` gave the lantern: a claim now names it.</summary>
    private static Lantern Lantern() => SeedTool<Lantern>("(T)Lantern", 0);

    /// <summary>A tool the category mapping has no word for: it is a `Tool`, and no claim names it.</summary>
    private static Wand Wand() => SeedTool<Wand>("(T)Wand", 0);

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
