using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Pathfinding;

namespace GameBuddy.Stardew;

/// <summary>
/// One-shot, read-only, game-thread measurement of the native path finder's
/// goal predicate.
///
/// The open decision is to replace the native pathing target's exact
/// coordinate with an "is at end" predicate, on the reasoning that a target
/// tile which cannot itself be walked to will then yield a path to a
/// neighbouring tile instead of null. Source review cannot settle that claim,
/// because it is the A* dequeue order rather than the goal test alone that
/// decides where the returned path stops. This probe measures both halves on
/// the live game thread in one bounded pass:
///
///   Q1. For a target tile that the planner's own obstacle test rejects and
///       that has at least one walkable cardinal neighbour, does
///       <see cref="PathFindController.findPath"/> return a non-null path with
///       an adjacent-tile goal while the same call with an exact-coordinate
///       goal returns null?
///
///   Q2. Where does that adjacent goal's path end - on the target, on a
///       cardinal neighbour, or on a diagonal neighbour? This decides whether
///       the Mod's Manhattan-1 arrival test (<c>IsCardinalAdjacent</c> in
///       <see cref="StardewBodyController"/>) is still sufficient or must
///       become Chebyshev-1.
///
/// Because Q2 asks whether a diagonal ending ever occurs, the adjacent goal is
/// measured twice: once as "target or cardinal neighbour" (Manhattan &lt;= 1)
/// and once as "target or any neighbour" (Chebyshev &lt;= 1). A Manhattan-only
/// goal path cannot end diagonally by construction, so only the Chebyshev form
/// can expose whether the arrival test is a real bug. For the same reason the
/// scan collects a second family of targets whose cardinal neighbours are all
/// blocked but which have a walkable diagonal - the only geometry in which
/// that diagonal can appear.
///
/// Every measured target is at least two tiles from the actor, so the start
/// node itself satisfies none of the three goals. Without that exclusion a
/// radius-1 target would return the start node as a one-node convergence
/// (PathFindController.cs:194 enqueues the start unconditionally and :199-201
/// tests the goal before any collision check), which would look like a
/// predicate success while proving nothing about where A* stops.
///
/// It never moves the actor, never assigns a controller, never injects input,
/// and never touches a private member. Its obstacle classification calls the
/// planner's own test with findPath's own arguments except for
/// <c>skipCollisionEffects: true</c>, which removes the one side effect
/// findPath itself has (<c>FarmAnimal.farmerPushing</c>, GameLocation.cs:
/// 2572-2575) without changing any return value; see
/// <see cref="CollidesAt"/> for why that is equivalent. Pathfinding is only
/// attempted while the actor is idle, because <c>findPath</c> throws from its
/// own Interlocked reentrancy guard when another pathfind is active
/// (PathFindController.cs:182-185, :241-244).
/// </summary>
internal sealed class PathPredicateProbe
{
    private const string Schema = "gamebuddy-path-predicate-probe/v1";

    /// <summary>
    /// Env-gated activation, mirroring the xUnit seam probes
    /// (<c>ChestSeamProbe.EnableLiveProbeVariable</c> / <c>ShopMenuHeadlessProbe</c>).
    /// This probe is a reusable measurement, not a product capability, so it must
    /// never add a field to a user profile or to <c>ModConfig</c>: the external
    /// harness sets these variables for the one process it launches.
    /// </summary>
    private const string EnableLiveProbeVariable = "GAMEBUDDY_STARDEW_PATH_PREDICATE_PROBE_LIVE";
    private const string EvidencePathVariable = "GAMEBUDDY_STARDEW_PATH_PREDICATE_PROBE_EVIDENCE";

    /// <summary>
    /// Optional explicit `x,y` target, so the probe can measure the EXACT pair a production refusal reported
    /// instead of only the families it collects on its own. Set by the harness for one process.
    /// </summary>
    private const string TargetPathVariable = "GAMEBUDDY_STARDEW_PATH_PREDICATE_PROBE_TARGET";

    private static readonly JsonSerializerOptions EvidenceJsonOptions = new() { WriteIndented = true };

    /// <summary>
    /// The production expansion budget. PathFindController's own public
    /// endPoint constructors use 10000 (PathFindController.cs:62), so a null
    /// result here means the open list drained (:237) rather than hitting a
    /// probe-imposed limit whose null would be indistinguishable (:232-235).
    /// </summary>
    private const int PathExpansionLimit = 10000;

