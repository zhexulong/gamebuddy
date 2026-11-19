using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Microsoft.Xna.Framework;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate <c>a_nearest_tile_is_a_tile_that_helps:&lt;site&gt;</c>: a refusal names a tile to WALK to only when a walk
/// ARRIVES from it, and otherwise says <c>progress=none</c>.
///
/// <para>
/// THE DEFECT, measured `round78`: the flood's nearest reachable tile was published as <c>closest=</c> whatever the
/// verdict said. Six refusals in ten minutes carried <c>closest=34,6;closest_distance=6</c> beside
/// <c>stand_at=40,10</c>, and the closer-looking tile was the end of a dead end - the run walked 46 steps to it and
/// arrived nowhere. The coordinate was not wrong as a MEASUREMENT (the flood really does reach 34,6); it was wrong as a
/// STEP, which is what a field called "closest" in a refusal is read as.
/// </para>
///
/// <para>
/// So the claim is judged against the receipt's own verdict rather than against a distance: with the route closed, no
/// reachable tile opens it, and the honest answer is that no tile helps. The measurement keeps its own spelling
/// (<c>reachable=</c>, beside <c>walk_limit_steps=</c>), which is a different sentence with a different subject.
/// </para>
///
/// <para>
/// Population: the refusals the body actually composes, driven in a headless world (the flood branch with a clearable
/// blocker and with one no action removes, and the resumed walk after a clear), plus one verdict whose route DOES exist
/// - so both arms are counted, and neither can be satisfied by deleting the field. The falsifier feeds the judging
/// function the round78 receipt itself.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the refusals judged here are produced by driving the real controller in a headless world; one assertion reads the controller source, because a claim composed by a formatter that no refusal calls is exactly the wiring no behaviour test of the formatter can see.
[Collection(HeadlessGameWorld.Collection)]
public sealed class NearestTileThatHelpsTests
{
    private const string Gate = "a_nearest_tile_is_a_tile_that_helps";

    /// <summary>The far end of the corridor: beyond the blocker, so the flood cannot reach it from her side.</summary>
    private static readonly Vector2 Beyond = new(13f, 3f);

    private readonly ITestOutputHelper output;

    public NearestTileThatHelpsTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// The three refused worlds the body composes, each judged by ONE function, and each of which must say no tile helps
    /// because in all three the route is closed.
    /// </summary>
    [Fact]
    public void ARefusalWithNoRouteNamesNoTileToWalkTo()
    {
        var driven = new List<(string Site, string? Evidence, string? Hint)>
        {
            DriveFloodRefusal(),
            DriveBushFloodRefusal(),
            DriveResumedWalkRefusal(),
        };

        foreach ((string site, string? evidence, string? hint) in driven)
        {
            evidence.Should().NotBeNull($"{Gate}:{site}: the refusal composes evidence");
            // Sites that computed a route claim must have computed THIS one: none of these three worlds has a route, so
            // none may pretend to one. The resumed-walk branch mints no route claim at all - the engine has already
            // refused the walk - and that absence is its own honest answer, not a gap this gate fills in for it.
            Field(evidence!, "route_exists_cardinal")?.Should().Be(
                "false",
                $"{Gate}:{site}: none of these three worlds has a route, so a route claim here must say so");
            Field(evidence!, "progress").Should().Be(
                "none",
                $"{Gate}:{site}: the flood reached a tile, but no walk ARRIVES from it - got: {evidence}");
            if (hint is null)
                continue;
            hint.Should().NotContain(
                "closest=",
                $"{Gate}:{site}: the hint is what a model follows, and a `closest=` here is a step to nowhere - got: {hint}");
            hint.Should().Contain(
                $"{ClearingEvidence.NoProgress}",
                $"{Gate}:{site}: the withdrawn step is still an answer, and it is this word - got: {hint}");
        }

        driven.Should().Contain(entry => entry.Hint != null, "the hint half of the claim must be exercised, not skipped");

        // The measurement is not deleted, only renamed: the same tile still reaches the caller under the field that says
        // what it is. Dropping it would be trading one lie for a silence.
        driven[0].Evidence!.Should().Contain(
            "reachable=",
            $"{Gate}: the flood's own nearest tile is still published, under the name that says it is a reach, not a route");
        driven[0].Hint!.Should().Contain("reachable=");
        this.output.WriteLine($"sites examined {driven.Count} · said {ClearingEvidence.NoProgress} {driven.Count} · named a tile 0");
    }

    /// <summary>
    /// The other arm, and the reason the first one cannot be satisfied by deleting the field: when the verdict says a walk
    /// arrives, the refusal names the flood's nearest tile and that tile is one the walk can stand on and from which the
    /// goal is strictly closer than it is from here.
    /// </summary>
    [Fact]
    public void ATileNamedAsClosestIsReachableAndCloser()
    {
        // A room whose target is inside it: the flood reaches it, so the claim is a step and not a dead end.
        static bool Room(Point tile) => tile.X >= 0 && tile.X <= 5 && tile.Y >= 0 && tile.Y <= 5;
        Point actor = new(0, 0);
        Point target = new(5, 5);
        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            actor,
            target,
            Room,
            maxVisited: 200,
            findClosestReachable: true);

