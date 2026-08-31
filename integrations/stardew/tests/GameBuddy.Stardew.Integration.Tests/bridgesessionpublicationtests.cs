using System.Text.Json;
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
        payload.RuntimeRole.Should().Be("unattested");
        payload.LaunchGeneration.Should().BeNull();

        BridgeProtocol.TrySerialize(acknowledgement, out string json, out string serializationReason)
            .Should().BeTrue(serializationReason);
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement serializedPayload = document.RootElement.GetProperty("payload");
        serializedPayload.EnumerateObject().Select(property => property.Name).Should().BeEquivalentTo(
            "sessionId",
            "capabilities",
            "catalogRevision",
            "enabledActionIds",
            "presentationLocale",
            "registrations",
            "runtimeRole",
            "launchGeneration");
        serializedPayload.GetProperty("launchGeneration").ValueKind.Should().Be(JsonValueKind.Null);

        string? snapshotOutputPath = Environment.GetEnvironmentVariable("GAMEBUDDY_SNAPSHOT_WIRE_OUTPUT");
        if (snapshotOutputPath is null)
            return;

        Path.IsPathFullyQualified(snapshotOutputPath).Should().BeTrue(
            "the Host parity test must own an absolute private output path");
        var observe = new BridgeEnvelope<BridgeObserveRequest>(
            BridgeProtocol.Version,
            "observe_publication_01",
            "observe_publication_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "observe_request",
            new BridgeObserveRequest());
        session.TryObserve(1, observe, out BridgeEnvelope<BridgeSnapshot>? snapshot, out string observeReason)
            .Should().BeTrue(observeReason);
        BridgeProtocol.TrySerialize(snapshot!, out string snapshotJson, out string snapshotSerializationReason)
            .Should().BeTrue(snapshotSerializationReason);
        using var stream = new FileStream(snapshotOutputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false));
        writer.Write(snapshotJson);
    }
}
