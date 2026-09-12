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
        payload.CatalogRevision.Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
        payload.PolicyIdentity.Value.Should().Be(publication.PolicyIdentity.Value);
        payload.PolicyIdentity.CapabilityRevision.Should().Be(publication.CapabilityRevision);
        payload.PolicyIdentity.CapabilityRevision.Should().BePositive();
         payload.Registrations.Should().ContainSingle(registration => registration.ActionId == "inspect_world_map")
             .Which.Kind.Should().Be("read_only");
         FarmhandActionRegistrationWire pickupForage = payload.Registrations.Single(registration => registration.ActionId == "pickup_forage");
         pickupForage.Descriptor.Should().NotBeNull();
         pickupForage.Descriptor!.Arguments.Select(argument => argument.Name)
             .Should().Equal("x", "y", "expectedQualifiedItemId", "expectedTargetId");
         pickupForage.Descriptor.SceneTarget.Should().BeEquivalentTo(
             new FarmhandActionObservationBindingDescriptorWire("ObservationBinding", 1, true, new[] { "observationId", "ref" }));
         pickupForage.Descriptor.Effect.Should().Be("write");
         pickupForage.Descriptor.Postcondition.Name.Should().Be("native_action_postcondition");
         payload.RuntimeRole.Should().Be("unattested");
        payload.LaunchGeneration.Should().BeNull();

        FarmhandCapabilityPublication successor = publication.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        successor.Should().NotBeSameAs(publication);
        successor.CapabilitySet.AdvertisedCapabilityIds.Should().NotContain("move_to_tile");
        successor.CapabilityRevision.Should().BeGreaterThan(publication.CapabilityRevision);
        successor.PolicyIdentity.Value.Should().NotBe(publication.PolicyIdentity.Value);
        publication = successor;
        session.TryCreateCatalogUpdate(1, 1, "catalog_publication_02", out string catalogUpdateJson)
            .Should().BeTrue();
        using (JsonDocument catalogUpdateDocument = JsonDocument.Parse(catalogUpdateJson))
        {
            JsonElement updatePayload = catalogUpdateDocument.RootElement.GetProperty("payload");
            updatePayload.GetProperty("catalogRevision").GetInt64().Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
            updatePayload.GetProperty("policyIdentity").GetProperty("capabilityRevision").GetInt64().Should().Be(successor.CapabilityRevision);
            updatePayload.GetProperty("policyIdentity").GetProperty("value").GetString().Should().Be(successor.PolicyIdentity.Value);
        }

         BridgeProtocol.TrySerialize(acknowledgement, out string json, out string serializationReason)
            .Should().BeTrue(serializationReason);
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement serializedPayload = document.RootElement.GetProperty("payload");
        serializedPayload.EnumerateObject().Select(property => property.Name).Should().BeEquivalentTo(
            "sessionId",
            "capabilities",
            "catalogRevision",
            "policyIdentity",
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

    [Fact]
    public void TryCreateWorldFactEvent_EmitsTypedFactOverPipeBridge()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal)
        {
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

        var fact = new BridgeWorldFact(
            "day_started_day_1",
            "day_started_day_1",
            "day_started",
            100,
            "0600",
            1,
            "{\"day\":1}",
            "day_started_day_1");

        // Unauthenticated session cannot emit
        session.TryCreateWorldFactEvent(fact).Should().BeFalse();

        // Authenticate session at generation 1
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_01",
            "hello_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token));
        session.TryAuthenticate(1, hello, out _, out string authReason).Should().BeTrue(authReason);

        // Before pipe bridge or sink is set, cannot enqueue
        session.TryCreateWorldFactEvent(fact).Should().BeFalse();

        // Wire outbound sink
        string? capturedJson = null;
        long capturedGen = -1;
        session.SetOutboundSink((gen, json) =>
        {
            capturedGen = gen;
            capturedJson = json;
            return true;
        });

        // Now emits successfully over outbound sink
        session.TryCreateWorldFactEvent(fact).Should().BeTrue();
        capturedGen.Should().Be(1);
        capturedJson.Should().NotBeNull();
        capturedJson.Should().Contain("\"type\":\"world_fact\"");
        capturedJson.Should().Contain("\"kind\":\"day_started\"");
        capturedJson.Should().Contain("\"deduplicationKey\":\"day_started_day_1\"");

        // Also test the overload with generation and out json
        session.TryCreateWorldFactEvent(1, fact, out string serializedJson).Should().BeTrue();
        BridgeProtocol.TryDeserializeWorldFact(serializedJson, out var deserialized, out string reason).Should().BeTrue(reason);
        deserialized!.Payload.Should().BeEquivalentTo(fact);

        // Mismatched generation is rejected
        session.TryCreateWorldFactEvent(999, fact, out _).Should().BeFalse();

        // Invalid fact (null / non-opaque id) is rejected
        var invalidFact = fact with { EventId = "" };
        session.TryCreateWorldFactEvent(invalidFact).Should().BeFalse();
    }
}
