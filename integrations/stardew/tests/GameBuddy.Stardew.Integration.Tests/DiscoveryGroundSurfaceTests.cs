using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// EVERY ROW A FAMILY PUBLISHES ABOUT A TILLED TILE STATES WHICH GROUND IT IS — and ONE reading answers them all.
///
/// <para>
/// WHY A TEST AND NOT ONLY THE SCHEMA. `check-stardew-observation-gap` reads
/// <c>protocol/bridge-v1.schema.json</c>, so it can see that a family's row DECLARES <c>surface</c>; it cannot see whether
/// the producer fills it. This drives the real <c>Discover*</c> methods over a world built the way the engine builds one,
/// and compares what they published against the reading's own answer for the same tile — one authority, two crossings, so
/// a producer that pasted a second "is this paved" spelling instead of <see cref="GroundSurface"/> would disagree here.
/// </para>
///
/// <para>
/// WHICH FAMILIES. The four a fixture world can build without performing an action AND without item content data: an
/// empty <c>HoeDirt</c> (cleared), a waterable crop (watered), a DEAD crop (the scythe's clear terminal, which needs no
/// <c>ItemRegistry</c> row) and a fertilizable tile (fertilized). Two are published by families this world cannot drive:
/// <c>harvestTargets</c> and a living <c>scytheCropTargets</c> row both resolve their harvest item through
/// <c>ItemRegistry.Create</c>, which needs <c>Data/Objects</c> this headless world does not load, and
/// <c>artifactSpotResultTargets</c> is published by <c>dig_artifact_spot</c> alone - its reading is taken where the row is
/// minted (<c>ExecuteDigArtifactSpot</c>) and the dig is driven by its own suite.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
[Trait("kind", "discovery-ground")]
public sealed class DiscoveryGroundSurfaceTests
{
    private readonly ITestOutputHelper output;

    public DiscoveryGroundSurfaceTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryTilledTileFamilyPublishesTheGroundTheOneReadingMeasured()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world =
            TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(4, 4);
        world.PlaceEmptyHoeDirt(2, 3);
        world.PlaceWaterableCrop(3, 3);
        world.PlaceDeadCrop(5, 3);
        world.PlaceEmptyHoeDirt(6, 3);
        PutInPack(world, slot: 20, "(O)368", "Basic Fertilizer", StardewValley.Object.fertilizerCategory);

        // ONE instance for the whole observation, which is the lifetime the snapshot gives it: a second reading per family
        // would price the same tile twice and could answer differently for it.
        GroundSurface surfaces = GroundSurface.Of(world.Farm);
        var exclusions = new DiscoveryExclusionRecorder();

        var published = new List<(string Family, int X, int Y, string Surface, string? Owner)>();
        foreach (BridgeClearHoeDirtTarget row in FarmhandTargetDiscovery.DiscoverClearHoeDirtTargets(world.Actor, surfaces))
            published.Add(("clearHoeDirtTargets", row.X, row.Y, row.Surface, row.SurfaceOwner));
        foreach (BridgeCropTarget row in FarmhandTargetDiscovery.DiscoverCropTargets(world.Actor, exclusions, surfaces))
            published.Add(("cropTargets", row.X, row.Y, row.Surface, row.SurfaceOwner));
        foreach (BridgeScytheCropTarget row in FarmhandTargetDiscovery.DiscoverScytheCropTargets(world.Actor, surfaces))
            published.Add(("scytheCropTargets", row.X, row.Y, row.Surface, row.SurfaceOwner));
        foreach (BridgeFertilizerTarget row in FarmhandTargetDiscovery.DiscoverFertilizerTargets(world.Actor, surfaces))
            published.Add(("fertilizerTargets", row.X, row.Y, row.Surface, row.SurfaceOwner));

        published.Select(row => row.Family).Distinct().Should().BeEquivalentTo(
            new[]
            {
                "clearHoeDirtTargets",
                "cropTargets",
                "scytheCropTargets",
                "fertilizerTargets",
            },
            "every family this world can build against publishes a row, or the crossings below assert nothing about it");
        published.Should().OnlyContain(row => !string.IsNullOrWhiteSpace(row.Surface));
        foreach ((string family, int x, int y, string surface, string? owner) in published)
        {
            surface.Should().Be(
                surfaces.Describe(x, y),
                $"{family} at {x},{y} must state the same reading, not a second spelling of it");
            owner.Should().Be(surfaces.At(x, y).Owner);
        }

        // THE COST, from this run: one measurement per tile however many families asked, and the line that says so.
        string cost = surfaces.CostLine();
        this.output.WriteLine($"{published.Count} row(s) over {surfaces.TilesMeasured} measured tile(s): {cost}");
        cost.Should().StartWith(GroundSurface.CostLinePrefix);
        surfaces.TilesMeasured.Should().Be(
            published.Select(row => (row.X, row.Y)).Distinct().Count(),
            "eight families share the reading, so the tiles measured are exactly the tiles they named");

        // THE WARM PRICE, from the same run. The line above paid the JIT: the first call into the engine properties this
        // reading touches costs a fresh process ~100 ms that the game never pays, because those paths run every frame.
        // One observation over a 13x13 window is the number a game-thread hitch would be blamed on, so it is measured
        // here on a second instance rather than inferred from the first.
        GroundSurface observation = GroundSurface.Of(world.Farm);
        for (int x = 0; x < 13; x++)
            for (int y = 0; y < 13; y++)
                observation.At(x, y);
        string warm = observation.CostLine();
        this.output.WriteLine($"one 13x13 observation: {warm}");
        observation.TilesMeasured.Should().Be(169, "the window is the one `soilTiles` walks");
        warm.Should().Contain("tiles=169");
    }

    /// <summary>One item in the actor's pack, at a slot the projection reads: the fertilizer family pairs a tile with a stack.</summary>
    private static void PutInPack(
        TargetFamilyCompletenessTests.TargetFamilyWorld world,
        int slot,
        string qualifiedItemId,
        string name,
        int category)
    {
        while (world.Actor.Items.Count <= slot) world.Actor.Items.Add(null!);
        world.Actor.Items[slot] = TargetFamilyCompletenessTests.TargetFamilyWorld.PlacedObject(qualifiedItemId, name, category);
    }
}