    /// <summary>
    /// The limits every measured goal is REPEATED at. The probe's whole read of a null path rests on
    /// "the open list drained rather than a limit stopping the search" (:80-86), and that is an assumption
    /// until it is measured: if a goal is null at 10000 but found at 40000, the limit is what failed, and any
    /// conclusion drawn from the 10000 result is about the budget, not about reachability. 400000 is far above
    /// any Farm-sized search (the planner counts one dequeue per distinct coordinate and never enqueues a
    /// coordinate twice), so a null there cannot be a budget result.
    /// </summary>
    private static readonly int[] LimitSweep = { 10000, 40000, 400000 };

    /// <summary>
    /// The smallest actor-to-target Chebyshev distance the probe will measure.
    /// Two is the first distance at which the start node satisfies none of the
    /// three goals, so every recorded path is a genuine A* result.
    /// </summary>
    private const int MinimumTargetDistance = 2;

    private const string GoalExact = "exact";
    private const string GoalCardinalAdjacent = "cardinal_adjacent";
    private const string GoalChebyshevAdjacent = "chebyshev_adjacent";

    /// <summary>
    /// A target with at least one walkable cardinal neighbour. Stopping on one
    /// of those neighbours is the behaviour the approved change claims to buy,
    /// so this is the family Q1 is measured on.
    /// </summary>
    private const string FamilyCardinalApproach = "cardinal_approach";

    /// <summary>
    /// An ordinary WALKABLE destination at Chebyshev distance >= 2: the shape the move action asks for when it
    /// sends the actor to a tile. Measured because a production refusal reported a walkable destination, a
    /// positive component size and a null path at once, and no obstacle family can reproduce that.
    /// </summary>
    private const string FamilyWalkableDestination = "walkable_destination";

    /// <summary>The exact pair a production refusal reported, supplied by the harness.</summary>
    private const string FamilyRequestedPair = "requested_pair";

    /// <summary>
    /// A target whose four cardinal neighbours are ALL blocked but which has a
    /// walkable diagonal neighbour. This is the only geometry in which an
    /// adjacent-tile goal can stop on a diagonal: the goal test cannot be
    /// satisfied by a cardinal neighbour, so A* keeps expanding until it
    /// reaches the diagonal. Without this family a cardinal-only goal could
    /// never return a diagonal by construction and Q2 would be unanswerable.
    /// </summary>
    private const string FamilyDiagonalOnlyApproach = "diagonal_only_approach";

    private readonly IMonitor monitor;
    private readonly string evidencePath;
    private readonly int searchRadius;
    private readonly int maxCandidateTargets;
    private readonly int maxRecordedPathTiles;
    private readonly DateTimeOffset deadline;
    private readonly List<string> trace = new();

    private bool measurementStarted;
    private bool finished;

    private PathPredicateProbe(IMonitor monitor, string evidencePath)
    {
        this.monitor = monitor;
        this.evidencePath = evidencePath;
        this.searchRadius = 14;
        this.maxCandidateTargets = 6;
        this.maxRecordedPathTiles = 128;
        this.deadline = DateTimeOffset.UtcNow.AddSeconds(120);
    }

    /// <summary>
    /// Fail-closed construction: the probe only starts for the exact harness that
    /// sets both variables, so an ordinary game session can never run a
    /// measurement and report it as evidence.
    /// </summary>
    internal static PathPredicateProbe? TryStart(IMonitor monitor)
    {
        if (!string.Equals(
                Environment.GetEnvironmentVariable(EnableLiveProbeVariable),
                "1",
                StringComparison.Ordinal))
            return null;
        string evidencePath = Environment.GetEnvironmentVariable(EvidencePathVariable) ?? string.Empty;
        if (!Path.IsPathFullyQualified(evidencePath))
        {
            monitor.Log(
                $"GameBuddy path-predicate probe refused: {EvidencePathVariable} must be an absolute path.",
                LogLevel.Error);
            return null;
        }
        var probe = new PathPredicateProbe(monitor, evidencePath);
        monitor.Log(
            $"GameBuddy path-predicate probe started: radius={probe.searchRadius}; "
                + $"targets={probe.maxCandidateTargets}; evidence='{evidencePath}'.",
            LogLevel.Info);
        return probe;
    }

