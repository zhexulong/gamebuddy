using System.Globalization;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE ORIGIN FOR THE MAGNET'S GEOMETRY, and the four refusals that proved there were two.
///
/// <para>
/// `round82`: four `pickup_item` requests settled `pickup_precondition_broken:player_in_range` with
/// <c>stand_at=73,27;actor_tile=73,27</c> and <c>axis_distance_px=153.9;radius=128</c> (144.1, 140.1 and 177.9 beside
/// it). She stood exactly where the search told her to stand and the engine's own <c>playerInRange</c> refused her: the
/// search had measured from <c>x * 64 + offset</c> with her CURRENT sub-tile remainder carried onto a tile she had never
/// reached, while <c>Debris.updateChunks</c> asks about the pixel she actually reports. For the first of the four the two
/// origins are side by side - <c>4672 + 48 = 4720</c> (119.9 px from the chunk centre, so the tile was admitted) against
/// <c>4672 + 14 = 4686</c> (153.9 px, so the engine refuses).
/// </para>
///
/// <para>
/// The engine's origin is the right one because it is the only one that exists at collection time, and the walk's
/// arrival is tile-granular (<c>LocalMoveSpec</c> + <c>IsArrivalTile</c> accept a TILE), so the remainder is never
/// carried. A tile therefore cannot name a pixel at all: it names the span in <see cref="MagneticPickupReach.StandingSpanOf"/>,
/// and a tile is admissible only when the engine's rectangle covers all of it
/// (<see cref="MagneticPickupReach.MagnetCoversTile"/>). What this file pins:
/// </para>
/// <list type="bullet">
/// <item>every pixel of a tile the search admits is one the engine collects from - so the two spellings cannot disagree
/// again, whatever pixel a walk leaves her on;</item>
/// <item>the four `round82` numbers replayed from their own arithmetic, with both origins printed;</item>
/// <item>the census: every production site that computes a standing pixel or a magnet rectangle, one origin, and no
/// restatement of the origin's arithmetic anywhere else;</item>
/// <item>what the rule costs, measured rather than described: the ring of admissible stand tiles goes from 5x5 at its
/// widest to 3x3 for a drop centred on a tile, because the far side of a two-tile reach can only be promised on a pixel
/// of the tile, never on the tile.</item>
/// </list>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the census test reads the Mod's source - which site computes the magnet's origin is a fact
// about the tree, not about a running game - while the four `round82` replays and the span property build and call the
// geometry itself.
public sealed class MagnetStandingOriginCensusTests
{
    /// <summary>The engine's tile size, as every conversion in these tests spells it.</summary>
    private const int TileSize = 64;

    /// <summary>The reach this file measures with: the default farmer's own `GetAppliedMagneticRadius`.</summary>
    private const int Reach = 128;

    /// <summary>The one file allowed to turn a debris' mean and a standing pixel into a distance.</summary>
    private const string OwnerFile = "GroundItemPickups.cs";

    /// <summary>
    /// The markers that make a production line part of the population: a place that names a standing pixel, the magnet's
    /// rectangle, or the owner's geometry. A file that starts computing any of these enters the census on its own.
    /// </summary>
    private static readonly string[] GeometryMarkers =
    {
        "StandingPixel",
        "MagneticPickupReach.",
        "MagnetCoversTile(",
        "WithinMagnet(",
        "StandingPixelOf(",
        "StandingSpanOf(",
        "AxisDistance(",
        "SubjectCentre(",
        "ChunkCentreOffset",
        "MagneticStandSearch",
    };

    /// <summary>
    /// The origin's arithmetic, in the only spelling it may have: the half tile the engine adds to the debris' mean. Any
    /// line outside the owner that adds it is a second origin, which is what `round82` paid for.
    /// </summary>
    private const string OriginAddition = "+ ChunkCentreOffset";

    private readonly ITestOutputHelper output;

    public MagnetStandingOriginCensusTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    // ---- the defect, replayed from its own four numbers ---------------------------

