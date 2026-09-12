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

    private static NodeAdmissionChallenge AdmissionChallenge() => new("program_1", "node_1", 1, 2, 3, 4,
        new("mod:policy/v1", 5), "navigate_to_destination",
        new Dictionary<string, BodyProgramCanonicalValue>
        {
            ["destination"] = new(BodyProgramArgumentKind.DestinationSelector, null, new("label", "Town", null)),
            ["count"] = new(BodyProgramArgumentKind.Integer, "9223372036854775807"),
            ["enabled"] = new(BodyProgramArgumentKind.Boolean, "true"),
            ["text"] = new(BodyProgramArgumentKind.String, ""),
        }, new Dictionary<string, string> { ["actor"] = "player_1" }, 5000);

    private static BridgeEnvelope<BodyNodeAdmissionChallengeWire> AdmissionEnvelope() =>
        new(1, "message_1", "correlation_1", 1000, SampleScope, "body_node_admission_challenge", BridgeProtocol.ProjectBodyNodeAdmissionChallenge(AdmissionChallenge()));

    [Fact]
    public void AdmissionChallenge_ProjectsDestinationAndRoundTripsCore()
    {
        BridgeProtocol.TrySerialize(AdmissionEnvelope(), out string json, out _).Should().BeTrue();
        json.Should().Contain("\"destination\":{\"kind\":\"label\"").And.NotContain("\"selector\"");
        BridgeProtocol.TryDeserializeBodyNodeAdmissionChallenge(json, out var parsed, out _).Should().BeTrue();
        parsed!.Payload.Should().BeEquivalentTo(AdmissionChallenge());
        BridgeProtocol.TrySerialize(BridgeProtocol.ProjectBodyNodeAdmissionChallenge(parsed.Payload), out _, out _).Should().BeTrue();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AdmissionGrant_PreservesOpaqueStringsAndRequiredNullableBinding(bool consumed)
    {
        var challenge = AdmissionChallenge();
        var binding = consumed ? new NodeExecutionBinding("program_1", "node_1", 1, "request_1", "key_1", "execution_1") : null;
        var grant = new HostAdmissionGrant(challenge.ProgramId, challenge.NodeId, 1, 2, 3, 4, challenge.PolicyIdentity,
            challenge.ActionId, challenge.CanonicalArguments, challenge.DerivedResourceClaims, 5000, "grant_1", "attachment:epoch/7", "host:policy/9", binding);
        var wire = BridgeProtocol.ProjectBodyNodeAdmissionGrant(grant);
        var envelope = new BridgeEnvelope<BodyNodeAdmissionGrantWire>(1, "message_1", "correlation_1", 1000, SampleScope, "body_node_admission_grant", wire);
        BridgeProtocol.TrySerialize(envelope, out string json, out _).Should().BeTrue();
        json.Should().Contain("\"executionBinding\":");
        BridgeProtocol.TryDeserializeBodyNodeAdmissionGrant(json, out var parsed, out _).Should().BeTrue();
        parsed!.Payload.Should().BeEquivalentTo(grant);
        BridgeProtocol.TrySerialize(wire, out _, out _).Should().BeTrue();
        var root = System.Text.Json.Nodes.JsonNode.Parse(json)!;
        foreach (string key in new[] { "executionBinding", "attachmentGeneration", "policyRevision", "grantId" })
        {
            var invalid = System.Text.Json.Nodes.JsonNode.Parse(json)!;
            invalid["payload"]!.AsObject().Remove(key);
            BridgeProtocol.TryDeserializeBodyNodeAdmissionGrant(invalid.ToJsonString(), out _, out _).Should().BeFalse();
        }
        foreach (string replacement in new[] { "0", "null", "\"\"" })
        {
            var invalid = System.Text.Json.Nodes.JsonNode.Parse(json)!;
            invalid["payload"]!["attachmentGeneration"] = System.Text.Json.Nodes.JsonNode.Parse(replacement);
            BridgeProtocol.TryDeserializeBodyNodeAdmissionGrant(invalid.ToJsonString(), out _, out _).Should().BeFalse();
        }
        foreach (string malformed in new[] { "{}", "{\"programId\":\"other\",\"nodeId\":\"node_1\",\"nodeAttempt\":1,\"requestId\":\"request_1\",\"idempotencyKey\":\"key_1\",\"executionId\":\"execution_1\"}" })
        {
            root["payload"]!["executionBinding"] = System.Text.Json.Nodes.JsonNode.Parse(malformed);
            BridgeProtocol.TryDeserializeBodyNodeAdmissionGrant(root.ToJsonString(), out _, out _).Should().BeFalse();
        }
    }

    [Theory]
    [InlineData("count", "01")]
    [InlineData("count", "-0")]
    [InlineData("count", "9223372036854775808")]
    [InlineData("count", "1.0")]
    [InlineData("enabled", "True")]
    [InlineData("enabled", "0")]
    public void AdmissionChallenge_RejectsNoncanonicalScalars(string key, string value)
    {
        var wire = AdmissionEnvelope().Payload;
        var args = wire.CanonicalBoundArgs.ToDictionary(pair => pair.Key, pair => pair.Value);
        args[key] = args[key] with { CanonicalValue = value };
        wire = wire with { CanonicalBoundArgs = args };
        BridgeProtocol.TrySerialize(wire, out _, out _).Should().BeFalse();
        var envelope = AdmissionEnvelope() with { Payload = wire };
        BridgeProtocol.TryDeserializeBodyNodeAdmissionChallenge(JsonSerializer.Serialize(envelope, BridgeProtocol.JsonOptions), out _, out _).Should().BeFalse();
    }

    [Fact]
    public void AdmissionChallenge_RejectsWrongKeysNumbersNullsAndEnvelope()
    {
        string json = JsonSerializer.Serialize(AdmissionEnvelope(), BridgeProtocol.JsonOptions);
        foreach (string key in new[] { "programId", "nodeId", "nodeAttempt", "admissionAttempt", "stopEpoch", "catalogRevision", "policyIdentity", "actionId", "canonicalBoundArgs", "derivedResourceClaims", "deadlineMs" })
        {
            var root = System.Text.Json.Nodes.JsonNode.Parse(json)!;
            root["payload"]!.AsObject().Remove(key);
            BridgeProtocol.TryDeserializeBodyNodeAdmissionChallenge(root.ToJsonString(), out _, out _).Should().BeFalse();
            root["payload"]![key] = null;
            BridgeProtocol.TryDeserializeBodyNodeAdmissionChallenge(root.ToJsonString(), out _, out _).Should().BeFalse();
        }
        foreach (string invalid in new[] {
            json.Replace("\"destination\":{", "\"selector\":{"),
            json.Replace("\"stopEpoch\":3", "\"stopEpoch\":9007199254740992"),
            json.Replace("\"nodeAttempt\":1", "\"nodeAttempt\":1.5"),
            json.Replace("\"deadlineMs\":5000", "\"deadlineMs\":0"),
            json.Replace("\"capabilityRevision\":5", "\"capabilityRevision\":-1"),
            json.Replace("\"kind\":\"label\"", "\"extra\":0,\"kind\":\"label\""),
            json.Replace("\"programId\":", "\"extra\":0,\"programId\":"),
            json.Replace("body_node_admission_challenge", "body_node_admission_grant"),
            json.Replace("\"saveId\":\"save_1\"", "\"saveId\":\"bad id\""),
            json.Replace("\"timestampMs\":1000", "\"timestampMs\":9007199254740992") })
            BridgeProtocol.TryDeserializeBodyNodeAdmissionChallenge(invalid, out _, out _).Should().BeFalse();
        BridgeProtocol.TrySerialize(AdmissionEnvelope() with { Type = "wrong" }, out _, out _).Should().BeFalse();
        BridgeProtocol.TrySerialize(AdmissionEnvelope() with { Scope = SampleScope with { SaveId = "bad id" } }, out _, out _).Should().BeFalse();
    }

    [Fact]
    public void AdmissionChallenge_ValidatesSelectorsPolicyAndMapBounds()
    {
        var wire = AdmissionEnvelope().Payload;
        foreach (var selector in new[] { new BodyNodeAdmissionSelectorWire("label", " "), new("label", "e\u0301"), new("label", new string('x', 129)), new("ref", Ref: "opaque"), new("ref", Ref: "dr1_AAAAAAAAAAAAAAAAAAAAAB"), new("label", "Town", "dr1_AAAAAAAAAAAAAAAAAAAAAA") })
            BridgeProtocol.TrySerialize(wire with { CanonicalBoundArgs = new Dictionary<string, BodyNodeAdmissionCanonicalValueWire> { ["target"] = new("destination_selector", Destination: selector) } }, out _, out _).Should().BeFalse();
        var validRef = wire with { CanonicalBoundArgs = new Dictionary<string, BodyNodeAdmissionCanonicalValueWire> { ["target"] = new("destination_selector", Destination: new("ref", Ref: "dr1_AAAAAAAAAAAAAAAAAAAAAA")) } };
        BridgeProtocol.TrySerialize(AdmissionEnvelope() with { Payload = validRef }, out string json, out _).Should().BeTrue();
        BridgeProtocol.TryDeserializeBodyNodeAdmissionChallenge(json, out var parsed, out _).Should().BeTrue();
        parsed!.Payload.CanonicalArguments["target"].Destination!.Ref.Should().Be("dr1_AAAAAAAAAAAAAAAAAAAAAA");
        BridgeProtocol.TrySerialize(wire with { PolicyIdentity = new("", 1) }, out _, out _).Should().BeFalse();
        BridgeProtocol.TrySerialize(wire with { PolicyIdentity = new("policy", 9007199254740992) }, out _, out _).Should().BeFalse();
        BridgeProtocol.TrySerialize(wire with { CanonicalBoundArgs = Enumerable.Range(0, 33).ToDictionary(i => "arg_" + i, _ => new BodyNodeAdmissionCanonicalValueWire("string", "")) }, out _, out _).Should().BeFalse();
        BridgeProtocol.TrySerialize(wire with { DerivedResourceClaims = Enumerable.Range(0, 17).ToDictionary(i => "claim_" + i, _ => "actor") }, out _, out _).Should().BeFalse();
    }

    [Fact]
    public void AdmissionChallenge_RejectsOversizedFrame()
    {
        var wire = AdmissionEnvelope().Payload with { CanonicalBoundArgs = Enumerable.Range(0, 32).ToDictionary(i => "arg_" + i, _ => new BodyNodeAdmissionCanonicalValueWire("string", new string('x', 512))) };
        var envelope = AdmissionEnvelope() with { Payload = wire };
        BridgeProtocol.TrySerialize(envelope, out _, out string reason).Should().BeFalse();
        reason.Should().Be("message_too_large");
        BridgeProtocol.TryDeserializeBodyNodeAdmissionChallenge(JsonSerializer.Serialize(envelope, BridgeProtocol.JsonOptions), out _, out reason).Should().BeFalse();
        reason.Should().Be("message_too_large");
    }

    [Fact]
    public void PickupForageExecutionRequest_RequiresTypedSceneTargetAndRoundTripsIt()
    {
        var request = new BridgeExecutionRequest("req_forage", "idemp_forage", "pickup_forage",
            new BridgeExecutionArgs { X = 12, Y = 34, ExpectedQualifiedItemId = "(O)16", ExpectedTargetId = "forage_target", SceneTarget = new ObservationBindingV1("observation_1", "forage_target") }, 1, 5000);
        var envelope = new BridgeEnvelope<BridgeExecutionRequest>(1, "msg_forage", "corr_forage", 1000L, SampleScope, "execution_request", request);

        BridgeProtocol.TrySerialize(envelope, out string json, out string serializeReason).Should().BeTrue(serializeReason);
        BridgeProtocol.TryDeserializeExecutionRequest(json, out BridgeEnvelope<BridgeExecutionRequest>? parsed, out string deserializeReason).Should().BeTrue(deserializeReason);
        parsed!.Payload.Args.SceneTarget.Should().BeEquivalentTo(request.Args.SceneTarget);

        var missing = System.Text.Json.Nodes.JsonNode.Parse(json)!;
        missing["payload"]!["args"]!.AsObject().Remove("sceneTarget");
        BridgeProtocol.TryDeserializeExecutionRequest(missing.ToJsonString(), out _, out string missingReason).Should().BeFalse();
        missingReason.Should().Be("invalid_envelope");
    }

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

    [Fact]
    public void ObservationBindingV1_RoundTripsExactKeysAndOpaqueValues()
    {
        var binding = new ObservationBindingV1("observation_1", "sr1_AAAAAAAAAAAAAAAA");

        BridgeProtocol.TrySerialize(binding, out string json, out string serializeReason).Should().BeTrue();
        serializeReason.Should().Be("accepted");
        using (JsonDocument document = JsonDocument.Parse(json))
        {
            document.RootElement.EnumerateObject().Select(property => property.Name)
                .Should().BeEquivalentTo("observationId", "ref");
            document.RootElement.GetProperty("observationId").GetString().Should().Be(binding.ObservationId);
            document.RootElement.GetProperty("ref").GetString().Should().Be(binding.Ref);
        }

        BridgeProtocol.TryDeserializeObservationBindingV1(json, out ObservationBindingV1? parsed, out string deserializeReason).Should().BeTrue();
        deserializeReason.Should().Be("accepted");
        parsed.Should().BeEquivalentTo(binding);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"observationId\":\"observation_1\"}")]
    [InlineData("{\"ref\":\"sr1_AAAAAAAAAAAAAAAA\"}")]
    [InlineData("{\"observationId\":\"observation_1\",\"ref\":\"sr1_AAAAAAAAAAAAAAAA\",\"kind\":\"npc\"}")]
    [InlineData("{\"ObservationId\":\"observation_1\",\"ref\":\"sr1_AAAAAAAAAAAAAAAA\"}")]
    [InlineData("{\"observationId\":null,\"ref\":\"sr1_AAAAAAAAAAAAAAAA\"}")]
    [InlineData("{\"observationId\":\"observation_1\",\"ref\":17}")]
    [InlineData("{\"observationId\":\"bad id\",\"ref\":\"sr1_AAAAAAAAAAAAAAAA\"}")]
    [InlineData("{\"observationId\":\"observation_1\",\"ref\":\"\"}")]
    public void TryDeserializeObservationBindingV1_RejectsNonExactOrNonOpaquePayload(string json)
    {
        BridgeProtocol.TryDeserializeObservationBindingV1(json, out ObservationBindingV1? binding, out string reasonCode).Should().BeFalse();

        reasonCode.Should().Be("observation_binding_malformed");
        binding.Should().BeNull();
    }

    [Fact]
    public void ObservationBindingV1_RejectsInvalidDirectValuesAndOversizedOpaqueStrings()
    {
        var invalidValues = new[]
        {
            new ObservationBindingV1("", "ref_1"),
            new ObservationBindingV1("observation_1", ""),
            new ObservationBindingV1("bad id", "ref_1"),
            new ObservationBindingV1(new string('o', 129), "ref_1"),
            new ObservationBindingV1("observation_1", new string('r', 129)),
        };

        foreach (ObservationBindingV1 invalid in invalidValues)
        {
            BridgeProtocol.TrySerialize(invalid, out string json, out string reasonCode).Should().BeFalse();
            json.Should().BeEmpty();
            reasonCode.Should().Be("observation_binding_malformed");
        }
    }

    [Fact]
    public void TryDeserializeObservationBindingV1_RejectsMalformedJsonAndOversizedFrame()
    {
        BridgeProtocol.TryDeserializeObservationBindingV1("{", out _, out string malformedReason).Should().BeFalse();
        malformedReason.Should().Be("observation_binding_malformed");

        string tooLong = "{\"observationId\":\"" + new string('o', 129) + "\",\"ref\":\"ref_1\"}";
        BridgeProtocol.TryDeserializeObservationBindingV1(tooLong, out _, out string tooLongReason).Should().BeFalse();
        tooLongReason.Should().Be("observation_binding_malformed");

        string oversized = "{\"observationId\":\"" + new string('o', 128) + "\",\"ref\":\"" + new string('r', 128) + "\"}";
        BridgeProtocol.TryDeserializeObservationBindingV1(oversized + new string(' ', BridgeProtocol.MaximumMessageBytes), out _, out string oversizedReason).Should().BeFalse();
        oversizedReason.Should().Be("message_too_large");
    }

    [Fact]
    public void TryDeserializeObserveSceneRequest_EmptyPayloadUsesDefaultRadius()
    {
        BridgeProtocol.TryDeserializeObserveSceneRequest(SceneEnvelope("observe_scene_request", "{}"), out var envelope, out string reasonCode).Should().BeTrue();

        reasonCode.Should().Be("accepted");
        envelope!.Payload.Radius.Should().Be(ObserveSceneRequestPayload.DefaultRadius);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(30)]
    public void TryDeserializeObserveSceneRequest_AcceptsInclusiveRadiusBounds(int radius)
    {
        BridgeProtocol.TryDeserializeObserveSceneRequest(SceneEnvelope("observe_scene_request", "{\"radius\":" + radius + "}"), out var envelope, out string reasonCode).Should().BeTrue();

        reasonCode.Should().Be("accepted");
        envelope!.Payload.Radius.Should().Be(radius);
    }

    [Theory]
    [InlineData("{\"radius\":-1}")]
    [InlineData("{\"radius\":31}")]
    [InlineData("{\"radius\":1.5}")]
    [InlineData("{\"radius\":null}")]
    [InlineData("{\"radius\":15,\"extra\":true}")]
    [InlineData("{\"extra\":true}")]
    public void TryDeserializeObserveSceneRequest_RejectsMalformedPayload(string payload)
    {
        BridgeProtocol.TryDeserializeObserveSceneRequest(SceneEnvelope("observe_scene_request", payload), out var envelope, out string reasonCode).Should().BeFalse();

        reasonCode.Should().Be("invalid_observe_scene_request");
        envelope.Should().BeNull();
    }

    [Fact]
    public void ObserveSceneResult_RoundTripsExactNullableWireShape()
    {
        var result = new ObserveSceneResultPayload(
            "Farm",
            "outdoor",
            new[]
            {
                new ObserveSceneAffordancePayload("sr1_AAAAAAAAAAAAAAAA", "npc", "Robin", 2, "East", null),
                new ObserveSceneAffordancePayload("sr1_AQEBAQEBAQEBAQEB", "chest", "Storage Chest", 0, "CurrentTile", "inspect"),
            },
            "Robin and a storage chest are nearby.",
            false,
            null);
        var envelope = new BridgeEnvelope<ObserveSceneResultPayload>(1, "msg_1", "corr_1", 1000L, SampleScope, "observe_scene_result", result);

        BridgeProtocol.TrySerialize(envelope, out string json, out string serializeReason).Should().BeTrue();
        serializeReason.Should().Be("accepted");
        using (JsonDocument document = JsonDocument.Parse(json))
        {
            document.RootElement.GetProperty("payload").EnumerateObject().Select(property => property.Name)
                .Should().BeEquivalentTo("currentLocation", "currentRegion", "affordances", "summary", "partial", "truncatedReason");
            document.RootElement.GetProperty("payload").GetProperty("affordances")[0].EnumerateObject().Select(property => property.Name)
                .Should().BeEquivalentTo("ref", "kind", "name", "distance", "direction", "actionHint");
            document.RootElement.GetProperty("payload").GetProperty("affordances")[0].GetProperty("actionHint").ValueKind.Should().Be(JsonValueKind.Null);
            document.RootElement.GetProperty("payload").GetProperty("truncatedReason").ValueKind.Should().Be(JsonValueKind.Null);
        }

        BridgeProtocol.TryDeserializeObserveSceneResult(json, out var parsed, out string deserializeReason).Should().BeTrue();
        deserializeReason.Should().Be("accepted");
        parsed!.Payload.Should().BeEquivalentTo(result);
    }

    [Theory]
    [InlineData("maximum_affordances")]
    [InlineData("payload_limit")]
    public void ObserveSceneResult_PartialResultRequiresTruncationReason(string truncatedReason)
    {
        var result = new ObserveSceneResultPayload("Farm", "outdoor", Array.Empty<ObserveSceneAffordancePayload>(), "Scene was truncated.", true, truncatedReason);
        var envelope = new BridgeEnvelope<ObserveSceneResultPayload>(1, "msg_1", "corr_1", 1000L, SampleScope, "observe_scene_result", result);

        BridgeProtocol.TrySerialize(envelope, out string json, out string serializeReason).Should().BeTrue();
        serializeReason.Should().Be("accepted");
        BridgeProtocol.TryDeserializeObserveSceneResult(json, out var parsed, out string deserializeReason).Should().BeTrue();
        deserializeReason.Should().Be("accepted");
        parsed!.Payload.Partial.Should().BeTrue();
        parsed.Payload.TruncatedReason.Should().Be(truncatedReason);
    }

    [Theory]
    [InlineData("{\"currentLocation\":\"Farm\",\"currentRegion\":\"outdoor\",\"affordances\":[],\"summary\":\"ok\",\"partial\":false,\"truncatedReason\":\"payload_limit\"}")]
    [InlineData("{\"currentLocation\":\"Farm\",\"currentRegion\":\"outdoor\",\"affordances\":[],\"summary\":\"ok\",\"partial\":true,\"truncatedReason\":null}")]
    [InlineData("{\"currentLocation\":\"Farm\",\"currentRegion\":\"outdoor\",\"affordances\":[{\"ref\":\"sr1_AAAAAAAAAAAAAAAA\",\"kind\":\"unknown\",\"name\":\"thing\",\"distance\":1,\"direction\":\"East\",\"actionHint\":null}],\"summary\":\"ok\",\"partial\":false,\"truncatedReason\":null}")]
    [InlineData("{\"currentLocation\":\"Farm\",\"currentRegion\":\"outdoor\",\"affordances\":[{\"ref\":\"sr1_AAAAAAAAAAAAAAAA\",\"kind\":\"npc\",\"name\":\"thing\",\"distance\":1,\"direction\":\"Northeast\",\"actionHint\":null}],\"summary\":\"ok\",\"partial\":false,\"truncatedReason\":null}")]
    [InlineData("{\"currentLocation\":\"Farm\",\"currentRegion\":\"outdoor\",\"affordances\":[{\"ref\":\"sr1_AAAAAAAAAAAAAAAA\",\"kind\":\"npc\",\"name\":\"thing\",\"distance\":1,\"direction\":\"East\",\"actionHint\":null},{\"ref\":\"sr1_AAAAAAAAAAAAAAAA\",\"kind\":\"chest\",\"name\":\"other\",\"distance\":2,\"direction\":\"West\",\"actionHint\":null}],\"summary\":\"ok\",\"partial\":false,\"truncatedReason\":null}")]
    public void TryDeserializeObserveSceneResult_RejectsInvalidUnionAndAffordancePayloads(string payload)
    {
        BridgeProtocol.TryDeserializeObserveSceneResult(SceneEnvelope("observe_scene_result", payload), out var envelope, out string reasonCode).Should().BeFalse();

        reasonCode.Should().Be("invalid_observe_scene_result");
        envelope.Should().BeNull();
    }

    [Fact]
    public void TrySerializeObserveSceneResult_RejectsInvalidDirectPayload()
    {
        var invalid = new ObserveSceneResultPayload("Farm", "outdoor", Array.Empty<ObserveSceneAffordancePayload>(), "ok", false, "payload_limit");

        BridgeProtocol.TrySerialize(invalid, out string json, out string reasonCode).Should().BeFalse();

        json.Should().BeEmpty();
        reasonCode.Should().Be("invalid_observe_scene_result");
    }

    private static string SceneEnvelope(string type, string payload) =>
        "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"" + type + "\",\"payload\":" + payload + "}";
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

    [Fact]
    public void CandidateAdapterEnforcesMaximumBodyProgramBindingsPerNode()
    {
        const string head = "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{},\"dependsOn\":[],\"bindings\":";
        const string tail = ",\"deadlineMs\":1000}]}";
        string bindingMap(int count) => "{" + string.Join(",", Enumerable.Range(0, count).Select(i => $"\"k{i}\":{{\"nodeId\":\"producer\",\"factName\":\"f{i}\"}}")) + "}";
        int maximum = BridgeProtocol.MaximumBodyProgramBindingsPerNode;

        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + head + bindingMap(maximum) + tail + "}",
            out BridgeEnvelope<ActionProgramCandidate>? accepted, out string acceptedReason).Should().BeTrue();
        acceptedReason.Should().Be("accepted");
        accepted!.Payload.Nodes.Single().Bindings.Should().HaveCount(maximum);

        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + head + bindingMap(maximum + 1) + tail + "}",
            out _, out string rejectedReason).Should().BeFalse();
        rejectedReason.Should().Be("invalid_body_program_request");
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

    [Theory]
    [InlineData("Town ")]
    [InlineData(" Town")]
    public void CandidateAdapterRejectsSelectorBoundaryWhitespace(string label)
    {
        string payload = "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"navigate\",\"arguments\":{\"destination\":{\"type\":\"destination_selector\",\"destination\":{\"kind\":\"label\",\"label\":\"" + label + "\"}}},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":1000}]}";
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

    [Theory]
    [InlineData("07")]
    [InlineData("9223372036854775808")]
    [InlineData("-9223372036854775809")]
    public void CandidateAdapterRejectsNonCanonicalOrOutOfRangeIntegerAtIngress(string canonicalValue)
    {
        string payload = IntegerCandidatePayload(canonicalValue);

        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_request");
    }

    [Fact]
    public void CandidateAdapterRejectsIntegerCanonicalValueOverMaximumLengthAtIngress()
    {
        string payload = IntegerCandidatePayload(new string('9', 513));

        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_request");
    }

    [Theory]
    [InlineData("-9223372036854775808")]
    [InlineData("9223372036854775807")]
    public void CandidateAdapterAcceptsSignedInt64BoundaryIntegerAtIngress(string canonicalValue)
    {
        string payload = IntegerCandidatePayload(canonicalValue);

        BridgeProtocol.TryDeserializeBodyProgramSubmitRequest(Prefix + payload + "}", out BridgeEnvelope<ActionProgramCandidate>? envelope, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        envelope!.Payload.Nodes.Single().Arguments["tile"].CanonicalValue.Should().Be(canonicalValue);
    }

    private static string IntegerCandidatePayload(string canonicalValue) =>
        "{\"programId\":\"program_1\",\"nodes\":[{\"nodeId\":\"first\",\"actionId\":\"move_to_tile\",\"arguments\":{\"tile\":{\"type\":\"integer\",\"canonicalValue\":\"" + canonicalValue + "\"}},\"dependsOn\":[],\"bindings\":{},\"deadlineMs\":1000}]}";

    [Fact]
    public void ResultProjectionIncludesStatusHighWaterAndEventContinuationFields()
    {
        var snapshot = new BodyProgramStatusSnapshot("program_1", BodyProgramState.Active, 7, 2, 11,
            new[] { new BodyProgramJournalNode("first", BodyProgramNodeState.Running, 3, 4, null, null) });
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
    public void VerifyResultHasIndependentExactShapeAndRoundTrips()
    {
        BridgeProtocol.TryDeserializeBodyProgramVerificationResult(ResultEnvelope("program_verify_result", "{\"accepted\":true,\"catalogRevision\":7,\"diagnostics\":[]}"), out var envelope, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        envelope!.Payload.Accepted.Should().BeTrue();
        BridgeProtocol.TrySerialize(envelope, out string serialized, out string serializeReason).Should().BeTrue();
        serializeReason.Should().Be("accepted");
        using JsonDocument document = JsonDocument.Parse(serialized);
        document.RootElement.GetProperty("payload").EnumerateObject().Select(property => property.Name).Should().BeEquivalentTo("accepted", "catalogRevision", "diagnostics");
    }

    [Fact]
    public void BodyProgramNodeAttemptsRejectValuesBeyondCoreInt32()
    {
        const string snapshot = "{\"code\":\"found\",\"snapshot\":{\"programId\":\"program_1\",\"state\":\"active\",\"catalogRevision\":7,\"stopEpoch\":2,\"eventHighWater\":11,\"nodes\":[{\"nodeId\":\"first\",\"state\":\"running\",\"nodeAttempt\":2147483648,\"admissionAttempt\":4}]}}";
        BridgeProtocol.TryDeserializeBodyProgramStatusResult(ResultEnvelope("program_status_result", snapshot), out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_result");
        const string events = "{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[{\"cursor\":9,\"programId\":\"program_1\",\"kind\":\"native_dispatch\",\"catalogRevision\":7,\"nodeId\":\"first\",\"nodeAttempt\":2147483648}],\"nextCursor\":9,\"highWater\":11}";
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result", events), out _, out reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void TrySerialize_BodyProgramCandidateRejectsMalformedRuntimeArguments()
    {
        var bogus = new BridgeBodyProgramCandidate("program_1", new[] { new BridgeBodyProgramCandidateNode("first", "navigate", new Dictionary<string, BodyProgramRuntimeValue> { ["destination"] = new("bogus", "x") }, Array.Empty<string>(), new Dictionary<string, BridgeBodyProgramBinding>(), 1000) });
        BridgeProtocol.TrySerialize(bogus, out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_result");
        var malformedSelector = new BridgeBodyProgramCandidate("program_1", new[] { new BridgeBodyProgramCandidateNode("first", "navigate", new Dictionary<string, BodyProgramRuntimeValue> { ["destination"] = new("destination_selector", null, new BodyProgramDestinationSelector("label", "Town", "dr1_bad")) }, Array.Empty<string>(), new Dictionary<string, BridgeBodyProgramBinding>(), 1000) });
        BridgeProtocol.TrySerialize(malformedSelector, out _, out reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_result");
        foreach (string label in new[] { " Town", "Town " })
        {
            var boundaryWhitespace = new BridgeBodyProgramCandidate("program_1", new[] { new BridgeBodyProgramCandidateNode("first", "navigate", new Dictionary<string, BodyProgramRuntimeValue> { ["destination"] = new("destination_selector", null, new BodyProgramDestinationSelector("label", label, null)) }, Array.Empty<string>(), new Dictionary<string, BridgeBodyProgramBinding>(), 1000) });
            BridgeProtocol.TrySerialize(boundaryWhitespace, out _, out reason).Should().BeFalse();
            reason.Should().Be("invalid_body_program_result");
        }
    }

    [Fact]
    public void TrySerialize_BodyProgramCandidateRejectsUnsafeDeadline()
    {
        var candidate = new BridgeBodyProgramCandidate("program_1", new[] { new BridgeBodyProgramCandidateNode("first", "navigate", new Dictionary<string, BodyProgramRuntimeValue>(), Array.Empty<string>(), new Dictionary<string, BridgeBodyProgramBinding>(), 9007199254740992) });
        BridgeProtocol.TrySerialize(candidate, out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_result");
    }

    [Fact]
    public void BodyProgramResultsRejectJavaScriptUnsafeNumbers()
    {
        string verification = "{\"accepted\":true,\"catalogRevision\":9007199254740992,\"diagnostics\":[]}";
        BridgeProtocol.TryDeserializeBodyProgramVerificationResult(ResultEnvelope("program_verify_result", verification), out _, out string reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_result");
        string events = "{\"programId\":\"program_1\",\"code\":\"found\",\"events\":[],\"nextCursor\":9007199254740992,\"highWater\":9007199254740992}";
        BridgeProtocol.TryDeserializeBodyProgramEventsResult(ResultEnvelope("program_events_result", events), out _, out reason).Should().BeFalse();
        reason.Should().Be("invalid_body_program_result");
        var unsafeEvent = new BridgeBodyProgramEventsResult("program_1", "found", new[] { new BridgeBodyProgramEvent(9, "program_1", "native_dispatch", 9007199254740992, "first", 3) }, 9, 11);
        BridgeProtocol.TrySerialize(unsafeEvent, out _, out string eventReason).Should().BeFalse();
        eventReason.Should().Be("invalid_body_program_result");
        var unsafeCursorEvent = new BridgeBodyProgramEventsResult("program_1", "found", new[] { new BridgeBodyProgramEvent(9007199254740992, "program_1", "native_dispatch", 7, "first", 3) }, 9, 11);
        BridgeProtocol.TrySerialize(unsafeCursorEvent, out _, out eventReason).Should().BeFalse();
        eventReason.Should().Be("invalid_body_program_result");
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
            new[] { new BodyProgramJournalNode("first", BodyProgramNodeState.Running, 3, 4, null, null) });
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

    [Fact]
    public void TryDeserializeBodyProgramStatusRequest_ValidRequest_DeserializesCorrectly()
    {
        BridgeProtocol.TryDeserializeBodyProgramStatusRequest(ResultEnvelope("program_status", "{\"programId\":\"program_1\"}"), out BridgeEnvelope<BridgeBodyProgramStatusRequest>? envelope, out string reason).Should().BeTrue();

        reason.Should().Be("accepted");
        envelope!.Payload.ProgramId.Should().Be("program_1");
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"programId\":1}")]
    [InlineData("{\"programId\":null}")]
    [InlineData("{\"programId\":\"\"}")]
    [InlineData("{\"programId\":\"program_1\",\"extra\":true}")]
    public void TryDeserializeBodyProgramStatusRequest_MalformedPayload_FailsClosed(string payload)
    {
        BridgeProtocol.TryDeserializeBodyProgramStatusRequest(ResultEnvelope("program_status", payload), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_request");
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(9, 16)]
    [InlineData(11, 32)]
    public void TryDeserializeBodyProgramEventsRequest_ValidRequest_DeserializesCorrectly(long cursor, int pageSize)
    {
        string payload = "{\"programId\":\"program_1\",\"cursor\":" + cursor + ",\"pageSize\":" + pageSize + "}";
        BridgeProtocol.TryDeserializeBodyProgramEventsRequest(ResultEnvelope("program_events", payload), out BridgeEnvelope<BridgeBodyProgramEventsRequest>? envelope, out string reason).Should().BeTrue();

        reason.Should().Be("accepted");
        envelope!.Payload.ProgramId.Should().Be("program_1");
        envelope.Payload.Cursor.Should().Be(cursor);
        envelope.Payload.PageSize.Should().Be(pageSize);
    }

    [Theory]
    [InlineData("{\"programId\":\"program_1\",\"cursor\":-1,\"pageSize\":1}")]
    [InlineData("{\"programId\":\"program_1\",\"cursor\":0,\"pageSize\":0}")]
    [InlineData("{\"programId\":\"program_1\",\"cursor\":0,\"pageSize\":33}")]
    [InlineData("{\"programId\":\"program_1\",\"cursor\":\"0\",\"pageSize\":1}")]
    [InlineData("{\"programId\":\"program_1\",\"cursor\":null,\"pageSize\":1}")]
    [InlineData("{\"programId\":\"program_1\",\"cursor\":0,\"pageSize\":1,\"extra\":true}")]
    [InlineData("{\"programId\":\"program_1\",\"cursor\":0}")]
    [InlineData("{\"programId\":\"program_1\",\"pageSize\":1}")]
    [InlineData("{\"cursor\":0,\"pageSize\":1}")]
    [InlineData("{\"programId\":1,\"cursor\":0,\"pageSize\":1}")]
    public void TryDeserializeBodyProgramEventsRequest_MalformedPayload_FailsClosed(string payload)
    {
        BridgeProtocol.TryDeserializeBodyProgramEventsRequest(ResultEnvelope("program_events", payload), out _, out string reason).Should().BeFalse();

        reason.Should().Be("invalid_body_program_request");
    }

    [Fact]
    public void TryDeserializeBodyProgramRequest_WrongPayloadShapeForType_FailsClosed()
    {
        BridgeProtocol.TryDeserializeBodyProgramStatusRequest(ResultEnvelope("program_status", "{\"programId\":\"program_1\",\"cursor\":0,\"pageSize\":1}"), out _, out string statusReason).Should().BeFalse();
        statusReason.Should().Be("invalid_body_program_request");

        BridgeProtocol.TryDeserializeBodyProgramEventsRequest(ResultEnvelope("program_events", "{\"programId\":\"program_1\"}"), out _, out string eventsReason).Should().BeFalse();
        eventsReason.Should().Be("invalid_body_program_request");
    }

    private static string ResultEnvelope(string type, string payload) =>
        "{\"protocolVersion\":1,\"messageId\":\"msg_1\",\"correlationId\":\"corr_1\",\"timestampMs\":1000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_1\",\"worldId\":\"world_1\",\"playerId\":\"player_1\",\"companionId\":\"companion_1\"},\"type\":\"" + type + "\",\"payload\":" + payload + "}";

    [Fact]
    public void TrySerialize_StatusSnapshotNodeArray_IsFrozenAtSixteen()
    {
        BridgeBodyProgramNodeStatus[] nodes = Enumerable.Range(0, 16)
            .Select(index => new BridgeBodyProgramNodeStatus($"node_{index:D2}", "pending", 1, 1)).ToArray();
        BridgeBodyProgramStatusSnapshot snapshot = new("program_1", "active", 7, 2, 11, nodes);

        BridgeProtocol.TrySerialize(new BridgeBodyProgramStatusResult("found", snapshot), out _, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");

        BridgeBodyProgramStatusSnapshot oversized = snapshot with
        {
            Nodes = nodes.Append(new BridgeBodyProgramNodeStatus("node_16", "pending", 1, 1)).ToArray(),
        };
        BridgeProtocol.TrySerialize(new BridgeBodyProgramStatusResult("found", oversized), out string json, out reason).Should().BeFalse();
        json.Should().BeEmpty();
        reason.Should().Be("invalid_body_program_result");
    }

    [Theory]
    [InlineData("rejected")]
    [InlineData("quarantined")]
    public void TrySerialize_SubmitSnapshotForRejectedOrQuarantined_IsExplicitNull(string code)
    {
        var result = new BridgeBodyProgramSubmitResult(code, new BridgeBodyProgramVerification(false, 7, Array.Empty<BridgeBodyProgramDiagnostic>()), null);

        BridgeProtocol.TrySerialize(result, out string json, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        using JsonDocument document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("snapshot").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public void TrySerialize_NotFoundStatusResult_SnapshotIsExplicitNull()
    {
        var result = new BridgeBodyProgramStatusResult("not_found", null);

        BridgeProtocol.TrySerialize(result, out string json, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        using JsonDocument document = JsonDocument.Parse(json);
        document.RootElement.GetProperty("snapshot").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public void TrySerialize_EventWithNoNodeIdentity_EmitsExplicitNullNodeKeys()
    {
        var result = new BridgeBodyProgramEventsResult("program_1", "found",
            new[] { new BridgeBodyProgramEvent(9, "program_1", "native_dispatch", 7, null, null) }, 9, 11);

        BridgeProtocol.TrySerialize(result, out string json, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement evt = document.RootElement.GetProperty("events")[0];
        evt.EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo("cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt");
        evt.GetProperty("nodeId").ValueKind.Should().Be(JsonValueKind.Null);
        evt.GetProperty("nodeAttempt").ValueKind.Should().Be(JsonValueKind.Null);
    }

    [Fact]
    public void TrySerialize_DiagnosticWithNullNodeId_EmitsExplicitNullNodeKey()
    {
        var verification = new BridgeBodyProgramVerification(false, 7, new[]
        {
            new BridgeBodyProgramDiagnostic("error", "invalid_program", null, "/", "invalid_program"),
        });

        BridgeProtocol.TrySerialize(verification, out string json, out string reason).Should().BeTrue();
        reason.Should().Be("accepted");
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement diagnostic = document.RootElement.GetProperty("diagnostics")[0];
        diagnostic.EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo("severity", "code", "nodeId", "path", "message");
        diagnostic.GetProperty("nodeId").ValueKind.Should().Be(JsonValueKind.Null);
    }
}
