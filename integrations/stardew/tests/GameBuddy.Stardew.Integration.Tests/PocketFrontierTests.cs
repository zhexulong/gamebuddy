using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// An actor ENCLOSED in a few walkable tiles, aimed at a target outside them, used to be told the DISTANCE and nothing
/// else: `no_reachable_approach:59:24` with `standable_tiles=6;blocked_by=range:reach:6`. Measured `round43`, 14
/// minutes of a live run, 59 such refusals on one `cut_grass`: her component was six tiles, the target was outside it,
/// and nothing in the refusal named the one tile she could cut to open it. A reachable state with no forward action is
/// the shape this Mod's own rules forbid.
///
/// <para>
/// So the refusal carries the FRONTIER of her own walkable component: the occupant-bearing rim tiles a published
/// `Clears` declaration can remove, ranked by the walk each one opens, in the same words `clear_step_blocked` uses -
/// `blocker_occupant`, `clears_with`, `blocker_target`, `stand_at`, `remaining_clears`. When the rim holds nothing
/// cuttable the refusal says `no_cuttable_blocker:&lt;reason&gt;` instead of dressing a distance up as an explanation.
/// </para>
///
/// <para>
/// The world is <see cref="ClearStepMoveTests.CorridorHarness"/>'s own headless farm corner: a 2x2 pocket whose ring is
/// unpriced resource clumps - the wall `BuildCorridor` already uses - with three WEEDS on the rim, and open ground
/// beyond it holding the target. Every number asserted below is read from the receipt the producer returns, so the
/// fixture never states the answer.
/// </para>
///
/// <para>
/// Two more questions are asked of the same producer here, because they are about the same sentence: the POPULATION the
/// answer was chosen from (a wall presents as many candidates as it has rim tiles, and pricing every one of them is
/// bounded), and the target's OWN ring when her own ring has no free tile.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class PocketFrontierTests
{
    /// <summary>The four tiles she can walk on: the pocket, which is the whole of her component.</summary>
    private static readonly (int X, int Y)[] PocketTiles = { (5, 6), (6, 6), (5, 7), (6, 7) };

    /// <summary>The three rim tiles a published action clears, one per side, at three different distances.</summary>
    private static readonly (int X, int Y)[] PocketWeeds = { (5, 5), (7, 6), (4, 7) };

    private static readonly (int X, int Y) ActorTile = (5, 7);

    private static readonly (int X, int Y) TargetTile = (9, 3);

    /// <summary>
    /// The measured shape. The actor is walled into four tiles, the target is eight tiles away on the other side of the
    /// rim, and the refusal must name the weed that opens the shortest way out - not the distance, not the target's own
    /// neighbours.
    ///
    /// <para>
    /// The east weed at (7,6) wins on the walk it opens: two steps from her own tile onto it, then three to a tile that
    /// reaches the target. The north weed is one step closer to her but opens onto the far side of the pocket, and the
    /// west weed opens the longest way round.
    /// </para>
    /// </summary>
    [Fact]
    public void AnEnclosedActorIsToldWhichTileOpensHerPocket()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        BuildPocket(harness);
        harness.Actor.position.Set(new Vector2(ActorTile.X * 64 + 8, ActorTile.Y * 64));

        (string code, string? evidence, string? hint) = Refuse(harness, TargetTile);

        code.Should().Be("no_reachable_approach:9:3", "the placement still has no approach, and the code still names it");
        evidence.Should().Contain("standable_neighbour=unreachable", "the ring of the target is free ground she cannot walk to");
        evidence.Should().Contain("blocker_occupant=weed@7,6",
            "the one tile that opens the shortest way out, named where it stands");
        evidence.Should().Contain("clears_with=cut_weeds", "and the published action whose Clears declaration removes it");
        evidence.Should().Contain("stand_at=6,7", "and the tile a swing reaches it from - inside her own pocket");
        evidence.Should().Contain("remaining_clears=1", "one clear, then the route is re-planned against a changed world");
        evidence.Should().NotContain("no_cuttable_blocker", "there IS something to cut, so the verdict must not say otherwise");
        hint.Should().NotBeNull();
        string keptHint = hint!;
        keptHint.Should().Contain("blocker_occupant=weed@7,6", "a settled failure keeps the hint, so the same fact must reach it");
        keptHint.Should().Contain("blocker_target=weed_", "including the id, so the next plan can aim at it without a fresh discovery call");
        keptHint.Should().Contain("stand_at=6,7");
        keptHint.Length.Should().BeLessThanOrEqualTo(BodyProgramValidation.MaximumNodeHintLength,
            "the journal and the wire both refuse a longer hint, so a hint nobody can persist is not a hint");
    }

    /// <summary>
    /// THE guarantee: the blocker the refusal names is addressable. A plan that reads `blocker_target` must be able to
    /// aim at that row without spending an observation round-trip finding out what the frame calls it, so the id is the
    /// weed family's own - `DiscoverWeedTargets` publishes a row for every weed in her component's neighbourhood, and
    /// the frontier is adjacent to that component by construction.
    /// </summary>
    [Fact]
    public void TheNamedBlockerIsAddressableInTheWeedFamily()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        BuildPocket(harness);
        harness.Actor.position.Set(new Vector2(ActorTile.X * 64 + 8, ActorTile.Y * 64));

        string? published = ExecutionManager.PublishedBlockerTargetId(harness.Actor, "weedTargets", 7, 6);
        published.Should().NotBeNull("the weed family publishes the frontier blocker, or the refusal names an id no plan can use");

        (_, string? evidence, _) = Refuse(harness, TargetTile);
        evidence.Should().Contain($"blocker_target={published}",
            "the refusal's blocker_target is that family's own id, not a second hash minted beside it");
    }

    /// <summary>
    /// The negative: a pocket walled by WATER. Nothing published removes water, so the honest answer is the reason word
    /// rather than a bare distance - `no_cuttable_blocker:water` says which wall it is in the code a settled node keeps.
    /// </summary>
    [Fact]
    public void APocketWalledByWaterSaysNoCuttableBlockerWater()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        BuildWaterPocket(harness);
        harness.Actor.position.Set(new Vector2(ActorTile.X * 64 + 8, ActorTile.Y * 64));

        (string code, string? evidence, string? hint) = Refuse(harness, TargetTile);

        code.Should().Be("no_cuttable_blocker:water", "the wall is the map's own water, and no published action removes it");
        evidence.Should().Contain("standable_neighbour=unreachable", "she is enclosed: the target is out there and she cannot walk to it");
        evidence.Should().Contain("no_cuttable_blocker=water", "the same word in the channel that outlives the refusal");
        evidence.Should().NotContain("blocker_occupant", "nothing cuttable is on the rim, so no blocker may be named");
        hint.Should().Be("no_approach;standable_neighbour=unreachable;no_cuttable_blocker=water",
            "a settled failure's evidence is withheld, so the hint is the only place this can reach her");
    }

    // -------------------------------------------------------------------------
    // What the answer was chosen from: pricing is per-candidate, and a wall has many.
    // -------------------------------------------------------------------------

    /// <summary>
    /// A hundred-tile corridor with a weed on EVERY rim tile - the row above it and the row below it - so the rim is two
    /// hundred clearable candidates. That is the weed-choked wall the receipt has to describe, and the shape whose price
    /// is measured below.
    ///
    /// <para>
    /// Two tiles beyond the wall, above the tenth column, are left free and the target stands on one of them: its own
    /// ring keeps a standable tile it cannot be walked to (<c>standable_neighbour=unreachable</c>), so this case stays
    /// about the frontier's population rather than about the ring the target's own description answers.
    /// </para>
    /// </summary>
    [Fact]
    public void AWallOfTwoHundredCandidatesNamesTheNearestAndSaysHowManyWerePriced()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create(width: 100);
        BuildLongWeedWall(harness);
        harness.Actor.position.Set(new Vector2(10 * 64 + 8, 3 * 64));

        (string code, string? evidence, _) = Refuse(harness, (10, 1));

        code.Should().Be("no_reachable_approach:10:1", $"the placement has no approach, and the code still names it - evidence={evidence}");
        evidence!.Should().Contain(
            "candidates=200;described=8",
            $"the wall holds two hundred candidates and the nearest eight were priced - got: {evidence}");
        evidence.Should().Contain(
            "blocker_occupant=weed@10,2",
            "the nearest candidate to the target is still the one the sentence names, exactly as it was when every candidate was priced");
    }

    /// <summary>
    /// The price itself, as a counted measurement rather than a claim. Each candidate costs one
    /// <see cref="ExecutionManager.StepsToActAfterClear"/> flood, and every visited tile asks the caller's walkability
    /// predicate - the one collision query the pricing spends. Two hundred candidates therefore spend two hundred
    /// futures' worth of queries, and the point of the truncation is that they no longer do: the two-hundred-candidate
    /// run and the eight-candidate run spend the SAME count, so the farther hundred and ninety-two are never consulted.
    /// </summary>
    [Fact]
    public void TheOrderPricesOnlyTheEightNearestCandidates()
    {
        (int X, int Y) actor = (0, 2);
        (int X, int Y) target = (250, 0);
        (int X, int Y)[] wall = Enumerable.Range(0, 200).Select(x => (x, 1)).ToArray();
        Func<(int X, int Y), bool> walkable = tile => tile.Y == 2 && tile.X >= 0 && tile.X < 200;

        int wide = 0;
        IReadOnlyList<ExecutionManager.FrontierPick> priced = ExecutionManager.OrderFrontierBlockers(
            actor,
            target,
            wall,
            tile =>
            {
                wide += 1;
                return walkable(tile);
            });

        priced.Select(pick => pick.Tile).Should().Equal(
            Enumerable.Range(0, 8).Select(offset => (199 - offset, 1)).ToArray(),
            "the eight nearest to the target, nearest first, and the other hundred and ninety-two not at all");
        priced.Should().OnlyContain(
            pick => pick.StepsToAct == null,
            "nothing behind this wall opens a way to the target, so null is the honest price for every candidate");

        int narrow = 0;
        ExecutionManager.OrderFrontierBlockers(
            actor,
            target,
            priced.Select(pick => pick.Tile).ToArray(),
            tile =>
            {
                narrow += 1;
                return walkable(tile);
            });

        wide.Should().BeGreaterThan(0, "a count of zero would agree with itself");
        wide.Should().Be(
            narrow,
            $"the farther candidates cost no walkability query at all: {wide} queries for two hundred candidates against {narrow} for the same eight");
    }

    // -------------------------------------------------------------------------
    // The other description: the target's OWN ring, when her own ring has no free tile.
    // -------------------------------------------------------------------------

    /// <summary>
    /// <c>standable_neighbour=none</c> used to stop at the count. "No free tile in the target's ring" is a fact about
    /// the island, not about what stands there, and the controller already answers the second question:
    /// <c>DescribeTargetApproaches</c> is the same ring the walk's own refusal publishes as <c>approaches=</c>, and it
    /// describes the four approaches without searching for anything new.
    /// </summary>
    [Fact]
    public void ARefusalWithNoStandableNeighbourDescribesTheTargetsOwnRing()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        BuildPocket(harness);
        // The target is walled in on all eight sides, so its own ring has no free tile: the `none` branch, beside the
        // pocket's rim - which still holds the weed the frontier names, so the placement keeps its own code.
        WallTheTargetRing(harness);
        harness.Actor.position.Set(new Vector2(ActorTile.X * 64 + 8, ActorTile.Y * 64));

        (string code, string? evidence, _) = Refuse(harness, TargetTile);

        code.Should().Be("no_reachable_approach:9:3", "a rim she can open keeps the placement's own name");
        evidence!.Should().Contain("standable_neighbour=none", "the target's ring has no free tile at all");
        evidence.Should().Contain(
            "described_by=target_ring", $"the refusal names which description it carries - got: {evidence}");
        evidence.Should().Contain(
            "approaches=north:clump:ResourceClump@9,2,east:clump:ResourceClump@10,3,south:clump:ResourceClump@9,4,west:clump:ResourceClump@8,3",
            $"and the geometry itself: what stands on each of the four approaches - got: {evidence}");
    }

    /// <summary>
    /// One answer, one predicate. The ring this branch publishes is asked with the REFUSAL's own standability predicate,
    /// so it cannot call a tile <c>open</c> that the sentence beside it has just counted as unstandable - the
    /// two-spellings defect that once put <c>approaches=east:open</c> beside <c>route_exists_cardinal=false</c>.
    /// </summary>
    [Fact]
    public void TheRingTheRefusalDescribesIsAskedWithTheRefusalsOwnPredicate()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.Actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));

        // The corridor row is free ground, so the harness's own standability would call the target's east and west
        // neighbours `open`. This predicate refuses them - as the tool approach does for a warp buffer - and the ring
        // published beside the refusal has to answer the same question the count did.
        (string code, string? evidence, _) = ExecutionManager.DescribeNoReachableApproach(
            (4, 3),
            (2, 3),
            _ => false,
            new[] { (4, 3) },
            location: harness.Location,
            player: harness.Actor);

        code.Should().Be("no_reachable_approach:4:3");
        evidence!.Should().Contain("standable_neighbour=none");
        evidence.Should().Contain("described_by=target_ring");
        evidence.Should().NotContain(":open", $"the ring answers the predicate the refusal used - got: {evidence}");
    }

    // -------------------------------------------------------------------------
    // The worlds: the long weed-choked wall, the walled-in target, and the pocket.
    // -------------------------------------------------------------------------

    /// <summary>Clumps on all eight tiles around the target, so its own ring holds nothing a body could stand on.</summary>
    private static void WallTheTargetRing(ClearStepMoveTests.CorridorHarness harness)
    {
        for (int dx = -1; dx <= 1; dx += 1)
        {
            for (int dy = -1; dy <= 1; dy += 1)
            {
                if (dx == 0 && dy == 0)
                    continue;
                harness.Location.resourceClumps.Add(
                    new StardewValley.TerrainFeatures.ResourceClump(0, 1, 1, new Vector2(TargetTile.X + dx, TargetTile.Y + dy)));
            }
        }
    }

    /// <summary>
    /// The long wall: a hundred-tile corridor (row y=3) whose two rim rows are weeds - two hundred clearable candidates -
    /// with unpriced clumps everywhere else, and two free tiles at (10,1)/(11,1) forming the target.
    ///
    /// <para>
    /// The free pair matters: the target's ring holds one standable tile it cannot be walked to, so this case sees the
    /// <c>standable_neighbour=unreachable</c> sentence and stays about the frontier's population rather than about the
    /// target's own ring.
    /// </para>
    /// </summary>
    private static void BuildLongWeedWall(ClearStepMoveTests.CorridorHarness harness)
    {
        GameLocation location = harness.Location;
        for (int x = 0; x < 100; x += 1)
        {
            for (int y = 0; y < 16; y += 1)
            {
                // The two rim rows are weeds and the corridor row is hers, so only the rest is wall - minus the free
                // pair the target occupies. A clump on a weed's own tile would answer `OccupantAt` for both of them
                // (the clump is read first, and an unpriced one is an unnamed wall).
                if (y is 2 or 3 or 4 || (y == 1 && x is 10 or 11))
                    continue;
                location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(0, 1, 1, new Vector2(x, y)));
            }

            harness.PlaceWeed(x, 2);
            harness.PlaceWeed(x, 4);
        }
    }

    // -------------------------------------------------------------------------
    // The pocket: four tiles inside a ring of walls, with the rim's clearable tiles
    // as weeds and the rest as the unpriced clumps `BuildCorridor` already uses.
    // -------------------------------------------------------------------------

    private static void BuildPocket(ClearStepMoveTests.CorridorHarness harness)
    {
        GameLocation location = harness.Location;
        foreach ((int X, int Y) tile in RimTiles())
        {
            if (PocketWeeds.Contains(tile))
                harness.PlaceWeed(tile.X, tile.Y);
            else
                location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(0, 1, 1, new Vector2(tile.X, tile.Y)));
        }
    }

    private static void BuildWaterPocket(ClearStepMoveTests.CorridorHarness harness)
    {
        GameLocation location = harness.Location;
        var map = location.map;
        var tileSize = new xTile.Dimensions.Size(64, 64);
        var sheet = new xTile.Tiles.TileSheet("pocket", map, "Maps/spring_outdoorsTileSheet", tileSize, tileSize);
        map.AddTileSheet(sheet);
        xTile.Layers.Layer back = map.GetLayer("Back");
        xTile.Layers.Layer buildings = map.GetLayer("Buildings");
        foreach ((int X, int Y) tile in RimTiles())
        {
            // The map's own water declaration, which is what `isWaterTile` reads, plus the engine's block: a Buildings
            // tile with neither `Shadow` nor `Passable` refuses the step (`TillSoilHarness.Wall` builds the same wall).
            var backTile = new xTile.Tiles.StaticTile(back, sheet, xTile.Tiles.BlendMode.Alpha, 0);
            backTile.Properties["Water"] = "T";
            back.Tiles[tile.X, tile.Y] = backTile;
            buildings.Tiles[tile.X, tile.Y] = new xTile.Tiles.StaticTile(buildings, sheet, xTile.Tiles.BlendMode.Alpha, 0);
        }

        location.isWaterTile(5, 5).Should().BeTrue("the fixture must be the world the classifier reads");
    }

    /// <summary>The eight-neighbour ring of the pocket, minus the pocket itself.</summary>
    private static IEnumerable<(int X, int Y)> RimTiles()
    {
        HashSet<(int X, int Y)> pocket = PocketTiles.ToHashSet();
        var rim = new HashSet<(int X, int Y)>();
        foreach ((int X, int Y) tile in pocket)
        {
            for (int dx = -1; dx <= 1; dx += 1)
            {
                for (int dy = -1; dy <= 1; dy += 1)
                {
                    (int X, int Y) neighbour = (tile.X + dx, tile.Y + dy);
                    if (!pocket.Contains(neighbour))
                        rim.Add(neighbour);
                }
            }
        }

        return rim;
    }

    /// <summary>
    /// The producer itself, asked of a live world: `TryBeginToolApproach` builds these same two facts - the leg's own
    /// standability predicate and the target as its own footprint - and hands them to this one function together with the
    /// location and the actor it is refusing for.
    /// </summary>
    private static (string Code, string? Evidence, string? Hint) Refuse(
        ClearStepMoveTests.CorridorHarness harness,
        (int X, int Y) target)
    {
        GameLocation location = harness.Location;
        Farmer actor = harness.Actor;
        (int X, int Y) actorTile = ((int)actor.Tile.X, (int)actor.Tile.Y);
        return ExecutionManager.DescribeNoReachableApproach(
            target,
            actorTile,
            tile => StardewBodyController.IsStandableTile(location, actor, new Vector2(tile.X, tile.Y)),
            new[] { target },
            location: location,
            player: actor);
    }

    // -------------------------------------------------------------------------
    // The ranking: three clearable rim tiles, three different walks.
    // -------------------------------------------------------------------------

    /// <summary>
    /// The rim's order, as arithmetic. Her corridor is the two open rows y=2 and y=3; the target sits on the open run at
    /// y=0; the rim between them is y=1, and three of its tiles are clearable. Each of the three opens the way with ONE
    /// clear, so the walk each one leaves is the only thing that separates them - and the middle tile wins because it
    /// lands inside the target's own radius first.
    /// </summary>
    [Fact]
    public void ThreeCuttableRimTilesAreOrderedByTheWalkEachOneOpens()
    {
        Func<(int X, int Y), bool> walkable = tile => tile.Y is 0 or 2 or 3;
        (int X, int Y)[] clearable = { (2, 1), (4, 1), (6, 1) };

        IReadOnlyList<ExecutionManager.FrontierPick> ordered =
            ExecutionManager.OrderFrontierBlockers((0, 3), (5, 0), clearable, walkable);

        ordered.Select(pick => pick.Tile).Should().Equal(new[] { (4, 1), (2, 1), (6, 1) },
            "the opener that lands beside the target first, then the rim tile she reaches second, then the far one");
        ordered.Select(pick => pick.StepsToAct).Should().Equal(new int?[] { 6, 7, 8 },
            "and the price of each: the steps to a tile the target can be acted on from, in the same order");
    }

    /// <summary>
    /// Fewest clears first, and that is the FIRST key: a rim tile whose removal opens nothing is ranked after every tile
    /// that opens the way, even when it is the nearest one to her. It is still named - it is still the thing in the way -
    /// but it is not the answer, because one swing at it buys nothing.
    /// </summary>
    [Fact]
    public void ARimTileThatOpensNothingIsRankedAfterTheOnesThatDo()
    {
        Func<(int X, int Y), bool> walkable = tile => tile.Y == 2 || (tile.Y == 0 && tile.X <= 2);
        (int X, int Y)[] clearable = { (6, 1), (0, 1), (1, 1) };

        IReadOnlyList<ExecutionManager.FrontierPick> ordered =
            ExecutionManager.OrderFrontierBlockers((6, 2), (0, 0), clearable, walkable);

        ordered.Select(pick => pick.Tile).Should().Equal(new[] { (1, 1), (0, 1), (6, 1) },
            "the nearer target-side opener first, then the other one, and the dead end last despite being next to her");
        ordered[2].StepsToAct.Should().BeNull("one clear at (6,1) reaches nothing, and null says so rather than zero");
    }
}
