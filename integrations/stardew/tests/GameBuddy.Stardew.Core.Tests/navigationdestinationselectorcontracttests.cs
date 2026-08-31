using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Task 7 navigate_to_destination contract-hardening slice: the canonical frozen
/// wire ref selector is exactly `{kind:'ref', ref:'dr1_...'}` (`destinationRef`
/// is unknown and rejected), and the Mod raw parser strictly validates the
/// nested destination shape BEFORE dispatch so a route/tile/x/y/warp/unknown
/// field can never reach the action router/handler (zero dispatch because the
/// parser produces no envelope).
/// </summary>
public sealed class NavigationDestinationSelectorContractTests
{
    private const string RefHandle = "dr1_AAAAAAAAAAAAAAAAAAAAAA";
    private const string UrlSafeRefHandle = "dr1_-_-_-_-_-_-_-_-_-_-_AQ";

    [Fact]
    public void CanonicalRefSelector_DeserializesExactRef_PreDispatch()
    {
        string json = EnvelopeJsonWithRef($"{{\"kind\":\"ref\",\"ref\":\"{RefHandle}\"}}");

        BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? envelope, out string reason)
            .Should().BeTrue(reason);
        envelope!.Payload.Action.Should().Be("navigate_to_destination");
        envelope.Payload.Args.Destination.Should().NotBeNull();
        envelope.Payload.Args.Destination!.Kind.Should().Be("ref");
        envelope.Payload.Args.Destination.Ref.Should().Be(RefHandle);
    }

    [Fact]
    public void CanonicalUrlSafeRefSelector_DeserializesExactRef_PreDispatch()
    {
        string json = EnvelopeJsonWithRef($"{{\"kind\":\"ref\",\"ref\":\"{UrlSafeRefHandle}\"}}");

        BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? envelope, out string reason)
            .Should().BeTrue(reason);
        envelope!.Payload.Args.Destination!.Ref.Should().Be(UrlSafeRefHandle);
    }

    [Fact]
    public void NonCanonicalSixteenByteRefSelector_IsRejectedBeforeDispatch()
    {
        string json = EnvelopeJsonWithRef("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAB\"}");

        BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? envelope, out string reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("invalid_envelope");
        envelope.Should().BeNull();
    }

    [Fact]
    public void CanonicalLabelSelector_DeserializesExact_PreDispatch()
    {
        string json = EnvelopeJsonWithRef("{\"kind\":\"label\",\"label\":\"Mine\"}");

        BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? envelope, out string reason)
            .Should().BeTrue(reason);
        envelope!.Payload.Args.Destination!.Kind.Should().Be("label");
        envelope.Payload.Args.Destination.Label.Should().Be("Mine");
        envelope.Payload.Args.Destination.Ref.Should().BeNull();
    }

    [Theory]
    // Unknown/primitive nested fields must be rejected BEFORE dispatch.
    [InlineData("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\",\"route\":\"Farm:10,10\"}")]
    [InlineData("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\",\"tile\":{\"x\":10,\"y\":10}}")]
    [InlineData("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\",\"warp\":true}")]
    [InlineData("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\",\"x\":10}")]
    [InlineData("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\",\"y\":20}")]
    [InlineData("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\",\"leg\":\"Mine\"}")]
    [InlineData("{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\",\"foo\":\"bar\"}")]
    [InlineData("{\"kind\":\"label\",\"label\":\"Mine\",\"tile\":[10,10]}")]
    [InlineData("{\"kind\":\"label\",\"label\":\"Mine\",\"warp\":true}")]
    // Mixed label+ref shapes must be rejected.
    [InlineData("{\"kind\":\"label\",\"label\":\"Mine\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\"}")]
    // Missing required selector field.
    [InlineData("{\"kind\":\"ref\"}")]
    // Unknown kind.
    [InlineData("{\"kind\":\"whatever\",\"label\":\"Mine\"}")]
    public void NestedDestinationPrimitivesAndMixedFields_RejectedBeforeDispatch_ZeroEnvelope(string destinationJson)
    {
        string json = EnvelopeJsonWithRef(destinationJson);

        bool deserialized = BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? envelope, out string reasonCode);

        deserialized.Should().BeFalse();
        reasonCode.Should().Be("invalid_envelope");
        // No envelope is produced, so the transport never calls TryExecute and the
        // action router/handler records zero dispatch.
        envelope.Should().BeNull();
    }

    [Fact]
    public void LegacyDestinationRefField_RejectedAsUnknown_ZeroDispatch()
    {
        // The frozen field is `ref`; a legacy `destinationRef` key is an unknown
        // selector key and must be rejected, never silently dropped.
        string json = EnvelopeJsonWithRef($"{{\"kind\":\"ref\",\"destinationRef\":\"{RefHandle}\"}}");

        BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? envelope, out string reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("invalid_envelope");
        envelope.Should().BeNull();
    }

    /// <summary>Returns a valid execution_request JSON for the given destination selector fragment.</summary>
    private static string EnvelopeJsonWithRef(string destinationJson) =>
        "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,"
        + "\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},"
        + "\"type\":\"execution_request\","
        + "\"payload\":{\"requestId\":\"req_nav_1\",\"idempotencyKey\":\"req_nav_1\",\"action\":\"navigate_to_destination\","
        + "\"args\":{\"destination\":" + destinationJson + "},\"expectedRevision\":1,\"deadlineMs\":5000}}";
}