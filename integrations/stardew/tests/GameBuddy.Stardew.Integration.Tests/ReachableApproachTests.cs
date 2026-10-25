using System.Collections.Generic;
using System.IO;
using FluentAssertions;
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
public sealed class ReachableApproachTests
{
    private static HashSet<(int X, int Y)> Tiles(params (int X, int Y)[] tiles) => new(tiles);

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

        (string code, string evidence) = ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), standable.Contains);
        code.Should().Be("no_reachable_approach:5:5", "the refusal names the tile, so a reader knows which target had no approach");
        evidence.Should().Contain("target=5,5", "the human-facing pair still reads as a coordinate");
    }

    [Fact]
    public void TheRefusalDistinguishesAWalledOffNeighbourFromNoNeighbourAtAll()
    {
        // Both refuse, but the evidence must not tell the same story: one placement has a free
        // tile the actor cannot reach (a wall), the other has no free tile (geometry).
        (string walledCode, string walledEvidence) =
            ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles((5, 6)).Contains);
        (string noneCode, string noneEvidence) =
            ExecutionManager.DescribeNoReachableApproach((5, 5), (0, 0), Tiles().Contains);

        walledCode.Should().Be(noneCode, "the placement has no approach either way");
        walledEvidence.Should().Contain("standable_neighbour=unreachable");
        noneEvidence.Should().Contain("standable_neighbour=none");
    }

    [Fact]
    public void TheRefusalCodeSatisfiesTheValidatorThatWillJudgeIt()
    {
        // The code is emitted into a receipt, so it must survive the journal's own validator and
        // the wire's schema. Asserted against the REAL validator and the REAL schema file rather
        // than a second copy of the pattern: a future tightening has to fail here instead of
        // silently faulting the bridge.
        (string code, _) = ExecutionManager.DescribeNoReachableApproach((35, 54), (0, 0), Tiles((35, 55)).Contains);

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
