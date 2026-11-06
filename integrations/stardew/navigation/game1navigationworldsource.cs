using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.GameData.Minecarts;
using StardewValley.Locations;

namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Live game-thread implementation of the Navigation source seam. It reads only
/// target-version native warps/doors, never route/coordinate keys, and folds
/// them into ordinary private transition facts consumed by the coordinator.
/// </summary>
internal sealed class Game1NavigationWorldSource : INavigationWorldSource, INavigationConnectivitySource
{
    public NavigationWorldView CurrentView(NavigationDestinationBinding binding)
    {
        Farmer? player = Game1.player;
        GameLocation? location = player?.currentLocation;
        bool live = Context.IsWorldReady && player is not null && location is not null;
        if (!live)
            return new NavigationWorldView(false, false, null, 0, 0, false, Array.Empty<NavigationTransitionLeg>(), false, false, false, false);

        var legs = new List<NavigationTransitionLeg>();
        foreach (WorldEdge edge in EnumerateEdges(location!))
        {
            if (string.IsNullOrWhiteSpace(edge.TargetLocation))
                continue;
            // An interior exit is a warp the engine's own `Building.updateInteriorWarps` rewrites onto the parent's
            // human-door tile, so it is admitted without the range test the other two families take.
            if (edge.Family != WorldEdgeFamily.InteriorExit
                && !InRange(edge.SourceX, edge.SourceY, edge.TargetX, edge.TargetY))
                continue;
            legs.Add(new NavigationTransitionLeg(
                edge.TargetLocation!, edge.SourceX, edge.SourceY, edge.TargetX, edge.TargetY, edge.IsDoor));
        }

        string? current = location!.NameOrUniqueName;
        return new NavigationWorldView(
            true,
            player!.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp,
            current,
            player.TilePoint.X,
            player.TilePoint.Y,
            string.Equals(current, binding.CanonicalDestinationIdentity, StringComparison.Ordinal),
            legs,
            binding.CanonicalDestinationIdentity.StartsWith("Undermine", StringComparison.Ordinal),
            false,
            false,
            false);
    }

