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
        foreach (Warp warp in location!.warps)
        {
            if (warp.npcOnly.Value || string.IsNullOrWhiteSpace(warp.TargetName)
                || !InRange(warp.X, warp.Y, warp.TargetX, warp.TargetY))
                continue;
            legs.Add(new NavigationTransitionLeg(warp.TargetName, warp.X, warp.Y, warp.TargetX, warp.TargetY, false));
        }
        foreach ((Point point, string _) in location.doors.Pairs)
        {
            Warp? warp = ResolveDoorWarp(location, point);
            if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName) || !InRange(point.X, point.Y, warp.TargetX, warp.TargetY))
                continue;
            legs.Add(new NavigationTransitionLeg(warp.TargetName, point.X, point.Y, warp.TargetX, warp.TargetY, true));
        }
        if (location is FarmHouse or Cabin)
        {
            foreach (Warp warp in location.warps.Where(candidate => !candidate.npcOnly.Value && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal)))
                legs.Add(new NavigationTransitionLeg(warp.TargetName, warp.X, warp.Y, warp.TargetX, warp.TargetY, true));
        }

        string? current = location.NameOrUniqueName;
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
            foreach (Warp warp in location.warps)
            {
                if (warp is null || warp.npcOnly.Value)
                    continue;
                if (string.IsNullOrWhiteSpace(warp.TargetName))
                {
                    reasonCode = "ordinary_warp_target_identity_invalid";
                    return false;
                }
                // A SOURCE coordinate may be NEGATIVE, and that is the native engine's own encoding for an edge exit.
                //
                // In a Stardew map, walking off the west edge warps from `X = -1` and walking off the north edge warps
                // from `Y = -1`; the tile is outside the grid because the trigger IS the boundary. Town's own map asset
                // declares its exits that way: `-1 53 BusStop 42 23`, `-1 54 BusStop 42 23`, `-1 55 BusStop 42 23`,
                // `79 -1 Mountain 15 40`, `80 -1 Mountain 15 40`, `-1 89 Forest 118 25`, `-1 90 Forest 118 25`. Only the
                // south Beach warps (`53 110 Beach 38 0`) are non-negative.
                //
                // MEASURED 2026-10-30 (`round9`): this guard dropped every negative-axis exit, so Town's published
                // `warps` contained Beach alone, the topology gave Town one outgoing edge, and `navigate_to_destination`
                // to the Farm was a legal `destination_unreachable` - which the companion then hit three times trying to
                // get home. The destination still has to be inside a real map, so `TargetX`/`TargetY` keep the strict
                // check below.
                if (warp.X < -1 || warp.Y < -1 || warp.X > MaximumTileCoordinate || warp.Y > MaximumTileCoordinate)
                    continue;
                if (!CoordinateInRange(warp.TargetX, warp.TargetY))
                    continue;
                legs.Add(new NavigationTransitionLeg(warp.TargetName, warp.X, warp.Y, warp.TargetX, warp.TargetY, false));
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
        CoordinateInRange(x, y) && CoordinateInRange(targetX, targetY);

    /// <summary>
    /// A coordinate INSIDE a map. Arrival tiles are ordinary map cells, so the floor is zero.
    ///
    /// <para>
    /// Do not use this for a warp's SOURCE column: an edge exit triggers from `-1` (west or north), which is outside
    /// every map by construction - see `DiscoverWarps` for the map asset that spells its exits that way.
    /// </para>
    /// </summary>
    private static bool CoordinateInRange(int x, int y) =>
        x >= 0 && y >= 0 && x <= MaximumTileCoordinate && y <= MaximumTileCoordinate;

    /// <summary>
    /// The largest legal tile index any coordinate may carry, source or destination. One bound for both checks, so a
    /// later reader cannot tighten one of them and leave the other.
    /// </summary>
    private const int MaximumTileCoordinate = 1000;

    private static Warp? ResolveDoorWarp(GameLocation location, Point point)
    {
        Warp? warp = location.getWarpFromDoor(point, Game1.player);
        if (warp is not null) return warp;
        if (location is FarmHouse or Cabin)
            return location.warps.FirstOrDefault(candidate => !candidate.npcOnly.Value && candidate.X == point.X && candidate.Y == point.Y && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal));
        return null;
    }
}
