using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class BridgeSessionPublicationTests
{
    [Fact]
    public void Hello_PublishesReadOnlyWorldMapOperationWithoutEnablingExecution()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal)
        {
            "inspect_world_map",
            "move_to_tile",
        });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "publication_token_0123456789abcdef";
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            token,
            () => publication,
            () => "en-US");
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_publication_01",
            "hello_publication_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token));

        session.TryAuthenticate(1, hello, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reasonCode)
            .Should().BeTrue(reasonCode);
        acknowledgement.Should().NotBeNull();
        BridgeHelloAck payload = acknowledgement!.Payload;
        payload.Capabilities.Should().Contain("inspect_world_map");
        payload.EnabledActionIds.Should().Equal("move_to_tile");
        payload.Registrations.Should().ContainSingle(registration => registration.ActionId == "inspect_world_map")
            .Which.Kind.Should().Be("read_only");
    }
}
