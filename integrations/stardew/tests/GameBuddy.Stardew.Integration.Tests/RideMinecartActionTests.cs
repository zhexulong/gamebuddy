using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Handlers;
using Xunit;
namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The `ride_minecart` execution action.
///
/// Seam decision: native 1.6 minecart travel is data-driven, not a Warp object.
/// The player path is `performAction case "MinecartTransport"` ->
/// `ShowMineCartMenu` (a MENU) -> `MinecartWarp(destination)`, and
/// `MinecartWarp` (GameLocation.cs:10302) is public and UI-free: it ends in the
/// same `Game1.warpFarmer` the ordinary warp path uses. That is the seam.
///
/// <para>
/// Why a separate action rather than a `travel` objective family: both the Mod's
/// execution parser (`BridgeProtocol.TryDeserializeExecutionRequest` ->
/// `HasExactProperties`) and `FarmhandExecutionAcceptance.HasExactArgumentShape`
/// are exact-shape allow-lists, and `FarmhandActionArgument` has no optional
/// argument. `travel` therefore keeps `{x, y}` and `ride_minecart` declares
/// `{x, y, expectedTargetId}`, in which x,y is the minecart STATION tile.
/// </para>
///
/// The native ride itself, the ticket charge, and the before/after arrival
/// observation belong to the native-local fixture gate.
/// </summary>
public sealed class RideMinecartActionTests
{
    [Fact]
    public void Catalog_Travel_KeepsPlainXYAndRideMinecartDeclaresTheStationAndSelector()
    {
        FarmhandActionRegistration travel = FarmhandActionCatalog.Registrations
            .First(r => r.ActionId == "travel");
        travel.Descriptor!.Arguments.Select(a => a.Name).Should().Equal("x", "y");

        FarmhandActionRegistration? ride = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "ride_minecart");

        ride.Should().NotBeNull();
        ride!.FamilyId.Should().Be("transport_warps");
        ride.Kind.Should().Be(FarmhandOperationKind.Execution);
        ride.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);
        ride.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        ride.Descriptor.Should().NotBeNull();
        // Every declared argument is mandatory: there is no "plain" minecart form,
        // and the selector names one published ride from the station tile.
        ride.Descriptor!.Arguments.Select(a => a.Name)
            .Should().Equal("x", "y", "expectedTargetId");
        ride.Descriptor.Arguments.Select(a => a.Type)
            .Should().Equal("integer", "integer", "string");
        ride.Descriptor.Effect.Should().Be("write");
        ride.Descriptor.Postcondition.Should().Be("minecart_ride_completed");
    }

    [Fact]
    public void Router_RideMinecart_WhenWorldNotReady_RejectsWithoutTouchingTheMinecartPath()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "ride_minecart" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MovementActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_ride_minecart_1", "idemp_ride_minecart_1", "ride_minecart",
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

        // `ride_minecart` keeps the shared `activeTravel` ownership (so the single
        // Warped release still settles it), but the terminal vocabulary is its own:
        // travel_completed must stay with the ordinary warp, and travel must not
        // have grown a minecart branch.
        movement.Should().Contain("minecart_ride_completed");
        movement.Should().Contain("minecart_ride_postcondition_mismatch");
        StripLineComments(source).Should().NotContain("\"travel_completed\"");
        StripLineComments(movement).Should().NotContain("expectedTargetId = null");
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

        // Discovery is gated by ride_minecart's own capability and wired into the
        // snapshot: a `travel`-only surface must not advertise minecart rides.
        string discovery = File.ReadAllText(DiscoverySourcePath());
        discovery.Should().Contain("DiscoverMinecartTargets");
        discovery.Should().Contain("advertisedCapabilities.Contains(\"ride_minecart\", StringComparer.Ordinal) ? DiscoverMinecartTargets(player) : null");
    }

    [Fact]
    public void Protocol_AdmitsExactlyTheRideMinecartArgs_AndRejectsTheOptionalWarpForm()
    {
        // The Mod's execution parser is an exact-match allow-list. `ride_minecart`
        // declares all three arguments, so the missing-selector form that was
        // structurally impossible on `travel` is rejected here as a malformed
        // request instead of silently degrading to an ordinary warp.
        string[]? declared = BridgeProtocol.ExecutionArgumentProperties("ride_minecart");
        declared.Should().NotBeNull();
        declared.Should().BeEquivalentTo(new[] { "x", "y", "expectedTargetId" });

        BridgeProtocol.TryDeserializeExecutionRequest(
            RideEnvelope("minecart_0123456789abcdef"), out _, out _).Should().BeTrue();

        // A missing selector, a raw non-string selector, an extra key, and a travel
        // request that tries to carry the selector all stay rejected.
        BridgeProtocol.TryDeserializeExecutionRequest(RideEnvelope(null), out _, out _).Should().BeFalse();
        BridgeProtocol.TryDeserializeExecutionRequest(RideEnvelope(null, "expectedTargetId", "7"), out _, out _).Should().BeFalse();
        BridgeProtocol.TryDeserializeExecutionRequest(RideEnvelope("", "destination", "\"BusStop\""), out _, out _).Should().BeFalse();
        BridgeProtocol.TryDeserializeExecutionRequest(TravelEnvelope("minecart_0123456789abcdef"), out _, out _).Should().BeFalse();

        // travel keeps exactly its two-argument wire.
        BridgeProtocol.ExecutionArgumentProperties("travel")
            .Should().BeEquivalentTo(new[] { "x", "y" });
        BridgeProtocol.TryDeserializeExecutionRequest(TravelEnvelope(null), out _, out _).Should().BeTrue();
    }

    /// <summary>
    /// One serialized ride_minecart execution envelope.
    /// <paramref name="expectedTargetId"/> is the JSON value to write (or null to
    /// omit the key); <paramref name="key"/>/<paramref name="value"/> optionally
    /// inject one extra raw JSON property.
    /// </summary>
    private static string RideEnvelope(string? expectedTargetId, string? key = null, string? value = null) =>
        EnvelopeFor("ride_minecart", expectedTargetId, key, value);

    /// <summary>One serialized travel execution envelope, always without a selector.</summary>
    private static string TravelEnvelope(string? expectedTargetId, string? key = null, string? value = null) =>
        EnvelopeFor("travel", expectedTargetId, key, value);

    private static string EnvelopeFor(string action, string? expectedTargetId, string? key, string? value)
    {
        var request = new BridgeExecutionRequest(
            "req_minecart_args", "idem_minecart_args", action,
            new BridgeExecutionArgs { X = 10, Y = 10, ExpectedTargetId = expectedTargetId }, 1, 5000);
        var envelope = new BridgeEnvelope<BridgeExecutionRequest>(
            1, "msg_minecart_args", "corr_minecart_args", 1000L, SampleScopeForTravel(), "execution_request", request);
        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeTrue(reason);
        if (key is null) return json;

        // Round-trip through the text form so the injected property is exactly the
        // raw JSON a caller could put on the wire.
        System.Text.Json.Nodes.JsonNode node = System.Text.Json.Nodes.JsonNode.Parse(json)!;
        node["payload"]!["args"]![key] = System.Text.Json.Nodes.JsonNode.Parse(value!);
        return node.ToJsonString();
    }

    private static BridgeScope SampleScopeForTravel() => new("stardew", "save_01", "world_01", "player_01", "companion_01");

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
