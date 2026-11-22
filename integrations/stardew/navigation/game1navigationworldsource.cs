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
            return new NavigationWorldView(false, null, null, 0, 0, false, Array.Empty<NavigationTransitionLeg>(), false, false, false, false);

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
        // ONE reading of "the player may act this frame", and the hold is described only when it says she may not.
        bool actionable = player!.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp;
        return new NavigationWorldView(
            true,
            actionable ? null : WorldModel.DescribeCurrentNavigationHold(player),
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

    /// <summary>
    /// The locations this location's OWN members name as transition targets, before any projection decides what may be
    /// walked. It is the population a reachability gate must use: taken from the projected legs instead, an edge the
    /// projection drops would silently shrink the set of places that have to be reachable, and the gate would pass by
    /// having watched nothing.
    /// </summary>
    internal static IReadOnlyList<string> DeclaredTransitionTargets(GameLocation location) =>
        EnumerateEdges(location)
            .Select(edge => edge.TargetLocation)
            .Where(target => !string.IsNullOrWhiteSpace(target))
            .Select(target => target!)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(target => target, StringComparer.Ordinal)
            .ToArray();

    /// <summary>
    /// The outgoing topology legs for ONE location: the same edges <see cref="CurrentView"/> publishes, put through the
    /// tile rules the topology requires. Split out of <see cref="TryCreateCurrentOrdinaryWarpTopology"/> so the rules that
    /// decide "is this a leg of the graph" are asserted against a real location instead of through a live save. It is
    /// TOTAL: a tile outside the publishable ranges is not a leg of this graph, and the enumeration never yields a
    /// transition without a target identity - the planner fail-closes if a synthetic topology carries one anyway.
    /// </summary>
    internal static NavigationTransitionLeg[] ProjectTopologyLegs(GameLocation location)
    {
        List<NavigationTransitionLeg> projected = new();
        foreach (WorldEdge edge in EnumerateEdges(location))
        {
            // A door is the ONLY way into an interior, so keeping the door families here is what makes the carpenter's,
            // Pierre's and the community centre destinations at all. The leg keeps `IsDoor`: the executor owns what
            // crossing a door MEANS (the game's own entry, not a bare warp).
            if (string.IsNullOrWhiteSpace(edge.TargetLocation))
                continue;
            if (!SourceCoordinateInRange(edge.SourceX, edge.SourceY))
                continue;
            if (!CoordinateInRange(edge.TargetX, edge.TargetY))
                continue;
            projected.Add(new NavigationTransitionLeg(
                edge.TargetLocation!, edge.SourceX, edge.SourceY, edge.TargetX, edge.TargetY, edge.IsDoor));
        }

        return projected.ToArray();
    }

    /// <summary>
    /// The DOOR legs of one location's own topology: the population a door-approach gate must examine, taken from the
    /// enumeration <see cref="EnumerateEdges"/> owns rather than from a list here. A door that stops being an edge
    /// leaves this set on its own, and a door the engine starts declaring appears in it without anyone editing a test.
    /// </summary>
    internal static IReadOnlyList<NavigationTransitionLeg> DoorLegs(GameLocation location) =>
        ProjectTopologyLegs(location).Where(leg => leg.IsDoor).ToArray();

    /// <summary>
    /// The legs of ONE loaded location a body could actually walk into: <see cref="ProjectTopologyLegs"/> without the
    /// exits whose own entry cell is a wall that stands for the whole run.
    ///
    /// <para>
    /// WHY AT BUILD TIME. The planner is an unweighted breadth-first search over map hops, so a two-hop route always beats
    /// a three-hop one - and `round89` measured what that means when the shorter one is not walkable: `Farm -> Backwoods
    /// -> Mountain` is two hops, the Backwoods' east exit is entered from the tile that map puts a Bush on
    /// (`entry_blocked_by:large:Bush@49,10`), so every navigation across the north of the valley walked to that wall and
    /// back while `Farm -> Backwoods -> BusStop -> Town -> Mountain` sat in the same topology unasked. An exit that can
    /// never be walked is not a route, and the graph is the layer that can say so once instead of once per navigation.
    /// </para>
    ///
    /// <para>
    /// ONLY AN EDGE EXIT IS EXAMINED, and only for an occupant no published action opens (<see cref="IsPermanentWall"/>).
    /// A DOOR is left alone on purpose: when the cell it faces is unusable the walk falls back to the ring around the door
    /// (<c>ExecutionManager.SelectSafeApproachTarget</c>), so a blocked facing cell there is a different fact and dropping
    /// the leg would make an interior unreachable. Everything transient - a villager, an animal, a chest, a boulder the
    /// pickaxe prices, a weed - stays in the graph for the same reason: which of them blocks TODAY is the walk's own
    /// question, and the executor re-plans around the answer it gets.
    /// </para>
    ///
    /// <para>
    /// The entry cell is <see cref="ExecutionManager.TransitionEntryCell"/>'s, derived from the source location and the
    /// transition's own data - the SAME cell the walk is aimed at and the refusal names, so the edge dropped here is the
    /// edge that walk would have refused.
    /// </para>
    /// </summary>
    internal static NavigationTransitionLeg[] TraversableTopologyLegs(GameLocation location)
    {
        List<NavigationTransitionLeg> legs = new();
        foreach (NavigationTransitionLeg leg in ProjectTopologyLegs(location))
        {
            if (leg.IsDoor
                || ExecutionManager.TransitionEntryCell(location, leg) is not { } entry
                || !IsPermanentWall(StardewBodyController.DescribeTargetOccupant(location, entry)))
            {
                legs.Add(leg);
            }
        }

        return legs.ToArray();
    }

    /// <summary>
    /// Whether what stands on one cell stands there for the whole run: the map's own two tile layers, a building
    /// footprint, or a large terrain feature - a Bush, the one occupant that blocks a body and that no priced tool removes
    /// (<see cref="StardewBodyController.OccupantAt"/> names it and prices it at nothing).
    ///
    /// <para>
    /// Grass, tilled soil and crops are where standing happens; a resource clump may be a boulder the pickaxe opens; an
    /// object may be litter an action clears or something the player lifts. None of them deletes a route from the graph:
    /// the walk decides those, and the executor re-plans when it refuses.
    /// </para>
    /// </summary>
    private static bool IsPermanentWall(RefusalLayerToken occupant) =>
        occupant.Layer is RefusalLayerKind.BackTile
            or RefusalLayerKind.BuildingsTile
            or RefusalLayerKind.Large
            or RefusalLayerKind.Building;

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

            sources.Add(new NavigationOrdinaryWarpLegs(sourceId, TraversableTopologyLegs(location)));
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
    /// A DOOR IS AN EDGE. It is the way a location is entered - an interior has no inbound warp at all, so a graph built
    /// from warps alone answers that the carpenter's or Pierre's cannot be reached, which is a statement about the graph
    /// and not about the game. The three families below are the three tables the game itself reads to move a player
    /// through a door: the door table `updateDoors` builds, each building's human door, and the location's warp list
    /// - the same three, in the same order, as the published `doorTargets` family
    /// (<c>ExecutionManager.DiscoverDoorTargets</c>), because one tile can be both a gated door and a plain warp and the
    /// gated one is the tile the native click entry knows.
    /// </para>
    /// <para>
    /// It yields raw facts and enforces only the rules that are identical for every consumer: an NPC-only warp moves no
    /// player, so it is not a player edge, and one tile is one transition (the earliest table owns the row, as in the
    /// published family). The tile ranges each caller accepts belong to the projections - see
    /// <see cref="SourceCoordinateInRange"/>.
    /// </para>
    /// </summary>
    private static IEnumerable<WorldEdge> EnumerateEdges(GameLocation location)
    {
        HashSet<(int X, int Y)> claimed = new();

        foreach ((Point point, string _) in location.doors.Pairs)
        {
            Warp? warp = ResolveDoorWarp(location, point);
            if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName))
                continue;
            claimed.Add((point.X, point.Y));
            yield return new WorldEdge(warp.TargetName, point.X, point.Y, warp.TargetX, warp.TargetY, WorldEdgeFamily.Door);
        }

        // `location.doors` holds only what a map DREW (`updateDoors`, GameLocation.cs:17586-17641), so a shed's, barn's,
        // coop's or greenhouse's entrance is in no door table at all: it is its building's human door, and the resolver
        // answers it with the interior's own entry tile (GameLocation.cs:2196-2206).
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (!building.HasIndoors())
                continue;
            Point point = building.getPointForHumanDoor();
            if (!claimed.Add((point.X, point.Y)))
                continue;
            Warp? warp = ResolveDoorWarp(location, point);
            if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName))
                continue;
            yield return new WorldEdge(warp.TargetName, point.X, point.Y, warp.TargetX, warp.TargetY, WorldEdgeFamily.Door);
        }

        foreach (Warp warp in location.warps)
        {
            if (warp is null || warp.npcOnly.Value || string.IsNullOrWhiteSpace(warp.TargetName))
                continue;
            if (!claimed.Add((warp.X, warp.Y)))
                continue;
            // A farmhouse or cabin exit lives in the interior's warp table and in no door table. It stays its own family
            // because the view admits it without the range test the other two families take.
            bool interiorExit = location is FarmHouse or Cabin
                && string.Equals(warp.TargetName, "Farm", StringComparison.Ordinal);
            yield return new WorldEdge(warp.TargetName, warp.X, warp.Y, warp.TargetX, warp.TargetY,
                interiorExit ? WorldEdgeFamily.InteriorExit : WorldEdgeFamily.Warp);
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
        /// <summary>Whether this transition is entered through the game's own door entry rather than walked as a bare
        /// map warp - the fact the walker needs, because a door's gates live above the resolver.</summary>
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
