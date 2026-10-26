using System;

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
    /// </summary>
    public static (int X, int Y)? Select(
        IReadOnlyList<(int X, int Y)> targetTiles,
        (int X, int Y) actor,
        Func<(int X, int Y), bool> isStandable,
        Func<(int X, int Y), bool> isReachable)
    {
        if (targetTiles is null || targetTiles.Count == 0) return null;

        // Standing on the target is not approaching it: a rock, a crop or a machine occupies the tile, and the actor
        // works from beside it. Every occupied tile is excluded, not just the anchor.
        HashSet<(int X, int Y)> occupied = new(targetTiles);
        (int X, int Y) anchor = targetTiles[0];

        (int X, int Y)? best = null;
        int bestDistance = int.MaxValue;
        bool bestIsBehind = true;

        foreach ((int X, int Y) occupiedTile in occupied)
        {
            foreach ((int dx, int dy) in NeighbourOffsets)
            {
                (int X, int Y) candidate = (occupiedTile.X + dx, occupiedTile.Y + dy);
                if (occupied.Contains(candidate)) continue;
                if (!isStandable(candidate)) continue;
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
        }

        return best;
    }
}
