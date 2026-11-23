using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>Fewest walkable tiles a play-session start must belong to.</summary>
    ///
    /// The scenario places several props, each needing a standable neighbour, so a pocket of five tiles cannot
    /// host the day. 64 is comfortably above the requirement and far below the farm's own 1623, so it refuses
    /// pockets without refusing a legitimately small farm.
    private const int PlaySessionMinimumComponentTiles = 64;

    /// <summary>
    /// Trees the play-session world offers.
    ///
    /// Two of the daily tasks name things a bare farm does not contain, and a task the world cannot satisfy measures
    /// the world rather than the companion. Kept small and fixed: these are props for a day?s work, not a forest - the
    /// prop budget for stones/weeds/crops is derived from walkable ground, but a tree consumes that ground, so the
    /// count has to be a decision rather than a fraction.
    /// </summary>
    private const int PlaySessionTreeCount = 3;

    /// <summary>Forage items the play-session world offers; same reasoning as the trees.</summary>
    private const int PlaySessionForageCount = 3;

    /// <summary>
    /// The forage items a fixture plants, in the order they are tried, declared ONCE for all three fixtures that
    /// place one: the play-session world, the native-local `pickup_forage` scenario and its HostAutomation twin. Each
    /// site keeps its own placement loop because their failure policies differ (the dedicated fixtures throw when
    /// their one target is missing; the play-session degrades like every other prop family), but the ids are one fact
    /// and must not be three hand-written copies.
    ///
    /// They are tried in this order rather than one being assumed: `dropObject` is the engine's own placement test and
    /// it refuses a tile for reasons no caller can predict from the tile alone, and `isForage()` filters any id whose
    /// content record does not call it forage.
    /// </summary>
    private static readonly string[] FixtureForageItemIds =
        new[] { "(O)399", "(O)396", "(O)398", "(O)16", "(O)18", "(O)20", "(O)22" };

    /// <summary>Fewest walkable tiles the door must keep after each placement.</summary>
    ///
    /// Set from the state BEFORE any prop exists. Measured 2026-10-25: the door's component was 1623 tiles and
    /// the field was inside it; after six props it was 122 and the field was outside. A tile in the middle of a
    /// field costs one tile of opening, the only bridge between two halves costs fifteen hundred.
    private static int PlaySessionDoorComponentFloor;

    private static int WalkableComponentSize(GameLocation farm, Vector2 from) =>
        // An unknown size is treated as large: the placement guards still refuse a prop that cannot be walked
        // to, so an over-generous budget cannot arm an unusable world - it can only make the search try harder.
        WalkableComponentTiles(farm, from)?.Count ?? int.MaxValue;

    /// <summary>
    /// The tiles of the walkable piece <paramref name="from"/> belongs to, or null when the flood gave up before it
    /// could answer.
    ///
    /// Returned as the set rather than only its size because the prop budget is asked of what is LEFT of the piece
    /// once the start ring and the building's held tiles are taken out (see
    /// <see cref="PlaySessionFixturePlacement.FreeTilesForProps"/>) - and the two answers must come from one flood, or
    /// the number the budget divides and the number the arm log prints could describe two different pieces.
    /// </summary>
    private static HashSet<Point>? WalkableComponentTiles(GameLocation farm, Vector2 from)
    {
        var layer = farm.map.Layers[0];
        return StardewBodyController.ReachableTiles(
            new Point((int)from.X, (int)from.Y),
            Math.Max(8000, layer.LayerWidth * layer.LayerHeight),
            tile =>
                tile.X >= 0
                && tile.Y >= 0
                && tile.X < layer.LayerWidth
                && tile.Y < layer.LayerHeight
                && StardewBodyController.IsWalkableTile(farm, Game1.player, new Vector2(tile.X, tile.Y)));
    }

    /// <summary>
    /// The same emptiness/standability probe the other fixtures use, with these additions: the target may not sit in the
    /// actor's own neighbourhood, so this fixture's props cannot fence the companion in, and it may not sit on a tile a
    /// building already holds (its footprint or the ring its door is used from), so a prop cannot spend a road the day
    /// needs. The session starts on the first placement's standing tile, and everything placed after it keeps that
    /// tile's cardinal ring clear.
    /// </summary>
    private static (Vector2 TargetTile, Vector2 StandingTile)? FindNativeLocalPlaySessionSpot(GameLocation farm, Vector2 start, IReadOnlyList<Vector2>? alreadyPlaced = null, Vector2? mustRemainReachable = null, IReadOnlySet<Point>? held = null)
    {
        int width = farm.map.Layers[0].LayerWidth;
        int height = farm.map.Layers[0].LayerHeight;
        // Outward from the actor's start, never inside its ring and never on a tile a standing building holds: the
        // ordering and both exclusions are pure rules (`PlaySessionFixturePlacement`) so their properties can be pinned
        // without a live game.
        var candidates = PlaySessionFixturePlacement.PlaceableCandidates(
            Enumerable.Range(0, width)
                .SelectMany(x => Enumerable.Range(0, height).Select(y => new Point(x, y))),
            new Point((int)start.X, (int)start.Y),
            held);
        foreach (Point candidate in candidates)
        {
            Vector2 target = new(candidate.X, candidate.Y);
            if (!farm.isTileOnMap(target) || farm.objects.ContainsKey(target) || farm.terrainFeatures.ContainsKey(target))
                continue;
            // The target must be reachable too, not only the tile the actor stands on to work it. A prop whose
            // standable neighbour is inside the actor's component can still be walled off from it, and the
            // fail-closed check after placement then refuses the world for a prop this search should never
            // have chosen (measured 2026-10-24: prop_unreachable_from_home:58,9).
            // The composed-world assertion counts this fixture's own placements as blockers, so placement must
            // ask the same question. `IsWalkableTile` runs the engine's collision test with `pathfinding: true`, which
            // does NOT treat a stone as blocking - so a prop could be chosen on a tile the assertion then called
            // unreachable, with no single step looking wrong. Measured 2026-10-24: the props were placed, then
            // `home_unreachable:what=field` refused the world.
            if (!IsReachableFromStart(farm, start, target))
                continue;
            // A placement must not isolate a prop already on the ground. Protecting only the door left the
            // earlier props exposed: stones were placed outward from the start, each one fine on its own, until
            // the field's walkable piece had shrunk to nine tiles and the door could no longer reach the work
            // (measured 2026-10-24: the world was refused after every placement "succeeded").
            //
            // Cheap because it is bounded: at most fifteen props exist by the time the last one is placed.
            // Protects the route the session depends on: the door. Earlier props are NOT protected here, and
            // that is a measured decision rather than an oversight - protecting every placed prop as well
            // refused 7 of 8 stones and then ran out of ground for the crops too, because every candidate had to
            // satisfy several reachability floods at once. A prop cut off by a later one is handled where it can
            // be judged: the pass after placement drops it and says which tile (see
            // `dropped_unreachable`), which keeps the world usable and the reason visible.
            if (alreadyPlaced is not null && alreadyPlaced.Count > 0)
            {
                // Nothing to do: kept as a parameter so the call sites state what they considered.
            }
            // A placement must not sever the route the session depends on. The start was chosen while the
            // farm was clean, so it could reach the door; a stone between them breaks that promise without any
            // single choice looking wrong, and the composed-world assertion then refuses the whole day
            // (measured 2026-10-24: home_unreachable:what=field;door=66,15;target=56,11;component_tiles=123).
            //
            // Checked by simulating the placement's effect: an actor can no longer WALK THROUGH the target, so the
            // route must survive with the target treated as blocked.
            if (mustRemainReachable is { } anchor)
            {
                // Put the prop down for real, ask the question, and undo it if the answer is bad. Every earlier
                // version of this guard simulated a partial world and therefore asked a question that could not
                // fail: first it moved a prop off an empty tile, then it placed one and put it back before
                // measuring the component.
                StardewValley.Object? displaced = null;
                farm.objects.TryGetValue(target, out displaced);
                farm.objects[target] = ItemRegistry.Create<StardewValley.Object>("(O)2", 1);
                bool stillConnected = IsReachableFromStartPessimistic(
                    farm,
                    start,
                    anchor,
                    tile => farm.objects.ContainsKey(new Vector2(tile.X, tile.Y))
                        || farm.terrainFeatures.ContainsKey(new Vector2(tile.X, tile.Y)));
                // Measured 2026-10-25: six props took the door's component from 1623 tiles to 122 and dropped the
                // field out of it. A tile in the middle of a field costs one; the only bridge between two halves
                // costs fifteen hundred. This is the rule that refuses the second kind.
                bool keepsDoorOpen = PlaySessionDoorComponentFloor <= 0
                    || WalkableComponentSize(farm, anchor) >= PlaySessionDoorComponentFloor;
                if (displaced is not null) farm.objects[target] = displaced;
                else farm.objects.Remove(target);
                if (!stillConnected || !keepsDoorOpen) continue;
            }
            Vector2[] cardinal =
            {
                target + new Vector2(-1f, 0f), target + new Vector2(1f, 0f),
                target + new Vector2(0f, -1f), target + new Vector2(0f, 1f),
            };
            Vector2[] validStanding = cardinal
                .Where(standing => farm.isTileOnMap(standing)
                    && standing != start
                    && !farm.objects.ContainsKey(standing)
                    && !farm.terrainFeatures.ContainsKey(standing)
                    && !farm.IsTileOccupiedBy(standing, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false)
                    // Two facts, both required, both from the planner's own authority:
                    //   * the planner will stand there (IsWalkableTile), and
                    //   * the actor can WALK there from where the session starts (AssessReachability).
                    // Without the second, a prop lands outside the actor's component -- measured: a crop two tiles
                    // away with component_tiles=28 and no cardinal route, which the session read as a system
                    // failure and re-aimed at eight times.
                    && StardewBodyController.IsWalkableTile(farm, Game1.player, standing)
                    && IsReachableFromStart(farm, start, standing))
                .ToArray();
            // Any one usable neighbour will do. Requiring EXACTLY one refused every tile of an open
            // field (measured: 1881 free tiles, 1881 refused), because a cleared field almost never has a
            // single approach. The first entry wins so the choice stays deterministic across runs.
            if (validStanding.Length > 0)
                return (target, validStanding[0]);
        }
        return null;
    }
}
