using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NavigationReadOnlySessionTests
{
    [Fact]
    public void NavigationRead_RequiresLiveReadOnlyPublication_AndNeverCreatesAnExecutionReceipt()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "inspect_world_map" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var session = new BridgeSession(
            executions,
            new FarmhandActionRouter(),
            scope,
            "navigation_token_0123456789abcdef",
            () => publication,
            () => "en-US",
            () => new DerivedDestinationSet("generation_01", new NavigationSourceNode(
                "root", null, null, null,
                new[] { new NavigationSourceNode("farm", "Farm", new NavigationDestination("stardew", "Farm", "Farm", null), null, Array.Empty<NavigationSourceNode>()) })),
            runtimeAttestation: BridgeRuntimeAttestation.Default);
        Authenticate(session, scope);

        session.TryNavigationRead(1, Request(scope), out BridgeEnvelope<BridgeNavigationReadResult>? response, out string reason)
            .Should().BeTrue(reason);
        reason.Should().Be("accepted");
        response!.Type.Should().Be("navigation_read_result");
        response.Payload.Status.Should().Be("succeeded");
        response.Payload.Entries.Should().ContainSingle().Which.Label.Should().Be("Farm");
        executions.TryGetReceipt("navigation_read_request_01", out _).Should().BeFalse();

        publication = publication.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        session.TryNavigationRead(1, Request(scope), out _, out reason).Should().BeFalse();
        reason.Should().Be("operation_not_available");
        executions.TryGetReceipt("navigation_read_request_01", out _).Should().BeFalse();
    }

    [Fact]
    public void NavigationRead_RejectsWrongGenerationWithoutProjection()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "inspect_world_map" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            "navigation_token_0123456789abcdef",
            () => publication,
            () => "en-US",
            () => new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>())),
            runtimeAttestation: BridgeRuntimeAttestation.Default);
        Authenticate(session, scope);

        session.TryNavigationRead(2, Request(scope), out _, out string reason).Should().BeFalse();
        reason.Should().Be("unauthenticated");
    }

    private static void Authenticate(BridgeSession session, BridgeScope scope)
    {
        session.TryAuthenticate(1, new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version, "navigation_hello_01", "navigation_hello_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello",
            new BridgeHello("navigation_token_0123456789abcdef")), out _, out string reason).Should().BeTrue(reason);
    }

    private static BridgeEnvelope<BridgeNavigationReadRequest> Request(BridgeScope scope) => new(
        BridgeProtocol.Version, "navigation_read_request_01", "navigation_read_correlation_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope,
        "navigation_read_request", new BridgeNavigationReadRequest("inspect_world_map", new BridgeNavigationReadArgs()));
}
