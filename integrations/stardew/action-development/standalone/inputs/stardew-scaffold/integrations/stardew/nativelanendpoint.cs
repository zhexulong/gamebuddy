using System.Globalization;
using System.Reflection;
using StardewValley;
using StardewValley.Network;

namespace GameBuddy.Stardew;

/// <summary>Reads the exact running native LAN socket selected by Stardew Valley.</summary>
internal static class NativeLanEndpoint
{
    private const string LoopbackHost = "127.0.0.1";
    private const string NetServerTypeName = "Lidgren.Network.NetServer";
    private const string NetPeerTypeName = "Lidgren.Network.NetPeer";
    private const string NetPeerStatusTypeName = "Lidgren.Network.NetPeerStatus";

    private static readonly FieldInfo? GameServersField = typeof(GameServer).GetField(
        "servers",
        BindingFlags.Instance | BindingFlags.NonPublic);
    private static readonly FieldInfo? LidgrenNetServerField = typeof(LidgrenServer).GetField(
        "server",
        BindingFlags.Instance | BindingFlags.Public);
    private static readonly PropertyInfo? NetPeerPortProperty = LidgrenNetServerField?.FieldType.GetProperty(
        "Port",
        BindingFlags.Instance | BindingFlags.Public);
    private static readonly PropertyInfo? NetPeerStatusProperty = LidgrenNetServerField?.FieldType.GetProperty(
        "Status",
        BindingFlags.Instance | BindingFlags.Public);

    internal static bool TryRead(out string endpoint)
    {
        endpoint = string.Empty;
        return Game1.server is GameServer gameServer
            && TryReadFromGameServer(gameServer, out endpoint);
    }

    private static bool TryReadFromGameServer(object gameServer, out string endpoint)
    {
        endpoint = string.Empty;
        if (!HasExactTargetSurface()
            || gameServer.GetType() != typeof(GameServer)
            || GameServersField!.GetValue(gameServer) is not List<Server> servers)
        {
            return false;
        }

        LidgrenServer? lidgrenServer = null;
        foreach (Server? server in servers)
        {
            if (server is null)
                return false;
            if (server is not LidgrenServer candidate)
                continue;
            if (lidgrenServer is not null)
                return false;
            lidgrenServer = candidate;
        }

        object? netServer = lidgrenServer is null ? null : LidgrenNetServerField!.GetValue(lidgrenServer);
        if (netServer is null
            || netServer.GetType() != LidgrenNetServerField!.FieldType
            || NetPeerPortProperty!.GetValue(netServer) is not int port
            || NetPeerStatusProperty!.GetValue(netServer) is not object status
            || status.GetType().FullName != NetPeerStatusTypeName
            || !string.Equals(status.ToString(), "Running", StringComparison.Ordinal)
            || port is < 1 or > 65535)
        {
            return false;
        }

        endpoint = $"{LoopbackHost}:{port.ToString(CultureInfo.InvariantCulture)}";
        return true;
    }

    private static bool HasExactTargetSurface() =>
        GameServersField?.FieldType == typeof(List<Server>)
        && LidgrenNetServerField?.FieldType.FullName == NetServerTypeName
        && NetPeerPortProperty?.DeclaringType?.FullName == NetPeerTypeName
        && NetPeerPortProperty.PropertyType == typeof(int)
        && NetPeerStatusProperty?.DeclaringType?.FullName == NetPeerTypeName
        && NetPeerStatusProperty.PropertyType.FullName == NetPeerStatusTypeName;
}
