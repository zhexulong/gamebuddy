using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A clump the actor cannot swing is still a clump: it is COUNTED with the reason, never deleted from the snapshot.
///
/// <para>
/// <c>DiscoverDebrisTargets</c> used to drop every stump, boulder and meteorite the pack held no matching tool for
/// (<c>if (usableSlot &lt; 0) continue;</c>), so a farm with three boulders and a basic pickaxe published
/// <c>debrisTargets: []</c> - the same answer as a farm with none. The engine, meanwhile, refuses that swing rather
/// than removing the clump: <c>ResourceClump.performToolAction</c> returns false for a wrong family and for a tool
/// below the clump's own level (ResourceClump.cs:150-234), which is what makes <c>tool_insufficient</c> an exclusion
/// and not an excuse.
/// </para>
///
/// <para>
/// The row is NOT the target itself and cannot be: <c>BridgeDebrisTarget.slot</c> is the inventory slot the swing is
/// made from, and the Host validates it as one (<c>isToolSlot</c>, host/src/protocol-target-facts.ts). A clump with no
/// usable tool has no honest slot, and a fabricated one closes the whole frame. What a caller can act on is the pair
/// "one clump is here, and the tier the family needs is not in the pack".
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class DebrisTargetExclusionTests
{
    /// <summary>
    /// The defect, as a case: a large stump needs an Axe at upgrade 1 (<c>ResourceClump.cs:150-170</c>) and the pack
    /// holds an Axe at 0, so nothing is published as a target - and the snapshot says why instead of saying nothing.
    /// </summary>
    [Fact]
    public void AClumpNoToolInThePackCanSwingIsCountedAsToolInsufficient()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
        world.PlaceResourceClump(
            x: 3,
            y: 2,
            parentSheetIndex: StardewValley.TerrainFeatures.ResourceClump.stumpIndex,
            width: 2,
            height: 2);
        world.StandAt(2, 2);

        (object targets, IReadOnlyList<BridgeDiscoveryExclusion> rows) = world.DiscoverExclusions("DiscoverDebrisTargets");

        targets.As<IReadOnlyList<BridgeDebrisTarget>>().Should().BeEmpty(
            "a target row would name an inventory slot to swing with, and this pack has none");
        rows.Should().ContainSingle("the clump is here, and the snapshot must not answer 'nothing there'")
            .Which.Should().Be(
                new BridgeDiscoveryExclusion("debrisTargets", DiscoveryExclusionReasons.ToolInsufficient, 1),
                "the reason names what the engine refuses: a tool below this clump's own level");
    }

    /// <summary>
    /// The count is a count: two clumps the pack cannot swing are one row of two, not one row of one.
    /// </summary>
    [Fact]
    public void TwoUnusableClumpsAreCountedTwice()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
        world.PlaceResourceClump(x: 3, y: 2, parentSheetIndex: StardewValley.TerrainFeatures.ResourceClump.stumpIndex, width: 2, height: 2);
        world.PlaceResourceClump(x: 3, y: 5, parentSheetIndex: StardewValley.TerrainFeatures.ResourceClump.stumpIndex, width: 2, height: 2);
        world.StandAt(2, 2);

        (object targets, IReadOnlyList<BridgeDiscoveryExclusion> rows) = world.DiscoverExclusions("DiscoverDebrisTargets");

        targets.As<IReadOnlyList<BridgeDebrisTarget>>().Should().BeEmpty();
        rows.Should().ContainSingle().Which.Count.Should().Be(2);
    }

    /// <summary>
    /// The inverse: with the axe the family wants, the clump is a TARGET and nothing was withheld - so an empty
    /// exclusion list and a published row are the two answers a caller must be able to tell apart.
    /// </summary>
    [Fact]
    public void AClumpThePackCanSwingIsPublishedAndNothingIsWithheld()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 1);
        world.PlaceResourceClump(
            x: 3,
            y: 2,
            parentSheetIndex: StardewValley.TerrainFeatures.ResourceClump.stumpIndex,
            width: 2,
            height: 2);
        world.StandAt(2, 2);

        (object targets, IReadOnlyList<BridgeDiscoveryExclusion> rows) = world.DiscoverExclusions("DiscoverDebrisTargets");

        targets.As<IReadOnlyList<BridgeDebrisTarget>>().Should().ContainSingle()
            .Which.Slot.Should().Be(0, "the row names the pack slot the swing is made from");
        rows.Should().BeEmpty();
    }
}
