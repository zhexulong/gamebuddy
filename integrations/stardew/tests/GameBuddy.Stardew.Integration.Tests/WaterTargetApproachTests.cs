using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE: every water tile `waterTargets` publishes is a tile a cast can be MADE FROM.
///
/// <para>
/// WHAT A CAST NEEDS, which is not what a water tile is. `fish_here` is never aimed at water: the body stands on the
/// SHORE and swings at the water from there (the engine gates the cast on the same Chebyshev-1 reach every other
/// native action uses), and the approach leg refuses <c>no_reachable_approach:&lt;x&gt;:&lt;y&gt;</c> when the ring
/// holds no tile she can stand on AND walk to. So the property of a published row is not "this is water" - it is
/// "there is one tile beside it, inside this body's own walkable component, that she may stand on".
/// </para>
///
/// <para>
/// MEASURED `round63`: 20 `fish_here` dispatches over five water tiles, every one `rejected/no_reachable_approach`
/// and not one cast. All five carried <c>standable_neighbour=unreachable;standable_tiles=1..4</c> - the ring had
/// somewhere to stand and the flood could not get there. Discovery published them anyway, because it asked a weaker
/// question ("is any CARDINAL neighbour standable") than the one the walk is refused on. That disagreement is what
/// this file makes loud: the population is what discovery PUBLISHES, and the property is re-derived here from the
/// world rather than from the filter that produced it.
/// </para>
///
/// <para>
/// THE FIXTURE IS THE SHAPE, NOT A COPY OF THE FARM, and two harness facts were measured rather than assumed
/// (2026-11-16):
/// </para>
/// <list type="bullet">
/// <item>
/// A Buildings-layer tile over a Back tile that carries <c>Water</c> makes <c>isTileFishable</c> answer FALSE
/// (<c>isOpenWater</c>), so water here is the map's own <c>Water</c> declaration and nothing else - and such a tile
/// is PASSABLE to the planner, because this process has no tilesheet index properties to refuse a step. Water is
/// therefore not the wall in these cases; the walls and the debris are <c>ResourceClump</c>s, which
/// <c>IsPlannerAdmissibleTile</c> already refuses (StardewBodyController.cs:1325-1331).
/// </item>
/// <item>
/// An OBJECT-layer occupant cannot be used at all: the planner's collision test reaches <c>Object.isPassable</c> ->
/// <c>Flooring.LoadFloorPathItemLookup</c>, which loads game content no headless fixture supplies. A shore tile
/// "covered by weeds" is therefore expressed as a shore tile carrying debris, which is the same
/// <c>IsStandableTile</c> fact and the same clearable class.
/// </item>
/// </list>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class WaterTargetApproachTests
{
    private readonly ITestOutputHelper output;

    public WaterTargetApproachTests(ITestOutputHelper output) => this.output = output;

    /// <summary>The open-shore pond: water the body can stand beside and walk to.</summary>
    private static readonly (int X, int Y)[] OpenPond = { (6, 4), (7, 4), (6, 5), (7, 5) };

    /// <summary>
    /// `round63`'s shape in one tile: (12,12) is water, its whole ring is WALL except the island (13,12), and the
    /// island's only other neighbours are wall - so the ring holds exactly one standable tile and the flood reaches
    /// neither it nor the water.
    ///
    /// <para>
    /// The walls are Buildings tiles rather than debris because that is what the planner refuses: measured 2026-11-16,
    /// a `ResourceClump` on a ring tile does NOT stop this flood (an uninitialized clump's box does not intersect), so a
    /// clump-built ring reads as reachable and would make this case assert the opposite of the defect.
    /// </para>
    /// </summary>
    private const int IslandWaterX = 12;
    private const int IslandWaterY = 12;
    private const int IslandShoreX = 13;
    private const int IslandShoreY = 12;

    private static readonly (int X, int Y)[] IslandRing =
    {
        (11, 11), (12, 11), (13, 11),
        (11, 12), (11, 13),
        (12, 13), (13, 13),
    };

    /// <summary>The island's far side, so the only land approach to it is the water tile it is the shore of.</summary>
    private static readonly (int X, int Y)[] IslandFarSide = { (14, 11), (14, 12), (14, 13) };

    /// <summary>The blocked pond: water in a walled pocket whose one open ring tile carries debris.</summary>
    private const int BlockedWaterX = 9;
    private const int BlockedWaterY = 2;

    private static readonly (int X, int Y)[] BlockedWalls =
    {
        (8, 1), (9, 1), (10, 1),
        (8, 2),
        (8, 3), (9, 3), (10, 3),
    };

    /// <summary>The one ring tile the round-trip opens, to show each drop was caused by that tile and not the map.</summary>
    private const int IslandGateX = 12;
    private const int IslandGateY = 11;
    private const int BlockedGateX = 10;
    private const int BlockedGateY = 2;

    /// <summary>
    /// THE GATE. Every published row is re-asked of the world, and the failure names the tile and which of the two
    /// facts is missing - in the words the refusal uses (`standable_neighbour=none|unreachable`).
    /// </summary>
    [Fact]
    public void EveryPublishedWaterTargetHasAShoreTheBodyCanStandOnAndWalkTo()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        BuildPonds(world);

        IReadOnlyList<BridgeWaterTarget> published = ExecutionManager.DiscoverWaterTargets(world.Actor);
        Census(world, published, out string examined, out IReadOnlyList<string> violations);

        this.output.WriteLine(examined);
        violations.Should().BeEmpty($"every published water target must be castable-from; {examined}");
    }

    /// <summary>
    /// THE FALSIFIER, BOTH WAYS. The gate is fed the real publication plus each refused shape and must go red naming
    /// that tile, so it is not an assertion that agrees with whatever discovery happens to publish.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnTheTwoShapesDiscoveryMustNotPublish()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        BuildPonds(world);
        IReadOnlyList<BridgeWaterTarget> published = ExecutionManager.DiscoverWaterTargets(world.Actor);

        Census(world, published.Append(Row(world, IslandWaterX, IslandWaterY)).ToArray(), out _, out IReadOnlyList<string> wallViolations);
        wallViolations.Should().Contain(
            $"fish_target_is_an_unstandable_tile:{IslandWaterX},{IslandWaterY}:shore_unreachable",
            "a water tile whose only shore tile is walled off is the exact shape round63 refused 20 times");

        Census(world, published.Append(Row(world, BlockedWaterX, BlockedWaterY)).ToArray(), out _, out IReadOnlyList<string> blockedViolations);
        blockedViolations.Should().Contain(
            $"fish_target_is_an_unstandable_tile:{BlockedWaterX},{BlockedWaterY}:no_standable_ring",
            "a shore ring of debris is geometry discovery must not publish past");
    }

    /// <summary>
    /// THE THREE ANSWERS, and the two drops are shown to be caused by the world: open ONE ring tile and the same
    /// water row is published on the next read. A drop that survived the world changing would be a filter keyed on
    /// the wrong fact.
    /// </summary>
    [Fact]
    public void TheTwoDropsAreCausedByTheWorldAndDissolveWhenItChanges()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        BuildPonds(world);

        HashSet<(int X, int Y)> before = Tiles(ExecutionManager.DiscoverWaterTargets(world.Actor));
        before.Should().Contain((6, 5), "the open-shore pond is castable-from and must be published");
        before.Should().NotContain((IslandWaterX, IslandWaterY), "its only shore tile is an island she cannot reach");
        before.Should().NotContain((BlockedWaterX, BlockedWaterY), "every tile beside it carries debris");

        world.RemoveResourceClump(BlockedGateX, BlockedGateY);
        world.ClearWall(IslandGateX, IslandGateY);

        HashSet<(int X, int Y)> after = Tiles(ExecutionManager.DiscoverWaterTargets(world.Actor));
        after.Should().Contain((IslandWaterX, IslandWaterY), "one cleared ring tile is a shore she can walk to");
        after.Should().Contain((BlockedWaterX, BlockedWaterY), "clearing the debris makes the shore tile standable");
    }

    /// <summary>
    /// THE REFUSAL IS STILL THE ADMISSION'S, on the game thread. Discovery publishes; the handler revalidates. A
    /// `fish_here` aimed at the walled water tile - a stale snapshot, a caller naming its own tile - is still refused,
    /// with the code and the `standable_neighbour` fact `round63` recorded, so the fix is not a publication-only
    /// claim about a decision taken somewhere else.
    /// </summary>
    [Fact]
    public void ADispatchAtTheWalledWaterIsStillRefusedByTheAdmission()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        BuildPonds(world);
        world.PutToolInPackSlot(0, typeof(FishingRod), "(T)FishingRod", upgradeLevel: 0);

        LocalExecutionReceipt receipt = Cast(world, IslandWaterX, IslandWaterY);

        receipt.State.Should().Be(ExecutionState.Rejected, "there is nowhere to stand, and no cast comes from nowhere");
        receipt.ReasonCode.Should().Be($"no_reachable_approach:{IslandWaterX}:{IslandWaterY}");
        receipt.Evidence.Should().Contain("standable_neighbour=unreachable", "the ring is not empty; it is out of reach");
        receipt.Evidence.Should().Contain("standable_tiles=1", "the island is the one tile beside it, and the count says so");
    }

    /// <summary>
    /// AND THE HALF THE FIX IS FOR: a water tile discovery still publishes is a cast the admission ADMITS, and the
    /// receipt names the shore tile she is sent to.
    /// </summary>
    [Fact]
    public void ADispatchAtAPublishedWaterIsAdmittedWithItsStandingTileNamed()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        BuildPonds(world);
        world.PutToolInPackSlot(0, typeof(FishingRod), "(T)FishingRod", upgradeLevel: 0);

        LocalExecutionReceipt receipt = Cast(world, 6, 5);

        receipt.State.Should().Be(ExecutionState.Accepted, receipt.Evidence);
        receipt.Evidence.Should().Contain("approach=adjacent;stand_at=", "the receipt names the shore tile she walks to");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The gate itself, and the fixture it reads.
    // ---------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// The property, re-derived from the world for each published row: does this water tile have a ring tile that is
    /// standable AND inside the body's own walkable component? The predicates are the production ones - the same
    /// `IsStandableTile` the leg asks and the same `SelectToolApproachTile` it chooses with - so a row can only pass
    /// this by the answer the walk would get.
    /// </summary>
    private static void Census(
        TargetFamilyWorld world,
        IReadOnlyList<BridgeWaterTarget> published,
        out string line,
        out IReadOnlyList<string> violations)
    {
        GameLocation location = world.Farm;
        Farmer actor = world.Actor;
        (int X, int Y) actorTile = ((int)actor.Tile.X, (int)actor.Tile.Y);
        Func<(int X, int Y), bool> isStandable = tile =>
            StardewBodyController.IsStandableTile(location, actor, new Vector2(tile.X, tile.Y))
            && !ExecutionManager.IsWarpBufferTile(location, tile);
        Func<(int X, int Y), bool> isReachable =
            StardewBodyController.BuildWalkableComponent(location, actor) is { } component
                ? tile => component(new Vector2(tile.X, tile.Y))
                : _ => true;

        int with = 0;
        int without = 0;
        var found = new List<string>();
        var named = new List<string>();
        foreach (BridgeWaterTarget row in published)
        {
            if (ExecutionManager.SelectToolApproachTile((row.X, row.Y), actorTile, isStandable, isReachable) is not null)
            {
                with++;
                continue;
            }

            without++;
            string reason = ApproachTileSelector.StandableCandidates(new[] { (row.X, row.Y) }, isStandable).Count > 0
                ? "shore_unreachable"
                : "no_standable_ring";
            named.Add($"{row.X},{row.Y}:{reason}");
            found.Add($"fish_target_is_an_unstandable_tile:{row.X},{row.Y}:{reason}");
        }

        if (published.Count == 0)
            found.Add("fish_target_population_empty: no water tile was examined, so nothing was proved");

        line = $"water tiles examined {published.Count} · with a standable approach {with} · without {without}"
            + (named.Count == 0 ? string.Empty : $" ({string.Join(";", named)})");
        violations = found;
    }

    private static void BuildPonds(TargetFamilyWorld world)
    {
        foreach ((int x, int y) in OpenPond)
            world.MakeWater(x, y);
        world.MakeWater(IslandWaterX, IslandWaterY);
        world.MakeWater(BlockedWaterX, BlockedWaterY);

        foreach ((int x, int y) in IslandRing.Concat(IslandFarSide).Concat(BlockedWalls))
            world.MakeWall(x, y);

        // The one open ring tile of the blocked pond, carrying the debris that stops her standing on it.
        world.PlaceResourceClump(BlockedGateX, BlockedGateY, 148, 1, 1);

        world.StandAt(3, 5);
    }

    private static LocalExecutionReceipt Cast(TargetFamilyWorld world, int x, int y)
    {
        ExecutionManager executions = world.NewExecutionManager("fish_here");
        return executions.RequestLocalFishHere(
            $"req_water_{x}_{y}",
            x,
            y,
            ExecutionManager.BuildWaterTargetId(world.Farm, x, y),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
    }

    private static BridgeWaterTarget Row(TargetFamilyWorld world, int x, int y) =>
        new(ExecutionManager.BuildWaterTargetId(world.Farm, x, y), x, y);

    private static HashSet<(int X, int Y)> Tiles(IReadOnlyList<BridgeWaterTarget> published) =>
        published.Select(row => (row.X, row.Y)).ToHashSet();
}