    /// <summary>Returns true once the probe has recorded a terminal result.</summary>
    internal bool Update()
    {
        if (this.finished)
            return true;

        if (DateTimeOffset.UtcNow > this.deadline)
        {
            this.Finish("blocked", "probe_deadline_exceeded", null);
            return true;
        }

        if (!Context.IsWorldReady || Game1.player is not Farmer actor)
            return false;

        // The whole measurement is atomic inside one game-thread tick.
        // Interleaving it would let the actor's own movement or a fixture
        // transition change the collision field between two calls that must be
        // comparable.
        if (this.measurementStarted)
            return false;

        if (actor.currentLocation is not GameLocation location)
        {
            this.Finish("blocked", "actor_location_unavailable", null);
            return true;
        }

        // findPath keeps its open/closed lists and its reentrancy counter in
        // static state, so the actor must be idle and no other controller may
        // be mid-pathfind. A menu or event can start a controller on a later
        // tick, so they read as "not yet idle" rather than as failure.
        if (actor.controller is not null
            || Game1.activeClickableMenu is not null
            || Game1.eventUp
            || !actor.CanMove)
        {
            return false;
        }

        this.measurementStarted = true;
        try
        {
            this.RunMeasurement(actor, location);
        }
        catch (Exception error)
        {
            this.trace.Add($"measurement_exception={error.GetType().Name}");
            this.Finish("blocked", $"measurement_exception:{error.GetType().Name}", null);
        }
        return true;
    }

    private void RunMeasurement(Farmer actor, GameLocation location)
    {
        Point start = actor.TilePoint;
        Vector2 tileBefore = actor.Tile;
        bool passableTilesEmptyBefore = actor.TemporaryPassableTiles.IsEmpty();

        this.trace.Add($"actor_start={start.X},{start.Y};location={location.NameOrUniqueName}");

        List<CandidateTarget> candidates = CollectCandidateTargets(location, start, this.searchRadius, this.maxCandidateTargets);
        // An explicit target is measured FIRST and always, even when the families above are empty: it is the
        // pair a production refusal named, and reproducing it is the whole point of setting the variable.
        string? explicitTarget = Environment.GetEnvironmentVariable(TargetPathVariable);
        if (!string.IsNullOrWhiteSpace(explicitTarget))
        {
            int separator = explicitTarget.IndexOf(',');
            if (separator <= 0
                || !int.TryParse(explicitTarget.AsSpan(0, separator), out int targetX)
                || !int.TryParse(explicitTarget.AsSpan(separator + 1), out int targetY))
            {
                this.trace.Add($"explicit_target_rejected={explicitTarget}");
            }
            else
            {
                candidates.Insert(0, new CandidateTarget(new Point(targetX, targetY), FamilyRequestedPair));
            }
        }
        if (candidates.Count == 0)
        {
            this.Finish(
                "blocked",
                "no_unwalkable_target_with_a_walkable_neighbor",
                new Dictionary<string, object?>
                {
                    ["searchRadius"] = this.searchRadius,
                    ["minimumTargetDistance"] = MinimumTargetDistance,
                });
            return;
        }

        // Harness control: a goal the start node already satisfies must return
        // a one-node stack, which is the cheapest available check that this
        // code is reading the planner it claims to be reading. If the control
        // fails, every other number below is untrustworthy rather than merely
        // surprising, so it is recorded beside them.
        Dictionary<string, object?> control = MeasureGoal(
            location,
            start,
            start,
            IsExactTarget,
            GoalExact,
            this.maxRecordedPathTiles);

        var measurements = new List<Dictionary<string, object?>>();
        foreach (CandidateTarget candidate in candidates)
            measurements.Add(MeasureTarget(location, start, candidate, this.maxRecordedPathTiles));

        Vector2 tileAfter = actor.Tile;
        bool passableTilesEmptyAfter = actor.TemporaryPassableTiles.IsEmpty();

        var payload = new Dictionary<string, object?>
        {
            ["expansionLimit"] = PathExpansionLimit,
            ["searchRadius"] = this.searchRadius,
            ["minimumTargetDistance"] = MinimumTargetDistance,
            ["candidateTargetCount"] = candidates.Count,
            ["cardinalApproachTargetCount"] = candidates.Count(candidate => candidate.Family == FamilyCardinalApproach),
            ["diagonalOnlyApproachTargetCount"] = candidates.Count(candidate => candidate.Family == FamilyDiagonalOnlyApproach),
            ["classificationObstacleTest"] =
                "isCollidingPosition(Rectangle(tile*64+1, 62x62), viewport, isFarmer, 0, glider:false, character, pathfinding:true, skipCollisionEffects:true)",
            ["startNodeControl"] = control,
            ["targets"] = measurements.ToArray(),
            ["actorTileBefore"] = Tile(tileBefore),
            ["actorTileAfter"] = Tile(tileAfter),
            ["actorMoved"] = tileBefore != tileAfter,
            ["animalsInLocation"] = AnimalCount(location),
            ["temporaryPassableTilesEmptyBefore"] = passableTilesEmptyBefore,
            ["temporaryPassableTilesEmptyAfter"] = passableTilesEmptyAfter,
            ["temporaryPassableTilesChanged"] = passableTilesEmptyBefore != passableTilesEmptyAfter,
        };

        this.monitor.Log(
            $"GameBuddy path-predicate probe recorded {candidates.Count} target(s); "
                + $"actorMoved={tileBefore != tileAfter}; evidence='{this.evidencePath}'.",
            LogLevel.Info);
        this.Finish("passed", "measurement_recorded", payload);
    }

