using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using StardewValley;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A refused slot-named tool request has to say enough to be repaired.
///
/// <para>
/// Measured 2026-10-28 (<c>round4</c>, two <c>chop_stump</c> refusals): the whole evidence was
/// <c>"detail": "slot=0"</c>. Slot 0 held no axe, but nothing in that receipt said so, named what the slot
/// did hold, or named the slot that would have worked - so the only repair available to the companion was
/// another guess, and the run paid for two of them.
/// </para>
///
/// <para>
/// The fix states four facts, each once: the slot the request named, what that slot actually holds, what is
/// in hand, and the slot the action's OWN declared claim selects (with that claim's refusal when nothing
/// satisfies it). The tool words are the published category vocabulary, so the receipt and the surface speak
/// the same language.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class RequestedSlotRefusalEvidenceTests
{
    private const string ResourceToolActions = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";

    [Fact]
    public void ARefusedSlotNamesTheSlotThatDoesHoldTheToolTheActionDeclares()
    {
        // The measured failure, repaired: slot 0 holds the hoe, the basic axe is in slot 2 and is not in hand.
        // Everything the model needs to correct itself is here, and each fact appears once.
        IList<Item?> pack = new List<Item?> { Hoe(), null, Axe(upgradeLevel: 0) };

        DescribeSlot(pack, requestedSlot: 0, heldSlot: 0, actionId: "chop_stump")
            .Should().Be("slot=0;holds=hoe;held=hoe;tool_slot=2;tool_refusal=none");
    }

    [Fact]
    public void ARefusedSlotSeparatesNotOwnedFromOwnedAtTheWrongTier()
    {
        // The two repairs are different - one cannot be fixed by the Mod at all - and the claim's own
        // vocabulary already states which is which, so the receipt reuses it rather than inventing a word.
        DescribeSlot(new List<Item?> { Hoe(), null }, requestedSlot: 1, heldSlot: 0, actionId: "chop_stump")
            .Should().Be("slot=1;holds=none;held=hoe;tool_slot=none;tool_refusal=tool_not_owned:axe");

        // An UPGRADED axe now SATISFIES `chop_stump`, because the claim is `AnyUpgrade` - the old `BasicOnly` demanded
        // the level-0 tier the game does not require (see `FarmhandResourceTemplateValue.BasicOnly`).
        DescribeSlot(new List<Item?> { Axe(upgradeLevel: 1) }, requestedSlot: 0, heldSlot: 0, actionId: "chop_stump")
            .Should().Be("slot=0;holds=axe;held=axe;tool_slot=0;tool_refusal=none");
    }

    [Fact]
    public void ARefusedSlotDistinguishesAnIndexThatDoesNotExist()
    {
        // `slot >= Items.Count` is one of the conditions the refusal collapses. Naming it as `none` would
        // read as "the slot is empty", which is a different request to make.
        DescribeSlot(new List<Item?> { Axe(upgradeLevel: 0) }, requestedSlot: 12, heldSlot: 0, actionId: "chop_stump")
            .Should().Be("slot=12;holds=out_of_range;held=axe;tool_slot=0;tool_refusal=none");
    }

    [Fact]
    public void ARefusedSlotNamesANonToolItemByIdentityRatherThanCallingItAbsent()
    {
        // A slot full of seeds is not an empty slot, and a category word does not exist for it: the identity
        // is the only honest answer left.
        IList<Item?> pack = new List<Item?> { ItemWithIdentity("(O)472") };

        DescribeSlot(pack, requestedSlot: 0, heldSlot: 0, actionId: "chop_stump")
            .Should().StartWith("slot=0;holds=(O)472;held=(O)472;");
    }

    [Fact]
    public void EveryAxeRefusalSiteCarriesTheEvidenceAndNoneStillSaysOnlyTheSlot()
    {
        // The population is derived from the source: every site that mints this code, not a hand-kept list of
        // four line numbers. A fifth axe refusal added later fails here by name instead of shipping `slot=N`.
        string source = File.ReadAllText(RepositorySourcePath(ResourceToolActions));
        const string Code = "\"basic_axe_not_equipped_in_requested_slot\"";

        int sites = 0;
        for (int index = source.IndexOf(Code, StringComparison.Ordinal); index >= 0;
             index = source.IndexOf(Code, index + Code.Length, StringComparison.Ordinal))
        {
            int statementEnd = source.IndexOf(';', index);
            statementEnd.Should().BeGreaterThan(index, "the refusal must be a complete statement");
            string statement = source[index..statementEnd];
            statement.Should().Contain("DescribeRequestedSlot(",
                "a refusal the companion can act on names the slot it asked for and the slot that would work");
            statement.Should().NotContain("$\"slot={slot}\"",
                "`slot=0` alone says nothing about what slot 0 held");
            sites++;
        }

        sites.Should().BeGreaterThanOrEqualTo(4, "the axe family's request and execution paths both refuse");
    }

    // ---- helpers -------------------------------------------------------------

    private static string DescribeSlot(IList<Item?> pack, int requestedSlot, int heldSlot, string actionId) =>
        (string)typeof(ExecutionManager)
            .GetMethod("DescribeRequestedSlot", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { pack, requestedSlot, heldSlot, actionId })!;

    /// <summary>A tool whose identity and level are the only things the evidence reads.</summary>
    private static T SeedTool<T>(string qualifiedItemId, int upgradeLevel)
        where T : Tool
    {
        var tool = (T)FormatterServices.GetUninitializedObject(typeof(T));
        SeedIdentity(tool, qualifiedItemId);
        typeof(Tool).GetField("upgradeLevel", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, new Netcode.NetInt(upgradeLevel));
        return tool;
    }

    private static Item SeedIdentity(Item item, string qualifiedItemId)
    {
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(item, qualifiedItemId);
        return item;
    }

    private static Axe Axe(int upgradeLevel) => SeedTool<Axe>("(T)Axe", upgradeLevel);

    private static Hoe Hoe() => SeedTool<Hoe>("(T)Hoe", 0);

    private static Item ItemWithIdentity(string qualifiedItemId) =>
        SeedIdentity((Item)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object)), qualifiedItemId);

    private static string RepositorySourcePath(string relative)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations", "stardew")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test runs inside the repository");
        return Path.Combine(directory!.FullName, relative);
    }
}
