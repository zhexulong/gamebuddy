using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
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
        // the currently loaded subgraph. Keep only loaded endpoints; the planner
        // will fail closed when the accepted destination is not reachable.
        NavigationOrdinaryWarpLegs[] filteredSources = sources
            .Select(source => new NavigationOrdinaryWarpLegs(
                source.SourceId,
                source.OutgoingOrdinaryLegs.Where(leg => sourceIds.Contains(leg.TargetLocation)).ToArray()))
            .ToArray();

        topology = new NavigationOrdinaryWarpTopology(currentSource, filteredSources);
        reasonCode = "accepted";
        return true;
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
