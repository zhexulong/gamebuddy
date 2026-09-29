using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// travel's minecart objective family.
///
/// Seam decision: native 1.6 minecart travel is data-driven, not a Warp object.
/// The player path is `performAction case "MinecartTransport"` ->
/// `ShowMineCartMenu` (a MENU) -> `MinecartWarp(destination)`, and
/// `MinecartWarp` (GameLocation.cs:10302) is public and UI-free: it ends in the
/// same `Game1.warpFarmer` the ordinary warp path uses. That is the seam.
///
/// <para>
/// This pins the structural contract: `travel` keeps its `{x, y}` wire and adds
/// only the optional `expectedTargetId` selector, discovery publishes one entry
/// per (station tile, destination) under a `minecart_` opaque ID, and the grown
/// objective is still terminated by the single `travel_completed` Warped
/// postcondition.
/// </para>
///
/// The native ride itself, the ticket charge, and the before/after arrival
/// observation belong to the native-local fixture gate.
/// </summary>
public sealed class MinecartTravelActionTests
{
    [Fact]
    public void Catalog_Travel_KeepsXYAndAddsOnlyTheOptionalMinecartSelector()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "travel");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("transport_warps");
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);
        reg.Descriptor.Should().NotBeNull();
        // The wire is unchanged: the minecart choice rides the existing optional
        // selector rather than a new action or a new required argument.
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().Equal("x", "y");
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_Travel_WhenWorldNotReady_RejectsWithoutTouchingTheMinecartPath()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "travel" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MovementActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_minecart_travel_1", "idemp_minecart_travel_1", "travel",
            new BridgeExecutionArgs { X = 10, Y = 10, ExpectedTargetId = "minecart_0123456789abcdef" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Handler_OwnsOnlyTheMinecartReasonCodes_AndRoutesThroughTheNativeRide()
    {
        string source = File.ReadAllText(NativeActionSourcePath());
        // The rejection codes split across the owned partials: the station-range and
        // affordability checks run in the movement request, the data/condition
        // checks in the minecart resolution.
        string movement = File.ReadAllText(MovementActionSourcePath());
        string codeUnion = source + "\n" + movement;

        // This action's own rejections. A stale or unknown selector must not fall
        // back to a plain warp, so the change/staleness code is explicit.
        foreach (string code in new[]
        {
            "minecart_station_unavailable",
            "minecart_station_out_of_range",
            "minecart_network_unknown",
            "minecart_network_locked",
            "minecart_destination_unavailable",
            "minecart_target_changed",
            "minecart_ticket_unaffordable",
        })
        {
            codeUnion.Should().Contain($"\"{code}\"");
        }

        // The ride must go through the single public native terminal, not through
        // a second warp path or a menu. `warpFarmer` is reached by MinecartWarp.
        source.Should().Contain("MinecartWarp(");

        // The native unlock and per-destination availability are the game's own
        // queries, not a re-implementation.
        source.Should().Contain("GameStateQuery.CheckConditions(network.UnlockCondition");
        source.Should().Contain("GameStateQuery.CheckConditions(destination.Condition");

        // Travel still has exactly one terminal postcondition, shared with the
        // ordinary warp path: the minecart partial must not mint its own terminal.
        // Assert against CODE only — the header comment legitimately names the
        // shared terminal while explaining the reuse.
        movement.Should().Contain("travel_completed");
        StripLineComments(source).Should().NotContain("\"travel_completed\"");
    }

    [Fact]
    public void Discovery_AdvertisesOneEntryPerStationAndDestination()
    {
        string source = File.ReadAllText(NativeActionSourcePath());

        // The station is found from the map's own Action property, and the network
        // ID is its first argument exactly as performAction reads it.
        source.Should().Contain("location.doesTileHaveProperty(x, y, \"Action\", \"Buildings\")");
        source.Should().Contain("\"MinecartTransport\"");
        source.Should().Contain("DataLoader.Minecarts(Game1.content)");

        // The station tile is part of the opaque identity: one destination may be
        // offered by several stations on the same map.
        source.Should().Contain("private static string BuildMinecartTargetId(string networkId, string destinationId, int stationX, int stationY)");
        source.Should().Contain("$\"minecart_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}\"");
        source.Should().Contain("$\"minecart:{networkId}:{destinationId}:{stationX},{stationY}\"");

        // Discovery is gated by the travel capability and wired into the snapshot.
        string discovery = File.ReadAllText(DiscoverySourcePath());
        discovery.Should().Contain("DiscoverMinecartTargets");
        discovery.Should().Contain("advertisedCapabilities.Contains(\"travel\", StringComparer.Ordinal) ? DiscoverMinecartTargets(player) : null");
    }

    private static string NativeActionSourcePath() => RepositorySourcePath(Path.Combine(
        "integrations", "stardew", "farmhandexecutioncontroller.minecartactions.cs"));

    /// <summary>Drop <c>//</c> line comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    private static string MovementActionSourcePath() => RepositorySourcePath(Path.Combine(
        "integrations", "stardew", "farmhandexecutioncontroller.movementactions.cs"));

    private static string DiscoverySourcePath() => RepositorySourcePath(Path.Combine(
        "integrations", "stardew", "farmhandexecutioncontroller.cs"));

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