    public bool TryCreateCurrentOrdinaryWarpTopology(
        NavigationDestinationBinding acceptedBinding,
        out NavigationOrdinaryWarpTopology? topology,
        out string reasonCode)
    {
        topology = null;
        reasonCode = "world_or_binding_unavailable";
        Farmer? player = Game1.player;
        GameLocation? currentLocation = player?.currentLocation;
        if (!Context.IsWorldReady || player is null || currentLocation is null
            || string.IsNullOrWhiteSpace(currentLocation.NameOrUniqueName)
            || string.IsNullOrWhiteSpace(acceptedBinding.CanonicalDestinationIdentity))
            return false;

        IList<GameLocation> locations = Game1.locations;
        if (locations is null || locations.Count == 0)
        {
            reasonCode = "loaded_locations_unavailable";
            return false;
        }

        HashSet<string> sourceIds = new(StringComparer.Ordinal);
        List<NavigationOrdinaryWarpLegs> sources = new();
        foreach (GameLocation location in locations)
        {
            string sourceId = location.NameOrUniqueName;
            if (string.IsNullOrWhiteSpace(sourceId))
            {
                reasonCode = "loaded_source_identity_invalid";
                return false;
            }
            if (!sourceIds.Add(sourceId))
            {
                reasonCode = "loaded_source_identity_duplicate";
                return false;
            }

            List<NavigationTransitionLeg> legs = new();
            foreach (WorldEdge edge in EnumerateEdges(location))
            {
                // A door is transit, not a walkable graph edge, and this topology holds walkable edges only. The
                // planner refuses a door leg outright - `navigationrouteplanner.cs:118` answers `route_topology_invalid`
                // for the WHOLE topology - and the executor refuses to arm one
                // (`navigation_transition_family_not_materialized`, at
                // `farmhandexecutioncontroller.movementactions.cs:872`, `farmhandexecutioncontroller.cs:4810` and
                // `:5033`). Publishing the edge here would make BFS answer a route the executor will not walk, which is
                // discovery advertising a capability execution refuses. `CurrentView` still publishes door legs, because
                // `enter_exit` consumes those; the two projections differ on purpose.
                if (edge.Family != WorldEdgeFamily.Warp)
                    continue;
                if (string.IsNullOrWhiteSpace(edge.TargetLocation))
                {
                    reasonCode = "ordinary_warp_target_identity_invalid";
                    return false;
                }
                if (!SourceCoordinateInRange(edge.SourceX, edge.SourceY))
                    continue;
                if (!CoordinateInRange(edge.TargetX, edge.TargetY))
                    continue;
                legs.Add(new NavigationTransitionLeg(
                    edge.TargetLocation!, edge.SourceX, edge.SourceY, edge.TargetX, edge.TargetY, false));
            }
            sources.Add(new NavigationOrdinaryWarpLegs(sourceId, legs));
        }

        string currentSource = currentLocation.NameOrUniqueName;
        if (!sourceIds.Contains(acceptedBinding.CanonicalDestinationIdentity))
        {
            reasonCode = "accepted_destination_not_loaded";
            return false;
        }
        // The live game may retain ordinary warps for locations that are not in
        // the currently loaded subgraph. Keep only loaded and natively accessible
        // endpoints; the planner will fail closed when the accepted destination is
        // not reachable. `isLocationAccessible` is the game's own gate authority.
        IReadOnlyDictionary<string, IReadOnlyList<NavigationVirtualConnectivityLeg>> virtualLegs =
            BuildVirtualConnectivityLegs(locations, sourceIds);
        NavigationOrdinaryWarpLegs[] filteredSources = sources
            .Select(source => new NavigationOrdinaryWarpLegs(
                source.SourceId,
                source.OutgoingOrdinaryLegs
                    .Where(leg => sourceIds.Contains(leg.TargetLocation) && IsLocationAccessible(leg.TargetLocation))
                    .ToArray(),
                virtualLegs.TryGetValue(source.SourceId, out IReadOnlyList<NavigationVirtualConnectivityLeg>? outgoing)
                    ? outgoing
                    : Array.Empty<NavigationVirtualConnectivityLeg>()))
            .ToArray();

        topology = new NavigationOrdinaryWarpTopology(currentSource, filteredSources);
        reasonCode = "accepted";
        return true;
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<NavigationVirtualConnectivityLeg>> BuildVirtualConnectivityLegs(
        IList<GameLocation> locations,
        HashSet<string> sourceIds)
    {
        Dictionary<string, IReadOnlyList<NavigationVirtualConnectivityLeg>> result = new(StringComparer.Ordinal);
        IReadOnlyDictionary<string, MinecartNetworkData>? networks = TryLoadMinecartNetworks();
        if (networks is null)
            return result;

        foreach (GameLocation location in locations)
        {
            string sourceId = location.NameOrUniqueName;
            if (!sourceIds.Contains(sourceId) || location.map is null)
                continue;

            List<NavigationVirtualConnectivityLeg> legs = new();
            foreach ((int stationX, int stationY, string networkId) in DiscoverMinecartStations(location))
            {
                if (!networks.TryGetValue(networkId, out MinecartNetworkData? network)
                    || network.Destinations is null
                    || !IsMinecartNetworkUnlocked(network, location))
                    continue;

                foreach (MinecartDestinationData? destination in network.Destinations)
                {
                    if (destination is null
                        || string.IsNullOrWhiteSpace(destination.Id)
                        || string.IsNullOrWhiteSpace(destination.TargetLocation)
                        || !sourceIds.Contains(destination.TargetLocation)
                        || !IsLocationAccessible(destination.TargetLocation)
                        || !IsMinecartDestinationAvailable(destination, location))
                        continue;

                    NavigationTransitionLeg transition = new(
                        destination.TargetLocation,
                        stationX,
                        stationY,
                        destination.TargetTile.X,
                        destination.TargetTile.Y,
                        IsDoor: false);
                    legs.Add(new NavigationVirtualConnectivityLeg(
                        transition,
                        sourceId,
                        "ride_minecart",
                        networkId,
                        destination.Id,
                        new NavigationConnectivityGate(
                            $"minecart:{networkId}:{destination.Id}",
                            true)));
                }
            }

            if (legs.Count > 0)
                result[sourceId] = legs;
        }

        return result;
    }

    private static IEnumerable<(int X, int Y, string NetworkId)> DiscoverMinecartStations(GameLocation location)
    {
        int width = location.map!.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
                if (action is null || !action.StartsWith("MinecartTransport", StringComparison.Ordinal))
                    continue;
                string[] parts = action.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                string networkId = parts.Length > 1 && !string.IsNullOrWhiteSpace(parts[1])
                    ? parts[1]
                    : "Default";
                yield return (x, y, networkId);
            }
        }
    }

    private static IReadOnlyDictionary<string, MinecartNetworkData>? TryLoadMinecartNetworks()
    {
        try
        {
            return DataLoader.Minecarts(Game1.content);
        }
        catch
        {
            return null;
        }
    }

    private static bool IsMinecartNetworkUnlocked(MinecartNetworkData network, GameLocation location)
    {
        if (string.IsNullOrWhiteSpace(network.UnlockCondition))
            return true;
        try
        {
            return GameStateQuery.CheckConditions(network.UnlockCondition, location);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsMinecartDestinationAvailable(MinecartDestinationData destination, GameLocation location)
    {
        if (string.IsNullOrWhiteSpace(destination.Condition))
            return true;
        try
        {
            return GameStateQuery.CheckConditions(destination.Condition, location);
        }
        catch
        {
            return false;
        }
    }

    internal static bool IsLocationAccessible(string locationName)
    {
        try
        {
            return Game1.isLocationAccessible(locationName);
        }
        catch
        {
            return false;
        }
    }

    private static bool InRange(int x, int y, int targetX, int targetY) =>
        SourceCoordinateInRange(x, y) && CoordinateInRange(targetX, targetY);

    /// <summary>
    /// A coordinate INSIDE a map. Arrival tiles are ordinary map cells, so the floor is zero.
    ///
    /// <para>
    /// Do not use this for a warp's SOURCE column: an edge exit triggers from `-1` (west or north), which is outside
    /// every map by construction - see <see cref="SourceCoordinateInRange"/>.
    /// </para>
    /// </summary>
    private static bool CoordinateInRange(int x, int y) =>
        FarmhandWarpCoordinateRange.IsPublishableDestination(x, y);

    /// <summary>
    /// A warp SOURCE coordinate, where `-1` is legal because it is the native engine's own encoding for an edge exit.
    ///
    /// <para>
    /// Walking off the west edge warps from `X = -1` and walking off the north edge from `Y = -1`; the tile is outside
    /// the grid because the trigger IS the boundary. Town's own map asset declares its exits that way: `-1 53 BusStop`,
    /// `79 -1 Mountain`, `-1 89 Forest`. MEASURED 2026-10-30 (`round9`): a guard that required both axes non-negative
    /// dropped every one of them, so Town's published `warps` contained Beach alone and `navigate_to_destination` to the
    /// Farm was a legal `destination_unreachable` - hit three times by a companion trying to get home.
    /// </para>
    /// <para>
    /// The range itself lives in <see cref="FarmhandWarpCoordinateRange"/> because execution acceptance and the
    /// snapshot publisher read the same fact; keeping a copy here is how the two spellings came to disagree.
    /// </para>
    /// </summary>
    private static bool SourceCoordinateInRange(int x, int y) =>
        FarmhandWarpCoordinateRange.IsPublishableSource(x, y);

    /// <summary>
    /// Every transition this location declares, before either consumer decides whether it may use it.
    ///
    /// <para>
    /// This is the ONE owner of "what counts as an edge". There used to be two: <see cref="CurrentView"/> enumerated
    /// location warps, the door table and the interior exits, while <see cref="TryCreateCurrentOrdinaryWarpTopology"/>
    /// enumerated location warps alone. Nothing forced the two to agree, so they did not: the topology answered
    /// `destination_unreachable` for transitions the view published. Adding the missing loops to the second function
    /// would have made a THIRD hand-written statement of the same fact, so the enumeration lives here and each caller
    /// projects the shape it needs.
    /// </para>
    /// <para>
    /// It yields raw facts and enforces only the rule that is identical for every consumer: an NPC-only warp moves no
    /// player, so it is not a player edge. The tile ranges each caller accepts, and whether it may use a door at all,
    /// belong to the projections - they genuinely differ, see <see cref="SourceCoordinateInRange"/> and the door
    /// exclusion in <see cref="TryCreateCurrentOrdinaryWarpTopology"/>.
    /// </para>
    /// </summary>
    private static IEnumerable<WorldEdge> EnumerateEdges(GameLocation location)
    {
        foreach (Warp warp in location.warps)
        {
            if (warp is null || warp.npcOnly.Value)
                continue;
            yield return new WorldEdge(warp.TargetName, warp.X, warp.Y, warp.TargetX, warp.TargetY, WorldEdgeFamily.Warp);
        }

        foreach ((Point point, string _) in location.doors.Pairs)
        {
            Warp? warp = ResolveDoorWarp(location, point);
            if (warp is null)
                continue;
            yield return new WorldEdge(warp.TargetName, point.X, point.Y, warp.TargetX, warp.TargetY, WorldEdgeFamily.Door);
        }

        // A farmhouse or cabin exit lives in the interior's warp table and in no door table, so it needs its own
        // family: it is the only way out of an interior.
        if (location is FarmHouse or Cabin)
        {
            foreach (Warp warp in location.warps.Where(candidate => !candidate.npcOnly.Value
                && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal)))
                yield return new WorldEdge(
                    warp.TargetName, warp.X, warp.Y, warp.TargetX, warp.TargetY, WorldEdgeFamily.InteriorExit);
        }
    }

    /// <summary>The native table a declared transition was read from.</summary>
    private enum WorldEdgeFamily
    {
        Warp,
        Door,
        InteriorExit,
    }

    /// <summary>One declared transition, before any consumer decides whether it may use it.</summary>
    private readonly record struct WorldEdge(
        string? TargetLocation,
        int SourceX,
        int SourceY,
        int TargetX,
        int TargetY,
        WorldEdgeFamily Family)
    {
        /// <summary>Whether this transition is a door rather than a walkable map warp - the one fact the two
        /// projections disagree about.</summary>
        internal bool IsDoor => this.Family != WorldEdgeFamily.Warp;
    }

    private static Warp? ResolveDoorWarp(GameLocation location, Point point)
    {
        Warp? warp = location.getWarpFromDoor(point, Game1.player);
        if (warp is not null) return warp;
        if (location is FarmHouse or Cabin)
            return location.warps.FirstOrDefault(candidate => !candidate.npcOnly.Value && candidate.X == point.X && candidate.Y == point.Y && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal));
        return null;
    }
}
