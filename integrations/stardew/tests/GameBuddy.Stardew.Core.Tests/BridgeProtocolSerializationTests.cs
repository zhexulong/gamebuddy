using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class BridgeProtocolSerializationTests
{
    private static readonly BridgeScope SampleScope = new("stardew", "save_1", "world_1", "player_1", "companion_1");

    [Fact]
    public void TryDeserializeExecutionRequest_ValidPayload_DeserializesCorrectly()
    {
        var request = new BridgeExecutionRequest("req_100", "idemp_100", "till_soil", new BridgeExecutionArgs { X = 12f, Y = 34f }, 1, 5000);
        var envelope = new BridgeEnvelope<BridgeExecutionRequest>(1, "msg_1", "corr_1", 1000L, SampleScope, "execution_request", request);

        BridgeProtocol.TrySerialize(envelope, out string json, out string serializeReason).Should().BeTrue();
        serializeReason.Should().Be("accepted");

        bool deserialized = BridgeProtocol.TryDeserializeExecutionRequest(json, out var roundTripEnvelope, out string deserializeReason);
        deserialized.Should().BeTrue();
        deserializeReason.Should().Be("accepted");
        roundTripEnvelope.Should().NotBeNull();
        roundTripEnvelope!.Payload.Action.Should().Be("till_soil");
        roundTripEnvelope.Payload.Args.X.Should().Be(12f);
        roundTripEnvelope.Payload.Args.Y.Should().Be(34f);
    }

    [Fact]
    public void TryDeserializeExecutionRequest_CorruptedEnvelope_FailsClosedWithInvalidEnvelope()
    {
        string malformedJson = "{\"protocolVersion\": 1, \"type\": \"execution_request\", \"payload\": {}}";
        bool deserialized = BridgeProtocol.TryDeserializeExecutionRequest(malformedJson, out var envelope, out string reasonCode);

        deserialized.Should().BeFalse();
        reasonCode.Should().Be("invalid_envelope");
        envelope.Should().BeNull();
    }

    [Fact]
    public void TryDeserializeExecutionReceiptQuery_ValidQuery_DeserializesCorrectly()
    {
        var query = new BridgeExecutionReceiptQuery("req_100", "idemp_100");
        var envelope = new BridgeEnvelope<BridgeExecutionReceiptQuery>(1, "msg_1", "corr_1", 1000L, SampleScope, "execution_receipt_query", query);

        BridgeProtocol.TrySerialize(envelope, out string json, out _).Should().BeTrue();
        bool deserialized = BridgeProtocol.TryDeserializeExecutionReceiptQuery(json, out var roundTrip, out string reason);

        deserialized.Should().BeTrue();
        reason.Should().Be("accepted");
        roundTrip!.Payload.RequestId.Should().Be("req_100");
        roundTrip.Payload.IdempotencyKey.Should().Be("idemp_100");
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"nodeRef\":\"nr1_node_01\"}")]
    [InlineData("{\"cursor\":\"wc1_cursor_01\"}")]
    public void TryDeserializeNavigationReadRequest_ExactInspectPayload_DeserializesCorrectly(string argsJson)
    {
        string json = "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"navigation_read_request\",\"payload\":{\"operation\":\"inspect_world_map\",\"args\":" + argsJson + "}}";

        bool deserialized = BridgeProtocol.TryDeserializeNavigationReadRequest(json, out var envelope, out string reasonCode);

        deserialized.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        envelope!.Payload.Operation.Should().Be("inspect_world_map");
    }

    [Fact]
    public void TryDeserializeNavigationReadRequest_ValidFindDestinationPayload_DeserializesCorrectly()
    {
        const string json = "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"navigation_read_request\",\"payload\":{\"operation\":\"find_destination\",\"args\":{\"query\":\"mine\"}}}";

        bool deserialized = BridgeProtocol.TryDeserializeNavigationReadRequest(json, out var envelope, out string reasonCode);

        deserialized.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        envelope!.Payload.Operation.Should().Be("find_destination");
        envelope.Payload.Args.Query.Should().Be("mine");
    }

    [Fact]
    public void TryDeserializeNavigationReadRequest_FindDestinationAtMaximumQueryLength_DeserializesCorrectly()
    {
        string query = new('q', 128);
        string json = "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"navigation_read_request\",\"payload\":{\"operation\":\"find_destination\",\"args\":{\"query\":\"" + query + "\"}}}";

        bool deserialized = BridgeProtocol.TryDeserializeNavigationReadRequest(json, out var envelope, out string reasonCode);

        deserialized.Should().BeTrue();
        reasonCode.Should().Be("accepted");
        envelope!.Payload.Args.Query.Should().Be(query);
    }

    [Theory]
    [InlineData("{\"operation\":\"inspect_world_map\",\"args\":{\"nodeRef\":\"nr1_node_01\",\"cursor\":\"wc1_cursor_01\"}}")]
    [InlineData("{\"operation\":\"inspect_world_map\",\"args\":{\"pageSize\":20}}")]
    [InlineData("{\"operation\":\"inspect_world_map\",\"args\":{\"query\":\"mine\"}}")]
    [InlineData("{\"operation\":\"find_destination\",\"args\":{}}")]
    [InlineData("{\"operation\":\"find_destination\",\"args\":{\"query\":\"\"}}")]
    [InlineData("{\"operation\":\"find_destination\",\"args\":{\"query\":null}}")]
    [InlineData("{\"operation\":\"find_destination\",\"args\":{\"query\":20}}")]
    [InlineData("{\"operation\":\"find_destination\",\"args\":{\"query\":{\"text\":\"mine\"}}}")]
    [InlineData("{\"operation\":\"find_destination\",\"args\":{\"query\":\"mine\",\"nodeRef\":\"nr1_node_01\"}}")]
    [InlineData("{\"operation\":\"find_destination\",\"args\":{\"query\":\"mine\",\"cursor\":\"wc1_cursor_01\"}}")]
    [InlineData("{\"operation\":\"unknown\",\"args\":{}}")]
    public void TryDeserializeNavigationReadRequest_NonUnionOrMalformedPayload_FailsClosed(string payloadJson)
    {
        string json = "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"navigation_read_request\",\"payload\":" + payloadJson + "}";

        bool deserialized = BridgeProtocol.TryDeserializeNavigationReadRequest(json, out var envelope, out string reasonCode);

        deserialized.Should().BeFalse();
        reasonCode.Should().Be("invalid_navigation_read_request");
        envelope.Should().BeNull();
    }
}