    /// <summary>
    /// Scans outward from the actor for tiles the planner's own obstacle test
    /// rejects. Two families are collected so Q2 has a geometry that can
    /// actually answer it:
    ///
    /// <list type="bullet">
    /// <item><description>
    /// <see cref="FamilyCardinalApproach"/> - at least one walkable cardinal
    /// neighbour, i.e. the ordinary case the approved change is about.
    /// </description></item>
    /// <item><description>
    /// <see cref="FamilyDiagonalOnlyApproach"/> - all four cardinal neighbours
    /// blocked but a walkable diagonal exists. Only here can a Chebyshev goal
    /// path stop diagonally, because a goal requiring cardinal adjacency can
    /// never be satisfied by a diagonal by construction.
    /// </description></item>
    /// </list>
    ///
    /// Because the probe cannot edit the world, both families are whatever the
    /// live collision field happens to contain. The run therefore reports how
    /// many of each it found instead of assuming the diagonal family exists;
    /// zero diagonal candidates is an honest partial answer to Q2, not a bug.
    /// </summary>
    private static List<CandidateTarget> CollectCandidateTargets(
        GameLocation location,
        Point start,
        int searchRadius,
        int maxCandidateTargets)
    {
        int perFamily = Math.Max(1, maxCandidateTargets / 2);
        var cardinal = new List<Point>();
        var diagonalOnly = new List<Point>();
        var walkable = new List<Point>();
        // The family the production move action actually asks for: an ordinary WALKABLE destination. A refusal
        // whose evidence says the destination is walkable and the planner still returned null cannot be
        // diagnosed from the obstacle families above, because those are unwalkable by construction.
        int walkableWanted = Math.Max(1, maxCandidateTargets / 2);
        // The walkable family starts at distance 1: the production case to explain is a refusal of a
        // WALKABLE destination, and a house interior (where the move fixture puts the actor) has no walkable
        // tile as far as distance 2.
        for (int walkableRadius = 1; walkableRadius <= searchRadius; walkableRadius++)
        {
            for (int dx = -walkableRadius; dx <= walkableRadius; dx++)
            {
                for (int dy = -walkableRadius; dy <= walkableRadius; dy++)
                {
                    if (walkable.Count >= walkableWanted)
                        break;
                    if (Math.Max(Math.Abs(dx), Math.Abs(dy)) != walkableRadius)
                        continue;
                    int x = start.X + dx;
                    int y = start.Y + dy;
                    if (!IsInLayerBounds(location, x, y))
                        continue;
                    if (IsPlannerWalkable(location, x, y))
                        walkable.Add(new Point(x, y));
                }
            }
        }
        for (int radius = MinimumTargetDistance; radius <= searchRadius; radius++)
        {
            for (int dx = -radius; dx <= radius; dx++)
            {
                for (int dy = -radius; dy <= radius; dy++)
                {
                    if (cardinal.Count >= perFamily && diagonalOnly.Count >= perFamily)
                        return Merge(cardinal, diagonalOnly, walkable);
                    if (Math.Max(Math.Abs(dx), Math.Abs(dy)) != radius)
                        continue;
                    int x = start.X + dx;
                    int y = start.Y + dy;
                    if (!IsInLayerBounds(location, x, y))
                        continue;
                    if (IsPlannerWalkable(location, x, y))
                        continue;
                    bool hasCardinal = HasWalkableCardinalNeighbor(location, x, y);
                    if (hasCardinal && cardinal.Count < perFamily)
                    {
                        cardinal.Add(new Point(x, y));
                        continue;
                    }
                    if (!hasCardinal
                        && diagonalOnly.Count < perFamily
                        && HasWalkableDiagonalNeighbor(location, x, y))
                    {
                        diagonalOnly.Add(new Point(x, y));
                    }
                }
            }
        }
        return Merge(cardinal, diagonalOnly, walkable);
    }

