using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The ground underfoot is a separate axis of fact from an affordance: an
/// affordance says what can be done on a tile, ground says what the tile IS.
/// It is read from the map's Back-layer `Type` property, which is the same signal
/// the engine uses for footstep sounds (GameLocation.cs:7560) and pathfinding
/// weights (PathFindController.cs), so it is a native fact rather than a label
/// invented by the Mod.
///
/// Two contracts are pinned here: the summary must compress a uniform region to
/// one dominant entry plus bounded deviations, and ground must never compete with
/// affordances for the 20-item budget.
/// </summary>
public sealed class SceneObservationGroundTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    [Theory]
    [InlineData("Grass", "grass")]
    [InlineData("Dirt", "dirt")]
    [InlineData("Stone", "stone")]
    [InlineData("Wood", "wood")]
    [InlineData("Other", "other")]
    public void SceneGroundKindWire_RoundTripsEveryEngineNamedSurface(string kindName, string wireValue)
    {
        SceneGroundKind kind = Enum.Parse<SceneGroundKind>(kindName);
        SceneGroundKindWire.IsDefined(kind).Should().BeTrue();
        SceneGroundKindWire.ToWireValue(kind).Should().Be(wireValue);
    }

    /// <summary>
    /// Exactly the four values the engine's own switches name map to themselves;
    /// anything else is `other`. Pinning this stops a future edit from silently
    /// classifying an unnamed surface as grass.
    /// </summary>
    [Theory]
    [InlineData("Grass", "Grass")]
    [InlineData("Dirt", "Dirt")]
    [InlineData("Stone", "Stone")]
    [InlineData("Wood", "Wood")]
    [InlineData("grass", "Other")] // engine values are case-sensitive
    [InlineData("Sand", "Other")]
    [InlineData("", "Other")]
    [InlineData(null, "Other")]
    public void SceneGroundKindWire_FromBackType_OnlyAcceptsTheEngineValues(string? backType, string expectedKindName)
    {
        SceneGroundKindWire.FromBackType(backType)
            .Should().Be(Enum.Parse<SceneGroundKind>(expectedKindName));
    }

    [Fact]
    public void Observe_UniformGround_ReportsOneDominantEntryAndNoExceptions()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());
        SceneGroundTile[] ground = Enumerable.Range(0, 49)
            .Select(index => new SceneGroundTile(1 + (index % 7), 1 + (index / 7), SceneGroundKind.Grass))
            .ToArray();
        SceneObservationInput input = new("Farm", 1, 1, Array.Empty<SceneAffordanceSource>(), ground);

        SceneObservationProjectionResult result = projection.Observe(Context(1), input);

        result.IsValid.Should().BeTrue();
        result.Ground.Should().NotBeNull();
        result.Ground!.DominantKind.Should().Be("grass");
        result.Ground.DominantTileCount.Should().Be(49);
        result.Ground.ScannedTileCount.Should().Be(49);
        result.Ground.Exceptions.Should().BeEmpty("a uniform region must cost one entry, not one per tile");
        result.Ground.OmittedExceptionTileCount.Should().Be(0);
        result.TruncatedReason.Should().NotBe("ground_limit");
    }

    [Fact]
    public void Observe_MixedGround_ListsOnlyTheDeviations()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());
        var ground = new List<SceneGroundTile>();
        for (int y = 1; y <= 7; y++)
        {
            for (int x = 1; x <= 7; x++)
            {
                // 3 watered-dirt tiles inside a grass field.
                bool tilled = (x, y) is (2, 2) or (3, 2) or (2, 3);
                ground.Add(new SceneGroundTile(x, y, tilled ? SceneGroundKind.Dirt : SceneGroundKind.Grass));
            }
        }
        SceneObservationInput input = new("Farm", 1, 1, Array.Empty<SceneAffordanceSource>(), ground);

        SceneObservationProjectionResult result = projection.Observe(Context(1), input);

        result.Ground!.DominantKind.Should().Be("grass");
        result.Ground.DominantTileCount.Should().Be(46);
        result.Ground.Exceptions.Should().HaveCount(3);
        result.Ground.Exceptions.Select(tile => (tile.TileX, tile.TileY))
            .Should().BeEquivalentTo(new[] { (2, 2), (3, 2), (2, 3) });
        result.Ground.Exceptions.Should().OnlyContain(tile => tile.Kind == "dirt");
    }

    /// <summary>
    /// The engine's own `default` arm treats an unnamed surface as neither grass
    /// nor stone, so `other` must still be countable rather than dropped: the
    /// Agent needs to distinguish "mostly unknown" from "mostly grass".
    /// </summary>
    [Fact]
    public void Observe_UnnamedSurface_IsCountedAsOtherAndStillTotals()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());
        // `other` must OUTNUMBER the named surface here, otherwise this test passes
        // even with the exclusion removed (stone would win the vote on count alone)
        // and would pin nothing.
        var ground = new List<SceneGroundTile>();
        for (int index = 0; index < 5; index++)
            ground.Add(new SceneGroundTile(index, 1, SceneGroundKind.Other));
        for (int index = 0; index < 3; index++)
            ground.Add(new SceneGroundTile(10 + index, 1, SceneGroundKind.Stone));
        SceneObservationInput input = new("Mine", 1, 1, Array.Empty<SceneAffordanceSource>(), ground);

        SceneObservationProjectionResult result = projection.Observe(Context(1), input);

        // `other` is never chosen as dominant when a named surface exists, even
        // when it is the plurality, because "Mostly: unknown" tells the Agent less
        // than naming the stone underfoot.
        result.Ground!.DominantKind.Should().Be("stone");
        result.Ground.DominantTileCount.Should().Be(3);
        result.Ground.ScannedTileCount.Should().Be(8);
        result.Ground.Exceptions.Should().HaveCount(5);
        result.Ground.Exceptions.Should().OnlyContain(tile => tile.Kind == "other");
    }

    [Fact]
    public void Observe_AllUnnamedSurface_FallsBackToOtherInsteadOfThrowing()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());
        SceneGroundTile[] ground = Enumerable.Range(0, 4)
            .Select(index => new SceneGroundTile(index, 1, SceneGroundKind.Other))
            .ToArray();
        SceneObservationInput input = new("Cellar", 1, 1, Array.Empty<SceneAffordanceSource>(), ground);

        SceneObservationProjectionResult result = projection.Observe(Context(1), input);

        result.IsValid.Should().BeTrue();
        result.Ground!.DominantKind.Should().Be("other");
        result.Ground.DominantTileCount.Should().Be(4);
        result.Ground.Exceptions.Should().BeEmpty();
    }

    /// <summary>
    /// Ground is a different axis, so it must not consume affordance slots: a
    /// radius packed with trees must still publish all 20 affordances AND the
    /// ground summary.
    /// </summary>
    [Fact]
    public void Observe_GroundDoesNotCompeteWithAffordancesForTheItemBudget()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());
        SceneAffordanceSource[] anchors = Enumerable.Range(0, 20)
            .Select(index => new SceneAffordanceSource(
                SceneAffordanceKind.Machine,
                $"Machine {index:00}",
                $"machine_{index:00}",
                "Farm",
                1 + (index % 5),
                1 + (index / 5),
                "machine_inspect",
                SceneAffordanceKindWire.DefaultPriority(SceneAffordanceKind.Machine)))
            .ToArray();
        SceneGroundTile[] ground = Enumerable.Range(0, 25)
            .Select(index => new SceneGroundTile(index, 9, SceneGroundKind.Grass))
            .ToArray();
        SceneObservationInput input = new("Farm", 1, 1, anchors, ground);

        SceneObservationProjectionResult result = projection.Observe(Context(1), input);

        result.Affordances.Should().HaveCount(SceneObservationProjection.MaximumAffordances);
        result.Ground.Should().NotBeNull();
        result.Ground!.DominantKind.Should().Be("grass");
        result.PayloadUtf8Bytes.Should().BeLessOrEqualTo(SceneObservationProjection.MaximumPayloadUtf8Bytes);
    }

    /// <summary>
    /// Deviations are bounded so one noisy region cannot inflate the payload.
    /// Omission is reported rather than hidden.
    /// </summary>
    [Fact]
    public void Observe_ExcessiveDeviations_AreBoundedAndReportedAsGroundLimit()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());
        // 60 grass tiles keep grass dominant; 40 stone tiles are the deviations.
        var ground = new List<SceneGroundTile>();
        for (int index = 0; index < 60; index++)
            ground.Add(new SceneGroundTile(index % 60, 0, SceneGroundKind.Grass));
        for (int index = 0; index < 40; index++)
            ground.Add(new SceneGroundTile(100 + index, 0, SceneGroundKind.Stone));
        SceneObservationInput input = new("Farm", 0, 0, Array.Empty<SceneAffordanceSource>(), ground);

        SceneObservationProjectionResult result = projection.Observe(Context(1), input);

        result.IsValid.Should().BeTrue();
        result.Ground!.DominantKind.Should().Be("grass");
        result.Ground.DominantTileCount.Should().Be(60);
        result.Ground.Exceptions.Should().HaveCount(SceneObservationProjection.MaximumGroundExceptions);
        result.Ground.OmittedExceptionTileCount.Should().Be(40 - SceneObservationProjection.MaximumGroundExceptions);
        result.IsPartial.Should().BeTrue("omitting reported deviations is a real truncation");
        result.TruncatedReason.Should().Be("ground_limit");
    }

    /// <summary>
    /// A caller that did not scan ground must produce `null`, not a fabricated
    /// summary: "not reported" and "no ground" are different facts.
    /// </summary>
    [Fact]
    public void Observe_WithoutGroundScan_ReportsNullGround()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());
        SceneObservationInput input = new("Farm", 1, 1, Array.Empty<SceneAffordanceSource>());

        SceneObservationProjectionResult result = projection.Observe(Context(1), input);

        result.IsValid.Should().BeTrue();
        result.Ground.Should().BeNull();
        result.TruncatedReason.Should().NotBe("ground_limit");
    }

    private static SceneObservationContext Context(long observationSequence) =>
        new("runtime_01", Scope, "Farm", 0, observationSequence);
}
