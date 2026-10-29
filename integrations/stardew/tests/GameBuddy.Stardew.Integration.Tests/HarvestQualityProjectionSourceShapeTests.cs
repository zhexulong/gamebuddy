using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The harvest receipt must name the quality it produced.
///
/// The engine tracks quality per item (`Object.Quality`: 0 normal, 1 silver, 2 gold, 4 iridium) and it decides both
/// the shipping value and whether an item is worth keeping. The receipt reported the crop id and the expected item
/// id, so a companion holding a gold cauliflower and a plain one saw the same fact - asked directly on 2026-10-18
/// ("do items have quality differences, and can the agent know?"), the answer from the artifacts was no.
///
/// Source-pinned because the path needs a live game to exercise: what is pinned is that the projection EXISTS and
/// measures the difference this harvest made, rather than reporting the inventory's absolute state (which would let
/// an earlier harvest's quality masquerade as this one's).
/// </summary>
public sealed class HarvestQualityProjectionSourceShapeTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private static string ReadFarmingActions() =>
        File.ReadAllText(
            Path.GetFullPath(
                Path.Combine(
                    AppContext.BaseDirectory,
                    RepositoryRelativeRoot,
                    "integrations",
                    "stardew",
                    "farmhandexecutioncontroller.farmingconstructionactions.cs")));

    [Fact]
    public void TheHarvestReceiptNamesTheQualityItAdded()
    {
        string source = ReadFarmingActions();
        source.Should().Contain("harvest_quality={harvestedQuality};");
        source.Should().Contain("quality_counts_before={qualityCountsBefore};");
        source.Should().Contain("quality_counts_after={qualityCountsAfter}");
    }

    [Fact]
    public void TheQualityItReportsIsThisHarvestsDifferenceNotTheInventorysTotal()
    {
        string source = ReadFarmingActions();
        // Counted per quality before AND after, and the gained one is the quality whose count grew - so a gold crop
        // harvested twice reports gold twice, and a gold crop harvested after a silver one does not report both.
        source.Should().Contain("Dictionary<int, int> qualityBefore = CountQualities();");
        source.Should().Contain("Dictionary<int, int> qualityAfter = CountQualities();");
        source.Should().Contain(".Where(pair => pair.Value > (qualityBefore.TryGetValue(pair.Key, out int heldBefore) ? heldBefore : 0))");
        // ...and an unreadable quality is named, never guessed as zero (0 is itself a legal quality: normal).
        source.Should().Contain("? \"unknown\"");
    }
}
