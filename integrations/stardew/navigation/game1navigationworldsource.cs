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
                if (warp.X < 0 || warp.Y < 0 || warp.X > 1000 || warp.Y > 1000)
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

    private static bool IsLocationAccessible(string locationName)
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

    private static bool CoordinateInRange(int x, int y) =>
        x >= 0 && y >= 0 && x <= 1000 && y <= 1000;

    private static Warp? ResolveDoorWarp(GameLocation location, Point point)
    {
        Warp? warp = location.getWarpFromDoor(point, Game1.player);
        if (warp is not null) return warp;
        if (location is FarmHouse or Cabin)
            return location.warps.FirstOrDefault(candidate => !candidate.npcOnly.Value && candidate.X == point.X && candidate.Y == point.Y && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal));
        return null;
    }
}
