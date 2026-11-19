using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Every action whose handler refuses the actor for DISTANCE must say where reach is - a tile she can walk to - and not
/// only the box, radius or distance it measured.
///
/// <para>
/// WHY. Measured `round79`: an actor at tile 4,6 asked to pick up a piece of furniture at tile 4,4 four times in one
/// morning, and every refusal answered
/// <c>target=4,4;actor_tile=4,6;furniture_tile=4,4;reach_inflate_px=96;reach_box=160,160:256x256;actor_standing_pixel=291,444</c>.
/// That is honest and complete and useless: the box ends at y=416 and her standing pixel is 28 px below it, and nothing
/// in the sentence turns a pixel rectangle into a tile. She had picked two pieces up already, so the action and the id
/// were proven; what she lacked was the one step that closes the gap.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED FROM WHAT MINTS THE REFUSAL, not from a list. This repository has no per-action
/// refusal-code table to read - <see cref="FarmhandActionCatalog"/> declares the family, lifecycle, arguments,
/// postcondition, native binding and approach relation, and no reason codes - so the authority for "this handler refuses
/// for distance" is the reach PREDICATE in its body. Two shapes exist and they are not the same question:
/// </para>
/// <list type="bullet">
/// <item>
/// <b>A tile relation</b> (<c>IsTileWithinChebyshevRadius</c>, <c>tileWithinRadiusOfPlayer</c>): the refusal names the
/// target tile and the radius, and "stand beside it" is derivable from those two numbers alone. Those rows are counted
/// and printed, and they are NOT in this population - a <c>stand_at</c> there would be a second spelling of a fact the
/// caller already holds.
/// </item>
/// <item>
/// <b>A pixel reach</b> (<c>IsCloseEnoughToFarmer</c>, <c>MagneticPickupReach</c>): the refusal's own bound is in pixels
/// plus the actor's standing pixel, and no arithmetic over the numbers it prints recovers a tile. Those rows ARE the
/// population, and each must either walk the actor in or name the tile.
/// </item>
/// </list>
///
/// <para>
/// The three counts answer the three ways a row can satisfy it, and `mute` is the defect: a handler that neither begins
/// an approach leg nor names a stand tile leaves the caller holding a distance it cannot close, which is exactly what
/// `round79` did four times. A fourth state - no tile beside the piece is standable and walkable - is now answered by the
/// SHARED approach leg (<c>no_reachable_approach:&lt;x&gt;:&lt;y&gt;</c> with <c>standable_neighbour=none</c>), because the
/// three furniture actions walk: their request half no longer prints a distance at all.
/// </para>
///
/// <para>
/// THE COMPOSER PREMISE IS ASSERTED ONLY WHILE A ROW RELIES ON IT. <c>names-the-stand-tile</c> is counted off a
/// <c>stand_at=</c> field (or the furniture reach helper that printed one), and that count is only honest while the
/// helper really composes a dispatchable step. Measured 2026-11-19, that branch has no member left: all four pixel-reach
/// rows walk, so the composer this file guarded was deleted with the refusal it served. The premise is kept, but it is
/// read where it applies - a returned consumer brings both assertions back with it.
/// </para>
/// </summary>
public sealed class RefusalNamesWhereReachIsTests
{
    /// <summary>
    /// The predicates that make a reach a PIXEL question: the engine's own furniture reach, and the magnet's radius.
    /// Both answer with a rectangle around a point, never with a tile count.
    /// </summary>
    private static readonly string[] PixelReachMarkers =
    {
        "IsCloseEnoughToFarmer(",
        "MagneticPickupReach.",
    };

    /// <summary>The predicates that make a reach a TILE question, whose refusal therefore already names the ring.</summary>
    private static readonly string[] TileReachMarkers =
    {
        "IsTileWithinChebyshevRadius(",
        "tileWithinRadiusOfPlayer(",
    };

    /// <summary>The one word this surface has for "where the body must stand", in a refusal and in a route hint alike.</summary>
    private const string StandTileField = "stand_at=";

    /// <summary>The shared owner of the furniture reach's geometry, read so a helper that stops naming the tile fails here.</summary>
    private const string FurnitureReachHelper = "internal static string DescribeFurnitureReach(";

    /// <summary>The one composer of the furniture stand tile, so the chain a furniture refusal names is not assumed.</summary>
    private const string FurnitureStandTileComposer = "private static string DescribeFurnitureStandTile(";

    /// <summary>The call the reach helper makes to it: the chain has two links and both are read.</summary>
    private const string FurnitureStandTileCall = "DescribeFurnitureStandTile(";

    /// <summary>What a `stand_at`-style field needs beside it to be a STEP and not just a position.</summary>
    private const string NextStepField = "next_steps=";

    private static readonly Lazy<Measurement> Measured = new(Measure);

    private readonly ITestOutputHelper output;

    public RefusalNamesWhereReachIsTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void ARefusalAboutReachSaysWhereReachIs()
    {
        Measurement measured = Measured.Value;

        List<ReachRow> population = measured.Rows.Where(row => row.PixelReach).ToList();
        population.Should().NotBeEmpty(
            "the derivation must find the handlers that enforce a pixel reach, or this gate reads nothing");

        List<ReachRow> walking = population.Where(row => row.Walks).ToList();
        List<ReachRow> naming = population.Where(row => !row.Walks && row.NamesTheStandTile).ToList();
        List<ReachRow> mute = population.Where(row => !row.Walks && !row.NamesTheStandTile).ToList();

        this.output.WriteLine(
            $"actions examined {population.Count} · names-the-stand-tile {naming.Count} · walks-into-reach {walking.Count} · mute {mute.Count}");
        this.output.WriteLine(
            $"  walks-into-reach: {string.Join(", ", walking.Select(row => row.ActionId))}");
        this.output.WriteLine(
            $"  names-the-stand-tile: {string.Join(", ", naming.Select(row => row.ActionId))}");
        this.output.WriteLine(
            $"tile-relation reaches (refused with the target tile and a tile radius, so the ring is derivable; not this population): "
                + $"{measured.TileRelationCount} actions");
        this.output.WriteLine(
            $"rows whose handler no reach predicate could be read: {measured.Unread}");
        this.output.WriteLine(
            $"the furniture reach names its stand tile through ONE helper: names_the_tile={measured.FurnitureReachNamesTheTile} "
                + $"composes_the_step={measured.FurnitureStandTileNamesTheStep} ({measured.FurnitureReachFile})");

        // The helper was the single owner of that geometry, so a row counted `names-the-stand-tile` off a
        // `DescribeFurnitureReach(` mention would have made every count above a false one. Read where it still applies: a
        // row that names the stand tile without walking is the only reason the composer exists.
        if (naming.Count > 0)
        {
            measured.FurnitureReachNamesTheTile.Should().BeTrue(
                $"{FurnitureReachHelper} no longer composes {FurnitureStandTileCall} in {measured.FurnitureReachFile}, so "
                    + "the furniture refusals that call it name the box and not the step - the round79 shape");
            measured.FurnitureStandTileNamesTheStep.Should().BeTrue(
                $"{FurnitureStandTileComposer} in {measured.FurnitureReachFile} no longer composes `{StandTileField}` and "
                    + $"`{NextStepField}` together, so the tile it chooses is not dispatchable by the caller");
        }
        else
        {
            // Printing this keeps the empty branch a MEASURED zero rather than a silent one.
            this.output.WriteLine(
                $"no row names the stand tile without walking, so {FurnitureStandTileComposer} is asserted only if one returns");
        }

        mute.Select(row => row.Site).Should().BeEmpty(
            "a_refusal_about_reach_says_where_reach_is: these handlers refuse the actor for a reach measured in PIXELS, "
                + "so nothing they print lets a caller recover the tile she must stand on - neither an approach leg that "
                + "walks her in nor a `stand_at=` naming one. With the handler site:\n  "
                + string.Join("\n  ", mute.Select(row => row.Site)));
    }

    // -------------------------------------------------------------------------

    /// <summary>
    /// One reading of the repository per test run: every registered EXECUTION row with the three facts its handler body
    /// answers, plus the two censuses this reading passes over.
    /// </summary>
    private static Measurement Measure()
    {
        IReadOnlyDictionary<string, string> handlers = HandlerSourceFacts.HandlerMethods();
        IReadOnlyDictionary<string, string> sources = HandlerSourceFacts.HandlerSources();

        var rows = new List<ReachRow>();
        int tileRelation = 0;
        int unread = 0;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor is null || registration.Kind != FarmhandOperationKind.Execution)
                continue;

            string? method = handlers.TryGetValue(registration.ActionId, out string? handlerMethod) ? handlerMethod : null;
            (string File, int Line, int BodyLine, string Body)? site = method is null
                ? null
                : HandlerSourceFacts.MethodSite(sources, method);
            if (site is null)
            {
                unread++;
                continue;
            }

            string body = HandlerSourceFacts.StripLineComments(site.Value.Body);
            bool pixelReach = PixelReachMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal));
            if (!pixelReach)
            {
                if (TileReachMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal)))
                    tileRelation++;
                continue;
            }

            rows.Add(new ReachRow(
                registration.ActionId,
                site.Value.File,
                site.Value.Line,
                body,
                pixelReach,
                HandlerApproachFacts.BeginsAnApproachLeg(body),
                body.Contains(StandTileField, StringComparison.Ordinal)
                    || body.Contains("DescribeFurnitureReach(", StringComparison.Ordinal)));
        }

        string furnitureFile = sources.Keys
            .FirstOrDefault(name => name.Contains("furnituredecorationactions", StringComparison.Ordinal))
            ?? "farmhandexecutioncontroller.furnituredecorationactions.cs";
        string furnitureSource = sources.TryGetValue(furnitureFile, out string? partial) ? partial : string.Empty;
        string reach = MethodBody(furnitureSource, FurnitureReachHelper);
        string composer = MethodBody(furnitureSource, FurnitureStandTileComposer);

        return new Measurement(
            rows,
            tileRelation,
            unread,
            reach.Contains(FurnitureStandTileCall, StringComparison.Ordinal),
            composer.Contains(StandTileField, StringComparison.Ordinal) && composer.Contains(NextStepField, StringComparison.Ordinal),
            furnitureFile);
    }

    /// <summary>The body of the first method declared by <paramref name="declaration"/>, or empty when it is absent.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        if (start < 0)
            return string.Empty;

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            if (source[index] == '{')
            {
                depth++;
                started = true;
            }
            else if (source[index] == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        return string.Empty;
    }

    private sealed record Measurement(
        IReadOnlyList<ReachRow> Rows,
        int TileRelationCount,
        int Unread,
        bool FurnitureReachNamesTheTile,
        bool FurnitureStandTileNamesTheStep,
        string FurnitureReachFile);

    /// <summary>
    /// One action whose handler enforces a pixel reach, with the two facts that decide whether its refusal can be acted
    /// on. `Site` is the pair a reader needs: which action, and where the handler that answers it is.
    /// </summary>
    private sealed record ReachRow(
        string ActionId,
        string File,
        int Line,
        string Body,
        bool PixelReach,
        bool Walks,
        bool NamesTheStandTile)
    {
        public string Site => $"{this.ActionId} - handler {this.File}:{this.Line}";
    }
}
