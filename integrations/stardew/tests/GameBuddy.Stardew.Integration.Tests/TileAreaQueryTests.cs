using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The rectangle query: a task with a SHAPE can be planned in one round trip.
///
/// <para>
/// MEASURED round42, live: the companion was asked to till a 3-wide, 20-long strip and the snapshot's soil family -
/// a square window around the actor with a cap - published a 7x8 blob at 55% density. She planned from the square in
/// 21 scripts of two or three nodes, re-observed every three or four tiles, and inferred her own work from the list's
/// silence. Nothing in her hands could answer "what is at (x..x+2, y..y+19)", which is the prerequisite this unit is.
/// </para>
///
/// <para>
/// Two things are pinned here beyond the happy path. The cross-check (<see cref="TheTillableRowsAreTheSoilDiscoverysOwnRows"/>)
/// asks the EXISTING authority - <c>ExecutionManager.DiscoverSoilTiles</c> - what the same ground is, so a second
/// re-implementation of the tillable predicate fails the suite instead of shipping; and the refusals are checked for
/// NAMING (the limit, the requested size, the corner), because a bound that refuses without saying what it refused is
/// a bound the caller can only discover by bisecting.
/// </para>
/// </summary>
[Trait("kind", "tile-area")]
public sealed class TileAreaQueryTests
{
    /// <summary>The revision the answer echoes back; the query creates no revision of its own.</summary>
    private const int Revision = 41;

    /// <summary>
    /// The unit's own case: 3 wide by 20 long, the strip the round42 run was asked for.
    ///
    /// The map is 20x20, so a 20-long rectangle fits exactly one column of the fixture; every tile in it is dug, so a
    /// row that is not tillable says the query read the wrong ground rather than that the ground is hard.
    /// </summary>
    [Fact]
    public void AThreeByTwentyRectanglePublishesEveryTileItWasAskedAbout()
    {
        using TillSoilRefusalNamingTests.TillSoilHarness harness = TillSoilRefusalNamingTests.TillSoilHarness.Create();
        for (int x = 4; x <= 6; x++)
            for (int y = 0; y < 20; y++)
                harness.SetDiggable(x, y);

        BridgeTileAreaQueryResult answer = TileAreaQuery.Answer(Game1.player, 4, 0, 3, 20, Revision);

        answer.Status.Should().Be("answered");
        answer.Detail.Should().BeNull();
        answer.Rows.Should().NotBeNull();
        answer.Rows!.Should().HaveCount(60, "3 x 20 is the strip the run was asked for, and a blob of 31 is the defect");
        answer.Rows!.Select(row => (row.X, row.Y)).Should().Equal(
            from y in Enumerable.Range(0, 20)
            from x in Enumerable.Range(4, 3)
            select (x, y),
            "the rows are the rectangle in reading order, so a caller can address them without re-sorting");
        answer.Rows!.Should().OnlyContain(row => row.Tillable, "every tile of the fixture is diggable ground");
        answer.Rows!.Should().OnlyContain(row => row.Occupant == "none", "nothing is stored on these tiles");
        answer.Rows!.Should().OnlyContain(row => !row.Hoed && !row.Watered && !row.Crop);
        (answer.Rows!.Count + answer.Omitted).Should().Be(
            3 * 20,
            "published plus stated-omitted is the whole rectangle, so no bound can truncate in silence");
        answer.Location.Should().Be("ProbeTillSoil", "the answer names the location it describes");
        answer.Revision.Should().Be(Revision, "the reader can tell which snapshot of the world this rectangle describes");
        answer.AreaLimit.Should().Be(TileAreaQuery.AreaLimit, "the answer states the bound it enforced");
    }