    private static List<CandidateTarget> Merge(List<Point> cardinal, List<Point> diagonalOnly, List<Point> walkable)
    {
        var merged = new List<CandidateTarget>(cardinal.Count + diagonalOnly.Count + walkable.Count);
        foreach (Point tile in cardinal)
            merged.Add(new CandidateTarget(tile, FamilyCardinalApproach));
        foreach (Point tile in diagonalOnly)
            merged.Add(new CandidateTarget(tile, FamilyDiagonalOnlyApproach));
        foreach (Point tile in walkable)
            merged.Add(new CandidateTarget(tile, FamilyWalkableDestination));
        return merged;
    }

    private static Dictionary<string, object?> MeasureTarget(
        GameLocation location,
        Point start,
        CandidateTarget candidate,
        int maxRecordedPathTiles)
    {
        Point target = candidate.Tile;
        // The planner's obstacle test is read before and after through the same
        // public native entry findPath uses. A change between the two reads
        // means a collision side effect altered the field these three calls
        // shared, and the target is flagged rather than silently trusted.
        bool targetWalkableBeforeCalls = IsPlannerWalkable(location, target.X, target.Y);
        bool targetWalkableAfterCalls = false;

        var calls = new Dictionary<string, object?>();
        try
        {
            calls[GoalExact] = MeasureGoal(
                location,
                start,
                target,
                IsExactTarget,
                GoalExact,
                maxRecordedPathTiles);
            calls[GoalCardinalAdjacent] = MeasureGoal(
                location,
                start,
                target,
                IsCardinalAdjacentOrTarget,
                GoalCardinalAdjacent,
                maxRecordedPathTiles);
            calls[GoalChebyshevAdjacent] = MeasureGoal(
                location,
                start,
                target,
                IsChebyshevAdjacentOrTarget,
                GoalChebyshevAdjacent,
                maxRecordedPathTiles);
        }
        finally
        {
            targetWalkableAfterCalls = IsPlannerWalkable(location, target.X, target.Y);
        }

        return new Dictionary<string, object?>
        {
            ["target"] = $"{target.X},{target.Y}",
            ["family"] = candidate.Family,
            ["targetWalkableBeforeCalls"] = targetWalkableBeforeCalls,
            ["targetWalkableAfterCalls"] = targetWalkableAfterCalls,
            ["collisionFieldChangedDuringCalls"] = targetWalkableBeforeCalls != targetWalkableAfterCalls,
            ["neighborWalkability"] = NeighborWalkability(location, target),
            ["hasWalkableCardinalNeighbor"] = HasWalkableCardinalNeighbor(location, target.X, target.Y),
            ["hasWalkableDiagonalNeighbor"] = HasWalkableDiagonalNeighbor(location, target.X, target.Y),
            ["targetRelativeToActor"] = Relative(start, target),
            ["productionCall"] = MeasureProductionCall(location, start, target, PathExpansionLimit),
            ["calls"] = calls,
        };
    }

