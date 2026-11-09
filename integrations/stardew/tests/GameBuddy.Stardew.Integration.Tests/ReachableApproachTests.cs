using System.Collections.Generic;
using System.IO;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Choosing the standing tile before a walk is committed, with the two facts kept apart.
///
/// <para>
/// <c>ApproachTileSelector</c> already answered "where should the actor stand" from both
/// predicates, and had six passing tests — but no production caller. The runtime kept its own
/// older helper that asked only "is this tile free", so a tile behind a fence won on geometry,
/// the walk was committed, and the engine answered <c>no_native_path</c>.
/// </para>
///
/// <para>
/// Measured 2026-10-25: five such refusals in one run, and one 57-second gap between a refusal
/// and the next executable action. The tool approach also handed the target tile itself to the
/// engine's planner (<c>adjacentArrival</c>), asking a four-way, 10 000-expansion-bounded search
/// to discover a neighbour — and on a large farm it exhausted first.
/// </para>
///
/// <para>
/// These cases pin the decision as arithmetic, because the live world cannot be asked in a unit
/// test and the wiring is what was missing, not the rule.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class ReachableApproachTests
{
    private static HashSet<(int X, int Y)> Tiles(params (int X, int Y)[] tiles) => new(tiles);

    // ---- guard 0: the ring is enumerated once, and it answers the count as well as the choice ----

    /// <summary>
    /// The ring is one enumeration read by both halves of the refusal: HOW MANY tiles there are to stand on (a count)
    /// and WHICH of them can be walked to (the choice). Two enumerations of the same ring is how the two start
    /// disagreeing about a tile that exists, so the selector exposes the enumeration the count is taken from.
    ///
    /// <para>
    /// The count's half of this file sits in this project rather than in `Core.Tests` because a count with no reader is
    /// arithmetic: what makes it a fact is that the refusal publishes it beside the word, and only this project can call
    /// the refusal. Pinning the two in one place is also what makes a collapse of either one fail here.
    /// </para>
    /// </summary>
    [Fact]
    public void OneStandableNeighbourIsCountedOnce()
    {
        ApproachTileSelector.StandableCandidates(new[] { (5, 5) }, Tiles((5, 6)).Contains)
            .Should().ContainSingle("one free tile beside the goal is one place to stand")
            .Which.Should().Be((5, 6));
    }

    /// <summary>
    /// The count is the number of TILES, not the number of ways to reach one. A two-tile footprint shares neighbours
    /// with itself, so a candidate offered from both of its tiles is one place to stand - counting the offers would
    /// report ground the actor does not have.
    /// </summary>
    [Fact]
    public void AFootprintOfTwoTilesThatShareANeighbourCountsItOnce()
    {
        // (4,5) is north-west of (5,5) and north-west of (5,6): both footprint tiles offer it, and it is one tile.
        ApproachTileSelector.StandableCandidates(new[] { (5, 5), (5, 6) }, Tiles((4, 5)).Contains)
            .Should().ContainSingle("a shared neighbour is one place to stand, not two ways of reaching it")
            .Which.Should().Be((4, 5));
    }

    /// <summary>
    /// The two answers, in one breath: two tiles exist to stand on, and neither can be walked to. Neither answer may be
    /// derived from the other - collapsing them turns "clear what is in the way" into "pick another target".
    /// </summary>
    [Fact]
    public void AStandableNeighbourNobodyCanWalkToIsCountedAndRefusedAtOnce()
    {
        (int X, int Y)[] ring = { (5, 5) };
        HashSet<(int X, int Y)> standable = Tiles((5, 6), (5, 4));

        ApproachTileSelector.StandableCandidates(ring, standable.Contains)
            .Should().HaveCount(2, "the count answers how many places there are, not how many can be walked to");

        ApproachTileSelector.Select(ring, (0, 0), standable.Contains, _ => false)
            .Should().BeNull("the choice answers which of them can be walked to, and here that is none");
    }

    /// <summary>
    /// The agreement the split exists for: whatever the choice returns is one of the tiles the count counted, so a
    /// refusal that says "two places" can never walk to a third.
    /// </summary>
    [Fact]
    public void TheChoiceIsAlwaysOneOfTheTilesTheCountCounted()
    {
        (int X, int Y)[] ring = { (5, 5) };
        HashSet<(int X, int Y)> standable = Tiles((5, 6), (5, 4), (4, 5), (6, 5));

        IReadOnlyList<(int X, int Y)> counted = ApproachTileSelector.StandableCandidates(ring, standable.Contains);
        (int X, int Y)? chosen = ApproachTileSelector.Select(ring, (5, 8), standable.Contains, tile => tile != (5, 6));

        chosen.Should().NotBeNull("three of the four counted tiles are walkable-to");
        counted.Should().Contain(chosen!.Value, "the count and the choice read the same ring");
    }

    // ---- guard 1: no reachable neighbour is refused, and nothing is dispatched --------------

    [Fact]
    public void AStandableButUnreachableNeighbour_YieldsNoTile_AndTheNamedRefusal()
    {
        // The only free neighbours sit behind a fence: the actor is at (0,0) and that is the
        // whole reachable component. Picking either one commits a walk that cannot arrive.
        HashSet<(int X, int Y)> standable = Tiles((5, 6), (5, 4));
        HashSet<(int X, int Y)> reachable = Tiles((0, 0));

        ExecutionManager.SelectToolApproachTile((5, 5), (0, 0), standable.Contains, reachable.Contains)
            .Should().BeNull("there is nowhere to stand, so no walk may be committed");

        (string code, string evidence, _) = ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), standable.Contains);
        code.Should().Be("no_reachable_approach:5:5", "the refusal names the tile, so a reader knows which target had no approach");
        evidence.Should().Contain("target=5,5", "the human-facing pair still reads as a coordinate");
    }

    [Fact]
    public void TheRefusalDistinguishesAWalledOffNeighbourFromNoNeighbourAtAll()
    {
        // Both refuse, but the evidence must not tell the same story: one placement has a free
        // tile the actor cannot reach (a wall), the other has no free tile (geometry).
        (string walledCode, string walledEvidence, _) =
            ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles((5, 6)).Contains);
        (string noneCode, string noneEvidence, _) =
            ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles().Contains);

        walledCode.Should().Be(noneCode, "the placement has no approach either way");
        walledEvidence.Should().Contain("standable_neighbour=unreachable");
        noneEvidence.Should().Contain("standable_neighbour=none");
    }

    /// <summary>
    /// The refusal answers two questions in one breath: HOW MANY tiles there are to stand on, and WHICH of them can be
    /// walked to. The first is the count that separates "clear what is in the way" from "pick another target"; the
    /// second is the word. Deriving the count from the choice - one place if a walk was possible, none otherwise -
    /// collapses them into one answer and reports a walled-off ring as a ring with no free tile at all.
    /// </summary>
    [Fact]
    public void TheRefusalCountsTheStandableTilesInsteadOfDerivingTheCountFromTheChoice()
    {
        (string walledCode, string walledEvidence, _) =
            ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles((5, 6)).Contains);
        (_, string twoEvidence, _) =
            ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles((5, 6), (5, 4)).Contains);
        (_, string noneEvidence, _) =
            ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles().Contains);

        walledCode.Should().Be("no_reachable_approach:5:5", "one free tile she cannot walk to is still no approach");
        walledEvidence.Should().Contain("standable_tiles=1", "there is one place to stand, so the count says one");
        twoEvidence.Should().Contain("standable_tiles=2", "both ring tiles are free, and one is offered by neither the other")
            .And.Contain("standable_neighbour=unreachable", "and neither of them is walkable-to: a wall, not geometry");
        noneEvidence.Should().Contain("standable_tiles=0").And.Contain("standable_neighbour=none",
            "with no free neighbour at all the count and the word agree, which is the one case they coincided in before");
    }

    [Fact]
    public void TheNoApproachRefusalCarriesTheFactAModelCanActOnAsItsHint()
    {
        // The refusal's evidence names which shape it is, and a settled failure's evidence is withheld (ADR-006), so a
        // node kept `no_reachable_approach:5:5` and nothing else - a verdict a companion can only answer by aiming again.
        // The hint is the channel that survives into the node's ledger, so it has to carry the same distinction.
        (_, _, string walledHint) = ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles((5, 6)).Contains);
        (_, _, string noneHint) = ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles().Contains);

        walledHint.Should().Be("no_approach;standable_neighbour=unreachable");
        noneHint.Should().Be("no_approach;standable_neighbour=none", "a wall and geometry are different corrections");
    }

    [Fact]
    public void TheRefusalCodeSatisfiesTheValidatorThatWillJudgeIt()
    {
        // The code is emitted into a receipt, so it must survive the journal's own validator and
        // the wire's schema. Asserted against the REAL validator and the REAL schema file rather
        // than a second copy of the pattern: a future tightening has to fail here instead of
        // silently faulting the bridge.
        (string code, _, _) = ExecutionManager.DescribeNoReachableApproach((35, 54), (0, 0), Tiles((35, 55)).Contains);

        FarmhandExecutionJournal.IsValidReasonCode(code)
            .Should().BeTrue($"{code} is journaled as a receipt reasonCode");

        string schema = File.ReadAllText(RepositorySourcePath(Path.Combine("protocol", "bridge-v1.schema.json")));
        schema.Should().Contain("^[a-z0-9_:-]{1,128}$", "the schema declares the wire's reasonCode alphabet");
        System.Text.RegularExpressions.Regex.IsMatch(code, "^[a-z0-9_:-]{1,128}$")
            .Should().BeTrue($"{code} is published to the Host as a receipt reasonCode");
    }

    // ---- guard 2: a reachable neighbour wins even when it is not the nearest ----------------

    [Fact]
    public void AReachableNeighbourWins_EvenWhenTheNearestIsUnreachable()
    {
        // (5,6) is one step from the actor at (5,7); (5,4) is three steps away. Geometry says
        // (5,6); reachability says (5,4) is the only tile the actor can walk to.
        HashSet<(int X, int Y)> standable = Tiles((5, 6), (5, 4));
        HashSet<(int X, int Y)> reachable = Tiles((5, 4));

        ExecutionManager.SelectToolApproachTile((5, 5), (5, 7), standable.Contains, reachable.Contains)
            .Should().Be((5, 4), "an unreachable tile is not an approach, however close it is");
    }

    // ---- guard 3: the test-island's own case now reaches the runtime path -------------------

    [Fact]
    public void SelectStandingApproachTile_SkipsTheUnreachableTile()
    {
        // `SelectStandingApproachTile` now delegates to the selector with a real reachability
        // predicate, so the case `StandingApproachTests` pinned in isolation (a nearer tile that
        // cannot be walked to) also holds on the runtime path.
        Vector2 target = new(5f, 5f);
        HashSet<Vector2> standable = new() { new Vector2(5f, 6f), new Vector2(5f, 4f) };
        HashSet<Vector2> reachable = new() { new Vector2(5f, 4f) };

        ExecutionManager.SelectStandingApproachTile(target, new Vector2(5f, 7f), standable.Contains, reachable.Contains)
            .Should().Be(new Vector2(5f, 4f), "the reachable tile is the approach, not the nearest one");

        ExecutionManager.SelectStandingApproachTile(target, new Vector2(5f, 7f), standable.Contains, _ => false)
            .Should().BeNull("with nothing reachable, null is honest and a wrong tile is not");
    }

    // ---- guard 3b: the runtime path carries a reachability predicate and refuses first ------

    [Fact]
    public void TheToolApproach_ChoosesTheTileBeforeDispatching_AndRefusesBeforeCommittingAWalk()
    {
        string source = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.resourcetoolactions.cs")));
        string body = MethodBody(source, "private LocalExecutionReceipt TryBeginToolApproach(");

        body.Should().Contain("SelectToolApproachTile(", "the choice must be made before the walk is dispatched");
        body.Should().Contain("BuildWalkableComponent(", "reachability is the actor's own component, not geometry");
        body.Should().Contain("DescribeNoReachableApproach(", "a placement with no approach must name itself");
        // The refusal must be emitted and must return before `TryStart`, or a walk is committed
        // for a placement that has no approach and the engine spends its search budget finding out.
        int refusal = body.IndexOf("DescribeNoReachableApproach(", System.StringComparison.Ordinal);
        int dispatch = body.IndexOf("this.controller.TryStart(", System.StringComparison.Ordinal);
        refusal.Should().BeGreaterThanOrEqualTo(0);
        dispatch.Should().BeGreaterThanOrEqualTo(0);
        refusal.Should().BeLessThan(dispatch, "nothing may be dispatched when there is no approach to walk to");

        // The old shape handed the target tile to the finder with adjacent arrival and let it
        // discover a neighbour. That is the search that exhausted.
        body.Should().Contain("new Vector2(goal.X, goal.Y)",
            "the walk must be dispatched to the chosen standing tile, not the target");
        // The two facts stay separate: a route that fails to an existing tile is not "no approach".
        body.Should().Contain("target_out_of_reach", "a failed route keeps the existing refusal");
    }

    // ---- guard 4: a moving target's approach is still recalculated --------------------------

    [Fact]
    public void AMovingTargetsApproach_IsStillRecalculatedFromTheLiveTile()
    {
        // The moving families plan against the LIVE tile and re-validate on arrival, so the
        // selection has to depend on the target it is given NOW: one actor, one world, two target
        // tiles, two different standing tiles.
        HashSet<(int X, int Y)> tiles = Tiles((5, 6), (7, 6));

        (int X, int Y)? first = ExecutionManager.SelectToolApproachTile((5, 5), (5, 8), tiles.Contains, tiles.Contains);
        (int X, int Y)? moved = ExecutionManager.SelectToolApproachTile((7, 5), (5, 8), tiles.Contains, tiles.Contains);

        first.Should().Be((5, 6));
        moved.Should().Be((7, 6), "a target that walked must be approached where it is now");
    }

    // -------------------------------------------------------------------------

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, System.StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }
        throw new System.InvalidOperationException($"unbalanced body for {signature}");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { System.AppContext.BaseDirectory, System.Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }
        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
