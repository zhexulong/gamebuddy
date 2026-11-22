using System;
using System.Collections.Generic;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Where the actor stands to work on a target tile.
///
/// This is the step before every native tool action, and it asks a different question than "which
/// standable tile is nearest". A tile can be standable and still be walled off from where the actor is;
/// choosing it commits the walk and then the engine answers `no_native_path`, which is a refusal the
/// agent can only read as "this target is unreachable" when in fact a free tile two steps further away
/// was available the whole time.
///
/// The caller supplies both predicates because only it knows how to ask the game: standability is one
/// answer (passable, not occupied, not the actor's own tile) and reachability is another (the actor's
/// own walkable component). Keeping them separate means the planner can be tested without a world, and
/// means a future caller that can answer reachability more cheaply does not have to change this rule.
///
/// The eight neighbours are tried in a fixed declared order and the nearest by Manhattan distance wins,
/// with strict `&lt;` so equidistant candidates keep that order. Determinism is a requirement, not a
/// nicety: a run-to-run diff has to mean the world changed, not that the sort was unstable.
///
/// WHICH NEIGHBOURS ARE OFFERED IS THE ACTION'S DECLARATION, NOT THIS CLASS'S OPINION. A row that declares
/// <see cref="ApproachStance.Any"/>, or declares no stance at all, is offered all eight; a swing that must be FACED at the
/// target (<see cref="ApproachStance.Cardinal"/>) is offered four, because a diagonal is a stand tile it cannot work from.
/// Both halves of the approach leg ask this class - the search below and <see cref="StandsWithin"/>, which the reach test
/// reads - so the tile she is sent to and the tile she is admitted to swing from cannot be two different answers.
/// </summary>
public static class ApproachTileSelector
{
    private static readonly (int X, int Y)[] NeighbourOffsets =
    {
        (-1, 0),
        (1, 0),
        (0, -1),
        (0, 1),
        (-1, -1),
        (1, -1),
        (-1, 1),
        (1, 1),
    };

    /// <summary>
    /// Whether a body standing on <paramref name="standing"/> can work <paramref name="target"/> from there under
    /// <paramref name="stance"/>.
    ///
    /// <para>
    /// THE ONE ANSWER BOTH HALVES OF THE LEG ASK: "is she already standing where this action can be done from?" (the reach
    /// test that decides whether to walk at all) and "which tile may she be sent to?" (<see cref="Select"/>). They used to
    /// answer separately - a bare Chebyshev-1 radius, which admits a diagonal - and `round92` is what that costs: the reach
    /// said yes from a diagonal and the swing refused `sweep_needs_cardinal_stance` three times in one plan.
    /// </para>
    /// </summary>
    public static bool StandsWithin((int X, int Y) target, (int X, int Y) standing, ApproachStance stance) =>
        stance == ApproachStance.Cardinal
            ? SwingFacing.For(standing, target) is not null
            : IsNeighbourOf(target, standing);

    /// <summary>The tile the body stands on is not a neighbour of itself - hence the two halves.</summary>
    private static bool IsNeighbourOf((int X, int Y) target, (int X, int Y) tile) =>
        tile != target && Math.Abs(tile.X - target.X) <= 1 && Math.Abs(tile.Y - target.Y) <= 1;

