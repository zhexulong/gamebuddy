using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Turning what stands on a farm into the search's vocabulary.
///
/// Three native containers describe what occupies a tile - `resourceClumps` (boulders, stumps, logs),
/// `objects` (stones, weeds, placed items) and `terrainFeatures` (grass, crops on dirt) - and a tile can
/// hold a member of only one of them at a time. The mapping therefore takes the first that answers,
/// which is also the order the engine's own occupancy test uses.
///
/// Kinds that this table does not name (a building, water, the map edge) are absent, and absent means
/// "wall" to the search: a clear plan may never claim that a wall can be paid for.
/// </summary>
public sealed class ClearableKindTests
{
    [Theory]
    [InlineData("resourceClump", "axe", "stump")]
    [InlineData("resourceClump", "pickaxe", "rock")]
    [InlineData("object", TileOccupantKind.Stone, "rock")]
    [InlineData("object", TileOccupantKind.Weed, "weed")]
    [InlineData("object", TileOccupantKind.Twig, "twig")]
    [InlineData("terrain", "grass", "grass")]
    [InlineData("terrain", "crop", "crop")]
    public void EachOccupantMapsToItsClearKind(string container, string detail, string expected)
    {
        ClearableKind.Map(container, detail).Should().Be(expected);
    }

    [Theory]
    [InlineData("object", TileOccupantKind.OtherObject)]
    [InlineData("object", "building")]
    [InlineData("terrain", "water")]
    [InlineData("terrain", "flooring")]
    public void ThingsThatCannotBeClearedMapToNothing(string container, string detail)
    {
        ClearableKind.Map(container, detail).Should().BeNull("a wall is not a bill");
    }

    [Fact]
    public void TheDeclaredUnclearableKindsPriceNothing()
    {
        // The declaration half of the vocabulary: a kind `TileOccupantKind.Unclearable` names is a kind the search may
        // not bill, so the two answers cannot disagree about one word.
        foreach ((string kind, string reason) in TileOccupantKind.Unclearable)
        {
            reason.Should().NotBeNullOrWhiteSpace($"{kind} is declared unclearable and has to say why");
            ClearableKind.Map("object", kind).Should().BeNull($"{kind} is declared unclearable");
        }
    }

    [Fact]
    public void OnlyTheKindsTheCostTablePricesAreKnown()
    {
        foreach (string kind in ClearCostTable.Kinds)
            ClearCostTable.Cost(kind, toolPower: 1, skillLevel: 0, efficient: false)
                .Should().NotBeNull($"{kind} is in the table, so it must have a price");

        ClearCostTable.Kinds.Should().BeEquivalentTo(new[] { "rock", "stump", "weed", "twig", "grass", "crop" });
    }
}
