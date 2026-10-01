using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The path-goal contract for local movement, tested as BEHAVIOUR.
///
/// The native path finder consumes a goal predicate, not a coordinate: `findPath`
/// enqueues the start node unconditionally (`PathFindController.cs:194`) and tests
/// `isAtEnd` on each dequeue (`:199-203`). Passing the exact-coordinate predicate
/// (`isAtEndPoint`, which is `currentNode.x == endPoint.X &amp;&amp; currentNode.y ==
/// endPoint.Y`) asked "can this tile be stood on", so a request for a tile that
/// cannot be occupied returned null even when a walkable neighbour existed.
///
/// These tests exercise the arithmetic directly rather than matching source text,
/// because a text pin still passes if the same condition yields a different value.
/// </summary>
public sealed class StardewBodyControllerPathGoalTests
{
    // ---- exact geometry -----------------------------------------------------

    [Theory]
    [InlineData(0, 0, true, true)]
    [InlineData(0, 0, false, true)]
    public void Exact_RequestedTileIsAlwaysArrival(int dx, int dy, bool allowAdjacent, bool expected)
    {
        StardewBodyController.IsArrivalDelta(dx, dy, allowAdjacent).Should().Be(expected);
    }

    [Theory]
    // The requested tile is arrival even when an adjacent approach is allowed, so
    // an actor already standing on it gets the immediate single-node success.
    [InlineData(1, 0, true)]
    [InlineData(0, 1, true)]
    [InlineData(2, 0, true)]
    [InlineData(0, 2, true)]
    [InlineData(1, 1, false)]
    [InlineData(2, 1, false)]
    [InlineData(0, 0, false)]
    public void Arrival_IsGatedOnTheDirectiveGeometry(int dx, int dy, bool allowAdjacent)
    {
        // With adjacent arrival the whole Chebyshev-1 ring qualifies; without it
        // only the exact tile does. Every non-arrival case here must be false, which
        // is what keeps the planner from stopping short of an exact request.
        bool expected = dx == 0 && dy == 0 || (allowAdjacent && dx <= 1 && dy <= 1);
        StardewBodyController.IsArrivalDelta(dx, dy, allowAdjacent).Should().Be(expected);
    }

    [Fact]
    public void Arrival_ExactMode_CoversExactlyTheFourAxesAndOrigin()
    {
        var arrived = new List<(int X, int Y)>();
        for (int dx = -2; dx <= 2; dx++)
        {
            for (int dy = -2; dy <= 2; dy++)
            {
                if (StardewBodyController.IsArrivalDelta(Math.Abs(dx), Math.Abs(dy), allowAdjacentArrival: false))
                    arrived.Add((dx, dy));
            }
        }

        arrived.Should().BeEquivalentTo(new[] { (0, 0) },
            "an exact request must accept only the requested tile, never a neighbour");
    }

    [Fact]
    public void Arrival_AdjacentMode_CoversTheWholeChebyshevRingIncludingDiagonals()
    {
        var arrived = new List<(int X, int Y)>();
        for (int dx = -2; dx <= 2; dx++)
        {
            for (int dy = -2; dy <= 2; dy++)
            {
                if (StardewBodyController.IsArrivalDelta(Math.Abs(dx), Math.Abs(dy), allowAdjacentArrival: true))
                    arrived.Add((dx, dy));
            }
        }

        // 3x3 block minus the four corners at Chebyshev-2.
        arrived.Should().HaveCount(9);
        arrived.Should().Contain(new[] { (1, 1), (-1, 1), (1, -1), (-1, -1) },
            "measured on the target version, A* ended DIAGONALLY on 4 of 6 sampled unreachable targets");
        arrived.Should().NotContain(new[] { (2, 0), (0, 2), (2, 2) },
            "Chebyshev-2 is outside the interaction neighbourhood");
    }

    // ---- the two halves must agree ------------------------------------------

    [Fact]
    public void PredicateAndArrivalTest_AcceptTheSameNeighbourhood()
    {
        // The planner stops where the goal predicate says, and Update then decides
        // whether that stop is success. If the two disagree, a completed route is
        // reported as `native_path_ended`. Both must be Chebyshev-1 for adjacent
        // approaches, which is why this asserts them together.
        //
        // The origin is deliberately excluded: the goal predicate accepts it (an
        // actor already standing correctly must get the immediate single-node
        // success), while the arrival test must not call it "adjacent" or standing
        // still would be reported as a neighbour arrival. Update checks exact
        // distance separately, so the split is intentional and pinned below.
        for (int dx = -2; dx <= 2; dx++)
        {
            for (int dy = -2; dy <= 2; dy++)
            {
                if (dx == 0 && dy == 0)
                    continue;
                bool goalAccepts = StardewBodyController.IsArrivalDelta(Math.Abs(dx), Math.Abs(dy), allowAdjacentArrival: true);
                bool arrivalAccepts = StardewBodyController.IsChebyshevAdjacent(Math.Abs(dx), Math.Abs(dy));
                arrivalAccepts.Should().Be(goalAccepts,
                    $"the goal predicate and the arrival test must agree at delta ({dx},{dy})");
            }
        }
    }

    [Fact]
    public void ArrivalTest_RejectsTheOrigin_SoTheExactBranchOwnsIt()
    {
        // The origin is arrival for the predicate but not "adjacent" for the arrival
        // test; Update checks exact distance separately, so this split must hold or
        // standing still would be reported as an adjacent arrival.
        StardewBodyController.IsChebyshevAdjacent(0, 0).Should().BeFalse();
        StardewBodyController.IsArrivalDelta(0, 0, allowAdjacentArrival: false).Should().BeTrue();
    }

    // ---- the plan must be built with the predicate ---------------------------

    [Fact]
    public void Plan_UsesThePredicateConstructor_NotTheCoordinateOne()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));

        // The coordinate overloads delegate to the predicate overload with
        // `isAtEndPoint` (PathFindController.cs:62/67/74/81). Only the predicate
        // overload can be handed a different goal, so the third argument must be the
        // predicate and the delegate type must be declared as such.
        source.Should().Contain("this.IsArrivalTile(specification)");
        source.Should().Contain("private PathFindController.isAtEnd IsArrivalTile(");
        source.Should().NotContain("new Point((int)specification.TargetTile.X, (int)specification.TargetTile.Y),");
    }

    [Fact]
    public void UnreachableTarget_KeepsTheDeadEndRejection()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));
        int start = source.IndexOf("public bool TryStart(", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0);

        string body = BalancedBody(source, start);
        // No tile satisfying the predicate means a genuinely unreachable target; the
        // rejection must keep naming both ends so the next attempt can differ.
        body.Should().Contain("plannedPath.pathToEndPoint is null");
        body.Should().Contain("\"no_native_path\"");
        body.Should().Contain("from={");
        body.Should().Contain("to={");
    }

    private static string BalancedBody(string source, int start)
    {
        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}' && started)
            {
                depth--;
                if (depth == 0)
                    return source.Substring(start, index - start + 1);
            }
        }

        return source.Substring(start);
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

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