    /// <summary>
    /// The cross-check against the EXISTING authority: <c>DiscoverSoilTiles</c> and this query must agree about which
    /// tiles the Hoe admits.
    ///
    /// <para>
    /// The discovery's window is 13x13 around the actor and its cap is 64 rows, so the ground outside the window is
    /// planted deliberately: it is the whole reason this query exists, and the case proves the two channels describe the
    /// same predicate while covering different ground. A hand-rolled second predicate that reads, say, only the map's
    /// `Diggable` property would answer `true` for a tile with a chest on it, and this case fails.
    /// </para>
    /// </summary>
    [Fact]
    public void TheTillableRowsAreTheSoilDiscoverysOwnRows()
    {
        using TillSoilRefusalNamingTests.TillSoilHarness harness = TillSoilRefusalNamingTests.TillSoilHarness.Create();
        harness.PlaceActorAt(8, 10);
        int radius = ExecutionManager.TargetDiscoveryRadius;
        // A block inside the discovery window, well under its 64-row cap so the published list is complete.
        for (int x = 3; x <= 12; x++)
            for (int y = 6; y <= 9; y++)
                harness.SetDiggable(x, y);
        // And four tiles OUTSIDE the window: the strip a plan needs and the square cannot carry.
        var beyondTheWindow = new List<(int X, int Y)> { (16, 5), (17, 5), (16, 6), (17, 6) };
        foreach ((int x, int y) in beyondTheWindow) harness.SetDiggable(x, y);
        // Two tiles inside the block that are diggable ground and still not hoeable: a placed object and water. They are
        // what a hand-rolled "the map says Diggable" check would call tillable, so the cross-check below has to see them
        // excluded by BOTH channels to mean anything.
        harness.PlaceObject(5, 6, new StardewValley.Objects.Chest());
        harness.SetWater(6, 6);

        IReadOnlyList<BridgeSoilTile> discovered = ExecutionManager.DiscoverSoilTiles(Game1.player, out int omitted);
        omitted.Should().Be(0, "the block inside the window is far below the 64-row cap, so the discovery published it all");
        int windowEast = 8 + radius;
        discovered.Select(row => (row.X, row.Y)).Should().NotContain(
            beyondTheWindow,
            "the discovery window ends at x=" + windowEast + ", so the ground east of it is not in the published list");

        var insideTheWindow = new HashSet<(int X, int Y)>(discovered.Select(row => (row.X, row.Y)));
        var asked = new List<(int X, int Y)>();
        (int X, int Y, int W, int H)[] rectangles =
        {
            // The discovery window (13x13 = 169 tiles) is wider than one answer may be, so it is asked in two.
            (2, 4, 13, 7),
            (2, 11, 13, 6),
            // The ground east of the window, in one more rectangle: 100 tiles is the bound, and this is 16.
            (15, 4, 4, 4),
        };
        foreach ((int x, int y, int w, int h) in rectangles)
        {
            BridgeTileAreaQueryResult answer = TileAreaQuery.Answer(Game1.player, x, y, w, h, Revision);
            answer.Status.Should().Be("answered", answer.Detail);
            answer.Rows!.Where(row => row.Tillable).Select(row => (row.X, row.Y)).ToList().ForEach(asked.Add);
        }

        asked.Should().Contain(insideTheWindow, "every tile the soil discovery calls tillable is tillable here");
        asked.Where(tile => !insideTheWindow.Contains(tile)).Should().BeEquivalentTo(
            beyondTheWindow,
            "the query reaches the ground the square window cannot, which is why it exists");
        asked.Should().HaveCount(insideTheWindow.Count + beyondTheWindow.Count);
    }

    /// <summary>
    /// Over the area bound the answer REFUSES BY NAME, with the limit and the size that was asked for, and the tile at
    /// the bound itself is answered: 10x10 is 100 tiles and fits, 11x10 is 110 and does not.
    /// </summary>
    [Fact]
    public void AnAreaOverTheLimitRefusesWithTheLimitAndTheRequestedSize()
    {
        using TillSoilRefusalNamingTests.TillSoilHarness harness = TillSoilRefusalNamingTests.TillSoilHarness.Create();

        BridgeTileAreaQueryResult refused = TileAreaQuery.Answer(Game1.player, 0, 0, 11, 10, Revision);

        refused.Status.Should().Be("area_too_large");
        refused.Detail.Should().Be(
            "inspect_tiles_area_too_large:100:11x10",
            "the refusal names the limit AND the size asked for, so a caller can shrink the rectangle instead of bisecting");
        refused.Rows.Should().BeNull("nothing was read, so nothing is published as a short list");
        refused.Omitted.Should().Be(0);
        (refused.X, refused.Y, refused.W, refused.H).Should().Be(
            (0, 0, 11, 10),
            "the answer echoes the question it refused");

        BridgeTileAreaQueryResult atTheBound = TileAreaQuery.Answer(Game1.player, 0, 0, 10, 10, Revision);
        atTheBound.Status.Should().Be("answered", "the bound is admitted, not approached");
        atTheBound.Rows.Should().HaveCount(TileAreaQuery.AreaLimit);
    }

    /// <summary>
    /// A rectangle with no tiles refuses by name: an empty side is a malformed question, not an empty answer, and an
    /// empty answer would read as "this ground holds nothing".
    /// </summary>
    [Theory]
    [InlineData(0, 5, "inspect_tiles_invalid_rectangle:0x5")]
    [InlineData(5, 0, "inspect_tiles_invalid_rectangle:5x0")]
    [InlineData(-1, 4, "inspect_tiles_invalid_rectangle:-1x4")]
    public void ARectangleWithNoOrNegativeTilesRefusesByName(int w, int h, string detail)
    {
        using TillSoilRefusalNamingTests.TillSoilHarness harness = TillSoilRefusalNamingTests.TillSoilHarness.Create();

        BridgeTileAreaQueryResult answer = TileAreaQuery.Answer(Game1.player, 3, 3, w, h, Revision);

        answer.Status.Should().Be("invalid_rectangle");
        answer.Detail.Should().Be(detail);
        answer.Rows.Should().BeNull();
    }

