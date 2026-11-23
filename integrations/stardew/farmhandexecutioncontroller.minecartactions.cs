using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using StardewValley.GameData.Minecarts;
using StardewValley.TokenizableStrings;

namespace GameBuddy.Stardew;

// Native minecart ride for the `ride_minecart` action.
//
// Native 1.6 minecart travel is data-driven, not a Warp object:
//
//   performAction case "MinecartTransport"   (GameLocation.cs:9790-9796)
//     -> ShowMineCartMenu(networkId, exclude) (GameLocation.cs:10214, a MENU)
//         - GameStateQuery.CheckConditions(network.UnlockCondition, location)
//         - per destination: GameStateQuery.CheckConditions(destination.Condition, location)
//         - Price > 0 -> ticket question dialogue -> who.Money -= Price
//     -> MinecartWarp(destination)            (GameLocation.cs:10302, public, NO UI)
//         -> Game1.warpFarmer(location, tileX, tileY, facing)
//
// The player path opens a menu; the ride itself is the public, UI-free
// `MinecartWarp`. The Mod performs only that ride plus the game's own condition
// queries, so no menu, ticket dialogue or second warp path is introduced.
//
// Why this is its own action: both the Mod's execution parser
// (BridgeProtocol.TryDeserializeExecutionRequest) and FarmhandExecutionAcceptance
// are exact-shape allow-lists, and FarmhandActionArgument has no
// optional-argument concept. A minecart ride therefore cannot be expressed as an
// extra optional key on `travel` ({x,y}); it is `ride_minecart`
// ({x,y,expectedTargetId}) where x,y is the minecart STATION tile. Verified live
// on the target version: the optional-key form was rejected at the parser as
// navigation_execution_parse_rejected and at acceptance as
// bridge_rejected:invalid_execution_request.
//
// Destination choice stays with the companion: one station tile can offer many
// destinations, so discovery publishes one entry per (station, destination) and
// the accepted ride must match the exact published TargetId. The Mod never
// picks a destination for the player.
internal sealed partial class ExecutionManager
{
    internal const int MinecartTargetDiscoveryRadius = 12;

    internal static IReadOnlyDictionary<string, MinecartNetworkData>? TryLoadMinecartNetworks()
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

    internal static bool IsMinecartNetworkUnlocked(MinecartNetworkData network, StardewValley.GameLocation location)
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

    internal static bool IsMinecartDestinationAvailable(MinecartDestinationData destination, StardewValley.GameLocation location)
    {
        if (string.IsNullOrWhiteSpace(destination.TargetLocation) || string.IsNullOrWhiteSpace(destination.Id))
            return false;
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

    internal static BridgeMinecartTarget BuildMinecartTarget(
        string networkId, MinecartDestinationData destination, int stationX, int stationY)
    {
        string displayName = ParseMinecartDisplayName(destination);
        return new BridgeMinecartTarget(
            BuildMinecartTargetId(networkId, destination.Id, stationX, stationY),
            networkId,
            destination.Id,
            displayName,
            destination.Price,
            stationX,
            stationY,
            destination.TargetLocation,
            destination.TargetTile.X,
            destination.TargetTile.Y);
    }

    private static string ParseMinecartDisplayName(MinecartDestinationData destination)
    {
        string? parsed = null;
        try
        {
            parsed = TokenParser.ParseText(destination.DisplayName);
        }
        catch
        {
        }
        string text = string.IsNullOrWhiteSpace(parsed) ? destination.DisplayName : parsed;
        if (string.IsNullOrWhiteSpace(text))
            text = destination.TargetLocation;
        return text.Length <= 128 ? text : text[..128];
    }

    private static string BuildMinecartTargetId(string networkId, string destinationId, int stationX, int stationY)
    {
        string raw = $"minecart:{networkId}:{destinationId}:{stationX},{stationY}";
        return $"minecart_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static MinecartRideResolution ResolveMinecartRide(
        StardewValley.GameLocation location, int stationX, int stationY, string expectedTargetId)
    {
        if (location.map is null)
            return MinecartRideResolution.Reject("minecart_station_unavailable");

        string? action = location.doesTileHaveProperty(stationX, stationY, "Action", "Buildings");
        if (action is null || !action.StartsWith("MinecartTransport", StringComparison.Ordinal))
            return MinecartRideResolution.Reject("minecart_station_unavailable");

        string[] parts = action.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        string networkId = parts.Length > 1 && !string.IsNullOrWhiteSpace(parts[1]) ? parts[1] : "Default";

        IReadOnlyDictionary<string, MinecartNetworkData>? networks = TryLoadMinecartNetworks();
        if (networks is null || !networks.TryGetValue(networkId, out MinecartNetworkData? network))
            return MinecartRideResolution.Reject("minecart_network_unknown");
        if (!IsMinecartNetworkUnlocked(network, location))
            return MinecartRideResolution.Reject("minecart_network_locked");
        if (network.Destinations is null)
            return MinecartRideResolution.Reject("minecart_network_unknown");

        foreach (MinecartDestinationData destination in network.Destinations)
        {
            if (destination is null || string.IsNullOrWhiteSpace(destination.Id))
                continue;
            if (!string.Equals(
                    BuildMinecartTargetId(networkId, destination.Id, stationX, stationY),
                    expectedTargetId,
                    StringComparison.Ordinal))
                continue;
            if (!IsMinecartDestinationAvailable(destination, location))
                return MinecartRideResolution.Reject("minecart_destination_unavailable");
            return MinecartRideResolution.Accept(networkId, destination);
        }

        return MinecartRideResolution.Reject("minecart_target_changed");
    }

    private sealed record MinecartRideResolution(
        bool Accepted,
        string ReasonCode,
        string NetworkId,
        MinecartDestinationData? Destination)
    {
        internal static MinecartRideResolution Accept(string networkId, MinecartDestinationData destination) =>
            new(true, "accepted", networkId, destination);

        internal static MinecartRideResolution Reject(string reasonCode) =>
            new(false, reasonCode, string.Empty, null);
    }

    private static int RideMinecart(MinecartDestinationData destination, string networkId, Farmer player)
    {
        int price = Math.Max(0, destination.Price);
        if (price > 0)
        {
            if (player.Money < price)
                return -1;
            player.Money -= price;
        }
        GameLocation? origin = player.currentLocation;
        origin?.MinecartWarp(destination);
        return price;
    }

    private static string FormatMinecartEvidence(string networkId, MinecartDestinationData destination) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"network={networkId};destination={destination.Id};price={Math.Max(0, destination.Price)}");
}
