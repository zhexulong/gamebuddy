using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate <c>a_reachability_verdict_says_which_it_means:&lt;case&gt;</c>: the two route claims a refusal publishes -
/// <c>route_exists_cardinal</c> and <c>target_enclosed</c> - are READ FROM the verdict, and they tell apart the two
/// worlds a caller can be refused in.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR, measured `round78`. <c>route_exists_cardinal=false</c> was a hardcoded literal in the
/// flood branch, and that branch was entered whenever the component did not contain the target's own tile - so a world
/// where the walkable neighbour WAS reached and only the target tile was unwalkable published
/// <c>route_exists_cardinal=false</c> beside <c>target_enclosed=false</c> and no <c>approaches=</c> at all: a road that
/// exists, reported as no road, with the four tiles that answer it withheld. The engine branch published the same field
/// from the narrower question ("can the body step ONTO the tile"). One field, two questions, neither of them the caller's.
/// </para>
///
/// <para>
/// So the population is the VERDICT crossed with the arrival rule the request declared - four worlds times two rules,
/// each verdict produced by the real flood over a real walkable-component predicate, and each expectation derived from
/// the world's own definition rather than from the code under test. The arrival rule is part of the population because
/// the flood's ring is <see cref="StardewBodyController.IsArrivalDelta"/>'s set: a diagonal neighbour is an arrival for a
/// request that allows one and not for a request that does not, so one verdict means two different things.
/// </para>
///
/// <para>
/// The falsifier below is the shape that motivated the second half: a world whose only ring tile in the component is
/// DIAGONAL. Refused before the engine was asked under the old Manhattan-only ring, and accepted (and arrived) once the
/// probe asks the arrival rule the walk declares.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the verdict claims are read from real floods and real refusals driven in a headless world, while one assertion reads the repository source because a literal re-introduced into the file is exactly the mutation no behaviour test can see.
[Collection(HeadlessGameWorld.Collection)]
public sealed class ReachabilityVerdictClaimTests
{
    private const string Gate = "a_reachability_verdict_says_which_it_means";

    private readonly ITestOutputHelper output;

    public ReachabilityVerdictClaimTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// One world, reduced to the four facts an expectation can be written from: which tiles a body may traverse, whether
    /// a tile the EXACT arrival rule accepts is in the component, whether a Chebyshev-1 tile is, and whether the target
    /// tile itself admits a body.
    /// </summary>
    private sealed record World(
        string Case,
        Point Actor,
        Point Target,
        Func<Point, bool> Walkable,
        bool CardinalRingInComponent,
        bool DiagonalRingInComponent,
        bool TargetTraversable)
    {
        /// <summary>Can a cardinal walk arrive from somewhere in the component, under this arrival rule?</summary>
        public bool WalkArrives(bool allowAdjacentArrival) =>
            (this.CardinalRingInComponent && this.TargetTraversable)
            || (allowAdjacentArrival && this.DiagonalRingInComponent);

        /// <summary>Is every tile the arrival rule accepts outside the component?</summary>
        public bool RingIsOutsideTheComponent(bool allowAdjacentArrival) =>
            !(allowAdjacentArrival ? this.DiagonalRingInComponent : this.CardinalRingInComponent);
    }

    /// <summary>
    /// The population: four worlds, each one a shape a refusal has to tell apart. Every predicate is finite, so the flood
    /// can exhaust it and make a claim (an unbounded component abandons the claim instead, which is a different test).
    /// </summary>
    private static IReadOnlyList<World> Worlds()
    {
        static bool SealedRoom(Point tile) => tile.X >= 0 && tile.X <= 2 && tile.Y >= -1 && tile.Y <= 1;
        static bool RoomWithoutTarget(Point tile) =>
            tile.X >= 0 && tile.X <= 4 && tile.Y >= 0 && tile.Y <= 2 && tile != new Point(3, 0);
        static bool Room(Point tile) => tile.X >= 0 && tile.X <= 4 && tile.Y >= 0 && tile.Y <= 2;
        // The diagonal case: a staircase body component whose only tile on the target's Chebyshev ring is its
        // north-west diagonal, because every CARDINAL neighbour of the target is outside the component.
        static bool Staircase(Point tile) =>
            tile == new Point(2, 2) || tile == new Point(3, 2) || tile == new Point(3, 3)
            || tile == new Point(4, 3) || tile == new Point(4, 4);

        return new[]
        {
            // The target is a sealed pocket five tiles east: no route, in either arrival rule.
            new World("target_behind_a_sealed_pocket", new Point(0, 0), new Point(5, 0), SealedRoom, false, false, false),
            // The road reaches the target's CARDINAL neighbour and the target tile itself refuses a body: a route
            // exists, and only an exact-arrival request cannot be served by it.
            new World("ring_reached_target_unwalkable", new Point(0, 0), new Point(3, 0), RoomWithoutTarget, true, true, false),
            // The ordinary world: the component reaches a cardinal neighbour and the target tile admits a body.
            new World("target_enterable", new Point(0, 0), new Point(3, 0), Room, true, true, true),
            // The measured shape: only a DIAGONAL ring tile is in the component.
            new World("only_diagonal_ring_reached", new Point(2, 2), new Point(5, 5), Staircase, false, true, true),
        };
    }