    /// <summary>
    /// A rectangle that leaves the map names the CORNER it leaves and the map's own size, because "off the map" alone
    /// leaves the caller guessing whether to move the origin, shrink the rectangle, or ask a different location.
    /// </summary>
    [Fact]
    public void ARectangleThatLeavesTheMapNamesTheCornerAndTheMapSize()
    {
        using TillSoilRefusalNamingTests.TillSoilHarness harness = TillSoilRefusalNamingTests.TillSoilHarness.Create();

        BridgeTileAreaQueryResult southEast = TileAreaQuery.Answer(Game1.player, 18, 18, 3, 3, Revision);
        southEast.Status.Should().Be("off_map");
        southEast.Detail.Should().Be("inspect_tiles_off_map:east,south:map=20x20");
        southEast.Rows.Should().BeNull();

        BridgeTileAreaQueryResult west = TileAreaQuery.Answer(Game1.player, -2, 0, 3, 3, Revision);
        west.Status.Should().Be("off_map");
        west.Detail.Should().Be("inspect_tiles_off_map:west:map=20x20");

        BridgeTileAreaQueryResult atTheEdge = TileAreaQuery.Answer(Game1.player, 17, 17, 3, 3, Revision);
        atTheEdge.Status.Should().Be(
            "answered",
            "the map's own last tile is inside it; only the rectangle that crosses the edge is refused");
        atTheEdge.Rows.Should().HaveCount(9);
    }

    /// <summary>
    /// What is STORED on a tile, as the engine names it - and what is deliberately not: a <c>HoeDirt</c> is the tile's
    /// soil and travels as `hoed`/`watered`/`crop`, so naming it an occupant would read the hoe's own result as an
    /// obstacle.
    /// </summary>
    [Fact]
    public void TheOccupantIsTheEngineThingAndTheSoilIsNotAnOccupant()
    {
        using TillSoilRefusalNamingTests.TillSoilHarness harness = TillSoilRefusalNamingTests.TillSoilHarness.Create();
        harness.SetDiggable(10, 5);
        harness.PlaceObject(10, 5, new StardewValley.Objects.Chest());
        harness.SetDiggable(11, 5);
        harness.PlaceHoeDirt(11, 5);
        ((StardewValley.TerrainFeatures.HoeDirt)harness.Location.terrainFeatures[new Vector2(11, 5)]).state.Value =
            StardewValley.TerrainFeatures.HoeDirt.watered;
        harness.SetDiggable(12, 5);

        BridgeTileAreaQueryResult answer = TileAreaQuery.Answer(Game1.player, 10, 5, 3, 1, Revision);

        BridgeTileAreaRow chest = answer.Rows![0];
        chest.Occupant.Should().Be("chest", "the word is the engine's own type name, lowercased");
        chest.Tillable.Should().BeFalse("the hoe refuses a tile with something on it, which is the same predicate the soil list uses");

        BridgeTileAreaRow soil = answer.Rows![1];
        soil.Occupant.Should().Be("none", "a tilled tile holds no occupant - its soil travels as its own fields");
        soil.Hoed.Should().BeTrue();
        soil.Watered.Should().BeTrue();
        soil.Crop.Should().BeFalse();
        soil.Tillable.Should().BeFalse("the hoe has already been here; that is `hoed`, not `tillable`");

        BridgeTileAreaRow free = answer.Rows![2];
        free.Occupant.Should().Be("none");
        free.Tillable.Should().BeTrue();
    }

    /// <summary>
    /// No world, no rectangle: a query that cannot read the world says so instead of answering an empty list, because
    /// "these sixty tiles hold nothing" and "I could not look" are different facts.
    /// </summary>
    [Fact]
    public void AQueryWithNoWorldSaysSoRatherThanAnsweringNothing()
    {
        BridgeTileAreaQueryResult answer = TileAreaQuery.Answer(actor: null, 0, 0, 3, 20, Revision);

        answer.Status.Should().Be("world_unavailable");
        answer.Detail.Should().Be("inspect_tiles_world_unavailable");
        answer.Rows.Should().BeNull();
    }

    /// <summary>
    /// Every fact a row publishes names its owner in one place, and the two owners that answer for OTHER publications
    /// are the ones those publications actually call. This is the in-assembly half of the drift gate
    /// (`tools/audit-stardew-discovery-channels.mjs` reads the same table against the wire schema).
    /// </summary>
    [Fact]
    public void EveryPublishedFactNamesOneOwner()
    {
        string[] published =
        {
            "x", "y", "tillable", "occupant", "hoed", "watered", "crop", "passable",
        };
        TileAreaQuery.PublishedFacts.Select(entry => entry.Fact).Should().OnlyHaveUniqueItems();
        TileAreaQuery.PublishedFacts.Select(entry => entry.Fact).Should().BeEquivalentTo(published);
        TileAreaQuery.PublishedFacts.Should().OnlyContain(entry => entry.Owner.Contains('.'), "an owner names type and member");

        TileAreaQuery.PublishedFacts.Single(entry => entry.Fact == "tillable").Owner.Should().Be(
            "ExecutionManager.IsTillableTile",
            "the cross-check above only holds while the discovery and this query ask one function");
    }
}