    private static Dictionary<string, object?> MeasureGoal(
        GameLocation location,
        Point start,
        Point target,
        PathFindController.isAtEnd goal,
        string goalName,
        int maxRecordedPathTiles)
    {
        bool startSatisfiesGoal = goal(
            new PathNode(start.X, start.Y, (byte)0, null),
            target,
            location,
            Game1.player);

        Stack<Point>? path = PathFindController.findPath(
            start,
            target,
            goal,
            location,
            Game1.player,
            PathExpansionLimit);
        List<Dictionary<string, object?>> sweep = new();
        foreach (int limit in LimitSweep)
        {
            Stack<Point>? atLimit = PathFindController.findPath(start, target, goal, location, Game1.player, limit);
            Point[] atLimitTiles = atLimit?.ToArray() ?? Array.Empty<Point>();
            sweep.Add(new Dictionary<string, object?>
            {
                ["limit"] = limit,
                ["returnsNull"] = atLimit is null,
                ["nodeCount"] = atLimitTiles.Length,
                ["finalTile"] = atLimitTiles.Length == 0 ? null : $"{atLimitTiles[^1].X},{atLimitTiles[^1].Y}",
            });
        }
        // Stack<Point>.ToArray() enumerates top-first, and reconstructPath
        // pushes the reached node before its ancestors (PathFindController.cs:
        // 248-257), so index 0 is the start tile and the last element is the
        // node the goal test accepted.
        Point[] tiles = path?.ToArray() ?? Array.Empty<Point>();
        Point? final = tiles.Length == 0 ? null : tiles[^1];

        return new Dictionary<string, object?>
        {
            ["goal"] = goalName,
            ["target"] = $"{target.X},{target.Y}",
            ["startSatisfiesGoal"] = startSatisfiesGoal,
            ["returnsNull"] = path is null,
            ["nodeCount"] = tiles.Length,
            ["pathTruncated"] = tiles.Length > maxRecordedPathTiles,
            ["pathTiles"] = tiles
                .Take(maxRecordedPathTiles)
                .Select(tile => $"{tile.X},{tile.Y}")
                .ToArray(),
            ["finalTile"] = final is null ? null : $"{final.Value.X},{final.Value.Y}",
            ["finalRelativeToTarget"] = final is null
                ? null
                : Relationship(final.Value.X - target.X, final.Value.Y - target.Y),
            ["finalMatchesStart"] = final is not null && final.Value == start,
            ["limitSweep"] = sweep.ToArray(),
        };
    }

    /// <summary>Today's exact-coordinate goal, spelled as PathFindController.isAtEndPoint is.</summary>
    private static bool IsExactTarget(PathNode currentNode, Point endPoint, GameLocation location, Character character)
        => currentNode.x == endPoint.X && currentNode.y == endPoint.Y;

    /// <summary>"Target or a cardinal neighbour" - Manhattan distance 1.</summary>
    private static bool IsCardinalAdjacentOrTarget(
        PathNode currentNode,
        Point endPoint,
        GameLocation location,
        Character character)
        => Math.Abs(currentNode.x - endPoint.X) + Math.Abs(currentNode.y - endPoint.Y) <= 1;

    /// <summary>"Target or any neighbour" - Chebyshev distance 1, diagonals included.</summary>
    private static bool IsChebyshevAdjacentOrTarget(
        PathNode currentNode,
        Point endPoint,
        GameLocation location,
        Character character)
        => Math.Abs(currentNode.x - endPoint.X) <= 1 && Math.Abs(currentNode.y - endPoint.Y) <= 1;

    private static bool HasWalkableCardinalNeighbor(GameLocation location, int x, int y)
        => IsPlannerWalkable(location, x, y - 1)
            || IsPlannerWalkable(location, x, y + 1)
            || IsPlannerWalkable(location, x - 1, y)
            || IsPlannerWalkable(location, x + 1, y);

    private static bool HasWalkableDiagonalNeighbor(GameLocation location, int x, int y)
        => IsPlannerWalkable(location, x - 1, y - 1)
            || IsPlannerWalkable(location, x + 1, y - 1)
            || IsPlannerWalkable(location, x - 1, y + 1)
            || IsPlannerWalkable(location, x + 1, y + 1);