    [Fact]
    public void EveryVerdictSaysWhichItMeans()
    {
        var claims = new List<string>();
        int routeClaimed = 0;
        int noRoute = 0;
        int enclosed = 0;
        foreach (World world in Worlds())
        {
            foreach (bool allowAdjacentArrival in new[] { false, true })
            {
                ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
                    world.Actor,
                    world.Target,
                    world.Walkable,
                    maxVisited: 4000,
                    findClosestReachable: true,
                    allowAdjacentArrival: allowAdjacentArrival);

                string label = $"{Gate}:{world.Case}:adjacent={(allowAdjacentArrival ? "true" : "false")}";
                verdict.Should().NotBeNull($"{label} - a finite component must produce a claim");
                ReachabilityVerdict assessed = verdict!.Value;
                string claim = StardewBodyController.DescribeRouteClaim(assessed, allowAdjacentArrival);
                claims.Add($"{label} -> {claim}");

                // Written from the WORLD's own definition, never from the claim: a gate that restates the code it
                // checks can only agree with it.
                bool expectedRoute = world.WalkArrives(allowAdjacentArrival);
                bool expectedEnclosed = world.RingIsOutsideTheComponent(allowAdjacentArrival);
                Field(claim, "route_exists_cardinal").Should().Be(
                    expectedRoute ? "true" : "false",
                    $"{label}: a cardinal walk {(expectedRoute ? "arrives" : "arrives nowhere")} here - the component "
                    + $"{(world.CardinalRingInComponent ? "does" : "does not")} reach a tile the exact rule accepts, "
                    + $"{(world.DiagonalRingInComponent ? "does" : "does not")} reach a diagonal one, and the target tile "
                    + $"{(world.TargetTraversable ? "admits" : "refuses")} a body - got: {claim}");
                Field(claim, "target_enclosed").Should().Be(
                    expectedEnclosed ? "true" : "false",
                    $"{label}: the arrival rule's own ring is {(expectedEnclosed ? "outside" : "inside")} the component - got: {claim}");
                // The narrower fact stays narrower: stepping ONTO the tile needs a cardinal neighbour, however wide the
                // arrival ring is.
                assessed.ComponentContainsTarget.Should().Be(
                    world.CardinalRingInComponent && world.TargetTraversable,
                    $"{label}: 'the planner can step onto the tile' is a different claim from 'the walk arrives'");

                routeClaimed += expectedRoute ? 1 : 0;
                noRoute += expectedRoute ? 0 : 1;
                enclosed += expectedEnclosed ? 1 : 0;
            }
        }

        foreach (string line in claims)
            this.output.WriteLine(line);
        this.output.WriteLine(
            $"cases examined {claims.Count} · route claimed {routeClaimed} · no route {noRoute} · ring outside the component {enclosed}");

