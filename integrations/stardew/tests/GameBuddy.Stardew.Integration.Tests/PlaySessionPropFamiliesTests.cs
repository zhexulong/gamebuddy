using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Which props the play-session world may lose, and which of them the day cannot do without.
///
/// <para>
/// THE DEFECT THESE EXIST FOR, measured 2026-11-23. The post-placement sweep dropped five of seventeen props and the
/// world refused with <c>world_too_fragmented:dropped=5;kept=12</c>, while the only record of WHAT was dropped was a list
/// of tiles (<c>8,36;8,35;9,35;9,34;9,33</c>). Whether that world had lost a target family - and so a chore the rotation
/// names - or five decorative rocks was not answerable from any artifact, so the two worlds looked the same from the
/// outside. They are not the same: one has a `weedTargets` chore with nothing to address.
/// </para>
///
/// <para>
/// WHAT IS PINNED HERE. The families the world lays, the published family each one puts rows in, the verdict for a drop
/// that leaves the family standing (scenery) and for the one that empties it (load-bearing), and the same question
/// asked before the sweep: a family the budget wanted and the ground never held.
/// </para>
/// </summary>
public sealed class PlaySessionPropFamiliesTests
{
    [Fact]
    public void EveryFamilyTheWorldLaysNamesADistinctPublishedTargetFamily()
    {
        // The population is the fixture's own declaration, not a list written here: a seventh prop family is inside this
        // assertion the moment it is added, and a copy of the six names would only catch what its author remembered.
        PlaySessionPropFamilies.All.Should().HaveCount(6, "the world lays trees, forage, weeds, grass, stones and crops");
        PlaySessionPropFamilies.All.Should().OnlyHaveUniqueItems();

        IReadOnlyList<string> published = PlaySessionPropFamilies.All
            .Select(PlaySessionPropFamilies.TargetFamilyOf)
            .ToList();
        published.Should().OnlyHaveUniqueItems("two prop families claiming one published family would report a drop twice");
        published.Should().OnlyContain(family => family.EndsWith("Targets", StringComparison.Ordinal), "the wire names its target families that way");
    }

    [Fact]
    public void AWordNoFamilyLaysIsRefusedByName()
    {
        // A drop the report cannot classify must not become scenery: the silent default is exactly how a family is lost
        // without a word said about it.
        Action unknown = () => PlaySessionPropFamilies.TargetFamilyOf("rock");

        unknown.Should().Throw<InvalidOperationException>().WithMessage("*prop_family_unknown:rock*");
    }

    [Fact]
    public void DroppingOneOfThreeLeavesTheFamilyStandingAndIsScenery()
    {
        IReadOnlyList<PlaySessionPropFamilies.DroppedProp> dropped = PlaySessionPropFamilies.ClassifyDrops(
            Weeds(3),
            new[] { new Vector2(1, 0) });

        dropped.Should().ContainSingle();
        dropped[0].Family.Should().Be(PlaySessionPropFamilies.Weed);
        dropped[0].Tile.Should().Be(new Vector2(1, 0));
        dropped[0].LoadBearing.Should().BeFalse("two weeds still stand, so no chore lost its target family");
    }

    [Fact]
    public void TheDropThatEmptiesAFamilyIsLoadBearing()
    {
        // The whole family taken, in the order the sweep took it: the day's weed is the LAST one, never all three.
        IReadOnlyList<PlaySessionPropFamilies.DroppedProp> dropped = PlaySessionPropFamilies.ClassifyDrops(
            Weeds(3),
            new[] { new Vector2(0, 0), new Vector2(1, 0), new Vector2(2, 0) });

        dropped.Select(prop => prop.LoadBearing).Should().Equal(false, false, true);
        dropped.Should().OnlyContain(prop => prop.Family == PlaySessionPropFamilies.Weed);
        PlaySessionPropFamilies.TargetFamilyOf(dropped[2].Family).Should().Be(TileTargetMint.WeedTargets);
    }

    [Fact]
    public void ASecondFamilyIsJudgedOnItsOwnMembersAndNotOnTheFirstFamilys()
    {
        // Two trees and one stone: the trees fall, the stone stands. Exactly one drop is load-bearing, and it is a tree -
        // a count over the whole world instead of per family would have called the first tree scenery and the last stone
        // the day's, which is the wrong repair for both.
        List<(Vector2 Tile, string Family)> placed = new()
        {
            (new Vector2(0, 0), PlaySessionPropFamilies.Tree),
            (new Vector2(1, 0), PlaySessionPropFamilies.Tree),
            (new Vector2(2, 0), PlaySessionPropFamilies.Stone),
        };

        IReadOnlyList<PlaySessionPropFamilies.DroppedProp> dropped = PlaySessionPropFamilies.ClassifyDrops(
            placed,
            new[] { new Vector2(0, 0), new Vector2(1, 0) });

        dropped.Where(prop => prop.LoadBearing).Should().ContainSingle()
            .Which.Family.Should().Be(PlaySessionPropFamilies.Tree);
        dropped.Where(prop => !prop.LoadBearing).Should().ContainSingle()
            .Which.Tile.Should().Be(new Vector2(0, 0));
    }

    [Fact]
    public void ADropOfATileTheWorldNeverPlacedIsRefusedByName()
    {
        // Evidence over assumption: a sweep that hands this a tile it did not lay is a defect in the sweep, and reporting
        // it as scenery would leave the ground and the report disagreeing.
        Action unplaced = () => PlaySessionPropFamilies.ClassifyDrops(Weeds(1), new[] { new Vector2(9, 9) });

        unplaced.Should().Throw<InvalidOperationException>().WithMessage("*dropped_tile_never_placed:9,9*");
    }

    private static List<(Vector2 Tile, string Family)> Weeds(int count) =>
        Enumerable.Range(0, count)
            .Select(index => (new Vector2(index, 0), PlaySessionPropFamilies.Weed))
            .ToList();
}