    private static Dictionary<string, object?> NeighborWalkability(GameLocation location, Point target)
        => new()
        {
            ["cardinal"] = new Dictionary<string, object?>
            {
                ["up"] = DescribeWalkability(location, target.X, target.Y - 1),
                ["down"] = DescribeWalkability(location, target.X, target.Y + 1),
                ["left"] = DescribeWalkability(location, target.X - 1, target.Y),
                ["right"] = DescribeWalkability(location, target.X + 1, target.Y),
            },
            ["diagonal"] = new Dictionary<string, object?>
            {
                ["upLeft"] = DescribeWalkability(location, target.X - 1, target.Y - 1),
                ["upRight"] = DescribeWalkability(location, target.X + 1, target.Y - 1),
                ["downLeft"] = DescribeWalkability(location, target.X - 1, target.Y + 1),
                ["downRight"] = DescribeWalkability(location, target.X + 1, target.Y + 1),
            },
        };

    private static Dictionary<string, object?> DescribeWalkability(GameLocation location, int x, int y)
    {
        // Out-of-bounds tiles are never collision-tested: findPath itself skips
        // the obstacle call for them (:215-219) and their layer index would be
        // unsafe to read.
        if (!IsInLayerBounds(location, x, y))
            return new Dictionary<string, object?> { ["tile"] = $"{x},{y}", ["inBounds"] = false, ["walkable"] = false };
        return new Dictionary<string, object?>
        {
            ["tile"] = $"{x},{y}",
            ["inBounds"] = true,
            ["walkable"] = !CollidesAt(location, x, y),
        };
    }

    private static bool IsInLayerBounds(GameLocation location, int x, int y)
    {
        // The same layer findPath reads for its own bounds test (:195-196).
        var layer = location.map.Layers[0];
        return x >= 0 && y >= 0 && x < layer.LayerWidth && y < layer.LayerHeight;
    }

    /// <summary>
    /// The planner's own obstacle test, argument-for-argument except for the
    /// last flag: the 62x62 rectangle anchored at tile*64+1 that
    /// PathFindController.cs:222 asks <c>isCollidingPosition</c> about, with
    /// the same viewport, farmer flag, damage, glider and pathfinding
    /// arguments.
    ///
    /// <paramref name="skipCollisionEffects"/> is the one deliberate
    /// difference. findPath leaves it at its default <c>false</c>, which makes
    /// GameLocation.cs:2572-2575 call <c>FarmAnimal.farmerPushing()</c> - a
    /// real mutation of <c>pushAccumulator</c> - whenever the tested rectangle
    /// overlaps an animal, even under <c>pathfinding: true</c>. Suppressing it
    /// cannot change this method's answer: in that branch the push happens
    /// before an unconditional <c>return true</c>, so with the flag on the
    /// function returns exactly the same value and only the side effect is
    /// gone. Every other use of the flag is already unreachable here
    /// (GameLocation.cs:2682 and :2710 are gated on <c>!pathfinding</c>, and
    /// :2855 is gated on <c>!isFarmer</c>). The probe is required to be
    /// read-only, so the equivalent-but-effect-free form is the honest one.
    /// </summary>
    private static bool CollidesAt(GameLocation location, int x, int y)
        => location.isCollidingPosition(
            new Rectangle(x * 64 + 1, y * 64 + 1, 62, 62),
            Game1.viewport,
            Game1.player is Farmer,
            0,
            glider: false,
            Game1.player,
            pathfinding: true,
            skipCollisionEffects: true);