        claims.Should().HaveCount(8, "four worlds crossed with two arrival rules");
        routeClaimed.Should().BeGreaterThan(0, "a population where nothing is reachable agrees with itself");
        noRoute.Should().BeGreaterThan(0, "and so does one where everything is");
    }

    /// <summary>
    /// THE FALSIFIER, on the measured shape: a goal whose only ring tile in the component is diagonal. Before the ring
    /// asked the arrival rule, the flood vetoed this walk before the engine was ever asked
    /// (<c>native=not_attempted</c>); now the walk is accepted, and the departure it produces is
    /// <c>target_reached</c> on that diagonal tile.
    /// </summary>
    [Fact]
    public void ADiagonalOnlyRingIsRefusedForAnExactRequestAndArrivedForAnAdjacentOne()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        BuildStaircase(harness);
        Vector2 target = new(5f, 5f);
        // EXACT: the walk must end ON 5,5, which no cardinal route reaches. Refused before the engine, and it says so.
        (string exactCode, string? exactEvidence, _) = Refuse(harness, new Vector2(2f, 2f), target, allowAdjacentArrival: false);
        exactCode.Should().Be(StardewBodyController.NoNativePathReasonCode);
        exactEvidence.Should().Contain("native=not_attempted", "an exact request cannot arrive, so the engine is never asked");
        Field(exactEvidence!, "target_enclosed").Should().Be("true");
        Field(exactEvidence!, "route_exists_cardinal").Should().Be("false");
        Field(exactEvidence!, "progress").Should().Be("none", "the flood's nearest tile is the end of a dead end here");

        // ADJACENT: the same world, the same target, and 4,4 is an arrival the request accepts. The engine is asked and
        // the walk starts - which is the whole difference between the two rules.
        harness.Actor.position.Set(new Vector2(2 * 64 + 8, 2 * 64));
        ExecutionState state = ExecutionState.Accepted;
        string? arrival = null;
        var controller = new StardewBodyController((transition, reasonCode, _) =>
        {
            state = transition;
            arrival = reasonCode;
        });
        var adjacent = new LocalMoveSpec(
            "execution_01",
            "request_01",
            target,
            AllowAdjacentArrival: true,
            1,
            10_000,
            long.MaxValue);
        bool started = controller.TryStart(adjacent, harness.Actor, tick: 1, out string adjacentCode, out _, out _);
        started.Should().BeTrue(
            $"4,4 is Chebyshev-1 of 5,5 and the request allows an adjacent arrival, so the walk exists - got: {adjacentCode}");

        // The body stands where the engine would stop: the diagonal tile.
        harness.Actor.position.Set(new Vector2(4 * 64 + 8, 4 * 64));
        controller.Update(tick: 2);

        state.Should().Be(ExecutionState.Succeeded, "standing on the arrival tile the request declared is success");
        arrival.Should().Be("target_reached");
    }

    /// <summary>
    /// The other half of the same field, on the wire: a world where the road reaches the target's neighbour and the TILE
    /// refuses. The two claims must read <c>false</c>/<c>false</c> - no route for THIS request, and the ring is not
    /// outside the component - and the four approaches must be named, because they are the answer.
    ///
    /// RED BEFORE THE CHANGE, in two ways: <c>route_exists_cardinal</c> was the literal <c>false</c> (so this world and
    /// the sealed pocket were spelled identically apart from <c>target_enclosed</c>), and <c>approaches=</c> was
    /// published only when <c>target_enclosed=true</c>, so this world - the one whose answer IS the ring - carried none.
    /// </summary>
    [Fact]
    public void ARoadThatReachesTheNeighboursOfAnUnenterableTileSaysSoAndNamesTheRing()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        // The staircase PLUS the target's south neighbour: the road reaches a tile the exact rule accepts and stops there.
        BuildStaircase(harness, (5, 4));
        // The target tile itself now refuses a body.
        harness.Location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(0, 1, 1, new Vector2(5f, 5f)));

        (string code, string? evidence, string? hint) = Refuse(harness, new Vector2(2f, 2f), new Vector2(5f, 5f), allowAdjacentArrival: false);

        code.Should().Be(StardewBodyController.NoNativePathReasonCode);
        Field(evidence!, "target_enclosed").Should().Be(
            "false", "the flood reaches a tile the exact rule accepts, so the target's neighbourhood is NOT outside the component");
        Field(evidence!, "route_exists_cardinal").Should().Be(
            "false", "and no cardinal walk ends ON a tile that refuses a body - the two false cases are different worlds, not one");
        Field(evidence!, "target_walkable").Should().Be("false");
        evidence!.Should().Contain("approaches=", "the four tiles beside the target are the answer, so the receipt names them");
        hint.Should().NotBeNull();
        hint!.Should().Contain("progress=none");
    }

    /// <summary>
    /// The field cannot go back to being a word somebody typed. Every occurrence of it in the controller must live in the
    /// one function that derives it, and the population is the occurrences themselves - so a second mint site fails here
    /// by name instead of reaching a model.
    /// </summary>
    [Fact]
    public void TheFieldIsOnlyEverDerived()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));
        string derivation = MethodBody(source, "internal static string DescribeRouteClaim(");
        const string field = "route_exists_cardinal";
        int bodyStart = source.IndexOf(derivation, StringComparison.Ordinal);
        bodyStart.Should().BeGreaterThanOrEqualTo(0, "the derivation must exist for this gate to mean anything");
        int bodyEnd = bodyStart + derivation.Length;

        // CODE only. The file's docblocks quote the old receipts on purpose - a measurement recorded in prose is not a
        // mint site, and counting it would make the gate fire on its own history.
        var code = new List<(int Line, int Offset, string Text)>();
        string[] lines = source.Split('\n');
        int offset = 0;
        for (int number = 0; number < lines.Length; number += 1)
        {
            string line = lines[number];
            string trimmed = line.TrimStart();
            bool isComment = trimmed.StartsWith("//", StringComparison.Ordinal);
            if (!isComment && line.Contains(field, StringComparison.Ordinal))
                code.Add((number + 1, offset, line.Trim()));
            offset += line.Length + 1;
        }

        code.Should().NotBeEmpty("a field no code mentions is a field this gate stopped watching");
        foreach ((int line, int position, string text) in code)
        {
            (position >= bodyStart && position < bodyEnd).Should().BeTrue(
                $"{field} sits in code at StardewBodyController.cs:{line} outside the one derivation - a literal verdict in "
                + $"a branch is the defect this gate exists for, because it reads as a measurement while nothing computed it: {text}");
            text.Should().NotContain($"{field}=false");
            text.Should().NotContain($"{field}=true");
        }

        this.output.WriteLine($"{field} code sites examined {code.Count} · all inside the derivation");
    }

    // -------------------------------------------------------------------------
    // The world, and the drive.
    // -------------------------------------------------------------------------

    /// <summary>
    /// The staircase: the actor's body component is five tiles, and the only tile of it on the target's Chebyshev ring is
    /// the DIAGONAL 4,4 - every cardinal neighbour of 5,5 is outside the component. Unpriced clumps elsewhere, the wall
    /// <see cref="ClearStepMoveTests.CorridorHarness"/> itself builds with.
    /// </summary>
    private static void BuildStaircase(ClearStepMoveTests.CorridorHarness harness, params (int X, int Y)[] alsoOpen)
    {
        var open = new List<(int X, int Y)> { (2, 2), (3, 2), (3, 3), (4, 3), (4, 4), (5, 5) };
        open.AddRange(alsoOpen);
        var walkable = new HashSet<(int X, int Y)>(open);
        xTile.Layers.Layer back = harness.Location.map.GetLayer("Back");
        for (int x = 0; x < back.LayerWidth; x += 1)
        {
            for (int y = 0; y < back.LayerHeight; y += 1)
            {
                if (walkable.Contains((x, y)))
                    continue;
                harness.Location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(0, 1, 1, new Vector2(x, y)));
            }
        }
    }

    private static (string Code, string? Evidence, string? Hint) Refuse(
        ClearStepMoveTests.CorridorHarness harness,
        Vector2 actorTile,
        Vector2 target,
        bool allowAdjacentArrival)
    {
        harness.Actor.position.Set(new Vector2((int)actorTile.X * 64 + 8, (int)actorTile.Y * 64));
        var specification = new LocalMoveSpec(
            "execution_01",
            "request_01",
            target,
            allowAdjacentArrival,
            1,
            10_000,
            long.MaxValue);
        bool started = new StardewBodyController((_, _, _) => { })
            .TryStart(specification, harness.Actor, tick: 1, out string reasonCode, out string? evidence, out string? hint);
        started.Should().BeFalse("no cardinal walk in this world satisfies an exact request");
        return (reasonCode, evidence, hint);
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

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"declaration not found: {declaration}");
        int open = source.IndexOf('{', start);
        int depth = 0;
        for (int position = open; position < source.Length; position += 1)
        {
            if (source[position] == '{') depth += 1;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(start, position - start + 1);
        }

        throw new InvalidOperationException($"unbalanced body: {declaration}");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }
}
