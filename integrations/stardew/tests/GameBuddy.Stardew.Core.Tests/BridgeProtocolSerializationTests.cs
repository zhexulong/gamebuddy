using System.Text;
using System.Text.Json;
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
    public void TrySerialize_SnapshotWireParityFixture_WritesHostWireParityFixtureWhenRequested()
    {
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var snapshot = new BridgeSnapshot(
            Revision: 1,
            Location: "unknown",
            Tile: new BridgeTile(0f, 0f),
            Stamina: 0f,
            Health: 0,
            CurrentTool: null,
            InventorySlots: 0,
            Actionable: false,
            Capabilities: new[] { "inspect_world_map" },
            CatalogRevision: 1,
            EnabledActionIds: Array.Empty<string>(),
            ActiveExecution: null,
            Warps: Array.Empty<BridgeWarp>(),
            DoorTargets: null,
            SoilTiles: null,
            ToolSlots: Array.Empty<BridgeToolSlot>(),
            WateringCanFacts: null,
            RefillWateringCanTargets: null,
            ForageTargets: null,
            ItemTargets: null,
            CropTargets: null,
            HarvestTargets: null,
            SeedTargets: null,
            FertilizerTargets: null,
            WoodFenceTargets: null,
            WoodFenceResultTargets: null,
            CrabPotTargets: null,
            CrabPotResultTargets: null,
            BaitCrabPotTargets: null,
            BaitCrabPotResultTargets: null,
            DebrisTargets: null,
            RockSourceTargets: null,
            ClearHoeDirtTargets: null,
            ArtifactSpotTargets: null,
            ArtifactSpotResultTargets: null,
            ArtifactSpotFarmSourceCount: null,
            MachineTargets: null,
            TreeChopSourceTargets: null,
            TreeChopResultTargets: null,
            NpcRelationshipTargets: null,
            PetTargets: null,
            AnimalProductTargets: null,
            FeedTroughTargets: null,
            InventoryItemFacts: null,
            FoodTargets: null,
            PresentationLocale: "en-US");
        var envelope = new BridgeEnvelope<BridgeSnapshot>(
            BridgeProtocol.Version,
            "snapshot_wire_parity_message",
            "snapshot_wire_parity_correlation",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "snapshot",
            snapshot);

        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeTrue(reason);
        using (JsonDocument document = JsonDocument.Parse(json))
        {
            document.RootElement.GetProperty("type").GetString().Should().Be("snapshot");
            document.RootElement.GetProperty("payload").GetProperty("location").GetString().Should().Be("unknown");
        }

        string? outputPath = Environment.GetEnvironmentVariable("GAMEBUDDY_SNAPSHOT_WIRE_OUTPUT");
        if (outputPath is null)
            return;

        Path.IsPathFullyQualified(outputPath).Should().BeTrue("the Host parity test must own an absolute private output path");
        WriteSnapshotWireParityFixture(outputPath, json);
    }

    private static void WriteSnapshotWireParityFixture(string outputPath, string json)
    {
        using var stream = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(json);
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
