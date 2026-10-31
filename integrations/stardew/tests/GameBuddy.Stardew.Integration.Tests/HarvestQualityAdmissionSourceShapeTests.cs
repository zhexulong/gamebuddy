using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The harvest admission must ask the pack about every quality the roll can produce, not about one
/// mostly-normal placeholder.
///
/// The probe was <c>ItemRegistry.Create(crop.indexOfHarvest.Value, 1)</c> - always quality 0 - and
/// <c>Item.canStackWith</c> refuses a different quality (<c>Item.cs:738</c>). The native harvest rolls
/// quality from farming level and fertilizer (<c>Crop.cs:562-578</c>), so a pack whose only matching
/// stack was normal-with-headroom was admitted for a gold roll it could not take; <c>Crop.harvest</c>
/// then refused the add (<c>Crop.cs:623</c>), showed the red "Inventory Full" message
/// (<c>Crop.cs:673-676</c>) and returned false, and the postcondition graded the untouched crop as
/// `crop_harvest_postcondition_unavailable`/Uncertain.
///
/// Source-pinned because reaching that state live needs a gold roll landing in a full pack: the pins
/// below assert the admission consults the crop's own quality bounds and the live pack, and that the
/// refusal names the qualities it could not place.
/// </summary>
[Trait("kind", "source-shape")]
public sealed class HarvestQualityAdmissionSourceShapeTests
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
    public void TheAdmissionAsksEveryQualityTheRollCanProduceRatherThanOnePlaceholderItem()
    {
        string source = ReadFarmingActions();
        // The crop's OWN quality bounds, which Crop.cs:578 clamps the roll with.
        source.Should().Contain("HarvestMinQuality");
        source.Should().Contain("HarvestMaxQuality");
        // ...and the per-quality capacity predicate over the live pack.
        source.Should().Contain("HarvestQualityCapacity.ReachableQualities");
        source.Should().Contain("HarvestQualityCapacity.Evaluate");
    }

    [Fact]
    public void TheCapacityProbeItUsedToMakeIsGoneForTheHarvestItem()
    {
        // `couldInventoryAcceptThisItem(Item)` answers for the ONE quality the passed item carries, so
        // using it here is the defect regardless of how the item was built. It may still be used
        // elsewhere (and is), so this pins the harvest admission specifically: the predicate is not
        // called with the harvest item.
        string source = ReadFarmingActions();
        source.Should().NotContain("couldInventoryAcceptThisItem(harvestItem)");
    }

    [Fact]
    public void TheRefusalNamesTheQualitiesThePackCouldNotTake()
    {
        string source = ReadFarmingActions();
        // A bare `inventory_full` told the Agent nothing it could act on: it names the qualities that
        // have nowhere to go, which is the difference between "make room" and "make room for gold".
        source.Should().Contain("refused_qualities=");
    }
}