    /// <summary>
    /// The nearest neighbour of <paramref name="target"/> that the actor can stand on AND walk to, or
    /// null when no neighbour qualifies.
    ///
    /// Null is the honest answer here: it means this placement has no approach, which the caller must
    /// report as a structured refusal rather than committing a walk that cannot arrive.
    /// </summary>
    /// <summary>
    /// The nearest tile beside ANY tile of the target that the actor can stand on AND walk to, or null.
    ///
    /// The target is a SET of occupied tiles, not one. A 2x2 `ResourceClump` (a big rock or a stump) occupies four, and
    /// the caller used to pass only its top-left anchor - so the eight neighbours of the anchor could never include the
    /// tile a farmer standing SOUTH of the rock occupies, (X, Y + 2). Measured 2026-10-26: an actor arriving from the
    /// south had no legal candidate in the ring at all and was forced around to the north face, which is the reported
    /// "it walked round behind the rock".
    ///
    /// Among candidates the nearest to the actor wins, and a candidate that sits BEHIND the target - farther from the
    /// actor than the target is - loses ties to one on the near side. That is a preference, not a rule: when the near
    /// face is walled off the far face is still chosen, because a distant approach beats no approach.
    ///
    /// <paramref name="stance"/> narrows the ring to the tiles the action can be worked from, and null from this search
    /// is then the honest answer for an action whose ring has nowhere to stand - the refusal the caller owes, not a walk
    /// to a tile the action will refuse on arrival.
    /// </summary>
    public static (int X, int Y)? Select(
        IReadOnlyList<(int X, int Y)> targetTiles,
        (int X, int Y) actor,
        Func<(int X, int Y), bool> isStandable,
        Func<(int X, int Y), bool> isReachable,
        ApproachStance stance = ApproachStance.Any)
    {
        if (targetTiles is null || targetTiles.Count == 0) return null;
        (int X, int Y) anchor = targetTiles[0];

        (int X, int Y)? best = null;
        int bestDistance = int.MaxValue;
        bool bestIsBehind = true;

        foreach ((int X, int Y) candidate in StandableCandidates(targetTiles, isStandable, stance))
        {
            if (!isReachable(candidate)) continue;

            int distance = Math.Abs(candidate.X - actor.X) + Math.Abs(candidate.Y - actor.Y);
            // Behind means: travelling away from the anchor on the way to the candidate.
            bool behind =
                Math.Abs(candidate.X - actor.X) + Math.Abs(candidate.Y - actor.Y)
                > Math.Abs(anchor.X - actor.X) + Math.Abs(anchor.Y - actor.Y);
            // Strictly better distance wins; equal distance prefers the near face.
            if (best is not null && (distance > bestDistance || (distance == bestDistance && !(bestIsBehind && !behind))))
                continue;

            best = candidate;
            bestDistance = distance;
            bestIsBehind = behind;
        }

        return best;
    }

    /// <summary>
    /// Every tile beside the target that the actor could STAND on, in the declared candidate order, with no question
    /// asked about whether it can be walked to.
    ///
    /// <para>
    /// This is the enumeration <see cref="Select"/> chooses from, split out because a refusal needs the same answer
    /// twice in one breath: "is there anywhere to stand at all?" is a count, and "which one can I walk to?" is the
    /// choice. A second enumeration of the same ring here is how the two start disagreeing about a tile that exists.
    /// </para>
    /// <para>
    /// The count it answers is over <paramref name="stance"/>'s ring, so a refusal can tell "no tile at all" apart from
    /// "the only tiles are outside the stance" - see <c>DescribeNoReachableApproach</c>.
    /// </para>
    /// </summary>
    public static IReadOnlyList<(int X, int Y)> StandableCandidates(
        IReadOnlyList<(int X, int Y)> targetTiles,
        Func<(int X, int Y), bool> isStandable,
        ApproachStance stance = ApproachStance.Any)
    {
        List<(int X, int Y)> candidates = new();
        if (targetTiles is null || targetTiles.Count == 0) return candidates;

        // Standing on the target is not approaching it: a rock, a crop or a machine occupies the tile, and the actor
        // works from beside it. Every occupied tile is excluded, not just the anchor.
        HashSet<(int X, int Y)> occupied = new(targetTiles);
        // Two footprint tiles share neighbours, so a candidate can be reached from two of them; the declared order keeps
        // the first, and the count stays the number of TILES rather than the number of ways to reach one.
        HashSet<(int X, int Y)> offered = new();

        foreach ((int X, int Y) occupiedTile in occupied)
        {
            foreach ((int dx, int dy) in NeighbourOffsets)
            {
                (int X, int Y) candidate = (occupiedTile.X + dx, occupiedTile.Y + dy);
                if (occupied.Contains(candidate)) continue;
                // The STANCE decides which of the eight this action can be worked from; the offsets only fix the order,
                // so a restricted ring is the same walk down the same list with tiles it cannot use dropped.
                if (!StandsWithin(occupiedTile, candidate, stance)) continue;
                if (!isStandable(candidate)) continue;
                if (!offered.Add(candidate)) continue;

                candidates.Add(candidate);
            }
        }

        return candidates;
    }
}
