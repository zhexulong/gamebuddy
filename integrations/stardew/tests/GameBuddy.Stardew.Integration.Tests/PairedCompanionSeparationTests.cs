using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE PAIRED WORLD'S STAGING WINDOW HAS ONE OWNER, and this is that owner's own arithmetic pinned to the production
/// radius it is derived from.
///
/// <para>
/// THE DEFECT THIS PINS. Two commits two minutes apart each enforced "she must not start inside the window that used to
/// carry other farmers" with their own number: the fixture placed her three to six tiles from the crop
/// (<c>c8cdd164</c>) and the paired runner refused to judge anything closer than seven (<c>0bb12791</c>), so every
/// paired run refused S1 with <c>paired_s1_companion_inside_the_old_radius:…:d=3..6:need=7</c> - a slice that could
/// never run, reported as a world that staged her wrong. The runner now stages against the window the placement record
/// publishes, so this constant is the only copy, and it is derived rather than chosen: the minimum is the nearest tile
/// <c>ExecutionManager.TargetDiscoveryRadius</c> (6) could NOT have published, which is what makes the <c>628c0967</c>
/// fix observable at all.
/// </para>
///
/// <para>
/// THE MAXIMUM IS A BUDGET, NOT A TASTE. Other farmers are bounded by her MAP now, so a ceiling on how far away the
/// person may be is not about what she can see: it is about the walk her own turn has to complete inside S1's window,
/// and past fifteen tiles that walk - not her attention - is what the slice would be measuring. Fifteen is pinned
/// literally because it is a judgement about a model turn's budget, not a derivation; the assertion below states the one
/// relation to the floor that has to stay true of it.
/// </para>
/// </summary>
public sealed class PairedCompanionSeparationTests
{
    [Fact]
    public void TheMinimumIsTheNearestTileTheOldPerceptionRadiusCouldNotPublish()
    {
        ModEntry.PairedCompanionSeparationMinimumTiles.Should().Be(
            ExecutionManager.TargetDiscoveryRadius + 1,
            "S1 asks whether she noticed a person the six-tile `otherFarmers` window would not have carried, so the "
                + "nearest tile it could not publish is the only honest floor - any smaller number is inside the radius "
                + "the fix replaced");
    }

    [Fact]
    public void TheMaximumLeavesTheSliceMeasuringHerAttentionRatherThanHerWalk()
    {
        ModEntry.PairedCompanionSeparationMaximumTiles.Should().Be(
            15,
            "the ceiling is the walk her own turn has to pay for inside S1's window, not the furthest tile the Farm "
                + "offers - a change here is a change to what the slice can measure");
        ModEntry.PairedCompanionSeparationMaximumTiles.Should().BeGreaterThan(
            ModEntry.PairedCompanionSeparationMinimumTiles,
            "an empty window places nobody, and the fixture would refuse S1 by name instead of measuring it");
    }
}
