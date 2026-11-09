using System;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The closed vocabulary a discovery family publishes when it WITHHOLDS a subject it could see.
///
/// <para>
/// The defect this protects against is not a missing field; it is the shape of the answer. A family that filters its
/// subjects and says nothing about the filter returns one empty list for two different worlds - "there is a tree on
/// this tile but you cannot chop it" and "there is no tree here" - and the companion plans against an empty world.
/// </para>
///
/// <para>
/// These cases are the Mod's half of the closed set. The Host's half is
/// <c>host/src/protocol.test.ts</c> (a reason outside the set is refused and the entry is named), and
/// <c>tools/check-stardew-discovery-exclusions.mjs</c> compares the two declarations by name so neither can grow alone.
/// </para>
/// </summary>
public sealed class DiscoveryExclusionVocabularyTests
{
    [Fact]
    public void EveryPublishedTokenIsAdmitted()
    {
        DiscoveryExclusionReasons.All.Should().HaveCount(10);
        foreach (string token in DiscoveryExclusionReasons.All)
        {
            DiscoveryExclusionReasons.IsKnown(token).Should().BeTrue($"'{token}' is published by All");
            token.Should().MatchRegex("^[a-z][a-z0-9_]*$");
        }
    }

    [Fact]
    public void EveryTokenIsTheConstantItNames()
    {
        // The set and the constants are two spellings of one fact unless this holds: a token added to `All` without a
        // constant, or a constant nobody lists, would travel to the Host as a value the Mod cannot name.
        DiscoveryExclusionReasons.All.Should().BeEquivalentTo(new[]
        {
            DiscoveryExclusionReasons.AlreadyTapped,
            DiscoveryExclusionReasons.Stump,
            DiscoveryExclusionReasons.NotGrown,
            DiscoveryExclusionReasons.Dead,
            DiscoveryExclusionReasons.PettedToday,
            DiscoveryExclusionReasons.AlreadyWatered,
            DiscoveryExclusionReasons.NotReady,
            DiscoveryExclusionReasons.WrongHarvestMethod,
            DiscoveryExclusionReasons.AlreadyBaited,
            DiscoveryExclusionReasons.ShopClosedToday,
        });
        DiscoveryExclusionReasons.All.Distinct(StringComparer.Ordinal).Should().HaveCount(DiscoveryExclusionReasons.All.Count);
    }

    [Fact]
    public void AReasonOutsideTheSetIsRefusedByTheModsValidator()
    {
        DiscoveryExclusionReasons.IsKnown("mossy").Should().BeFalse();
        DiscoveryExclusionReasons.IsKnown(string.Empty).Should().BeFalse();
        DiscoveryExclusionReasons.IsKnown(null).Should().BeFalse();

        DiscoveryExclusionRecorder recorder = new();
        Action recording = () => recorder.Record("treeChopSourceTargets", "mossy");
        // Throwing is the point: the only way a token outside the set can enter is a call site that invented one, and a
        // silently dropped row would be a filter that published nothing - the defect this whole field exists for.
        recording.Should().Throw<ArgumentOutOfRangeException>().WithParameterName("reason");
        recorder.Publish(out int omitted).Should().BeEmpty();
        omitted.Should().Be(0);
    }

    [Fact]
    public void CountsOneRowPerFamilyAndReasonInAStableOrder()
    {
        DiscoveryExclusionRecorder recorder = new();
        recorder.Record("treeChopSourceTargets", DiscoveryExclusionReasons.AlreadyTapped);
        recorder.Record("treeChopSourceTargets", DiscoveryExclusionReasons.Stump);
        recorder.Record("treeChopSourceTargets", DiscoveryExclusionReasons.AlreadyTapped);
        recorder.Record("petTargets", DiscoveryExclusionReasons.PettedToday);

        var rows = recorder.Publish(out int omitted);

        omitted.Should().Be(0);
        rows.Should().Equal(
            new BridgeDiscoveryExclusion("petTargets", DiscoveryExclusionReasons.PettedToday, 1),
            new BridgeDiscoveryExclusion("treeChopSourceTargets", DiscoveryExclusionReasons.AlreadyTapped, 2),
            new BridgeDiscoveryExclusion("treeChopSourceTargets", DiscoveryExclusionReasons.Stump, 1));
    }

    [Fact]
    public void TheCapPublishesWhatItLeftOut()
    {
        DiscoveryExclusionRecorder recorder = new();
        string[] families = Enumerable.Range(0, DiscoveryExclusionRecorder.MaximumRows + 3)
            .Select(index => $"family{index:00}")
            .ToArray();
        foreach (string family in families)
            recorder.Record(family, DiscoveryExclusionReasons.NotReady);

        var rows = recorder.Publish(out int omitted);

        rows.Should().HaveCount(DiscoveryExclusionRecorder.MaximumRows);
        omitted.Should().Be(3);
        // The cap keeps the first rows in the published order, so an unchanged world always yields the same register.
        rows[0].Family.Should().Be("family00");
    }
}
