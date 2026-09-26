using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane F: the dense discovery kinds (tree, animal) and the per-kind density cap
/// that keeps them from consuming the shared 20-item scene budget.
///
/// A farm radius holds dozens of wild trees and animals while NPCs, exits,
/// machines and water are sparse. Without a cap, whichever dense instances
/// happen to be nearest fill all 20 slots and the sparse anchors never reach the
/// Agent. The wire values must be exactly "tree" and "animal" to match the Host
/// protocol set and the language-neutral JSON schema.
/// </summary>
public sealed class SceneObservationDenseKindTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    [Theory]
    [InlineData("Tree", "tree")]
    [InlineData("Animal", "animal")]
    public void SceneAffordanceKindWire_DenseKind_IsDefinedWithExactWireValueAndRefPrefix(string kindName, string wireValue)
    {
        SceneAffordanceKind kind = Enum.Parse<SceneAffordanceKind>(kindName);
        SceneAffordanceKindWire.IsDefined(kind).Should().BeTrue();
        SceneAffordanceKindWire.ToWireValue(kind).Should().Be(wireValue);
        SceneAffordanceKindWire.IsDensityCapped(kind).Should().BeTrue();
    }

    [Theory]
    [InlineData("Npc")]
    [InlineData("Chest")]
    [InlineData("Crop")]
    [InlineData("Forage")]
    [InlineData("Door")]
    [InlineData("Machine")]
    [InlineData("WaterSource")]
    public void SceneAffordanceKindWire_SparseAnchor_IsNotDensityCappedOrDemoted(string kindName)
    {
        SceneAffordanceKind kind = Enum.Parse<SceneAffordanceKind>(kindName);
        SceneAffordanceKindWire.IsDensityCapped(kind).Should().BeFalse();
        SceneAffordanceKindWire.DefaultPriority(kind).Should().Be(0);
    }

    /// <summary>
    /// The behavior this lane exists for: a farm field of trees must not push a
    /// nearby NPC out of observe_scene output. The cap bounds how many trees any
    /// single observation may spend, so the NPC still gets an issued ref.
    /// </summary>
    [Fact]
    public void Observe_KeepsSparseNpcWhenDenseTreesAreNearer()
    {
        var store = new SceneObservationStore();
        var projection = new SceneObservationProjection(store);
        // 30 live trees inside radius 1 of the actor: more than the whole
        // 20-item budget, and every one of them nearer than the NPC.
        SceneAffordanceSource[] trees = Enumerable.Range(0, 30)
            .Select(index => new SceneAffordanceSource(
                SceneAffordanceKind.Tree,
                "Tree",
                $"tree:Farm:{index},1:1",
                "Farm",
                1 + (index % 3),
                1 + (index / 3),
                "chop_tree_source",
                SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Tree)))
            .ToArray();
        var npc = new SceneAffordanceSource(
            SceneAffordanceKind.Npc,
            "Robin",
            "npc_robin",
            "Farm",
            5,
            5,
            "npc_relationship",
            SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Npc));
        SceneObservationInput input = new("Farm", 1, 1, trees.Append(npc).ToArray());

        SceneObservationProjectionResult result = projection.Observe(Context(observationSequence: 1), input);

        result.IsValid.Should().BeTrue();
        result.Affordances.Should().Contain(affordance => affordance.Kind == "npc" && affordance.Name == "Robin");
        result.Affordances.Count(affordance => affordance.Kind == "tree")
            .Should().Be(SceneAffordanceKindWire.MaximumDenseKindAffordances);
        // The cap is a real truncation of the same budget, not a silent drop, so
        // the existing partial/truncatedReason path must still fire.
        result.IsPartial.Should().BeTrue();
        result.TruncatedReason.Should().Be("maximum_affordances");
        result.PayloadUtf8Bytes.Should().BeLessOrEqualTo(SceneObservationProjection.MaximumPayloadUtf8Bytes);
    }

    [Fact]
    public void Observe_CapsEachDenseKindIndependentlyOfTheSharedBudget()
    {
        var store = new SceneObservationStore();
        var projection = new SceneObservationProjection(store);
        // Animals may not consume tree slots: each dense kind has its own ceiling.
        SceneAffordanceSource[] trees = Enumerable.Range(0, 10)
            .Select(index => Candidate(SceneAffordanceKind.Tree, $"tree_{index:00}", 1, 1 + index))
            .ToArray();
        SceneAffordanceSource[] animals = Enumerable.Range(0, 10)
            .Select(index => Candidate(SceneAffordanceKind.Animal, $"animal_{index:00}", 2, 1 + index))
            .ToArray();
        SceneObservationInput input = new("Farm", 1, 1, trees.Concat(animals).ToArray());

        SceneObservationProjectionResult result = projection.Observe(Context(observationSequence: 1), input);

        result.IsValid.Should().BeTrue();
        result.Affordances.Count(affordance => affordance.Kind == "tree")
            .Should().Be(SceneAffordanceKindWire.MaximumDenseKindAffordances);
        result.Affordances.Count(affordance => affordance.Kind == "animal")
            .Should().Be(SceneAffordanceKindWire.MaximumDenseKindAffordances);
        result.IsPartial.Should().BeTrue();
        result.TruncatedReason.Should().Be("maximum_affordances");
    }

    /// <summary>
    /// An untruncated observation must not report partial: the cap only marks
    /// truncation when it actually withheld a candidate.
    /// </summary>
    [Fact]
    public void Observe_DenseKindBelowCap_IsNotReportedAsTruncated()
    {
        var store = new SceneObservationStore();
        var projection = new SceneObservationProjection(store);
        SceneObservationInput input = new(
            "Farm",
            1,
            1,
            Enumerable.Range(0, SceneAffordanceKindWire.MaximumDenseKindAffordances)
                .Select(index => Candidate(SceneAffordanceKind.Tree, $"tree_{index:00}", 1, 1 + index))
                .ToArray());

        SceneObservationProjectionResult result = projection.Observe(Context(observationSequence: 1), input);

        result.Affordances.Should().HaveCount(SceneAffordanceKindWire.MaximumDenseKindAffordances);
        result.IsPartial.Should().BeFalse();
        result.TruncatedReason.Should().BeNull();
    }

    /// <summary>
    /// The demotion must be load-bearing, not decorative. Mutating
    /// `DefaultPriority` so dense kinds keep the neutral 0 leaves every other
    /// test in this class green, so without this case the whole priority field
    /// could be deleted without any test noticing.
    ///
    /// The setup is the one case the cap alone cannot cover: the dense kind is
    /// already below its own ceiling, so nothing is capped, and there are still
    /// free budget slots when the sparse anchor is reached. Both kinds fit, so
    /// the only thing that can decide the order is the second sort key.
    /// </summary>
    [Fact]
    public void Observe_OrdersSparseAnchorBeforeEquallyDistantDenseKind()
    {
        var store = new SceneObservationStore();
        var projection = new SceneObservationProjection(store);
        // `animal` sorts FIRST in ordinal order (animal < chest < crop < door
        // < forage < machine < npc < tree < water_source), which is the third
        // sort key. So an animal tied on distance with a chest would be issued
        // first by the existing tie-break alone; only the priority demotion can
        // put the sparse anchor ahead. Using `tree` (ordinal 7, after every
        // sparse kind) would pass without DefaultPriority doing anything.
        var animal = new SceneAffordanceSource(
            SceneAffordanceKind.Animal, "Cluck", "animal:Farm:7:1", "Farm", 2, 1, "collect_animal_product",
            SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Animal));
        var chest = new SceneAffordanceSource(
            SceneAffordanceKind.Chest, "Chest", "chest:Farm:2,1", "Farm", 2, 1, null,
            SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Chest));
        SceneObservationInput input = new("Farm", 1, 1, new[] { animal, chest });

        SceneObservationProjectionResult result = projection.Observe(Context(observationSequence: 1), input);

        result.IsValid.Should().BeTrue();
        result.Affordances.Should().HaveCount(2, "both fit, so nothing was withheld and this is not a cap case");
        // Equal distance and equal kind names would not decide it either; the
        // only key that can order these two is DefaultPriority. Assert that the
        // ordinal fallback really would have chosen the other one, so this test
        // cannot silently become vacuous if the kind set ever changes.
        string.CompareOrdinal("animal", "chest").Should().BeLessThan(0,
            "ordinal order alone would issue the animal first, so priority is load-bearing here");
        result.Affordances[0].Kind.Should().Be("chest", "an equally distant sparse anchor must outrank a dense fact");
        result.Affordances[1].Kind.Should().Be("animal");
        // The demotion must not be so strong that a dense fact loses to a
        // farther sparse anchor: the first sort key is still distance.
        result.Affordances.Select(affordance => affordance.Distance).Should().BeInAscendingOrder();
    }

    /// <summary>
    /// Distance still outranks the dense-kind demotion: a near dense fact must
    /// beat a far sparse anchor, otherwise the demotion would invert the
    /// primary ordering rather than only breaking ties.
    /// </summary>
    [Fact]
    public void Observe_NearerDenseKindStillOutranksFartherSparseAnchor()
    {
        var store = new SceneObservationStore();
        var projection = new SceneObservationProjection(store);
        var nearAnimal = new SceneAffordanceSource(
            SceneAffordanceKind.Animal, "Cluck", "animal:Farm:2:1", "Farm", 2, 1, "collect_animal_product",
            SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Animal));
        var farChest = new SceneAffordanceSource(
            SceneAffordanceKind.Chest, "Chest", "chest:Farm:7,7", "Farm", 7, 7, null,
            SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Chest));
        SceneObservationInput input = new("Farm", 1, 1, new[] { farChest, nearAnimal });

        SceneObservationProjectionResult result = projection.Observe(Context(observationSequence: 1), input);

        result.Affordances.Should().HaveCount(2, "both are inside DefaultRadius (15): distances 1 and 12");
        result.Affordances[0].Kind.Should().Be("animal", "distance is the first key, so the near dense fact wins");
        result.Affordances[0].Distance.Should().BeLessThan(result.Affordances[1].Distance);
    }

    private static SceneObservationContext Context(long observationSequence) =>
        new("runtime_01", Scope, "Farm", 0, observationSequence);

    private static SceneAffordanceSource Candidate(SceneAffordanceKind kind, string identity, int x, int y) =>
        new(kind, kind == SceneAffordanceKind.Tree ? "Tree" : "Cluck", identity, "Farm", x, y, "available",
            SceneAffordanceKindWire.DefaultPriority(kind));
}
