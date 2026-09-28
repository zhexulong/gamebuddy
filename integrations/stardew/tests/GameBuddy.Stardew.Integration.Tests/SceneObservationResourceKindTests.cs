using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The resource-discovery kinds the observe_scene projection publishes so the
/// companion can plan clearing work (cut_weeds, break_rock_source, clear_debris,
/// dig_artifact_spot) instead of only reacting to near-radius radar. Each kind
/// must keep its exact wire value, its own ref prefix, and its density posture so
/// a dense farm radius cannot starve the sparse anchors that matter (NPC, exit,
/// machine, water).
/// </summary>
public sealed class SceneObservationResourceKindTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    [Theory]
    [InlineData("Weed", "weed", "wd")]
    [InlineData("Stone", "stone", "st")]
    [InlineData("Debris", "debris", "db")]
    [InlineData("ArtifactSpot", "artifact_spot", "af")]
    public void ResourceKind_IsDefinedWithExactWireValueAndRefPrefix(string kindName, string wireValue, string refPrefix)
    {
        SceneAffordanceKind kind = Enum.Parse<SceneAffordanceKind>(kindName);

        SceneAffordanceKindWire.IsDefined(kind).Should().BeTrue();
        SceneAffordanceKindWire.ToWireValue(kind).Should().Be(wireValue);
        SceneAffordanceKindWire.ToRefPrefix(kind).Should().Be(refPrefix);
    }

    [Theory]
    [InlineData("Weed")]
    [InlineData("Stone")]
    public void DenseResourceKind_IsDensityCappedAndDemoted(string kindName)
    {
        SceneAffordanceKind kind = Enum.Parse<SceneAffordanceKind>(kindName);

        SceneAffordanceKindWire.IsDensityCapped(kind).Should().BeTrue();
        SceneAffordanceKindWire.DefaultPriority(kind).Should().BeGreaterThan(0);
    }

    [Theory]
    [InlineData("Debris")]
    [InlineData("ArtifactSpot")]
    public void SparseResourceKind_IsNeitherCappedNorDemoted(string kindName)
    {
        SceneAffordanceKind kind = Enum.Parse<SceneAffordanceKind>(kindName);

        SceneAffordanceKindWire.IsDensityCapped(kind).Should().BeFalse();
        SceneAffordanceKindWire.DefaultPriority(kind).Should().Be(0);
    }

    // --- ClassifyWorldObject ---
    // The Mod scanner feeds five independent predicates into the same total
    // mapping. Precedence is deliberate and must be pinned: if a stone that is
    // also breakable were classified as an artifact spot, the wrong action would
    // be planned.
    [Theory]
    [InlineData(true, false, false, false, false, "forage")]
    [InlineData(false, true, false, false, false, "machine")]
    [InlineData(false, false, true, false, false, "chest")]
    [InlineData(false, false, false, true, false, "artifact_spot")]
    [InlineData(false, false, false, false, true, "weed")]
    [InlineData(false, false, false, false, false, "stone")]
    [InlineData(false, false, false, false, false, null)]
    public void ClassifyWorldObject_EachPredicateMapsToItsOwnKind(
        bool isForage, bool hasMachineData, bool isChest,
        bool isArtifactSpot, bool isWeeds, string? expectedWire)
    {
        SceneAffordanceKind? kind = SceneAffordanceKindWire.ClassifyWorldObject(
            isForage, hasMachineData, isChest, isArtifactSpot, isWeeds, isBreakableStone: expectedWire == "stone");

        if (expectedWire is null)
            kind.Should().BeNull("an object with no supported affordance must not default to a kind");
        else
            SceneAffordanceKindWire.ToWireValue(kind!.Value).Should().Be(expectedWire);
    }

    private static SceneObservationContext Context(long observationSequence) =>
        new("runtime_01", Scope, "Farm", 0, observationSequence);

    private static SceneAffordanceSource Candidate(SceneAffordanceKind kind, string identity, int x, int y) =>
        new(kind, kind.ToString(), identity, "Farm", x, y, "available", SceneAffordanceKindWire.DefaultPriority(kind));
}