using System;
using System.Collections.Generic;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

// Obelisk activation for the `use_obelisk` action.
//
// WHY THIS IS ITS OWN ACTION. The reconciliation table used to claim the obelisk
// selectors were already covered by `travel`/`enter_exit`. That was FALSE:
//   * `enter_exit`'s building branch needs `building.HasIndoors()` plus
//     `getPointForHumanDoor() == source` (farmhandexecutioncontroller.movementactions.cs
//     :437-445) and an obelisk has no indoors, so it is skipped outright; its other
//     branch admits only keys of `location.doors`, which `updateDoors` builds from
//     MAP Buildings-layer Actions containing "Warp" (GameLocation.cs:17586-17631),
//     while a modern obelisk's action string comes from Data/Buildings ActionTiles
//     via `Building.doAction` -> `GetData().GetActionAtTile` -> `performAction`
//     (Building.cs:981-991);
//   * `travel` serves only `GameLocation.warps`.
// Nothing reached an obelisk.
//
// ONE action id covers BOTH native routes, because the Agent-facing intent is the
// same -- "activate this fixed-point warp structure; I do not choose a
// destination" -- and the Mod selects the destination from the target structure:
//
//   Route A -- a placed obelisk BUILDING (Data/Buildings obelisk types). The shared
//     public UI-free seam is `Building.PerformObeliskWarp` (Building.cs:1030 ->
//     `obeliskWarpForReal` :1067). `Building.TryPerformObeliskWarp` (:1009) is NOT
//     the seam: `doAction` reaches it only when `GetData() == null`
//     (Building.cs:994-999), so a modern data-driven obelisk never goes through it.
//     The building-type -> destination mapping is therefore read from that switch
//     (Building.cs:1011-1028) into `TryGetObeliskWarp` below:
//       Desert Obelisk -> Desert       35,43  force_dismount=true
//       Water Obelisk  -> Beach        20,4   force_dismount=false
//       Earth Obelisk  -> Mountain     31,20  force_dismount=false
//       Island Obelisk -> IslandSouth  11,11  force_dismount=false
//
//   Route B -- IslandWest's own "FarmObelisk" tile, handled by
//     `IslandWest.performAction` itself (IslandWest.cs:184-199: temp sprites, wand
//     sound, displayFarmer=false, freezePause, DelayedAction.fadeAfterDelay ->
//     warpFarmer("Farm", ...)). That action string does NOT contain "Warp", so
//     `updateDoors` can never put it in the door table either. PREREQUISITE: the
//     tile only exists after the island obelisk upgrade applies the
//     `Island_W_Obelisk` map override (IslandWest.cs:425-440), which is what
//     `IslandWest.farmObelisk` drives; discovery and admission both require it.
//
// ARGUMENTS: `{ x, y, expectedTargetId }`. Both native routes are addressed by a
// TILE -- Route B literally calls `performAction(action, who, tileLocation)`, and
// Route A is a building the client locates in its own footprint -- and the protocol
// has no optional argument (FarmhandActionArgument has no concept of one, and both
// the execution parser and acceptance are exact-shape allow-lists), so `x,y` are
// declared and required exactly as `ride_minecart` declares its station tile.
//
// ASYNC TERMINAL. `PerformObeliskWarp` does not warp: it plays the wand effect,
// freezes the actor and hands `obeliskWarpForReal` to
// `DelayedAction.fadeAfterDelay(..., 1000)`; the island tile does the same. The
// terminal therefore belongs to the ARRIVAL, never to the dispatch return value:
// this accepts, records the specification in the shared `activeTravel` slot, and
// lets `CompleteTravelAfterWarp` mint the single terminal once the Warped edge
// arrives -- the same one-terminal ledger path as `travel`, `ride_minecart`,
// `enter_mine` and `select_mine_elevator_floor`.
//
// POSTCONDITION. Location equality with the destination is the legal
// postcondition for BOTH routes, and the arrival TILE is not: Route B's arrival
// tile is chosen by the game inside its own delayed callback (IslandWest.cs:200-208
// reads the farm's WarpTotemEntry map property, else a whichFarm fallback), and
// Route A's fixed destination tile can be nudged by `Game1.warpFarmer` onto a
// passable neighbour. The receipt still carries the expected destination tile.
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    /// <summary>Route selector for a placed obelisk building.</summary>
    internal const string ObeliskBuildingRoute = "building";
    /// <summary>Route selector for IslandWest's own "FarmObelisk" tile.</summary>
    internal const string ObeliskIslandFarmTileRoute = "island_farm_tile";

    /// <summary>The action string IslandWest.performAction handles itself (IslandWest.cs:186).</summary>
    private const string IslandFarmObeliskAction = "FarmObelisk";
    /// <summary>The map the island obelisk warps to (IslandWest.cs:209).</summary>
    internal const string IslandFarmObeliskDestination = "Farm";
    private const string IslandFarmObeliskDisplayName = "Island Farm Obelisk";
    /// <summary>The visible radius discovery scans for the island obelisk tile.</summary>
    private const int ObeliskTargetDiscoveryRadius = 12;

    /// <summary>
    /// The building-type -> destination mapping, read from
    /// <c>Building.TryPerformObeliskWarp</c>'s switch (Building.cs:1011-1028). It is
    /// owned here rather than delegated to that method because the destination is
    /// part of this action's receipt, its admission (the destination must resolve)
    /// and its postcondition -- all of which would otherwise be unverifiable.
    /// </summary>
    internal static bool TryGetObeliskWarp(
        string buildingType,
        out string destination,
        out int warpX,
        out int warpY,
        out bool forceDismount)
    {
        switch (buildingType)
        {
            case "Desert Obelisk":
                destination = "Desert";
                warpX = 35;
                warpY = 43;
                forceDismount = true;
                return true;
            case "Water Obelisk":
                destination = "Beach";
                warpX = 20;
                warpY = 4;
                forceDismount = false;
                return true;
            case "Earth Obelisk":
                destination = "Mountain";
                warpX = 31;
                warpY = 20;
                forceDismount = false;
                return true;
            case "Island Obelisk":
                destination = "IslandSouth";
                warpX = 11;
                warpY = 11;
                forceDismount = false;
                return true;
            default:
                destination = string.Empty;
                warpX = 0;
                warpY = 0;
                forceDismount = false;
                return false;
        }
    }

    /// <summary>
    /// Opaque, stable selector for one obelisk structure. The route is part of the
    /// identity, so an id published for the island tile can never be replayed
    /// against a building (or the reverse).
    /// </summary>
    internal static string BuildObeliskTargetId(string route, string location, string key, int x, int y)
    {
        string raw = $"obelisk:{route}:{location}:{key}:{x},{y}";
        return $"obelisk_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The native <c>Building.doAction</c> interaction radius, as geometry: the
    /// interaction happens from a tile that is Chebyshev-1 from a tile the building
    /// occupies, i.e. the actor tile lies inside the building rectangle dilated by
    /// one. Pure over the numbers so the ring is testable without a live Building.
    /// </summary>
    internal static bool IsTileWithinBuildingRing(
        int actorTileX,
        int actorTileY,
        int buildingTileX,
        int buildingTileY,
        int buildingTilesWide,
        int buildingTilesHigh) =>
        actorTileX >= buildingTileX - 1
        && actorTileX <= buildingTileX + buildingTilesWide
        && actorTileY >= buildingTileY - 1
        && actorTileY <= buildingTileY + buildingTilesHigh;

    /// <summary>
    /// Answers, for the fixture, the two questions this action asks before it will act: can the
    /// published identity be resolved at the named tile, and is the actor inside the building's
    /// interaction ring. The first live run passed a weaker fixture check and was still refused, so
    /// this exists to make that class of mismatch impossible to ship again.
    /// </summary>
    internal sealed record ObeliskFixtureProbe(bool Resolvable, string Route, int TileX, int TileY);

    internal static ObeliskFixtureProbe ProbeObeliskFixture(
        GameLocation location,
        int tileX,
        int tileY,
        int actorTileX,
        int actorTileY,
        string expectedTargetId)
    {
        ObeliskTargetResolution resolution = ResolveObeliskTarget(location, tileX, tileY, expectedTargetId);
        if (!resolution.Accepted)
            return new ObeliskFixtureProbe(false, resolution.ReasonCode, tileX, tileY);
        bool inRing = resolution.Route == ObeliskBuildingRoute && resolution.Building is { } building
            ? IsTileWithinBuildingRing(
                actorTileX,
                actorTileY,
                building.tileX.Value,
                building.tileY.Value,
                building.tilesWide.Value,
                building.tilesHigh.Value)
            : Utility.tileWithinRadiusOfPlayer(tileX, tileY, 1, Game1.player);
        return new ObeliskFixtureProbe(inRing, resolution.Route, tileX, tileY);
    }

    /// <summary>The island obelisk tile is identified by its own action string.</summary>
    private static bool IsFarmObeliskAction(string action)
    {
        string[] parts = action.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length > 0 && string.Equals(parts[0], IslandFarmObeliskAction, StringComparison.Ordinal);
    }

    /// <summary>
    /// The native arrival tile of the island route, read from the same source the
    /// game's delayed callback reads (IslandWest.cs:200-208): the farm's
    /// <c>WarpTotemEntry</c> map property, else the whichFarm fallback. Recorded as
    /// EXPECTED-tile evidence only -- the postcondition is the arrival location,
    /// because `Game1.warpFarmer` may place the actor on a passable neighbour.
    /// </summary>
    private static bool TryResolveIslandFarmObeliskArrival(out int tileX, out int tileY)
    {
        tileX = 0;
        tileY = 0;
        StardewValley.GameLocation? farm = Game1.getFarm();
        if (farm is null)
            return false;

        Microsoft.Xna.Framework.Point parsed = default;
        bool hasEntry = false;
        try
        {
            hasEntry = farm.TryGetMapPropertyAs("WarpTotemEntry", out parsed, required: false);
        }
        catch
        {
            // A malformed map property falls back to the same whichFarm default the
            // native callback uses; it is not a refusal.
            hasEntry = false;
        }

        if (!hasEntry)
        {
            parsed = Game1.whichFarm switch
            {
                6 => new Microsoft.Xna.Framework.Point(82, 29),
                5 => new Microsoft.Xna.Framework.Point(48, 39),
                _ => new Microsoft.Xna.Framework.Point(48, 7),
            };
        }

        tileX = parsed.X;
        tileY = parsed.Y;
        return true;
    }

    /// <summary>
    /// The obelisk structures the actor can name right now, projected read-only from
    /// live state: every finished obelisk building in the current location, plus
    /// IslandWest's own tile when the island obelisk upgrade is applied. Nothing is
    /// synthesized -- an obelisk that is not there is not advertised.
    /// </summary>
    private IReadOnlyList<BridgeObeliskTarget> DiscoverObeliskTargets(Farmer player)
    {
        if (player is null || player.currentLocation is not StardewValley.GameLocation location)
            return Array.Empty<BridgeObeliskTarget>();

        List<BridgeObeliskTarget> targets = new();

        // Route A: placed obelisk buildings.
        foreach (Building building in location.buildings)
        {
            if (building is null || building.daysOfConstructionLeft.Value > 0)
                continue;
            if (!TryGetObeliskWarp(building.buildingType.Value, out string destination, out _, out _, out bool forceDismount))
                continue;
            targets.Add(new BridgeObeliskTarget(
                BuildObeliskTargetId(ObeliskBuildingRoute, location.NameOrUniqueName, building.buildingType.Value, building.tileX.Value, building.tileY.Value),
                ObeliskBuildingRoute,
                location.NameOrUniqueName,
                building.tileX.Value,
                building.tileY.Value,
                building.buildingType.Value,
                destination,
                forceDismount));
        }

        // Route B: IslandWest's own "FarmObelisk" tile. The tile exists only after
        // the Island_W_Obelisk override is applied (IslandWest.cs:425-440), so an
        // island without the upgrade advertises nothing here.
        if (location is StardewValley.Locations.IslandWest islandWest && islandWest.farmObelisk.Value)
        {
            xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
            if (buildings is not null)
            {
                int minX = Math.Max(0, player.TilePoint.X - ObeliskTargetDiscoveryRadius);
                int maxX = Math.Min(buildings.LayerWidth - 1, player.TilePoint.X + ObeliskTargetDiscoveryRadius);
                int minY = Math.Max(0, player.TilePoint.Y - ObeliskTargetDiscoveryRadius);
                int maxY = Math.Min(buildings.LayerHeight - 1, player.TilePoint.Y + ObeliskTargetDiscoveryRadius);
                for (int x = minX; x <= maxX; x++)
                {
                    for (int y = minY; y <= maxY; y++)
                    {
                        string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
                        if (action is null || !IsFarmObeliskAction(action))
                            continue;
                        targets.Add(new BridgeObeliskTarget(
                            BuildObeliskTargetId(ObeliskIslandFarmTileRoute, location.NameOrUniqueName, IslandFarmObeliskAction, x, y),
                            ObeliskIslandFarmTileRoute,
                            location.NameOrUniqueName,
                            x,
                            y,
                            IslandFarmObeliskDisplayName,
                            IslandFarmObeliskDestination,
                            false));
                    }
                }
            }
        }

        return targets;
    }

    /// <summary>
    /// One resolved obelisk, or the named reason the published target no longer
    /// matches the live world.
    /// </summary>
    private sealed record ObeliskTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        string Route,
        string Destination,
        int DestinationX,
        int DestinationY,
        bool ForceDismount,
        Building? Building)
    {
        internal static ObeliskTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, string.Empty, string.Empty, 0, 0, false, null);
    }

    /// <summary>
    /// Re-derives the named obelisk on the game thread. The client-supplied id is
    /// only a selector: the structure at `x,y` decides the route, the destination
    /// and the identity, and a mismatch is a named refusal rather than a silent
    /// re-target.
    /// </summary>
    private static ObeliskTargetResolution ResolveObeliskTarget(
        StardewValley.GameLocation location, int x, int y, string expectedTargetId)
    {
        // Route A. The named tile may be ANY tile of the building's own footprint;
        // the canonical identity is the building's origin tile plus its type, so a
        // different tile of the same building is the same obelisk.
        foreach (Building building in location.buildings)
        {
            if (building is null || !building.occupiesTile(x, y))
                continue;
            if (!TryGetObeliskWarp(building.buildingType.Value, out string destination, out int warpX, out int warpY, out bool forceDismount))
                return ObeliskTargetResolution.Reject(
                    "obelisk_not_an_obelisk",
                    $"tile={x},{y};building_type={building.buildingType.Value};building_origin={building.tileX.Value},{building.tileY.Value}");
            string liveId = BuildObeliskTargetId(
                ObeliskBuildingRoute, location.NameOrUniqueName, building.buildingType.Value, building.tileX.Value, building.tileY.Value);
            if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
                return ObeliskTargetResolution.Reject(
                    "obelisk_target_changed",
                    $"tile={x},{y};published={expectedTargetId};live={liveId}");
            return new(true, "accepted", string.Empty, ObeliskBuildingRoute, destination, warpX, warpY, forceDismount, building);
        }

        // The tile belongs to a building only through its extra tile-property
        // radius: something is there and it is not an obelisk the caller may name.
        foreach (Building building in location.buildings)
        {
            if (building is null || !building.occupiesTile(x, y, applyTilePropertyRadius: true))
                continue;
            return ObeliskTargetResolution.Reject(
                "obelisk_not_an_obelisk",
                $"tile={x},{y};building_type={building.buildingType.Value};building_origin={building.tileX.Value},{building.tileY.Value};tile_outside_owned_footprint=true");
        }

        // Route B.
        string? tileAction = location.doesTileHaveProperty(x, y, "Action", "Buildings");
        if (tileAction is null || !IsFarmObeliskAction(tileAction))
            return ObeliskTargetResolution.Reject(
                "obelisk_target_not_found",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId}");

        string islandId = BuildObeliskTargetId(ObeliskIslandFarmTileRoute, location.NameOrUniqueName, IslandFarmObeliskAction, x, y);
        if (!string.Equals(islandId, expectedTargetId, StringComparison.Ordinal))
            return ObeliskTargetResolution.Reject(
                "obelisk_target_changed",
                $"tile={x},{y};published={expectedTargetId};live={islandId}");

        if (!TryResolveIslandFarmObeliskArrival(out int arrivalX, out int arrivalY))
            return ObeliskTargetResolution.Reject(
                "obelisk_destination_unavailable",
                $"tile={x},{y};destination={IslandFarmObeliskDestination}");

        return new(true, "accepted", string.Empty, ObeliskIslandFarmTileRoute, IslandFarmObeliskDestination, arrivalX, arrivalY, false, null);
    }

    /// <summary>
    /// Activates one published obelisk and hands the arrival to the shared travel
    /// completion path. Admission is instantaneous and named in the native route's
    /// own terms; the terminal is minted only by
    /// <c>CompleteTravelAfterWarp</c> once the Warped edge shows the destination.
    /// </summary>
    public LocalExecutionReceipt RequestLocalUseObelisk(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        if (!this.TryGetBoundActor(out Farmer? actor, out string scopeReason) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, scopeReason, null);

        StardewValley.GameLocation? location = actor.currentLocation;
        if (!Context.IsWorldReady || location is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        if (Game1.activeClickableMenu is not null || Game1.eventUp || !actor.CanMove)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (request.DeadlineMs <= nowMs || request.DeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);

        // A pending native warp or freeze already exists: the obelisk's own fade
        // arms freezePause for 1000ms before it warps (Building.cs:1045,
        // IslandWest.cs:196), so dispatching into that window would stack two
        // warps. Named rather than silently serialized in the wrong order.
        if (Game1.isWarping || actor.freezePause > 0)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "obelisk_warp_already_pending",
                $"is_warping={Game1.isWarping};freeze_pause={actor.freezePause}");

        // One body at a time: the shared travel slot and every other long-lived
        // owner this action would otherwise race.
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null
            || this.activeToolApproach is not null || this.activeMountTransport is not null
            || this.activeBusRide is not null || this.activeDayAdvance is not null
            || this.activeNavigate is not null
            || this.controller.HasActiveExecution)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "body_owned",
                this.activeTravel?.ExecutionId ?? this.active?.ExecutionId ?? this.activeBusRide?.ExecutionId);
        }

        if (string.IsNullOrWhiteSpace(request.Args.ExpectedTargetId))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "missing_expected_target_id", null);
        string targetId = request.Args.ExpectedTargetId;
        int targetX = (int)(request.Args.X ?? 0);
        int targetY = (int)(request.Args.Y ?? 0);

        ObeliskTargetResolution resolution = ResolveObeliskTarget(location, targetX, targetY, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        // Reach is checked AFTER resolution because the two routes have different interaction
        // geometry, and checking one shape against the other refuses a correctly-staged actor:
        //   * Route A names a BUILDING. The native click reaches it from any tile inside the
        //     building rectangle dilated by one (IsTileWithinBuildingRing), and the published
        //     tile may be any footprint tile while the actor stands on the ring around the whole
        //     footprint — for a 3-wide obelisk that is up to three tiles from the origin.
        //   * Route B names a single map tile, so Chebyshev-1 of that exact tile is right.
        // This is the same defect the tool family had: requiring adjacency to one nominated tile
        // rather than to the thing the actor actually interacts with.
        bool withinReach = resolution.Route == ObeliskBuildingRoute && resolution.Building is { } reached
            ? IsTileWithinBuildingRing(
                actor.TilePoint.X,
                actor.TilePoint.Y,
                reached.tileX.Value,
                reached.tileY.Value,
                reached.tilesWide.Value,
                reached.tilesHigh.Value)
            : Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, actor);
        if (!withinReach)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "obelisk_out_of_reach",
                $"target={targetX},{targetY};tile={actor.TilePoint.X},{actor.TilePoint.Y};route={resolution.Route}");

        if (resolution.Route == ObeliskBuildingRoute)
        {
            // The native click path refuses a mounted actor before it reaches the
            // warp (Building.doAction :933-936), and PerformObeliskWarp's
            // force_dismount arm only dismounts instead of warping (:1032-1036), so
            // a mounted actor is a named refusal rather than a warp that never comes.
            if (actor.isRidingHorse())
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "obelisk_riding_horse",
                    $"target={targetId};tile={targetX},{targetY};building_type={resolution.Building?.buildingType.Value}");

            if (resolution.Building is { } finished && finished.daysOfConstructionLeft.Value > 0)
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "obelisk_under_construction",
                    $"target={targetId};tile={targetX},{targetY};days_left={finished.daysOfConstructionLeft.Value}");
        }
        else
        {
            // The island tile only exists once the upgrade applied the override, so
            // the world fact that drives it is checked directly as well.
            if (location is not StardewValley.Locations.IslandWest islandWest || !islandWest.farmObelisk.Value)
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "obelisk_not_built",
                    $"target={targetId};tile={targetX},{targetY};location={location.NameOrUniqueName}");
        }

        // The warp family ends in Game1.warpFarmer, which needs the destination to
        // resolve; an unresolvable destination is named here instead of becoming a
        // silent non-arrival.
        if (Game1.getLocationFromName(resolution.Destination) is null)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "obelisk_destination_unavailable",
                $"target={targetId};route={resolution.Route};destination={resolution.Destination}");

        string origin = location.NameOrUniqueName;
        if (string.Equals(origin, resolution.Destination, StringComparison.Ordinal))
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "obelisk_already_at_destination",
                $"target={targetId};origin={origin};destination={resolution.Destination}");

        try
        {
            if (resolution.Route == ObeliskBuildingRoute)
            {
                // The shared public UI-free seam. Neither the wand effect, nor the
                // freeze, nor the delayed warp is re-implemented here.
                Building.PerformObeliskWarp(
                    resolution.Destination,
                    resolution.DestinationX,
                    resolution.DestinationY,
                    resolution.ForceDismount,
                    actor);
            }
            else if (!location.performAction(
                IslandFarmObeliskAction,
                actor,
                new xTile.Dimensions.Location(targetX, targetY)))
            {
                // A location that does not own this string cannot start the routine;
                // nothing native ran, so this is a refusal and not an uncertain warp.
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "obelisk_warp_not_started",
                    $"target={targetId};tile={targetX},{targetY};route={resolution.Route};location={origin}");
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "obelisk_native_exception",
                $"target={targetId};tile={targetX},{targetY};route={resolution.Route};native_exception={nativeException.GetType().Name}");
        }

        LocalTravelSpec specification = new(
            executionId,
            request.RequestId,
            "use_obelisk",
            origin,
            targetX,
            targetY,
            resolution.Destination,
            resolution.DestinationX,
            resolution.DestinationY,
            this.revision,
            request.DeadlineMs);
        this.activeTravel = specification;

        LocalExecutionReceipt accepted = new(
            executionId,
            request.RequestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            $"route={resolution.Route};target={targetId};target_tile={targetX},{targetY};origin={origin};"
                + $"destination={resolution.Destination};destination_tile={resolution.DestinationX},{resolution.DestinationY};"
                + $"force_dismount={(resolution.ForceDismount ? "true" : "false")}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }
}
