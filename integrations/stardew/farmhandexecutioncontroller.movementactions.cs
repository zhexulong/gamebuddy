using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.GameData.Minecarts;
using StardewValley.Tools;
using StardewValley.Characters;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Navigation;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    /// <summary>The native click radius. <c>Game1.checkAction</c> gates the ordinary action path on
    /// <c>tileWithinRadiusOfPlayer(grabTile, 1)</c> (Game1.cs:11509) and <c>shop_purchase</c> refuses with
    /// <c>shop_counter_out_of_reach</c> at the same radius, so one constant names the reach every consumer enforces.</summary>
    internal const int NativeInteractionRadius = 1;

    /// <summary>The refusal a substituted approach reports when the body cannot act on the tile it was asked for.</summary>
    internal const string ApproachOutOfReachReasonCode = "approach_out_of_reach";

    /// <summary>How many exit tiles one transition refusal names.</summary>
    internal const int ExitNamingLimit = 3;

    /// <summary>
    /// Whether a body on <paramref name="actor"/>'s tile can still ACT on <paramref name="requested"/>.
    ///
    /// <para>
    /// Asked of the engine's own gate (<see cref="Utility.tileWithinRadiusOfPlayer"/>, Utility.cs:4100-4109 - Chebyshev,
    /// reading <c>f.Tile</c>), never of a distance written here: the action that follows a move refuses at exactly this
    /// radius, so a second spelling could publish "in range" for a body the next action then refuses. Measured
    /// 2026-11-09: the move receipt claimed the requested tile while the body stood two tiles from the counter
    /// <c>shop_purchase</c> then refused against.
    /// </para>
    /// </summary>
    internal static bool IsWithinRangeOfRequest((int X, int Y) requested, Farmer actor) =>
        actor is not null && Utility.tileWithinRadiusOfPlayer(requested.X, requested.Y, NativeInteractionRadius, actor);

    /// <summary>
    /// What a <c>target_reached</c> receipt says about WHERE the body is relative to the tile that was ASKED for.
    ///
    /// <para>
    /// <c>reached=requested</c> is the only claim that the body is on the requested tile, and it is made only when it
    /// is true. <c>reached=adjacent</c> is the substituted-approach case (or a directive that allowed adjacency) and
    /// names all three facts, including whether the requested tile is still within the native interaction radius from
    /// where the body stands. The old shape said <c>already_at_target=true</c> for the SUBSTITUTED tile while printing
    /// <c>requested=</c>, which reads as "you are there" to a consumer computing reach from the request: four moves in
    /// one run reported it and the shop action then refused <c>shop_counter_out_of_reach</c> naming both tiles.
    /// </para>
    /// </summary>
    internal static string DescribeMoveArrival(
        (int X, int Y) requested,
        (int X, int Y) actor,
        bool withinRangeOfRequest) =>
        $"reached={(actor == requested ? "requested" : "adjacent")};requested={requested.X},{requested.Y};"
        + $"actor={actor.X},{actor.Y};within_range_of_request={(withinRangeOfRequest ? "true" : "false")}";

    public LocalExecutionReceipt RequestLocalMove(string requestId, Vector2 targetTile, long? requestedDeadlineMs = null, bool allowAdjacentArrival = false)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "world_not_ready", null);

        if (!IsFiniteTile(targetTile) || targetTile.X != MathF.Floor(targetTile.X) || targetTile.Y != MathF.Floor(targetTile.Y)
            || targetTile.X < 0 || targetTile.Y < 0 || targetTile.X > 1000 || targetTile.Y > 1000)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "invalid_target_tile",
                $"tile={targetTile.X.ToString(CultureInfo.InvariantCulture)},{targetTile.Y.ToString(CultureInfo.InvariantCulture)}");

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long deadlineMs = requestedDeadlineMs ?? nowMs + DefaultDeadlineTicks * 1000L / 60L;
        if (deadlineMs <= nowMs)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "deadline_expired",
                $"deadline={deadlineMs};now={nowMs}");
        if (deadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "invalid_deadline",
                $"deadline={deadlineMs};now={nowMs};ceiling={nowMs + (long)TimeSpan.FromMinutes(1).TotalMilliseconds}");

        if (this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null)
            return this.RejectBodyOwned(requestId, Guid.NewGuid().ToString("N"));
        if (this.active is not null)
            this.controller.Cancel("superseded_by_new_directive");
        if (this.active is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Uncertain, "body_release_unavailable", null);

        string executionId = Guid.NewGuid().ToString("N");
        if (Game1.player.currentLocation is not { } moveLocation)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "location_unavailable", null);
        // A COORDINATE ON ANOTHER MAP IS NOT A WALK. `move_to_tile(64,14)` from `FarmHouse(3,11)` named the farmhouse's
        // own door as the FARM spells it, and the answer was `target_not_addressable;target_on_map=false` - true, and
        // silent about where the number came from (round82). The map that declares the tile as its door leading back
        // here is the answer, and it is the same one `enter_exit` gives for the same coordinate.
        if (!IsTileOfCurrentMap(Game1.player, (int)targetTile.X, (int)targetTile.Y)
            && MapDeclaringExitTileTo(moveLocation, (int)targetTile.X, (int)targetTile.Y) is { } otherMap)
        {
            (int X, int Y) standing = ((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y);
            (string anotherMapCode, string anotherMapEvidence) = DescribeAnotherMapsDoor(
                moveLocation, otherMap, (int)targetTile.X, (int)targetTile.Y, standing);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, anotherMapCode, anotherMapEvidence);
        }
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((deadlineMs - nowMs) * 60d / 1000d));
        bool nativeWarpTarget = Game1.player.currentLocation.warps.Any(warp => !warp.npcOnly.Value && warp.X == (int)targetTile.X && warp.Y == (int)targetTile.Y);
        bool adjacentArrival = allowAdjacentArrival || nativeWarpTarget;

        // 1. The named tile cannot be walked onto -- it holds the thing the caller
        //    wants to touch (a tree, a rock, a chest, a building) -- but a walkable
        //    neighbour is: approach that neighbour instead of refusing. Every other
        //    interaction in this Mod is a native action from an adjacent tile, so
        //    "walk to the object" now works the way the agent means it. The test is the
        //    PLANNER's own walkability, not a stricter object-occupancy reading: a
        //    cropped HoeDirt is legally walkable, and treating it as blocked both
        //    hijacked the request into a failed substitution and refused a move the
        //    planner would have made (the Mod's own probe contradicted the verdict with
        //    probe_says_reachable=true). The substitution is named in the receipt, never
        //    silent.
        Vector2 effectiveTarget = targetTile;
        bool approachSubstituted = false;
        // A PERSON IS NOT A WALL. A villager, pet or farm animal standing on the named tile is a body that will walk
        // away, not a map fact; the planner walks happily onto its tile (`pathfinding: true` skips characters,
        // GameLocation.cs:2697) and the BODY then cannot enter it (`Farmer.MovePosition` uses the non-pathfinding
        // collision test), so the walk stalls one tile short and the request used to end as `no_native_path` / a stall.
        // The postcondition of a move is to be able to act on that tile, so the honest walk is the tile beside them -
        // and only a tile with NO free neighbour at all is `target_tile_occupied`.
        RefusalLayerToken stoodAsideFor = RefusalProbe.CharacterOn(moveLocation, targetTile);
        if (stoodAsideFor.Refused || !StardewBodyController.IsWalkableTile(moveLocation, Game1.player, targetTile))
        {
            Vector2? approach = SelectStandingApproachTile(
                targetTile,
                Game1.player.Tile,
                candidate => StardewBodyController.IsWalkableTile(moveLocation, Game1.player, candidate)
                    && !IsWarpBufferTile(moveLocation, ((int)candidate.X, (int)candidate.Y)),
                StardewBodyController.BuildWalkableComponent(moveLocation, Game1.player)
                    ?? (_ => true));
            if (approach is not null)
            {
                effectiveTarget = approach.Value;
                adjacentArrival = false;
                approachSubstituted = true;
            }
            else if (stoodAsideFor.Refused)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    $"{StardewBodyController.TargetTileOccupiedReasonCode}:{RefusalProbe.ReasonCodeToken(stoodAsideFor)}",
                    $"target={FormatTile(targetTile)};actor={FormatTile(Game1.player.Tile)};reach=1;approach=none;blocked_by={stoodAsideFor.Format()};standable_neighbour=none");
            }
        }

        (int X, int Y) requestedTile = ((int)targetTile.X, (int)targetTile.Y);
        (int X, int Y) actorTile = ((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y);
        bool withinRangeOfRequest = IsWithinRangeOfRequest(requestedTile, Game1.player);
        if (StardewBodyController.IsArrivalDelta(
            Math.Abs(actorTile.X - (int)effectiveTarget.X),
            Math.Abs(actorTile.Y - (int)effectiveTarget.Y),
            adjacentArrival))
        {
            if (approachSubstituted && !withinRangeOfRequest)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    ApproachOutOfReachReasonCode,
                    $"requested={FormatTile(targetTile)};actor={FormatTile(Game1.player.Tile)};approach={FormatTile(effectiveTarget)};reach={NativeInteractionRadius};within_range_of_request=false");
            }

            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Succeeded,
                "target_reached",
                DescribeMoveArrival(requestedTile, actorTile, withinRangeOfRequest)
                    + (stoodAsideFor.Refused ? $";stood_aside_for={stoodAsideFor.Format()}" : string.Empty));
        }

        LocalMoveSpec specification = new(executionId, requestId, effectiveTarget, adjacentArrival, this.revision, this.tick + deadlineTicks, deadlineMs);
        this.slots.Active.Assign(specification);
        if (!this.controller.TryStart(specification, Game1.player, this.tick, out string reasonCode, out string? startEvidence, out string? startHint))
        {
            if (reasonCode == StardewBodyController.NoNativePathReasonCode
                && this.controller.TryStartClearApproach(specification, Game1.player, this.tick, out string? clearEvidence)
                && clearEvidence is not null)
            {
                string clearAcceptedEvidence = $"route_revision={specification.RouteRevision};requested={FormatTile(targetTile)};clear_step_approach=true;{clearEvidence}";
                return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted", clearAcceptedEvidence);
            }

            this.slots.Active.Clear();
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode, startEvidence, hint: startHint);
        }

        string acceptedEvidence = approachSubstituted
            ? $"route_revision={specification.RouteRevision};target={FormatTile(effectiveTarget)};requested={FormatTile(targetTile)};approach=substituted"
            : $"route_revision={specification.RouteRevision};target={FormatTile(effectiveTarget)}"
                + (adjacentArrival ? ";adjacent_arrival=true" : string.Empty);
        if (stoodAsideFor.Refused)
            acceptedEvidence += $";stood_aside_for={stoodAsideFor.Format()}";
        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted", acceptedEvidence);
    }

    /// <summary>The refusal a placement with no reachable standing tile reports, and nothing else does.</summary>
    internal const string NoReachableApproachReasonCode = "no_reachable_approach";

    /// <summary>
    /// The same verdict under the name an action that just asked "is this ground farmable" calls it: the tile is
    /// worth working, and there is nowhere legal to stand.
    ///
    /// <para>
    /// Two names, one verdict, one predicate - the leg already says `no_reachable_approach:&lt;x&gt;:&lt;y&gt;`, which names the
    /// PLACEMENT. `till_soil` has answered the placement already (the tile is farmable, the actor is simply not beside
    /// it) and its remaining question is the standing tile, so a caller reading its refusal has to be told which of the
    /// two failed. The suffix is the same `standable_neighbour` fact the evidence and the hint carry.
    /// </para>
    /// </summary>
    internal const string NoStandingTileCodePrefix = "no_standing_tile";

    /// <summary>
    /// The hollow ring: a tool swing's target tile must not be the tile the actor is standing on.
    ///
    /// <para>
    /// <c>UseNativeToolOnTile</c> names the target tile's pixel centre directly, and every tool family gates
    /// execution on the native Chebyshev-1 radius. Distance ZERO satisfies that gate, so an actor standing ON the
    /// target was admitted to swing at its own feet - the Hoe re-tilling the tile the actor occupies, the Axe
    /// counting the tile in front of the facing while the receipt reported the named one. Design §3.1.1 states the
    /// rule (「工具挥击的**目标格**不得等于**身体格**」) and requires the correction to be a native position change
    /// under body ownership, recorded as <c>stepped_out_from</c> / <c>stepped_out_to</c>.
    /// </para>
    /// <para>
    /// This answers only that question. Reach, target identity and tool ownership are separate facts with their own
    /// refusals; folding any of them in here would make this predicate say "not underfoot" for the one case it
    /// exists for.
    /// </para>
    /// </summary>
    internal static bool IsToolTargetUnderActor(Farmer player, int targetX, int targetY) =>
        player.Tile.X == targetX && player.Tile.Y == targetY;

    /// <summary>
    /// Whether a tile warps the actor who STOPS on it - the one place design §3.1.1 forbids standing.
    ///
    /// <para>
    /// The rule is three-way, not a ban: a <c>TouchAction Warp</c> tile is legal to CROSS (the native
    /// <c>PathFindController</c> has its own door and warp branches, and an A* that read these tiles as
    /// impassable would cut every doorway out of the map) and it is legal as an <c>enter_exit</c> target. Only
    /// buffering there is forbidden, because the engine warps the moment the body's box reaches it - so a step-out
    /// that landed on one would teleport the companion instead of moving it half a step.
    /// </para>
    /// <para>
    /// Asked of the location's own warp table rather than of the map's <c>TouchAction</c> property so it answers the
    /// same thing the engine will do. An NPC-only warp does not move the companion and so is not a buffer.
    /// </para>
    /// </summary>
    internal static bool IsWarpBufferTile(GameLocation location, (int X, int Y) tile) =>
        location.warps.Any(warp => !warp.npcOnly.Value && warp.X == tile.X && warp.Y == tile.Y);

    internal static (int X, int Y)? SelectToolApproachTile(
        (int X, int Y) target,
        (int X, int Y) actor,
        Func<(int X, int Y), bool> isStandable,
        Func<(int X, int Y), bool> isReachable) =>
        ApproachTileSelector.Select(new[] { target }, actor, isStandable, isReachable);

    /// <summary>
    /// The same choice for a target that occupies several tiles - a 2x2 ResourceClump (big rock, stump) or any other
    /// multi-tile obstacle. Passing only the anchor made the far face unreachable by construction: the tile a farmer
    /// standing south of a 2x2 rock occupies is two rows below the anchor, outside the anchor's eight-neighbour ring.
    /// </summary>
    internal static (int X, int Y)? SelectToolApproachTile(
        System.Collections.Generic.IReadOnlyList<(int X, int Y)> targetTiles,
        (int X, int Y) actor,
        Func<(int X, int Y), bool> isStandable,
        Func<(int X, int Y), bool> isReachable) =>
        ApproachTileSelector.Select(targetTiles, actor, isStandable, isReachable);
    /// <summary>
    /// The refusal for a placement with no reachable standing tile: the code an agent can branch
    /// on, the evidence a reader needs to see WHY, and the one line the settled node keeps.
    ///
    /// The code names the tile pair with COLONS. The wire's reasonCode alphabet is `[a-z0-9_:-]`
    /// (`protocol/bridge-v1.schema.json`, `FarmhandExecutionJournal.IsValidReasonCode`), so a
    /// comma would make the receipt fail validation instead of reporting the refusal; the
    /// human-facing pair still appears in the evidence as `target=x,y`.
    ///
    /// It also keeps two different facts apart: a free neighbour the actor cannot walk to is a
    /// wall (`standable_neighbour=unreachable`), and no free neighbour at all is geometry
    /// (`standable_neighbour=none`). Neither is `target_out_of_reach`, which stays what a FAILED
    /// ROUTE to a tile that does exist reports.
    ///
    /// The third statement is that same distinction in the channel that outlives the refusal. ADR-006
    /// withholds the evidence of a node that proved nothing, so a node settled here kept the code and
    /// nothing else - and the code says only that this placement has no approach, not whether a wall
    /// stands in the way (walk around or clear it) or the tile has no free neighbour (choose another
    /// target). Bounded, and derived from the same predicate as the evidence, so the two cannot name
    /// different worlds.
    ///
    /// <para>
    /// <paramref name="location"/> and <paramref name="player"/> are the world the refusal is ABOUT, supplied by the
    /// caller that already holds it (`TryBeginToolApproach`) rather than read here from `Game1`: the rim that opens a
    /// pocket is a fact about one body in one location, and a lookup this function performed itself could describe a
    /// body nobody asked about. Absent - a caller with no world, as the arithmetic tests have none - the refusal keeps
    /// the words it always had.
    /// </para>
    /// </summary>
    internal static (string Code, string Evidence, string Hint) DescribeNoReachableApproach(
        (int X, int Y) target,
        (int X, int Y) actor,
        Func<(int X, int Y), bool> isStandable,
        System.Collections.Generic.IReadOnlyList<(int X, int Y)>? footprint = null,
        string? reasonCodePrefix = null,
        GameLocation? location = null,
        Farmer? player = null)
    {
        System.Collections.Generic.IReadOnlyList<(int X, int Y)> tiles = footprint ?? new[] { target };
        int standableTiles = ApproachTileSelector.StandableCandidates(tiles, isStandable).Count;
        string neighbour = standableTiles > 0 ? "unreachable" : "none";
        string evidence = $"target={target.X},{target.Y};actor={actor.X},{actor.Y};reach=1;approach=none;standable_neighbour={neighbour};standable_tiles={standableTiles.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
        if (footprint is not null)
            evidence += $";footprint={footprint.Count}";
        string code = reasonCodePrefix is null
            ? $"{NoReachableApproachReasonCode}:{target.X}:{target.Y}"
            : $"{reasonCodePrefix}:{neighbour}";
        string hint = $"no_approach;standable_neighbour={neighbour}";
        if (standableTiles == 0
            && location is not null
            && player is not null
            && ((int)player.Tile.X, (int)player.Tile.Y) == actor)
        {
            evidence += $";described_by=target_ring;approaches={StardewBodyController.DescribeTargetApproaches(player, location, new Vector2(target.X, target.Y), tile => isStandable(((int)tile.X, (int)tile.Y)))}";
        }
        if (location is not null
            && player is not null
            && ((int)player.Tile.X, (int)player.Tile.Y) == actor
            && StardewBodyController.BuildWalkableComponent(location, player) is { } component
            && !component(new Vector2(target.X, target.Y))
            && DescribeFrontierClearance(location, player, actor, target, component) is { } clearance)
        {
            evidence += clearance.Evidence;
            if (reasonCodePrefix is null && clearance.Code is { } frontierCode)
                code = frontierCode;
            hint = ClearingEvidence.DescribeRouteHint(evidence, hint) ?? hint;
        }

        return (code, evidence, hint);
    }

    /// <summary>
    /// The refusal an ENCLOSED actor reports when nothing on the rim of her own component can be cleared:
    /// <c>no_cuttable_blocker:&lt;reason&gt;</c>, where the reason is the rim's own word for what stands there.
    ///
    /// <para>
    /// The other half of one answer. A measured `round43` run spent 14 minutes and 59 refusals on one `cut_grass`, each
    /// reading `no_reachable_approach:59:24` with `standable_tiles=6` and `blocked_by=range:reach:6`: a distance, about a
    /// pocket six tiles wide, where the cause was a wall nothing published removes. Distance is not a cause, and an
    /// answer that dresses one up as an explanation is the dead end this constant replaces.
    /// </para>
    /// </summary>
    internal const string NoCuttableBlockerReasonCode = "no_cuttable_blocker";

    private const string OutOfMapReason = "out_of_map";

    private const int FrontierFloodLimit = 8000;

    private const int FrontierPricedCandidateLimit = 8;

    /// <summary>One occupant-bearing tile on the rim of the actor's own walkable component that a published action removes.</summary>
    /// <param name="Tile">The wall to swing at.</param>
    /// <param name="StandAt">The component tile a swing reaches it from - inside the pocket, by construction.</param>
    /// <param name="Occupant">The engine's own name for what stands there (`weed`, `quarry_boulder`, `bush`).</param>
    /// <param name="Clearers">
    /// Every published action whose own `Clears` declaration accepts the occupant, with its stated price - the SAME
    /// declarations the `clear_step_blocked` path reads, so no kind-to-action table exists here to drift from them. The
    /// family a blocker's id comes from is read from these too (`TargetFamily`), not from a field beside them.
    /// </param>
    /// <param name="StaminaCharge">The engine's charge for one swing at it, or null when the live tool cannot pay one.</param>
    internal readonly record struct FrontierBlocker(
        (int X, int Y) Tile,
        (int X, int Y) StandAt,
        string Occupant,
        System.Collections.Generic.IReadOnlyList<FarmhandClearingOffer> Clearers,
        int? StaminaCharge);

    /// <summary>
    /// One rim blocker, ranked by what clearing it buys: <see cref="StepsToAct"/> is how many steps it takes, after the
    /// clear, to reach a tile the target can be acted on from - or null when that one clear does not open the way.
    /// </summary>
    internal readonly record struct FrontierPick((int X, int Y) Tile, int? StepsToAct);

    internal static System.Collections.Generic.IReadOnlyList<FrontierPick> OrderFrontierBlockers(
        (int X, int Y) actor,
        (int X, int Y) target,
        System.Collections.Generic.IReadOnlyList<(int X, int Y)> clearable,
        Func<(int X, int Y), bool> isWalkable)
    {
        System.Collections.Generic.List<(int X, int Y)> nearest = NearestCandidates(clearable, target);
        var picks = new System.Collections.Generic.List<FrontierPick>(nearest.Count);
        foreach ((int X, int Y) tile in nearest)
            picks.Add(new FrontierPick(tile, StepsToActAfterClear(actor, target, tile, isWalkable)));
        picks.Sort((left, right) => CompareFrontierPicks(left, right, target));
        return picks;
    }

    private static System.Collections.Generic.List<(int X, int Y)> NearestCandidates(
        System.Collections.Generic.IReadOnlyList<(int X, int Y)> clearable,
        (int X, int Y) target)
    {
        var ordered = new System.Collections.Generic.List<(int X, int Y)>(clearable);
        ordered.Sort((left, right) =>
        {
            int byDistance = FrontierDistance(left, target).CompareTo(FrontierDistance(right, target));
            if (byDistance != 0)
                return byDistance;
            return left.Y != right.Y ? left.Y.CompareTo(right.Y) : left.X.CompareTo(right.X);
        });
        if (ordered.Count > FrontierPricedCandidateLimit)
            ordered.RemoveRange(FrontierPricedCandidateLimit, ordered.Count - FrontierPricedCandidateLimit);
        return ordered;
    }

    private static readonly (int Dx, int Dy)[] FrontierSteps = { (0, -1), (1, 0), (0, 1), (-1, 0) };

    private static int CompareFrontierPicks(FrontierPick left, FrontierPick right, (int X, int Y) target)
    {
        int bySteps = (left.StepsToAct ?? int.MaxValue).CompareTo(right.StepsToAct ?? int.MaxValue);
        if (bySteps != 0)
            return bySteps;
        int byDistance = FrontierDistance(left.Tile, target).CompareTo(FrontierDistance(right.Tile, target));
        if (byDistance != 0)
            return byDistance;
        return left.Tile.Y != right.Tile.Y ? left.Tile.Y.CompareTo(right.Tile.Y) : left.Tile.X.CompareTo(right.Tile.X);
    }

    private static int FrontierDistance((int X, int Y) left, (int X, int Y) right) =>
        Math.Abs(left.X - right.X) + Math.Abs(left.Y - right.Y);

    internal static int? StepsToActAfterClear(
        (int X, int Y) actor,
        (int X, int Y) target,
        (int X, int Y) cleared,
        Func<(int X, int Y), bool> isWalkable)
    {
        var seen = new System.Collections.Generic.HashSet<(int X, int Y)> { actor };
        var pending = new System.Collections.Generic.Queue<((int X, int Y) Tile, int Steps)>();
        pending.Enqueue((actor, 0));
        while (pending.Count > 0)
        {
            ((int X, int Y) tile, int steps) = pending.Dequeue();
            if (Math.Abs(tile.X - target.X) <= NativeInteractionRadius && Math.Abs(tile.Y - target.Y) <= NativeInteractionRadius)
                return steps;
            if (seen.Count > FrontierFloodLimit)
                return null;
            foreach ((int dx, int dy) in FrontierSteps)
            {
                (int X, int Y) next = (tile.X + dx, tile.Y + dy);
                if (!seen.Add(next))
                    continue;
                if (next != cleared && !isWalkable(next))
                    continue;
                pending.Enqueue((next, steps + 1));
            }
        }

        return null;
    }

    private readonly record struct FrontierClearance(string Evidence, string? Code);

    private static FrontierClearance? DescribeFrontierClearance(
        GameLocation location,
        Farmer player,
        (int X, int Y) actor,
        (int X, int Y) target,
        Func<Vector2, bool> component)
    {
        var candidates = new System.Collections.Generic.List<FrontierBlocker>();
        var walls = new System.Collections.Generic.List<((int X, int Y) Tile, string Reason)>();
        var onRim = new System.Collections.Generic.HashSet<(int X, int Y)>();
        var layer = location.map.Layers[0];
        for (int x = 0; x < layer.LayerWidth; x += 1)
        {
            for (int y = 0; y < layer.LayerHeight; y += 1)
            {
                if (!component(new Vector2(x, y)))
                    continue;
                foreach ((int dx, int dy) in FrontierSteps)
                {
                    (int X, int Y) rim = (x + dx, y + dy);
                    if (component(new Vector2(rim.X, rim.Y)) || !onRim.Add(rim))
                        continue;
                    if (rim.X < 0 || rim.Y < 0 || rim.X >= layer.LayerWidth || rim.Y >= layer.LayerHeight)
                    {
                        walls.Add((rim, OutOfMapReason));
                        continue;
                    }

                    if (StandingTileFor(rim, component, actor) is not { } standAt)
                        continue;
                    if (StardewBodyController.OccupantAt(location, player, new Vector2(rim.X, rim.Y)) is not { } occupancy)
                    {
                        walls.Add((rim, FrontierWallReason(location, player, rim)));
                        continue;
                    }

                    System.Collections.Generic.IReadOnlyList<FarmhandClearingOffer> clearers =
                        ClearingActionSurface.ClearersOf(occupancy.Occupant, FarmhandActionCatalog.Registrations);
                    if (clearers.Count == 0)
                    {
                        walls.Add((rim, occupancy.Occupant));
                        continue;
                    }

                    candidates.Add(new FrontierBlocker(rim, standAt, occupancy.Occupant, clearers, occupancy.StaminaCharge));
                }
            }
        }

        if (candidates.Count > 0)
        {
            System.Collections.Generic.IReadOnlyList<FrontierPick> ordered = OrderFrontierBlockers(
                actor,
                target,
                candidates.ConvertAll(candidate => candidate.Tile),
                tile => StardewBodyController.IsWalkableTile(location, player, new Vector2(tile.X, tile.Y)));
            (int X, int Y) head = ordered[0].Tile;
            string population = $";candidates={candidates.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)};described={ordered.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)}";
            if (!IsAStepTowardTheSubject(actor, target, head))
                return new FrontierClearance($";blocker={ClearingEvidence.EveryClearerBeyondTheSubject}{population}", Code: null);
            return new FrontierClearance(
                DescribeFrontierBlocker(candidates.Find(candidate => candidate.Tile == head), player) + population,
                Code: null);
        }

        if (walls.Count == 0)
            return null;
        string reason = NearestWallReason(walls, target);
        return new FrontierClearance($";{NoCuttableBlockerReasonCode}={reason}", $"{NoCuttableBlockerReasonCode}:{reason}");
    }

    private static (int X, int Y)? StandingTileFor((int X, int Y) blocker, Func<Vector2, bool> component, (int X, int Y) actor)
    {
        (int X, int Y)? best = null;
        int bestDistance = int.MaxValue;
        for (int dx = -1; dx <= 1; dx += 1)
        {
            for (int dy = -1; dy <= 1; dy += 1)
            {
                if (dx == 0 && dy == 0)
                    continue;
                (int X, int Y) candidate = (blocker.X + dx, blocker.Y + dy);
                if (!component(new Vector2(candidate.X, candidate.Y)))
                    continue;
                int distance = FrontierDistance(candidate, actor);
                bool better = best is not { } incumbent
                    || distance < bestDistance
                    || (distance == bestDistance && (candidate.Y < incumbent.Y || (candidate.Y == incumbent.Y && candidate.X < incumbent.X)));
                if (!better)
                    continue;
                best = candidate;
                bestDistance = distance;
            }
        }

        return best;
    }

    private static string FrontierWallReason(GameLocation location, Farmer player, (int X, int Y) tile)
    {
        if (location.isWaterTile(tile.X, tile.Y))
            return "water";
        RefusalLayerToken wall = StardewBodyController.DescribeTargetOccupant(location, new Vector2(tile.X, tile.Y), player);
        return wall.Refused ? wall.Layer.ToWireValue() : "blocked";
    }

    private static string NearestWallReason(
        System.Collections.Generic.IReadOnlyList<((int X, int Y) Tile, string Reason)> walls,
        (int X, int Y) target)
    {
        ((int X, int Y) Tile, string Reason) best = walls[0];
        foreach (((int X, int Y) Tile, string Reason) wall in walls)
        {
            int distance = FrontierDistance(wall.Tile, target);
            int bestDistance = FrontierDistance(best.Tile, target);
            if (distance > bestDistance)
                continue;
            if (distance == bestDistance && (wall.Tile.Y > best.Tile.Y || (wall.Tile.Y == best.Tile.Y && wall.Tile.X > best.Tile.X)))
                continue;
            best = wall;
        }

        return best.Reason;
    }

    private static string DescribeFrontierBlocker(FrontierBlocker blocker, Farmer player)
    {
        string? targetId = PublishedBlockerTargetId(player, blocker.Occupant, blocker.Tile.X, blocker.Tile.Y);
        string step = ClearingEvidence.DescribeFirstStep(
            new FirstClearStep(true, blocker.Tile, blocker.StandAt, RemainingClears: 1, "frontier"),
            _ => blocker.Occupant) ?? string.Empty;
        string described = ClearingEvidence.DescribeBlocker(
            blocker.Occupant,
            blocker.Tile,
            targetId,
            blocker.Clearers,
            blocker.StaminaCharge,
            detourFacts: null);
        return $";{step};{described}";
    }

    /// <summary>
    /// Whether a rim tile is a step a refusal may NAME: nearer to her than the subject the refusal is about, so walking
    /// to it is progress toward the thing she asked for.
    ///
    /// <para>
    /// The rule's other half - being swingable from a tile inside her OWN component - is <see cref="StandingTileFor"/>'s
    /// filter, which no candidate reaches this point without: a blocker with no standable component neighbour is dropped
    /// while the rim is being scanned, so the tile named here is always one she can walk to and swing from today.
    /// </para>
    /// <para>
    /// WHY THE DISTANCE IS PART OF THE RULE. <see cref="OrderFrontierBlockers"/> prices each candidate by the walk it
    /// opens and only THEN by its distance to the subject, so when no single clear opens the way every candidate ties on
    /// the first key and the ranking degenerates to "nearest to the subject" - a fact about the map that says nothing
    /// about the walk from where she stands. Measured `round82`: a `fish_here` at Town `69,42` from `69,51` was refused
    /// `no_reachable_approach:69:42` and the repair step named `twig@102,43` - thirty-three tiles from the subject,
    /// forty-one from her, on a rim that is the whole town - carrying `blocker_target=unpublished:worldObjectTargets`
    /// because no family publishes a row that far from the actor. She would have walked to it. A step farther than the
    /// thing it is supposed to open is not a repair, so the refusal says
    /// <c>blocker=every_clearer_beyond_the_subject</c> instead of the family's nearest row - a DIFFERENT answer from
    /// `no_cuttable_blocker`, which is the empty or unopenable rim: there IS a step here, and it is behind her.
    /// </para>
    /// </summary>
    private static bool IsAStepTowardTheSubject((int X, int Y) actor, (int X, int Y) subject, (int X, int Y) blocker) =>
        FrontierDistance(blocker, actor) < FrontierDistance(subject, actor);

    /// <summary>
    /// The footprint tile a chosen standing tile reaches, which is the tile every later reach test must use.
    ///
    /// A 2x2 `ResourceClump` at (5,5) is reached from (5,7) - the tile a farmer standing SOUTH of it occupies - but
    /// (5,7) is Chebyshev-2 from the anchor (5,5). Measuring the arrival against the anchor therefore refuses a walk
    /// that arrived exactly where it was sent. The tile actually reached is (5,6), one step from (5,7) and inside the
    /// footprint.
    ///
    /// Nearest footprint tile wins, and an equidistant set is decided by lowest y then lowest x, so one world state
    /// always yields one tile. Totality matters here: the selector only ever returns a tile beside an occupied tile,
    /// so the nearest footprint tile is at Chebyshev-1 by construction and no fallback branch is needed.
    /// </summary>
    internal static (int X, int Y) SelectReachTile(
        System.Collections.Generic.IReadOnlyList<(int X, int Y)> footprint,
        (int X, int Y) standing)
    {
        (int X, int Y) best = footprint[0];
        int bestDistance = Math.Max(Math.Abs(best.X - standing.X), Math.Abs(best.Y - standing.Y));
        foreach ((int X, int Y) tile in footprint)
        {
            int distance = Math.Max(Math.Abs(tile.X - standing.X), Math.Abs(tile.Y - standing.Y));
            if (distance > bestDistance) continue;
            if (distance == bestDistance && (tile.Y > best.Y || (tile.Y == best.Y && tile.X > best.X))) continue;
            best = tile;
            bestDistance = distance;
        }
        return best;
    }

    internal static Vector2? SelectStandingApproachTile(
        Vector2 targetTile,
        Vector2 actorTile,
        Func<Vector2, bool> isStandable,
        Func<Vector2, bool> isReachable)
    {
        (int X, int Y)? pick = ApproachTileSelector.Select(
            new[] { ((int)targetTile.X, (int)targetTile.Y) },
            ((int)actorTile.X, (int)actorTile.Y),
            tile => isStandable(new Vector2(tile.X, tile.Y)),
            tile => isReachable(new Vector2(tile.X, tile.Y)));
        return pick is { } chosen ? new Vector2(chosen.X, chosen.Y) : null;
    }

    /// <summary>
    /// Requests one native minecart ride named by an exact published objective.
    /// Every fact is re-derived on the game thread from the live station tile and
    /// the game's own `Data/Minecarts`; the client-supplied ID is only a selector.
    /// The native ride is `GameLocation.MinecartWarp`, which ends in the same
    /// `Warped` event the ordinary warp path uses, so the ride keeps the single
    /// `activeTravel` ownership and the same one-shot release; only the terminal
    /// reason code is the ride's own (`minecart_ride_completed`).
    /// </summary>
    public LocalExecutionReceipt RequestLocalMinecartRide(
        string requestId, int sourceX, int sourceY, long requestedDeadlineMs, string expectedTargetId)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity) in the one authority, in that same order: the
        // refusal now NAMES the hold (actor_held_by_modal / cutscene_active /
        // actor_passed_out / transient_busy) where the inline copy reported the
        // anonymous player_not_actionable. The station geometry, the ride
        // resolution and the Warped postcondition stay action-specific.
        // Physical: the ride drives the native minecart object, not a tool swing.
        //
        // EVIDENCE PENDING, recorded rather than hidden: the native entry this mirrors (`GameLocation.MinecartWarp`,
        // `GameLocation.cs:10302`) has NO precondition guard of its own - the only native gate is
        // `ShowMineCartMenu`'s `mount != null` check (`:10216`), on the CLICK path this action bypasses. So a state
        // this admission now refuses here (a freezePause, an eating actor) is not PROVABLY native-forbidden; the
        // ride self-heals in 700 ms. An independent reviewer flagged exactly this and I am not claiming otherwise:
        // the refusal is the shared authority's, and settling whether the native path would have admitted the same
        // tick needs a live probe.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is { } admissionRefusal)
            return admissionRefusal;

        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (!Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "minecart_station_out_of_range", $"source={sourceX},{sourceY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1;blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, $"reach:{ChebyshevDistance(Game1.player, sourceX, sourceY)}").Format()}");

        MinecartRideResolution resolution = ResolveMinecartRide(location, sourceX, sourceY, expectedTargetId);
        if (!resolution.Accepted || resolution.Destination is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, $"source={sourceX},{sourceY};target={expectedTargetId}");

        MinecartDestinationData destination = resolution.Destination;
        int pricePaid = RideMinecart(destination, resolution.NetworkId, Game1.player);
        if (pricePaid < 0)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "minecart_ticket_unaffordable",
                $"source={sourceX},{sourceY};target={expectedTargetId};price={destination.Price};currency=money;held={Game1.player.Money}"
                    + PriceShortfallToken(destination.Price, Game1.player.Money));

        LocalTravelSpec specification = new(
            executionId,
            requestId,
            "ride_minecart",
            location.NameOrUniqueName,
            sourceX,
            sourceY,
            destination.TargetLocation,
            destination.TargetTile.X,
            destination.TargetTile.Y,
            this.revision,
            requestedDeadlineMs,
            resolution.NetworkId,
            destination.Id);
        this.slots.Travel.Assign(specification);
        return this.RememberTerminal(
            requestId,
            executionId,
            ExecutionState.Accepted,
            "accepted",
            $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};{FormatMinecartEvidence(resolution.NetworkId, destination)};ticket_price={pricePaid}");
    }

    /// <summary>
    /// Requests a native warp from a structured source warp in the current
    /// location. Only the Warped event can produce the authoritative travel
    /// postcondition.
    /// </summary>
    public LocalExecutionReceipt RequestLocalTravel(string requestId, int sourceX, int sourceY, long requestedDeadlineMs)
    {
        return this.RequestLocalDoorTransition(requestId, sourceX, sourceY, requestedDeadlineMs, false);
    }

    public LocalExecutionReceipt RequestLocalEnterExit(string requestId, int sourceX, int sourceY, long requestedDeadlineMs)
    {
        return this.RequestLocalDoorTransition(requestId, sourceX, sourceY, requestedDeadlineMs, true);
    }

    private LocalExecutionReceipt RequestLocalDoorTransition(string requestId, int sourceX, int sourceY, long requestedDeadlineMs, bool isDoor)
    {
        if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay) return replay;
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is { } admissionRefusal)
            return admissionRefusal;

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Microsoft.Xna.Framework.Point doorPoint = new(sourceX, sourceY);
        (int X, int Y) actorTile = ((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y);
        StardewValley.Warp? doorWarp = isDoor ? ResolveDoorWarp(location, doorPoint) : null;
        StardewValley.Warp? warp = doorWarp ?? ResolveLocationWarp(location, sourceX, sourceY);
        bool doorOwned = doorWarp is not null;
        string adjacentApproach = string.Empty;
        if (warp is null || warp.TargetName is null or "")
        {
            IReadOnlyList<BridgeDoor> exits = DiscoverExitTiles(Game1.player);
            // Measured 2026-11-14 (`round42`, day 6): she stood on `(3,11)`, the farmhouse door was at `(3,12)`, and she
            // named her own tile. One step was all that stood between her and the way out, so that request is the
            // transition rather than a refusal - and the rule is the GOAL ("leave this location"), not the coordinate she
            // named: a request that names a DIFFERENT door which resolves never reaches this branch, so honouring the
            // named door and taking the one beside her cannot disagree. The step is not taken by MOVING the body onto the
            // warp tile: the engine fires a warp from `Farmer.MovePositionImpl` (Farmer.cs:8586) and from nothing else, so a
            // position write would leave the body parked on a buffer tile design §3.1.1 forbids and fire no trigger; the
            // door is entered from where she stands, exactly as the native click entry does at its own radius-1 gate.
            if (AdjacentExitStep(exits, Game1.player) is { } step)
            {
                doorPoint = new Microsoft.Xna.Framework.Point(step.X, step.Y);
                doorWarp = isDoor ? ResolveDoorWarp(location, doorPoint) : null;
                warp = doorWarp ?? ResolveLocationWarp(location, step.X, step.Y);
                doorOwned = doorWarp is not null;
                if (warp is not null && warp.TargetName is not null and not "")
                    adjacentApproach = $";approach=adjacent_door;door={step.X},{step.Y}";
            }

            if (warp is null || warp.TargetName is null or "")
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    isDoor ? "door_not_available" : "warp_not_available",
                    DescribeExitRefusal((sourceX, sourceY), location.warps.Count, actorTile, exits)
                        + ";" + DescribeDoorAtTile(location, sourceX, sourceY));
        }
        if (!Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, Game1.player))
        {
            bool ofThisMap = IsTileOfCurrentMap(Game1.player, sourceX, sourceY);
            // WHERE A COORDINATE LIVES IS NOT A DISTANCE. `distance=61` from `(3,11)` to `Farm:64,14` measured a walk
            // that cannot exist (round82) because the tile is not a tile of this map at all. Ask which map claims it
            // before reporting a distance at all.
            if (!ofThisMap && MapDeclaringExitTileTo(location, sourceX, sourceY) is { } there)
            {
                (string anotherMapCode, string anotherMapEvidence) = DescribeAnotherMapsDoor(
                    location, there, sourceX, sourceY, actorTile, (warp.X, warp.Y), warp);
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    anotherMapCode,
                    anotherMapEvidence);
            }

            string radiusEvidence = $"source={sourceX},{sourceY};door={warp.X},{warp.Y};{DescribeRadiusOrigins((sourceX, sourceY), Game1.player)};distance={Math.Max(Math.Abs((int)Game1.player.Tile.X - sourceX), Math.Abs((int)Game1.player.Tile.Y - sourceY))};target={warp.TargetName}:{warp.TargetX},{warp.TargetY};blocked_by={new RefusalLayerToken(RefusalLayerKind.Range, $"adjacent:{ChebyshevDistance(Game1.player, sourceX, sourceY)}").Format()}";
            // A tile nothing on this map claims has no distance from her either, and no map to be named in its place - so
            // the arithmetic is reported with the one fact that stops it being read as a walk here.
            if (!ofThisMap)
                radiusEvidence += ";target_on_map=false";
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                doorOwned ? "door_out_of_range" : "warp_out_of_range",
                radiusEvidence);
        }

        LocalTravelSpec specification = new(
            executionId,
            requestId,
            isDoor ? "enter_exit" : "travel",
            location.NameOrUniqueName,
            sourceX,
            sourceY,
            warp.TargetName,
            warp.TargetX,
            warp.TargetY,
            this.revision,
            requestedDeadlineMs);

        // enter_exit runs the game's own door entry instead of a bare warpFarmer.
        // `getWarpFromDoor` only RESOLVES a door into a Warp; every door gate
        // lives one level up, in the entry GameLocation.checkAction (:7888)
        // dispatches for a real player: GameLocation.performAction's Warp family
        // (LockedDoorWarp's festival / SeedShop-Wednesday / open-hours /
        // friendship tests at :10319, WarpCommunityCenter's ccDoorUnlock at
        // :9462, Warp_Sunroom_Door's Caroline hearts at :9113,
        // WarpGreenhouse's ccPantry test at :9416) and Building.doAction's
        // construction / demolish-lock / dismount rules (Building.cs:937-959).
        //
        // The game's own return value decides whether the entry handled this
        // tile: performAction returns true for every Warp-family case it owns and
        // false from its `default:` branch. That is what keeps a door the click
        // path does not own (WarpBoatTunnel has no performAction case) on the
        // resolver's warp instead of being misread as a locked gate. The chosen
        // entry is echoed into the receipt so an observer can tell a gated door
        // apart from the resolver fallback.
        string entry = "none";
        if (doorOwned)
        {
            NativeDoorOutcome outcome = DispatchNativeDoor(location, doorPoint, out string refusal, out entry);
            switch (outcome)
            {
                case NativeDoorOutcome.Refused:
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Rejected,
                        "door_gate_refused",
                        $"source={sourceX},{sourceY};gate=refused;entry={entry};{DescribeDoorAtTile(location, doorPoint.X, doorPoint.Y)};dialogue={refusal}{adjacentApproach}");

                case NativeDoorOutcome.NoEffect:
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Rejected,
                        "door_transition_not_started",
                        $"source={sourceX},{sourceY};gate=passed;entry={entry};transition=not_started{adjacentApproach}");

                case NativeDoorOutcome.TransitionStarted:
                    break;

                case NativeDoorOutcome.NotNative:
                default:
                    this.slots.Travel.Assign(specification);
                    LocalExecutionReceipt plainDoorAccepted = this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Accepted,
                        "accepted",
                        $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};entry={entry}{adjacentApproach}");
                    Game1.player.warpFarmer(warp);
                    return plainDoorAccepted;
            }
        }

        this.slots.Travel.Assign(specification);
        LocalExecutionReceipt accepted = this.RememberTerminal(
            requestId,
            executionId,
            ExecutionState.Accepted,
            "accepted",
            isDoor
                ? $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};entry={entry}{adjacentApproach}"
                : $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY}{adjacentApproach}");
        // A native door entry already ran Game1.warpFarmer; only a plain record
        // (travel, an edge warp, or a door the click path does not own) warps here.
        if (!doorOwned)
            Game1.player.warpFarmer(warp);
        return accepted;
    }

    /// <summary>
    /// Every tile this location actually offers as a way out, in the one shape both published families use.
    ///
    /// <para>
    /// The two families are asked rather than re-walked: <see cref="DiscoverDoorTargets"/> is the request-path owner of
    /// the <c>doorTargets</c> family (the door table <c>updateDoors</c> builds, building human doors, and the
    /// farmhouse/cabin exit), and <c>location.warps</c> is what the <c>warps</c> family publishes under
    /// <see cref="FarmhandWarpCoordinateRange"/>. Which table holds a transition tile is an artefact of map authoring,
    /// so a caller reading this list is reading "the tiles I could leave from", not "the table the map used".
    /// </para>
    /// </summary>
    internal static IReadOnlyList<BridgeDoor> DiscoverExitTiles(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDoor>();

        List<BridgeDoor> exits = new();
        HashSet<(int X, int Y)> named = new();
        foreach (BridgeDoor door in DiscoverDoorTargets(player))
        {
            if (named.Add((door.SourceX, door.SourceY)))
                exits.Add(door);
        }

        foreach (StardewValley.Warp warp in location.warps)
        {
            if (warp is null || warp.npcOnly.Value || string.IsNullOrWhiteSpace(warp.TargetName))
                continue;
            if (!FarmhandWarpCoordinateRange.IsPublishableSource(warp.X, warp.Y)
                || !FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
                continue;
            if (named.Add((warp.X, warp.Y)))
                exits.Add(new BridgeDoor(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY));
        }

        return exits;
    }

    /// <summary>
    /// How far a refusal measures: Chebyshev, the radius <see cref="NativeInteractionRadius"/> and
    /// <c>Utility.tileWithinRadiusOfPlayer</c> are measured in, so "distance=1" means the same thing to a reader as it
    /// does to the gate that admits the transition.
    /// </summary>
    internal static int ExitDistance((int X, int Y) exit, (int X, int Y) actor) =>
        Math.Max(Math.Abs(exit.X - actor.X), Math.Abs(exit.Y - actor.Y));

    /// <summary>
    /// The exits in the order a refusal names them: nearest to the actor first, ties broken by lowest row then lowest
    /// column so one world state always yields one line.
    /// </summary>
    internal static IReadOnlyList<BridgeDoor> ExitsNearestFirst(IReadOnlyList<BridgeDoor> exits, (int X, int Y) actor) =>
        exits
            .OrderBy(exit => ExitDistance((exit.SourceX, exit.SourceY), actor))
            .ThenBy(exit => exit.SourceY)
            .ThenBy(exit => exit.SourceX)
            .ToArray();

    /// <summary>
    /// The exit tile a refused request may still leave from, or null when this request is not that case.
    ///
    /// <para>
    /// The rule is the GOAL, not the coordinate: <c>enter_exit</c> and <c>travel</c> mean "leave this location", so when
    /// the nearest exit this location publishes is a tile the actor can CLICK, that exit is the way out - whether or not
    /// the tile she named was the door. Reach is asked of the engine's own gate (<see cref="IsWithinRangeOfRequest"/>,
    /// <c>Utility.tileWithinRadiusOfPlayer</c>, Utility.cs:4100-4109: BOTH axes tested against the radius), never of a
    /// distance recomputed here. A sum of the two axis deltas is Manhattan, and it disagrees with that gate on every
    /// diagonal: the door at `3,12` from an actor on `2,11` is one tile away and a tile the player can click
    /// (Game1.cs:11509 gates the action path on that same predicate), while the sum reads 2 and refused it. Measured
    /// 2026-11-14: 15 refusals at `you=44,57 nearest=43,56` - one Chebyshev step, two Manhattan.
    /// </para>
    ///
    /// <para>
    /// The named tile is where she thought the way out was: she stood on `3,11` and named `3,11` while the door was at
    /// `3,12` (`round42`), and a request naming a DIFFERENT door that resolves is honoured before this decision is
    /// reached, because the caller runs only when the named tile resolved nothing.
    /// </para>
    /// </summary>
    internal static (int X, int Y, int Distance)? AdjacentExitStep(
        IReadOnlyList<BridgeDoor> exits,
        Farmer actor)
    {
        (int X, int Y) actorTile = ((int)actor.Tile.X, (int)actor.Tile.Y);
        IReadOnlyList<BridgeDoor> ordered = ExitsNearestFirst(exits, actorTile);
        if (ordered.Count == 0) return null;

        BridgeDoor nearest = ordered[0];
        if (!IsWithinRangeOfRequest((nearest.SourceX, nearest.SourceY), actor))
            return null;
        return (nearest.SourceX, nearest.SourceY, ExitDistance((nearest.SourceX, nearest.SourceY), actorTile));
    }

    internal static string DescribeExitRefusal(
        (int X, int Y) source,
        int warpCount,
        (int X, int Y) actor,
        IReadOnlyList<BridgeDoor> exits)
    {
        IReadOnlyList<BridgeDoor> ordered = ExitsNearestFirst(exits, actor);
        string nearest = ordered.Count == 0
            ? "nearest=none;distance=none"
            : $"nearest={ordered[0].SourceX},{ordered[0].SourceY};distance={ExitDistance((ordered[0].SourceX, ordered[0].SourceY), actor).ToString(CultureInfo.InvariantCulture)}";
        string doors = ordered.Count == 0
            ? "none"
            : string.Join("|", ordered.Take(ExitNamingLimit)
                .Select(exit => $"{exit.SourceX},{exit.SourceY}->{exit.TargetLocation}"));
        return $"source={source.X},{source.Y};warps={warpCount};you={actor.X},{actor.Y};{nearest};doors={doors}";
    }

    /// <summary>
    /// Whether a coordinate is a tile of the CURRENT map's own space: inside its map, or one of the exit tiles it declares
    /// itself - an edge exit's source is encoded one step OUTSIDE the map boundary (`Town` declares `-1 53 BusStop`,
    /// `79 -1 Mountain`), and that tile is THIS map's, not another one's. The two facts are the map's own grid and the
    /// exit family it publishes, so a tile either of them names is never a coordinate of another map.
    /// </summary>
    internal static bool IsTileOfCurrentMap(Farmer player, int x, int y) =>
        (player.currentLocation is { } location && location.isTileOnMap(new Vector2(x, y)))
        || DiscoverExitTiles(player).Any(exit => exit.SourceX == x && exit.SourceY == y);

    /// <summary>One tile's edge in pixels: `Character.Tile` is `StandingPixel / 64` (Character.cs:361-373), so this is
    /// the pixel width the radius of one tile is measured in.</summary>
    internal const int TilePixels = 64;

    /// <summary>
    /// The two origins a radius refusal prints, so a reader can tell a distance from an artefact of how it was measured.
    ///
    /// <para>
    /// <c>Utility.tileWithinRadiusOfPlayer</c> (Utility.cs:4100-4109) compares TILE INDICES: it reads <c>f.Tile</c>, which
    /// is <c>StandingPixel / 64</c> (Character.cs:361-373) - the centre of the body's bounding box, floored. So the gate
    /// that admitted or refused a door was decided in tiles derived from one pixel, and the refusal printed only the tile
    /// (`actor=9,9`). Measured `round91`: `door_out_of_range ... actor=9,9 distance=6` gave a reader no way to tell "she is
    /// six tiles away" from "the check used an origin other than the one you are holding".
    /// </para>
    /// <para>
    /// <c>measured_px</c> is that same separation in pixels - her standing pixel to the requested tile's centre - and it
    /// differs from <c>distance</c> × 64 by up to half a tile on each axis, because the tile index is the FLOOR of hers.
    /// The disagreement is the fact this publishes rather than a rounding error to hide: it appears exactly when the body
    /// is off a tile centre, which is most of a walk. <c>allowed_px</c> is the radius the gate compares against, one tile.
    /// </para>
    /// </summary>
    internal static string DescribeRadiusOrigins((int X, int Y) requested, Farmer actor)
    {
        Microsoft.Xna.Framework.Point standing = actor.StandingPixel;
        int centreX = requested.X * TilePixels + TilePixels / 2;
        int centreY = requested.Y * TilePixels + TilePixels / 2;
        int measured = Math.Max(Math.Abs(standing.X - centreX), Math.Abs(standing.Y - centreY));
        return $"actor_tile={(int)actor.Tile.X},{(int)actor.Tile.Y};actor_px={standing.X},{standing.Y};"
            + $"allowed_px={TilePixels};measured_px={measured.ToString(CultureInfo.InvariantCulture)}";
    }

    /// <summary>
    /// What THIS map says about one tile a door request named: whether it declares a door there at all, and - for the
    /// door the clock shuts - the hours the game itself reads.
    ///
    /// <para>
    /// WHY THE MAP'S NAME IS PART OF IT. Measured `round91`: `door_not_available ... you=7,18;nearest=28,15;distance=21`
    /// six times, and the sentence could not tell "no door of this map is on that tile" from "one is, and it is shut",
    /// because it named the exits it had enumerated without saying whose exits they were.
    /// </para>
    /// <para>
    /// The declaration tested here is the one the door path itself admits on: a building's human door, or a
    /// Buildings-layer <c>Action</c> containing "Warp" (<see cref="IsNativeWarpAction"/>, the predicate
    /// <c>updateDoors</c> applies). <c>locked_by_hours</c> is read from `LockedDoorWarp`'s own arguments -
    /// `LockedDoorWarp &lt;x&gt; &lt;y&gt; &lt;location&gt; &lt;openTime&gt; &lt;closeTime&gt;` (GameLocation.cs:9539) - so the hours
    /// are the world's numbers and not a second copy of the gate's verdict: the gate ALSO honours the town key, the
    /// SeedShop Wednesday rule and green rain (GameLocation.cs:10319-10379), which is why the verdict stays the game's
    /// own dialogue and only the window is printed here.
    /// </para>
    /// </summary>
    internal static string DescribeDoorAtTile(StardewValley.GameLocation? location, int x, int y)
    {
        if (location is null)
            return $"map=unknown;door_tile={x},{y};door_at_tile=unknown";

        Microsoft.Xna.Framework.Point tile = new(x, y);
        string? action = ReadBuildingsLayerAction(location, tile);
        bool declared = IsNativeWarpAction(action)
            || location.buildings.Any(building => building.HasIndoors() && building.getPointForHumanDoor() == tile);
        string head = $"map={location.NameOrUniqueName};door_tile={x},{y};door_at_tile=";
        if (!declared)
            return head + "absent";
        return ReadLockedDoorWindow(action) is { } window
            ? $"{head}locked_by_hours;opens_at={window.OpensAt.ToString(CultureInfo.InvariantCulture)};"
                + $"closes_at={window.ClosesAt.ToString(CultureInfo.InvariantCulture)};now={Game1.timeOfDay.ToString(CultureInfo.InvariantCulture)}"
            : head + "declared";
    }

    /// <summary>
    /// The open/close window a `LockedDoorWarp` Buildings-layer <c>Action</c> declares, or null when this tile carries no
    /// such window. The token positions are the engine's own (`ArgUtility.TryGetInt(action, 4, ...)` / <c>5</c>,
    /// GameLocation.cs:9539): token 0 is the action name, 1-2 the destination tile, 3 the destination map.
    /// </summary>
    private static (int OpensAt, int ClosesAt)? ReadLockedDoorWindow(string? action)
    {
        if (action is null)
            return null;
        string[] tokens = action.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length < 6 || !string.Equals(tokens[0], "LockedDoorWarp", StringComparison.Ordinal))
            return null;
        return int.TryParse(tokens[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out int opensAt)
            && int.TryParse(tokens[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out int closesAt)
            ? (opensAt, closesAt)
            : null;
    }

    /// <summary>The field a refusal carries when it is the refusal answered just before it, word for word.</summary>
    internal const string SameRefusalField = "same_refusal_as_before";

    /// <summary>
    /// <paramref name="evidence"/> with <c>same_refusal_as_before=&lt;n&gt;</c> when the receipt stored immediately before this
    /// one was the same refusal: same code, same evidence, nothing settled between them.
    ///
    /// <para>
    /// WHY A REPEAT HAS TO SAY SO. Measured `round91`: eight door refusals in one window - `door_out_of_range` twice with
    /// the same actor and distance, `door_not_available` six times - each one word for word the one before. A refusal that
    /// comes back identical carries no fact its predecessor did not, so a reader cannot tell "the world has not changed"
    /// from "the world changed and this is a new failure", and the run spends the turn re-reading one sentence. The count
    /// sizes the stretch at a glance: `same_refusal_as_before=7` is the eighth answer to one question.
    /// </para>
    /// <para>
    /// THE COMPARISON IS THE PREVIOUS SETTLEMENT, NOT THE PREVIOUS REFUSAL OF THIS KIND, and that settlement is the receipt
    /// the ledger stored last - so anything that resolved in between (a door entered, a walk taken, another action
    /// settled) breaks the chain, while a refusal whose own evidence MOVED (the distance shrank, the nearest door changed)
    /// is a new fact and is never marked. The two answers are compared with the previous one's own marker removed, which is
    /// the only thing they are allowed to differ by.
    /// </para>
    /// <para>
    /// Applied at the two places a receipt is minted - <c>ExecutionManager.RememberTerminal</c> for every action's
    /// terminal, and <c>ExecutionManager.SettleNavigationTerminal</c> for a navigation - so the rule is one field and one
    /// function rather than a line in each family's refusal.
    /// </para>
    /// </summary>
    internal static string? NoteRepeatedRefusal(
        string? previousReasonCode,
        string? previousEvidence,
        string reasonCode,
        string? evidence)
    {
        if (evidence is null
            || previousEvidence is null
            || !string.Equals(previousReasonCode, reasonCode, StringComparison.Ordinal))
            return evidence;
        return string.Equals(WithoutRepeatedRefusal(previousEvidence), evidence, StringComparison.Ordinal)
            ? $"{evidence};{SameRefusalField}={(RepeatedRefusalCount(previousEvidence) + 1).ToString(CultureInfo.InvariantCulture)}"
            : evidence;
    }

    /// <summary>
    /// How many identical answers one refusal's own evidence says came before it: 0 when it carries no marker, and the
    /// marker's own count plus one when it does, so the marker of a refusal and the count of its run never disagree.
    /// </summary>
    private static int RepeatedRefusalCount(string evidence) => RepeatMarkerSpan(evidence) is { } span ? span.Count : 0;

    /// <summary>The same evidence with the repeat marker removed, so two answers can be compared on what they say.</summary>
    private static string WithoutRepeatedRefusal(string evidence) =>
        RepeatMarkerSpan(evidence) is { } span ? evidence.Remove(span.Start, span.End - span.Start) : evidence;

    /// <summary>Where the repeat field sits in one evidence detail and what it counts, or null when it carries none.</summary>
    private static (int Start, int End, int Count)? RepeatMarkerSpan(string evidence)
    {
        int start = evidence.IndexOf($";{SameRefusalField}=", StringComparison.Ordinal);
        if (start < 0)
            return null;
        int digits = start + SameRefusalField.Length + 2;
        int end = digits;
        while (end < evidence.Length && evidence[end] >= '0' && evidence[end] <= '9')
            end += 1;
        return end > digits
            && int.TryParse(evidence[digits..end], NumberStyles.Integer, CultureInfo.InvariantCulture, out int count)
            ? (start, end, count)
            : null;
    }

    /// <summary>
    /// The map a coordinate that is not a tile of THIS one really belongs to, or null when no loaded map claims it.
    ///
    /// <para>
    /// THE ONE FACT `round82` NEEDED AND NOTHING SAID. Measured 2026-11-20, twice in one run: from `FarmHouse` at
    /// `(3,11)` she sent `enter_exit(64,14)`, and from `AnimalShop` at `(13,19)` `enter_exit(90,15)`. Both numbers are
    /// the door tile of the SAME door spelled the way the map she had just LEFT spells it - `Farm:64,14` is the
    /// farmhouse's own human door and `Forest:90,15` the shop's - so the request named a tile that is not on her map at
    /// all. `enter_exit` answered `door_out_of_range ... distance=61`: a walk from `3,11` to a column 61 tiles away that
    /// exists on another map, which is not a distance between two places she can be.
    /// </para>
    ///
    /// <para>
    /// The question is answered by the projection her own doors come from, asked of a different location: a loaded map
    /// that declares this tile as one of its exits AND leads back to where she stands is the map the coordinate belongs
    /// to. Requiring the RETURN leg is what keeps the answer honest - a door of some third map that happens to share
    /// the column says nothing about the door beside her.
    /// </para>
    /// </summary>
    internal static string? MapDeclaringExitTileTo(StardewValley.GameLocation here, int tileX, int tileY)
    {
        foreach (StardewValley.GameLocation candidate in Game1.locations)
        {
            if (candidate is null || ReferenceEquals(candidate, here) || string.IsNullOrWhiteSpace(candidate.NameOrUniqueName))
                continue;
            foreach (BridgeDoor exit in DiscoverDoorTargets(candidate, Game1.player))
            {
                if (exit.SourceX == tileX && exit.SourceY == tileY
                    && string.Equals(exit.TargetLocation, here.NameOrUniqueName, StringComparison.Ordinal))
                    return candidate.NameOrUniqueName;
            }
        }

        return null;
    }

    /// <summary>
    /// The refusal for a coordinate that names <paramref name="there"/>'s door while the actor stands on
    /// <paramref name="here"/>: the code the wire accepts, and the detail that spells the two names the confusion needs.
    ///
    /// <para>
    /// ONE RELATION, TWO SPELLINGS, AND WHY. The reason code is judged by the Host's own `isReasonCode`
    /// (`host/src/protocol.ts`, `[a-z0-9_:-]`), which admits neither `&gt;` nor `,`, so the code carries the fact in the
    /// alphabet it must survive - `target_is_on_another_map:farmhouse:64:14`, the same `name:x:y` shape
    /// `no_reachable_approach:x:y` already uses - while the EVIDENCE carries the readable `here-&gt;there:x,y` form
    /// beside the two facts the door path knows: `door_tile`, the door on HER map, against `lands_at`, where that door
    /// puts her on the other one. The two field names are what make the pair unsayable the other way round.
    /// </para>
    /// </summary>
    internal static (string Code, string Evidence) DescribeAnotherMapsDoor(
        StardewValley.GameLocation here,
        string there,
        int x,
        int y,
        (int X, int Y) actor,
        (int X, int Y)? doorTile = null,
        StardewValley.Warp? doorWarp = null)
    {
        string code = $"target_is_on_another_map:{RefusalProbe.ReasonCodeToken(here.NameOrUniqueName)}:{x.ToString(CultureInfo.InvariantCulture)}:{y.ToString(CultureInfo.InvariantCulture)}";
        string evidence = $"target_is_on_another_map:{here.NameOrUniqueName}->{there}:{x},{y}";
        if (doorTile is { } tile)
            evidence += $";door_tile={tile.X},{tile.Y}";
        if (doorWarp?.TargetName is { Length: > 0 } landsAt)
            evidence += $";lands_at={landsAt}:{doorWarp.TargetX},{doorWarp.TargetY}";
        return (code, evidence + $";actor={actor.X},{actor.Y}");
    }

    private enum NativeDoorOutcome
    {
        NotNative,

        Refused,

        TransitionStarted,

        NoEffect,
    }

    /// <summary>
    /// Runs the native player door entry for a door tile and reports what the
    /// game did, so enter_exit cannot bypass a native door gate.
    ///
    /// The dispatch order mirrors GameLocation.checkAction exactly: building
    /// human doors are tried first (:7647-7653) and only then the Buildings-layer
    /// Action property (:7868-7888). Each branch uses the game's own return value
    /// as the "the click path owns this tile" signal, which is what keeps a door
    /// the click path does not own (WarpBoatTunnel has no performAction case) on
    /// the resolver's warp instead of being misread as a locked gate.
    ///
    /// A refusal leaves the game's own DialogueBox mounted; it is closed with the
    /// public step the native input paths use (<see cref="DialogueBox.closeDialogue"/>),
    /// which also restores <c>Farmer.CanMove</c>. Leaving it mounted would make
    /// every later action reject as <c>player_not_actionable</c>, so the refusal
    /// is reported in the receipt instead of being handed to the player.
    /// </summary>
    private static NativeDoorOutcome DispatchNativeDoor(
        StardewValley.GameLocation location,
        Microsoft.Xna.Framework.Point source,
        out string refusal,
        out string entry)
    {
        refusal = string.Empty;
        entry = "none";
        bool handled = false;

        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (building.HasIndoors() && building.getPointForHumanDoor() == source)
            {
                entry = "building_do_action";
                handled = building.doAction(new Vector2(source.X, source.Y), Game1.player);
                break;
            }
        }

        // The admission predicate is updateDoors' own -- "the Action string
        // contains Warp" (GameLocation.cs:17601) -- and NOT membership of
        // location.doors. Those are different sets, and the difference is a door
        // gate that enter_exit could walk through: updateDoors builds the table
        // from the FOURTH token of the Action string (:17631-17638), so a
        // Warp-family Action with fewer than four tokens is considered and then
        // DISCARDED. WarpGreenhouse is exactly that shape -- one token, and a
        // `ccPantry` gate a real click runs before warping (:9415-9440) -- so
        // door-table membership sent the tile to the resolver's ungated warp.
        // Reading the Action unconditionally would be worse: it would also run
        // "Kitchen", animal-door and generic ActionTiles.
        string? warpAction = ReadBuildingsLayerAction(location, source);
        if (!handled && IsNativeWarpAction(warpAction))
        {
            entry = "perform_action";
            handled = location.performAction(warpAction!, Game1.player, new xTile.Dimensions.Location(source.X, source.Y));
        }

        if (Game1.isWarping)
            return NativeDoorOutcome.TransitionStarted;

        if (Game1.activeClickableMenu is DialogueBox dialogueBox)
        {
            refusal = string.Join(" | ", dialogueBox.dialogues);
            dialogueBox.closeDialogue();
            return NativeDoorOutcome.Refused;
        }

        if (!handled)
            entry = "resolved_warp_fallback";
        return handled ? NativeDoorOutcome.NoEffect : NativeDoorOutcome.NotNative;
    }

    /// <summary>
    /// The Buildings-layer <c>Action</c> property of one tile, read exactly the way
    /// <c>GameLocation.updateDoors</c> reads it: the raw map layer's own tile
    /// property (GameLocation.cs:17600-17601). Deliberately not
    /// <c>doesTileHaveProperty</c>, which also answers for tiles a Building or a
    /// Furniture owns (:13153-13185) and would therefore admit a tile the door table
    /// never sees. An off-map tile answers null instead of throwing.
    /// </summary>
    internal static string? ReadBuildingsLayerAction(
        StardewValley.GameLocation location, Microsoft.Xna.Framework.Point source) =>
        ReadBuildingsLayerAction(location.map?.GetLayer("Buildings"), source.X, source.Y);

    /// <summary>The same read for a caller that already holds the Buildings layer (the
    /// tile scans hoist it once instead of re-resolving it per tile).</summary>
    internal static string? ReadBuildingsLayerAction(xTile.Layers.Layer? buildings, int x, int y)
    {
        if (buildings is null || x < 0 || y < 0 || x >= buildings.LayerWidth || y >= buildings.LayerHeight)
            return null;

        var tile = buildings.Tiles[x, y];
        if (tile is null || !tile.Properties.TryGetValue("Action", out var action))
            return null;
        return action.ToString();
    }

    /// <summary>
    /// Whether a Buildings-layer Action belongs to the warp family. This is
    /// <c>value.Contains("Warp")</c> -- the same test <c>GameLocation.updateDoors</c>
    /// applies to admit a tile (GameLocation.cs:17601) and the same one
    /// <c>getWarpFromDoor</c>'s default arm reapplies when resolving it (:2238). Every
    /// door the table does hold passes it, and the gates the Mod must not bypass
    /// (ccPantry, ccDoorUnlock, Caroline's hearts, locked-door hours) all live behind
    /// it, so it is the only safe admission predicate here.
    /// </summary>
    internal static bool IsNativeWarpAction(string? actionProperty) =>
        actionProperty is not null && actionProperty.Contains("Warp", StringComparison.Ordinal);

    public void CompleteTravelAfterWarp()
    {
        LocalTravelSpec? specification = this.activeTravel;
        if (specification is null || Game1.player is null || Game1.player.currentLocation is null)
            return;

        this.revision++;
        bool locationMatches = string.Equals(Game1.player.currentLocation.NameOrUniqueName, specification.TargetLocation, StringComparison.Ordinal);
        // THE ARRIVAL IS THE POSTCONDITION, AND THE ENGINE CHOOSES WHERE.
        //
        // A warp's declared target tile (`Warp.TargetX/TargetY`, the map asset's own number) is not where the engine
        // puts the farmer. `Game1.warpFarmer` rewrites the tile before the body moves (Game1.cs:9801-9936): a `Farm`
        // entry from `BusStop` is replaced by the Farm map's own `BusStopEntry` (:9864), `FarmCave`/`Forest`/`Backwoods`
        // entries the same way (:9818, :9843, :9873), `BusStop` and `IslandSouth` clamp it (:9804, :9883), `Trailer` and
        // `Club` land in a different location (:9892, :9933), a mount adds `nextFarmerWarpOffset` (:10000), and
        // `performWarpFarmer` slides a right-edge tile one column left (:10009-10012).
        //
        // MEASURED round68: `travel` from `BusStop` was accepted for `Farm:79,17` and the engine landed her on
        // `(78,17)` - the Farm map's `BusStopEntry` - so a tile-exact postcondition refused an arrival that WAS the
        // arrival, twice. The tile is reported (it is in the evidence below, and in every later snapshot) but it is not
        // a promise the engine ever made, so it is not a postcondition. The mine arms keep theirs because a mine level
        // is the location's identity, not a tile the engine is free to move.
        bool tileMatches = specification.Action switch
        {
            "enter_mine" => Game1.player.currentLocation is StardewValley.Locations.MineShaft mine
                && mine.mineLevel == int.Parse(specification.TargetLocation.Substring("UndergroundMine".Length)),
            "select_mine_elevator_floor" => specification.TargetLocation == "Mine"
                ? locationMatches
                : Game1.player.currentLocation is StardewValley.Locations.MineShaft elevatorMine
                    && elevatorMine.mineLevel == int.Parse(specification.TargetLocation.Substring("UndergroundMine".Length)),
            "use_mine_ladder" => locationMatches,
            "use_obelisk" => locationMatches,
            // A warp totem's landing tile is also chosen inside the game's own delayed callback
            // (Object.totemWarpForReal) and Game1.warpFarmer may nudge it, so the destination LOCATION is the only legal
            // postcondition here too.
            "use_warp_item" => locationMatches,
            // Every remaining arm is an ordinary warp the engine performs - `travel`, `enter_exit`, `ride_minecart` - and
            // the engine rewrites the declared tile before the body moves (see the block above), so the arrival location
            // is the only postcondition any of them can have.
            _ => locationMatches,
        };
        ExecutionState state = locationMatches && tileMatches ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = locationMatches && tileMatches
            ? specification.Action == "enter_exit"
                ? "enter_exit_completed"
                : specification.Action == "ride_minecart"
                    ? "minecart_ride_completed"
                    : specification.Action == "enter_mine"
                        ? "mine_entered"
                        : specification.Action == "select_mine_elevator_floor"
                            ? "mine_elevator_floor_selected"
                            : specification.Action == "use_obelisk"
                                ? "obelisk_arrived"
                                : specification.Action == "use_warp_item"
                                    ? "warp_item_arrived"
                                    : specification.Action == "use_mine_ladder"
                                        ? "mine_left"
                                        : "travel_completed"
            : specification.Action == "enter_exit"
                ? "enter_exit_postcondition_mismatch"
                : specification.Action == "ride_minecart"
                    ? "minecart_ride_postcondition_mismatch"
                    : specification.Action == "enter_mine"
                        ? "mine_entry_postcondition_mismatch"
                        : specification.Action == "select_mine_elevator_floor"
                            ? "mine_elevator_floor_postcondition_mismatch"
                            : specification.Action == "use_obelisk"
                                ? "obelisk_postcondition_mismatch"
                                : specification.Action == "use_warp_item"
                                    ? "warp_item_arrival_mismatch"
                                    : specification.Action == "use_mine_ladder"
                                        ? "mine_exit_postcondition_mismatch"
                                        : "travel_postcondition_mismatch";
        string minecartEvidence = specification.MinecartNetworkId is null || specification.MinecartDestinationId is null
            ? string.Empty
            : $";network={specification.MinecartNetworkId};destination={specification.MinecartDestinationId}";
        string mineExitDecisionEvidence = specification.Action == "use_mine_ladder"
            ? $";question={MineExitQuestionKey};response={MineExitResponseKey}"
            : string.Empty;
        this.slots.Travel.Clear();
        this.RememberTerminal(specification.RequestId, specification.ExecutionId, state, reasonCode,
            $"expected={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};actual={Game1.player.currentLocation.NameOrUniqueName}:{Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}{(specification.Action is "enter_mine" or "select_mine_elevator_floor" && Game1.player.currentLocation is StardewValley.Locations.MineShaft shaft2 ? $";level={shaft2.mineLevel}" : string.Empty)}{(specification.Action == "ride_minecart" ? minecartEvidence : string.Empty)}{mineExitDecisionEvidence}");
    }

    /// <summary>
    /// The evidence a refused destination selector publishes: which kind of selector the request named, the label when
    /// the selector carried one, and the ONE fact that refused it (<see cref="NavigationDestinationResolution.FailureDetail"/>).
    ///
    /// <para>
    /// MEASURED `round85` (`plan_323`): a `navigate_to_destination` admitted through a `dr1_` handle the companion had
    /// copied from an observation six minutes earlier answered `destination_selector_stale` with `detail=destination` -
    /// the word the admission used to publish whenever a ref resolution carried no label. A reader could not tell a
    /// handle it had outlived (the store's lifetime is five minutes) from a destination set that had moved, and the same
    /// stale handle was planned again. `NavigationNextStep.Describe` then appends the next step the code owes the
    /// caller (`observe_the_published_destinations`), which is the re-resolve this refusal exists to ask for.
    /// </para>
    /// </summary>
    private static string DescribeSelectorRefusal(
        NavigationDestinationSelector selector,
        NavigationDestinationResolution resolution)
    {
        List<string> fields = new();
        if (resolution.DisplayLabel is { Length: > 0 } label)
            fields.Add($"destination={label}");
        fields.Add($"selector={selector.Kind}");
        if (resolution.FailureDetail is { Length: > 0 } detail)
            fields.Add(detail);
        return string.Join(';', fields);
    }

    /// <summary>
    /// Requests the single Navigation execution. It creates exactly one receipt
    /// lineage through the coordinator lifecycle and performs the terminal CAS
    /// on this ledger. Local approach/native transition legs are coordinator-own
    /// internal steps; a possibly side-effected but uncorrelated transition is
    /// never retried. Without a wired Navigation runtime this ledger fails closed.
    /// </summary>
    public LocalExecutionReceipt RequestNavigate(string requestId, NavigationDestinationSelector selector, long deadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = this.ledger.NewExecutionId(requestId);
        this.ledger.MarkNavigationExecution(executionId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (deadlineMs <= nowMs || deadlineMs > nowMs + TimeSpan.FromMinutes(10).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline",
                $"deadline={deadlineMs};now={nowMs};ceiling={nowMs + (long)TimeSpan.FromMinutes(10).TotalMilliseconds}");

        if (this.activeNavigate is not null
            || this.active is not null
            || this.activeTravel is not null
            || this.activePet is not null
            || this.activeAnimalProduct is not null
            || this.activeItemUse is not null
            || this.activeItemPickup is not null
            || this.controller.HasActiveExecution
            || this.activeNavigationCoordinator is not null)
        {
            return this.RejectBodyOwned(requestId, executionId);
        }

        NavigationRuntimeSnapshot? runtime = this.navigationRuntimeFactory?.Invoke();
        if (runtime is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "destination_access_indeterminate", NavigationNextStep.Describe("destination_access_indeterminate", "navigation_runtime_unavailable"));

        AcceptedNavigationExecution coordinator;
        NavigationPlan plan;
        try
        {
            NavigationAdmission admission = AcceptedNavigationExecution.Admit(selector, runtime);
            if (!admission.IsAccepted)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    admission.Resolution.FailureReason ?? "destination_selector_invalid",
                    NavigationNextStep.Describe(
                        admission.Resolution.FailureReason ?? "destination_selector_invalid",
                        DescribeSelectorRefusal(selector, admission.Resolution)));
            }

            coordinator = AcceptedNavigationExecution.ForAcceptedDestination(admission);
            string? canonicalIdentity = admission.Resolution.Binding?.CanonicalDestinationIdentity;
            string? shopClosingEvidence = this.RunNavigationShopPreflight(canonicalIdentity);
            if (shopClosingEvidence is not null)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Blocked,
                    "destination_closed_hours",
                    shopClosingEvidence);
            }
            plan = coordinator.PlanNextRouteLeg();
        }
        catch
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "destination_access_indeterminate", NavigationNextStep.Describe("destination_access_indeterminate", "navigation_decision_unavailable"));
        }

        if (plan.IsTerminal)
            return this.RememberTerminal(requestId, executionId, plan.Outcome.State, plan.Outcome.TerminalReasonCode, NavigationNextStep.Describe(plan.Outcome.TerminalReasonCode, plan.Outcome.Evidence));

        NavigationTransitionLeg? nextLeg = plan.Outcome.NextLeg;
        if (nextLeg is null)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "destination_access_indeterminate",
                NavigationNextStep.Describe("destination_access_indeterminate", "phase=approved;transition=none;commit=never_armed"));
        }

        NavigationTransitionLeg? approachLeg = this.SelectApproachableLeg(coordinator, nextLeg, out Vector2 approachTile, out string routeEvidence);
        if (approachLeg is null)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "navigation_approach_unavailable", NavigationNextStep.Describe("navigation_approach_unavailable", $"phase=approved;approach=unavailable{routeEvidence};never_retry=true"));
        }
        nextLeg = approachLeg;
        Vector2 approachTarget = approachTile;

        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((deadlineMs - nowMs) * 60d / 1000d));
        string canonicalDestinationIdentity = plan.Resolution.Binding?.CanonicalDestinationIdentity ?? nextLeg.TargetLocation;
        LocalNavigateSpec navigation = new(
            executionId,
            requestId,
            selector,
            canonicalDestinationIdentity,
            plan.View.CurrentSourceLocation ?? "unknown",
            nextLeg,
            approachTarget,
            deadlineMs,
            LocalNavigatePhase.Approaching);
        LocalMoveSpec approach = new(
            executionId,
            requestId,
            approachTarget,
            AllowAdjacentArrival: true,
            this.revision,
            this.tick + deadlineTicks,
            deadlineMs);

        this.slots.NavigationCoordinator.Assign(coordinator);
        this.slots.Navigate.Assign(navigation);
        this.slots.Active.Assign(approach);
        if (!this.TryStartApproach(approach, out string reasonCode, out string? approachEvidence, out string? approachHint))
        {
            this.slots.Active.Clear();
            this.slots.Navigate.Clear();
            this.slots.NavigationCoordinator.Clear();
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode ?? "approach_unavailable", approachEvidence ?? "phase=approaching;arm=failed", hint: approachHint);
        }

        return this.RememberTerminal(requestId, executionId, ExecutionState.Accepted, "accepted", $"navigation=accepted;phase=approaching{routeEvidence}");
    }

    private static readonly Dictionary<string, int> DirectionMap = new(StringComparer.Ordinal)
    {
        ["up"] = 0,
        ["right"] = 1,
        ["down"] = 2,
        ["left"] = 3,
    };

    /// <summary>
    /// `face_direction`: the actor's own facing, applied whether she stands or walks.
    ///
    /// <para>
    /// The native call takes no movement precondition, so the only thing this can honestly refuse is another execution
    /// already writing the same field - see the block below.
    /// </para>
    /// </summary>
    public LocalExecutionReceipt RequestLocalFaceDirection(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (this.OpenDispatchEnvelope(request, ledger, out string executionId) is DispatchEnvelope.Answered alreadyAnswered)
            return alreadyAnswered.Receipt;

        this.revision++;

        if (request.Args.Direction is null || !DirectionMap.TryGetValue(request.Args.Direction, out int directionInt))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_direction",
                $"direction={request.Args.Direction ?? "none"}");

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        // AN EXPRESSION DOES NOT NEED THE BODY TO BE STILL. `Character.faceDirection` (Character.cs:713-729: `if
        // (direction != -3) { FacingDirection = direction; Sprite?.faceDirection(direction); faceTowardFarmer = false; }`)
        // writes the actor's own facing and asks nothing of her - no `CanMove`, no `isMoving()`, no `Game1.eventUp` - and
        // it changes nothing about the world either: no object, tile, terrain, inventory, container or NPC state, the same
        // fact that took `express_emote` out of the durability alarm
        // (`FarmhandActionCatalog.ActionsThatChangeNothing`). Gating a flat expression on motion therefore refused a
        // request that touched nothing, with a code (`actor_moving`) that named nothing the caller could wait for
        // (measured `1795084502755`).
        //
        // WHAT A WALK DOES TO IT, because the receipt must not claim more than it proved: `Character.MovePosition` faces
        // the direction it steps on every movement tick (Character.cs:851, :879, :907, :935), so a facing applied mid-walk
        // is hers at the instant `actor_facing_matches` is read and is the walk's own on the next step. That is why the
        // receipt publishes `moving=` beside the direction instead of staying silent about it.
        //
        // THE ONE HOLD LEFT is another EXECUTION's ownership, and it is not about motion: that owner writes the same
        // field on its own next tick, so a facing minted underneath it would be overwritten before anyone could observe
        // it. It is named by the one describer of body ownership, so the refusal carries the owner's own evidence.
        bool walking = actor.isMoving();
        if (this.active is not null || this.activeNavigate is not null || this.controller.HasActiveExecution)
        {
            BodyOwner owner = this.admission.Describe();
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, owner.ReasonCode, owner.Evidence);
        }

        try
        {
            actor.faceDirection(directionInt);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "face_direction_native_exception",
                $"direction={request.Args.Direction};native_dispatched=false;native_exception={nativeException.GetType().Name}",
                this.TryCreateLocalObservation(actor));
        }

        BridgeLocalObservation? observation = this.TryCreateLocalObservation(actor);
        string moving = walking ? "true" : "false";
        if (actor.FacingDirection == directionInt)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "actor_facing_matches",
                $"direction={request.Args.Direction};moving={moving}",
                observation);
        }

        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Failed,
            "postcondition_failed",
            $"expected={directionInt};actual={actor.FacingDirection};moving={moving}",
            observation);
    }
}