    /// <summary>
    /// THE FOUR REFUSALS, each replayed from the numbers it published, with both origins printed side by side. The
    /// reconstruction only assumes what the receipt stated: the tile she stood on, the reach, and the distance the
    /// engine measured against the pixel she had. Her remainder before the walk is the far side of her own tile (63),
    /// and tile-granular arrival leaves her `ceil(distance - reach)` pixels further back in the stand tile - which is the
    /// half of the story the old model never had.
    /// </summary>
    [Theory]
    [InlineData(73, 27, 153.9f)]
    [InlineData(63, 17, 144.1f)]
    [InlineData(50, 34, 140.1f)]
    [InlineData(52, 21, 177.9f)]
    public void ARound82RefusalReplaysWithBothOriginsSideBySide(int tileX, int tileY, float publishedAxis)
    {
        const int carriedRemainder = 63;
        int landedRemainder = carriedRemainder - (int)Math.Ceiling(publishedAxis - Reach);
        landedRemainder.Should().BeGreaterThanOrEqualTo(0, "the arrival pixel has to be inside the tile the search chose");

        var searchPixel = new Point(tileX * TileSize + carriedRemainder, tileY * TileSize + 16);
        var enginePixel = new Point(tileX * TileSize + landedRemainder, tileY * TileSize + 16);
        // The chunk sits east of her, far enough that the engine's own measurement is the published number.
        var subject = new Vector2(
            enginePixel.X + publishedAxis - MagneticPickupReach.ChunkCentreOffset,
            enginePixel.Y - MagneticPickupReach.ChunkCentreOffset);

        // THE SEARCH'S ORIGIN: her current remainder carried onto a tile she has not reached. It admits the tile.
        Vector2 searchDistance = MagneticPickupReach.AxisDistance(subject, searchPixel);
        MagneticPickupReach.WithinMagnet(subject, searchPixel, Reach).Should().BeTrue(
            "the old search measured from this pixel and promised the tile on it");

        // THE ENGINE'S ORIGIN: the pixel she reports once she stands there. It refuses her, by the published number.
        Vector2 engineDistance = MagneticPickupReach.AxisDistance(subject, enginePixel);
        engineDistance.X.ToString("0.#", CultureInfo.InvariantCulture).Should().Be(
            publishedAxis.ToString("0.#", CultureInfo.InvariantCulture),
            "the refusal's own number, produced by the owner's arithmetic");
        engineDistance.X.Should().BeGreaterThan(Reach);
        MagneticPickupReach.WithinMagnet(subject, enginePixel, Reach).Should().BeFalse(
            "the engine's answer about the pixel she actually has is the refusal the round recorded");

        this.output.WriteLine(
            $"stand_at={tileX},{tileY} · search_px={searchPixel.X} ({searchDistance.X.ToString("0.#", CultureInfo.InvariantCulture)} in reach, admitted)"
                + $" · engine_px={enginePixel.X} ({engineDistance.X.ToString("0.#", CultureInfo.InvariantCulture)}, refused) · radius={Reach}");

        // THE RULE THAT REPLACED IT: the tile is refused, because one pixel of it is the pixel the engine refuses...
        MagneticPickupReach.MagnetCoversTile(subject, (tileX, tileY), Reach).Should().BeFalse(
            $"({tileX},{tileY}) holds the pixel {enginePixel.X} the engine measured {publishedAxis} against");

        // ... and the tile it chooses instead is one where EVERY pixel is inside, so no walk to it can end in this
        // refusal. That is the whole difference between a promise and a measurement.
        MagneticStandSearch chosen = MagneticPickupReach.SelectStandTile(
            subject, (tileX, tileY), Reach, isStandable: _ => true, isReachable: _ => true);
        chosen.Tile.Should().NotBeNull("the rectangle still covers tiles, so the drop is not refused for nothing");
        (int X, int Y) standTile = chosen.Tile!.Value;
        this.output.WriteLine(
            $"  stand_at=none for {tileX},{tileY};in_reach={chosen.InReach};chosen={standTile.X},{standTile.Y}");
        AssertEveryPixelIsCollectable(subject, standTile);
    }

    // ---- the property, over a population the geometry derives --------------------

    /// <summary>
    /// THE IMPLICATION THE OLD RULE LACKED, over every tile in a window around four chunk positions: if the search admits
    /// a tile then <c>Debris.playerInRange</c> is true at EVERY pixel that tile can report, so a walk onto it cannot
    /// produce `pickup_precondition_broken:player_in_range`. The same population is then asked the OLD rule's question -
    /// her remainder carried - and the count of admitted tiles a pixel of which the engine refuses is printed: that
    /// number is the defect, and it being non-zero is what keeps the property from being vacuous.
    /// </summary>
    [Fact]
    public void EveryPixelOfATileTheSearchAdmitsIsOneTheEngineCollectsFrom()
    {
        var subjects = new[]
        {
            new Vector2(0, 0),
            new Vector2(20, 20),
            new Vector2(4886, 2468),
            new Vector2(4807.9f, 1712f),
        };
        int tilesExamined = 0;
        int admitted = 0;
        int pixelsExamined = 0;
        int carriedAdmitted = 0;
        int carriedWithARefusedPixel = 0;

        foreach (Vector2 subject in subjects)
        {
            Vector2 centre = MagneticPickupReach.SubjectCentre(subject);
            int firstX = (int)Math.Floor(centre.X / TileSize) - 4;
            int firstY = (int)Math.Floor(centre.Y / TileSize) - 4;
            for (int x = firstX; x < firstX + 9; x++)
            {
                for (int y = firstY; y < firstY + 9; y++)
                {
                    tilesExamined++;
                    if (MagneticPickupReach.MagnetCoversTile(subject, (x, y), Reach))
                    {
                        admitted++;
                        pixelsExamined += CountEveryPixelIsInside(subject, (x, y));
                    }

                    foreach (int remainder in new[] { 0, 17, 40, 63 })
                    {
                        if (!MagneticPickupReach.WithinMagnet(subject, new Point(x * TileSize + remainder, y * TileSize + remainder), Reach))
                            continue;
                        carriedAdmitted++;
                        if (PixelsOutside(subject, (x, y)) > 0)
                            carriedWithARefusedPixel++;
                    }
                }
            }
        }

        this.output.WriteLine(
            $"subjects {subjects.Length} · tiles examined {tilesExamined} · admitted {admitted} · pixels checked {pixelsExamined}");
        this.output.WriteLine(
            "the rule this replaced, on the same population: admitted by a carried remainder "
                + $"{carriedAdmitted} (tile,remainder) pairs · of which a pixel the engine refuses {carriedWithARefusedPixel}");

        tilesExamined.Should().BeGreaterThan(0, "the population is the rectangle around each chunk, and it cannot be empty");
        admitted.Should().BeGreaterThan(0, "the rectangle always covers the chunk's own span, so the search must find tiles");
        pixelsExamined.Should().Be(admitted * TileSize * TileSize, "every admitted tile is asked about every pixel it can report");
        carriedWithARefusedPixel.Should().BeGreaterThan(
            0,
            "the old rule really did admit tiles holding a pixel the engine refuses - that is `round82`, and this property "
                + "is only worth asserting while it can fail");
    }

    // ---- the census: one origin ------------------------------------------------

    /// <summary>
    /// `a_geometry_the_search_and_the_executor_both_compute_names_one_origin`. The population is DERIVED from source -
    /// every production line that names a standing pixel or the magnet's rectangle, in a directory scan - so a new file
    /// that starts computing either enters it without anyone editing a list here. One origin is the owner's
    /// <c>SubjectCentre</c>/<c>AxisDistance</c>; a restatement is a second spelling of that arithmetic anywhere else,
    /// which is what the receipt carried in `round82` and what this gate refuses to let come back.
    /// </summary>
    [Fact]
    public void AStandingPixelOrAMagnetRectangleHasOneOrigin()
    {
        Census census = Measure();

        this.output.WriteLine(
            $"geometry sites {census.Sites.Count} · one origin {census.OriginAdditions} ({OwnerFile}, SubjectCentre/AxisDistance)"
                + $" · restated {census.Restatements.Count}");
        foreach (Site site in census.Sites)
            this.output.WriteLine($"  {(site.InOwner ? "origin" : "reader"),-6} {site.File}:{site.Line}  {site.Text}");
        this.output.WriteLine(
            $"ring {census.PointModelRing}x{census.PointModelRing} -> {census.SpanModelRing}x{census.SpanModelRing}"
                + $" · point model widest {census.PointModelRing} · span model {census.SpanModelRing}");

        census.Sites.Should().NotBeEmpty(
            "the derivation must find the places that compute a standing pixel or a magnet rectangle, or this gate reads nothing");
        census.OriginAdditions.Should().Be(
            2,
            "the half tile `Debris.playerInRange` adds is two additions per axis pair, in ONE member of the owner");
        census.Restatements.Should().BeEmpty(
            "a_geometry_the_search_and_the_executor_both_compute_names_one_origin: these sites compute the magnet's origin "
                + "themselves instead of reading the owner, so the search and the refusal can measure from different points "
                + "again - which is `round82`'s four refusals. With the site:\n  "
                + string.Join("\n  ", census.Restatements.Select(site => $"{site.File}:{site.Line}  {site.Text}")));
        census.SearchPredictsAPixel.Should().BeFalse(
            "the stand-tile search may not predict the pixel a walk will leave her on - it decides on the tile's whole span");
        census.PointModelRing.Should().Be(5, "the carried pixel admits a 5x5 ring at its widest, and that width is exactly what it could not keep");
        census.SpanModelRing.Should().Be(3, "the span rule admits 3x3 whatever remainder she has, which is what it can promise");
    }

    // -------------------------------------------------------------------------

    /// <summary>
    /// Asks the engine's predicate about every pixel of a tile's span, and returns how many it asked. Used by both the
    /// property and the replay, so the two cannot measure different families.
    /// </summary>
    private static int CountEveryPixelIsInside(Vector2 subject, (int X, int Y) tile)
    {
        Rectangle span = MagneticPickupReach.StandingSpanOf(tile);
        int checkedPixels = 0;
        for (int x = span.Left; x < span.Right; x++)
        {
            for (int y = span.Top; y < span.Bottom; y++)
            {
                MagneticPickupReach.WithinMagnet(subject, new Point(x, y), Reach).Should().BeTrue(
                    $"({tile.X},{tile.Y}) was admitted by the span rule, so the engine collects from its pixel {x},{y}");
                checkedPixels++;
            }
        }

        return checkedPixels;
    }

    private void AssertEveryPixelIsCollectable(Vector2 subject, (int X, int Y) tile) =>
        CountEveryPixelIsInside(subject, tile).Should().Be(
            TileSize * TileSize, "a tile's span is its own 64x64 square, and every pixel of it was just asked");

    /// <summary>How many pixels of <paramref name="tile"/>'s span the engine's rectangle refuses.</summary>
    private static int PixelsOutside(Vector2 subject, (int X, int Y) tile)
    {
        Rectangle span = MagneticPickupReach.StandingSpanOf(tile);
        int outside = 0;
        for (int x = span.Left; x < span.Right; x++)
        {
            for (int y = span.Top; y < span.Bottom; y++)
            {
                if (!MagneticPickupReach.WithinMagnet(subject, new Point(x, y), Reach))
                    outside++;
            }
        }

        return outside;
    }

    /// <summary>
    /// One reading of the repository and of the two admission rules. Everything here is derived: the sites from a
    /// directory scan of the production sources, the rings from the arithmetic each rule performs.
    /// </summary>
    private static Census Measure()
    {
        string root = HandlerSourceFacts.RepositorySourcePath("integrations/stardew");
        var sites = new List<Site>();
        var restatements = new List<Site>();
        bool searchPredictsAPixel = false;

        foreach (string file in Directory.GetFiles(root, "*.cs", SearchOption.AllDirectories).OrderBy(path => path, StringComparer.Ordinal))
        {
            string display = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (IsNotProduction(display))
                continue;

            bool inOwner = string.Equals(display, OwnerFile, StringComparison.Ordinal);
            string[] lines = HandlerSourceFacts.StripLineComments(File.ReadAllText(file)).Split('\n');
            for (int index = 0; index < lines.Length; index++)
            {
                string line = lines[index];
                if (!GeometryMarkers.Any(marker => line.Contains(marker, StringComparison.Ordinal)))
                    continue;

                var site = new Site(display, index + 1, line.Trim(), inOwner);
                sites.Add(site);
                if (!inOwner && line.Contains(OriginAddition, StringComparison.Ordinal))
                    restatements.Add(site);
            }

            if (inOwner)
            {
                string ownerSource = HandlerSourceFacts.StripLineComments(File.ReadAllText(file));
                string search = MemberBodyOf(ownerSource, "internal static MagneticStandSearch SelectStandTile(");
                searchPredictsAPixel = search.Contains("offsetX", StringComparison.Ordinal)
                    || search.Contains("offsetY", StringComparison.Ordinal);
            }
        }

        string owner = HandlerSourceFacts.StripLineComments(File.ReadAllText(Path.Combine(root, OwnerFile)));
        int originAdditions = Regex.Matches(owner, Regex.Escape(OriginAddition)).Count;
        string originBody = MemberBodyOf(owner, "internal static Vector2 SubjectCentre(");
        originAdditions.Should().Be(
            Regex.Matches(originBody, Regex.Escape(OriginAddition)).Count,
            $"every `{OriginAddition}` in {OwnerFile} belongs to SubjectCentre, the one place the half tile is added");
        Regex.Matches(owner, "- standingPixel\\.").Count.Should().Be(
            Regex.Matches(MemberBodyOf(owner, "internal static Vector2 AxisDistance("), "- standingPixel\\.").Count,
            $"every subtraction from a standing pixel in {OwnerFile} belongs to AxisDistance");

        return new Census(sites, restatements, originAdditions, searchPredictsAPixel, WidestPointModelRing(), SpanModelRing());
    }

    /// <summary>
    /// How many columns the OLD rule admitted at best, over every remainder she could have had: a carried pixel is one
    /// point, so the ring's width depends on where in her tile she happened to stand - widest when that remainder is the
    /// half tile, and then a tile two columns away sits exactly on the 128 px boundary.
    /// </summary>
    private static int WidestPointModelRing()
    {
        int widest = 0;
        for (int remainder = 0; remainder < TileSize; remainder++)
        {
            int columns = 0;
            for (int delta = -4; delta <= 4; delta++)
            {
                int pixel = delta * TileSize + remainder;
                if (Math.Abs(pixel - (TileSize / 2)) <= Reach)
                    columns++;
            }

            widest = Math.Max(widest, columns);
        }

        return widest;
    }

    /// <summary>How many columns the span rule admits for the same drop: the tile's far pixel must fit too.</summary>
    private static int SpanModelRing()
    {
        int columns = 0;
        for (int delta = -4; delta <= 4; delta++)
        {
            Rectangle span = MagneticPickupReach.StandingSpanOf((delta, 0));
            bool inside = Math.Abs(span.Left - (TileSize / 2)) <= Reach && Math.Abs(span.Right - 1 - (TileSize / 2)) <= Reach;
            if (inside)
                columns++;
        }

        return columns;
    }

    private static string MemberBodyOf(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} is the member this gate reads");
        return HandlerSourceFacts.MemberBody(source, start) ?? string.Empty;
    }

    /// <summary>Generated code and the tests are not production; a `tests/` site answers its own question.</summary>
    private static bool IsNotProduction(string relativePath) =>
        relativePath.Split('/').Any(segment => segment is "tests" or "bin" or "obj");

    private sealed record Site(string File, int Line, string Text, bool InOwner);

    private sealed record Census(
        IReadOnlyList<Site> Sites,
        IReadOnlyList<Site> Restatements,
        int OriginAdditions,
        bool SearchPredictsAPixel,
        int PointModelRing,
        int SpanModelRing);
}
