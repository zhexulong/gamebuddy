using FluentAssertions;
using StardewValley.GameData.Shops;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Which shop counters the snapshot may publish, decided by the engine's own rule.
///
/// <para>
/// Measured round41 (a Desert Festival day): <c>shopTargets</c> published <c>DesertFestival_Pierre</c> and
/// <c>SeedShop</c> on the SAME tile (4,17) - Pierre's own - beside five festival stalls, and the purchase then refused
/// against a counter that was shut. Both shops' owner entries name Pierre and both conditions matched, so
/// <c>ShopBuilder.GetCurrentOwners</c> alone (the whole of the old test) answers YES for both. The engine's decision has
/// a second half: the entry that would run the counter carries <c>ClosedMessage</c>, and
/// <c>Utility.TryOpenShopMenu</c> draws that message and opens nothing (<c>Utility.cs:4305-4317</c>).
/// </para>
/// <para>
/// These cases drive that decision on real <see cref="ShopData"/>/<see cref="ShopOwnerData"/> rows - the objects the
/// engine itself reads - because the condition evaluation in <c>GetCurrentOwners</c> needs a loaded world. The wiring
/// half (discovery asks this and records the exclusion) is pinned by name in the second test.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the behaviour cases decide what a shop offers now, and the shape pin asserts that the discovery path asks the engine's own `OpensNow(resolvedOwner)` rather than re-deriving opening hours. Keep them together: if that call is renamed, the behaviour cases would still pass against a re-implementation and the pin is what fails, so it has to live where the reader of those cases will see it.
public sealed class ShopPurchasabilityTests
{
    private const string ClosedToday = "Pierre's shop is closed today.";

    private static ShopOwnerData Owner(string name, string? closedMessage = null) =>
        new() { Name = name, ClosedMessage = closedMessage };

    [Fact]
    public void TheStallOnPierreTileOpensWhileTheStoreBehindItIsShut()
    {
        ShopOwnerData stall = Owner("Pierre");
        ShopOwnerData store = Owner("Pierre", closedMessage: ClosedToday);

        ExecutionManager.OpensNow(stall).Should().BeTrue("a counter whose owner entry carries no closed message opens");
        ExecutionManager.OpensNow(store).Should().BeFalse(
            "the resolved entry's ClosedMessage IS the engine's refusal: TryOpenShopMenu draws it and returns false");
    }

    [Fact]
    public void AShopNoEntryCanRunIsNotAnOpenCounter()
    {
        // The engine's `shopOwnerData == null` branch: nothing resolved means nothing to open, and the snapshot must not
        // turn that into a row either.
        ExecutionManager.OpensNow(null).Should().BeFalse();
    }

    [Fact]
    public void TheOwnerThatRunsTheCounterIsChosenTheWayTheEngineChoses()
    {
        // NamedNpc first (Utility.cs:4212-4214), matched by the engine's own IsValid against the owner name in hand.
        ShopOwnerData helper = Owner("None");
        ShopOwnerData other = Owner("Morris");
        ShopOwnerData pierre = Owner("Pierre", closedMessage: ClosedToday);

        ExecutionManager.SelectCurrentShopOwner(new[] { helper, other, pierre }, "Pierre").Should().BeSameAs(pierre);
        ExecutionManager.SelectCurrentShopOwner(new[] { helper, other, pierre }, "Nobody").Should().BeNull(
            "a name no eligible entry matches is the engine's \"nobody here can run it\"");
    }

    [Fact]
    public void ATileOpenedCounterIsResolvedThroughItsAnyOrNoneEntry()
    {
        // The tile-opened stalls have no NPC owner; the native case resolves the AnyOrNone/None entry (Utility.cs:4271)
        // and that form opens regardless of a closed message, which is why this arm is separate.
        ShopOwnerData stallEntry = Owner("AnyOrNone");
        ShopOwnerData npc = Owner("Pierre");

        ExecutionManager.SelectCurrentShopOwner(new[] { npc, stallEntry }, string.Empty).Should().BeSameAs(stallEntry);
    }

    [Fact]
    public void DiscoveryWithholdsTheShutCounterAndSaysSoInTheFamilyExclusions()
    {
        // The wiring: shop discovery asks the one verdict and records the closed vocabulary's token, so the empty list
        // and "the counter is here but shut" never answer the same way.
        string source = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.shopactions.cs")));

        source.Should().Contain("OpensNow(resolvedOwner)", "discovery asks the engine's own verdict on the entry that runs the counter");
        source.Should().Contain(
            "exclusions.Record(\"shopTargets\", DiscoveryExclusionReasons.ShopClosedToday)",
            "the withheld counter is named in the family's exclusions, not silently dropped");
        source.Should().Contain(
            "List<DiscoveredShopCounter> counters = EnumerateShopCounters(location)",
            "the purchase re-reads the SAME enumeration the snapshot published, so agreement is construction, not luck");
        source.Should().Contain(
            "openNow = OpensNow(SelectCurrentShopOwner(eligibleOwners, ownerName))",
            "the seed-shortage fact reads its openNow through that same verdict");

        string vocabulary = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "src", "Core", "Policy", "DiscoveryExclusionReasons.cs")));
        vocabulary.Should().Contain("\"shop_closed_today\"");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }
}
