using System.Reflection;
using System.Runtime.CompilerServices;
using FluentAssertions;
using GameBuddy.Stardew;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NativeLanEndpointTargetSurfaceTests
{
    [Fact]
    public void TargetSurface_UsesExactGameServerListAndLidgrenMembers()
    {
        FieldInfo servers = typeof(GameServer).GetField("servers", BindingFlags.Instance | BindingFlags.NonPublic)!;
        FieldInfo nativeServer = typeof(LidgrenServer).GetField("server", BindingFlags.Instance | BindingFlags.Public)!;
        PropertyInfo port = nativeServer.FieldType.GetProperty("Port", BindingFlags.Instance | BindingFlags.Public)!;
        PropertyInfo status = nativeServer.FieldType.GetProperty("Status", BindingFlags.Instance | BindingFlags.Public)!;

        servers.FieldType.Should().Be(typeof(List<>).MakeGenericType(typeof(Server)));
        nativeServer.FieldType.FullName.Should().Be("Lidgren.Network.NetServer");
        port.DeclaringType!.FullName.Should().Be("Lidgren.Network.NetPeer");
        port.PropertyType.Should().Be(typeof(int));
        status.DeclaringType!.FullName.Should().Be("Lidgren.Network.NetPeer");
        status.PropertyType.FullName.Should().Be("Lidgren.Network.NetPeerStatus");
    }

    [Fact]
    public void Reader_WithoutNativeServer_FailsClosed()
    {
        InvokeReader(RuntimeHelpers.GetUninitializedObject(typeof(GameServer)), out string endpoint).Should().BeFalse();
        endpoint.Should().BeEmpty();
    }

    [Fact]
    public void Reader_RejectsAmbiguousMultipleLidgrenServers()
    {
        object gameServer = RuntimeHelpers.GetUninitializedObject(typeof(GameServer));
        FieldInfo servers = typeof(GameServer).GetField("servers", BindingFlags.Instance | BindingFlags.NonPublic)!;
        FieldInfo nativeServer = typeof(LidgrenServer).GetField("server", BindingFlags.Instance | BindingFlags.Public)!;
        object peer = RuntimeHelpers.GetUninitializedObject(nativeServer.FieldType);
        object first = RuntimeHelpers.GetUninitializedObject(typeof(LidgrenServer));
        object second = RuntimeHelpers.GetUninitializedObject(typeof(LidgrenServer));
        nativeServer.SetValue(first, peer);
        nativeServer.SetValue(second, peer);
        servers.SetValue(gameServer, new List<Server> { (Server)first, (Server)second });

        InvokeReader(gameServer, out string endpoint).Should().BeFalse();
        endpoint.Should().BeEmpty();
    }

    [Fact]
    public void Reader_RejectsNonRunningOrInvalidPortWithoutStartingServer()
    {
        object gameServer = RuntimeHelpers.GetUninitializedObject(typeof(GameServer));
        FieldInfo servers = typeof(GameServer).GetField("servers", BindingFlags.Instance | BindingFlags.NonPublic)!;
        FieldInfo nativeServer = typeof(LidgrenServer).GetField("server", BindingFlags.Instance | BindingFlags.Public)!;
        object peer = RuntimeHelpers.GetUninitializedObject(nativeServer.FieldType);
        object lidgren = RuntimeHelpers.GetUninitializedObject(typeof(LidgrenServer));
        nativeServer.SetValue(lidgren, peer);
        servers.SetValue(gameServer, new List<Server> { (Server)lidgren });

        SetPeerState(peer, "Running", 24642);
        InvokeReader(gameServer, out string endpoint).Should().BeTrue();
        endpoint.Should().Be("127.0.0.1:24642");

        SetPeerState(peer, "Running", 0);
        InvokeReader(gameServer, out endpoint).Should().BeFalse();
        endpoint.Should().BeEmpty();

        SetPeerState(peer, "NotRunning", 24642);
        InvokeReader(gameServer, out endpoint).Should().BeFalse();
        endpoint.Should().BeEmpty();
    }

    private static bool InvokeReader(object gameServer, out string endpoint)
    {
        MethodInfo method = typeof(NativeLanEndpoint).GetMethod(
            "TryReadFromGameServer",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        object?[] arguments = { gameServer, string.Empty };
        bool result = (bool)method.Invoke(null, arguments)!;
        endpoint = (string)arguments[1]!;
        return result;
    }

    private static void SetPeerState(object peer, string statusName, int port)
    {
        Type peerType = peer.GetType().BaseType!;
        peerType.GetField("m_listenPort", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(peer, port);
        Type statusType = peerType.Assembly.GetType("Lidgren.Network.NetPeerStatus")!;
        peerType.GetField("m_status", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(peer, Enum.Parse(statusType, statusName));
    }
}