    /// <summary>
    /// The production call path, measured as production reads it. `StardewBodyController` decides
    /// "no path" from the CONSTRUCTOR's `pathToEndPoint` field (:105-108), not from `findPath`'s return, and
    /// the constructor has a branch that never assigns that field at all: when the character is not an NPC,
    /// nobody is present in the location, the goal is the plain `isAtEndPoint`, and the end point is positive,
    /// it TELEPORTS the character (PathFindController.cs:133-136) and leaves `pathToEndPoint` null. This
    /// records which branch ran, so a null field is never read as an A* failure without the facts that would
    /// explain it.
    /// </summary>
    private static Dictionary<string, object?> MeasureProductionCall(
        GameLocation location,
        Point start,
        Point target,
        int limit)
    {
        Vector2 tileBefore = Game1.player.Tile;
        bool farmersPresent = location.farmers.Count > 0;
        bool actorInFarmers = location.farmers.Contains(Game1.player);
        PathFindController controller = new(
            Game1.player,
            location,
            IsExactTarget,
            -1,
            null,
            limit,
            target);
        Vector2 tileAfter = Game1.player.Tile;
        // The Mod's OWN verdict for this pair, from the same function production uses. Before the fix this
        // reported `route_exists=true` for a destination no cardinal route reaches; the corrected verdict is
        // what a live refusal now carries, so it is measured here beside the planner's own answer.
        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            start,
            target,
            tile => IsPlannerWalkable(location, tile.X, tile.Y),
            maxVisited: 4000,
            findClosestReachable: true);
        return new Dictionary<string, object?>
        {
            ["fromActorTile"] = $"{start.X},{start.Y}",
            ["actorTilePoint"] = $"{Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}",
            ["actorTileVsTilePointDiffer"] = Game1.player.TilePoint.X != (int)Game1.player.Tile.X || Game1.player.TilePoint.Y != (int)Game1.player.Tile.Y,
            ["locationFarmersCount"] = location.farmers.Count,
            ["farmersPresent"] = farmersPresent,
            ["actorInFarmers"] = actorInFarmers,
            ["teleportBranchPossible"] = !farmersPresent,
            ["pathToEndPointNull"] = controller.pathToEndPoint is null,
            ["pathToEndPointCount"] = controller.pathToEndPoint?.Count,
            ["actorMovedByConstruction"] = tileBefore != tileAfter,
            ["modVerdict"] = verdict is ReachabilityVerdict assessed
                ? new Dictionary<string, object?>
                {
                    ["targetEnclosed"] = assessed.TargetEnclosed,
                    ["componentContainsTarget"] = assessed.ComponentContainsTarget,
                    ["componentTiles"] = assessed.ComponentTiles,
                    ["closestToTarget"] = assessed.ClosestToTarget is Point closestTile ? $"{closestTile.X},{closestTile.Y}" : null,
                    ["productionLabel"] = assessed.ComponentContainsTarget ? "planner_null_with_cardinal_route" : "no_cardinal_route",
                }
                : null,
        };
    }

    private static bool IsPlannerWalkable(GameLocation location, int x, int y)
        => IsInLayerBounds(location, x, y) && !CollidesAt(location, x, y);

    private static int AnimalCount(GameLocation location) => location.animals.Length;

    private static Dictionary<string, object?> Relative(Point from, Point to)
        => new()
        {
            ["deltaX"] = to.X - from.X,
            ["deltaY"] = to.Y - from.Y,
            ["relationship"] = Relationship(to.X - from.X, to.Y - from.Y),
        };

    private static string Relationship(int deltaX, int deltaY)
    {
        if (deltaX == 0 && deltaY == 0)
            return "exact";
        if (deltaX == 0 || deltaY == 0)
            return "cardinal";
        if (Math.Abs(deltaX) == 1 && Math.Abs(deltaY) == 1)
            return "diagonal";
        return "other";
    }

    private static string Tile(Vector2 tile)
        => $"{(int)tile.X},{(int)tile.Y}";

    /// <summary>A scanned target tile together with the geometry family that qualified it.</summary>
    private sealed record CandidateTarget(Point Tile, string Family);

    private void Finish(string state, string reasonCode, Dictionary<string, object?>? payload)
    {
        if (this.finished)
            return;
        this.finished = true;

        var evidence = new Dictionary<string, object?>
        {
            ["schema"] = Schema,
            ["state"] = state,
            ["reasonCode"] = reasonCode,
            ["topology"] = "native_local_player_fixture",
            ["targetVersion"] = new Dictionary<string, object?>
            {
                ["game"] = Game1.version,
            },
            ["measurement"] = payload,
            ["trace"] = this.trace.ToArray(),
            ["eventChain"] = new[]
            {
                "read_only_game_thread_measurement",
                "pathfind_exact_goal",
                "pathfind_cardinal_adjacent_goal",
                "pathfind_chebyshev_adjacent_goal",
                "actor_never_assigned_a_controller",
            },
        };

        try
        {
            string? directory = Path.GetDirectoryName(this.evidencePath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);
            File.WriteAllText(
                this.evidencePath,
                JsonSerializer.Serialize(evidence, EvidenceJsonOptions));
            this.monitor.Log(
                $"GameBuddy path-predicate probe finished: state={state}; reason={reasonCode}; evidence='{this.evidencePath}'.",
                LogLevel.Info);
        }
        catch (Exception error)
        {
            this.monitor.Log(
                $"GameBuddy path-predicate probe could not write evidence: {error.GetType().Name}.",
                LogLevel.Error);
        }
    }
}
