using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One fact, two readers: what stands on a tile is answered by the rectangle query (<see cref="TileAreaQuery"/>, the
/// row a planner reads) and by the pass's own row (<see cref="FarmhandForEachFarmWorld.ReadRow"/>, the row
/// <c>where.occupant</c> is decided against). A filter written against one has to be writable against the other, so the
/// two answers for the same tile must be the SAME WORD.
///
/// <para>
/// The population is a fixture that carries one tile per word the loop names - a weed, a rock, a grass tuft, a tree, a
/// stump, a crop, empty soil, a resource clump and the clump's second tile - read through BOTH paths over the same
/// rectangle. A zero population is answered by name rather than passing, because an agreement check over no tiles
/// agrees with itself.
/// </para>
/// </summary>
[Trait("kind", "tile-occupant-vocabulary")]
public sealed class TileOccupantVocabularyTests
{
    private const int Revision = 7;

    /// <summary>The rectangle every case reads, sized to hold the fixture's ten tiles.</summary>
    private const int OriginX = 3;
    private const int OriginY = 4;
    private const int Width = 5;
    private const int Height = 2;

    /// <summary>
    /// The two paths over the same rectangle, tile by tile.
    ///
    /// The published word is read out of the tile-area answer and the loop's word out of the row the pass builds for
    /// the same coordinate, so a tile the two disagree about is named with its coordinate and both words.
    /// </summary>
    [Fact]
    public void TheTileRowPublishesTheWordTheLoopFiltersOn()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        Populate(world);

        IReadOnlyList<string> findings = Findings(BothPaths(world, row => row.OccupantKind));

        findings.Should().BeEmpty(
            "a filter written against the rectangle's word must claim the rows the loop's own filter claims, and: {0}",
            string.Join(" ", findings));
    }

    /// <summary>
    /// The two occupant fields are two different vocabularies, and the tiles above are where they part: a weed is the
    /// engine's `object` and the loop's `weed`, and a crop tile is `none` there because soil is not an occupant while
    /// here it is the crop. A rename that collapsed the two fields would make these equal, and a filter written against
    /// the engine's word would then be silently right on some tiles and wrong on others.
    /// </summary>
    [Fact]
    public void TheEngineTypeNameIsNotTheFilterVocabulary()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        SeedFloorPathLookup();
        Populate(world);

        IReadOnlyList<TileOccupantReading> tiles = BothPaths(world, row => row.Occupant);

        tiles.Should().Contain(
            tile => tile.X == 3 && tile.Y == 4 && tile.Published != tile.Loop,
            "a weed is an engine Object and the loop's `weed`");
        tiles.Should().Contain(
            tile => tile.X == 4 && tile.Y == 5 && tile.Published != tile.Loop,
            "a crop tile is `none` to the engine's occupant walk because soil is not an occupant");
    }

    /// <summary>
    /// The guard itself, fed a disagreement on purpose: the message names the tile and BOTH words, so a reader can tell
    /// which path said what without re-running either.
    /// </summary>
    [Fact]
    public void ADisagreementNamesTheTileAndBothWords()
    {
        IReadOnlyList<string> findings = Findings(new[] { new TileOccupantReading(12, 9, "object", "weed") });

        findings.Should().Equal("occupant_vocabulary_disagrees:12,9:object:weed");
    }

    /// <summary>
    /// The two paths agreeing is the passing arm: without it the guard above could be red for a reason that never
    /// depends on the words it compares.
    /// </summary>
    [Fact]
    public void AnAgreementIsQuiet()
    {
        Findings(new[] { new TileOccupantReading(1, 2, "weed", "weed"), new TileOccupantReading(2, 2, "none", "none") })
            .Should()
            .BeEmpty();
    }

    /// <summary>No tiles is a blocked reading, never a pass.</summary>
    [Fact]
    public void NoTilesIsRefusedByName()
    {
        Findings(Array.Empty<TileOccupantReading>()).Should().Equal("occupant_vocabulary_unmeasured");
    }

    /// <summary>
    /// The fixture: one tile per word, all inside <see cref="Width"/> x <see cref="Height"/> at the rectangle's origin.
    ///
    /// The clump is two tiles wide and two tall with its origin at (5,5), so (5,5) is the clump and (6,5) is the tile
    /// the engine's own rectangle walk also calls a boulder - a second reader's answer the loop deliberately does not
    /// share, and therefore the tile that proves this check reads the loop's word rather than the engine's.
    /// </summary>
    private static void Populate(TargetFamilyCompletenessTests.TargetFamilyWorld world)
    {
        world.PlaceWeed(3, 4);
        world.PlaceRock(4, 4, durability: 2);
        world.PlaceGrass(5, 4);
        world.PlaceTree(6, 4);
        world.PlaceStump(7, 4);
        world.PlaceEmptyHoeDirt(3, 5);
        world.PlaceDeadCrop(4, 5);
        world.PlaceResourceClump(
            x: 5,
            y: 5,
            parentSheetIndex: StardewValley.TerrainFeatures.ResourceClump.boulderIndex,
            width: 2,
            height: 2);
    }

    /// <summary>
    /// ROUND58'S STRIP, IN THREE TILES. The measure that produced this vocabulary was a row of clutter the companion could
    /// not work: the settlement read <c>no_row_matched_where:occupant_in_stone:none_tree_crop_object</c> and then
    /// <c>no_published_action_clears:object</c>, because every object that was not `(O)2` or a weed was called `object` -
    /// a word no declaration answers.
    ///
    /// <para>
    /// The three tiles below hold the SAME ID with two different predicates' answers, which is the point: `(O)450` named
    /// `Stone` is the engine's breakable stone and `(O)450` named `Twig` is the engine's twig litter, and the word follows
    /// the predicate - not the id this file happens to pass. `(O)2` is here as the id the old classifier hard-coded, so the
    /// case cannot pass by being narrowed back to it.
    /// </para>
    /// </summary>
    [Fact]
    public void TheStripIsNamedByThePredicateThatClearsItRatherThanByItsItemId()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PlaceObjectAt(3, 4, "(O)450", name: "Stone", category: -999).MinutesUntilReady = 2;
        StardewValley.Object twig = world.PlaceObjectAt(4, 4, "(O)450", name: "Twig", category: -999);
        world.PlaceObjectAt(5, 4, "(O)2", name: "Stone", category: -999);

        TileOccupancy.Of(world.Farm, 3, 4).Should().Be(TileOccupantKind.Stone,
            "the engine's breakable stone is a category and a name (`Object.IsBreakableStone`), not the id `(O)2`");
        twig.IsTwig().Should().BeTrue("the fixture has to be the engine's twig, or this case measures nothing");
        TileOccupancy.Of(world.Farm, 4, 4).Should().Be(TileOccupantKind.Twig,
            "twig litter is its own word because it is its own tool: an axe, through the one action that declares it");
        TileOccupancy.Of(world.Farm, 5, 4).Should().Be(TileOccupantKind.Stone);

        ClearingActionSurface.ClearersOf(TileOccupantKind.Stone, FarmhandActionCatalog.Registrations)
            .Select(offer => offer.ActionId).Should().Contain("break_rock");
        ClearingActionSurface.ClearersOf(TileOccupantKind.Twig, FarmhandActionCatalog.Registrations)
            .Select(offer => offer.ActionId).Should().Contain("remove_placed_item",
                "a twig's own clearance is the axe swing remove_placed_item declares - the answer round58 never got");
    }

    /// <summary>
    /// A kind no action opens a route through is DECLARED, not silently absent: `object` and `bush` both answer with a
    /// reason, so a planner is told what the tile needs instead of being handed a word with no action behind it.
    /// </summary>
    [Fact]
    public void TheKindsNothingClearsCarryAReason()
    {
        foreach (string kind in new[] { TileOccupantKind.OtherObject, TileOccupantKind.Bush, TileOccupantKind.Terrain, TileOccupantKind.FruitTree, TileOccupantKind.ResourceClump })
        {
            ClearingActionSurface.ClearersOf(kind, FarmhandActionCatalog.Registrations).Should().BeEmpty(
                $"{kind} is declared unclearable, so no declaration may name it");
            TileOccupantKind.UnclearableReason(kind).Should().NotBeNullOrWhiteSpace($"{kind} has to say why");
        }
    }

    /// <summary>
    /// The BUSH, through both readers: it is a large terrain feature, so the rectangle walk has to see the collection the
    /// route refusal already reads - otherwise one tile is `bush` to the refusal and `none` to the row a filter is written
    /// against.
    /// </summary>
    [Fact]
    public void ABushIsTheSameWordToBothReaders()
    {
        using TargetFamilyCompletenessTests.TargetFamilyWorld world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.PlaceHarvestableBush(7, 4);

        IReadOnlyList<string> findings = Findings(BothPaths(world, row => row.OccupantKind));

        findings.Should().BeEmpty("one tile, one word: {0}", string.Join(" ", findings));
        TileAreaQuery.Answer(world.Actor, OriginX, OriginY, Width, Height, Revision).Rows!
            .Should().Contain(row => row.X == 7 && row.Y == 4 && row.OccupantKind == TileOccupantKind.Bush,
                "the bush tile is named in the vocabulary the refusal uses (`no_published_action_clears:bush`)");
    }

    /// <summary>One tile as each path answered it.</summary>
    internal readonly record struct TileOccupantReading(int X, int Y, string Published, string Loop);

    /// <summary>
    /// Every disagreement between the two answers, in the form a reader can act on, or the blocked reading when there
    /// are no tiles to compare.
    /// </summary>
    internal static IReadOnlyList<string> Findings(IReadOnlyList<TileOccupantReading> tiles)
    {
        if (tiles.Count == 0) return new[] { "occupant_vocabulary_unmeasured" };
        return tiles
            .Where(tile => !string.Equals(tile.Published, tile.Loop, StringComparison.Ordinal))
            .Select(tile => $"occupant_vocabulary_disagrees:{tile.X},{tile.Y}:{tile.Published}:{tile.Loop}")
            .ToList();
    }

    /// <summary>
    /// <c>Object.isPassable</c> asks <c>IsFloorPathItem</c> (Object.cs:6075/:6082), which builds its lookup from
    /// <c>Game1.floorPathData</c> (Flooring.cs:130) - a cache filled at startup. An uninitialized <c>Game1</c> leaves it
    /// null, so ONE placed object made every collision read throw. Empty is the honest value: this world declares no
    /// flooring, so no object is a floor path. <c>TillSoilHarness</c> seeds it for the same reason.
    /// </summary>
    private static void SeedFloorPathLookup() =>
        Game1.floorPathData ??= new Dictionary<string, StardewValley.GameData.FloorsAndPaths.FloorPathData>(StringComparer.Ordinal);

    private static IReadOnlyList<TileOccupantReading> BothPaths(
        TargetFamilyCompletenessTests.TargetFamilyWorld world,
        Func<BridgeTileAreaRow, string> read)
    {
        BridgeTileAreaQueryResult answer = TileAreaQuery.Answer(world.Actor, OriginX, OriginY, Width, Height, Revision);
        answer.Status.Should().Be("answered");
        answer.Rows.Should().NotBeNull("an answered rectangle carries a row per tile");
        IReadOnlyList<BridgeTileAreaRow> rows = answer.Rows!;

        var pass = new FarmhandForEachFarmWorld(
            world.Farm,
            new HashSet<string>(StringComparer.Ordinal),
            () => false);

        return rows
            .Select(row =>
            {
                FarmhandForEachRow? loopRow = pass.ReadRow(row.X, row.Y, row.X - OriginX, row.Y - OriginY);
                loopRow.Should().NotBeNull("every tile of the rectangle is on the map");
                return new TileOccupantReading(
                    row.X,
                    row.Y,
                    read(row),
                    loopRow!.Fields[FarmhandForEachHealing.OccupantField].Text ?? string.Empty);
            })
            .ToList();
    }
}