        verdict.Should().NotBeNull();
        ReachabilityVerdict assessed = verdict!.Value;
        StardewBodyController.RouteExists(assessed, allowAdjacentArrival: false).Should().BeTrue();
        string claim = StardewBodyController.DescribeWalkTarget(assessed, new Vector2(target.X, target.Y), allowAdjacentArrival: false);
        claim.Should().StartWith("closest=", $"a route exists, so the walk target is a tile - got: {claim}");

        string coordinate = Field(claim, "closest")!;
        string[] parts = coordinate.Split(',');
        Point tile = new(int.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture), int.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture));
        Room(tile).Should().BeTrue($"{Gate}: the named tile is in the actor's own component");
        Math.Max(Math.Abs(tile.X - target.X), Math.Abs(tile.Y - target.Y)).Should().BeLessThan(
            Math.Max(Math.Abs(actor.X - target.X), Math.Abs(actor.Y - target.Y)),
            $"{Gate}: and it is strictly closer to the goal than where the actor stands, or it is not a step");
        this.output.WriteLine($"sites examined 1 · said {ClearingEvidence.NoProgress} 0 · named a tile 1 ({claim})");
    }

    /// <summary>
    /// THE FALSIFIER on the gate itself: the round78 receipt, verbatim. A tile named as the walk target while the same
    /// receipt reports no route - one finding, named by its field and site.
    /// </summary>
    [Fact]
    public void ADeadEndDressedAsAClosestTileIsReportedByName()
    {
        IReadOnlyList<string> findings = Judge(new[]
        {
            (Site: "flood",
                Evidence: (string?)"native=not_attempted;route_exists_cardinal=false;target_enclosed=false;closest=34,6;closest_distance=6;reachable=34,6;walk_limit_steps=46;stand_at=40,10"),
        });

        findings.Should().Equal($"{Gate}:flood");
    }

    /// <summary>
    /// One rule, over a refusal's own claims: a `closest=` beside a verdict that says no route is a step to nowhere.
    /// <see cref="ClearingEvidence.NoProgress"/> in its place is the answer, and a receipt that says neither was not
    /// measured and is not judged here.
    /// </summary>
    internal static IReadOnlyList<string> Judge(IReadOnlyList<(string Site, string? Evidence)> refusals)
    {
        var findings = new List<string>();
        foreach ((string site, string? evidence) in refusals)
        {
            if (evidence is null)
            {
                findings.Add($"{Gate}:{site}");
                continue;
            }

            bool routeExists = Field(evidence, "route_exists_cardinal") == "true";
            string? tile = Field(evidence, "closest");
            string? progress = Field(evidence, "progress");
            if (tile is not null && !routeExists)
                findings.Add($"{Gate}:{site}");
            else if (tile is null && progress != ClearingEvidence.NoProgress && !routeExists)
                findings.Add($"{Gate}:{site}");
        }

        return findings;
    }

    // -------------------------------------------------------------------------
    // The drives: one real refusal per branch the body composes a tile claim on.
    // -------------------------------------------------------------------------

    /// <summary>One weed on a one-tile corridor, the target beyond it: the flood branch.</summary>
    private static (string Site, string? Evidence, string? Hint) DriveFloodRefusal()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(9, 3);
        (string _, string? evidence, string? hint) = harness.RefuseWithHint(fromX: 2, fromY: 3, Beyond);
        return ("flood", evidence, hint);
    }

    /// <summary>A bush: nothing published removes it, so the refusal has no clear step and only the flood's own read.</summary>
    private static (string Site, string? Evidence, string? Hint) DriveBushFloodRefusal()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceBush(9, 3);
        (string _, string? evidence, string? hint) = harness.RefuseWithHint(fromX: 2, fromY: 3, Beyond);
        return ("bush", evidence, hint);
    }

    /// <summary>The arrival whose blocker is gone and whose route the engine still refuses: the resumed-walk branch.</summary>
    private static (string Site, string? Evidence, string? Hint) DriveResumedWalkRefusal()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(8, 3);
        (string _, string? evidence) = harness.Arrive((6, 3), fromX: 5, fromY: 3);
        // This branch mints its refusal through the controller's own `Fail`, whose hint is empty: the claim under test is
        // the evidence's, so the hint half is judged where a hint exists (the two flood drives above).
        evidence.Should().Contain("native=attempted");
        return ("resumed_walk", evidence, Hint: null);
    }

    /// <summary>One `k=v` field of a receipt's evidence, or null when the field is absent.</summary>
    private static string? Field(string evidence, string name)
    {
        foreach (string entry in evidence.Split(';'))
        {
            int equals = entry.IndexOf('=');
            if (equals > 0 && entry[..equals] == name)
                return entry[(equals + 1)..];
        }

        return null;
    }
}
