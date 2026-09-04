using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.BodyPrograms;
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

    [Theory]
    [MemberData(nameof(ValidNavigationResults))]
    public void TrySerialize_NavigationResultEnvelope_EmitsAllSevenPayloadKeys(BridgeNavigationReadResult result)
    {
        var envelope = new BridgeEnvelope<BridgeNavigationReadResult>(1, "msg_1", "corr_1", 1000L, SampleScope, "navigation_read_result", result);

        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        using JsonDocument document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("payload").EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo("status", "reason", "entries", "nextCursor", "candidates", "destination", "unlockState");
    }

    [Fact]
    public void TrySerialize_NavigationResolvedEnvelope_WritesHostWireParityFixtureWhenRequested()
    {
        long timestampMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var result = new BridgeNavigationReadResult(
            "resolved",
            "exact_current_locale",
            null,
            null,
            null,
            new("label", "Farm", null),
            "unknown");
        var envelope = new BridgeEnvelope<BridgeNavigationReadResult>(
            1,
            "navigation_wire_parity_message",
            "navigation_wire_parity_correlation",
            timestampMs,
            SampleScope,
            "navigation_read_result",
            result);

        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        using (JsonDocument document = JsonDocument.Parse(json))
        {
            JsonElement payload = document.RootElement.GetProperty("payload");
            payload.EnumerateObject().Select(property => property.Name)
                .Should().BeEquivalentTo("status", "reason", "entries", "nextCursor", "candidates", "destination", "unlockState");
            payload.GetProperty("destination").EnumerateObject().Select(property => property.Name)
                .Should().BeEquivalentTo("kind", "label", "ref");
            payload.GetProperty("destination").GetProperty("ref").ValueKind.Should().Be(JsonValueKind.Null);
        }

        string? outputPath = Environment.GetEnvironmentVariable("GAMEBUDDY_NAVIGATION_WIRE_OUTPUT");
        if (outputPath is null)
            return;

        Path.IsPathFullyQualified(outputPath).Should().BeTrue("the Host parity test must own an absolute private output path");
        WriteNavigationWireParityFixture(outputPath, json);
    }

    [Fact]
    public void TrySerialize_NavigationWireParityFixture_RejectsExistingOutputWithoutChangingBytes()
    {
        string outputPath = Path.Combine(Path.GetTempPath(), $"gamebuddy-navigation-wire-{Guid.NewGuid():N}.json");
        byte[] sentinel = Encoding.UTF8.GetBytes("existing-sentinel");
        File.WriteAllBytes(outputPath, sentinel);

        try
        {
            Action write = () => WriteNavigationWireParityFixture(outputPath, "replacement");

            write.Should().Throw<IOException>();
            File.ReadAllBytes(outputPath).Should().Equal(sentinel);
        }
        finally
        {
            File.Delete(outputPath);
        }
    }

    private static void WriteNavigationWireParityFixture(string outputPath, string json)
    {
        using var stream = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(json);
    }

    [Fact]
    public void TrySerialize_NavigationNestedNullableMembers_AlwaysEmitExactKeys()
    {
        var candidateResult = new BridgeNavigationReadResult("candidates", "ambiguous_exact", null, null,
            new[] { Candidate("Farm") }, null, null);
        var mapResult = new BridgeNavigationReadResult("succeeded", "world_map_observed",
            new[] { new BridgeWorldMapEntry("Farm", null, null, null) }, null);

        BridgeProtocol.TrySerialize(candidateResult, out string candidateJson, out _).Should().BeTrue();
        BridgeProtocol.TrySerialize(mapResult, out string mapJson, out _).Should().BeTrue();
        using JsonDocument candidateDocument = JsonDocument.Parse(candidateJson);
        using JsonDocument mapDocument = JsonDocument.Parse(mapJson);
        JsonElement candidate = candidateDocument.RootElement.GetProperty("candidates")[0];
        candidate.EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo("label", "contextLabel", "destination", "unlockState");
        candidate.GetProperty("destination").EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo("kind", "label", "ref");
        JsonElement entry = mapDocument.RootElement.GetProperty("entries")[0];
        entry.EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo("label", "contextLabel", "nodeRef", "destination");
        entry.GetProperty("contextLabel").ValueKind.Should().Be(JsonValueKind.Null);
        entry.GetProperty("nodeRef").ValueKind.Should().Be(JsonValueKind.Null);
        entry.GetProperty("destination").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Theory]
    [MemberData(nameof(ValidNavigationResults))]
    public void TrySerialize_AllValidNavigationResultVariants_AreAccepted(BridgeNavigationReadResult result)
    {
        BridgeProtocol.TrySerialize(result, out _, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
    }

    [Theory]
    [MemberData(nameof(InvalidNavigationResults))]
    public void TrySerialize_MalformedNavigationResultEnvelope_IsRejected(BridgeNavigationReadResult result)
    {
        var envelope = new BridgeEnvelope<BridgeNavigationReadResult>(1, "msg_1", "corr_1", 1000L, SampleScope, "navigation_read_result", result);

        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeFalse();
        json.Should().BeEmpty();
        reason.Should().Be("invalid_navigation_read_result");
    }

    public static IEnumerable<object[]> ValidNavigationResults()
    {
        yield return Result(new("succeeded", "world_map_observed",
            new[] { new BridgeWorldMapEntry("Farm", null, null, new("label", "Farm", null)) }, null));
        yield return Result(new("resolved", "exact_current_locale", null, null, null, new("label", "Farm", null), "unknown"));
        yield return Result(new("resolved", "exact_fallback_locale", null, null, null, new("ref", null, null), "unknown"));
        yield return Result(new("resolved", "exact_alias", null, null, null, new("ref", null, "dr1_AAAAAAAAAAAAAAAAAAAAAA"), "unknown"));
        yield return Result(new("candidates", "ambiguous_exact", null, null,
            new[] { Candidate("Farm") }, null, null));
        yield return Result(new("candidates", "fuzzy_match", null, null,
            new[] { Candidate("Farm"), Candidate("Forest"), Candidate("Mine") }, null, null));
        yield return Result(new("not_found", "destination_not_found", null, null));
        yield return Result(new("invalid", "destination_search_invalid", null, null));
        foreach (string reason in new[] { "world_map_node_invalid", "world_map_node_stale", "world_map_node_not_found", "world_map_unavailable", "world_map_cursor_invalid", "world_map_cursor_stale", "world_map_projection_too_large", "world_map_disclosure_budget_exhausted", "destination_search_unavailable" })
            yield return Result(new("blocked", reason, null, null));
    }

    public static IEnumerable<object[]> InvalidNavigationResults()
    {
        yield return Result(new("resolved", "exact_current_locale", Array.Empty<BridgeWorldMapEntry>(), null, null, new("label", "Farm", null), "unknown"));
        yield return Result(new("resolved", "wrong_reason", null, null, null, new("label", "Farm", null), "unknown"));
        yield return Result(new("resolved", "exact_current_locale", null, null, null, new("label", "", null), "unknown"));
        yield return Result(new("resolved", "exact_current_locale", null, null, null, new("label", "Farm", "dr1_AAAAAAAAAAAAAAAAAAAAAA"), "unknown"));
        yield return Result(new("resolved", "exact_current_locale", null, null, null, new("ref", "Farm", null), "unknown"));
        yield return Result(new("resolved", "exact_current_locale", null, null, null, new("ref", null, "dr1_bad"), "unknown"));
        yield return Result(new("resolved", "exact_current_locale", null, null, null, new("ref", null, null), "unlocked"));
        yield return Result(new("candidates", "ambiguous_exact", null, null, Array.Empty<BridgeDestinationSearchCandidate>(), null, null));
        yield return Result(new("candidates", "fuzzy_match", null, null, new[] { Candidate("A"), Candidate("B"), Candidate("C"), Candidate("D") }, null, null));
        yield return Result(new("candidates", "fuzzy_match", null, null, new[] { Candidate("Farm") }, new("label", "Farm", null), null));
        yield return Result(new("candidates", "fuzzy_match", null, null, new[] { Candidate("Farm", new("ref", null, "dr1_AAAAAAAAAAAAAAAAAAAAAA")) }, null, null));
        yield return Result(new("not_found", "destination_not_found", null, null, new[] { Candidate("Farm") }, null, null));
        yield return Result(new("blocked", "wrong_reason", null, null));
        yield return Result(new("succeeded", "world_map_observed", Enumerable.Range(0, 21).Select(index => new BridgeWorldMapEntry($"Entry {index}", null, null, null)).ToArray(), null));
    }

    private static object[] Result(BridgeNavigationReadResult result) => new object[] { result };

    private static BridgeDestinationSearchCandidate Candidate(string label, BridgeNavigationDestinationSelector? selector = null) =>
        new(label, null, selector ?? new("ref", null, null), "unknown");

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


public sealed class BridgeBodyProgramProtocolTests
{
    private static readonly BridgeScope SampleScope = new("stardew", "save_1", "world_1", "player_1", "companion_1");
    private const string Prefix = "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"program_submit\",\"payload\":";

    [Fact]
    public void CandidateAdapterMapsSelectorVariantsAndWireBindingNodeIdToProducerNodeId()
    {
        const string payload = "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{\"label\":{\"type\":\"destination_selector\",\"destination\":{\"kind\":\"label\",\"label\":\"Town\"}},\"ref\":{\"type\":\"destination_selector\",\"destination\":{\"kind\":\"ref\",\"ref\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\"}}},\"dependsOn\":[],\"bindings\":{\"destination\":{\"nodeId\":\"producer\",\"factName\":\"arrival\"}},\"deadlineMs\":1000}]}";
        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out BridgeEnvelope<ActionProgramCandidate>? envelope, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        envelope!.Payload.Nodes.Single().Bindings["destination"].ProducerNodeId.Should().Be("producer");
        envelope.Payload.Nodes.Single().Arguments["label"].Destination!.Label.Should().Be("Town");
        envelope.Payload.Nodes.Single().Arguments["ref"].Destination!.Ref.Should().Be("dr1_AAAAAAAAAAAAAAAAAAAAAA");
    }

    [Theory]
    [InlineData("{\"type\":\"destination_selector\",\"canonicalValue\":\"Town\"}")]
    [InlineData("{\"type\":\"destination_selector\",\"destinationRef\":\"dr1_AAAAAAAAAAAAAAAAAAAAAA\"}")]
    [InlineData("{\"type\":\"string\",\"canonicalValue\":\"Town\",\"extra\":null}")]
    [InlineData("{\"type\":\"string\",\"canonicalValue\":null}")]
    public void CandidateAdapterRejectsScalarizedSelectorDestinationRefExtraAndNull(string argument)
    {
        string payload = "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{\"destination\":" + argument + "},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":1000}]}";
        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_request");
    }

    [Fact]
    public void CandidateAdapterRejectsArrivalAsArgument()
    {
        const string payload = "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{\"arrival\":{\"type\":\"destination_arrival\",\"canonicalValue\":\"arrived\"}},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":1000}]}";
        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_request");
    }

    [Fact]
    public void ResultProjectionIncludesStatusHighWaterAndEventContinuationFields()
    {
        var snapshot = new BodyProgramStatusSnapshot("program_1", BodyProgramState.Active, 7, 2, 11,
            new[] { new BodyProgramJournalNode("first", BodyProgramNodeState.Running, 3, 4, null) });
        var result = BridgeProtocol.ProjectBodyProgramEventsResult(new BodyProgramEventsResult("program_1", BodyProgramQueryCode.Found,
            new[] { new BodyProgramJournalEvent(9, "program_1", "native_dispatch", 7, "first", 3) }, 9, 11));
        BridgeProtocol.TrySerialize(result, out string json, out _).Should().BeTrue();
        using JsonDocument document = JsonDocument.Parse(json);
        document.RootElement.EnumerateObject().Select(property => property.Name).Should().BeEquivalentTo("programId", "code", "events", "nextCursor", "highWater");
        document.RootElement.GetProperty("events")[0].EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo("cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt");
        BridgeBodyProgramStatusResult status = BridgeProtocol.ProjectBodyProgramStatusResult(new BodyProgramStatusResult(BodyProgramQueryCode.Found, snapshot));
        BridgeProtocol.TrySerialize(status, out string statusJson, out _).Should().BeTrue();
        using JsonDocument statusDocument = JsonDocument.Parse(statusJson);
        statusDocument.RootElement.GetProperty("snapshot").EnumerateObject().Select(property => property.Name)
            .Should().Contain("programId", "state", "catalogRevision", "stopEpoch", "eventHighWater", "nodes");
    }

    [Fact]
    public void TryDeserializeBodyProgramSubmitResult_RejectsUnknownSubmitCode()
    {
        BridgeProtocol.TryDeserializeBodyProgramSubmitResult(ResultEnvelope("program_submit_result",
            "{\"code\":\"unknown\",\"verification\":{\"accepted\":true,\"catalogRevision\":7,\"diagnostics\":[]},\"snapshot\":null}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TryDeserializeBodyProgramStatusResult_RejectsUnknownQueryCode()
    {
        BridgeProtocol.TryDeserializeBodyProgramStatusResult(ResultEnvelope("program_status_result", "{\"code\":\"unknown\",\"snapshot\":null}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Theory]
    [InlineData("{\"code\":\"found\",\"snapshot\":null}")]
    [InlineData("{\"code\":\"not_found\",\"snapshot\":{\"programId\":\"program_1\",\"state\":\"active\",\"catalogRevision\":7,\"stopEpoch\":2,\"eventHighWater\":11,\"nodes\":[]}}")]
    [InlineData("{\"code\":\"invalid_input\",\"snapshot\":{\"programId\":\"program_1\",\"state\":\"active\",\"catalogRevision\":7,\"stopEpoch\":2,\"eventHighWater\":11,\"nodes\":[]}}")]
    public void TryDeserializeBodyProgramStatusResult_RejectsCodeSnapshotMismatch(string payload)
    {
        BridgeProtocol.TryDeserializeBodyProgramStatusResult(ResultEnvelope("program_status_result", payload), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TryDeserializeBodyProgramStatusResult_RejectsUnknownProgramState()
    {
        BridgeProtocol.TryDeserializeBodyProgramStatusResult(ResultEnvelope("program_status_result",
            "{\"code\":\"found\",\"snapshot\":{\"programId\":\"program_1\",\"state\":\"unknown\",\"catalogRevision\":7,\"stopEpoch\":2,\"eventHighWater\":11,\"nodes\":[]}}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TryDeserializeBodyProgramStatusResult_RejectsUnknownNodeState()
    {
        BridgeProtocol.TryDeserializeBodyProgramStatusResult(ResultEnvelope("program_status_result",
            "{\"code\":\"found\",\"snapshot\":{\"programId\":\"program_1\",\"state\":\"active\",\"catalogRevision\":7,\"stopEpoch\":2,\"eventHighWater\":11,\"nodes\":[{\"nodeId\":\"first\",\"state\":\"unknown\",\"nodeAttempt\":3,\"admissionAttempt\":4}]}}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TryDeserializeBodyProgramEventsResult_RejectsUnknownQueryCode()
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result", "{\"programId\":\"program_1\",\"code\":\"unknown\",\"events\":[],\"nextCursor\":0,\"highWater\":0}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Theory]
    [InlineData("{\"programId\":\"program_1\",\"code\":\"not_found\",\"events\":[{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3}],\"nextCursor\":9,\"highWater\":11}")]
    [InlineData("{\"programId\":\"program_1\",\"code\":\"invalid_input\",\"events\":[{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3}],\"nextCursor\":9,\"highWater\":11}")]
    [InlineData("{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[{\"cursor\":12,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3}],\"nextCursor\":12,\"highWater\":11}")]
    [InlineData("{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3}],\"nextCursor\":8,\"highWater\":11}")]
    public void TryDeserializeBodyProgramEventsResult_RejectsInvalidCodeOrPageValues(string payload)
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result", payload), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Theory]
    [InlineData("{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3},{\"cursor\":8,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3}],\"nextCursor\":8,\"highWater\":11}")]
    [InlineData("{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3},{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3}],\"nextCursor\":9,\"highWater\":11}")]
    public void TryDeserializeBodyProgramEventsResult_RejectsNonIncreasingEventCursors(string payload)
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result", payload), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TryDeserializeBodyProgramEventsResult_AcceptsEmptyPageCursorPastHighWater()
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result",
            "{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[],\"nextCursor\":12,\"highWater\":11}"), out BridgeEnvelope<BridgeBodyProgramEventsResult>? envelope, out string reason).Should().BeTrue();

        reason.Should().Be("accepted");
        envelope!.Payload.NextCursor.Should().Be(12);
        envelope.Payload.HighWater.Should().Be(11);
    }

    [Fact]
    public void TryDeserializeBodyProgramEventsResult_RejectsMissingPageProgramId()
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result", "{\"code\":\"found\",\"events\":[],\"nextCursor\":0,\"highWater\":0}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TryDeserializeBodyProgramEventsResult_RejectsEventForAnotherProgram()
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result",
            "{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[{\"cursor\":9,\"programId\":\"program_2\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3}],\"nextCursor\":9,\"highWater\":11}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TryDeserializeBodyProgramEventsResult_RejectsPageFieldsInsideEvent()
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result",
            "{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":3,\"nextCursor\":9,\"highWater\":11}],\"nextCursor\":9,\"highWater\":11}"), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_result");
    }

    [Theory]
    [MemberData(nameof(InvalidOutboundResults))]
    public void TrySerialize_InvalidBodyProgramResult_IsRejected(object result)
    {
        BridgeProtocol.TrySerialize(result, out string json, out string reason).Should().BeFalse();

        json.Should().BeEmpty();
        reason.Should().Be("invalid_body_program_result");
    }

    public static IEnumerable<object[]> InvalidOutboundResults()
    {
        BridgeBodyProgramStatusSnapshot snapshot = new("program_1", "active", 7, 2, 11, Array.Empty<BridgeBodyProgramNodeStatus>());
        yield return new object[] { new BridgeBodyProgramSubmitResult("unknown", new BridgeBodyProgramVerification(true, 7, Array.Empty<BridgeBodyProgramDiagnostic>()), snapshot) };
        yield return new object[] { new BridgeBodyProgramSubmitResult("accepted", new BridgeBodyProgramVerification(false, 7, Array.Empty<BridgeBodyProgramDiagnostic>()), snapshot) };
        yield return new object[] { new BridgeBodyProgramSubmitResult("rejected", new BridgeBodyProgramVerification(true, 7, Array.Empty<BridgeBodyProgramDiagnostic>()), null) };
        yield return new object[] { new BridgeBodyProgramSubmitResult("persistence_failure", new BridgeBodyProgramVerification(false, 7, Array.Empty<BridgeBodyProgramDiagnostic>()), null) };
        yield return new object[] { new BridgeBodyProgramStatusResult("unknown", null) };
        yield return new object[] { new BridgeBodyProgramStatusResult("found", null) };
        yield return new object[] { new BridgeBodyProgramStatusResult("not_found", snapshot) };
        yield return new object[] { new BridgeBodyProgramStatusResult("found", snapshot with { State = "unknown" }) };
        yield return new object[] { new BridgeBodyProgramEventsResult("program_1", "unknown", Array.Empty<BridgeBodyProgramEvent>(), 0, 0) };
        yield return new object[] { new BridgeBodyProgramEventsResult("program_1", "not_found", new[] { new BridgeBodyProgramEvent(1, "program_1", "native_dispatch", 7, null, null) }, 1, 1) };
        yield return new object[] { new BridgeBodyProgramEventsResult("program_1", "found", new[] { new BridgeBodyProgramEvent(2, "program_1", "native_dispatch", 7, null, null) }, 2, 1) };
        yield return new object[] { new BridgeBodyProgramEventsResult("program_1", "found", new[] { new BridgeBodyProgramEvent(9, "program_1", "native_dispatch", 7, null, null) }, 8, 11) };
        yield return new object[] { new BridgeBodyProgramEventsResult("program_1", "found", new[] { new BridgeBodyProgramEvent(9, "program_1", "native_dispatch", 7, null, null), new BridgeBodyProgramEvent(9, "program_1", "native_dispatch", 7, null, null) }, 9, 11) };
        yield return new object[] { new BridgeEnvelope<BridgeBodyProgramStatusResult>(1, "msg_1", "corr_1", 1000, SampleScope, "wrong_type", new BridgeBodyProgramStatusResult("found", snapshot)) };
    }

    [Theory]
    [MemberData(nameof(InvalidBodyProgramOutboundEnvelopes))]
    public void TrySerialize_InvalidBodyProgramResultEnvelope_IsRejected(BridgeEnvelope<BridgeBodyProgramStatusResult> envelope)
    {
        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeFalse();

        json.Should().BeEmpty();
        reason.Should().Be("invalid_body_program_result");
    }

    public static IEnumerable<object[]> InvalidBodyProgramOutboundEnvelopes()
    {
        BridgeBodyProgramStatusResult result = new("found", new BridgeBodyProgramStatusSnapshot("program_1", "active", 7, 2, 11, Array.Empty<BridgeBodyProgramNodeStatus>()));
        yield return new object[] { new BridgeEnvelope<BridgeBodyProgramStatusResult>(2, "msg_1", "corr_1", 1000, SampleScope, "program_status_result", result) };
        yield return new object[] { new BridgeEnvelope<BridgeBodyProgramStatusResult>(BridgeProtocol.Version, "", "corr_1", 1000, SampleScope, "program_status_result", result) };
        yield return new object[] { new BridgeEnvelope<BridgeBodyProgramStatusResult>(BridgeProtocol.Version, "msg_1", "", 1000, SampleScope, "program_status_result", result) };
        yield return new object[] { new BridgeEnvelope<BridgeBodyProgramStatusResult>(BridgeProtocol.Version, "msg_1", "corr_1", 1000, new BridgeScope("", "save_1", "world_1", "player_1", "companion_1"), "program_status_result", result) };
    }

    [Fact]
    public void ProjectBodyProgramResults_SerializesValidCoreResults()
    {
        var snapshot = new BodyProgramStatusSnapshot("program_1", BodyProgramState.Active, 7, 2, 11,
            new[] { new BodyProgramJournalNode("first", BodyProgramNodeState.Running, 3, 4, null) });
        BodyProgramVerificationReport verification = new(true, 7, null, Array.Empty<BodyProgramDiagnostic>());
        BridgeBodyProgramSubmitResult submit = BridgeProtocol.ProjectBodyProgramSubmitResult(new BodyProgramSubmitResult(BodyProgramSubmitCode.Accepted, verification, snapshot));
        BridgeBodyProgramStatusResult status = BridgeProtocol.ProjectBodyProgramStatusResult(new BodyProgramStatusResult(BodyProgramQueryCode.Found, snapshot));
        BridgeBodyProgramEventsResult events = BridgeProtocol.ProjectBodyProgramEventsResult(new BodyProgramEventsResult("program_1", BodyProgramQueryCode.Found,
            new[] { new BodyProgramJournalEvent(9, "program_1", "native_dispatch", 7, "first", 3) }, 9, 11));

        BridgeProtocol.TrySerialize(submit, out _, out string submitReason).Should().BeTrue();
        BridgeProtocol.TrySerialize(status, out _, out string statusReason).Should().BeTrue();
        BridgeProtocol.TrySerialize(events, out _, out string eventsReason).Should().BeTrue();
        BridgeProtocol.TrySerialize(BridgeProtocol.ProjectBodyProgramEventsResult(new BodyProgramEventsResult("program_1", BodyProgramQueryCode.Found,
            Array.Empty<BodyProgramJournalEvent>(), 12, 11)), out _, out string emptyEventsReason).Should().BeTrue();

        submitReason.Should().Be("accepted");
        statusReason.Should().Be("accepted");
        eventsReason.Should().Be("accepted");
        emptyEventsReason.Should().Be("accepted");
    }

    [Fact]
    public void BodyProgramEventsResultProjection_RoundTripsExactPageShape()
    {
        var projected = BridgeProtocol.ProjectBodyProgramEventsResult(new BodyProgramEventsResult("program_1", BodyProgramQueryCode.Found,
            new[] { new BodyProgramJournalEvent(9, "program_1", "native_dispatch", 7, "first", 3) }, 9, 11));
        var envelope = new BridgeEnvelope<BridgeBodyProgramEventsResult>(1, "msg_1", "corr_1", 1000, SampleScope, "program_events_result", projected);

        BridgeProtocol.TrySerialize(envelope, out string json, out string serializeReason).Should().BeTrue();
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(json, out BridgeEnvelope<BridgeBodyProgramEventsResult>? roundTrip, out string deserializeReason).Should().BeTrue();

        serializeReason.Should().Be("accepted");
        deserializeReason.Should().Be("accepted");
        roundTrip!.Payload.ProgramId.Should().Be("program_1");
        roundTrip.Payload.Code.Should().Be("found");
        roundTrip.Payload.Events.Should().ContainSingle().Which.Should().Be(new BridgeBodyProgramEvent(9, "program_1", "native_dispatch", 7, "first", 3));
        roundTrip.Payload.NextCursor.Should().Be(9);
        roundTrip.Payload.HighWater.Should().Be(11);
    }

    private static string ResultEnvelope(string type, string payload) =>
        "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"" + type + "\",\"payload\":" + payload + "}";
}
